/**
 * Scraper Moto.it — HTTP puro (cheerio), UNA sola via per on-search e crawler.
 *
 * F41: on-search NON usa più il browser (Playwright). Il crawler prova da sempre
 * che l'HTTP sequenziale + cheerio sulla STESSA `buildUrl` funziona (ha popolato
 * 6891 annunci) e che `/moto-usate/ricerca?...&sort=price-a` ritorna i risultati
 * ordinati dal più economico. Il path browser (F35) divergeva → ricerca infedele.
 * → on-search = HTTP **sequenziale gentile** (mai parallelo: il parallelo a raffica
 *   era l'unica cosa che soft-bloccava). Zero fallback: su blocco la fonte
 *   dichiara l'errore, mentre Subito/AS24 possono comunque rispondere.
 *
 * Architettura ricerca (entrambi i consumatori):
 * - Motore /moto-usate/ricerca (non la landing SEO), filtri server-side
 *   brand/model/price_f-t/km_f-t/year_f-t/region, paginazione /pagina-N, sort=price-a.
 * - Una pagina nativa per fetta on-search; fino a 3 pagine nel percorso deep.
 *
 * Slug: SOLO slug espliciti dal catalogo (`motoitBrandSlug`/`motoitModelSlug`).
 *   Senza `motoitBrandSlug` → bail out []. Modello non risolto → brand-only +
 *   post-filter titolo lato server.
 */

const cheerio      = require('cheerio');
const salute = require('../fonti-salute');

const { kindForStatus, fail } = require('./utils');   // salute crawler (come AS24/Subito)
const motoHttp = require('./motoit-http');
const { prezzoMoto, avvisoPrezzi } = require('./motoit-prezzo');
const { slugDaUrl, varianteDaSlug } = require('./motoit-versione');  // la versione che l'annuncio dichiara nell'URL

