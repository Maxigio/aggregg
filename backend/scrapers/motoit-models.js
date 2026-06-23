/**
 * Catalogo modelli/versioni Moto.it dall'**API JSON autorevole** (`api-50`).
 *
 * F43: il sito stesso usa queste API per popolare i menu Marca→Modello→Versione.
 *  - `GET /api-50/market/search/models/<brand>/Used`
 *      → { result:"OK", data:[ { value:"<brand>|<modelSlug>", text:"Modello" } ] }
 *      `value` = ESATTAMENTE il param `model=` del search.
 *  - `GET /api-50/market/search/bikes/<brand>|<model>/Used`
 *      → data:[ { value:"<codice 6char opaco>", text:"Versione (anni) - sigla" } ]
 *      `value` = ESATTAMENTE il param `bike=` (versione/allestimento).
 *
 * Niente più scrape HTML né slug indovinati: si usano i `value` reali dell'API.
 * Cache in-memory 12h per chiave + dedup richieste concorrenti.
 */
const https = require('https');
const { makeModelResolver } = require('./brand-match');

const BASE = 'https://www.moto.it';
const API  = `${BASE}/api-50/market/search`;
const TTL_MS = 12 * 60 * 60 * 1000;  // 12h

const modelsCache = new Map();   // brandSlug → { ts, models:[{name,slug}] }
const bikesCache  = new Map();   // `${brand}|${model}` → { ts, bikes:[{name,code}] }
const inflight    = new Map();   // chiave → Promise (dedup concorrenti)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// GET JSON con segui-redirect. L'API risponde a GET (verificato) — niente cookie.
function fetchJson(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Accept-Language': 'it-IT,it;q=0.9' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http') ? res.headers.location : BASE + res.headers.location;
        return fetchJson(next, hops + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('JSON non valido: ' + e.message)); } });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('timeout')));
  });
}

