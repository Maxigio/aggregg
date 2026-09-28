'use strict';

const modelsData = require('../data/models.json');
const { makeResolver, loadAliasMap, norm } = require('./scrapers/brand-match');

// I resolver usano lo stesso catalogo delle rotte, così il nome canonico e i metadati
// provengono dalla stessa voce anche quando la marca digitata è un alias.
const catalogResolver = {
  auto: makeResolver(Object.entries(modelsData.auto || {}).map(([nome, entry]) => ({ name: nome, value: { nome, entry } })), { alias: loadAliasMap('auto') }),
  moto: makeResolver(Object.entries(modelsData.moto || {}).map(([nome, entry]) => ({ name: nome, value: { nome, entry } })), { alias: loadAliasMap('moto') }),
};
const lookupBrand = (tipo, marca) => catalogResolver[tipo]?.(marca) || null;

let modelGroups = { auto: {}, moto: {} };
try { modelGroups = require('../data/model-groups.json'); } catch (_) { /* opzionale */ }

function lookupModelGroup(tipo, brandName, modelText) {
  const brands = modelGroups[tipo];
  if (!brands || !brandName) return null;
  const g = brands[brandName];
  if (!g) return null;
  const q = norm(modelText);
  if (!q) return null;
  for (const [serie, membri] of Object.entries(g)) if (norm(serie) === q) return membri;
  return null;
}

module.exports = { catalogResolver, lookupBrand, lookupModelGroup };
