/**
 * Scraper Moto.it — HTTP puro (cheerio), UNA sola via per on-search e crawler.
 *
 * F41: on-search NON usa più il browser (Playwright). Il crawler prova da sempre
 * che l'HTTP sequenziale + cheerio sulla STESSA `buildUrl` funziona (ha popolato
 * 6891 annunci) e che `/moto-usate/ricerca?...&sort=price-a` ritorna i risultati
 * ordinati dal più economico. Il path browser (F35) divergeva → ricerca infedele.
 * → on-search = HTTP **sequenziale gentile** (mai parallelo: il parallelo a raffica
 *   era l'unica cosa che soft-bloccava). Zero fallback: su blocco → fonte vuota,
 *   Subito/AS24 portano la ricerca.
 *
 * Architettura ricerca (entrambi i consumatori):
 * - Motore /moto-usate/ricerca (non la landing SEO), filtri server-side
 *   brand/model/price_f-t/km_f-t/year_f-t/region, paginazione /pagina-N, sort=price-a.
 * - ~10-13 annunci/pagina × 3 pagine = ~30 annunci on-search.
 *
 * Slug: SOLO slug espliciti dal catalogo (`motoitBrandSlug`/`motoitModelSlug`).
 *   Senza `motoitBrandSlug` → bail out []. Modello non risolto → brand-only +
 *   post-filter titolo lato server.
 */

const https        = require('https');
const cheerio      = require('cheerio');

const { kindForStatus, fail } = require('./utils');   // salute crawler (come AS24/Subito)
const budget = require('../budget-richieste');        // conta le richieste, non le limita
const { slugDaUrl } = require('./motoit-versione');    // lo slug-versione che l'annuncio dichiara nell'URL

