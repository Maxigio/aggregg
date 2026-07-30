'use strict';
// Route on-demand "scheda tecnica veicolo".
//  auto → auto-data.net (/it/)
//  moto → Moto.it /listino/ (PRIMARIA: italiano nativo, mercato italiano, prezzo di listino)
//         con ultimatespecs.com come RIPIEGO. Misurato su 6 marche/1087 modelli:
//         ultimatespecs 50,6% · Moto.it 42,2% · unione 62,6% (fonti complementari).
// mount(app, { clientIp }).
//  GET /api/scheda-veicolo?tipo&marca&modello&anno?&gen?     → generazioni/anni + voci (dropdown)
//  GET /api/scheda-veicolo/specs?url=<auto-data.net|ultimatespecs.com|moto.it>  → specifiche
const fs = require('fs');
const path = require('path');
const { norm } = require('./scrapers/brand-match');
const vs = require('./scrapers/vehicle-specs');
const ms = require('./scrapers/moto-specs');
const mis = require('./scrapers/motoit-specs');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { getBrandModels, getModelBikes } = require('./scrapers/motoit-models');
// Dall'annuncio alla versione Moto.it: e' il modulo che lo fa meglio, e ora lo usa la scheda.
const { risolviVersione } = require('./scrapers/risolvi-versione');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'autodata-index.json');
let INDEX = null;
function loadIndex() {
  if (INDEX) return INDEX;
  // NB: memoizza solo in caso di successo; se il file non è (ancora) leggibile ritorna un vuoto
  // NON cachato → la richiesta successiva riprova (evita notFound-per-sempre fino al riavvio).
  try { INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); return INDEX; } catch (_) { return { brands: {} }; }
}

const MOTO_INDEX_PATH = path.join(__dirname, '..', 'data', 'ultimatespecs-moto-index.json');
let MOTO_INDEX = null;
function loadMotoIndex() {
  if (MOTO_INDEX) return MOTO_INDEX;
  try { MOTO_INDEX = JSON.parse(fs.readFileSync(MOTO_INDEX_PATH, 'utf8')); return MOTO_INDEX; } catch (_) { return { brands: {}, host: ms.HOST }; }
}

// Alias marca app→chiave-indice: i cataloghi app hanno nomi più lunghi di quelli scrapati.
const BRAND_ALIAS = { royalenfield: 'enfield', dsautomobiles: 'ds' };
function brandKey(marca) { const k = norm(marca); return BRAND_ALIAS[k] || k; }

// Cache per-URL (pagine liste 12h, specs 1h, vuoti 5min) + LRU.
const PAGE_TTL = 12 * 60 * 60 * 1000, SPEC_TTL = 60 * 60 * 1000, EMPTY_TTL = 5 * 60 * 1000, CACHE_MAX = 300;
const cache = new Map();
function cacheGet(key) { const h = cache.get(key); if (h && Date.now() - h.ts < h.ttl) { cache.delete(key); cache.set(key, h); return h.data; } if (h) cache.delete(key); return null; }
function cacheSet(key, data, ttl) { cache.set(key, { ts: Date.now(), data, ttl }); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
async function fetchCached(url, ttl) { const hit = cacheGet(url); if (hit != null) return hit; const { body } = await vs.httpGetText(url); cacheSet(url, body, ttl); return body; }

const hits = new Map();
function rateOk(ip) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();   // ponytail: limita la crescita per-IP; finestra 60s → reset innocuo
  const a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length <= 40;
}

const HOST_OK_AUTO = /^https?:\/\/(www\.)?auto-data\.net\//i;
const HOST_OK_MOTO = /^https?:\/\/(www\.)?ultimatespecs\.com\//i;
const HOST_OK_MOTOIT = /^https?:\/\/(www\.)?moto\.it\/listino\//i;   // solo il listino, non tutto moto.it
// specs URL → quale parser usare (o null se host non consentito, anti-SSRF)
function specsHostKind(url) {
  if (HOST_OK_AUTO.test(url)) return 'auto';
  if (HOST_OK_MOTO.test(url)) return 'moto';
  if (HOST_OK_MOTOIT.test(url)) return 'motoit';
  return null;
}
// nome modello senza gli anni finali ("Golf 1974 -" → "Golf", "A3 2003 -" → "A3") per display E match
const cleanName = n => String(n).replace(/\s+(19|20)\d{2}\s*(-\s*((19|20)\d{2})?)?\s*$/, '').trim() || String(n);

/**
 * Match modello SICURO: esatto-normalizzato, altrimenti la query è PREFISSO del candidato
 * (golf → golf1974). NON il contrario → evita falsi positivi tipo "classea" → "cla".
 *
 * UN SOLO CANDIDATO O NIENTE. Prima, con più candidati, si prendeva il più CORTO — cioè si
 * sorteggiava: "Silverado" (4 candidati: 1500, 2500 HD, 3500 HD, EV) finiva sulla EV, e
 * "Hover" (CUV, H5, H6) sulla H5. Sono veicoli diversi, e la scheda tecnica usciva
 * dichiarata come quella giusta. Con un candidato solo il prefisso resta la migliore
 * risposta disponibile ("575M" → "575M Maranello", che nel catalogo tecnico si chiama così).
 * Misurato sulle famiglie Subito: 21 match per prefisso, 4 con più di un candidato.
 */
function matchModel(models, query) {
  const q = norm(query);
  if (!q) return null;
  const items = models.map(m => ({ n: norm(cleanName(m.name)), m })).filter(x => x.n);
  const exact = items.find(x => x.n === q);
  if (exact) return exact.m;
  if (q.length >= 3) {
    const pref = items.filter(x => x.n.length >= 3 && x.n.startsWith(q));
    if (pref.length === 1) return pref[0].m;
  }
  return null;
}

// ── Moto (ultimatespecs) ─────────────────────────────────────────────────────
// Match modello moto: esatto-normalizzato + varianti (chiave che estende q con un
// carattere NON numerico → "mt07" pesca mt07/mt07abs/mt07tr, ma non "r1"→"r15").
// token a confine-parola, accenti appianati ("Caballero-Rally-500" → [caballero,rally,500])
const motoTokens = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);
// Prefisso SICURO: la chiave estende la query con un carattere NON numerico.
// "mt07"→"mt07abs" sì; "r1"→"r15" no; "cb1"→"cb1100" no (sono moto diverse).
// Regola unica per entrambe le fonti moto: duplicarla è come sono nati i falsi match.
const prefissoSicuro = (k, q) => k.startsWith(q) && k.length > q.length && !/\d/.test(k[q.length]);

