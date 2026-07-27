'use strict';
/**
 * Scraper Subito via API di prima parte (hades.subito.it).
 *
 * Path PRIMARIO per Subito: GET JSON diretto, niente browser/DataDome/bootstrap
 * CAPTCHA → elimina il punto più fragile dell'app. Su errore/blocco → throw, così
 * server.js fa fallback a subito-playwright (browser+stealth).
 *
 * Schema verificato:
 *  GET /v1/search/items?c=<cat>&t=s&q=<marca modello>&lim=<n>&start=<off>
 *  c=2 Auto, c=3 Moto e Scooter (macrocategoria Motori).
 *  ad.subject (titolo), ad.urls.default (URL), ad.geo.region.friendly_name +
 *  ad.geo.city.value, ad.features[] (label→values[0].value): Prezzo, Km,
 *  Immatricolazione, Carburante, Cambio, Potenza, …
 */
const https = require('https');

const { kindForStatus, fail } = require('./utils');   // classificazione salute crawler (F1.5)
const budget = require('../budget-richieste');        // conta le richieste, non le limita

const HOST = 'hades.subito.it';
// Categorie hades (macro Motori=1). accessoriAuto/Moto scoperti live 2026-07-07 per la sezione Ricambi.
const CAT = { auto: '2', moto: '3', accessoriAuto: '5', accessoriMoto: '36' };
const PAGE_SIZE = 50;
const MAX_PAGES = 2;            // 2×50 = 100
const TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function httpGetJson(path) {
  budget.conta('subito');
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path,
      headers: { 'user-agent': UA, 'referer': 'https://www.subito.it/', 'accept': 'application/json' },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
}

// feature per label → primo value
function feat(ad, label) {
  const f = (ad.features || []).find(x => x.label === label);
  if (!f) return null;
  const v = f.values && f.values[0];
  return (v && (v.value != null ? v.value : v.key)) || null;
}

// Sub-valore per label dentro una feature multi-livello (es. feature 'Auto'/'Moto'
// → values con label Marca/Modello/Versione). Solo nativo: null se assente.
function subFeat(ad, parentLabel, subLabel) {
  const f = (ad.features || []).find(x => x.label === parentLabel);
  if (!f || !Array.isArray(f.values)) return null;
  const v = f.values.find(x => x && x.label === subLabel);
  return (v && (v.value != null ? v.value : v.key)) || null;
}

// CV dal valore nativo Potenza ("60 kW / 82 Cv" → 82). null se assente/solo-kW.
const cvFrom = s => { const m = String(s == null ? '' : s).match(/(\d+)\s*Cv/i); return m ? parseInt(m[1], 10) : null; };

const digits = s => { const m = String(s == null ? '' : s).replace(/\./g, '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };
const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) && y > 1900 ? y : null; };

function mapAd(ad, opts = {}) {
  const url = ad.urls && (ad.urls.default || ad.urls.mobile);
  if (!url) return null;
  // km: "124000 Km" oppure bucket "120.000 - 129.999" → estremo inferiore
  const kmRaw = feat(ad, 'Km');
  const km = kmRaw ? digits(String(kmRaw).split('-')[0]) : null;
  // data pubblicazione: hades espone ad.date (ISO) — usata come posted_at.
  const posted = ad.date || (ad.dates && (ad.dates.display || ad.dates.created)) || null;
  // Condizione nativa 'Condizioni del veicolo': Nuovo/Km 0 → nuovo=true, Usato → false.
  const cond = feat(ad, 'Condizioni del veicolo');
  const nuovo = cond == null ? null : (cond === 'Nuovo' || cond === 'Km 0');
  // Neopatentati: 'Sì'/'No' nativo → bool; assente → null.
  const neo = feat(ad, 'Per neopatentati');
  const out = {
    fonte: 'subito',
    titolo: ad.subject || 'Annuncio senza titolo',
    prezzo: digits(feat(ad, 'Prezzo')),
    km,
    anno: yearOf(feat(ad, 'Immatricolazione') || feat(ad, 'Anno di immatricolazione')),
    carburante: feat(ad, 'Carburante'),
    provincia: (ad.geo && ad.geo.city && ad.geo.city.value) || null,
    regione: (ad.geo && ad.geo.region && ad.geo.region.friendly_name) || null,   // nativa (slug già giusto)
    cambio: feat(ad, 'Cambio'),
    cilindrata: digits(feat(ad, 'Cilindrata')),
    // Versione/allestimento NATIVA (auto sotto 'Auto', moto sotto 'Moto'); null se assente.
    variante: subFeat(ad, 'Auto', 'Versione') || subFeat(ad, 'Moto', 'Versione'),
    // Venditore dal boolean nativo advertiser.company (true=conce, false=privato).
    venditore: (ad.advertiser && typeof ad.advertiser.company === 'boolean')
      ? (ad.advertiser.company ? 'concessionario' : 'privato') : null,
    potenzaCv: cvFrom(feat(ad, 'Potenza')),
    // Specs ricche NATIVE (già nel payload, zero richieste extra); null se assenti.
    colore: feat(ad, 'Colore'),
    carrozzeria: feat(ad, 'Carrozzeria') || feat(ad, 'Tipologia'),   // auto / moto
    porte: feat(ad, 'Numero di porte'),       // stringa nativa "4/5"
    posti: digits(feat(ad, 'Posti')),
    classeEmissioni: feat(ad, 'Classe emissioni'),
    neopatentati: neo == null ? null : neo === 'Sì',
    // Immagini NATIVE (già nel payload, zero richieste extra): URL webp dalla CDN
    // costruiti dal cdn_base_url + rule (thumb mobile per la lista, fullscreen per lo slider).
    immagini: (Array.isArray(ad.images) ? ad.images : [])
      .filter(i => i && i.cdn_base_url)
      .slice(0, 10)
      .map(i => ({
        thumb: `${i.cdn_base_url}?rule=gallery-mobile-1x-auto`,
        full:  `${i.cdn_base_url}?rule=fullscreen-1x-auto`,
      })),
    url,
    // Campi per il DB (crawler). nuovo ora nativo da 'Condizioni'; danni non esposto.
    nuovo,
    danni: null,
    posted_at: posted,
  };
  if (opts.attachRaw) out._raw = ad;   // foto grezza per raw_json (keep-last)
  return out;
}

