'use strict';
const salute = require('./fonti-salute');
// Rotta GET /api/ricambi?oen=... — codice OEM → articoli MULTI-FONTE (Autodoc + Web).
// Estratta da server.js per testabilità in isolamento (deps iniettabili) senza avviare
// l'intero server né toccare le fonti. Montata da server.js con mount(app).
//
// Dietro auth, demo-allowed (GET, non nei prefissi privati del demo-gate). Le fonti sono
// costose (browser stealth + chiamata Anthropic) → cache per OEN + rate-limit dedicato.
// Ritorna SEMPRE 200 con l'envelope multi-fonte (lo status per-fonte è dentro `sources`),
// come la ricerca auto: un fallimento parziale non è un errore della rotta.
const realCore = require('./ricambi-core');
const realOem = require('./oem-lookup');
const realEbay = require('./ebay-scrape');

const RICAMBI_TTL = 60 * 60 * 1000;        // 1h per lookup con risultati
const RICAMBI_EMPTY_TTL = 5 * 60 * 1000;   // 5min per 0-item (codice ignoto): non ri-cercare subito
const RICAMBI_CACHE_MAX = 200;
const RATE_WINDOW = 60 * 1000;
const RATE_CAP = 10;
const EBAY_RATE_CAP = 30;   // l'enrich ⓘ è leggero (1 nav) → budget separato, non ruba quello delle ricerche

const defaultClientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket?.remoteAddress || 'local';

// Non cachare se una fonte è in errore transitorio (blocked/error/timeout) → così un OEN
// degradato viene ritentato invece di restare congelato in cache.
function cacheable(env) {
  const bad = s => s === 'error' || s === 'blocked' || s === 'timeout';
  return !Object.values(env.sources || {}).some(s => bad(s.status));
}

