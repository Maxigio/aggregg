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

const { kindForStatus, fail } = require('./utils');   // classificazione salute crawler (F1.5)

const HOST = 'listing-search.api.autoscout24.com';
const AUTH = 'Basic YXMyNC1zZWFyY2gtZnVubmVsOnZucmZiYkJqSTMyT2wxV2thNnVOSFJwM0VZbjRkag==';
const PAGE_SIZE = 50;
const MAX_PAGES = 2;          // 2×50 = 100 (più del path Playwright: 3×~17)
const TIMEOUT_MS = 15000;

// Query ridotta ai soli campi mappati (+ media.images webp per lo slider; no leasing/360).
const QUERY = `query Search($v:Vehicle_,$loc:Location_,$pr:Price_,$m:Metadata_){
  search{ listings(vehicle:$v, location:$loc, price:$pr, metadata:$m, locale:it_IT){
    listings{ details(withFallbackAttributes:true){
      webPage
      publication{ createdTimestampWithOffset }
      prices{ public{ amountInEUR{ raw } onRequestOnly } }
      location{ city zip }
      seller{ type }
      media{ images(with360Images:false, first:5){ __typename ... on StandardImage{ formats{ webp{ size420x315 size800x600 } } } } }
      vehicle{
        classification{ make{ formatted } model{ formatted } modelVersionInput }
        condition{ mileageInKm{ raw } firstRegistrationDate{ formatted } numberOfPreviousOwnersExtended{ raw } damage{ isCurrentlyDamaged } }
        engine{ transmissionType{ formatted } engineDisplacementInCCM{ raw } power{ hp{ raw } } numberOfCylinders }
        fuels{ primary{ type{ raw formatted } } fuelCategory{ formatted } }
        bodyColor{ formatted }
        bodyType{ formatted }
        usageState
      }
    } }
  } }
}`.replace(/\s+/g, ' ');

function httpPost(body, auth = AUTH) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      host: HOST, path: '/graphql', method: 'POST',
      headers: {
        'authorization': auth,
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
  // Regione AS24 NATIVA = location + raggio (come il sito ufficiale: per "Lombardia"
  // manda zip="Lombardia (italy)" + zipr + lat/lon del capoluogo). `params.autoscoutGeo`
  // è risolto da server.js dai centroidi-regione. Sostituisce il vecchio post-filtro.
  if (params.autoscoutGeo && params.autoscoutGeo.lat != null) {
    loc.position = { latitude: params.autoscoutGeo.lat, longitude: params.autoscoutGeo.lng };
    if (params.autoscoutGeo.radius) loc.radius = params.autoscoutGeo.radius;
    if (params.autoscoutGeo.zip)    loc.zip = [params.autoscoutGeo.zip];
  }
  const m = { page, size: PAGE_SIZE };
  // Crawler: ordina per età crescente (Age Asc = più recenti prima) per non
  // sprecare le prime pagine sugli annunci-civetta a basso prezzo (sort default
  // = prezzo crescente). enum passati come stringhe via variabili.
  if (opts.sortByDate) m.sort = [{ field: 'Age', order: 'Asc' }];

  // Km + anno NATIVI (input Vehicle_, verificati via introspezione + query live):
  //  - mileageInKm: IntRange {from,to} in km raw.
  //  - firstRegistration: IntRange {from,to} in formato yyyymmdd (modelYear è vuoto
  //    per le auto → inutile). Cosi l'anno è filtrato alla fonte: pagina 1 già in-range,
  //    niente più hack sort-by-date + maxPages in server.js.
  if (params.kmMin != null || params.kmMax != null) {
    v.mileageInKm = { from: params.kmMin || 0, to: params.kmMax || 100000000 };
  }
  if (params.annoMin != null || params.annoMax != null) {
    v.firstRegistration = {
      from: (params.annoMin || 1900) * 10000 + 101,
      to:   (params.annoMax || 2100) * 10000 + 1231,
    };
  }

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

  // Specs ricche NATIVE (una sola query, zero richieste extra). null se assenti.
  const eng = v.engine || {};
  const cond = v.condition || {};
  const hp = eng.power && eng.power.hp ? eng.power.hp.raw : null;
  const dmg = cond.damage;                                  // { isCurrentlyDamaged } | null
  const sellerType = (dt.seller && dt.seller.type) || '';   // 'PrivateSeller' | 'Dealer'
  const venditore = /dealer/i.test(sellerType) ? 'concessionario'
                  : /private/i.test(sellerType) ? 'privato' : null;
  // danni: nativo `damage.isCurrentlyDamaged` (più affidabile), fallback al vecchio usageState.
  const danni = dmg && typeof dmg.isCurrentlyDamaged === 'boolean'
    ? dmg.isCurrentlyDamaged
    : (usage ? DAMAGED.has(usage) : null);

  // Immagini NATIVE (stessa query, zero costo extra). Solo StandardImage con webp;
  // entry senza webp (video/360/altro) scartate.
  const immagini = ((dt.media && dt.media.images) || []).reduce((acc, im) => {
    const w = im && im.formats && im.formats.webp;
    if (w && w.size420x315) acc.push({ thumb: w.size420x315, full: w.size800x600 || w.size420x315 });
    return acc;
  }, []);

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
    // Specs ricche NATIVE; null se assenti (gap onesto, niente fabbricazione).
    potenzaCv: hp,
    cilindri: eng.numberOfCylinders ?? null,
    proprietari: cond.numberOfPreviousOwnersExtended ? cond.numberOfPreviousOwnersExtended.raw : null,
    colore: (v.bodyColor && v.bodyColor.formatted) || null,
    carrozzeria: (v.bodyType && v.bodyType.formatted) || null,
    venditore,
    immagini,
    zip: (dt.location && dt.location.zip) || null,   // per il post-filtro regione (fallback CAP→regione)
    url: dt.webPage || null,
    // Campi per il DB (usati dal crawler; ignorati dal path on-search legacy):
    nuovo: usage ? usage === 'New' : null,
    danni,   // nativo damage.isCurrentlyDamaged, fallback usageState
    posted_at: (dt.publication && dt.publication.createdTimestampWithOffset) || null,
  };
  // raw_json (keep-last) senza `media`: gli URL immagine non vanno persistiti
  // (servono solo al display on-search) → evita di gonfiare raw_json sui crawl profondi.
  if (opts.attachRaw) { const { media, ...rawNoMedia } = dt; out._raw = rawNoMedia; }
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