// Filtri NATIVI hades (verificati live): regione `r`, prezzo `ps`/`pe`, anno
// `ys`/`ye`, ordinamento `sort`. Mappa friendly_name→key (== `province.json.regione`,
// derivata iterando r=1..20 sull'API). Senza nativo, il filtro veniva applicato
// client-side su 2 pagine NAZIONALI → economici/regione persi (vedi piano F17).
const SUBITO_REGION_KEY = {
  'valle-d-aosta': '1', 'piemonte': '2', 'liguria': '3', 'lombardia': '4',
  'trentino-alto-adige': '5', 'veneto': '6', 'friuli-venezia-giulia': '7',
  'emilia-romagna': '8', 'toscana': '9', 'umbria': '10', 'lazio': '11',
  'marche': '12', 'abruzzo': '13', 'molise': '14', 'campania': '15',
  'puglia': '16', 'basilicata': '17', 'calabria': '18', 'sardegna': '19',
  'sicilia': '20',
};
const SORT_VALIDI = new Set(['priceasc', 'pricedesc', 'datedesc', 'relevance']);

// Km NATIVO hades: param `ms`/`me` (mileage start/end) come CHIAVE CATEGORIA 1..36,
// NON km raw (verificato live: ms/me operano sull'indice categoria, inclusivi).
// Fonte tabella: https://hades.subito.it/v1/values/mileage/max (key→soglia).
// `kmToKey(x)` = prima categoria il cui tetto ≥ x = la categoria che CONTIENE x →
// usata sia per `me` (tetto km max) sia per `ms` (bound inferiore: la categoria di kmMin).
const KM_KEY_TABLE = [
  [4999, 1], [9999, 2], [14999, 3], [19999, 4], [24999, 5], [29999, 6], [34999, 7],
  [39999, 8], [44999, 9], [49999, 10], [54999, 11], [59999, 12], [64999, 13], [69999, 14],
  [74999, 15], [79999, 16], [84999, 17], [89999, 18], [94999, 19], [99999, 20], [109999, 21],
  [119999, 22], [129999, 23], [139999, 24], [149999, 25], [159999, 26], [169999, 27],
  [179999, 28], [189999, 29], [199999, 30], [249999, 31], [299999, 32], [349999, 33],
  [399999, 34], [449999, 35], [499999, 36],
];
function kmToKey(km) {
  for (const [limit, key] of KM_KEY_TABLE) if (limit >= km) return key;
  return 36; // oltre 499.999 km
}

function buildPath(params, start) {
  const c = CAT[params.tipo] || CAT.auto;
  const q = [params.marca, params.modello].filter(Boolean).join(' ').trim();
  const qs = new URLSearchParams({ c, t: 's', lim: String(PAGE_SIZE), start: String(start) });
  if (q) qs.set('q', q);
  // Regione nativa (se mappabile; altrimenti resta il post-filtro client difensivo).
  const regKey = params.regione && SUBITO_REGION_KEY[String(params.regione).trim().toLowerCase()];
  if (regKey) qs.set('r', regKey);
  // Prezzo/anno nativi (i post-filtri client restano come doppia rete).
  if (params.prezzoMin != null) qs.set('ps', String(params.prezzoMin));
  if (params.prezzoMax != null) qs.set('pe', String(params.prezzoMax));
  if (params.annoMin   != null) qs.set('ys', String(params.annoMin));
  if (params.annoMax   != null) qs.set('ye', String(params.annoMax));
  // Km nativo (categoria): ms=bound inferiore (categoria di kmMin), me=tetto (categoria di kmMax).
  if (params.kmMin     != null) qs.set('ms', String(kmToKey(params.kmMin)));
  if (params.kmMax     != null) qs.set('me', String(kmToKey(params.kmMax)));
  // Ordinamento: solo se richiesto esplicitamente (on-search='priceasc'); il crawler
  // NON lo passa → ordine naturale invariato (vista profonda/truncated intatta).
  if (params._sort && SORT_VALIDI.has(params._sort)) qs.set('sort', params._sort);
  return `/v1/search/items?${qs.toString()}`;
}

