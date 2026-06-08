/**
 * Scraper Autoscout24 con Playwright (Chrome headless).
 * Sostituisce axios + __NEXT_DATA__ con un browser vero per evitare blocchi
 * anti-bot e garantire completezza + ordinamento priceasc.
 *
 * Funzionalità:
 * - URL unico mmmv-based per auto e moto: /lst?atype=C|B&cy=I&mmmv=...
 *   (params.autoscoutMmmv obbligatorio, risolto da server.js tramite data/models.json)
 * - Sort server-side: sort=price&desc=0 (prezzo crescente)
 * - 4 pagine in parallelo (~80 risultati, target completezza)
 * - Browser singleton riusato per tutta la sessione
 * - Se autoscoutMmmv mancante (brand non su AS24 o modello solo-Subito): return []
 */

const { chromium } = require('playwright');
const path = require('path');
const https = require('https');
const { parseEuro, parseKm, REGION_AS24, resolveChromiumExecutable } = require('./utils');
const filtersSchema = require('./filters-schema');

const BASE = 'https://www.autoscout24.it';
const NUM_PAGES = 3;   // §17.2: 5→3 (i più economici restano in cima per l'ordine prezzo)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// §17.1: path HTTPS diretto (no browser) come primario, fallback Playwright. Spegnibile.
const USE_HTTP_SCRAPE = process.env.USE_HTTP_SCRAPE !== '0';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET https con redirect+timeout → { status, body }.
function httpGetText(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return httpGetText(next, hops + 1).then(resolve, reject);
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// Parse __NEXT_DATA__ da HTML → { items, ok }. ok=false ⇒ struttura attesa
// assente (probabile challenge/soft-block) → il chiamante fa fallback al browser.
function parseAs24Html(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { items: [], ok: false };
  let nextData;
  try { nextData = JSON.parse(m[1]); } catch (_) { return { items: [], ok: false }; }
  const listings = nextData?.props?.pageProps?.listings;
  if (!Array.isArray(listings)) return { items: [], ok: false };
  return { items: listings.map(parseListing).filter(Boolean), ok: true };
}

// Tutte le pagine via HTTPS in parallelo. blocked=true se UNA pagina è sospetta
// (no __NEXT_DATA__ / HTTP≠200&≠404) → fallback browser sull'intera ricerca.
async function scrapeAs24ViaHttp(urls) {
  const res = await Promise.all(urls.map(async u => {
    try {
      const { status, body } = await httpGetText(u);
      if (status === 404) return { items: [], ok: true };       // 404 genuino (modello assente su AS24)
      if (status !== 200) return { items: [], ok: false };
      return parseAs24Html(body);
    } catch (_) { return { items: [], ok: false }; }
  }));
  return { pages: res.map(r => r.items), blocked: res.some(r => !r.ok) };
}

// In un bundle Electron (macOS/Windows) le risorse sono in process.resourcesPath/pw-browsers.
// In dev (senza bundle) usiamo la cartella locale al repo.
const _respath = process.env.RESOURCES_PATH || process.resourcesPath;
const PW_BROWSERS = _respath && require('fs').existsSync(path.join(_respath, 'pw-browsers'))
  ? path.join(_respath, 'pw-browsers')
  : path.join(__dirname, '../../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

// ─── Browser singleton ───────────────────────────────────────────────────────
let browserInstance = null;

async function getBrowser() {
  if (browserInstance) {
    try { browserInstance.contexts(); return browserInstance; } catch (_) {}
  }
  console.log('[AS24-PW] Avvio Chrome headless…');
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

// ─── Costruzione URL ─────────────────────────────────────────────────────────
function buildFilters({ prezzoMin, prezzoMax, annoMin, annoMax, kmMax }) {
  const qs = new URLSearchParams({ cy: 'I' });
  qs.set('sort', 'price');
  qs.set('desc', '0');
  if (prezzoMin != null) qs.set('pricefrom', prezzoMin);
  if (prezzoMax != null) qs.set('priceto',   prezzoMax);
  if (annoMin   != null) qs.set('fregfrom',  annoMin);
  if (annoMax   != null) qs.set('fregto',    annoMax);
  if (kmMax     != null) qs.set('kmto',      kmMax);
  return qs;
}

function buildUrl(params, page = 1) {
  const { tipo, autoscoutMmmv, regione, filtersAutoscout } = params;
  if (!autoscoutMmmv) return { unsupported: true };
  const qs = buildFilters(params);
  qs.set('atype', tipo === 'moto' ? 'B' : 'C');
  qs.set('mmmv', autoscoutMmmv);
  if (page > 1) qs.set('page', String(page));

  // Filtri specifici Autoscout (P10) — definiti in filters-schema.js
  // Es: { carburante: 'D', cambio: 'M', carrozzeria: '4' } → &fuel=D&gear=M&bt=4
  if (filtersAutoscout && Object.keys(filtersAutoscout).length > 0) {
    const asSchema = filtersSchema.AUTOSCOUT_FILTERS.filter(f => f.appliesTo.includes(tipo));
    filtersSchema.applySiteFilters(qs, filtersAutoscout, asSchema);
  }

  // Filtro geografico regionale (verificato a mano contro l'UI di AS24):
  //   /lst?mmmv=...&zip=<Region>%20(Italy)&zipr=<km>&lat=<lat>&lon=<lon>
  // È l'UNICO modo affidabile per filtrare per area mantenendo mmmv intatto.
  // Tentativi precedenti con path /lst-*/<brand>/<model>/<Region>%20(Italy)
  // fallivano perché non abbiamo slug AS24 per-modello nel catalogo (gli slug
  // di Moto.it/Subito non coincidono: "t-max-500" vs "tmax-500") e lo slug
  // errato azzerava il filtro modello → risultati sbagliati.
  const geo = regione && REGION_AS24[regione];
  if (geo) {
    qs.set('zip',  `${geo.label} (Italy)`);
    qs.set('zipr', String(geo.zipr));
    qs.set('lat',  String(geo.lat));
    qs.set('lon',  String(geo.lon));
  }

  return { url: `${BASE}/lst?${qs.toString()}` };
}

// ─── Parsing annuncio ────────────────────────────────────────────────────────
function detail(vehicleDetails, label) {
  return (vehicleDetails || []).find(d => d.ariaLabel === label)?.data;
}

function parseAnno(vehicleDetails) {
  const data = detail(vehicleDetails, 'Anno');
  if (!data) return null;
  const parts = data.split('/');
  const year = parseInt(parts[parts.length - 1], 10);
  return isNaN(year) ? null : year;
}

function parseProvincia(city) {
  if (!city) return null;
  // AS24 formati visti: "Venaria Reale - Torino - TO", "Marino- Rm",
  // "Milano - MI". Cerca il codice provincia (2 lettere uppercase) alla fine.
  const match = city.match(/\b([A-Za-z]{2})\s*$/);
  if (!match) return null;
  const prov = match[1].toUpperCase();
  return /^[A-Z]{2}$/.test(prov) ? prov : null;
}

function parseListing(item) {
  if (!item.url) return null;
  const url = `${BASE}${item.url}`;

  const make = item.vehicle?.make || '';
  let modelPart = item.vehicle?.modelVersionInput
                  || item.vehicle?.modelGroup
                  || item.vehicle?.model
                  || '';
  if (make && modelPart.toLowerCase().startsWith(make.toLowerCase())) {
    modelPart = modelPart.slice(make.length).trim();
  }

  // §22 — campi strutturati gratis dal payload AS24 (no fetch).
  const ccmRaw = item.vehicle?.engineDisplacementInCCM;
  const cilindrata = ccmRaw ? (parseInt(String(ccmRaw).replace(/[^\d]/g, ''), 10) || null) : null;

  return {
    fonte:      'autoscout',
    titolo:     [make, modelPart].filter(Boolean).join(' ') || 'Annuncio senza titolo',
    prezzo:     parseEuro(item.price?.priceFormatted),
    km:         parseKm(detail(item.vehicleDetails, 'Chilometraggio')),
    anno:       parseAnno(item.vehicleDetails),
    carburante: detail(item.vehicleDetails, 'Carburante') || null,
    provincia:  parseProvincia(item.location?.city),
    // §22 strutturati (mostrati istantanei nel pannello "Dettagli")
    cambio:     item.vehicle?.transmission || null,
    cilindrata,
    variante:   item.vehicle?.modelVersionInput || item.vehicle?.variant || null,
    url,
  };
}

// ─── Fetch singola pagina ────────────────────────────────────────────────────
async function fetchPage(browser, url) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    // 404 sul modello moto (slug non presente nel catalogo AS24): no fallback, torna []
    if (resp && resp.status() === 404) {
      console.log(`[AS24-PW] 404 su ${url} — skip`);
      return [];
    }

    const nextDataJson = await page.$eval(
      '#__NEXT_DATA__',
      el => el.textContent
    ).catch(() => null);

    if (!nextDataJson) {
      console.warn('[AS24-PW] __NEXT_DATA__ non trovato su:', url);
      return [];
    }

    const nextData = JSON.parse(nextDataJson);
    const listings = nextData?.props?.pageProps?.listings;
    if (!Array.isArray(listings)) return [];

    return listings.map(parseListing).filter(Boolean);
  } finally {
    await context.close();
  }
}

// ─── Rate limit: 2s tra ricerche ─────────────────────────────────────────────
let lastSearchAt = 0;
async function throttle() {
  const wait = 2000 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

// ─── Scraper principale ──────────────────────────────────────────────────────
async function scrapeAutoscout(params) {
  await throttle();

  const first = buildUrl(params, 1);
  if (first.unsupported) {
    console.log('[AS24-PW] Brand/modello non disponibile su AS24 → 0 risultati');
    return [];
  }

  const urls = Array.from({ length: NUM_PAGES }, (_, i) => buildUrl(params, i + 1).url);
  const dedup = pages => {
    const visti = new Set();
    return pages.flat().filter(r => { if (visti.has(r.url)) return false; visti.add(r.url); return true; });
  };

  // §17.1 — path HTTPS primario (no browser). Solo se NON bloccato ci si fida
  // (anche 0 risultati genuini va bene); se bloccato/sospetto → fallback browser.
  if (USE_HTTP_SCRAPE) {
    try {
      const { pages, blocked } = await scrapeAs24ViaHttp(urls);
      if (!blocked) {
        const risultati = dedup(pages);
        console.log(`[AS24-HTTP] OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})`);
        return risultati;
      }
      console.warn('[AS24-HTTP] sospetto blocco/struttura assente → fallback browser');
    } catch (e) {
      console.warn(`[AS24-HTTP] errore (${e.message}) → fallback browser`);
    }
  }

  const browser = await getBrowser();
  console.log(`[AS24-PW] Fetching ${NUM_PAGES} pagine (browser): ${urls[0]}`);
  const pages = await Promise.all(urls.map(u => fetchPage(browser, u).catch(err => {
    console.warn(`[AS24-PW] Errore pagina ${u}: ${err.message}`);
    return [];
  })));

  const risultati = dedup(pages);
  console.log(`[AS24-PW] Totale: ${risultati.length} annunci (${pages.map(p => p.length).join('+')})`);
  return risultati;
}

// Esposto per pre-warm al boot del server.
scrapeAutoscout.warmup = async () => { await getBrowser(); };
scrapeAutoscout._parseListing = parseListing;   // hook per i test (§20)

module.exports = scrapeAutoscout;
