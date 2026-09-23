'use strict';
// parts-core: aggrega più fonti ricambi, come runSearchCore per auto/moto.
// Fonti: Autodoc (stealth scrape, solo mode OEM) + Web (Anthropic web_search) + Subito accessori.
// Ogni fonte è avvolta in un wrapper never-reject + timeout → una fonte lenta/rotta NON abbatte
// le altre (Promise.all sicuro). eBay sarà una fonte in più: stesso wrapper, zero refactor.
const { lookupOem, normOen } = require('./oem-lookup');
const { lookupCmsnl } = require('./cmsnl-lookup');
const { searchWebParts } = require('./web-parts');
const scrapeSubito = require('./scrapers/subito-api');   // .searchAccessori(keyword)
const ebayScrape = require('./ebay-scrape');             // scrape-bridge in attesa API ufficiale
const logger = require('./logger');
const salute = require('./fonti-salute');

const TIMEOUT_MS = parseInt(process.env.RICAMBI_TIMEOUT_MS, 10) || 45000;

// Adatta un item Subito (mapAd) allo shape parti unificato. prezzo 0 = trattabile → null.
function subitoToPart(it) {
  return {
    fonte: 'subito',
    nome: it.titolo || 'Annuncio Subito',
    prezzo: (typeof it.prezzo === 'number' && it.prezzo > 0) ? it.prezzo : null,
    valuta: 'EUR',
    immagine: it.immagini && it.immagini[0] ? (it.immagini[0].thumb || it.immagini[0].full) : null,
    venditore: it.venditore || 'privato',
    provincia: it.provincia || null,
    url: it.url || null,
  };
}
async function subitoSource(term, opts = {}) {
  if (salute.fermo('subito').fermo) {
    return { blocked: true, error: 'Subito è in pausa dopo un blocco. Riprova più tardi.' };
  }
  try {
    const items = await scrapeSubito.searchAccessori(term, { cat: opts.cat });
    salute.registra('subito', { conteggio: items.length });
    return { articoli: items.map(subitoToPart) };
  } catch (e) {
    salute.registra('subito', { errore: e });
    if (e.status === 429) return { blocked: true, error: scrapeSubito.AVVISO_429, httpStatus: 429 };
    throw e;
  }
}
async function ebaySource(term) {
  const items = await ebayScrape.searchEbay(term);   // 403/timeout → runSource lo cattura
  return { articoli: items };
}

// Filtro pertinenza per le ricerche testuali (nome/prodotto): Subito con keyword generiche
// pesca rumore (PROVATO: "faretto originale bmw gs" → 44 item tra cui barre portatutto auto).
// Tieni solo gli annunci il cui titolo contiene ≥1 token significativo della query.
const STOPWORDS = new Set(['originale', 'per', 'con', 'senza', 'nuovo', 'usato', 'coppia', 'set', 'kit',
  'completo', 'completi', 'della', 'dello', 'delle', 'di', 'da', 'la', 'il', 'lo', 'le', 'un', 'una', 'in', 'su', 'e', 'ed', 'o']);
function relevantToQuery(items, query) {
  const tokens = String(query || '').toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
  if (!tokens.length) return items;
  // match sul titolo; per i token >3 char accetta anche lo stem senza l'ultima lettera
  // (singolare/plurale italiano: faretto→farett matcha "faretti")
  return items.filter(a => {
    const titolo = String(a.nome || '').toLowerCase();
    return tokens.some(t => titolo.includes(t) || (t.length > 3 && titolo.includes(t.slice(0, -1))));
  });
}

// Avvolge la promise di una fonte (che risolve al SUO envelope) in { items, status, reason, meta }.
// status: ok | empty | blocked | error | timeout. Non rigetta mai.
async function runSource(promise, ms) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__timeout__')), ms); });
  try {
    const res = await Promise.race([promise, timeout]);
    if (!res) return { items: [], status: 'error', reason: 'nessuna risposta', meta: null };
    if (res.blocked) return { items: [], status: 'blocked', reason: res.error || 'bloccato', meta: res };
    if (res.error) return { items: [], status: 'error', reason: res.error, meta: res };
    const items = Array.isArray(res.articoli) ? res.articoli : [];
    // Una fonte puo' tornare zero articoli SAPENDO di non averli letti davvero. In quel caso
    // 'empty' sarebbe una bugia — a schermo diventerebbe "ricambio non presente nel catalogo" —
    // e la sola differenza fra le due risposte e' questo campo.
    if (!items.length && res.sospetto) return { items: [], status: 'error', reason: res.sospetto, meta: res };
    return { items, status: items.length ? 'ok' : 'empty', reason: null, meta: res };
  } catch (e) {
    const isTimeout = e.message === '__timeout__';
    return { items: [], status: isTimeout ? 'timeout' : 'error', reason: isTimeout ? 'timeout' : e.message, meta: null };
  } finally {
    clearTimeout(timer);   // libera il timer se la fonte ha vinto la race (altrimenti resta pendente 45s)
  }
}

