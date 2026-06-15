'use strict';
/**
 * F11 — generatore di target CANDIDATI dal catalogo (modulo PURO, niente DB).
 *
 * Sorgente unica dei nuovi target = `data/models.json` (il DB conosce solo i
 * modelli che GIÀ crawliamo → non può proporre novità). Qui:
 *   1. appiattisce catalogo auto+moto → (tipo, marca, modello),
 *   2. SOTTRAE ciò che è già in watchlist (match normalizzato + alias VW↔Volkswagen),
 *   3. SCARTA i modelli morti (coverage 0 = su nessuna fonte),
 *   4. filtra per tipo/marca,
 *   5. ordina per COPERTURA fonti desc (subito+autoscout+moto.it), poi marca,modello.
 *
 * `coverage` è oggettivo e misurabile (presenza sulle fonti) — NON una classifica
 * di popolarità inventata.
 */
const { norm, loadAliasMap } = require('./scrapers/brand-match');

// Quante fonti coprono questo modello (0..3). Subito/AS24 via `sites` (+ modelIdAS
// come prova extra per AS24); Moto.it via slug modello risolto nel catalogo.
function coverage(model) {
  const sites = new Set(Array.isArray(model.sites) ? model.sites : []);
  let n = 0;
  if (sites.has('subito')) n++;
  if (sites.has('autoscout') || model.modelIdAS) n++;
  if (model.slugMotoIt) n++;
  return n;
}

// Nome canonico del brand per il confronto (alias → primo del gruppo), poi norm.
function canonKey(tipo, marca, modello, aliasMap) {
  const canon = aliasMap[norm(marca)] || marca;
  return `${tipo}|${norm(canon)}|${norm(modello)}`;
}

/**
 * @param catalog   data/models.json ({auto:{...}, moto:{...}})
 * @param existing  righe watchlist [{tipo,marca,modello}] da escludere
 * @param opts      {tipo?, marca?, limit=50, offset=0}
 * @returns {items:[{tipo,marca,modello,coverage,sites}], total}
 */
function candidates(catalog, existing, opts = {}) {
  const { tipo, marca, limit = 50, offset = 0 } = opts;
  const tipi = tipo ? [tipo] : ['auto', 'moto'];
  const aliasMaps = { auto: loadAliasMap('auto'), moto: loadAliasMap('moto') };

  // Set degli esistenti, normalizzato+canonicalizzato per tipo.
  const have = new Set();
  for (const e of (Array.isArray(existing) ? existing : [])) {
    if (!e || !e.tipo || !e.marca || !e.modello) continue;
    have.add(canonKey(e.tipo, e.marca, e.modello, aliasMaps[e.tipo] || {}));
  }

  const marcaQ = marca ? norm(marca) : null;
  const out = [];
  for (const tp of tipi) {
    const brands = catalog[tp] || {};
    const amap = aliasMaps[tp] || {};
    for (const brandName of Object.keys(brands)) {
      if (marcaQ && norm(brandName) !== marcaQ) continue;
      const entry = brands[brandName] || {};
      for (const model of (entry.models || [])) {
        if (!model || !model.nome) continue;
        const cov = coverage(model);
        if (cov === 0) continue;                                  // niente target morti
        const key = `${tp}|${norm(aliasMap1(amap, brandName))}|${norm(model.nome)}`;
        if (have.has(key)) continue;                              // già in watchlist
        out.push({ tipo: tp, marca: brandName, modello: model.nome, coverage: cov, sites: model.sites || [] });
      }
    }
  }
  // copertura desc, poi marca/modello alfabetico (stabile, neutro a parità).
  out.sort((a, b) => b.coverage - a.coverage
    || a.marca.localeCompare(b.marca) || a.modello.localeCompare(b.modello));

  const total = out.length;
  const items = out.slice(offset, offset + limit);
  return { items, total };
}

// Canonicalizza il nome brand del catalogo con la stessa aliasMap usata sugli
// esistenti → i due lati combaciano anche se il catalogo usa una variante.
function aliasMap1(amap, brandName) { return amap[norm(brandName)] || brandName; }

module.exports = { candidates, coverage, _canonKey: canonKey };
