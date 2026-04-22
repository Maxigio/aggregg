/**
 * Scraper Subito.it con Playwright (Chrome headless reale).
 * Sostituisce axios + __NEXT_DATA__ con un browser vero per evitare i 403.
 *
 * Funzionalità:
 * - Chrome headless con flags anti-rilevamento
 * - Ordinamento per prezzo crescente (sort=p&order=asc)
 * - Fino a 5 pagine sequenziali (~150 risultati) con early-stop se pagina vuota
 * - Browser riusato per tutta la sessione (più veloce dalla seconda ricerca)
 */

const { chromium } = require('playwright');
const path         = require('path');
const { toSlug, toInt, resolveChromiumExecutable } = require('./utils');

// ─── Conversione km raw → codice categorico Subito ───────────────────────────
// Subito usa indici di categoria per il filtro km, NON valori raw.
// Fonte: https://hades.subito.it/v1/values/mileage/max
// key=1 → ≤4.999km, key=2 → ≤9.999km, key=3 → ≤14.999km ... key=36 → ≤499.999km
const KM_MAX_TABLE = [
  [4999,1],[9999,2],[14999,3],[19999,4],[24999,5],[29999,6],[34999,7],[39999,8],
  [44999,9],[49999,10],[54999,11],[59999,12],[64999,13],[69999,14],[74999,15],
  [79999,16],[84999,17],[89999,18],[94999,19],[99999,20],[109999,21],[119999,22],
  [129999,23],[139999,24],[149999,25],[159999,26],[169999,27],[179999,28],
  [189999,29],[199999,30],[249999,31],[299999,32],[349999,33],[399999,34],
  [449999,35],[499999,36],
];