// F50 — totale per-query = `count_all` della risposta hades (oggi ignorato).
// = quanti annunci Subito HA per la query (tetto copertura). null se assente.
function extractTotal(j) {
  const n = j && j.count_all;
  return Number.isFinite(n) ? n : null;
}

async function fetchPage(params, start) {
  const res = await httpGetJson(buildPath(params, start));
  if (res.status !== 200) throw fail(`Subito hades HTTP ${res.status}`, { status: res.status, kind: kindForStatus(res.status) });
  let j;
  try { j = JSON.parse(res.body); } catch (_) { throw fail('Subito hades: body non-JSON (blocco?)', { status: res.status, kind: 'blocked' }); }
  if (j.errors) throw fail('Subito hades errors: ' + JSON.stringify(j.errors).slice(0, 100), { kind: 'error' });
  return { ads: Array.isArray(j.ads) ? j.ads : [], total: extractTotal(j) };
}

/**
 * Annunci Subito via API. Throw su errore → fallback Playwright.
 * @param opts.maxPages  override profondità (crawler: 10-20; on-search: 2)
 * @param opts.attachRaw allega `_raw` (foto grezza) per il DB
 * @param opts.withMeta  ritorna {items, truncated} invece dell'array (back-compat).
 *                       truncated=true se fermato al cap con ultima pagina PIENA
 *                       (vista parziale → il crawler NON deve rilevare venduti).
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scrapeSubitoApi(params, opts = {}) {
  const regione = params.regione ? String(params.regione).trim().toLowerCase() : null;
  const maxPages = opts.maxPages || MAX_PAGES;
  const pageDelay = opts.pageDelayMs || 0;   // pausa tra le pagine (anti-ban su crawl profondi)
  // Ordinamento esplicito (on-search passa 'priceasc' per le occasioni in cima).
  // Il crawler NON passa opts.sort → ordine naturale, vista profonda invariata.
  const reqParams = opts.sort ? { ...params, _sort: opts.sort } : params;
  const out = [];
  let truncated = false;
  let total = null;                          // F50 count_all (tetto), additivo
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && pageDelay) await sleep(pageDelay);   // mai raffica di pagine
    const page = await fetchPage(reqParams, p * PAGE_SIZE);
    if (p === 0) total = page.total;         // count_all dalla 1ª pagina (uguale su tutte)
    for (const ad of page.ads) {
      // Doppia rete regione: `buildPath` filtra già nativo via `r=<key>` quando la
      // regione è mappabile; questo post-filtro client copre i casi non mappati.
      if (regione) {
        const r = ad.geo && ad.geo.region && ad.geo.region.friendly_name;
        if (r && r.toLowerCase() !== regione) continue;
      }
      const m = mapAd(ad, opts);
      if (m && m.prezzo != null) out.push(m);
    }
    if (page.ads.length < PAGE_SIZE) break;  // lista esaurita = vista completa
    if (p === maxPages - 1) truncated = true; // ultima pagina piena al cap → forse altro
  }
  return opts.withMeta ? { items: out, truncated, total } : out;
}

// Ricerca ACCESSORI/RICAMBI per keyword libera (OEM o nome pezzo) nelle categorie
// Accessori Auto (c=5) + Accessori Moto (c=36). Riusa scrapeSubitoApi (path API, no CAPTCHA).
// La keyword viaggia su `marca` (buildPath fa q=marca+modello). Ritorna item mapAd (shape Subito).
// opts.cat = 'auto' | 'moto' → interroga SOLO quella categoria (un ricambio è per auto O per moto).
// Lancia solo se TUTTE le categorie interrogate falliscono (una KO → torna quel che c'è).
async function searchAccessori(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const { cat, ...rest } = opts;
  const cats = cat === 'auto' ? ['accessoriAuto'] : cat === 'moto' ? ['accessoriMoto'] : ['accessoriAuto', 'accessoriMoto'];
  const res = await Promise.allSettled(cats.map(tipo =>
    scrapeSubitoApi({ marca: kw, tipo }, { maxPages: 1, sort: 'priceasc', ...rest })));
  const items = res.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const rejected = res.find(r => r.status === 'rejected');
  // 0 item MA almeno una categoria bloccata → propaga (runSource → 'error', non cachato come 'empty').
  // both-fulfilled con 0 item = vuoto legittimo → return [].
  if (!items.length && rejected) throw rejected.reason;
  return items;
}

module.exports = scrapeSubitoApi;
module.exports.searchAccessori = searchAccessori;
module.exports._mapAd = mapAd;
module.exports._buildPath = buildPath;
module.exports._extractTotal = extractTotal;   // F50 copertura