function matchMotoModels(models, query) {
  const q = norm(query);
  if (!q) return [];
  const out = [];
  for (const k of Object.keys(models)) {
    if (k === q || prefissoSicuro(k, q)) out.push({ k, ...models[k] });
  }
  // RIPIEGO: ultimatespecs intercala la variante nel nome ("Caballero-Rally-500"), quindi
  // "Caballero 500" non è prefisso di nessuna chiave → prima non trovavamo niente. Qui si
  // accettano le voci il cui nome contiene TUTTI i token cercati, a confine-parola e in
  // ordine libero. Il confine-parola è ciò che evita i falsi match: "Pegaso 50" NON prende
  // "Pegaso-650" (token "50" ≠ "650"), e "R1" non prende "R15".
  // Solo se il prefisso non ha trovato nulla → nessun match già funzionante cambia.
  if (!out.length) {
    const qt = motoTokens(query);
    // Sigla-serie di 1 carattere dichiarata dalla query (BMW "R 1300 R" → "r"): in quel caso
    // NON si accetta una voce che apra con una sigla DIVERSA ("K-1300-R" è un'altra moto).
    // Se la query non dichiara nessuna sigla ("100 CS"), la voce può averla ("R-100-CS").
    const qSigle = qt.filter(t => t.length === 1);
    if (qt.length) for (const k of Object.keys(models)) {
      const lt = motoTokens(models[k].label);
      if (!qt.every(t => lt.includes(t))) continue;
      if (qSigle.length && lt[0] && lt[0].length === 1 && !qSigle.includes(lt[0])) continue;
      out.push({ k, ...models[k] });
    }
  }
  out.sort((a, b) => a.k.length - b.k.length);   // base (chiave più corta) primo
  return out;
}

// Marche moto dal catalogo (per lo slug Moto.it già risolto). Caricamento pigro: il file
// è grosso ma è lo STESSO modulo che require anche server.js → istanza condivisa da Node.
let MOTO_BRANDS = null;
function motoBrandEntry(marca) {
  if (!MOTO_BRANDS) { try { MOTO_BRANDS = require('../data/models.json').moto || {}; } catch (_) { MOTO_BRANDS = {}; } }
  return MOTO_BRANDS[marca] || null;
}

// ── Moto.it (/listino/) — fonte PRIMARIA per la scheda moto ──────────────────
// Riusa la stessa API che alimenta l'input "Versione Moto.it" della ricerca: così la
// scheda parla della STESSA versione che l'utente sceglie cercando (prima ricerca e
// scheda usavano fonti diverse, da cui la confusione "Explorer" di moto.it vs "Explore").
// Ritorna null se Moto.it non copre la moto → il chiamante ripiega su ultimatespecs.
/**
 * La famiglia Moto.it che corrisponde al modello cercato — o NIENTE.
 * Fuori da resolveMotoit solo per poterla provare senza rete: e' la regola, non la richiesta.
 */
function famigliaMotoit(modelli, modello) {
  const q = norm(modello), qt = motoTokens(modello);
  const cand = (modelli || []).map(m => ({ ...m, n: norm(m.name), t: motoTokens(m.name) }));
  const unico = lista => (lista.length === 1 ? lista[0] : null);
  return cand.find(m => m.n === q)
    || unico(cand.filter(m => q.length >= 3 && prefissoSicuro(m.n, q)))
    || (qt.length ? unico(cand.filter(m => qt.every(t => m.t.includes(t)))) : null);
}

async function resolveMotoit({ marca, modello, anno }) {
  if (!marca || !modello) return null;
  const brandEntry = motoBrandEntry(marca);
  const brandSlug = (brandEntry && brandEntry.motoit && brandEntry.motoit.brandSlug) || resolveMotoitSlug(marca) || null;
  if (!brandSlug) return null;
  let modelli = [];
  try { modelli = await getBrandModels(brandSlug); } catch (_) { return null; }
  if (!modelli.length) return null;
  // UN SOLO CANDIDATO O NIENTE — la stessa regola che `matchModel` applica gia' al catalogo
  // auto (righe 80-91). Qui non c'era: fra piu' famiglie si teneva la PIU' CORTA, e a parita'
  // di lunghezza vinceva l'ordine di inserimento del catalogo, cioe' il caso. Misurato su
  // 5.639 nomi Subito: 235 finivano su una famiglia scelta a sorte fra 2 e 12 — un annuncio
  // Ducati Scrambler 800 apriva la scheda "Scrambler 350", una monocilindrica anni '60, con
  // le specifiche presentate come quelle dell'annuncio. Tornando null si ripiega su
  // ultimatespecs, che di quelle 235 ne copre 185.
  const hit = famigliaMotoit(modelli, modello);
  if (!hit) return null;
  let versioni = [];
  try { versioni = await getModelBikes(brandSlug, hit.slug); } catch (_) { return null; }
  if (!versioni.length) return null;
  // Foto + prezzo per versione dalla pagina-modello: UNA richiesta cachata 12h per tutte,
  // così la griglia moto ha le immagini come quella auto. Se salta, si procede senza foto.
  let meta = { versioni: {}, fotoModello: '' };
  try {
    const mUrl = mis.modelUrl(brandSlug, hit.slug);
    const hitCache = cacheGet('motoit-model:' + mUrl);
    if (hitCache) meta = hitCache;
    else {
      const { body } = await mis.httpGetText(mUrl);
      meta = mis.parseModelVersionsMeta(body, brandSlug, hit.slug);
      cacheSet('motoit-model:' + mUrl, meta, PAGE_TTL);
    }
  } catch (_) { /* niente foto, la scheda funziona comunque */ }
  const entries = versioni.map(v => {
    const m = meta.versioni[v.code] || {};
    return {
      label: v.name, url: mis.specUrl(brandSlug, hit.slug, v.code),
      year: v.annoMin || null, yearRange: v.annoMin ? (v.annoMax && v.annoMax !== v.annoMin ? `${v.annoMin}–${v.annoMax}` : `${v.annoMin}`) : '',
      img: m.img || meta.fotoModello || '', prezzo: m.prezzo || '',
    };
  });
  entries.sort((a, b) => (b.year || 0) - (a.year || 0) || a.label.localeCompare(b.label));
  const yr = Number(anno) || null;   // porta in cima l'annata cercata (lista comunque anno-desc)
  if (yr && entries.length) {
    let bi = 0, bd = Infinity;
    entries.forEach((e, i) => { const d = Math.abs((e.year || 0) - yr); if (d < bd) { bd = d; bi = i; } });
    if (bi > 0) entries.unshift(entries.splice(bi, 1)[0]);
  }
  const nome = hit.name || String(modello).trim();
  return {
    title: `${marca} ${nome}`, marca, modello: nome,
    generations: [], gen: { name: `${marca} ${nome}`, slug: '' },
    motorizzazioni: entries, source: 'moto.it',
  };
}

