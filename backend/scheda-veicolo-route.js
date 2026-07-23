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
  try { INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch (_) { INDEX = { brands: {} }; }
  return INDEX;
}

const MOTO_INDEX_PATH = path.join(__dirname, '..', 'data', 'ultimatespecs-moto-index.json');
let MOTO_INDEX = null;
function loadMotoIndex() {
  if (MOTO_INDEX) return MOTO_INDEX;
  try { MOTO_INDEX = JSON.parse(fs.readFileSync(MOTO_INDEX_PATH, 'utf8')); } catch (_) { MOTO_INDEX = { brands: {}, host: ms.HOST }; }
  return MOTO_INDEX;
}

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
const BODY_VARIANT = /cabriolet|convertible|variant|estate|wagon|sportsvan|sportback|shooting|gran\b|\bplus\b|alltrack|allroad|cross|coupe|3-door|roadster|spider|touring|\blong\b|\b4x4\b|\b4wd\b/i;
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

// Ordina le generazioni best-first: carrozzeria BASE nell'anno cercato, poi varianti
// nell'anno, poi base fuori-anno, poi il resto (gens è già ordinata dal più recente).
function rankGens(gens, yr) {
  const inYear = g => g.years.length && yr && yr >= Math.min(...g.years) && yr <= Math.max(...g.years) + 2;
  const rank = g => (yr && inYear(g) ? 0 : 2) + (BODY_VARIANT.test(g.name) ? 1 : 0);
  return gens.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(x => x.g);
}
function pickGen(gens, yr) { return rankGens(gens, yr)[0]; }

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

// marca+modello → tutte le voci/anni della famiglia (dropdown), specifiche lazy via /specs.
function resolveMoto({ marca, modello }) {
  const idx = loadMotoIndex();
  const brand = idx.brands[norm(marca)];
  if (!brand) return { notFound: 'marca' };
  const matched = matchMotoModels(brand.models, modello);
  if (!matched.length) return { notFound: 'modello' };
  const host = idx.host || ms.HOST;
  const entries = [];
  for (const mo of matched) for (const [year, slug] of mo.items) {
    entries.push({ label: `${mo.label} · ${year}`, url: `${host}/motorcycles-specs/${brand.seg}/${slug}`, year });
  }
  entries.sort((a, b) => b.year - a.year || a.label.localeCompare(b.label));
  const baseLabel = matched[0].label;
  return {
    title: `${brand.name} ${baseLabel}`, marca: brand.name, modello: baseLabel,
    generations: [], gen: { name: `${brand.name} ${baseLabel}`, slug: '' },
    motorizzazioni: entries.map(e => ({ label: e.label, url: e.url })),
    source: 'ultimatespecs.com',
  };
}

// marca+modello(+anno|gen) → { title, marca, modello, generations[], gen, motorizzazioni[] }
async function resolveScheda({ tipo, marca, modello, anno, genSlug }) {
  if (tipo === 'moto') return resolveMoto({ marca, modello });
  if (tipo && tipo !== 'auto') return { unsupported: true };
  const idx = loadIndex();
  const brand = idx.brands[norm(marca)];
  if (!brand) return { notFound: 'marca' };
  // Nomi IT → EN per i pattern comuni (Serie 3 → 3 Series, Classe A → A-Class) su auto-data.net
  const candidates = [modello];
  let mm = /^serie\s+(.+)$/i.exec(modello); if (mm) candidates.push(mm[1] + ' Series');
  mm = /^classe\s+(.+)$/i.exec(modello); if (mm) { candidates.push(mm[1] + '-Class'); candidates.push(mm[1] + ' Class'); }
  let model = null;
  for (const q of candidates) { model = matchModel(Object.values(brand.models), q); if (model) break; }
  if (!model) return { notFound: 'modello' };

  const mp = await fetchCached(`${vs.HOST}/en/${model.slug}`, PAGE_TTL);
  const gens = vs.parseGenerationList(mp);
  if (!gens.length) return { notFound: 'generazione' };

  // Generazione esplicita (dropdown) → onorala. Altrimenti scorri le candidate best-first
  // e usa la PRIMA con motorizzazioni: salta le gen "fantasma" (es. Fiesta Van = 0 motori).
  let gen = genSlug ? gens.find(g => g.slug === genSlug) : null;
  let motorizzazioni = [];
  if (gen) {
    const gp = await fetchCached(`${vs.HOST}/en/${gen.slug}`, PAGE_TTL);
    motorizzazioni = vs.parseTrimList(gp, gen.slug);
  } else {
    for (const g of rankGens(gens, Number(anno) || null).slice(0, 4)) {   // cap 4 fetch (cache 12h)
      const gp = await fetchCached(`${vs.HOST}/en/${g.slug}`, PAGE_TTL);
      const trims = vs.parseTrimList(gp, g.slug);
      if (!gen) gen = g;   // fallback: prima candidata anche se vuota
      if (trims.length) { gen = g; motorizzazioni = trims; break; }
    }
  }
  const mName = cleanName(model.name);   // via anni dal nome
  return {
    title: `${brand.name} ${mName}`, marca: brand.name, modello: mName,
    generations: gens.map(g => ({ name: g.name, slug: g.slug })),
    gen: { name: gen.name, slug: gen.slug },
    motorizzazioni, source: 'auto-data.net',
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

module.exports = { mount, resolveScheda, matchModel, pickGen, matchMotoModels, resolveMoto };
