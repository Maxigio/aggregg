/**
 * Unisce data/models.json (Subito, sorgente esistente) con
 * data/catalog_autoscout.json (AS24, catalogo nativo completo)
 * in un unico data/models.json con schema unificato.
 *
 * Regole di unione (confermate dall'utente):
 *   D1 = a: includiamo TUTTI i brand dei due siti. Brand presenti su un solo
 *           sito avranno sites=['subito'] o sites=['autoscout'] (badge UI).
 *   D2 = b: includiamo TUTTI i modelli. Modelli presenti su un solo sito
 *           avranno sites=['...'] (badge UI).
 *   D3 = a: se un modello è solo su Subito, il server non cercherà su AS24
 *           (la chiave mmmvAutoscout sarà assente).
 *
 * Matching: brand e modello matchano per "normalized key"
 *           (lowercase, no accenti, no caratteri non-alfanumerici).
 *
 * Output schema:
 * {
 *   generatedAt: ISO,
 *   auto: {
 *     "<Brand Display>": {
 *       sites: ["subito", "autoscout"],
 *       subito?:    { brandKey? },              // brandKey solo su moto
 *       autoscout?: { makeId, slugAS, totalAnnunci },
 *       models: [
 *         {
 *           nome: "<label display>",
 *           sites: ["subito","autoscout"],
 *           slugSubito?: string,                // chiave URL Subito (se presente su Subito)
 *           subitoKey?:  string,                // key numerica Subito moto (solo moto)
 *           mmmvAutoscout?: string,             // "makeId|modelId||" oppure "makeId||modelLineId|"
 *           modelIdAS?:     number,
 *           modelLineIdAS?: number,
 *           kindAS?:        "model" | "modelLine"
 *         }
 *       ]
 *     }
 *   },
 *   moto: { ... stesso schema ... }
 * }
 *
 * Uso: node scripts/merge_catalogs.js
 */

const fs   = require('fs');
const path = require('path');

const SUBITO_PATH = path.join(__dirname, '../data/models.json');
const AS24_PATH   = path.join(__dirname, '../data/catalog_autoscout.json');
const OUT_PATH    = path.join(__dirname, '../data/models.json');
const BACKUP_PATH = path.join(__dirname, '../data/models.subito-only.backup.json');

/** Identifica lo schema: legacy Subito-only (auto = array) vs nuovo unificato (auto[brand].models). */
function isUnifiedSchema(root) {
  const sample = Object.values(root.auto || {})[0];
  return sample && typeof sample === 'object' && !Array.isArray(sample) && Array.isArray(sample.models);
}

// Alias a livello di brand: nomi AS24 che vanno mappati al canonico Subito.
// Solo per brand che non matchano naturalmente per nome normalizzato.
const BRAND_ALIAS = {
  auto: {},
  moto: {
    zero: 'zeromotorcycles', // AS24 "Zero" ↔ Subito "Zero Motorcycles"
  },
};