// marca+modello(+anno) → tutte le voci/anni della famiglia (dropdown), specifiche lazy via /specs.
function resolveMoto({ marca, modello, anno }) {
  const idx = loadMotoIndex();
  const brand = idx.brands[brandKey(marca)];
  if (!brand) return { notFound: 'marca' };
  const matched = matchMotoModels(brand.models, modello);
  if (!matched.length) return { notFound: 'modello' };
  const host = idx.host || ms.HOST;
  const entries = [];
  for (const mo of matched) for (const [year, slug] of mo.items) {
    entries.push({ label: `${mo.label} · ${year}`, url: `${host}/motorcycles-specs/${brand.seg}/${slug}`, year });
  }
  entries.sort((a, b) => b.year - a.year || a.label.localeCompare(b.label));
  const yr = Number(anno) || null;   // preseleziona (in cima) la voce dell'annata cercata; lista resta anno-desc
  if (yr && entries.length) {
    let bi = 0, bd = Infinity;
    entries.forEach((e, i) => { const d = Math.abs(e.year - yr); if (d < bd) { bd = d; bi = i; } });
    if (bi > 0) entries.unshift(entries.splice(bi, 1)[0]);
  }
  // Nome del veicolo: la voce ESATTA se esiste, altrimenti ciò che l'utente ha cercato.
  // Prima si prendeva matched[0].label = la chiave più corta, cioè una variante ARBITRARIA:
  // cercando "800MT" (che su ultimatespecs non esiste come voce a sé) la scheda si
  // intitolava "800MT-Sport" solo perché più corta di "800MT-Touring". Le varianti restano
  // tutte selezionabili nella griglia: è là che l'utente scegli, non nel titolo.
  const exact = matched.find(m => m.k === norm(modello));
  const baseLabel = exact ? exact.label : String(modello || '').trim() || matched[0].label;
  return {
    title: `${brand.name} ${baseLabel}`, marca: brand.name, modello: baseLabel,
    generations: [], gen: { name: `${brand.name} ${baseLabel}`, slug: '' },
    motorizzazioni: entries.map(e => ({ label: e.label, url: e.url, year: e.year })),
    source: 'ultimatespecs.com',
  };
}

// marca+modello(+anno|gen) → { title, marca, modello, generations[], gen, motorizzazioni[] }
/**
 * IL NOME DEL MODELLO SENZA LA GENERAZIONE CHE LA FONTE GLI ATTACCA.
 *
 * Subito non scrive "Golf": scrive "Golf 5ª serie", "Panda 3ª serie", "Serie 3 (E90/91)".
 * Il catalogo tecnico ha "Golf" e "Serie 3", quindi con il nome cosi' com'e' non trovava
 * niente. Misurato su 120 annunci veri di sei modelli: 74 volte su 120 la scheda rispondeva
 * "modello non a catalogo", e togliendo questo suffisso scendono a 11.
 *
 * Sta QUI e non nel frontend perche' vale per ogni chiamante — la griglia, il parco di un
 * concessionario, la preselezione — e perche' la generazione, quando serve, si legge dal nome
 * grezzo prima di questa pulizia (vedi `schedaPerAnnuncio`).
 */
const senzaGenerazione = m => String(m == null ? '' : m)
  .replace(/\s*\(.*$/, '')                        // "Serie 3 (E90/91)"
  .replace(/\s+\d+[ªa°]?\s*serie\b.*$/i, '')      // "Golf 5ª serie"
  .trim();

/**
 * LE PAROLE CHE DISTINGUONO LE GENERAZIONI FRA LORO, dette dal catalogo e non da una tabella.
 *
 * Il catalogo tecnico separa "A3 Sportback (8V)" da "A3 (8V)", "Serie 3 Touring (F31)" da
 * "Serie 3 Berlina (F30)", "Golf Variant" da "Golf". Quelle parole — sportback, touring,
 * variant, cabriolet, 4x4, e persino i codici telaio — l'annuncio spesso le scrive nel titolo,
 * e finora non le guardavamo. Prendendole dai NOMI delle generazioni non c'e' nessun elenco da
 * mantenere: quando il catalogo cambia, cambiano da sole.
 *
 * Misurato sul testo degli annunci: BMW Serie 3 142 su 208 (touring 94, e i codici e46/e90/e91
 * scritti dal venditore), Audi A3 32 su 210 (sportback), Golf 21, Classe A 16, Panda 19.
 */
const RUMORE_GEN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|facelift|phase|door|doors|porte|lci|typ|restyling|mk|serie|series|\d+)$/i;
const paroleDi = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);
function paroleDistintive(gens, marca, modello) {
  const escluse = new Set([...paroleDi(marca), ...paroleDi(modello)]);
  const insiemi = gens.map(g => new Set(paroleDi(g.name).filter(w => w.length > 2 && !escluse.has(w) && !RUMORE_GEN.test(w))));
  const conta = new Map();
  for (const ins of insiemi) for (const w of ins) conta.set(w, (conta.get(w) || 0) + 1);
  return [...conta.entries()].filter(([, n]) => n < gens.length).map(([w]) => w);
}

