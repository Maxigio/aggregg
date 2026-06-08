/**
 * Scraper Moto.it con Playwright (Chrome headless reale).
 *
 * Architettura:
 * - Usa il motore di ricerca vero /moto-usate/ricerca (non la landing SEO /moto-usate/{marca})
 * - Filtri server-side supportati: brand, model, price_f/t, km_f/t, year_f/t, sort
 * - Paginazione via /moto-usate/ricerca/pagina-N
 * - 13 annunci/pagina × 5 pagine = ~65 annunci per ricerca (obiettivo: i 50 più economici)
 * - Ordinamento price-a (prezzo crescente) allineato all'obiettivo utente
 *
 * Strategia slug (SOLO slug espliciti dal catalogo, niente fallback fallaci):
 *   - Brand slug: motoitBrandSlug (da brandEntry.motoit.brandSlug del catalogo)
 *   - Model slug: motoitModelSlug (da modelEntry.slugMotoIt del catalogo)
 *   Se motoitBrandSlug manca → bail out con [] (il brand non è su Moto.it).
 */

const { chromium } = require('playwright');
const path         = require('path');
const https        = require('https');
const cheerio      = require('cheerio');
const { toInt, resolveChromiumExecutable } = require('./utils');
const filtersSchema = require('./filters-schema');

