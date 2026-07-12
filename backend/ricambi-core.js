'use strict';
// parts-core: aggrega più fonti ricambi, come runSearchCore per auto/moto.
// Fonti: Autodoc (stealth scrape, solo mode OEM) + Web (Anthropic web_search) + Subito accessori.
// Ogni fonte è avvolta in un wrapper never-reject + timeout → una fonte lenta/rotta NON abbatte
// le altre (Promise.all sicuro). eBay sarà una fonte in più: stesso wrapper, zero refactor.
const { lookupOem, normOen, fetchAutodocSpecs } = require('./oem-lookup');
const { lookupCmsnl } = require('./cmsnl-lookup');
const { searchWebParts } = require('./web-parts');
const scrapeSubito = require('./scrapers/subito-api');   // .searchAccessori(keyword)
const ebayScrape = require('./ebay-scrape');             // scrape-bridge in attesa API ufficiale
const logger = require('./logger');

const TIMEOUT_MS = parseInt(process.env.RICAMBI_TIMEOUT_MS, 10) || 45000;

// Adatta un item Subito (mapAd) allo shape parti unificato. prezzo 0 = trattabile → null.
function subitoToPart(it) {
  return {
    fonte: 'subito',
    nome: it.titolo || 'Annuncio Subito',
    prezzo: (typeof it.prezzo === 'number' && it.prezzo > 0) ? it.prezzo : null,
    valuta: 'EUR',
    immagine: it.immagini && it.immagini[0] ? (it.immagini[0].thumb || it.immagini[0].full) : null,
    venditore: it.venditore || 'privato',
    provincia: it.provincia || null,
    url: it.url || null,
  };
}
async function subitoSource(term, opts = {}) {
  const items = await scrapeSubito.searchAccessori(term, { cat: opts.cat });   // può lanciare (blocco hades) → runSource lo cattura
  return { articoli: items.map(subitoToPart) };
}
async function ebaySource(term) {
  const items = await ebayScrape.searchEbay(term);   // 403/timeout → runSource lo cattura
  return { articoli: items };
}

// Filtro pertinenza per le ricerche testuali (nome/prodotto): Subito con keyword generiche
// pesca rumore (PROVATO: "faretto originale bmw gs" → 44 item tra cui barre portatutto auto).
// Tieni solo gli annunci il cui titolo contiene ≥1 token significativo della query.
const STOPWORDS = new Set(['originale', 'per', 'con', 'senza', 'nuovo', 'usato', 'coppia', 'set', 'kit',
  'completo', 'completi', 'della', 'dello', 'delle', 'di', 'da', 'la', 'il', 'lo', 'le', 'un', 'una', 'in', 'su', 'e', 'ed', 'o']);
function relevantToQuery(items, query) {
  const tokens = String(query || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens.length) return items;
  // match sul titolo; per i token >3 char accetta anche lo stem senza l'ultima lettera
  // (singolare/plurale italiano: faretto→farett matcha "faretti")
  return items.filter(a => {
    const titolo = String(a.nome || '').toLowerCase();
    return tokens.some(t => titolo.includes(t) || (t.length > 3 && titolo.includes(t.slice(0, -1))));
  });
}

// Avvolge la promise di una fonte (che risolve al SUO envelope) in { items, status, reason, meta }.
// status: ok | empty | blocked | error | timeout. Non rigetta mai.
async function runSource(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__timeout__')), ms); });
  try {
    const res = await Promise.race([promise, timeout]);
    if (!res) return { items: [], status: 'error', reason: 'nessuna risposta', meta: null };
    if (res.blocked) return { items: [], status: 'blocked', reason: res.error || 'bloccato', meta: res };
    if (res.error) return { items: [], status: 'error', reason: res.error, meta: res };
    const items = Array.isArray(res.articoli) ? res.articoli : [];
    return { items, status: items.length ? 'ok' : 'empty', reason: null, meta: res };
  } catch (e) {
    const isTimeout = e.message === '__timeout__';
    return { items: [], status: isTimeout ? 'timeout' : 'error', reason: isTimeout ? 'timeout' : e.message, meta: null };
  } finally {
    clearTimeout(timer);   // libera il timer se la fonte ha vinto la race (altrimenti resta pendente 45s)
  }
}

