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

/**
 * LE AGGIUNTE CURATE (data/motoit-marche-aggiunte.json): marche che Moto.it ha — listino
 * verificato dal vivo — ma che mancano da ENTRAMBI gli elenchi qui sopra. Trovata con
 * Talaria: 5 modelli del menu con slugMotoIt validi e la marca dichiarata «non su
 * Moto.it», perche' lo slug vero e' 'talaria-moto' e nessun file lo sapeva. File assente
 * o illeggibile → nessuna marca in meno di prima.
 */
let aggiunte = [];
try {
  const agg = require('../../data/motoit-marche-aggiunte.json');
  aggiunte = (agg.voci || []).filter(v => v && v.name && v.slug).map(v => ({ name: v.name, slug: v.slug }));
} catch (_) { /* senza aggiunte resta l'unione di prima */ }

const resolve = makeResolver(
  [...brands, ...daCatalogo, ...aggiunte].map(b => ({ name: b.name, value: b.slug })),
  { alias: loadAliasMap('moto') }
);

/** Ritorna lo slug Moto.it reale per la marca, o null se non presente. */
function resolveMotoitSlug(marca) {
  return resolve(marca) || null;
}

module.exports = { resolveMotoitSlug, motoitBrands: brands };
