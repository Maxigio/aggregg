/**
 * Risoluzione nome-marca → slug REALE di Moto.it (fallback per marche non in
 * catalogo). Gli slug veri vivono in data/motoit-brands.json (harvest da
 * scripts/harvest-motoit-brands.js). Match via matcher condiviso: alias curati
 * (data/brand-aliases.json) + esatto-normalizzato. NIENTE contenimento (niente
 * slug inventati). Se la marca non è tra quelle reali → null (skip onesto).
 */
const brands = require('../../data/motoit-brands.json'); // [{ name, slug }]
const { makeResolver, loadAliasMap } = require('./brand-match');

/**
 * L'UNIONE col catalogo locale: chi consuma un elenco di riferimento lo prende
 * dall'unione degli elenchi che il progetto gia' possiede. Misurato: due marche
 * (hyosung, 26 modelli; um-italia, 20) stanno in motoit-catalogo.json — cioe' la fonte
 * per quello slug HA risposto — e non in motoit-brands.json: il runtime dichiarava
 * «marca non su Moto.it», una ragione che i dati dell'app stessa smentivano. I cataloghi
 * in data/ non si toccano: l'unione si fa qui, per slug.
 */
let daCatalogo = [];
try {
  const cat = require('../../data/motoit-catalogo.json');
  const marche = cat.marche || cat;
  const noti = new Set(brands.map(b => String(b.slug).toLowerCase()));
  daCatalogo = Object.entries(marche)
    .filter(([slug]) => !noti.has(String(slug).toLowerCase()))
    .map(([slug, m]) => ({ name: (m && m.nome) || slug, slug }));
} catch (_) { /* senza catalogo locale resta l'elenco harvestato: nessuna marca in meno di prima */ }

const resolve = makeResolver(
  [...brands, ...daCatalogo].map(b => ({ name: b.name, value: b.slug })),
  { alias: loadAliasMap('moto') }
);

/** Ritorna lo slug Moto.it reale per la marca, o null se non presente. */
function resolveMotoitSlug(marca) {
  return resolve(marca) || null;
}

module.exports = { resolveMotoitSlug, motoitBrands: brands };