// ─── F50 copertura: conteggio totale per-query (count-query LEGGERA, separata) ───
// La query di RICERCA (sopra) NON espone metadata.totalItems (validation-fail
// verificato). Questa usa `listingsByQueryString` (curl utente provato) con l'auth
// del client `home-feed-js`. La chiama il CRAWLER (NON la ricerca) → +1 richiesta cheap.
const COUNT_AUTH = 'Basic aG9tZS1mZWVkLWpzOnAzNVBLeUZCNG5VREtFTllKNG9HUTVJYjFTM0NieQ==';
const COUNT_QUERY = `query GET_TOTAL_LISTING_COUNT_BY_QUERY_STRING($queryString:String!,$locale:Locale_){ search{ listingsByQueryString(queryString:$queryString, locale:$locale){ metadata{ totalItems } } } }`;

// PURO: mmmv "make|model|..." → queryString. atype=C auto / B moto (entrambi provati).
// ustate=U: il tetto deve combaciare con lo SCOPE che ingeriamo. `listings()` ci dà il
// "non-nuovo" (usato + km0/demo; 0 `nuovo=true` su 87k AS24 in DB), ed `ustate=U` conta
// lo stesso insieme (escludendo solo le Neu). Verificato live (Audi A3): ustate=U=5553 ≈
// listings() per-fetta. NB: il GROSSO buco sui best-seller (Audi A3: ~5300 usate vere vs
// 1629 ingerite = 31%) NON sono auto nuove — è il TETTO DI PAGINAZIONE di `listings()`
// (~1629/query): si recupera spezzando la query per anno/prezzo (vedi M-K), non qui.
function countQueryString(mmmv, tipo, range = {}) {
  const [make, model] = String(mmmv || '').split('|');
  if (!make) return null;
  const atype = tipo === 'moto' ? 'B' : 'C';
  let qs = `sort=standard&desc=0&ustate=U&atype=${atype}&cy=I&mmm=${make}|${model || ''}|`;
  // M-K split: range opzionali per stare sotto il tetto di paginazione AS24 (~1629/query).
  // anno = fregfrom/fregto (PROVATO live: fregto=2015→1417 + fregfrom=2016→3887 = totale 5304).
  // prezzo = pricefrom/priceto (usato solo se un singolo anno sfora; da verificare live).
  const { annoMin, annoMax, prezzoMin, prezzoMax } = range || {};
  if (annoMin != null) qs += `&fregfrom=${annoMin}`;
  if (annoMax != null) qs += `&fregto=${annoMax}`;
  if (prezzoMin != null) qs += `&pricefrom=${prezzoMin}`;
  if (prezzoMax != null) qs += `&priceto=${prezzoMax}`;
  return qs;
}

// PURO: estrae totalItems dalla risposta GraphQL (o null). Testabile senza rete.
function parseTotalCount(j) {
  const n = j && j.data && j.data.search && j.data.search.listingsByQueryString
    && j.data.search.listingsByQueryString.metadata && j.data.search.listingsByQueryString.metadata.totalItems;
  return Number.isFinite(n) ? n : null;
}

