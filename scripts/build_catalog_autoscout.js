/**
 * Costruisce data/catalog_autoscout.json — catalogo NATIVO completo di Autoscout24.
 * Scarica TUTTI i make e per ognuno TUTTI i models + modelLines + totale annunci.
 *
 * Tassonomia AS24 (nativa, non derivata da Subito):
 *   catalog_autoscout.auto[brandLabel] = {
 *     makeId: number,
 *     slugAS: string,                 // slug path (es. "fiat", "alfa-romeo")
 *     totalAnnunci: number,           // numberOfResults sul brand
 *     models:    [{ modelId, label, modelLineId }],
 *     modelLines:[{ modelLineId, label, name }]   // solo auto: famiglie aggregate (Serie 3, Classe A)
 *   }
 *   catalog_autoscout.moto[brandLabel] = { ... stesso schema, modelLines quasi sempre vuoto }
 *
 * URL usato: /lst?atype=C|B&cy=I&mmmv={makeId}|||  (a prova di slug mancante)
 *
 * Uso: node scripts/build_catalog_autoscout.js
 */

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');
const { HEADERS, extractNextData, toSlug } = require('../backend/scrapers/utils');

const BASE = 'https://www.autoscout24.it';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RATE_LIMIT_MS = 400;

async function fetchUrl(url, attempt = 1) {
  try {
    const res = await axios.get(url, { headers: HEADERS, maxRedirects: 5, timeout: 20000 });
    return res.data;
  } catch (err) {
    if (attempt < 3 && (err.code === 'ECONNRESET' || err.response?.status >= 500)) {
      await sleep(1500);
      return fetchUrl(url, attempt + 1);
    }
    throw err;
  }
}

/**
 * Scarica una pagina AS24 e restituisce pageProps per analisi.
 * Funziona sia per auto (atype=C) sia per moto (atype=B).
 */
async function fetchTaxonomyPage(atype, mmmv = null) {
  const qs = new URLSearchParams({ atype, cy: 'I' });
  if (mmmv) qs.set('mmmv', mmmv);
  const url = `${BASE}/lst?${qs.toString()}`;
  const html = await fetchUrl(url);
  const nd = extractNextData(html);
  if (!nd) throw new Error(`__NEXT_DATA__ mancante: ${url}`);
  return nd.props.pageProps;
}

async function fetchAllMakes(atype) {
  // Una qualsiasi pagina brand contiene la lista completa makes.
  // Usiamo un brand "sicuro" per atype: Fiat(28) per auto, KTM(50060) per moto.
  const seedMmmv = atype === 'C' ? '28|||' : '50060|||';
  const pp = await fetchTaxonomyPage(atype, seedMmmv);
  return pp.taxonomy?.makes || {};
}

async function fetchBrandTaxonomy(makeId, atype) {
  const pp = await fetchTaxonomyPage(atype, `${makeId}|||`);
  return {
    totalAnnunci: pp.numberOfResults || 0,
    models:     pp.taxonomy?.models?.[makeId]     || [],
    modelLines: pp.taxonomy?.modelLines?.[makeId] || [],
  };
}

async function buildCatalogForType(atype, label) {
  console.log(`\n=== ${label} (atype=${atype}) ===`);
  const makes = await fetchAllMakes(atype);
  const entries = Object.entries(makes)
    .map(([id, v]) => ({ makeId: parseInt(id, 10), label: v.label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  console.log(`Trovati ${entries.length} brand nel dropdown AS24.`);

  const catalog = {};
  let i = 0;
  for (const { makeId, label: brandLabel } of entries) {
    i++;
    process.stdout.write(`  [${String(i).padStart(3)}/${entries.length}] ${brandLabel.padEnd(28)} `);
    try {
      const { totalAnnunci, models, modelLines } = await fetchBrandTaxonomy(makeId, atype);
      catalog[brandLabel] = {
        makeId,
        slugAS: toSlug(brandLabel),
        totalAnnunci,
        models: models.map(m => ({
          modelId:     m.value,
          label:       m.label,
          modelLineId: m.modelLineId ?? null,
        })),
        modelLines: modelLines.map(l => ({
          modelLineId: l.id,
          label:       l.label,
          name:        l.name,
        })),
      };
      console.log(`✓ ${totalAnnunci.toString().padStart(6)} annunci | ${String(models.length).padStart(3)} models | ${String(modelLines.length).padStart(2)} lines`);
    } catch (err) {
      console.log(`✗ ERR: ${err.message}`);
    }
    await sleep(RATE_LIMIT_MS);
  }
  return catalog;
}

(async () => {
  const catalog = {
    generatedAt: new Date().toISOString(),
    auto: await buildCatalogForType('C', 'AUTO'),
    moto: await buildCatalogForType('B', 'MOTO'),
  };

  const outPath = path.join(__dirname, '../data/catalog_autoscout.json');
  fs.writeFileSync(outPath, JSON.stringify(catalog, null, 2), 'utf8');

  const autoTot = Object.values(catalog.auto).reduce((a, b) => a + b.models.length, 0);
  const motoTot = Object.values(catalog.moto).reduce((a, b) => a + b.models.length, 0);
  console.log(`\n✅ Salvato in data/catalog_autoscout.json`);
  console.log(`   Auto: ${Object.keys(catalog.auto).length} brand, ${autoTot} modelli`);
  console.log(`   Moto: ${Object.keys(catalog.moto).length} brand, ${motoTot} modelli`);
})().catch(err => {
  console.error('ERRORE FATALE:', err);
  process.exit(1);
});
