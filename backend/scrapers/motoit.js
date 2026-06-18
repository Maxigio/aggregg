/**
 * Scraper Moto.it.
 *
 * Due path, DUE consumatori distinti:
 *  - ON-SEARCH (app, default) → **Playwright (browser reale)**. Moto.it soft-blocca
 *    l'HTTP a raffica (4 richieste parallele → serve pagine vuote: `0+0+0+13`), ma
 *    NON il browser (sessione/JS/cookie reali) → ricerca FEDELE. Zero fallback: se
 *    il browser fallisce → la fonte ritorna errore onesto (Subito/AS24 portano).
 *  - CRAWLER (deep, background) → **HTTP sequenziale-gentile** (cheerio, niente
 *    browser): paziente, con delay anti-ban; su blocco → throw taggato alla salute.
 *    Ha già popolato il DB (6891 annunci) → resta così.
 *
 * Architettura ricerca (entrambi i path):
 * - Motore /moto-usate/ricerca (non la landing SEO), filtri server-side
 *   brand/model/price_f-t/km_f-t/year_f-t/region, paginazione /pagina-N, sort=price-a.
 * - 13 annunci/pagina × 3 pagine = ~39 annunci on-search.
 *
 * Slug: SOLO slug espliciti dal catalogo (`motoitBrandSlug`/`motoitModelSlug`).
 *   Senza `motoitBrandSlug` → bail out []. Modello non risolto → brand-only +
 *   post-filter titolo lato server.
 */

const path         = require('path');
const https        = require('https');
const cheerio      = require('cheerio');
const { toInt, resolveChromiumExecutable } = require('./utils');

// Errore taggato per la salute crawler (come AS24/Subito).
function kindForStatus(s) {
  if (s === 401) return 'auth';
  if (s === 403 || s === 429) return 'blocked';
  if (s >= 500) return 'transient';
  return 'error';
}
function fail(msg, { status = null, kind = 'error' } = {}) {
  const e = new Error(msg); e.status = status; e.kind = kind; return e;
}

const BASE = 'https://www.moto.it';
const MAX_PAGES = 3;        // on-search: ~39 annunci (13/pag), com'era prima.
const HTTP_TIMEOUT_DEFAULT = 15000;   // crawler (sequenziale, paziente).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
  const { chromium } = require('playwright');   // lazy: solo il path browser tira playwright
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

function httpGetText(url, hops = 0, timeoutMs = HTTP_TIMEOUT_DEFAULT) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return httpGetText(next, hops + 1, timeoutMs).then(resolve, reject);
      }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// ─── Costruzione URL ─────────────────────────────────────────────────────────
// Moto.it offre un motore di ricerca completo a /moto-usate/ricerca con query params.
// Paginazione via /pagina-N nel path (NON come query param).
function buildUrl(params, page = 1) {
  const { prezzoMin, prezzoMax, annoMin, annoMax, kmMin, kmMax, regione,
          motoitBrandSlug, motoitModelSlug } = params;

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
  if (kmMin     != null) qs.set('km_f',    String(kmMin));
  if (kmMax     != null) qs.set('km_t',    String(kmMax));
  if (annoMin   != null) qs.set('year_f',  String(annoMin));
  if (annoMax   != null) qs.set('year_t',  String(annoMax));

  // Ordinamento: prezzo crescente (obiettivo "i più economici")
  qs.set('sort', 'price-a');

  return `${BASE}/moto-usate/ricerca${pagePath}?${qs.toString()}`;
}

// ─── Parser prezzo: "€ 4.800" → 4800, "T.RISERVATA" → null ───────────────────
function parsePrezzo(str) {
  if (!str) return null;
  const clean = str.replace(/[€\s.]/g, '').replace(/,\d+$/, '');
  const n = parseInt(clean, 10);
  return isNaN(n) ? null : n;
}

