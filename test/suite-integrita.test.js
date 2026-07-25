'use strict';
/**
 * INTEGRITA' DELLA SUITE — garantisce che i test esistano ancora.
 *
 * CORREZIONE DEL 2026-07-26. La prima versione di questo commento diceva che `node --test` esce
 * con codice 0 quando un file di test non riesce a CARICARSI. E' FALSO, ed era una misura
 * sbagliata: l'exit code letto veniva da un `| tail` in coda al comando, non da node. Rimisurato
 * su node v26.4.0 senza pipe — require di modulo inesistente, throw dopo la registrazione, sia
 * sul singolo file sia sulla suite intera — l'uscita e' sempre 1. Il fallimento al load si vede.
 * (Un granello di verita' resta: dentro `describe` i CONTATORI possono dire «pass 0, fail 0».
 * L'uscita del processo no, ed e' l'unica cosa che npm test guarda.)
 *
 * PERCHE' IL FILE RESTA, per un motivo diverso da quello scritto prima: dodici moduli del
 * backend non sono richiesti da NESSUN test e sono coperti solo qui — fra cui auth.js,
 * catalogo-route.js, db/index.js, normalize.js, utils.js, web-parts.js. Se uno prende un errore
 * di sintassi o un require morto, senza il primo test qui sotto la suite resta verde. E' uno
 * smoke test sul caricamento, e costa circa un secondo.
 *
 * Il secondo test (dipendenze dei file di test) e' piu' debole: i file che le usano falliscono
 * gia' da soli al load. Serve pero' a scoprire subito QUALE simbolo e' sparito, senza leggere
 * lo stack di un altro file.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const RADICE = path.join(__dirname, '..');

function tuttiJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : tuttiJs(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test('ogni modulo del backend si carica', () => {
  const mods = tuttiJs(path.join(RADICE, 'backend'));
  assert.ok(mods.length > 40, `attesi molti moduli, trovati ${mods.length}: il conteggio e' crollato?`);
  const ko = [];
  for (const m of mods) {
    try { require(m); } catch (e) { ko.push(`${path.relative(RADICE, m)} → ${e.message}`); }
  }
  assert.deepStrictEqual(ko, [], 'moduli che non si caricano');
});

test('ogni dipendenza dichiarata dai file di test si risolve', () => {
  // Si caricano le DIPENDENZE dei file di test, non i file stessi (li ri-registrerebbe).
  // E' la difesa diretta: se un backend cambia nome, qui diventa rosso invece di far sparire
  // in silenzio il file che lo usava.
  // Ricorsivo: senza, un file spostato in test/unit/ sparisce dal conteggio E dall'esecuzione
  // (il glob di package.json e' anch'esso ricorsivo, per la stessa ragione).
  const files = fs.readdirSync(__dirname, { recursive: true }).map(String).filter(f => f.endsWith('.test.js'));
  assert.ok(files.length >= 30, `attesi almeno 30 file di test, trovati ${files.length}`);
  const ko = [];
  for (const f of files) {
    const testo = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of testo.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
      const rel = m[1];
      if (/fixtures\//.test(rel)) continue;          // le fixture le prova gia' il test che le usa
      try { require(path.resolve(__dirname, rel)); }
      catch (e) { ko.push(`${f} richiede ${rel} → ${e.message}`); }
    }
  }
  assert.deepStrictEqual(ko, [], 'dipendenze di test non risolvibili');
});

test('richiedere server.js resta senza effetti collaterali', () => {
  // Se qualcuno rimettesse app.listen incondizionato, l'intera suite aprirebbe una porta e
  // scalderebbe due browser headless a ogni esecuzione.
  const srv = require('../backend/server');
  assert.strictEqual(srv.server, null,
    'server.js si e\' rimesso in ascolto al require: rimetti la guardia require.main === module');
});
