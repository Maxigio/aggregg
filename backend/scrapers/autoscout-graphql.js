'use strict';
/**
 * Scraper AS24 via API GraphQL ufficiale (listing-search.api.autoscout24.com).
 *
 * Path PRIMARIO per Autoscout24: single POST autenticato → dati strutturati,
 * niente browser/DataDome, paginazione vera (size 50), filtro Italia + prezzo
 * server-side. Se l'API fallisce (401 = credenziale ruotata, errori, blocco)
 * → throw, così server.js fa fallback allo scraper Playwright (autoscout-playwright).
 *
 * Credenziale: header Basic STATICO embeddato nel frontend AS24 (client pubblico
 * `as24-search-funnel`). Non è un nostro segreto; se smette (401) → fallback +
 * ri-catturare dal Network tab di autoscout24.it.
 */
const https = require('https');

// Errore "taggato" per la classificazione salute crawler (F1.5).
// kind: 'blocked' (ban-class) | 'auth' | 'transient' | 'error'.
function kindForStatus(s) {
  if (s === 401) return 'auth';
  if (s === 403 || s === 429) return 'blocked';
  if (s >= 500) return 'transient';
  return 'error';
}
function fail(msg, { status = null, kind = 'error' } = {}) {
  const e = new Error(msg); e.status = status; e.kind = kind; return e;
}

const HOST = 'listing-search.api.autoscout24.com';
const AUTH = 'Basic YXMyNC1zZWFyY2gtZnVubmVsOnZucmZiYkJqSTMyT2wxV2thNnVOSFJwM0VZbjRkag==';
const PAGE_SIZE = 50;
const MAX_PAGES = 2;          // 2×50 = 100 (più del path Playwright: 3×~17)
const TIMEOUT_MS = 15000;

// Query ridotta ai soli campi mappati (no leasing/media/360 → payload piccolo).
const QUERY = `query Search($v:Vehicle_,$loc:Location_,$pr:Price_,$m:Metadata_){
  search{ listings(vehicle:$v, location:$loc, price:$pr, metadata:$m, locale:it_IT){
    listings{ details(withFallbackAttributes:true){
      webPage
      publication{ createdTimestampWithOffset }
      prices{ public{ amountInEUR{ raw } onRequestOnly } }
      location{ city zip }
      vehicle{
        classification{ make{ formatted } model{ formatted } modelVersionInput }
        condition{ mileageInKm{ raw } firstRegistrationDate{ formatted } }
        engine{ transmissionType{ formatted } engineDisplacementInCCM{ raw } }
        fuels{ primary{ type{ raw formatted } } fuelCategory{ formatted } }
        usageState
      }
    } }
  } }
}`.replace(/\s+/g, ' ');

function httpPost(body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      host: HOST, path: '/graphql', method: 'POST',
      headers: {
        'authorization': AUTH,
        'content-type': 'application/json',
        'accept': '*/*',
        'origin': 'https://www.autoscout24.it',
        'referer': 'https://www.autoscout24.it/',
        'x-culture': 'it-IT', 'culture': 'it-IT',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1',
        'content-length': data.length,
      },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
    req.write(data); req.end();
  });
}

// Variabili dalla nostra params. classification: make/model = ID numerici del
// catalogo (mmmvAutoscout = "makeId|modelId|...", brand-only = "makeId|||").
function buildVariables(params, page, opts = {}) {
  const mmmv = String(params.autoscoutMmmv || params.mmmvAutoscout || '');
  const [makeStr, modelStr] = mmmv.split('|');
  const make = parseInt(makeStr, 10);
  const model = parseInt(modelStr, 10);
  if (!make) return null;   // senza makeId non interroghiamo l'API

  const classification = { make };
  if (model) classification.model = model;

  const v = {
    classification: [classification],
    vehicleType: [params.tipo === 'moto' ? 'Bike' : 'Car'],   // niente moto nelle ricerche auto e viceversa
  };
  const loc = { country: ['Italy'] };
  const m = { page, size: PAGE_SIZE };
  // Crawler: ordina per età crescente (Age Asc = più recenti prima) per non
  // sprecare le prime pagine sugli annunci-civetta a basso prezzo (sort default
  // = prezzo crescente). enum passati come stringhe via variabili.
  if (opts.sortByDate) m.sort = [{ field: 'Age', order: 'Asc' }];

  const vars = { v, loc, m };
  if (params.prezzoMin != null || params.prezzoMax != null) {
    vars.pr = { price: { from: params.prezzoMin || 1, to: params.prezzoMax || 100000000 } };
  }
  return vars;
}

const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) ? y : null; };

const DAMAGED = new Set(['HadAccident', 'Wreck']);