function kmMaxToKey(kmMax) {
  // Trova il primo step il cui limite copre il kmMax richiesto.
  // Arrotondiamo per eccesso così non escludiamo annunci al limite.
  // Il post-filter in server.js garantisce il rispetto esatto del valore.
  for (const [limit, key] of KM_MAX_TABLE) {
    if (limit >= kmMax) return key;
  }
  return 36; // oltre 499.999 km
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Path Chromium cross-platform (dev vs bundle Electron) ───────────────────
const _respath = process.env.RESOURCES_PATH || process.resourcesPath;
const PW_BROWSERS = _respath && require('fs').existsSync(path.join(_respath, 'pw-browsers'))
  ? path.join(_respath, 'pw-browsers')
  : path.join(__dirname, '../../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

// ─── Browser singleton (aperto una volta, riusato per tutte le ricerche) ─────
let browserInstance = null;

async function getBrowser() {
  if (browserInstance) {
    // Verifica che sia ancora aperto
    try { browserInstance.contexts(); return browserInstance; } catch (_) {}
  }
  console.log('[Subito-PW] Avvio Chrome headless…');
  browserInstance = await chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  browserInstance.on('disconnected', () => { browserInstance = null; });
  return browserInstance;
}

// ─── Costruzione URL ──────────────────────────────────────────────────────────
function buildUrl({ tipo, marca, modello, regione: regioneParam, prezzoMin, prezzoMax, annoMin, annoMax, kmMax, slugSubito, modelloSlugSubito, motoBrandKey, motoModelKey }, page = 1) {
  const regione = regioneParam || 'italia';

  const qs = new URLSearchParams();
  // Ordinamento per prezzo crescente — formato corretto Subito
  qs.set('order', 'priceasc');
  // Pagina (Subito usa ?o=N, 1-based)
  if (page > 1) qs.set('o', String(page));

  let baseUrl;
  if (tipo === 'auto') {
    const marcaSlug   = slugSubito || toSlug(marca);
    // Usa slugSubito dal database (campo modelloSlugSubito), se disponibile.
    // Fallback a toSlug(modello) per retrocompatibilità (es. ricerche senza modello nel DB).
    const modelloSlug = modello ? (modelloSlugSubito || toSlug(modello)) + '/' : '';
    baseUrl = `https://www.subito.it/annunci-${regione}/vendita/auto/${marcaSlug}/${modelloSlug}`;
  } else {
    // Moto: usa chiavi numeriche bb (brand) e bm (model) — stesso sistema di Subito
    baseUrl = `https://www.subito.it/annunci-${regione}/vendita/moto-e-scooter/`;
    if (motoBrandKey) {
      qs.set('bb', motoBrandKey);
      if (motoModelKey) qs.set('bm', motoModelKey);
    } else {
      // fallback testuale se le chiavi non sono disponibili
      qs.set('q', modello ? `${marca} ${modello}` : marca);
    }
  }

  if (prezzoMin != null) qs.set('ps', prezzoMin);
  if (prezzoMax != null) qs.set('pe', prezzoMax);
  if (annoMin   != null) qs.set('ys', annoMin);
  if (annoMax   != null) qs.set('ye', annoMax);
  // km → codice categoria Subito (NON valore raw)
  if (kmMax     != null) qs.set('me', kmMaxToKey(kmMax));

  return `${baseUrl}?${qs.toString()}`;
}

// ─── Parsing annuncio dal JSON __NEXT_DATA__ ──────────────────────────────────
function parseItem(entry) {
  const item = entry?.item;
  if (!item || item.kind !== 'AdItem') return null;

  const f   = item.features || {};
  const url = item.urls?.default;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  return {
    fonte:      'subito',
    titolo:     item.subject || 'Annuncio senza titolo',
    prezzo:     toInt(f['/price']?.values?.[0]?.key),
    km:         toInt(f['/mileage_scalar']?.values?.[0]?.key),
    anno:       toInt(f['/year']?.values?.[0]?.key),
    carburante: f['/fuel']?.values?.[0]?.value || null,
    provincia:  item.geo?.city?.shortName || null,
    url,
  };
}

// ─── Fetch singola pagina ─────────────────────────────────────────────────────
async function fetchPage(browser, url) {
  const context = await browser.newContext({
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:     'it-IT',
    viewport:   { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Nascondi il flag webdriver a livello di script di pagina
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Estrai __NEXT_DATA__ dal DOM (più affidabile che dall'HTML grezzo)
    const nextDataJson = await page.$eval(
      '#__NEXT_DATA__',
      el => el.textContent
    ).catch(() => null);

    if (!nextDataJson) {
      console.warn('[Subito-PW] __NEXT_DATA__ non trovato su:', url);
      return [];
    }

    const nextData = JSON.parse(nextDataJson);
    const list     = nextData?.props?.pageProps?.initialState?.items?.list;
    if (!Array.isArray(list)) return [];

    return list.map(parseItem).filter(Boolean);
  } finally {
    await context.close();
  }
}

// ─── Rate limiting: minimo 2s tra una ricerca e la successiva ────────────────
let lastSearchAt = 0;
async function throttle() {
  const wait = 2000 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

const MAX_PAGES = 5;

// ─── Scraper principale ───────────────────────────────────────────────────────
async function scrapeSubito(params) {
  await throttle();
  const browser = await getBrowser();

  console.log(`[Subito-PW] Pagina 1: ${buildUrl(params, 1)}`);

  // Pagine sequenziali con pausa randomizzata: evita pattern rilevabili da Akamai WAF.
  // Early-stop quando una pagina restituisce 0 annunci (fine risultati raggiunta).
  const pages = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = buildUrl(params, p);
    const items = await fetchPage(browser, url);
    pages.push(items);
    if (items.length === 0) break;
    if (p < MAX_PAGES) await sleep(800 + Math.random() * 600);
  }

  // Deduplicazione per URL
  const visti    = new Set();
  const risultati = pages.flat().filter(r => {
    if (visti.has(r.url)) return false;
    visti.add(r.url);
    return true;
  });

  const conteggi = pages.map(p => p.length).join('+');
  console.log(`[Subito-PW] Totale: ${risultati.length} annunci (${conteggi})`);
  return risultati;
}

// Esposto per pre-warm al boot del server (evita primo-lancio in parallelo che
// saturerebbe il TIMEOUT_MS della prima ricerca).
scrapeSubito.warmup = async () => { await getBrowser(); };

module.exports = scrapeSubito;