// searchRicambi(q, opts): opts.mode = 'oem' (default) | 'prodotto' | 'nome'.
//  - oem     : term = normOen(q) → Autodoc /oem/ (auto) + CMSNL (moto) + Web + Subito
//  - prodotto: term = q.trim()   → Web + Subito (codice ARTICOLO produttore: normOen lo
//              storpierebbe — es. "09.A758.11" — e /oem/ e CMSNL vogliono un OEN)
//  - nome    : term = q.trim()   → Web + Subito
// Nei modi testuali (nome/prodotto) Subito passa dal filtro pertinenza (rumore keyword).
// deps iniettabili (test): opts.{autodoc, cmsnl, web, subito} → default = reali.
async function searchRicambi(qRaw, opts = {}) {
  const mode = ['nome', 'prodotto'].includes(opts.mode) ? opts.mode : 'oem';
  const veicolo = opts.veicolo === 'moto' ? 'moto' : 'auto';   // binario: un ricambio è per auto O per moto
  const autodocFn = opts.autodoc || lookupOem;
  const cmsnlFn = opts.cmsnl || lookupCmsnl;
  const webFn = opts.web || searchWebParts;
  const subitoFn = opts.subito || subitoSource;
  const ebayFn = opts.ebay || ebaySource;
  const ebaySpecsFn = opts.ebaySpecs || ebayScrape.fetchEbayItemSpecs;
  const term = mode === 'oem' ? normOen(qRaw) : String(qRaw || '').trim();
  if (!term) return { oen: '', mode, veicolo, articoli: [], count: 0, sources: {}, error: 'query vuota' };

  // Fan-out SOLO fonti strutturate. Il catalogo OEM segue il veicolo: auto → Autodoc, moto → CMSNL.
  // Subito interroga la sola categoria del veicolo (c=5 auto / c=36 moto).
  const jobs = {
    subito: runSource(Promise.resolve().then(() => subitoFn(term, { cat: veicolo })), TIMEOUT_MS),
    ebay: runSource(Promise.resolve().then(() => ebayFn(term)), TIMEOUT_MS),
  };
  if (mode === 'oem') {
    if (veicolo === 'auto') jobs.autodoc = runSource(Promise.resolve().then(() => autodocFn(term)), TIMEOUT_MS);
    else jobs.cmsnl = runSource(Promise.resolve().then(() => cmsnlFn(term)), TIMEOUT_MS);
  }

  const keys = Object.keys(jobs);
  const settled = await Promise.all(keys.map(k => jobs[k]));
  const res = {};
  keys.forEach((k, i) => { res[k] = settled[i]; });

  // rumore nei modi testuali → filtro pertinenza (sources.count riflette il filtrato)
  for (const k of ['subito', 'ebay']) {
    if (res[k] && mode !== 'oem') {
      res[k].items = relevantToQuery(res[k].items, term);
      if (res[k].status === 'ok' && !res[k].items.length) res[k].status = 'empty';
    }
  }

  // SCHEDA RICAMBIO: i cataloghi (Autodoc/CMSNL) trattano ricambi NUOVI → non sono "annunci",
  // sono l'identità certa del pezzo: dati tecnici + prezzo nuovo. La lista articoli resta per
  // le OFFERTE di mercato (Subito usato, poi eBay).
  const scheda = buildScheda(res, term);
  if (mode === 'oem' && !scheda) {   // diagnosi "annunci sì, scheda no": perché il catalogo non ha dato la scheda
    const cat = veicolo === 'auto' ? res.autodoc : res.cmsnl;
    logger.info('[ricambi]', `scheda null "${term}" (${veicolo}): catalogo ${cat ? cat.status : 'assente'}${cat?.reason ? ' — ' + cat.reason : ''}`);
  }

  /**
   * LA SCHEDA E' IL CATALOGO, NON IL MERCATO.
   *
   * Qui la scheda del pezzo — che e' la sua identita' certa: dati tecnici e prezzo del NUOVO
   * — si riempiva coi dati degli annunci. La foto arrivava da un'inserzione eBay e, se quella
   * mancava, dal PRIMO annuncio USATO di Subito; i dati tecnici da quella stessa inserzione,
   * mescolati a quelli di catalogo senza distinzione. Il risultato: un pezzo usato ammaccato
   * poteva finire come immagine di catalogo del pezzo nuovo, e le misure di un venditore
   * qualunque come specifiche del ricambio.
   *
   * Decisione del proprietario: nella scheda entra solo quello che dice il catalogo
   * (Autodoc/CMSNL). Se la foto non c'e', si vede il segnaposto; se i dati tecnici non ci
   * sono, quelle righe non ci sono. Gli annunci restano nella lista sotto, dove ognuno porta
   * la SUA foto e i SUOI dati, attribuiti a chi li ha scritti.
   */

  // Web search = FALLBACK-ONLY: parte solo se né la scheda né le offerte hanno trovato nulla.
  const offerteCount = ['subito', 'ebay'].reduce((n, k) => n + (res[k] ? res[k].items.length : 0), 0);
  if (!scheda && offerteCount === 0) {
    res.web = await runSource(Promise.resolve().then(() => webFn(term, { mode, veicolo, raw: String(qRaw || '').trim() })), TIMEOUT_MS);
  }

  const order = ['autodoc', 'cmsnl', 'subito', 'ebay', 'web'];
  const articoli = ['subito', 'ebay', 'web'].flatMap(k => (res[k] ? res[k].items : []));   // SOLO offerte (niente item catalogo)
  const sources = {};
  order.forEach(k => {
    if (!res[k]) return;
    sources[k] = { status: res[k].status, reason: res[k].reason, count: res[k].items.length };
    if (res[k].meta?.httpStatus) sources[k].httpStatus = res[k].meta.httpStatus;
    // fonte non riuscita → logga tag + reason (prima era muto: causa del "Web error" invisibile)
    if (res[k].status !== 'ok' && res[k].status !== 'empty') logger.warn('[ricambi]', `fonte ${k} "${term}" (${mode}/${veicolo}): ${res[k].status} — ${res[k].reason || 'n/d'}`);
  });

  return {
    oen: term, mode, veicolo,
    scheda,   // identità certa del pezzo (o null se nessun catalogo l'ha)
    // campi top-level mantenuti per compat (PDF/testata): identità catalogo → web
    tipoPezzo: scheda?.tipoPezzo || res.web?.meta?.pezzo?.tipo || null,
    categoria: res.autodoc?.meta?.categoria || null,
    veicoli: schedaVeicoli(scheda) || res.web?.meta?.pezzo?.veicoli || null,
    oeAlternativi: scheda?.oeAlternativi || [],
    sources,
    articoli,
    count: articoli.length,
    // Le pagine che la ricerca web ha TROVATO, quando non ha saputo dire chi vende cosa.
    // Non sono offerte e non stanno fra gli articoli: hanno una sezione loro (vedi
    // web-parts.js). Assenti quasi sempre — la ricerca web parte solo come ultimo ripiego.
    pagineWeb: (res.web?.meta?.pagine && res.web.meta.pagine.length) ? res.web.meta.pagine : null,
  };
}