/** Quella stessa generazione, letta invece di buttata: "5ª serie" → V, "(E90/91)" → [E90,E91]. */
const ROMANI = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function generazioneDichiarata(modello) {
  const s = String(modello == null ? '' : modello);
  const n = s.match(/\s(\d+)[ªa°]?\s*serie\b/i);
  const c = s.match(/\(([^)]+)\)/);
  return {
    romano: n && ROMANI[Number(n[1])] ? ROMANI[Number(n[1])] : null,
    codici: c ? codiciDaParentesi(c[1]) : [],
  };
}
/**
 * LA PARENTESI VALE INTERA. Subito scrive due codici accorciando il primo — "Classe C (W/S205)"
 * sono W205 (berlina) e S205 (station wagon), "Serie 3 (E90/91)" sono E90 ed E91. Scartando i
 * pezzi troppo corti restava un codice solo, e su Mercedes era SEMPRE quello della wagon: chi
 * apriva la scheda di una berlina si vedeva peso, bagagliaio e consumi della familiare,
 * presentati come quelli del suo annuncio. Ogni pezzo si ricompone con la coda del vicino
 * completo, come versione-dedotta.js:207 fa con le porte "3/5" → [3,5].
 */
function codiciDaParentesi(dentro) {
  const VALIDO = /^[A-Za-z0-9]{2,6}$/;
  const pezzi = String(dentro).split(/[\/,\s]+/).filter(Boolean);
  // Un codice e' COMPLETO quando ha sia lettere sia cifre ("S205", "E90", "F20"): e' da
  // quelli che si ricava la parte mancante degli altri.
  const completi = pezzi.filter(x => VALIDO.test(x) && /[A-Za-z]/.test(x) && /\d/.test(x));
  const prefisso = (completi.map(x => (x.match(/^[A-Za-z]+/) || [''])[0]).find(Boolean)) || '';
  const cifre = (completi.map(x => (x.match(/\d+$/) || [''])[0]).find(Boolean)) || '';
  const out = new Set(completi);
  for (const p of pezzi) {
    if (completi.includes(p)) continue;
    let cand = null;
    if (/^[A-Za-z]+$/.test(p) && cifre) cand = p + cifre;                 // "W"  + 205 → W205
    else if (/^\d+$/.test(p) && prefisso) cand = prefisso + p;            // "E" + "91" → E91
    if (cand && VALIDO.test(cand)) { out.add(cand); continue; }
    // Nessun vicino da cui ricavare niente: si tiene il pezzo se e' valido da solo.
    // E' il caso di "Panda (169)", dove le cifre nude SONO il codice.
    if (VALIDO.test(p)) out.add(p);
  }
  return [...out];
}

/** La cilindrata in litri, da dove la fonte l'ha messa. Le etichette del catalogo la scrivono
 *  cosi' ("1.9 TDI 105 Hp"), tranne su BMW dove al suo posto c'e' la sigla ("320d"). */
const litri = t => { const m = String(t == null ? '' : t).match(/\b([0-9])[.,]([0-9])\b/); return m ? Number(m[1] + '.' + m[2]) : null; };
/** Le sigle-motore scritte nell'annuncio: "320d", "116d", "340i". */
const sigleMotore = t => [...new Set((String(t == null ? '' : t).toLowerCase().match(/\b\d{2,4}[a-z]{1,3}\b/g) || []))];

async function resolveScheda({ tipo, marca, modello: modelloGrezzo, anno, genSlug }) {
  const modello = senzaGenerazione(modelloGrezzo) || modelloGrezzo;
  if (tipo === 'moto') return (await resolveMotoit({ marca, modello, anno })) || resolveMoto({ marca, modello, anno });
  if (tipo && tipo !== 'auto') return { unsupported: true };
  const idx = loadIndex();
  const brand = idx.brands[brandKey(marca)];
  if (!brand) return { notFound: 'marca' };
  // Nomi IT → EN per i pattern comuni (Serie 3 → 3 Series, Classe A → A-Class) su auto-data.net
  const candidates = [modello];
  let mm = /^serie\s+(.+)$/i.exec(modello); if (mm) candidates.push(mm[1] + ' Series');
  mm = /^classe\s+(.+)$/i.exec(modello); if (mm) { candidates.push(mm[1] + '-Class'); candidates.push(mm[1] + ' Class'); }
  let model = null;
  for (const q of candidates) { model = matchModel(Object.values(brand.models), q); if (model) break; }
  if (model) return await resolveModelPage(brand, model, genSlug);
  // Fallback: la ricerca interna di auto-data.net risolve le sigle-motore/varianti che NON sono
  // modelli ("318"→trim Serie 3, "CT 200h"→trim Lexus CT). Delego il matching alla fonte, niente liste.
  return (await searchScheda(brand, marca, modello, genSlug)) || { notFound: 'modello' };
}