function mapListing(node, opts = {}) {
  const dt = node && node.details;
  if (!dt) return null;
  const pub = dt.prices && dt.prices.public;
  if (pub && pub.onRequestOnly) return null;          // scarta "prezzo su richiesta"
  const prezzo = pub && pub.amountInEUR ? pub.amountInEUR.raw : null;
  if (prezzo == null) return null;

  const v = dt.vehicle || {};
  const c = v.classification || {};
  const make = (c.make && c.make.formatted) || '';
  const variante = c.modelVersionInput || null;
  const titolo = [make, variante].filter(Boolean).join(' ')
              || (c.model && c.model.formatted) || 'Annuncio senza titolo';
  const ccm = v.engine && v.engine.engineDisplacementInCCM ? v.engine.engineDisplacementInCCM.raw : null;
  const usage = v.usageState || null;   // New | Used | HadAccident | Wreck

  const out = {
    fonte: 'autoscout',
    titolo,
    prezzo,
    km: v.condition && v.condition.mileageInKm ? v.condition.mileageInKm.raw : null,
    anno: yearOf(v.condition && v.condition.firstRegistrationDate && v.condition.firstRegistrationDate.formatted),
    carburante: (() => {
      const f = v.fuels || {};
      const t = f.primary && f.primary.type;
      return (t && (t.formatted || t.raw)) || (f.fuelCategory && f.fuelCategory.formatted) || null;
    })(),
    // city AS24 spesso è "Comune - Provincia - PV" → tieni il comune (1° segmento)
    provincia: (dt.location && dt.location.city ? String(dt.location.city).split(' - ')[0].trim() : null) || null,
    cambio: (v.engine && v.engine.transmissionType && v.engine.transmissionType.formatted) || null,
    cilindrata: ccm ? (parseInt(String(ccm).replace(/[^\d]/g, ''), 10) || null) : null,
    variante,
    zip: (dt.location && dt.location.zip) || null,   // per il post-filtro regione (fallback CAP→regione)
    url: dt.webPage || null,
    // Campi per il DB (usati dal crawler; ignorati dal path on-search legacy):
    nuovo: usage ? usage === 'New' : null,
    danni: usage ? DAMAGED.has(usage) : null,
    posted_at: (dt.publication && dt.publication.createdTimestampWithOffset) || null,
  };
  if (opts.attachRaw) out._raw = dt;   // foto grezza per raw_json (keep-last)
  return out;
}

async function fetchPage(params, page, opts = {}) {
  const variables = buildVariables(params, page, opts);
  if (!variables) return { items: [], raw: 0 };
  const res = await httpPost(JSON.stringify({ query: QUERY, variables }));
  if (res.status === 401) throw fail('AS24 GraphQL 401 (credenziale)', { status: 401, kind: 'auth' });   // → fallback
  if (res.status !== 200) throw fail(`AS24 GraphQL HTTP ${res.status}`, { status: res.status, kind: kindForStatus(res.status) });
  let j;
  try { j = JSON.parse(res.body); } catch (_) { throw fail('AS24 GraphQL: body non-JSON', { status: res.status, kind: 'blocked' }); }
  if (j.errors) throw fail('AS24 GraphQL errors: ' + JSON.stringify(j.errors).slice(0, 120), { kind: 'error' });
  const arr = ((j.data || {}).search || {}).listings;
  const list = (arr && arr.listings) || [];
  // `raw` = annunci grezzi della pagina (per decidere se c'è una pagina dopo);
  // `items` è filtrato (onRequestOnly/prezzo-null) → non usarlo per la paginazione.
  return { items: list.map(n => mapListing(n, opts)).filter(Boolean), raw: list.length };
}

/**
 * Ritorna gli annunci AS24 via API. Throw su errore → fallback Playwright.
 * @param opts.maxPages   override profondità (crawler: 10-20; on-search: 2)
 * @param opts.attachRaw  allega `_raw` (foto grezza) per il DB
 * @param opts.sortByDate ordina per età crescente (più recenti prima)
 * @param opts.withMeta   ritorna {items, truncated} invece dell'array (back-compat).
 *                        truncated=true se fermato al cap con ultima pagina PIENA
 *                        (vista parziale → il crawler NON deve rilevare venduti).
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scrapeAutoscoutGraphql(params, opts = {}) {
  const maxPages = opts.maxPages || MAX_PAGES;
  const pageDelay = opts.pageDelayMs || 0;   // pausa tra le pagine (anti-ban su crawl profondi)
  const out = [];
  let truncated = false;
  for (let p = 1; p <= maxPages; p++) {
    if (p > 1 && pageDelay) await sleep(pageDelay);   // mai raffica di pagine
    const { items, raw } = await fetchPage(params, p, opts);
    out.push(...items);
    if (raw < PAGE_SIZE) break;       // lista esaurita (conteggio GREZZO) = vista completa
    if (p === maxPages) truncated = true;   // ultima pagina piena al cap → forse altro
  }
  return opts.withMeta ? { items: out, truncated } : out;
}

module.exports = scrapeAutoscoutGraphql;
module.exports._mapListing = mapListing;
module.exports._buildVariables = buildVariables;
