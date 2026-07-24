'use strict';
// Route on-demand "scheda tecnica veicolo": auto-data.net (auto) + ultimatespecs.com (moto).
// mount(app, { clientIp }).
//  GET /api/scheda-veicolo?tipo&marca&modello&anno?&gen?     → generazioni/anni + voci (dropdown)
//  GET /api/scheda-veicolo/specs?url=<auto-data.net|ultimatespecs.com>  → specifiche della voce
const fs = require('fs');
const path = require('path');
const { norm } = require('./scrapers/brand-match');
const vs = require('./scrapers/vehicle-specs');
const ms = require('./scrapers/moto-specs');

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
// specs URL → quale parser usare (o null se host non consentito, anti-SSRF)
function specsHostKind(url) { if (HOST_OK_AUTO.test(url)) return 'auto'; if (HOST_OK_MOTO.test(url)) return 'moto'; return null; }
// nome modello senza gli anni finali ("Golf 1974 -" → "Golf", "A3 2003 -" → "A3") per display E match
const cleanName = n => String(n).replace(/\s+(19|20)\d{2}\s*(-\s*((19|20)\d{2})?)?\s*$/, '').trim() || String(n);

// Match modello SICURO: esatto-normalizzato, altrimenti la query è PREFISSO del candidato
// (golf → golf1974). NON il contrario → evita falsi positivi tipo "classea" → "cla".
function matchModel(models, query) {
  const q = norm(query);
  if (!q) return null;
  const items = models.map(m => ({ n: norm(cleanName(m.name)), m })).filter(x => x.n);
  const exact = items.find(x => x.n === q);
  if (exact) return exact.m;
  if (q.length >= 3) {
    const pref = items.filter(x => x.n.length >= 3 && x.n.startsWith(q));
    if (pref.length) { pref.sort((a, b) => a.n.length - b.n.length); return pref[0].m; }
  }
  return null;
}

// ── Moto (ultimatespecs) ─────────────────────────────────────────────────────
// Match modello moto: esatto-normalizzato + varianti (chiave che estende q con un
// carattere NON numerico → "mt07" pesca mt07/mt07abs/mt07tr, ma non "r1"→"r15").
function matchMotoModels(models, query) {
  const q = norm(query);
  if (!q) return [];
  const out = [];
  for (const k of Object.keys(models)) {
    if (k === q || (k.startsWith(q) && k.length > q.length && !/\d/.test(k[q.length]))) out.push({ k, ...models[k] });
  }
  out.sort((a, b) => a.k.length - b.k.length);   // base (chiave più corta) primo
  return out;
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
  const baseLabel = matched[0].label;
  return {
    title: `${brand.name} ${baseLabel}`, marca: brand.name, modello: baseLabel,
    generations: [], gen: { name: `${brand.name} ${baseLabel}`, slug: '' },
    motorizzazioni: entries.map(e => ({ label: e.label, url: e.url, year: e.year })),
    source: 'ultimatespecs.com',
  };
}

// marca+modello(+anno|gen) → { title, marca, modello, generations[], gen, motorizzazioni[] }
async function resolveScheda({ tipo, marca, modello, anno, genSlug }) {
  if (tipo === 'moto') return resolveMoto({ marca, modello, anno });
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

function mount(app, deps = {}) {
  const clientIp = deps.clientIp || (req => req.ip || '');
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
      const specs = kind === 'moto' ? await ms.fetchMotoSpecs(url) : await vs.fetchVehicleSpecs(url);
      const data = { ok: true, ...specs };
      cacheSet(key, data, SPEC_TTL); res.json(data);
    } catch (_) { const data = { ok: false, error: 'specifiche non disponibili' }; cacheSet(key, data, EMPTY_TTL); res.json(data); }
  });
}

module.exports = { mount, resolveScheda, matchModel, matchMotoModels, resolveMoto };
