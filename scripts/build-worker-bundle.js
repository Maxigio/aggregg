'use strict';
/**
 * F9 — costruisce il worker in UN file-bundle (esbuild) servito dal centrale ai nodi.
 *  - cheerio (+parse5 ecc., puro JS) finisce DENTRO il bundle → il nodo non installa npm.
 *  - playwright resta `external` (lazy/opzionale: sul nodo manca → l'errore è catturato
 *    in motoit → fallback browser saltato, il path HTTP-first cheerio funziona lo stesso).
 * Uso CLI: node scripts/build-worker-bundle.js   |   npm run build:worker
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUTFILE = path.join(ROOT, 'worker', 'dist', 'worker-bundle.js');

async function buildWorkerBundle() {
  const esbuild = require('esbuild');   // devDependency (solo iMac)
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'worker', 'worker.js')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: OUTFILE,
    external: ['playwright'],
  });
  return OUTFILE;
}

module.exports = { buildWorkerBundle, OUTFILE };

if (require.main === module) {
  buildWorkerBundle()
    .then(f => console.log('[build:worker] OK →', f))
    .catch(e => { console.error('[build:worker] FALLITO:', e.message); process.exit(1); });
}