// deps iniettabili: { searchRicambi, normOen, clientIp } — default = reali. I test passano stub.
function mount(app, deps = {}) {
  const searchRicambi = deps.searchRicambi || realCore.searchRicambi;
  const normOen = deps.normOen || realOem.normOen;
  const fetchEbayItemDetails = deps.fetchEbayItemDetails || realEbay.fetchEbayItemDetails;
  const fetchAutodocSpecs = deps.fetchAutodocSpecs || realOem.fetchAutodocSpecs;
  // La chiave dei limiti: la PERSONA quando e' entrata, l'indirizzo quando no.
  // La calcola server.js (`chiaveLimite`), che e' l'unico a sapere chi ha il cookie.
  const chiaveLimite = deps.chiaveLimite || deps.clientIp || defaultClientIp;


  const cache = new Map();                   // normOen → { ts, ttl, data }
  const ebayCache = new Map();               // itm url → { ts, data } (enrich lazy annunci eBay)
  const autodocCache = new Map();            // product url → { ts, data } (specs lazy variante Autodoc)
  const crea = require('./limite-richieste').crea;
  const limite = crea({ max: RATE_CAP, finestra: RATE_WINDOW, cosa: 'ricerche di ricambi' });
  const limiteEbay = crea({ max: EBAY_RATE_CAP, finestra: RATE_WINDOW, cosa: 'aperture di schede eBay' });

  app.get('/api/ricambi', async (req, res) => {
    const q = String(req.query.q || req.query.oen || '').trim();   // ?q= (nuovo) o ?oen= (retro-compat)
    const mode = ['nome', 'prodotto'].includes(req.query.mode) ? req.query.mode : 'oem';
    const veicolo = req.query.veicolo === 'moto' ? 'moto' : 'auto';
    if (!q) return res.status(400).json({ error: 'codice/nome ricambio mancante' });
    const key = mode + ':' + veicolo + ':' + (mode === 'oem' ? normOen(q) : q.toLowerCase());
    const hit = cache.get(key);
    // LA CACHE NON COSTA NIENTE ALLE FONTI, quindi non consuma il budget: e' la stessa regola
    // che il competitor applica ai parchi gia' scaricati. Il limitatore sta qui per impedire
    // che una raffica si faccia bloccare da Autodoc o eBay, non per contare i clic.
    if (hit && Date.now() - hit.ts < hit.ttl) {
      cache.delete(key); cache.set(key, hit);   // LRU touch
      return res.json({ ...salute.conStatoFonti(hit.data), restanti: limite.stato(chiaveLimite(req)).restanti });
    }
    const g = limite.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ error: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    try {
      const data = await searchRicambi(q, { mode, veicolo });
      if (cacheable(data)) {
        const ttl = data.count > 0 ? RICAMBI_TTL : RICAMBI_EMPTY_TTL;
        cache.set(key, { ts: Date.now(), ttl, data });
        if (cache.size > RICAMBI_CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      res.json({ ...data, restanti: g.restanti });
    } catch (e) {
      console.error('[ricambi]', e.message);
      res.status(500).json({ error: 'Errore interno durante il lookup.' });
    }
  });

  // Enrich LAZY di un annuncio eBay (venditore/spedizione/quantità/marca) — chiamata all'apertura ⓘ.
  // Valida l'URL item (anti-SSRF: solo ebay.<tld>/itm/), cache per URL, stesso rate-limit.
  app.get('/api/ricambi/ebay-item', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!/^https:\/\/www\.ebay\.\w+\/itm\/\d+/.test(url)) return res.status(400).json({ error: 'URL eBay item non valido' });
    const hit = ebayCache.get(url);
    // LA CACHE NON COSTA NIENTE ALLE FONTI, quindi non consuma il budget (stessa regola di
    // /api/ricambi qui sopra): riaprire le stesse ⓘ dopo una nuova ricerca — il frontend
    // azzera `_ebayDetails` a ogni ricerca — finiva i 30 posti senza una richiesta a eBay.
    if (hit && Date.now() - hit.ts < RICAMBI_TTL) {
      ebayCache.delete(url); ebayCache.set(url, hit);   // LRU touch (come la cache ricerche)
      return res.json(hit.data);
    }
    const g = limiteEbay.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ error: limiteEbay.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    try {
      const data = await fetchEbayItemDetails(url);
      // Una scheda VUOTA (la pagina non si e' idratata nei 12 s: il timeout e' ingoiato dentro
      // fetchEbayItemDetails) non e' "la risposta di eBay" e non si tiene un'ora: si risponde e
      // basta, cosi' il prossimo clic riprova. In cache entra solo una scheda con dentro qualcosa.
      if (data && Object.keys(data).length) ebayCache.set(url, { ts: Date.now(), data });
      if (ebayCache.size > RICAMBI_CACHE_MAX) ebayCache.delete(ebayCache.keys().next().value);
      res.json(data);
    } catch (e) {
      console.error('[ricambi] ebay-item', e.message);
      res.status(502).json({ error: 'Dettaglio annuncio non disponibile.' });
    }
  });

  // Specs LAZY di una variante Autodoc (datiTecnici + compatibilità) — chiamata quando si seleziona
  // una variante nel selettore. Valida l'URL product-page (anti-SSRF: solo auto-doc.it), cache per URL.
  app.get('/api/ricambi/autodoc-specs', async (req, res) => {
    const url = String(req.query.url || '').trim();
    if (!/^https?:\/\/(www\.)?auto-doc\.it\//i.test(url)) return res.status(400).json({ error: 'URL Autodoc non valido' });
    const hit = autodocCache.get(url);
    // Stessa regola: la cache non paga pedaggio. Qui pesa doppio perche' il frontend chiama
    // questa rotta da solo a ogni ricerca e a ogni clic su tipo/variante, e il budget e' lo
    // STESSO di ebay-item (limiteEbay), quindi i due consumi si sommano sulla stessa persona.
    if (hit && Date.now() - hit.ts < (hit.ttl || RICAMBI_TTL)) {
      autodocCache.delete(url); autodocCache.set(url, hit);   // LRU touch
      return res.json(hit.data);
    }
    const g = limiteEbay.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ error: limiteEbay.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    try {
      const data = await fetchAutodocSpecs(url);
      // fetchAutodocSpecs non lancia mai (CF block/HTTP>=400 → shape vuoto): un vuoto è spesso un
      // blocco transitorio → TTL breve (come RICAMBI_EMPTY_TTL), non congelarlo 1h.
      const vuoto = !data || ((!data.datiTecnici || !Object.keys(data.datiTecnici).length) && !(data.compatibilita && data.compatibilita.length));
      // Un blocco o un errore di rete non si mettono in cache affatto: non dicono niente
      // sull'articolo, e tenerli anche solo per il TTL corto significa ripetere all'utente
      // una risposta che non abbiamo mai ottenuto.
      const nonDaTenere = data && ['bloccato', 'errore'].includes(data.motivo);
      if (!nonDaTenere) {
        autodocCache.set(url, { ts: Date.now(), ttl: vuoto ? RICAMBI_EMPTY_TTL : RICAMBI_TTL, data });
        if (autodocCache.size > RICAMBI_CACHE_MAX) autodocCache.delete(autodocCache.keys().next().value);
      }
      res.json(data);
    } catch (e) {
      console.error('[ricambi] autodoc-specs', e.message);
      res.status(502).json({ error: 'Specifiche non disponibili.' });
    }
  });
}

module.exports = { mount };