// Cache+dedup generico.
function cached(store, key, ttl, producer) {
  const hit = store.get(key);
  if (hit && Date.now() - hit.ts < ttl) return Promise.resolve(hit.value);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await producer();
      store.set(key, { ts: Date.now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** Modelli (famiglie) di una marca: [{name, slug}]. `slug` = parte dopo `<brand>|`. */
async function getBrandModels(brandSlug) {
  if (!brandSlug) return [];
  return cached(modelsCache, `m:${brandSlug}`, TTL_MS, async () => {
    try {
      const j = await fetchJson(`${API}/models/${encodeURIComponent(brandSlug)}/Used`);
      const data = (j && j.result === 'OK' && Array.isArray(j.data)) ? j.data : [];
      return data
        .map(d => {
          const value = String(d.value || '');
          const i = value.indexOf('|');
          const slug = i >= 0 ? value.slice(i + 1) : '';
          return slug ? { name: String(d.text || '').trim(), slug } : null;
        })
        .filter(Boolean);
    } catch (e) {
      console.warn(`[motoit-models] models ${brandSlug}: ${e.message}`);
      return [];
    }
  });
}

/** Versioni di un modello: [{name, code}]. `code` (opaco) = il param `bike=`. */
async function getModelBikes(brandSlug, modelSlug) {
  if (!brandSlug || !modelSlug) return [];
  const key = `b:${brandSlug}|${modelSlug}`;
  return cached(bikesCache, key, TTL_MS, async () => {
    try {
      const j = await fetchJson(`${API}/bikes/${encodeURIComponent(`${brandSlug}|${modelSlug}`)}/Used`);
      const data = (j && j.result === 'OK' && Array.isArray(j.data)) ? j.data : [];
      return data
        .map(d => { if (!d.value) return null; const name = String(d.text || '').trim(); return { name, code: String(d.value), ...parseYears(name) }; })
        .filter(Boolean);
    } catch (e) {
      console.warn(`[motoit-models] bikes ${brandSlug}|${modelSlug}: ${e.message}`);
      return [];
    }
  });
}

/**
 * Risolve uno slug-modello dal testo (retro-compat: crawler + runSearchCore fallback).
 * Match fuzzy SOLO tra i nomi reali dell'API (non slug inventati). null = brand-only.
 */
async function resolveMotoitModelSlug(brandSlug, modelloText) {
  if (!brandSlug || !modelloText) return null;
  const models = await getBrandModels(brandSlug);
  if (!models.length) return null;
  const resolver = makeModelResolver(models.map(m => ({ name: m.name, value: m.slug })));
  return resolver(modelloText) || null;
}

// ─── Lazy-T2: risoluzione voce-versione catalogo → famiglia Moto.it + versioni ──
// Es. "Dyna Fat Bob" (catalogo AS24, senza slug Moto.it) → famiglia "Dyna" + le bike
// "Fat Bob (anni)". Deterministico: la famiglia è la sequenza INIZIALE del nome-voce
// (la più lunga che combacia); il match è sul nome COSTRUITO "famiglia + versione",
// così "Sport Glide" non becca per errore la famiglia "Sport" (Sport non ha quel bike).
const normN = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// "Fat Bob (2014-17)" → "Fat Bob"; "1200 Iron (2018-20) - XL1200N" → "1200 Iron".
function versionBase(bikeName) {
  return String(bikeName || '').replace(/\([^)]*\)/g, ' ').replace(/\s*-\s*[A-Za-z0-9]+\s*$/, ' ').replace(/\s+/g, ' ').trim();
}
// "(2014 - 17)"/"(2008-13)"/"(2019)" → {annoMin, annoMax}.
function parseYears(bikeName) {
  const r = String(bikeName || '').match(/\((\d{4})\s*-\s*(\d{2,4})\)/);
  if (r) { const a = +r[1]; let b = +r[2]; if (b < 100) b = Math.floor(a / 100) * 100 + b; return { annoMin: a, annoMax: b }; }
  const s = String(bikeName || '').match(/\((\d{4})\)/);
  return s ? { annoMin: +s[1], annoMax: +s[1] } : { annoMin: null, annoMax: null };
}

/** "Dyna Fat Bob" → { familySlug:'dyna', familyName:'Dyna', versions:[{nome,code,annoMin,annoMax}] } | null. */
async function resolveMotoitVersionEntry(brandSlug, entryName) {
  if (!brandSlug || !entryName) return null;
  const families = await getBrandModels(brandSlug);
  const target = normN(entryName);
  // Confine famiglia: spazio ("Dyna Fat Bob") O lettera incollata ("V-Strom 1050SE" = 1050+se),
  // MAI una cifra (no falso "105"→"1050"). `target === nf` PRIMA: su esatto `next` è undefined.
  const cands = families
    .filter(f => {
      const nf = normN(f.name);
      if (!nf) return false;
      if (target === nf) return true;
      if (!target.startsWith(nf)) return false;
      const next = target[nf.length];
      return next === ' ' || /[a-z]/.test(next || '');
    })
    .sort((a, b) => normN(b.name).length - normN(a.name).length);
  for (const fam of cands) {
    const bikes = await getModelBikes(brandSlug, fam.slug);
    const toV = bk => ({ nome: bk.name, code: bk.code, annoMin: bk.annoMin, annoMax: bk.annoMax });
    const versionPart = target.slice(normN(fam.name).length).trim();   // "dyna fat bob" − "dyna" = "fat bob"
    // Voce = famiglia esatta (famiglia Moto.it senza slug nel catalogo) → tutte le sue bike.
    if (!versionPart) {
      if (bikes.length) return { familySlug: fam.slug, familyName: fam.name, versions: bikes.map(toV) };
      continue;
    }
    const versions = [];
    for (const bk of bikes) {
      const base = normN(versionBase(bk.name));
      // forma Harley: bike = sola versione ("1584 Fat Bob"→"fat bob"); forma Suzuki: bike RIPETE la
      // famiglia ("V-Strom 1050SE")→ match sul nome-voce intero (`base === target`).
      const bv = base.replace(/^\d{2,4}\s+/, '');
      if (bv === versionPart || base === target) versions.push(toV(bk));
    }
    if (versions.length) return { familySlug: fam.slug, familyName: fam.name, versions };
  }
  return null;
}

module.exports = { resolveMotoitModelSlug, getBrandModels, getModelBikes, resolveMotoitVersionEntry };
