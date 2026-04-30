#!/usr/bin/env node
/**
 * Copia i file vendor (Bootstrap, TomSelect, noUISlider, jsPDF) da node_modules
 * a frontend/vendor/ in modo che l'app sia self-contained senza dipendere da CDN.
 *
 * Eseguito automaticamente come hook "postinstall" di npm.
 * Garantisce che l'app funzioni offline e senza restrizioni di rete (Electron).
 */
const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const VENDOR_DIR = path.join(ROOT, 'frontend', 'vendor');

// [sorgente in node_modules, nome file di destinazione in frontend/vendor/]
const FILES = [
  ['bootstrap/dist/css/bootstrap.min.css',                'bootstrap.min.css'],
  ['bootstrap/dist/js/bootstrap.bundle.min.js',           'bootstrap.bundle.min.js'],
  ['nouislider/dist/nouislider.min.css',                  'nouislider.min.css'],
  ['nouislider/dist/nouislider.min.js',                   'nouislider.min.js'],
  ['tom-select/dist/css/tom-select.bootstrap5.min.css',   'tom-select.bootstrap5.min.css'],
  ['tom-select/dist/js/tom-select.complete.min.js',       'tom-select.complete.min.js'],
  ['jspdf/dist/jspdf.umd.min.js',                        'jspdf.umd.min.js'],
  ['jspdf-autotable/dist/jspdf.plugin.autotable.min.js', 'jspdf.plugin.autotable.min.js'],
];

fs.mkdirSync(VENDOR_DIR, { recursive: true });

let ok = 0, errors = 0;
for (const [src, dest] of FILES) {
  const srcPath  = path.join(ROOT, 'node_modules', src);
  const destPath = path.join(VENDOR_DIR, dest);
  try {
    fs.copyFileSync(srcPath, destPath);
    console.log(`[bundle-vendor] ✓ ${dest}`);
    ok++;
  } catch (e) {
    console.error(`[bundle-vendor] ✗ ${dest}: ${e.message}`);
    errors++;
  }
}

if (errors > 0) {
  console.error(`[bundle-vendor] ${errors} errori — verifica che npm install sia completato.`);
  process.exit(1);
}
console.log(`[bundle-vendor] ✓ ${ok} file copiati in frontend/vendor/`);