// Ritorna il totale AS24 per (mmmv,tipo[,range anno/prezzo]) o null. Best-effort: mai throw.
async function fetchTotalCount({ mmmv, tipo, annoMin, annoMax, prezzoMin, prezzoMax } = {}) {
  const qs = countQueryString(mmmv, tipo, { annoMin, annoMax, prezzoMin, prezzoMax });
  if (!qs) return null;
  try {
    const res = await httpPost(JSON.stringify({ query: COUNT_QUERY, variables: { queryString: qs, locale: 'it_IT' } }), COUNT_AUTH);
    if (res.status !== 200) return null;
    return parseTotalCount(JSON.parse(res.body));
  } catch (_) {
    return null;
  }
}

// ─── M-K: pianifica i bucket per superare il tetto di paginazione AS24 ───────────
// `listings()` serve ~1629 risultati/query poi si ferma. Per i best-seller (Audi A3
// ~5300 usate) spezziamo per ANNO (poi per PREZZO se un singolo anno sfora), così ogni
// sotto-query sta sotto il tetto ed è paginabile per intero. PURO rispetto alla rete:
// `countFn(range)->Promise<number|null>` è INIETTATA → testabile senza HTTP. Ritorna una
// lista di range-foglia {annoMin,annoMax[,prezzoMin,prezzoMax]}; `[{}]` = una sola sweep
// piena (totale ≤ soglia o count KO → comportamento attuale).
const SPLIT_OVER = 1500;            // margine sotto il ceiling ~1629
const SPLIT_PRICE_MAX = 1000000;    // bound della bisezione prezzo; il bucket TOP è APERTO
                                    // (prezzoMax=null) → le auto > MAX (supercar) NON si perdono

async function planBuckets(countFn, opts = {}) {
  const splitOver = opts.splitOver || SPLIT_OVER;
  // F1 (review): yMin BASSO (1900) + yMax con buffer (+2) → la bisezione copre TUTTI gli anni
  // reali (epoca inclusa) e i futuri-datati; niente cade fuori dai bucket (countFn({}) = Σ foglie,
  // partizione esatta). yMin=1985 droppava silenziosamente l'usato pre-1985 dei modelli d'epoca.
  const yMin = opts.yearMin || 1900;
  const yMax = opts.yearMax || (new Date().getFullYear() + 2);
  const maxLeaves = opts.maxLeaves || 24;   // anti-runaway (best-seller ≈ 6-10 foglie)
  const leaves = [];

  async function recurPrice(year, lo, hi) {
    // bordi APERTI agli estremi: prezzoMin=0→null (nessun pricefrom), prezzoMax=MAX→null
    // (nessun priceto → cattura > MAX). Così la partizione prezzo copre [0, +∞) senza buchi.
    const range = { annoMin: year, annoMax: year,
                    prezzoMin: lo <= 0 ? null : lo,
                    prezzoMax: hi >= SPLIT_PRICE_MAX ? null : hi };
    const n = await countFn(range);
    if (n == null || n <= splitOver || hi - lo <= 1000 || leaves.length >= maxLeaves) {
      leaves.push(range); return;
    }
    const mid = Math.floor((lo + hi) / 2);
    await recurPrice(year, lo, mid);
    await recurPrice(year, mid + 1, hi);
  }

  async function recurYear(a, b) {
    const n = await countFn({ annoMin: a, annoMax: b });
    if (n == null || n <= splitOver) { leaves.push({ annoMin: a, annoMax: b }); return; }
    if (a >= b) { await recurPrice(a, 0, SPLIT_PRICE_MAX); return; }   // singolo anno troppo grande → prezzo
    if (leaves.length >= maxLeaves) { leaves.push({ annoMin: a, annoMax: b }); return; }
    const mid = (a + b) >> 1;
    await recurYear(a, mid);
    await recurYear(mid + 1, b);
  }

  const total = await countFn({});                       // {} = nessun range = query piena
  if (total == null || total <= splitOver) return [{}];  // sweep singola (comportamento attuale)
  await recurYear(yMin, yMax);
  return leaves.length ? leaves : [{}];
}

module.exports = scrapeAutoscoutGraphql;
module.exports._mapListing = mapListing;
module.exports._buildVariables = buildVariables;
module.exports.fetchTotalCount = fetchTotalCount;       // F50 copertura (chiamato dal crawler)
module.exports.planBuckets = planBuckets;               // M-K split (crawler + test; countFn iniettata = puro)
module.exports.SPLIT_OVER = SPLIT_OVER;
module.exports._countQueryString = countQueryString;    // PURO, testabile senza rete
module.exports._parseTotalCount = parseTotalCount;      // PURO, testabile senza rete