// Cover dalla card di ricerca: le `.mcard--big` mostrano già la copertina come
// `<img src="…/images/<id>/<size>/<file>.jpg">`. Valida che sia un'immagine cdn-img
// (scarta placeholder lazy / src non-cdn), strippa la query, ricostruisce thumb/full.
// → la riga ha una foto SUBITO, senza attendere l'arricchimento /api/detail.
function coverFromImg(src) {
  if (!src) return null;
  const m = String(src).match(/https:\/\/cdn-img\.moto\.it\/images\/\d+\/[^"'\\ )?]+?\.(?:jpe?g|webp)/i);
  if (!m) return null;
  const base = m[0];
  return { thumb: `${base}?format=webp&width=300`, full: `${base}?format=webp&width=1200` };
}

// Mapping card-grezza → risultato (condiviso path browser + HTTPS).
function mapCards(cards, opts = {}) {
  return cards.map(c => {
    if (!c.href) return null;
    const fullUrl = c.href.startsWith('http') ? c.href : `${BASE}${c.href}`;
    const out = {
      fonte:      'moto',
      titolo:     c.titolo || 'Annuncio senza titolo',
      prezzo:     parsePrezzo(c.priceRaw),
      km:         c.km,
      anno:       c.anno,
      carburante: null,
      provincia:  c.provincia,
      venditore:  c.venditore || null,   // label nativa card (privato/concessionario)
      immagini:   coverFromImg(c.cover) ? [coverFromImg(c.cover)] : [],  // cover dalla card → thumb immediata; galleria piena via /api/detail
      url:        fullUrl,
      // campi DB: Moto.it HTML non li espone puliti → null
      nuovo:      null,
      danni:      null,
      posted_at:  null,
    };
    if (opts.attachRaw) out._raw = c;   // card grezza per raw_json
    return out;
  }).filter(Boolean);
}

// ─── Estrazione card dal DOM (browser, on-search) ────────────────────────────
// `page.$$eval` sulle `.mcard--big`. Stessa semantica di `extractCardsHtml`
// (cheerio, crawler) ma sul DOM renderizzato dal browser reale.
async function extractCards(page) {
  return await page.$$eval('.mcard--big', cards => cards.map(c => {
    const text = (c.innerText || '').replace(/\n+/g, ' | ').trim();
    const titleEl = c.querySelector('h2, h3, .mcard-title, [class*="title"]');
    const titolo = titleEl ? (titleEl.innerText || '').replace(/\s+/g, ' ').trim() : null;
    const priceRaw = c.querySelector('[class*="price"], [class*="prezzo"]')?.innerText?.trim() || null;
    const href = c.querySelector('a[href]')?.getAttribute('href') || null;
    // Ultimo anno 4-cifre = anno veicolo (la prima riga è la data pubblicazione).
    const years = [...text.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => m[1]);
    const anno = years.length > 0 ? parseInt(years[years.length - 1], 10) : null;
    const kmMatch = text.match(/([\d.]+)\s*Km/i);
    const km = kmMatch ? parseInt(kmMatch[1].replace(/\./g, ''), 10) : null;
    const provMatch = text.match(/\(([A-Z]{2})\)/);
    const provincia = provMatch ? provMatch[1] : null;
    const venditore = /concessionar/i.test(text) ? 'concessionario' : /privato/i.test(text) ? 'privato' : null;
    const cover = c.querySelector('img[src*="cdn-img.moto.it/images"]')?.getAttribute('src') || null;
    return { titolo, priceRaw, href, anno, km, provincia, venditore, cover };
  }));
}

// ─── Fetch singola pagina nel browser ────────────────────────────────────────
// Moto.it renderizza progressivamente: il DOM iniziale a volte ha 4/13 card, le
// restanti compaiono 1-2s dopo → si attende che il count si stabilizzi.
async function fetchPageBrowser(browser, url) {
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'it-IT',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(400);
    let prev = -1;
    for (let i = 0; i < 15; i++) {   // count stabile (2 snapshot uguali) o max ~4.5s
      const count = await page.$$eval('.mcard--big', els => els.length).catch(() => 0);
      if (count > 0 && count === prev) break;
      prev = count;
      await sleep(300);
    }
    return mapCards(await extractCards(page));
  } finally {
    await context.close();
  }
}

// ─── Estrazione card da HTML STATICO (cheerio, crawler) ──────────────────────
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
    const venditore = /concessionar/i.test(text) ? 'concessionario' : /privato/i.test(text) ? 'privato' : null;
    const cover = c.find('img[src*="cdn-img.moto.it/images"]').first().attr('src') || null;
    out.push({ titolo, priceRaw, href, anno, km, provincia, venditore, cover });
  });
  return out;
}

// ─── Crawler (deep): tutte le pagine via HTTPS, SEQUENZIALI con delay anti-ban ─
// On block (403/429) → throw taggato alla salute. `opts.httpTimeoutMs` per-chiamata.
async function scrapeMotoViaHttp(urls, opts = {}) {
  const delay = opts.pageDelayMs || 0;
  const tmo = opts.httpTimeoutMs || HTTP_TIMEOUT_DEFAULT;
  const pages = [];
  let truncated = false;
  for (let i = 0; i < urls.length; i++) {
    if (i > 0 && delay) await sleep(delay);
    const { status, body } = await httpGetText(urls[i], 0, tmo);
    if (status === 403 || status === 429) throw fail(`Moto.it HTTP ${status}`, { status, kind: 'blocked' });
    if (status !== 200) {
      if (i === 0) return { pages: [], blocked: true, truncated: false };  // pagina-1 sospetta
      break;                                                               // pagina dopo non-200 = fine
    }
    const items = mapCards(extractCardsHtml(body), opts);
    if (items.length === 0) break;                       // esaurito (fine risultati genuina)
    pages.push(items);
    if (i === urls.length - 1) truncated = true;         // ultima pagina ancora piena → forse altro
  }
  return { pages, blocked: false, truncated };
}

