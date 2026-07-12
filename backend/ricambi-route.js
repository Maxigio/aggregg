'use strict';
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
  const clientIp = deps.clientIp || defaultClientIp;

  const hits = new Map();                    // ip → { windowStart, count } (ricerche)
  const ebayHits = new Map();                // ip → { windowStart, count } (enrich ⓘ, budget separato)
  const cache = new Map();                   // normOen → { ts, ttl, data }
  const ebayCache = new Map();               // itm url → { ts, data } (enrich lazy annunci eBay)
  const rateLimiter = (map, cap) => (ip) => {
    const now = Date.now();
    const rec = map.get(ip);
    if (!rec || now - rec.windowStart >= RATE_WINDOW) { map.set(ip, { windowStart: now, count: 1 }); return true; }
    rec.count++; return rec.count <= cap;
  };
  const rateOk = rateLimiter(hits, RATE_CAP);
  const ebayRateOk = rateLimiter(ebayHits, EBAY_RATE_CAP);

  app.get('/api/ricambi', async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste, attendi un momento.' });
    const q = String(req.query.q || req.query.oen || '').trim();   // ?q= (nuovo) o ?oen= (retro-compat)
    const mode = ['nome', 'prodotto'].includes(req.query.mode) ? req.query.mode : 'oem';
    const veicolo = req.query.veicolo === 'moto' ? 'moto' : 'auto';
    if (!q) return res.status(400).json({ error: 'codice/nome ricambio mancante' });
    const key = mode + ':' + veicolo + ':' + (mode === 'oem' ? normOen(q) : q.toLowerCase());
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < hit.ttl) {
      cache.delete(key); cache.set(key, hit);   // LRU touch
      return res.json(hit.data);
    }
    try {
      const data = await searchRicambi(q, { mode, veicolo });
      if (cacheable(data)) {
        const ttl = data.count > 0 ? RICAMBI_TTL : RICAMBI_EMPTY_TTL;
        cache.set(key, { ts: Date.now(), ttl, data });
        if (cache.size > RICAMBI_CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      res.json(data);
    } catch (e) {
      console.error('[ricambi]', e.message);
      res.status(500).json({ error: 'Errore interno durante il lookup.' });
    }
  });

  // Enrich LAZY di un annuncio eBay (venditore/spedizione/quantità/marca) — chiamata all'apertura ⓘ.
  // Valida l'URL item (anti-SSRF: solo ebay.<tld>/itm/), cache per URL, stesso rate-limit.
  app.get('/api/ricambi/ebay-item', async (req, res) => {
    if (!ebayRateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste, attendi un momento.' });
    const url = String(req.query.url || '').trim();
    if (!/^https:\/\/www\.ebay\.\w+\/itm\/\d+/.test(url)) return res.status(400).json({ error: 'URL eBay item non valido' });
    const hit = ebayCache.get(url);
    if (hit && Date.now() - hit.ts < RICAMBI_TTL) return res.json(hit.data);
    try {
      const data = await fetchEbayItemDetails(url);
      ebayCache.set(url, { ts: Date.now(), data });
      if (ebayCache.size > RICAMBI_CACHE_MAX) ebayCache.delete(ebayCache.keys().next().value);
      res.json(data);
    } catch (e) {
      console.error('[ricambi] ebay-item', e.message);
      res.status(502).json({ error: 'Dettaglio annuncio non disponibile.' });
    }
  });
}

module.exports = { mount };
