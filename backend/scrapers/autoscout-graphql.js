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
      prices{ public{ amountInEUR{ raw } onRequestOnly } }
      location{ city zip }
      vehicle{
        classification{ make{ formatted } model{ formatted } modelVersionInput }
        condition{ mileageInKm{ raw } firstRegistrationDate{ formatted } }
        engine{ transmissionType{ formatted } engineDisplacementInCCM{ raw } }
        fuels{ primary{ type{ raw formatted } } fuelCategory{ formatted } }
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
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.write(data); req.end();
  });
}

// Variabili dalla nostra params. classification: make/model = ID numerici del
// catalogo (mmmvAutoscout = "makeId|modelId|...", brand-only = "makeId|||").
function buildVariables(params, page) {
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

  const vars = { v, loc, m };
  if (params.prezzoMin != null || params.prezzoMax != null) {
    vars.pr = { price: { from: params.prezzoMin || 1, to: params.prezzoMax || 100000000 } };
  }
  return vars;
}

const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) ? y : null; };

function mapListing(node) {
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

  return {
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
  };
}

async function fetchPage(params, page) {
  const variables = buildVariables(params, page);
  if (!variables) return { items: [], raw: 0 };
  const res = await httpPost(JSON.stringify({ query: QUERY, variables }));
  if (res.status === 401) throw new Error('AS24 GraphQL 401 (credenziale)');   // → fallback
  if (res.status !== 200) throw new Error(`AS24 GraphQL HTTP ${res.status}`);
  let j;
  try { j = JSON.parse(res.body); } catch (_) { throw new Error('AS24 GraphQL: body non-JSON'); }
  if (j.errors) throw new Error('AS24 GraphQL errors: ' + JSON.stringify(j.errors).slice(0, 120));
  const arr = ((j.data || {}).search || {}).listings;
  const list = (arr && arr.listings) || [];
  // `raw` = annunci grezzi della pagina (per decidere se c'è una pagina dopo);
  // `items` è filtrato (onRequestOnly/prezzo-null) → non usarlo per la paginazione.
  return { items: list.map(mapListing).filter(Boolean), raw: list.length };
}

/** Ritorna gli annunci AS24 via API. Throw su errore → fallback Playwright. */
async function scrapeAutoscoutGraphql(params) {
  const out = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const { items, raw } = await fetchPage(params, p);
    out.push(...items);
    if (raw < PAGE_SIZE) break;   // ultima pagina (conteggio GREZZO, non filtrato)
  }
  return out;
}

module.exports = scrapeAutoscoutGraphql;
module.exports._mapListing = mapListing;
module.exports._buildVariables = buildVariables;