const BASE = 'https://www.moto.it';
const MAX_PAGES = 3;                  // percorso deep; on-search legge una pagina per fetta.
const HTTP_TIMEOUT_DEFAULT = 15000;   // crawler (sequenziale, paziente).
const ONSEARCH_DELAY_MS    = 1000;    // on-search: gentile tra pagine (sequenziale, mai parallelo).
const ONSEARCH_TIMEOUT_MS  = 12000;   // on-search: non troppo stretto (8s troncava su risposte lente).
const sleep = ms => new Promise(r => setTimeout(r, ms));
const httpGetText = (url, _hops = 0, timeoutMs = HTTP_TIMEOUT_DEFAULT) => motoHttp.get(url, { timeoutMs });

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

  // Modello: formato "brandSlug|modelSlug" (es. "ducati|monster-1100"). Gli slug possono
  // essere PIU' D'UNO separati da virgola — Moto.it li tratta in OR, verificato sul sito:
  // scarabeo-50 (29) + scarabeo-125 (4) + scarabeo-500 (8) = 41, esattamente il totale della
  // query con le tre insieme. Serve a chi scrive il nome largo ("Scarabeo") di un modello che
  // su Moto.it e' spezzato per cilindrata: prima se ne sceglieva una sola, a caso.
  if (motoitModelSlug) {
    const slugs = String(motoitModelSlug).split(',').map(s => s.trim()).filter(Boolean);
    if (slugs.length) qs.set('model', slugs.map(s => `${brandSlug}|${s}`).join(','));
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
      ...prezzoMoto(c.priceRaw),
      km:         c.km,
      anno:       c.anno,
      carburante: null,
      provincia:  c.provincia,
      venditore:  c.venditore || null,   // label nativa card (privato/concessionario)
      immagini:   coverFromImg(c.cover) ? [coverFromImg(c.cover)] : [],  // cover dalla card → thumb immediata; galleria piena via /api/detail
      url:        fullUrl,
      /**
       * LA VERSIONE CHE L'ANNUNCIO DICHIARA, letta dal suo URL (vedi motoit-versione.js).
       * La usavamo gia' per FILTRARE e la buttavamo via subito dopo: cosi' ogni riga
       * Moto.it usciva "versione n.d.", cioe' «il venditore non l'ha indicata» — falso,
       * e su moto come la CB 500 e la CB 500 S vuol dire non distinguere due mezzi diversi.
       * Stesso campo che Subito e Autoscout riempiono con la versione nativa.
       */
      variante:   varianteDaSlug(slugDaUrl(fullUrl), opts.modelSlug) || null,
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
  let errorePagina = null;
  let driftBreak = false;                    // pagina illeggibile dopo pagine buone
  let total = null;                          // F50 "N annunci" (tetto), dalla 1ª pagina
  let scartate = 0;                          // card presenti ma non leggibili
  for (let i = 0; i < urls.length; i++) {
    if (i > 0 && delay) await sleep(delay);
    let pagina;
    try {
      // La verifica comprende anche il parser: HTTP 200 da solo non prova che
      // la pagina degli annunci sia tornata leggibile.
      pagina = await salute.richiesta('moto', async () => {
        const { status, body, headers } = await module.exports._get(urls[i], 0, tmo);
        if (status !== 200) throw salute.erroreHttp('moto', status, headers);
        const totale = extractTotal(body);
        const grezze = extractCardsHtml(body);
        const items = mapCards(grezze, opts);
        if (!grezze.length && !cheerio.load(body)('#plist-top, .plist-head-title-info').length) {
          throw Object.assign(fail('Moto.it: pagina di ricerca non riconoscibile, disponibilità non verificata', { kind: 'error' }), { code: 'FONTE_FORMATO' });
        }
        const deriva = !items.length && (grezze.length > 0 || (i === 0 && !(opts.fetta > 0) && totale > 0));
        if (deriva) throw Object.assign(fail(`Moto.it: ${grezze.length} card in pagina, ${totale == null ? '?' : totale} annunci dichiarati, 0 leggibili — e' cambiato il markup della fonte, non il piazzale a essere vuoto`, { kind: 'error' }), { code: 'FONTE_FORMATO' });
        // Il 200 di una manutenzione senza card né contatore non prova la
        // ripartenza. Lo zero esplicito della fonte rimane un esito valido.
        if (salute.fermo('moto').verifica && !items.length && totale == null) {
          throw Object.assign(fail('Moto.it: pagina non riconoscibile, disponibilità non verificata', { kind: 'error' }), { code: 'FONTE_FORMATO' });
        }
        if (items.length) salute.registra('moto', { conteggio: items.length });
        return { items, totale, scartate: grezze.length - items.length };
      });
    } catch (e) {
      if (i === 0) {
        if (opts.sonda) throw e;
        if (e.status && e.status !== 403 && e.status !== 429) return { pages: [], statoKo: e.status, truncated: false, cadute: 0 };
        throw e;
      }
      errorePagina = e; driftBreak = true; break;
    }
    if (i === 0) total = pagina.totale;
    scartate += pagina.scartate;
    const { items } = pagina;
    if (!items.length) break;
    pages.push(items);
  }
  // Un break per deriva a pagina >1 non e' una vista completa: senza `truncated` il
  // crawler, quando tornera' attivo, farebbe markGone su una lista parziale.
  if (driftBreak) truncated = true;
  // Le PAGINE PERSE viaggiano a parte da `truncated`: quel flag lo alza anche il caso
  // ordinario qui sotto (got < total col cap esaurito), che e' normale e cachabile, quindi
  // non puo' reggere un avviso. `cadute` dice solo "abbiamo smesso prima": e' l'unico
  // segnale con cui chi chiama puo' dichiarare l'elenco monco.
  const cadute = driftBreak ? urls.length - pages.length : 0;
  // review: prima truncated=true su QUALSIASI ultima pagina non vuota (Moto.it non ha un
  // PAGE_SIZE fisso: ~10-13/pag → niente check raw<PAGE_SIZE come Subito/AS24) → un target
  // esaurito ESATTAMENTE al cap restava "troncato" per sempre (escalation cap + markGone mai +
  // 'in fill' perenne). Ora: troncato solo se abbiamo usato TUTTE le pagine richieste E il sito
  // dichiara più annunci di quanti ne abbiamo presi. Se il tetto è ignoto → conservativo (assume
  // altro, così non si marca falsamente 'venduto'). got>=total = provato completo → markGone sicuro.
  const got = pages.reduce((n, p) => n + p.length, 0);
  // Moto.it non ha una dimensione di pagina costante: oltre la prima fetta il totale
  // non permette di ricostruire quante card grezze abbiamo gia' attraversato.
  // Una fetta piena resta navigabile; la prima pagina vuota chiudera' la fonte.
  const hasMore = !driftBreak && pages.length === urls.length
    && ((opts.fetta || 0) > 0 || total == null || got < total);
  if (hasMore) truncated = true;
  if (scartate) truncated = true;
  return { pages, blocked: false, truncated, cadute, scartate, total, hasMore, errorePagina };
}