function normKey(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // AS24 marca i modelLine aggregati con "(tutto)": es. "serie 3 (tutto)" → "Serie 3"
    .replace(/\s*\(tutto\)\s*/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function brandKey(s, tipo) {
  const k = normKey(s);
  return BRAND_ALIAS[tipo]?.[k] || k;
}

// Per i modelLine AS24 conviene anche tentare il match sul campo "name"
// (es. "3-Series" per auto BMW quando Subito lo chiama "Serie 3 3 Series").
function normKeyOf(obj, fields) {
  for (const f of fields) {
    if (obj && obj[f]) {
      const k = normKey(obj[f]);
      if (k) return k;
    }
  }
  return '';
}

function mergeTipo(tipo, subitoRoot, as24Root) {
  const subBrands = subitoRoot[tipo] || {};
  const asBrands  = as24Root[tipo]   || {};

  // indici case/spelling-insensitive (con alias di brand)
  const subNorm = new Map();
  for (const name of Object.keys(subBrands)) subNorm.set(brandKey(name, tipo), name);
  const asNorm = new Map();
  for (const name of Object.keys(asBrands)) asNorm.set(brandKey(name, tipo), name);

  const allBrandKeys = new Set([...subNorm.keys(), ...asNorm.keys()]);
  const out = {};

  for (const bk of allBrandKeys) {
    const subName = subNorm.get(bk) || null;
    const asName  = asNorm.get(bk)  || null;
    // Display: preferiamo il nome Subito (whitelist curata), fallback AS24
    const displayName = subName || asName;

    const sites = [];
    if (subName) sites.push('subito');
    if (asName)  sites.push('autoscout');

    const brandEntry = { sites };

    if (subName) {
      const sd = subBrands[subName];
      if (tipo === 'moto' && sd?.brandKey) {
        brandEntry.subito = { brandKey: sd.brandKey };
      } else {
        brandEntry.subito = {};
      }
    }
    if (asName) {
      const ad = asBrands[asName];
      brandEntry.autoscout = {
        makeId:       ad.makeId,
        slugAS:       ad.slugAS,
        totalAnnunci: ad.totalAnnunci,
      };
    }

    // Liste native
    const subModels = subName
      ? (tipo === 'moto' ? (subBrands[subName].models || []) : (subBrands[subName] || []))
      : [];
    const asModels  = asName ? (asBrands[asName].models     || []) : [];
    const asLines   = asName ? (asBrands[asName].modelLines || []) : [];
    const makeId    = asName ? asBrands[asName].makeId : null;

    // indici dei modelli
    const subModIdx = new Map();
    for (const m of subModels) subModIdx.set(normKey(m.nome), m);
    const asModIdx = new Map();
    for (const m of asModels)  asModIdx.set(normKey(m.label), m);
    const asLineIdx = new Map();
    for (const l of asLines)   asLineIdx.set(normKey(l.label), l);

    const allModelKeys = new Set([
      ...subModIdx.keys(),
      ...asModIdx.keys(),
      ...asLineIdx.keys(),
    ]);

    const models = [];
    for (const mk of allModelKeys) {
      const sM = subModIdx.get(mk)  || null;
      const aM = asModIdx.get(mk)   || null;
      const aL = asLineIdx.get(mk)  || null;

      const mSites = [];
      if (sM)          mSites.push('subito');
      if (aM || aL)    mSites.push('autoscout');

      // Display: Subito > AS24 model label > AS24 modelLine label
      const nome = sM?.nome || aM?.label || aL?.label;

      const entry = { nome, sites: mSites };

      if (sM) {
        if (sM.slugSubito) entry.slugSubito = sM.slugSubito;
        if (sM.subitoKey)  entry.subitoKey  = sM.subitoKey;
      }

      if (aM) {
        entry.mmmvAutoscout = `${makeId}|${aM.modelId}||`;
        entry.modelIdAS     = aM.modelId;
        if (aM.modelLineId != null) entry.modelLineIdAS = aM.modelLineId;
        entry.kindAS = 'model';
      } else if (aL) {
        // solo modelLine: il model specifico non esiste, usiamo la line (es. BMW Serie 3)
        entry.mmmvAutoscout = `${makeId}||${aL.modelLineId}|`;
        entry.modelLineIdAS = aL.modelLineId;
        entry.kindAS = 'modelLine';
      }

      models.push(entry);
    }

    models.sort((a, b) => a.nome.localeCompare(b.nome, 'it', { sensitivity: 'base' }));
    brandEntry.models = models;

    out[displayName] = brandEntry;
  }

  return out;
}

function stats(root, tipo) {
  const brands = root[tipo];
  const total = Object.keys(brands).length;
  const both = Object.values(brands).filter(b => b.sites.length === 2).length;
  const only = Object.values(brands).filter(b => b.sites.length === 1);
  const onlySub = only.filter(b => b.sites[0] === 'subito').length;
  const onlyAS  = only.filter(b => b.sites[0] === 'autoscout').length;
  const modelsTotal = Object.values(brands).reduce((a, b) => a + b.models.length, 0);
  const modelsBoth = Object.values(brands).reduce(
    (a, b) => a + b.models.filter(m => m.sites.length === 2).length, 0);
  const modelsOnlySub = Object.values(brands).reduce(
    (a, b) => a + b.models.filter(m => m.sites.length === 1 && m.sites[0] === 'subito').length, 0);
  const modelsOnlyAS = Object.values(brands).reduce(
    (a, b) => a + b.models.filter(m => m.sites.length === 1 && m.sites[0] === 'autoscout').length, 0);

  console.log(`\n${tipo.toUpperCase()}:`);
  console.log(`  Brand:   ${total}  (entrambi: ${both}, solo Subito: ${onlySub}, solo AS24: ${onlyAS})`);
  console.log(`  Modelli: ${modelsTotal}  (entrambi: ${modelsBoth}, solo Subito: ${modelsOnlySub}, solo AS24: ${modelsOnlyAS})`);
}

(function main() {
  const as24   = JSON.parse(fs.readFileSync(AS24_PATH,   'utf8'));

  // Il catalogo Subito legacy ha auto = array, moto = {brandKey, models: []}.
  // Se data/models.json è già stato unificato in un run precedente,
  // leggiamo il backup per non rileggere lo schema nuovo come input.
  let subito = JSON.parse(fs.readFileSync(SUBITO_PATH, 'utf8'));
  if (isUnifiedSchema(subito)) {
    if (!fs.existsSync(BACKUP_PATH)) {
      throw new Error(`models.json è già unificato ma il backup Subito non esiste: ${BACKUP_PATH}`);
    }
    subito = JSON.parse(fs.readFileSync(BACKUP_PATH, 'utf8'));
    console.log(`models.json già unificato: uso il backup come sorgente Subito (${BACKUP_PATH})`);
  } else if (!fs.existsSync(BACKUP_PATH)) {
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(subito, null, 2), 'utf8');
    console.log(`Backup Subito salvato in: ${BACKUP_PATH}`);
  } else {
    console.log(`Backup già presente (skip): ${BACKUP_PATH}`);
  }

  const merged = {
    generatedAt: new Date().toISOString(),
    auto: mergeTipo('auto', subito, as24),
    moto: mergeTipo('moto', subito, as24),
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`\nSalvato catalogo unificato in: ${OUT_PATH}`);

  stats(merged, 'auto');
  stats(merged, 'moto');

  // Spot-check
  console.log('\n── Spot-check ──────────────────────────────────');
  const fiat = merged.auto['Fiat'];
  console.log(`Fiat: sites=${JSON.stringify(fiat.sites)} | modelli=${fiat.models.length}`);
  const panda = fiat.models.find(m => m.nome.toLowerCase().includes('panda'));
  console.log(`  Panda esempio:`, JSON.stringify(panda));
  const bmw = merged.auto['BMW'];
  const serie3 = bmw?.models.find(m => /serie 3|3 series/i.test(m.nome));
  console.log(`  BMW Serie 3:`, JSON.stringify(serie3));
  const ktm = merged.moto['KTM'];
  console.log(`KTM moto: sites=${JSON.stringify(ktm?.sites)} | modelli=${ktm?.models.length}`);
})();