// Estrae il TIPO base dal nome Autodoc ("Bloccasterzo TOPRAN 1K0 905 851 B" → "Bloccasterzo"):
// taglia dalla marca (1° token) o dal primo token-codice. Pura (testabile).
function baseTipo(nome, marca) {
  const n = String(nome || '').replace(/\s+/g, ' ').trim();
  if (!n) return 'Ricambio';
  const brand = String(marca || '').split(/\s+/)[0];
  // match case-insensitive: l'alt del logo ("Febi Bilstein") può differire per casing dal nome ("FEBI BILSTEIN")
  if (brand && brand.length > 1) { const i = n.toUpperCase().indexOf(brand.toUpperCase()); if (i > 0) return n.slice(0, i).trim() || n; }
  const m = n.match(/^(.*?)\s+[0-9][\w .-]*$/);   // fallback: taglia dal 1° token che inizia con cifra (codice)
  return (m && m[1]) ? m[1].trim() : n;
}
// Default variante = PIÙ RECENSITA; fallback = prezzo più vicino alla mediana. Pura.
function pickDefaultVariant(articoli) {
  const rev = articoli.filter(v => v.recensioni > 0);
  if (rev.length) return rev.reduce((m, v) => (v.recensioni > m.recensioni ? v : m)).articleId;
  const priced = articoli.filter(v => typeof v.prezzo === 'number');
  if (!priced.length) return articoli[0]?.articleId || null;
  const sorted = priced.map(v => v.prezzo).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  return priced.reduce((m, v) => (Math.abs(v.prezzo - median) < Math.abs(m.prezzo - median) ? v : m)).articleId;
}
// veicoli top-level (PDF): compatibilità della 1ª variante che ce l'ha (cmsnl fits). Array → stringa.
function schedaVeicoli(scheda) {
  const v = scheda?.catalogo?.tipi?.flatMap(t => t.articoli).find(a => a.compatibilita)?.compatibilita;
  return Array.isArray(v) ? v.join(', ') : (v || null);
}