const BASE = 'https://www.moto.it';
const MAX_PAGES = 3;   // §17.2: 5→3 (ordine prezzo → i più economici restano in cima)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// §17.1: path HTTPS diretto (cheerio, no browser) primario, fallback Playwright. Spegnibile.
const USE_HTTP_SCRAPE = process.env.USE_HTTP_SCRAPE !== '0';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// ─── Path Chromium cross-platform (dev vs bundle Electron) ───────────────────
const _respath = process.env.RESOURCES_PATH || process.resourcesPath;
const PW_BROWSERS = _respath && require('fs').existsSync(path.join(_respath, 'pw-browsers'))
  ? path.join(_respath, 'pw-browsers')
  : path.join(__dirname, '../../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

// ─── Browser singleton (riusato tra ricerche successive) ─────────────────────
let browserInstance = null;

async function getBrowser() {
  if (browserInstance) {
    try { browserInstance.contexts(); return browserInstance; } catch (_) {}
  }
  console.log('[Moto.it-PW] Avvio Chrome headless…');
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
// Moto.it offre un motore di ricerca completo a /moto-usate/ricerca con query params.
// Paginazione via /pagina-N nel path (NON come query param).
function buildUrl(params, page = 1) {
  const { prezzoMin, prezzoMax, annoMin, annoMax, kmMax, regione,
          motoitBrandSlug, motoitModelSlug, filtersMotoit } = params;

  // Path pagina (1 = senza suffisso, >1 = /pagina-N)
  const pagePath = page > 1 ? `/pagina-${page}` : '';

  const qs = new URLSearchParams();

  // Brand (obbligatorio — garantito dal server che skippa quando manca)
  const brandSlug = motoitBrandSlug;
  qs.set('brand', brandSlug);

  // Modello: formato "brandSlug|modelSlug" (es. "ducati|monster-1100")
  if (motoitModelSlug) {
    qs.set('model', `${brandSlug}|${motoitModelSlug}`);
  }

  // Regione: Moto.it accetta region=<slug> server-side (stesso formato di province.json:
  // "liguria", "emilia-romagna", "valle-d-aosta"…). Fondamentale per evitare che il
  // sort=price-a globale tagli fuori i risultati regionali dai primi 65.
  if (regione) qs.set('region', regione);

  // Filtri numerici
  if (prezzoMin != null) qs.set('price_f', String(prezzoMin));
  if (prezzoMax != null) qs.set('price_t', String(prezzoMax));
  if (kmMax     != null) qs.set('km_t',    String(kmMax));
  if (annoMin   != null) qs.set('year_f',  String(annoMin));
  if (annoMax   != null) qs.set('year_t',  String(annoMax));

  // Ordinamento: prezzo crescente (obiettivo "i più economici")
  qs.set('sort', 'price-a');

  // Filtri specifici Moto.it (P10) — definiti in filters-schema.js
  // Es: { categoria: 'enduro', cilindrata: {from: 600, to: 1300} }
  //   → &category=enduro&displacement_f=600&displacement_t=1300
  if (filtersMotoit && Object.keys(filtersMotoit).length > 0) {
    const miSchema = filtersSchema.MOTOIT_FILTERS.filter(f => f.appliesTo.includes('moto'));
    filtersSchema.applySiteFilters(qs, filtersMotoit, miSchema);
  }

  return `${BASE}/moto-usate/ricerca${pagePath}?${qs.toString()}`;
}

// ─── Parse card visibile nel DOM ─────────────────────────────────────────────
// Estrae i dati da ciascun .mcard--big presente nella pagina.
// La card contiene un innerText strutturato su più righe:
//   "5 marzo 2026 alle 13:32 | Ducati | Scrambler 800 Icon Dark (2025 - 26) | € 1 | Concessionario ufficiale Ducati | Acireale (CT) | 2025 | 6.000 Km"
// Estraiamo: marca, modello, prezzo, anno, km, città/provincia, link.
async function extractCards(page) {
  return await page.$$eval('.mcard--big', cards => cards.map(c => {
    const text = (c.innerText || '').replace(/\n+/g, ' | ').trim();

    // Titolo: h2/h3 contiene "Marca\nModello" — normalizziamo a singolo spazio
    const titleEl = c.querySelector('h2, h3, .mcard-title, [class*="title"]');
    const titolo = titleEl ? (titleEl.innerText || '').replace(/\s+/g, ' ').trim() : null;

    // Prezzo: cerca elemento con "price" nel class
    const priceRaw = c.querySelector('[class*="price"], [class*="prezzo"]')?.innerText?.trim() || null;

    // Link dettaglio
    const href = c.querySelector('a[href]')?.getAttribute('href') || null;

    // Anno: pattern "| 2018 |" (ultimo match — prima riga è la data pubblicazione)
    // Prendiamo l'ultimo anno 4-cifre nel testo, che corrisponde all'anno veicolo
    const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => m[1]);
    const anno = years.length > 0 ? parseInt(years[years.length - 1], 10) : null;

    // Km: "37.576 Km" → 37576
    const kmMatch = text.match(/([\d.]+)\s*Km/i);
    const km = kmMatch ? parseInt(kmMatch[1].replace(/\./g, ''), 10) : null;

    // Provincia: "(CT)", "(TO)", "(PD)"
    const provMatch = text.match(/\(([A-Z]{2})\)/);
    const provincia = provMatch ? provMatch[1] : null;

    return { titolo, priceRaw, href, anno, km, provincia };
  }));
}

// ─── Parser prezzo: "€ 4.800" → 4800, "T.RISERVATA" → null ───────────────────
function parsePrezzo(str) {
  if (!str) return null;
  const clean = str.replace(/[€\s.]/g, '').replace(/,\d+$/, '');
  const n = parseInt(clean, 10);
  return isNaN(n) ? null : n;
}

// Mapping card-grezza → risultato (condiviso path browser + HTTPS).
function mapCards(cards) {
  return cards.map(c => {
    if (!c.href) return null;
    const fullUrl = c.href.startsWith('http') ? c.href : `${BASE}${c.href}`;
    return {
      fonte:      'moto',
      titolo:     c.titolo || 'Annuncio senza titolo',
      prezzo:     parsePrezzo(c.priceRaw),
      km:         c.km,
      anno:       c.anno,
      carburante: null,
      provincia:  c.provincia,
      url:        fullUrl,
    };
  }).filter(Boolean);
}

// §17.1 — Estrae le card da HTML STATICO via cheerio (stessa logica di
// extractCards, ma su stringa invece che su DOM Playwright). Le pagine
// /moto-usate/ricerca rendono le `.mcard--big` server-side (verificato).
function extractCardsHtml(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.mcard--big').each((_, el) => {
    const c = $(el);
    const text = c.text().replace(/\s+/g, ' ').trim();
    const titolo = c.find('h2, h3, .mcard-title, [class*="title"]').first().text().replace(/\s+/g, ' ').trim() || null;
    const priceRaw = c.find('[class*="price"], [class*="prezzo"]').first().text().trim() || null;
    const href = c.find('a[href]').first().attr('href') || null;
    const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => m[1]);
    const anno = years.length ? parseInt(years[years.length - 1], 10) : null;
    const kmMatch = text.match(/([\d.]+)\s*Km/i);
    const km = kmMatch ? parseInt(kmMatch[1].replace(/\./g, ''), 10) : null;
    const provMatch = text.match(/\(([A-Z]{2})\)/);
    const provincia = provMatch ? provMatch[1] : null;
    out.push({ titolo, priceRaw, href, anno, km, provincia });
  });
  return out;
}

