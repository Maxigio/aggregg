/**
 * Scraper Subito.it con Playwright + storageState persistente.
 *
 * Subito è protetto da DataDome (anti-bot). Per superarlo serve un cookie
 * `datadome` valido — che si ottiene risolvendo manualmente il CAPTCHA una
 * volta tramite il bootstrap interattivo (vedi subito-bootstrap.js).
 * Lo scraper:
 *   - Usa playwright-extra + stealth plugin (anti-fingerprint).
 *   - Carica storageState (cookie + localStorage) dal file salvato dal bootstrap.
 *   - Riconosce la CAPTCHA challenge di DataDome e segnala "blocked"
 *     (l'API server propaga `subitoStatus: 'needs_bootstrap'` al frontend).
 *   - Salva il storageState dopo ogni ricerca andata a buon fine, per
 *     mantenere il cookie aggiornato (DataDome a volte refresha la session).
 *
 * Funzionalità invariate dal pre-refactor:
 *   - Costruzione URL con `?q=marca+modello` (auto + moto).
 *   - Fino a 5 pagine sequenziali (~150 risultati) con early-stop.
 *   - Browser singleton riusato per la sessione.
 */

const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright-extra');
const stealth     = require('puppeteer-extra-plugin-stealth')();
const { toInt, resolveChromiumExecutable } = require('./utils');
const session = require('./subito-session');
const filtersSchema = require('./filters-schema');

