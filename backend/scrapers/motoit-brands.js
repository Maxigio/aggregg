/**
 * Risoluzione nome-marca → slug REALE di Moto.it (fallback per marche non in
 * catalogo). Gli slug veri vivono in data/motoit-brands.json (harvest da
 * scripts/harvest-motoit-brands.js). Match via matcher condiviso: alias curati
 * (data/brand-aliases.json) + esatto-normalizzato. NIENTE contenimento (niente
 * slug inventati). Se la marca non è tra quelle reali → null (skip onesto).
 */
const brands = require('../../data/motoit-brands.json'); // [{ name, slug }]
const { makeResolver, loadAliasMap } = require('./brand-match');

const resolve = makeResolver(
  brands.map(b => ({ name: b.name, value: b.slug })),
  { alias: loadAliasMap('moto') }
);

/** Ritorna lo slug Moto.it reale per la marca, o null se non presente. */
function resolveMotoitSlug(marca) {
  return resolve(marca) || null;
}

module.exports = { resolveMotoitSlug, motoitBrands: brands };