// Tutte le pagine via HTTPS in parallelo. blocked se la PRIMA pagina è sospetta
// (status≠200 o 0 card su una query che dovrebbe popolare) → fallback browser.
// Pagine successive con 0 card = fine genuina dei risultati (non blocco).
async function scrapeMotoViaHttp(urls) {
  const res = await Promise.all(urls.map(async (u, i) => {
    try {
      const { status, body } = await httpGetText(u);
      if (status !== 200) return { items: [], ok: false };
      const items = mapCards(extractCardsHtml(body));
      return { items, ok: i === 0 ? items.length > 0 : true };
    } catch (_) { return { items: [], ok: false }; }
  }));
  return { pages: res.map(r => r.items), blocked: !res[0].ok };
}

// ─── Fetch singola pagina ────────────────────────────────────────────────────
async function fetchPage(browser, url) {
  const context = await browser.newContext({
    userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:     'it-IT',
    viewport:   { width: 1280, height: 900 },
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Moto.it renderizza progressivamente: DOM iniziale a volte 4/13 card, le
    // restanti compaiono 1-2s dopo. Aspettiamo che il count si stabilizzi
    // (2 snapshot consecutivi uguali a distanza di 300ms, max 4.5s totali).
    await sleep(400);
    let prev = -1;
    for (let i = 0; i < 15; i++) {
      const count = await page.$$eval('.mcard--big', els => els.length).catch(() => 0);
      if (count > 0 && count === prev) break;
      prev = count;
      await sleep(300);
    }

    const cards = await extractCards(page);
    return mapCards(cards);
  } finally {
    await context.close();
  }
}

// ─── Rate limiting: minimo 1.5s tra ricerche ─────────────────────────────────
let lastSearchAt = 0;
async function throttle() {
  const wait = 1500 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

// ─── Scraper principale ──────────────────────────────────────────────────────
async function scrapeMotoIt(params) {
  // Solo moto (già garantito dal server, ma difesa in profondità)
  if (params.tipo !== 'moto') return [];
  // Senza motoitBrandSlug il brand non è su Moto.it: bail out (no fallback fallaci).
  if (!params.motoitBrandSlug) {
    console.log(`[Moto.it-PW] Skip: nessun motoitBrandSlug per marca "${params.marca}".`);
    return [];
  }

  await throttle();

  const urls = Array.from({ length: MAX_PAGES }, (_, i) => buildUrl(params, i + 1));
  const dedup = pages => {
    const visti = new Set();
    return pages.flat().filter(r => { if (visti.has(r.url)) return false; visti.add(r.url); return true; });
  };

  // §17.1 — path HTTPS primario (cheerio, no browser, pagine in parallelo).
  if (USE_HTTP_SCRAPE) {
    try {
      const { pages, blocked } = await scrapeMotoViaHttp(urls);
      if (!blocked) {
        const risultati = dedup(pages);
        console.log(`[Moto.it-HTTP] OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})`);
        return risultati;
      }
      console.warn('[Moto.it-HTTP] sospetto blocco/pagina-1 vuota → fallback browser');
    } catch (e) {
      console.warn(`[Moto.it-HTTP] errore (${e.message}) → fallback browser`);
    }
  }

  const browser = await getBrowser();
  console.log(`[Moto.it-PW] Pagina 1 (browser): ${urls[0]}`);
  const pages = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    try {
      const items = await fetchPage(browser, urls[p - 1]);
      pages.push(items);
      if (items.length === 0) break; // Fine risultati
      if (p < MAX_PAGES) await sleep(700 + Math.random() * 500);
    } catch (err) {
      console.warn(`[Moto.it-PW] Errore pagina ${p}: ${err.message}`);
      break;
    }
  }

  const risultati = dedup(pages);
  console.log(`[Moto.it-PW] Totale: ${risultati.length} annunci (${pages.map(p => p.length).join('+')})`);
  return risultati;
}

// Esposto per pre-warm al boot del server.
scrapeMotoIt.warmup = async () => { await getBrowser(); };

module.exports = scrapeMotoIt;
