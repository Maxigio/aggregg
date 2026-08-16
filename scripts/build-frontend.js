'use strict';
/**
 * Minify del frontend servito (Q2 protezione codice): toglie COMMENTI + spazi da
 * `app.js`/`style.css` PRIMA di servirli → i commenti italiani che spiegano la
 * logica non finiscono nel browser. Il sorgente resta intatto (commentato).
 *
 * NB: `minifyIdentifiers:false` di proposito — l'app usa nomi-funzione GLOBALI
 * (es. `doSearch`, `renderResults` su window, handler inline) → rinominarli
 * romperebbe tutto. Togliamo solo commenti+spazi, NON rinominiamo. Niente
 * sourcemap (riesporrebbe il sorgente). esbuild è già dipendenza (worker-bundle).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FE = path.join(__dirname, '../frontend');

function buildFrontendSync() {
  // Dentro la funzione, non in cima: esbuild e' una devDependency e nel
  // pacchetto Electron NON c'e'. A livello di modulo questo require ammazzava il boot
  // a server.js:14, PRIMA del try/catch che dichiara "minify fallita → servo i sorgenti".
  const esbuild = require('esbuild');
  const jsSrc  = fs.readFileSync(path.join(FE, 'app.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(FE, 'style.css'), 'utf8');
  const js = esbuild.transformSync(jsSrc, {
    loader: 'js', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, legalComments: 'none',
  }).code;
  const css = esbuild.transformSync(cssSrc, { loader: 'css', minify: true, legalComments: 'none' }).code;
  const ver = crypto.createHash('sha256').update(js + css).digest('hex').slice(0, 12);
  return { js, css, ver };
}

module.exports = { buildFrontendSync };