// searchRicambi(q, opts): opts.mode = 'oem' (default) | 'prodotto' | 'nome'.
//  - oem     : term = normOen(q) → Autodoc /oem/ (auto) + CMSNL (moto) + Web + Subito
//  - prodotto: term = q.trim()   → Web + Subito (codice ARTICOLO produttore: normOen lo
//              storpierebbe — es. "09.A758.11" — e /oem/ e CMSNL vogliono un OEN)
//  - nome    : term = q.trim()   → Web + Subito
// Nei modi testuali (nome/prodotto) Subito passa dal filtro pertinenza (rumore keyword).
// deps iniettabili (test): opts.{autodoc, cmsnl, web, subito} → default = reali.
async function searchRicambi(qRaw, opts = {}) {
  const mode = ['nome', 'prodotto'].includes(opts.mode) ? opts.mode : 'oem';
  const veicolo = opts.veicolo === 'moto' ? 'moto' : 'auto';   // binario: un ricambio è per auto O per moto
  const autodocFn = opts.autodoc || lookupOem;
  const cmsnlFn = opts.cmsnl || lookupCmsnl;
  const webFn = opts.web || searchWebParts;
  const subitoFn = opts.subito || subitoSource;
  const ebayFn = opts.ebay || ebaySource;
  const ebaySpecsFn = opts.ebaySpecs || ebayScrape.fetchEbayItemSpecs;
  const autodocSpecsFn = opts.autodocSpecs || fetchAutodocSpecs;
  const term = mode === 'oem' ? normOen(qRaw) : String(qRaw || '').trim();
  if (!term) return { oen: '', mode, veicolo, articoli: [], count: 0, sources: {}, error: 'query vuota' };

  // Fan-out SOLO fonti strutturate. Il catalogo OEM segue il veicolo: auto → Autodoc, moto → CMSNL.
  // Subito interroga la sola categoria del veicolo (c=5 auto / c=36 moto).
  const jobs = {
    subito: runSource(Promise.resolve().then(() => subitoFn(term, { cat: veicolo })), TIMEOUT_MS),
    ebay: runSource(Promise.resolve().then(() => ebayFn(term)), TIMEOUT_MS),
  };
  if (mode === 'oem') {
    if (veicolo === 'auto') jobs.autodoc = runSource(Promise.resolve().then(() => autodocFn(term)), TIMEOUT_MS);
    else jobs.cmsnl = runSource(Promise.resolve().then(() => cmsnlFn(term)), TIMEOUT_MS);
  }

  const keys = Object.keys(jobs);
  const settled = await Promise.all(keys.map(k => jobs[k]));
  const res = {};
  keys.forEach((k, i) => { res[k] = settled[i]; });

  // rumore nei modi testuali → filtro pertinenza (sources.count riflette il filtrato)
  for (const k of ['subito', 'ebay']) {
    if (res[k] && mode !== 'oem') {
      res[k].items = relevantToQuery(res[k].items, term);
      if (res[k].status === 'ok' && !res[k].items.length) res[k].status = 'empty';
    }
  }

  // SCHEDA RICAMBIO: i cataloghi (Autodoc/CMSNL) trattano ricambi NUOVI → non sono "annunci",
  // sono l'identità certa del pezzo: dati tecnici + prezzo nuovo. La lista articoli resta per
  // le OFFERTE di mercato (Subito usato, poi eBay).
  const scheda = buildScheda(res, term);
  if (mode === 'oem' && !scheda) {   // diagnosi "annunci sì, scheda no": perché il catalogo non ha dato la scheda
    const cat = veicolo === 'auto' ? res.autodoc : res.cmsnl;
    logger.info('[ricambi]', `scheda null "${term}" (${veicolo}): catalogo ${cat ? cat.status : 'assente'}${cat?.reason ? ' — ' + cat.reason : ''}`);
  }

  // Arricchimento scheda da eBay: foto REALE del pezzo + dati tecnici ("Item specifics").
  // Match affidabile solo in mode oem: l'offerta il cui titolo contiene il codice.
  if (scheda && mode === 'oem') {
    const match = (res.ebay?.items || []).find(i => normOen(i.nome).includes(term));
    if (match?.immagine && (!scheda.immagine || scheda.prezzoNuovo?.fonte === 'cmsnl')) {
      scheda.immagine = match.immagine;   // la foto CMSNL è spesso un disegno → meglio la foto vera
    }
    if (match) {
      let timer;
      try {
        const s = await Promise.race([
          ebaySpecsFn(match.url),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('specs timeout')), 20000); }),
        ]);
        if (s?.specs && Object.keys(s.specs).length) scheda.datiTecnici = s.specs;
        if (s?.immagine && scheda.prezzoNuovo?.fonte !== 'autodoc') scheda.immagine = s.immagine;
        if (s?.galleria?.length) scheda.galleria = s.galleria;   // foto multiple → lightbox scheda
      } catch (e) {
        logger.warn('[ricambi]', `ebay specs "${term}": ${e.message}`);
      } finally { clearTimeout(timer); }
    }
  }
  // Arricchimento scheda AUTO da Autodoc: la pagina-prodotto ha la tabella tecnica (Potenza/Anno/
  // Codice produttore + eventuali misure) e i modelli compatibili — la card no. +1 navigazione, cache-coperta.
  if (scheda && mode === 'oem' && scheda.prezzoNuovo?.fonte === 'autodoc' && scheda.prezzoNuovo.url) {
    let timer;
    try {
      const a = await Promise.race([
        autodocSpecsFn(scheda.prezzoNuovo.url),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('autodoc specs timeout')), 25000); }),
      ]);
      if (a?.datiTecnici && Object.keys(a.datiTecnici).length) scheda.datiTecnici = { ...(scheda.datiTecnici || {}), ...a.datiTecnici };   // catalogo ha precedenza sull'eBay
      if (a?.compatibilita?.length && !scheda.compatibilita) scheda.compatibilita = a.compatibilita;   // riempie la compatibilità auto (gap storico)
    } catch (e) {
      logger.warn('[ricambi]', `autodoc specs "${term}": ${e.message}`);
    } finally { clearTimeout(timer); }
  }
  if (scheda && !scheda.immagine) scheda.immagine = (res.subito?.items || [])[0]?.immagine || null;

  // Web search = FALLBACK-ONLY: parte solo se né la scheda né le offerte hanno trovato nulla.
  const offerteCount = ['subito', 'ebay'].reduce((n, k) => n + (res[k] ? res[k].items.length : 0), 0);
  if (!scheda && offerteCount === 0) {
    res.web = await runSource(Promise.resolve().then(() => webFn(term, { mode, veicolo, raw: String(qRaw || '').trim() })), TIMEOUT_MS);
  }

  const order = ['autodoc', 'cmsnl', 'subito', 'ebay', 'web'];
  const articoli = ['subito', 'ebay', 'web'].flatMap(k => (res[k] ? res[k].items : []));   // SOLO offerte (niente item catalogo)
  const sources = {};
  order.forEach(k => {
    if (!res[k]) return;
    sources[k] = { status: res[k].status, reason: res[k].reason, count: res[k].items.length };
    // fonte non riuscita → logga tag + reason (prima era muto: causa del "Web error" invisibile)
    if (res[k].status !== 'ok' && res[k].status !== 'empty') logger.warn('[ricambi]', `fonte ${k} "${term}" (${mode}/${veicolo}): ${res[k].status} — ${res[k].reason || 'n/d'}`);
  });

  return {
    oen: term, mode, veicolo,
    scheda,   // identità certa del pezzo (o null se nessun catalogo l'ha)
    // campi top-level mantenuti per compat (PDF/testata): identità catalogo → web
    tipoPezzo: scheda?.tipoPezzo || res.web?.meta?.pezzo?.tipo || null,
    categoria: res.autodoc?.meta?.categoria || null,
    veicoli: (Array.isArray(scheda?.compatibilita) ? scheda.compatibilita.join(', ') : scheda?.compatibilita) || res.web?.meta?.pezzo?.veicoli || null,
    oeAlternativi: scheda?.oeAlternativi || [],
    sources,
    articoli,
    count: articoli.length,
  };
}