// ─── Ricerca on-search nel browser: 3 pagine SEQUENZIALI, zero fallback ──────
// Lo slug-modello arriva già risolto in `params.motoitModelSlug` (catalogo o
// resolver HTTP del server) → ricerca server-side `model=`. Senza → brand-only
// + post-filter titolo lato server.
// SEQUENZIALE di proposito: le navigazioni in parallelo, anche nel browser, fanno
// scattare timeout/soft-block (verificato: page-breakdown `0+13+13` → parziali).
async function scrapeViaBrowser(params, maxPages) {
  const browser = await getBrowser();   // throw → fonte in errore onesto (no fallback)
  const dedup = pages => {
    const visti = new Set();
    return pages.flat().filter(r => { if (visti.has(r.url)) return false; visti.add(r.url); return true; });
  };
  const pages = [];
  for (let p = 1; p <= maxPages; p++) {
    const url = buildUrl(params, p);
    try {
      const items = await fetchPageBrowser(browser, url);
      pages.push(items);
      if (items.length === 0) break;   // fine risultati genuina
    } catch (err) {
      console.warn(`[Moto.it-PW] Errore pagina ${p}: ${err.message}`);
      if (p === 1) throw err;          // pagina-1 KO = fonte in errore onesto
      break;                           // pagina>1 KO = ritorna il parziale già raccolto
    }
    if (p < maxPages) await sleep(500 + Math.random() * 400);
  }
  const risultati = dedup(pages);
  console.log(`[Moto.it-PW] ${risultati.length} annunci (${pages.map(p => p.length).join('+')})`);
  return risultati;
}

// ─── Rate limiting: minimo 1.5s tra ricerche ─────────────────────────────────
let lastSearchAt = 0;
async function throttle() {
  const wait = 1500 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

// ─── Scraper principale ──────────────────────────────────────────────────────
async function scrapeMotoIt(params, opts = {}) {
  // Solo moto (già garantito dal server, ma difesa in profondità)
  if (params.tipo !== 'moto') return opts.withMeta ? { items: [], truncated: false } : [];
  // Senza motoitBrandSlug il brand non è su Moto.it: bail out (no fallback fallaci).
  if (!params.motoitBrandSlug) {
    console.log(`[Moto.it] Skip: nessun motoitBrandSlug per marca "${params.marca}".`);
    return opts.withMeta ? { items: [], truncated: false } : [];
  }

  await throttle();

  // deep = chiamata dal crawler (opts) → HTTP sequenziale paziente, throw alla salute.
  const deep = !!(opts.pageDelayMs || opts.withMeta || opts.maxPages);

  if (deep) {
    const maxPages = opts.maxPages || MAX_PAGES;
    const urls = Array.from({ length: maxPages }, (_, i) => buildUrl(params, i + 1));
    const dedup = pages => {
      const visti = new Set();
      return pages.flat().filter(r => { if (visti.has(r.url)) return false; visti.add(r.url); return true; });
    };
    const { pages, blocked, truncated } = await scrapeMotoViaHttp(urls, { ...opts, httpTimeoutMs: HTTP_TIMEOUT_DEFAULT });
    if (blocked) throw fail('Moto.it-HTTP: sospetto blocco (pagina-1 vuota)', { kind: 'blocked' });
    const risultati = dedup(pages);
    console.log(`[Moto.it-HTTP] OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})${truncated ? ' [troncato]' : ''}`);
    return opts.withMeta ? { items: risultati, truncated } : risultati;
  }

  // ON-SEARCH: SOLO browser. Moto.it non soft-blocca il browser reale → ricerca
  // fedele. Niente fallback: se il browser fallisce, runSource segna la fonte
  // in errore onesto e Subito/AS24 portano la ricerca.
  return scrapeViaBrowser(params, MAX_PAGES);
}

// Esposto per pre-warm opzionale al boot (di default il browser parte lazy alla 1ª ricerca).
scrapeMotoIt.warmup = async () => { await getBrowser(); };

module.exports = scrapeMotoIt;
