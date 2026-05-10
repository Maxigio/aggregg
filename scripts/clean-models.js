/**
 * Pulizia chirurgica one-shot di data/models.json (P1 redesign catalogo).
 *
 * Cosa rimuove:
 *  1. Voci moto con `slugMotoIt: "pagina-N"` (URL paginazione scrapate per errore).
 *  2. Voci con `kindAS: "modelLine"` (famiglie tipo "Serie 3", non varianti
 *     specifiche). Subito ?q= cercherebbe poco, AS24 è meglio servito da un
 *     mmmv per variante.
 *  3. Voci AUTO senza `mmmvAutoscout` (body-style solo-Subito tipo
 *     "Serie 3 Gran Turismo"). Per le MOTO le manteniamo: alcune moto sono
 *     valide solo via Moto.it (slug-based) e non hanno mappatura AS24.
 *
 * Cosa pulisce per ogni voce:
 *  - Rimuove campi obsoleti `slugSubito`, `subitoKey`, `brandKey` (non più
 *    usati: Subito cerca con ?q=marca+modello).
 *
 * Cosa pulisce per ogni brand:
 *  - Rimuove l'oggetto `subito` (era contenitore di slug/key, non più necessario).
 *  - Ricalcola `sites`: Subito è sempre disponibile via ?q=, autoscout/motoit
 *    dipendono dai relativi metadata di brand.
 *
 * Salva un backup `data/models.json.bak` prima di sovrascrivere.
 *
 * Uso:  node scripts/clean-models.js
 */

const fs   = require('fs');
const path = require('path');

const inPath  = path.join(__dirname, '../data/models.json');
const outPath = inPath;
const backup  = inPath + '.bak';

if (!fs.existsSync(inPath)) {
  console.error('ERRORE: ' + inPath + ' non trovato');
  process.exit(1);
}

console.log('Backup → ' + backup);
fs.copyFileSync(inPath, backup);

const sizeBefore = fs.statSync(inPath).size;
const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const stats = {
  auto:  { brands: 0, modelsBefore: 0, modelsAfter: 0 },
  moto:  { brands: 0, modelsBefore: 0, modelsAfter: 0 },
  removed: { paginaBug: 0, modelLine: 0, noMmmvAuto: 0 },
  fieldsCleaned: { slugSubito: 0, subitoKey: 0, brandKey: 0 },
};

for (const tipo of ['auto', 'moto']) {
  if (!data[tipo]) continue;
  for (const [brandName, brand] of Object.entries(data[tipo])) {
    stats[tipo].brands++;
    const before = (brand.models || []).length;
    stats[tipo].modelsBefore += before;

    brand.models = (brand.models || []).filter(m => {
      // 1. Voci paginazione moto (slugMotoIt: "pagina-N")
      if (m.slugMotoIt && /^pagina-\d+$/.test(m.slugMotoIt)) {
        stats.removed.paginaBug++;
        return false;
      }
      // 2. Voci modelLine (famiglie, non varianti)
      if (m.kindAS === 'modelLine') {
        stats.removed.modelLine++;
        return false;
      }
      // 3. Voci AUTO senza mmmvAutoscout (body-style solo-Subito ormai inutili)
      if (tipo === 'auto' && !m.mmmvAutoscout) {
        stats.removed.noMmmvAuto++;
        return false;
      }
      return true;
    });

    // Pulizia campi obsoleti per voce + ricalcolo sites
    brand.models.forEach(m => {
      if ('slugSubito' in m) { delete m.slugSubito; stats.fieldsCleaned.slugSubito++; }
      if ('subitoKey'  in m) { delete m.subitoKey;  stats.fieldsCleaned.subitoKey++;  }
      if ('brandKey'   in m) { delete m.brandKey;   stats.fieldsCleaned.brandKey++;   }
      // Ricalcola sites del modello: Subito sempre presente (ricerca testuale ?q=
      // funziona per qualsiasi nome). Manteniamo gli altri se presenti.
      const sites = new Set(['subito']);
      if (m.mmmvAutoscout) sites.add('autoscout');
      if (m.slugMotoIt)    sites.add('motoit');
      m.sites = [...sites];
    });

    // Pulisci metadata brand
    if ('subito' in brand) delete brand.subito;
    const newSites = ['subito'];
    if (brand.autoscout) newSites.push('autoscout');
    if (brand.motoit)    newSites.push('motoit');
    brand.sites = newSites;

    stats[tipo].modelsAfter += brand.models.length;
  }
}

fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
const sizeAfter = fs.statSync(outPath).size;

const fmtKB = b => (b / 1024).toFixed(0) + ' KB';
const pct   = (a, b) => b ? ((a - b) / b * 100).toFixed(1) + '%' : '–';

console.log('\n--- Cleaning report ---');
console.log(`AUTO  brands: ${stats.auto.brands}   models: ${stats.auto.modelsBefore} → ${stats.auto.modelsAfter}  (${pct(stats.auto.modelsAfter, stats.auto.modelsBefore)})`);
console.log(`MOTO  brands: ${stats.moto.brands}   models: ${stats.moto.modelsBefore} → ${stats.moto.modelsAfter}  (${pct(stats.moto.modelsAfter, stats.moto.modelsBefore)})`);
console.log(`Removed:  paginaBug=${stats.removed.paginaBug}  modelLine=${stats.removed.modelLine}  noMmmvAuto=${stats.removed.noMmmvAuto}`);
console.log(`Fields cleaned: slugSubito=${stats.fieldsCleaned.slugSubito}  subitoKey=${stats.fieldsCleaned.subitoKey}  brandKey=${stats.fieldsCleaned.brandKey}`);
console.log(`File size: ${fmtKB(sizeBefore)} → ${fmtKB(sizeAfter)}  (${pct(sizeAfter, sizeBefore)})`);
console.log(`Backup:    ${backup}`);
console.log(`Output:    ${outPath}`);