// SCHEDA v7 = ALBERO CATALOGO: un codice OEM mappa PIÙ tipi + PIÙ varianti (materiali/marche) — NON
// un solo pezzo. Raggruppa per tipo; niente min-prezzo. Il frontend fa il selettore (tipo → variante).
function buildScheda(res, term) {
  const aItems = res.autodoc?.items || [];
  const cItems = res.cmsnl?.items || [];
  let fonte, items, fits = null, fitsTotale = null;
  if (aItems.length) { fonte = 'autodoc'; items = aItems; }
  else if (cItems.length) { fonte = 'cmsnl'; items = cItems; fits = res.cmsnl.meta?.veicoli || null; fitsTotale = res.cmsnl.meta?.veicoliTotale || null; }
  else return null;

  const byTipo = new Map();   // chiave UPPERCASE (raggruppamento case-insensitive), display = 1ª occorrenza
  items.forEach((a, idx) => {
    const tipo = fonte === 'cmsnl' ? (res.cmsnl.meta?.tipoPezzo || a.nome || 'Ricambio') : baseTipo(a.nome, a.marca);
    const v = {
      fonte, marca: a.marca || null, variante: a.variante || null,
      prezzo: typeof a.prezzo === 'number' ? a.prezzo : null,
      prezzoListino: a.prezzoListino || null, sconto: a.sconto || null,
      immagine: a.immagine || null, url: a.url || null,
      articleId: String(a.articleId || a.codiceCmsnl || a.url || a.nome || ('v' + idx)),
      stelle: a.stelle ? Number(a.stelle) : null, recensioni: a.recensioni ? Number(a.recensioni) : null,
      disponibile: a.disponibile ?? null,
      compatibilita: fonte === 'cmsnl' ? fits : null,   // cmsnl porta i fits embedded; autodoc → specs LAZY
      // Quanti sono IN TUTTO: la lista si ferma a venti, il numero no. Senza, la scheda
      // scriveva "20 modelli" per un pezzo che ne copre sessanta.
      compatibilitaTotale: fonte === 'cmsnl' ? fitsTotale : null,
      spedizione: a.spedizione || null, condizione: a.condizione || null,
    };
    const k = tipo.toUpperCase();
    if (!byTipo.has(k)) byTipo.set(k, { tipo, articoli: [] });
    byTipo.get(k).articoli.push(v);
  });
  const tipi = [...byTipo.values()]
    .sort((x, y) => y.articoli.length - x.articoli.length);   // dominante = più varianti
  const multiTipo = tipi.length > 1;
  return {
    codice: term,
    tipoPezzo: tipi[0].tipo,
    oeAlternativi: fonte === 'autodoc' ? (res.autodoc.meta?.oeAlternativi || []) : [],
    catalogo: { tipi, multiTipo, tipoDominante: tipi[0].tipo, defaultArticleId: multiTipo ? null : pickDefaultVariant(tipi[0].articoli) },
  };
}

module.exports = { searchRicambi, runSource, relevantToQuery };

// self-check manuale: `node backend/ricambi-core.js 1K0905851B` (fetch reali; web richiede ANTHROPIC_API_KEY)
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const { closeBrowser } = require('./oem-lookup');
  searchRicambi(process.argv[2] || '1K0905851B')
    .then(r => { console.log(JSON.stringify(r, null, 2)); return closeBrowser(); })
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}