const BASE = 'https://www.moto.it';
const MAX_PAGES = 3;                  // on-search: ~30 annunci (~10-13/pag), cheapest-first.
const HTTP_TIMEOUT_DEFAULT = 15000;   // crawler (sequenziale, paziente).
const ONSEARCH_DELAY_MS    = 1000;    // on-search: gentile tra pagine (sequenziale, mai parallelo).
const ONSEARCH_TIMEOUT_MS  = 12000;   // on-search: non troppo stretto (8s troncava su risposte lente).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpGetText(url, hops = 0, timeoutMs = HTTP_TIMEOUT_DEFAULT) {
  // Anche un redirect e' una richiesta: si conta ogni salto, non solo il primo.
  budget.conta('motoit', hops ? 'redirect' : null);
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
          motoitBrandSlug, motoitModelSlug, motoitBikeCode } = params;

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

  // Versione (allestimento): codice opaco dall'API `bikes` → param `bike=`
  // (es. "9UMy8q" = Harley 883 Iron). VERIFICATO onorato server-side nell'HTML.
  if (motoitBikeCode) {
    qs.set('bike', motoitBikeCode);
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

  // Ordinamento: prezzo crescente (obiettivo "i più economici"). VERIFICATO reale
  // (WebFetch F41: i risultati tornano €99,€99,€150,… in ordine crescente).
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

// Mapping card-grezza → risultato.
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

// ─── Estrazione card da HTML (cheerio) ───────────────────────────────────────
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

// F50 — totale per-query = "N annunci" nella pagina (es. "4.323 annunci"; il punto è
// separatore migliaia). = quanti annunci Moto.it HA per la query (tetto copertura).
// ANCORATO allo span del titolo-lista `plist-head-title-info`: un "N annunci" di
// marketing/nav altrove nella pagina darebbe un tetto SBAGLIATO — meglio null (miss)
// che un numero errato. `&nbsp;` ammesso (markup IT server-rendered). Best-effort.
function extractTotal(html) {
  if (!html) return null;
  const m = String(html).match(/plist-head-title-info[^>]*>\s*([\d][\d.]*)(?:&nbsp;|\s)*annunci/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/\./g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// Dedup per-url su pagine concatenate.
function dedup(pages) {
  const visti = new Set();
  return pages.flat().filter(r => { if (visti.has(r.url)) return false; visti.add(r.url); return true; });
}

/**
 * IL FILTRO VERSIONE QUANDO `bike=` NON BASTA.
 *
 * Moto.it spezza la stessa moto per periodo — "MT-07 (2014-16)", "(2017-18)", "(2018-20)",
 * "(2021-24)" sono quattro voci di catalogo. Il parametro `bike=` ne accetta UNA sola
 * (verificato: la virgola prende la prima e ignora il resto, il pipe risponde vuoto),
 * quindi quando il testo scritto ne aggancia piu' d'una non si puo' chiedere alla fonte.
 *
 * Ma non serve: ogni annuncio dichiara la propria versione nello slug dell'URL — verificato
 * su Honda SH 125, 13 annunci e 6 slug distinti. Si filtra qui, esatto e senza richieste.
 */
function filtraPerSlug(items, ammessi) {
  if (!ammessi || !ammessi.size) return items;
  return items.filter(r => { const s = slugDaUrl(r.url); return s && ammessi.has(s); });
}

// ─── Fetch HTTPS sequenziale (cheerio) — on-search e crawler ─────────────────
// SEQUENZIALE con delay anti-ban (mai parallelo: il burst a raffica è l'unica cosa
// che soft-blocca). On block (403/429) → throw taggato alla salute. `opts.httpTimeoutMs`
// per-chiamata, `opts.pageDelayMs` tra pagine.
async function scrapeMotoViaHttp(urls, opts = {}) {
  const delay = opts.pageDelayMs || 0;
  const tmo = opts.httpTimeoutMs || HTTP_TIMEOUT_DEFAULT;
  const pages = [];
  let truncated = false;
  let total = null;                          // F50 "N annunci" (tetto), dalla 1ª pagina
  for (let i = 0; i < urls.length; i++) {
    if (i > 0 && delay) await sleep(delay);
    const { status, body } = await httpGetText(urls[i], 0, tmo);
    if (status === 403 || status === 429) throw fail(`Moto.it HTTP ${status}`, { status, kind: 'blocked' });
    if (status !== 200) {
      // Un 500 o un 503 NON sono un blocco: 403 e 429 sono gia' presi sopra. Dichiarandoli
      // "blocked" il registro salute non arrivava mai a classificarli come guasti
      // passeggeri, e una manutenzione momentanea di Moto.it faceva saltare la fonte per
      // sei ore su tutti i target. Qui si porta fuori lo stato e chi chiama decide.
      if (i === 0) return { pages: [], statoKo: status, truncated: false };
      break;                                                               // pagina dopo non-200 = fine
    }
    if (i === 0) total = extractTotal(body);             // tetto dalla 1ª pagina (anche se 0 card)
    const items = mapCards(extractCardsHtml(body), opts);
    if (items.length === 0) break;                       // esaurito (fine risultati genuina)
    pages.push(items);
  }
  // review: prima truncated=true su QUALSIASI ultima pagina non vuota (Moto.it non ha un
  // PAGE_SIZE fisso: ~10-13/pag → niente check raw<PAGE_SIZE come Subito/AS24) → un target
  // esaurito ESATTAMENTE al cap restava "troncato" per sempre (escalation cap + markGone mai +
  // 'in fill' perenne). Ora: troncato solo se abbiamo usato TUTTE le pagine richieste E il sito
  // dichiara più annunci di quanti ne abbiamo presi. Se il tetto è ignoto → conservativo (assume
  // altro, così non si marca falsamente 'venduto'). got>=total = provato completo → markGone sicuro.
  if (pages.length === urls.length) {
    const got = pages.reduce((n, p) => n + p.length, 0);
    if (total == null || got < total) truncated = true;
  }
  return { pages, blocked: false, truncated, total };
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

  // deep = chiamata dal crawler (opts) → HTTP paziente, throw alla salute su blocco.
  const deep = !!(opts.pageDelayMs || opts.withMeta || opts.maxPages);
  const maxPages = deep ? (opts.maxPages || MAX_PAGES) : MAX_PAGES;
  // "Carica altri": la fetta successiva. Provato pagina 1 contro pagina 50 — nessun
  // link in comune, quindi le pagine profonde portano moto diverse e non le stesse.
  const salta = Math.max(0, opts.fetta || 0) * maxPages;
  const urls = Array.from({ length: maxPages }, (_, i) => buildUrl(params, salta + i + 1));

  if (deep) {
    const { pages, statoKo, truncated, total } = await scrapeMotoViaHttp(urls, { ...opts, httpTimeoutMs: HTTP_TIMEOUT_DEFAULT });
    // L'etichetta la calcola `kindForStatus`: 5xx = passeggero, non blocco. E il messaggio
    // non dice piu' "pagina-1 vuota", che era un residuo di codice tolto tempo fa e mandava
    // a cercare un problema anti-bot inesistente.
    if (statoKo) throw fail(`Moto.it-HTTP ${statoKo}`, { status: statoKo, kind: kindForStatus(statoKo) });
    const risultati = filtraPerSlug(dedup(pages), params.motoitSlugAmmessi);
    console.log(`[Moto.it-HTTP] OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})${truncated ? ' [troncato]' : ''}`);
    return opts.withMeta ? { items: risultati, truncated, total } : risultati;
  }

  // ON-SEARCH: HTTP sequenziale gentile (come il crawler). Niente browser, niente
  // fallback. Su blocco → fonte vuota (Subito/AS24 portano la ricerca), NON crash.
  const { pages, statoKo, truncated } = await scrapeMotoViaHttp(urls, {
    pageDelayMs: ONSEARCH_DELAY_MS, httpTimeoutMs: ONSEARCH_TIMEOUT_MS,
  });
  if (statoKo) {
    console.warn(`[Moto.it] on-search: HTTP ${statoKo} sulla prima pagina → fonte vuota`);
    return [];
  }
  const risultati = filtraPerSlug(dedup(pages), params.motoitSlugAmmessi);
  console.log(`[Moto.it] on-search OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})${truncated ? ' [troncato]' : ''}`);
  return risultati;
}

module.exports = scrapeMotoIt;
module.exports._mapCards = mapCards;   // backfill F50: re-map della card grezza in raw_json
module.exports._extractTotal = extractTotal;   // F50 copertura
// La vetrina del concessionario (Competitor) parla con lo stesso host e deve contare le
// richieste nello stesso budget: una sola porta HTTP verso Moto.it, non due.
module.exports._get = httpGetText;