chromium.use(stealth);

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
  for (const [limit, key] of KM_MAX_TABLE) {
    if (limit >= kmMax) return key;
  }
  return 36; // oltre 499.999 km
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Path Chromium cross-platform (dev vs bundle Electron) ───────────────────
const _respath = process.env.RESOURCES_PATH || process.resourcesPath;
const PW_BROWSERS = _respath && fs.existsSync(path.join(_respath, 'pw-browsers'))
  ? path.join(_respath, 'pw-browsers')
  : path.join(__dirname, '../../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

// ─── Browser singleton (aperto una volta, riusato per tutte le ricerche) ─────
let browserInstance = null;

async function getBrowser() {
  if (browserInstance) {
    try { browserInstance.contexts(); return browserInstance; } catch (_) {}
  }
  console.log('[Subito-PW] Avvio Chrome headless (stealth)…');
  browserInstance = await chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  browserInstance.on('disconnected', () => { browserInstance = null; });
  return browserInstance;
}

// ─── Errore speciale: CAPTCHA / 403 → richiede bootstrap ─────────────────────
class SubitoBlockedError extends Error {
  constructor(reason) {
    super('SUBITO_BLOCKED:' + reason);
    this.name = 'SubitoBlockedError';
    this.reason = reason; // 'captcha' | '403' | 'no_data'
  }
}

// ─── Costruzione URL ──────────────────────────────────────────────────────────
function buildUrl(params, page = 1) {
  const { tipo, marca, modello, regione: regioneParam,
          prezzoMin, prezzoMax, annoMin, annoMax, kmMax,
          filtersSubito } = params;
  const regione  = regioneParam || 'italia';
  const segmento = tipo === 'auto' ? 'auto' : 'moto-e-scooter';
  const baseUrl  = `https://www.subito.it/annunci-${regione}/vendita/${segmento}/`;

  const qs = new URLSearchParams();
  qs.set('q', modello ? `${marca} ${modello}` : marca);
  qs.set('order', 'priceasc');
  if (page > 1) qs.set('o', String(page));

  // Filtri base universali
  if (prezzoMin != null) qs.set('ps', prezzoMin);
  if (prezzoMax != null) qs.set('pe', prezzoMax);
  if (annoMin   != null) qs.set('ys', annoMin);
  if (annoMax   != null) qs.set('ye', annoMax);
  if (kmMax     != null) qs.set('me', kmMaxToKey(kmMax));

  // Filtri specifici Subito (P10) — definiti in filters-schema.js
  // Es: { carburante: '2', cambio: '1', tipoAnnuncio: 'p' } → &fu=2&gb=1&a=p
  if (filtersSubito && Object.keys(filtersSubito).length > 0) {
    const subitoSchema = filtersSchema.SUBITO_FILTERS.filter(f => f.appliesTo.includes(tipo));
    // Caso speciale per kmMin: filtersSubito.kmMin è un numero raw, da convertire in categoria
    const blob = { ...filtersSubito };
    if (blob.kmMin != null && blob.kmMin !== '') {
      const kmMinNum = parseInt(blob.kmMin, 10);
      if (!isNaN(kmMinNum)) blob.kmMin = kmMaxToKey(kmMinNum);
    }
    filtersSchema.applySiteFilters(qs, blob, subitoSchema);
  }

  return `${baseUrl}?${qs.toString()}`;
}

// ─── Parsing annuncio dal JSON __NEXT_DATA__ ──────────────────────────────────
// Nelle pagine `?q=` di Subito l'AdItem è direttamente l'entry (no wrapping
// `.item` come nelle vecchie pagine path-based).
function parseItem(entry) {
  if (!entry || entry.kind !== 'AdItem') return null;

  const f   = entry.features || {};
  const url = entry.urls?.default;
  if (!url || !/^https?:\/\//i.test(url)) return null;

  // Subito usa "9999999" come placeholder per "km non specificati"
  const kmRaw = toInt(f['/mileage_scalar']?.values?.[0]?.key);
  const km    = kmRaw === 9999999 ? null : kmRaw;

  return {
    fonte:      'subito',
    titolo:     entry.subject || 'Annuncio senza titolo',
    prezzo:     toInt(f['/price']?.values?.[0]?.key),
    km,
    anno:       toInt(f['/year']?.values?.[0]?.key),
    carburante: f['/fuel']?.values?.[0]?.value || null,
    provincia:  entry.geo?.city?.shortName || null,
    url,
  };
}

// ─── Detection challenge DataDome ────────────────────────────────────────────
// La pagina valida è ~600 KB e contiene `__NEXT_DATA__`. La challenge DataDome è
// ~1 KB e contiene un iframe verso `geo.captcha-delivery.com` con payload
// {host:'geo.captcha-delivery.com'} inline.
//
// NOTA: non possiamo usare la sola presenza della stringa "datadome" o "captcha"
// nel HTML — DataDome inietta script di tracking anche nelle pagine valide.
// I marker affidabili sono:
//   - status 403
//   - HTML molto piccolo (< 4 KB) + iframe verso geo.captcha-delivery.com
function detectDataDomeChallenge(html, status) {
  if (status === 403) return '403';
  if (!html) return null;
  // Challenge page ha SEMPRE l'iframe verso geo.captcha-delivery.com.
  // Su pagina valida quel host non compare (la pagina ha solo lo script datadome
  // js base, NON l'iframe della challenge).
  if (html.length < 4000 && /geo\.captcha-delivery\.com/i.test(html)) return 'captcha';
  return null;
}

// ─── Fetch singola pagina ─────────────────────────────────────────────────────
async function fetchPage(context, url) {
  const page = await context.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = resp?.status();

    // Detect blocco DataDome prima di provare a estrarre __NEXT_DATA__
    const html = await page.content();
    const blocked = detectDataDomeChallenge(html, status);
    if (blocked) {
      throw new SubitoBlockedError(blocked);
    }

    const nextDataJson = await page.$eval('#__NEXT_DATA__', el => el.textContent).catch(() => null);
    if (!nextDataJson) {
      // No __NEXT_DATA__ ma neanche CAPTCHA esplicito → trattalo come blocco soft.
      // Spesso DataDome serve una variante senza marker espliciti in pagina.
      console.warn('[Subito-PW] __NEXT_DATA__ assente su:', url);
      throw new SubitoBlockedError('no_data');
    }

    const nextData = JSON.parse(nextDataJson);
    const items    = nextData?.props?.pageProps?.initialState?.items;
    // Per le pagine `?q=` il payload split annunci in:
    //   - originalList:  risultati standard della ricerca testuale (~30 per pagina)
    //   - galleryList:   annunci promoted in cima alla pagina, comunque pertinenti
    //                    alla query (verificato: contengono lo stesso match testuale).
    // Uniamo entrambi; il dedup downstream sull'URL gestisce eventuali doppioni.
    const merged = [
      ...(Array.isArray(items?.galleryList)  ? items.galleryList  : []),
      ...(Array.isArray(items?.originalList) ? items.originalList : []),
    ];
    if (merged.length === 0) return [];
    return merged.map(parseItem).filter(Boolean);
  } finally {
    await page.close();
  }
}

// ─── Rate limiting: minimo 2s tra ricerche ───────────────────────────────────
let lastSearchAt = 0;
async function throttle() {
  const wait = 2000 - (Date.now() - lastSearchAt);
  if (wait > 0) await sleep(wait);
  lastSearchAt = Date.now();
}

const MAX_PAGES = 3;   // §17.2: 5→3 (ordine prezzo → i più economici restano in cima; taglia il tempo Subito)

// ─── Scraper principale ───────────────────────────────────────────────────────
async function scrapeSubito(params) {
  // Se sappiamo già che siamo bloccati e il flag non è stato cleared via bootstrap,
  // saltiamo subito senza consumare richieste (che incrementerebbero il fingerprint).
  if (session.isSubitoBlocked()) {
    throw new SubitoBlockedError('cached_block');
  }

  await throttle();
  const browser = await getBrowser();

  // Carica storageState esistente se disponibile — il cookie DataDome è qui.
  const storageState = session.loadStorageState();
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'it-IT',
    viewport:  { width: 1280, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' },
  };
  if (storageState) ctxOpts.storageState = storageState;

  const context = await browser.newContext(ctxOpts);
  console.log(`[Subito-PW] Pagina 1 (storageState=${storageState ? 'YES' : 'NO'}): ${buildUrl(params, 1)}`);

  try {
    const pages = [];
    for (let p = 1; p <= MAX_PAGES; p++) {
      const url = buildUrl(params, p);
      const items = await fetchPage(context, url);
      pages.push(items);
      if (items.length === 0) break;
      if (p < MAX_PAGES) await sleep(800 + Math.random() * 600);
    }

    const visti = new Set();
    const risultati = pages.flat().filter(r => {
      if (visti.has(r.url)) return false;
      visti.add(r.url);
      return true;
    });

    // Salva storageState aggiornato (DataDome a volte rinfresca il cookie)
    try {
      const fresh = await context.storageState();
      session.saveStorageState(fresh);
    } catch (_) { /* non-fatal */ }

    const conteggi = pages.map(p => p.length).join('+');
    console.log(`[Subito-PW] Totale: ${risultati.length} annunci (${conteggi})`);
    return risultati;
  } catch (err) {
    if (err instanceof SubitoBlockedError) {
      console.warn('[Subito-PW] Bloccato (' + err.reason + ') — serve bootstrap utente');
      session.markSubitoBlocked();
    }
    throw err;
  } finally {
    await context.close();
  }
}

// Esposto per pre-warm al boot del server.
scrapeSubito.warmup = async () => { await getBrowser(); };

/**
 * Keep-alive: visita una pagina light di Subito usando lo storageState corrente.
 * - Se la richiesta passa (200 + __NEXT_DATA__) → DataDome ha rinfrescato il cookie,
 *   salviamo lo storageState aggiornato → la sessione resta viva senza intervento utente.
 * - Se la richiesta è bloccata (403/CAPTCHA) → segniamo blocked, l'UI lo mostrerà.
 *
 * Strategia: usata da setInterval in server.js per estendere indefinitamente
 * la sessione finché l'utente tiene aperta l'app. Riduce il bootstrap manuale
 * a "una volta ogni X giorni quando l'app è chiusa abbastanza a lungo".
 *
 * Ritorna { ok: bool, reason?: string }.
 */
async function keepAliveSubito() {
  const storageState = session.loadStorageState();
  if (!storageState) {
    return { ok: false, reason: 'no_session' };
  }

  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      storageState,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale:    'it-IT',
      viewport:  { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7' },
    });
    const page = await context.newPage();

    // Una pagina lista light (poche risorse) — Subito serve __NEXT_DATA__ ovunque.
    const url = 'https://www.subito.it/annunci-italia/vendita/auto/?q=auto&order=priceasc';
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = resp?.status();
    const html = await page.content();
    const blocked = detectDataDomeChallenge(html, status);

    if (blocked) {
      session.markSubitoBlocked();
      session.recordRefresh(false);
      console.warn('[Subito-PW] Keep-alive bloccato (' + blocked + ')');
      return { ok: false, reason: blocked };
    }

    const hasNextData = await page.$eval('#__NEXT_DATA__', el => !!el).catch(() => false);
    if (!hasNextData) {
      session.recordRefresh(false);
      return { ok: false, reason: 'no_data' };
    }

    // Cookie probabilmente rinfrescato — salva storageState aggiornato
    const fresh = await context.storageState();
    session.saveStorageState(fresh);
    session.clearSubitoBlocked();
    session.recordRefresh(true);
    return { ok: true };
  } catch (err) {
    session.recordRefresh(false);
    return { ok: false, reason: err.message };
  } finally {
    if (context) { try { await context.close(); } catch (_) {} }
  }
}

module.exports = scrapeSubito;
module.exports.buildUrl = buildUrl;
module.exports.SubitoBlockedError = SubitoBlockedError;
module.exports.keepAliveSubito    = keepAliveSubito;