/**
 * TENERE LE PAGINE SUPERSTITI E' GIUSTO, NON DIRLO NO. Con la pagina 2 caduta (un 503 di manutenzione,
 * o card che smettono di mapparsi) l'esito usciva come un 'ok' pieno: `truncated` non
 * sopravvive a `sciogli()` in server.js, che copia campi fissi, quindi `sources.moto.parziale`
 * restava null, la pastiglia era VERDE senza un avviso e `cacheable()` — che il campo
 * `parziale` lo legge apposta — congelava tre minuti la risposta monca, rendendo inutile
 * l'unico gesto di rimedio (ripremere Cerca). E siccome le pagine si chiedono con
 * `sort=price-a`, quel che manca e' sempre la parte piu' cara: la fetta Moto.it entrava nel
 * confronto piu' povera del solito senza che nulla lo dichiarasse.
 */
const avvisoCadute = (cadute, tot) => cadute
  ? `${cadute} pagine su ${tot} non si sono lasciate leggere da Moto.it: l'elenco e' parziale (mancano gli annunci piu' cari)`
  : null;
const avvisoScartate = n => n ? `${n} card di Moto.it presenti ma non leggibili: i risultati potrebbero essere incompleti` : null;

// ─── Scraper principale ──────────────────────────────────────────────────────
async function scrapeMotoIt(params, opts = {}) {
  // Solo moto (già garantito dal server, ma difesa in profondità)
  if (params.tipo !== 'moto') return opts.withMeta ? { items: [], truncated: false } : [];
  // Senza motoitBrandSlug il brand non è su Moto.it: bail out (no fallback fallaci).
  if (!params.motoitBrandSlug) {
    console.log(`[Moto.it] Skip: nessun motoitBrandSlug per marca "${params.marca}".`);
    return opts.withMeta ? { items: [], truncated: false } : [];
  }

  // deep = chiamata dal crawler (opts) → HTTP paziente, throw alla salute su blocco.
  // `withMeta` NON discrimina piu': da quando il server lo passa a OGNI ricerca (per il
  // totale F50), teneva TUTTE le ricerche live sul ramo crawler — delay zero fra pagine e
  // timeout lungo, l'esatto contrario dell'"HTTP sequenziale gentile" promesso qui sotto.
  // I tre chiamanti crawler veri passano tutti maxPages+pageDelayMs.
  const deep = !!(opts.pageDelayMs || opts.maxPages);
  // La fetta visibile corrisponde a UNA pagina nativa, come per Subito e AutoScout.
  // Il giro profondo conserva il proprio tetto, senza cambiare il percorso sospeso.
  const maxPages = deep ? (opts.maxPages || MAX_PAGES) : 1;
  // "Carica altri": la fetta successiva. Provato pagina 1 contro pagina 50 — nessun
  // link in comune, quindi le pagine profonde portano moto diverse e non le stesse.
  const salta = Math.max(0, opts.fetta || 0) * maxPages;
  const urls = Array.from({ length: maxPages }, (_, i) => buildUrl(params, salta + i + 1));

  if (deep) {
    const { pages, statoKo, truncated, cadute, scartate, total, hasMore, errorePagina } = await scrapeMotoViaHttp(urls, {
    ...opts, modelSlug: params.motoitModelSlug, httpTimeoutMs: HTTP_TIMEOUT_DEFAULT });
    // L'etichetta la calcola `kindForStatus`: 5xx = passeggero, non blocco. E il messaggio
    // non dice piu' "pagina-1 vuota", che era un residuo di codice tolto tempo fa e mandava
    // a cercare un problema anti-bot inesistente.
    if (statoKo) throw fail(`Moto.it-HTTP ${statoKo}`, { status: statoKo, kind: kindForStatus(statoKo) });
    const risultati = filtraPerSlug(dedup(pages), params.motoitSlugAmmessi);
    console.log(`[Moto.it-HTTP] OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})${truncated ? ' [troncato]' : ''}`);
    /**
   * IL TOTALE DI CHI? Senza lo slug del modello la ricerca si allarga alla MARCA, e il
   * conteggio in pagina e' quello della marca — ma la pill scriveva "N di M" come se quel
   * M fosse del modello chiesto. Misurato: cercando "CB 500 X Adventure Sports" uscivano
   * "39 di 148", e 148 era il bacino della famiglia, non del modello.
   * Il numero resta (dice quanto e' grande il bacino da cui peschiamo): smette di
   * spacciarsi per tuo.
   */
  const totaleLargo = !params.motoitModelSlug || null;
  return opts.withMeta ? { items: risultati, truncated, total, hasMore, totaleLargo,
    parziale: [avvisoCadute(cadute, urls.length), avvisoScartate(scartate), avvisoPrezzi(risultati), errorePagina?.message].filter(Boolean).join(' · ') || null,
    parzialeRete: !!cadute, erroreTipo: errorePagina?.kind || null, erroreHttp: errorePagina?.status || null,
    bloccoParziale: errorePagina?.kind === 'blocked' ? errorePagina : null } : risultati;
  }

  // ON-SEARCH: HTTP sequenziale gentile (come il crawler). Niente browser, niente
  // fallback. Il ramo onora `withMeta` (totale F50 e "Carica altri" ne dipendono) e
  // `fetta`: senza, tornato vivo questo ramo, sarebbero regrediti entrambi.
  const { pages, statoKo, truncated, cadute, scartate, total, hasMore, errorePagina } = await scrapeMotoViaHttp(urls, {
    modelSlug: params.motoitModelSlug,   // per leggere la versione dallo slug dell'annuncio
    pageDelayMs: ONSEARCH_DELAY_MS, httpTimeoutMs: ONSEARCH_TIMEOUT_MS, fetta: opts.fetta || 0,
  });
  // Stessa condizione del ramo `deep`, stesso esito: prima qui si tornava una lista vuota,
  // quindi `runSource` classificava 'empty', la pill diceva "Moto.it nessun risultato" in
  // grigio come per un piazzale davvero vuoto, e `cacheable()` — che considera rotti solo
  // 'error' e 'timeout' — congelava per tre minuti una risposta a cui
  // mancava una fonte intera. Una manutenzione di Moto.it non e' un mercato vuoto.
  if (statoKo) throw fail(`Moto.it-HTTP ${statoKo}`, { status: statoKo, kind: kindForStatus(statoKo) });
  const risultati = filtraPerSlug(dedup(pages), params.motoitSlugAmmessi);
  console.log(`[Moto.it] on-search OK ${risultati.length} annunci (${pages.map(p => p.length).join('+')})${truncated ? ' [troncato]' : ''}`);
  /**
   * IL TOTALE DI CHI? Senza lo slug del modello la ricerca si allarga alla MARCA, e il
   * conteggio in pagina e' quello della marca — ma la pill scriveva "N di M" come se quel
   * M fosse del modello chiesto. Misurato: cercando "CB 500 X Adventure Sports" uscivano
   * "39 di 148", e 148 era il bacino della famiglia, non del modello.
   * Il numero resta (dice quanto e' grande il bacino da cui peschiamo): smette di
   * spacciarsi per tuo.
   */
  const totaleLargo = !params.motoitModelSlug || null;
  const parziale = [avvisoCadute(cadute, urls.length), avvisoScartate(scartate), avvisoPrezzi(risultati), errorePagina?.message].filter(Boolean).join(' · ') || null;
  if (parziale) console.warn(`[Moto.it] ${parziale}`);
  return opts.withMeta ? { items: risultati, truncated, total, hasMore, totaleLargo, parziale,
    parzialeRete: !!cadute, erroreTipo: errorePagina?.kind || null, erroreHttp: errorePagina?.status || null,
    bloccoParziale: errorePagina?.kind === 'blocked' ? errorePagina : null } : risultati;
}

module.exports = scrapeMotoIt;
module.exports._mapCards = mapCards;   // backfill F50: re-map della card grezza in raw_json
module.exports._extractTotal = extractTotal;   // F50 copertura
// Esposto per i test del trasporto: se una futura area riusa questo host deve
// condividere il budget delle richieste, non aprire una seconda porta HTTP.
module.exports._get = httpGetText;
module.exports._hostOk = motoHttp.hostOk;
// Il loop di pagine e' testabile senza il throttle da 1.5s, stubbando _get.
module.exports._scrapeVia = scrapeMotoViaHttp;