// Costruisce la scheda dal catalogo del veicolo. Autodoc lista fino a 12 VENDITORI dello stesso
// pezzo nuovo → si prende il prezzo MINIMO (gli altri sono lo stesso ricambio, non offerte diverse).
function buildScheda(res, term) {
  const aItems = res.autodoc?.items || [];
  if (aItems.length) {
    const priced = aItems.filter(a => typeof a.prezzo === 'number');
    const best = priced.length ? priced.reduce((m, a) => (a.prezzo < m.prezzo ? a : m)) : aItems[0];
    return {
      tipoPezzo: res.autodoc.meta?.tipoPezzo || best.nome || null,
      codice: term,
      marca: best.marca || null,
      compatibilita: null,   // gap applicabilità auto (candidato PartSouq)
      oeAlternativi: res.autodoc.meta?.oeAlternativi || [],
      prezzoNuovo: typeof best.prezzo === 'number'
        ? { valore: best.prezzo, listino: best.prezzoListino || null, sconto: best.sconto || null, fonte: 'autodoc', url: best.url || null }
        : null,
      immagine: best.immagine || null,
      disponibile: best.disponibile ?? null,
      condizione: 'Nuovo', spedizione: null,
      stelle: best.stelle || null, recensioni: best.recensioni || null,
    };
  }
  const c = (res.cmsnl?.items || [])[0];
  if (c) {
    return {
      tipoPezzo: res.cmsnl.meta?.tipoPezzo || c.nome || null,
      codice: term,
      marca: c.marca || null,
      compatibilita: res.cmsnl.meta?.veicoli || null,   // fits con anni/telai
      oeAlternativi: [],
      prezzoNuovo: typeof c.prezzo === 'number' ? { valore: c.prezzo, listino: null, sconto: null, fonte: 'cmsnl', url: c.url || null } : null,
      immagine: c.immagine || null,
      disponibile: c.disponibile ?? null,
      condizione: c.condizione || 'Nuovo', spedizione: c.spedizione || null,
      stelle: null, recensioni: null,
    };
  }
  return null;
}

module.exports = { searchRicambi, runSource, relevantToQuery };

// self-check manuale: `node backend/ricambi-core.js 1K0905851B` (fetch reali; web richiede ANTHROPIC_API_KEY)
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const { closeBrowser } = require('./oem-lookup');
  searchRicambi(process.argv[2] || '1K0905851B')
    .then(r => { console.log(JSON.stringify(r, null, 2)); return closeBrowser(); })
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
