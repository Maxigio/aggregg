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
const { toInt, resolveChromiumExecutable } = require('./utils');

const BASE = 'https://www.moto.it';
const MAX_PAGES = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Path Chromium cross-platform (dev vs bundle Electron) ───────────────────
const PW_BROWSERS = process.resourcesPath && require('fs').existsSync(path.join(process.resourcesPath, 'pw-browsers'))
  ? path.join(process.resourcesPath, 'pw-browsers')
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
  const { prezzoMin, prezzoMax, annoMin, annoMax, kmMax, regione, motoitBrandSlug, motoitModelSlug } = params;

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
  const browser = await getBrowser();

  console.log(`[Moto.it-PW] Pagina 1: ${buildUrl(params, 1)}`);

  const pages = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = buildUrl(params, p);
    try {
      const items = await fetchPage(browser, url);
      pages.push(items);
      if (items.length === 0) break; // Fine risultati
      if (p < MAX_PAGES) await sleep(700 + Math.random() * 500);
    } catch (err) {
      console.warn(`[Moto.it-PW] Errore pagina ${p}: ${err.message}`);
      break;
    }
  }

  // Dedup per URL
  const visti = new Set();
  const risultati = pages.flat().filter(r => {
    if (visti.has(r.url)) return false;
    visti.add(r.url);
    return true;
  });

  const conteggi = pages.map(p => p.length).join('+');
  console.log(`[Moto.it-PW] Totale: ${risultati.length} annunci (${conteggi})`);
  return risultati;
}

// Esposto per pre-warm al boot del server.
scrapeMotoIt.warmup = async () => { await getBrowser(); };

module.exports = scrapeMotoIt;
