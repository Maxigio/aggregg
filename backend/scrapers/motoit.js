/**
 * Scraper Moto.it via HTTP diretto (cheerio, niente browser).
 *
 * Architettura:
 * - Usa il motore di ricerca vero /moto-usate/ricerca (non la landing SEO /moto-usate/{marca})
 * - Filtri server-side supportati: brand, model, price_f/t, km_f/t, year_f/t, sort
 * - Paginazione via /moto-usate/ricerca/pagina-N
 * - 13 annunci/pagina × 4 pagine = ~52 annunci per ricerca (on-search)
 * - Ordinamento price-a (prezzo crescente) allineato all'obiettivo utente
 *
 * F33: rimosso il fallback browser Playwright (era la causa della lentezza: HTTP
 * throttle → browser → goto timeout 20s × pagine = hang fino a 45s). Ora SOLO HTTP:
 * se Moto.it blocca/throttla, ritorna parziale/vuoto SUBITO (stato fonte onesto),
 * Subito/AS24 portano la ricerca. Il crawler era già solo-HTTP (deep → throw).
 *
 * Strategia slug (SOLO slug espliciti dal catalogo, niente fallback fallaci):
 *   - Brand slug: motoitBrandSlug (da brandEntry.motoit.brandSlug del catalogo)
 *   - Model slug: motoitModelSlug (da modelEntry.slugMotoIt del catalogo)
 *   Se motoitBrandSlug manca → bail out con [] (il brand non è su Moto.it).
 */

const https        = require('https');
const cheerio      = require('cheerio');
const { toInt }    = require('./utils');

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
const MAX_PAGES = 4;        // on-search: ~52 annunci (13/pag). Meno pagine = meno richieste parallele = Moto.it throttla meno = veloce.
const HTTP_TIMEOUT_DEFAULT = 15000;   // crawler (sequenziale, paziente). On-search passa 7s (vedi opts.httpTimeoutMs).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// Estrae le card da HTML STATICO via cheerio. Le pagine /moto-usate/ricerca
// rendono le `.mcard--big` server-side (verificato) → niente browser necessario.
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

// Tutte le pagine via HTTPS. `blocked` = pagina-1 sospetta (status≠200 o 0 card).
// On-search: il chiamante ritorna parziale/vuoto (niente browser, F33). Crawler
// (deep): throw alla salute. `opts.httpTimeoutMs` per-chiamata (on-search 7s / crawler 15s).
async function scrapeMotoViaHttp(urls, opts = {}) {
  const delay = opts.pageDelayMs || 0;
  const tmo = opts.httpTimeoutMs || HTTP_TIMEOUT_DEFAULT;
  // PARALLELO (on-search, pageDelayMs=0).
  if (!delay) {
    const res = await Promise.all(urls.map(async (u, i) => {
      try {
        const { status, body } = await httpGetText(u, 0, tmo);
        if (status !== 200) return { items: [], ok: false };
        const items = mapCards(extractCardsHtml(body), opts);
        return { items, ok: i === 0 ? items.length > 0 : true };
      } catch (_) { return { items: [], ok: false }; }
    }));
    return { pages: res.map(r => r.items), blocked: !res[0].ok, truncated: false };
  }
  // SEQUENZIALE (crawler deep, anti-ban): pagina per pagina con delay, errori taggati.
  const pages = [];
  let truncated = false;
  for (let i = 0; i < urls.length; i++) {
    if (i > 0) await sleep(delay);
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

  // deep = chiamata dal crawler (opts) → cap pagine proprio + timeout paziente (15s) + throw alla salute.
  // On-search (!deep) → timeout corto (7s) + degrado onesto (parziale/vuoto, mai browser).
  const deep = !!(opts.pageDelayMs || opts.withMeta || opts.maxPages);
  const maxPages = opts.maxPages || MAX_PAGES;
  const httpTimeoutMs = deep ? HTTP_TIMEOUT_DEFAULT : 7000;
  const urls = Array.from({ length: maxPages }, (_, i) => buildUrl(params, i + 1));
  const dedup = pages => {
    const visti = new Set();
    return pages.flat().filter(r => { if (visti.has(r.url)) return false; visti.add(r.url); return true; });
  };

  // F33: SOLO HTTP (cheerio). Niente browser → niente hang. Se Moto.it blocca/throttla:
  // crawler (deep) → throw taggato alla salute; on-search → ritorna i risultati HTTP
  // ottenuti (parziali/vuoti) SUBITO, Subito/AS24 portano la ricerca.
  try {
    const { pages, blocked, truncated } = await scrapeMotoViaHttp(urls, { ...opts, httpTimeoutMs });
    if (blocked && deep) throw fail('Moto.it-HTTP: sospetto blocco (pagina-1 vuota)', { kind: 'blocked' });
    const risultati = dedup(pages);
    console.log(`[Moto.it-HTTP] ${blocked ? 'blocco/parziale' : 'OK'} ${risultati.length} annunci (${pages.map(p => p.length).join('+')})${truncated ? ' [troncato]' : ''}`);
    return opts.withMeta ? { items: risultati, truncated } : risultati;
  } catch (e) {
    if (deep) throw e;   // crawler: propaga taggato alla salute
    console.warn(`[Moto.it-HTTP] errore on-search (${e.message}) → 0 annunci`);
    return opts.withMeta ? { items: [], truncated: false } : [];
  }
}

module.exports = scrapeMotoIt;