// modello risolto → generazioni (senza gen scelta) o trim della generazione scelta.
async function resolveModelPage(brand, model, genSlug) {
  const modelUrl = `${vs.HOST}/it/${model.slug}`;   // /it/ = pagina in italiano (nomi generazioni + specifiche native)
  const mp = await fetchCached(modelUrl, PAGE_TTL);
  const gens = vs.parseGenerationList(mp);
  // body senza generazioni = pagina transitoria/interstitial servita 200 → declassa il TTL a EMPTY_TTL
  // così si riprova tra pochi minuti invece di restare notFound per 12h.
  if (!gens.length) { cacheSet(modelUrl, mp, EMPTY_TTL); return { notFound: 'generazione' }; }
  // nome-modello italiano dal <title> della pagina /it/ ("BMW Serie 3 | Scheda…"), altrimenti quello (EN) dall'indice
  const itTitle = (mp.match(/<title>([^<|]+)/i) || [])[1];
  const itName = itTitle ? itTitle.replace(/\s+/g, ' ').trim().replace(new RegExp('^' + brand.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '').trim() : '';
  const mName = itName || cleanName(model.name);   // via anni dal nome
  const base = {
    title: `${brand.name} ${mName}`, marca: brand.name, modello: mName,
    generations: gens.map(g => ({ name: g.name, slug: g.slug, img: g.img || '', years: g.years || [] })), source: 'auto-data.net',
  };
  // Senza generazione scelta: NON caricare i trim (l'utente sceglie prima la generazione).
  const gen = genSlug ? gens.find(g => g.slug === genSlug) : null;
  if (!gen) return { ...base, gen: null, motorizzazioni: [] };
  const gp = await fetchCached(`${vs.HOST}/it/${gen.slug}`, PAGE_TTL);
  return { ...base, gen: { name: gen.name, slug: gen.slug }, motorizzazioni: vs.parseTrimList(gp, gen.slug) };
}

// Ricerca interna auto-data.net (get-words.php): se indica un modello del nostro indice usa il flusso
// generazioni; altrimenti "atterra sui trim" — le versioni trovate diventano le motorizzazioni.
async function searchScheda(brand, marca, modello, genSlug) {
  const url = `${vs.HOST}/ajax/get-words.php?SEARCH_MORE_RESULTS=0&search=${encodeURIComponent(`${marca} ${modello}`)}`;
  let body; try { body = await fetchCached(url, PAGE_TTL); } catch (_) { return null; }
  const bn = norm(brand.name);
  const items = vs.parseSearchWords(body).filter(x => norm(x.label).startsWith(bn));   // solo la marca cercata
  if (!items.length) return null;
  // la ricerca indica un MODELLO che abbiamo in indice → flusso generazioni (griglia foto)
  const modelHit = items.find(x => x.kind === 'model');
  const model = modelHit && Object.values(brand.models).find(m => m.slug === modelHit.slug);
  if (model) return await resolveModelPage(brand, model, genSlug);
  // altrimenti atterra sui trim (le versioni che la fonte associa alla sigla cercata)
  const trims = items.filter(x => x.kind === 'trim').slice(0, 40);
  if (!trims.length) return null;
  return {
    title: `${brand.name} ${cleanName(modello)}`, marca: brand.name, modello: cleanName(modello),
    generations: [], gen: null, source: 'auto-data.net', kind: 'search',
    motorizzazioni: trims.map(t => ({ label: t.label, url: t.url, year: t.year, yearRange: t.yearRange, hp: t.hp, fuel: t.fuel })),
  };
}

/**
 * LA SCHEDA DI QUESTO ANNUNCIO, non del modello cercato.
 *
 * Prima la scheda nasceva dai parametri di RICERCA — marca, modello, anno — e poi
 * chiedeva a te di scegliere a mano generazione e motorizzazione. Due difetti, e il
 * secondo e' peggiore del primo:
 *   - ti faceva ri-specificare a mano quello che il singolo annuncio gia' dichiara;
 *   - con la versione diventata un campo libero e facoltativo, una scheda agganciata
 *     alla ricerca mostra le specifiche di "quello che hai cercato" su un annuncio che
 *     quella cosa non e'.
 *
 * Qui si parte dall'annuncio: anno, potenza e carburante li DICHIARA lui, e sono
 * esattamente i campi con cui il catalogo distingue una motorizzazione dall'altra.
 *
 * NON SI SCEGLIE MAI FRA PARI. Se dopo il confronto ne restano due, si restituiscono
 * tutte e due e decide chi guarda: mostrare la scheda sbagliata e' peggio che non
 * mostrarne nessuna, perche' chi legge non ha modo di accorgersene.
 *
 * COSTO: due pagine di catalogo per annuncio, entrambe in cache 12 ore e condivise fra
 * annunci dello stesso modello — che in una ricerca sono quasi tutti.
 */
const FAM_CARB = s => {
  const t = norm(s);
  if (!t) return null;
  if (/elettric/.test(t)) return 'e';
  if (/gpl|lpg/.test(t)) return 'g';
  if (/metano|cng/.test(t)) return 'm';
  if (/diesel|gasolio/.test(t)) return 'd';
  if (/benzin|petrol/.test(t)) return 'b';
  if (/ibrid|hybrid/.test(t)) return 'i';
  return null;
};
/** Carburanti incompatibili? Solo quando lo sono davvero: un ibrido benzina sta su una benzina. */
function carbDiverso(a, b) {
  if (!a || !b) return false;
  if (a === 'i' || b === 'i') return false;          // l'ibrido il catalogo lo scrive in mille modi
  return a !== b;
}

/**
 * Il catalogo scrive il cambio dentro l'etichetta ("2.0 TDI 150 Hp DSG"), l'annuncio lo
 * dichiara in un campo. Vale un dimezzamento della lista: fra "150 Hp" e "150 Hp DSG"
 * l'annuncio sa quale delle due e'.
 */
const AUTOM_ETI = /\b(dsg|s.?tronic|tiptronic|multitronic|steptronic|geartronic|dualogic|powershift|automatic|automatica|automatico|cvt|edc|dct|tct|pdk|amt|at\d?)\b/i;

/**
 * LA CARROZZERIA TAGLIA LE GENERAZIONI, ed e' il taglio piu' utile perche' arriva PRIMA
 * delle richieste: su "Golf 2016" le generazioni che coprono l'anno sono sei, e sono
 * quasi tutte varianti di carrozzeria (3 porte, 5 porte, Variant, Sportsvan, Alltrack,
 * Cabriolet). L'annuncio la dichiara — campo nativo, presente nel 99% — quindi non c'e'
 * ragione di aprirle tutte e poi far scegliere a mano.
 */
// `t-modell` e' come auto-data chiama la station wagon Mercedes: verificato sulla pagina della
// Classe C, dove le generazioni si chiamano "Classe C (W205)" e "Classe C T-modell (S205)".
// Senza, la carrozzeria dichiarata dall'annuncio non riusciva a distinguerle.
const GEN_FAMIGLIA = /\b(variant|alltrack|sportwagon|estate|touring|avant|wagon|sw|t-modell)\b/i;
const GEN_APERTA    = /\b(cabrio|cabriolet|roadster|convertible|spider|spyder)\b/i;
const GEN_COUPE     = /\b(coupe|coup[eé])\b/i;
const GEN_MONOV     = /\b(sportsvan|plus|van|monovolume|tourer)\b/i;
function generazioneCompatibile(nome, carrozzeria) {
  const c = norm(carrozzeria);
  if (!c) return true;
  const n = String(nome || '');
  if (/stationwagon|familiare|sw/.test(c))          return GEN_FAMIGLIA.test(n);
  if (/cabrio|spider|spyder|convertibile/.test(c))  return GEN_APERTA.test(n);
  if (/coupe/.test(c))                              return GEN_COUPE.test(n) || (!GEN_FAMIGLIA.test(n) && !GEN_APERTA.test(n));
  if (/monovolume|multispazio/.test(c))             return GEN_MONOV.test(n);
  // Berlina, utilitaria, city car, SUV: tutto tranne le carrozzerie che si riconoscono
  return !GEN_FAMIGLIA.test(n) && !GEN_APERTA.test(n) && !GEN_MONOV.test(n);
}

async function schedaPerAnnuncio({ tipo, marca, modello: modelloGrezzo, anno, cv, carburante, cambio, carrozzeria, titolo, variante, cilindrata }) {
  const modello = senzaGenerazione(modelloGrezzo) || modelloGrezzo;
  const base = await resolveScheda({ tipo, marca, modello, anno });
  if (!base || base.unsupported || base.notFound) return { ok: false, motivo: 'modello non a catalogo' };

  /**
   * LE MOTO LE RISOLVE `risolvi-versione.js`, non i filtri qui sotto.
   *
   * Moto.it taglia le versioni per PERIODO di produzione, e il catalogo non porta ne'
   * potenza ne' carburante: gli unici vincoli utili sono l'anno e le parole del titolo, che
   * e' esattamente il lavoro di quel modulo. Misurato su 204 annunci Moto.it veri, dove la
   * verita' e' esatta perche' l'URL dell'annuncio dichiara la sua versione:
   *
   *   solo la finestra degli anni (quello che facevamo)  71 risposte, 65 giuste
   *   risolviVersione (anno + variante dal titolo)      157 risposte, 156 giuste
   *
   * Raddoppia le risposte e alza la precisione dal 91,5% al 99,4%. E quando non e' sicuro
   * lo DICHIARA (`ripiego`, `ambigua`): quei casi non si preselezionano, si mostra la griglia.
   */
  if (tipo === 'moto' && Array.isArray(base.motorizzazioni) && base.motorizzazioni.length) {
    const voci = base.motorizzazioni;
    const nomeMod = base.modello || modello || '';
    const parole = s => String(s || '').toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
    const modTok = new Set(parole(nomeMod));
    const indice = {
      marca, subito: { nome: nomeMod },
      versioniMotoit: voci.map(v => {
        const pulito = String(v.label || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        const a = String(v.yearRange || '').match(/(\d{4})\D+(\d{4})/);
        return {
          nome: v.label, _voce: v,
          variante: parole(pulito).filter(w => !modTok.has(w)).join(' ') || null,
          anni: v.year ? { da: v.year, a: a ? Number(a[2]) : v.year } : null,
        };
      }),
    };
    const r = risolviVersione(indice, { anno, versione: titolo || '' });
    const scelta = r.esito === 'una' && r.versioni.length === 1 ? r.versioni[0]._voce : null;
    return {
      ok: true, source: base.source, genUnica: null,
      scelta,
      candidate: scelta ? [] : (r.versioni.length ? r.versioni : indice.versioniMotoit).map(v => v._voce).slice(0, 40),
      perche: scelta ? r.perche : (r.perche + ' → scegli tu'),
      grado: r.esito,
    };
  }

  const y = parseInt(anno, 10) || null;
  /**
   * LE GENERAZIONI CHE COPRONO L'ANNO, e prima quelle che lo coprono DAVVERO.
   * Su "Golf 2016" dodici generazioni passano con un anno di tolleranza, e le prime della
   * lista sono i facelift 2017: un'auto del 2016 non e' li'. Prendendo le prime quattro si
   * finiva a proporre delle 1.4 TGI (metano) per un diesel. Quindi: prima chi contiene
   * l'anno per davvero, e la tolleranza solo se non contiene nessuno.
   */
  let gens = base.generations || [];
  if (y && gens.length) {
    const dentro = gens.filter(g => { const [da, a] = g.years || []; return da && y >= da && (!a || y <= a); });
    const quasi  = gens.filter(g => { const [da, a] = g.years || []; return da && y >= da - 1 && (!a || y <= a + 1); });
    if (dentro.length) gens = dentro;
    else if (quasi.length) gens = quasi;
  }
  // La carrozzeria dell'annuncio, quando c'e', toglie le generazioni che non possono
  // essere quella. Non si applica se svuota: meglio qualche candidata in piu' che zero.
  if (carrozzeria && gens.length > 1) {
    const p = gens.filter(g => generazioneCompatibile(g.name, carrozzeria));
    if (p.length) gens = p;
  }
  /**
   * LA GENERAZIONE CHE L'ANNUNCIO DICHIARA. Subito la scrive nel nome del modello e finora la
   * buttavamo: "Golf 5ª serie" e' la V, "Serie 3 (E90/91)" e' la E90 o la E91. Restringe le
   * generazioni da aprire, quindi taglia anche le richieste.
   *
   * Le due lingue non combaciano allo stesso modo per tutte le marche — misurato: il catalogo
   * tecnico usa il numero romano su Volkswagen, Fiat, Ford e Renault, il codice telaio su BMW,
   * il codice progetto ("8V") su Audi, dove "4ª serie" non ha nessun ponte con "8V". Quindi
   * questo aggancio riesce su alcune marche e non su altre, e quando non riesce si ignora.
   */
  const gd = generazioneDichiarata(modelloGrezzo);
  const gensTutte = gens;
  if ((gd.romano || gd.codici.length) && gens.length > 1) {
    const p = gens.filter(g => gd.codici.some(c => new RegExp('\\b' + c + '\\b', 'i').test(g.name))
      || (gd.romano && new RegExp('\\b' + gd.romano + '\\b').test(g.name)));
    if (p.length) gens = p;
  }
  /**
   * LA CARROZZERIA (E IL TELAIO) SCRITTI NEL TESTO. Subito mette Sportback, Berlina e Sedan
   * tutte sotto "Berlina" — 172 annunci su 210 sull'A3 — quindi il campo carrozzeria non le
   * separa. Il titolo invece lo fa, e con lui i codici telaio che i venditori BMW scrivono.
   * Vince la generazione che ne contiene PIU' di quelle trovate: chiederle tutte scarterebbe
   * un titolo che ne nomina due appartenenti a generazioni diverse.
   */
  if (gens.length > 1) {
    const dis = paroleDistintive(gens, marca, modello);
    // SOLO quello che ha scritto il venditore. Il nome del modello NO: "Serie 3 (E90/91)"
    // porta dentro DUE codici — berlina e touring — e ne farebbe due indizi a pari merito,
    // cioe' rumore. Quella coppia la gestisce gia' `generazioneDichiarata` come tale.
    const nel = new Set(paroleDi(`${titolo || ''} ${variante || ''}`));
    const cercate = dis.filter(w => nel.has(w));
    if (cercate.length) {
      const punti = g => { const p = paroleDi(g.name); return cercate.filter(w => p.includes(w)).length; };
      const max = Math.max(...gens.map(punti));
      if (max > 0) gens = gens.filter(g => punti(g) === max);
    }
  }
  // Il tetto resta una richiesta per generazione: sei bastano; oltre, l'anno e la
  // carrozzeria non stanno restringendo niente e la scelta e' tua.
  const apri = async (quali) => {
    const voci = (base.motorizzazioni || []).slice();
    for (const g of quali.slice(0, 6)) {
      try {
        const d = await resolveScheda({ tipo, marca, modello, genSlug: g.slug });
        for (const m of (d && d.motorizzazioni) || []) voci.push({ ...m, gen: g.name, genSlug: g.slug });
      } catch (_) { /* una generazione che non si apre non deve far cadere le altre */ }
    }
    return voci;
  };
  let voci = await apri(gens);
  if (!voci.length) return { ok: false, motivo: 'nessuna motorizzazione a catalogo' };

  /**
   * POTENZA E CARBURANTE INSIEME, non uno dopo l'altro.
   * A catena, quando il secondo vincolo non trovava niente si teneva il risultato del
   * primo: per un Golf diesel 110 CV restavano quattro 1.4 TGI, che e' metano. Un
   * insieme sbagliato mostrato con sicurezza e' peggio di un insieme vuoto.
   */
  const cvN = parseInt(cv, 10) || null;
  const fam = FAM_CARB(carburante);
  // Il cambio: 'Manuale' → fuori le automatiche, 'Automatico'/'Sequenziale' → solo quelle.
  const cam = norm(cambio);
  const auto = cam ? (/manuale/.test(cam) ? false : /autom|sequen/.test(cam) ? true : null) : null;
  const usati = [cvN && 'potenza', fam && 'carburante', auto != null && 'cambio', carrozzeria && 'carrozzeria'].filter(Boolean);
  // I CV dichiarati e quelli di catalogo ballano di un paio: arrotondamenti kW→CV.
  /**
   * LA POTENZA SI CONFRONTA CON CHI LA DICHIARA. Il catalogo Moto.it porta solo nome, codice
   * e annate: senza cavalli, `m.hp` e' sempre assente e il confronto era falso per OGNI voce
   * moto — con la potenza dell'annuncio (che sulle moto c'e' quasi sempre) non ne
   * sopravviveva nessuna e la preselezione non riusciva mai. Ora una voce che non dichiara
   * la potenza non viene esclusa da essa: resta in gioco e la decidono gli altri vincoli.
   */
  let vive = voci.filter(m => (!cvN || m.hp == null || Math.abs(m.hp - cvN) <= 3)
                           && (!fam || !carbDiverso(fam, FAM_CARB(m.fuel)))
                           && (auto == null || AUTOM_ETI.test(m.label || '') === auto));
  // Doppioni: la stessa motorizzazione compare in generazioni gemelle (Variant, facelift).
  const visti = new Set();
  vive = vive.filter(m => { const k = m.url; if (visti.has(k)) return false; visti.add(k); return true; });
  /**
   * LA RETE SOTTO LA GENERAZIONE. Quel filtro taglia PRIMA di aprire le generazioni, quindi
   * quando sbaglia — e su Audi sbaglia per costruzione, "4ª serie" non e' "(8V)" — la
   * motorizzazione giusta non viene nemmeno scaricata, e un annuncio che prima finiva in
   * griglia finiva a mani vuote. Misurato: un caso su 120. Qui si riapre tutto e si rifa' il
   * conto, cosi' un vincolo puo' solo aggiungere risposte, mai togliere.
   */
  if (!vive.length && gens !== gensTutte) {
    voci = await apri(gensTutte);
    vive = voci.filter(m => (!cvN || m.hp == null || Math.abs(m.hp - cvN) <= 3)
                         && (!fam || !carbDiverso(fam, FAM_CARB(m.fuel)))
                         && (auto == null || AUTOM_ETI.test(m.label || '') === auto));
    const visti2 = new Set();
    vive = vive.filter(m => { const k = m.url; if (visti2.has(k)) return false; visti2.add(k); return true; });
  }
  if (!vive.length) return { ok: false, motivo: 'nessuna motorizzazione del catalogo combacia con ' + (usati.join(' e ') || 'questo annuncio') };

  /**
   * DUE VINCOLI IN PIU', E OGNUNO SI IGNORA SE SVUOTA.
   *
   * La cilindrata e la sigla-motore stanno nell'annuncio ma non nei campi: la prima nel campo
   * nativo di Autoscout o dentro la versione ("1.6 TDI Highline"), la seconda nel titolo
   * ("320d"). Sono complementari per marca, ed e' per questo che valgono solo insieme —
   * misurato su 117 annunci: la cilindrata da sola non guadagna NIENTE (i cavalli hanno gia'
   * fatto quel lavoro), la sigla porta 19 riconoscimenti a 27, tutti e tre insieme a 39.
   *
   * La regola dello scarto e' quella di sempre e qui vale come garanzia: un filtro che
   * azzererebbe le candidate viene ignorato, quindi nessun annuncio che oggi si riconosce
   * puo' peggiorare — un vincolo puo' solo togliere candidate, e se le toglie tutte non conta.
   */
  const stringi = (v, f) => { const q = v.filter(f); return q.length ? q : v; };
  // La cilindrata: dal campo nativo (Autoscout la manda in cm³) o dal testo della versione.
  const cc = (Number(cilindrata) > 300 ? Math.round(Number(cilindrata) / 100) / 10 : null)
    || litri(variante) || litri(titolo);
  if (cc) vive = stringi(vive, m => { const c = litri(m.label); return c == null || Math.abs(c - cc) < 0.05; });
  const sg = sigleMotore(`${titolo || ''} ${variante || ''}`);
  if (sg.length) vive = stringi(vive, m => sg.some(s => String(m.label || '').toLowerCase().includes(s)));

  /**
   * LA GENERAZIONE, quando le candidate sono tutte la stessa. Scegliere fra due
   * motorizzazioni sarebbe tirare a indovinare; aprire la generazione che TUTTE
   * condividono non lo e' — e salta una griglia da decine di voci.
   */
  const gs = [...new Set(vive.map(m => m.genSlug).filter(Boolean))];

  /**
   * QUANDO LE CANDIDATE SONO LO STESSO MOTORE.
   *
   * Misurato: delle 78 volte in cui restano piu' candidate, in 50 (il 64%) hanno cilindrata,
   * potenza e carburante IDENTICI — "1.9 TDI 105 Hp DSG", "1.9 TDI 105 Hp manual 6 speed",
   * "1.9 TDI 105 Hp manual 5 speed". Quattordici righe per un motore solo, che si distinguono
   * per cambio, trazione e sigle commerciali (bmt, bluemotion). E la distinzione l'annuncio non
   * la porta: nessun venditore scrive "manual 5 speed".
   *
   * Quindi non si sceglie e non si mostra un elenco muto: si DICE che il motore e' quello, e si
   * dice cosa resta da distinguere. Il motore e' identificato, l'allestimento no, e la
   * differenza fra le due cose e' esattamente quello che chi guarda deve sapere.
   */
  let stessoMotore = null;
  if (vive.length > 1) {
    const chiave = m => `${litri(m.label) || ''}|${m.hp || ''}|${norm(m.fuel || '')}`;
    if (new Set(vive.map(chiave)).size === 1) {
      const parole = l => String(l || '').toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
      const insiemi = vive.map(m => parole(m.label));
      const comuni = insiemi[0].filter(w => insiemi.every(t => t.includes(w)));
      const differenze = [...new Set(vive.map(m => parole(m.label).filter(w => !comuni.includes(w)).join(' ')).filter(Boolean))];
      // Il nome del motore si scrive come lo scrive il catalogo ("1.9 TDI 105 Hp"), non
      // minuscolo: la lista di parole comuni serve al confronto, non alla lettura.
      const suo = String(vive[0].label || '').split(/[^A-Za-z0-9.]+/).filter(Boolean);
      stessoMotore = {
        quante: vive.length,
        motore: suo.filter(w => comuni.includes(w.toLowerCase())).join(' ') || (vive[0].label || ''),
        cv: vive[0].hp || null,
        carburante: vive[0].fuel || null,
        differenze: differenze.slice(0, 8),
      };
    }
  }

  return {
    ok: true,
    stessoMotore,
    source: base.source,
    genUnica: gs.length === 1 ? gs[0] : null,
    scelta: vive.length === 1 ? vive[0] : null,
    candidate: vive.length === 1 ? [] : vive.slice(0, 40),
    perche: vive.length === 1
      ? 'unica del catalogo compatibile con ' + (usati.join(' e ') || 'questo modello') + ' dichiarati nell\'annuncio'
      : vive.length + ' motorizzazioni compatibili: scegli tu',
  };
}

function mount(app, deps = {}) {
  const clientIp = deps.clientIp || (req => req.ip || '');
  // La scheda tecnica DI QUESTO ANNUNCIO — vedi schedaPerAnnuncio.
  app.get('/api/scheda-veicolo/annuncio', async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste.' });
    const { tipo, marca, modello, anno, cv, carburante, cambio, carrozzeria } = req.query || {};
    // Il titolo dell'annuncio serve SOLO alle moto: e' da li' che si legge la variante
    // ("ABS", "Moto Cage", "Rally"), l'unica cosa che il periodo di produzione non separa.
    const titolo = String((req.query || {}).titolo || '').slice(0, 120);
    // La versione e la cilindrata dichiarate dall'annuncio: servono ai due vincoli in piu'
    // (cilindrata e sigla-motore), che sulle auto valgono solo insieme alla generazione.
    const variante = String((req.query || {}).variante || '').slice(0, 120);
    const cilindrata = String((req.query || {}).cilindrata || '').slice(0, 8);
    if (!marca || !modello) return res.status(400).json({ error: 'marca/modello mancanti' });
    const key = `ann:${tipo}|${norm(marca)}|${norm(modello)}|${anno || ''}|${cv || ''}|${norm(carburante)}|${norm(cambio)}|${norm(carrozzeria)}|${norm(titolo)}|${norm(variante)}|${cilindrata}`;
    const hit = cacheGet(key); if (hit != null) return res.json(hit);
    try {
      const out = await schedaPerAnnuncio({ tipo, marca, modello, anno, cv, carburante, cambio, carrozzeria, titolo, variante, cilindrata });
      cacheSet(key, out, out.ok ? PAGE_TTL : EMPTY_TTL);
      res.json(out);
    } catch (_) { res.json({ ok: false, motivo: 'scheda non disponibile' }); }
  });
  app.get('/api/scheda-veicolo', async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste.' });
    const { tipo, marca, modello, anno, gen } = req.query || {};
    if (!marca || !modello) return res.status(400).json({ error: 'marca/modello mancanti' });
    try {
      const out = await resolveScheda({ tipo, marca, modello, anno, genSlug: gen });
      if (out.unsupported) return res.json({ ok: false, unsupported: true });
      if (out.notFound) return res.json({ ok: false, notFound: out.notFound });
      res.json({ ok: true, ...out });
    } catch (_) { res.json({ ok: false, error: 'scheda non disponibile' }); }
  });
  app.get('/api/scheda-veicolo/specs', async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste.' });
    const url = String(req.query.url || '');
    const kind = specsHostKind(url);
    if (!kind) return res.status(400).json({ error: 'url non valido' });
    const key = 'specs:' + url;
    const hit = cacheGet(key); if (hit != null) return res.json(hit);
    try {
      const specs = kind === 'motoit' ? await mis.fetchMotoitSpecs(url)
        : kind === 'moto' ? await ms.fetchMotoSpecs(url)
        : await vs.fetchVehicleSpecs(url);
      const data = { ok: true, ...specs };
      cacheSet(key, data, SPEC_TTL); res.json(data);
    } catch (_) { const data = { ok: false, error: 'specifiche non disponibili' }; cacheSet(key, data, EMPTY_TTL); res.json(data); }
  });
}

module.exports = { mount, resolveScheda, schedaPerAnnuncio, matchModel, matchMotoModels, resolveMoto,
  // Puri e provabili senza rete: la pulizia del nome (la usa anche la rotta cerchi) e la
  // lettura della generazione dichiarata nel nome Subito.
  senzaGenerazione, generazioneDichiarata, famigliaMotoit };
