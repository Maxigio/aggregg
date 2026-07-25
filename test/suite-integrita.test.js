'use strict';
/**
 * INTEGRITA' DELLA SUITE — difende dal fallimento che non si vede.
 *
 * Scoperto il 2026-07-25 provando a rompere il codice apposta: se un file di test non riesce a
 * CARICARSI (un require che punta a un simbolo rinominato, un modulo spostato), `node --test`
 * stampa lo stack ma dichiara «pass 1, fail 0» ed esce con codice 0. Misurato sia sul singolo
 * file sia sulla suite intera. Conseguenza: un refactor puo' cancellare in silenzio un intero
 * file di test, e nessun segnale lo dice — ne' i contatori ne' l'uscita del processo.
 *
 * Qui si chiude il buco da fuori: si caricano tutti i moduli del backend e tutte le dipendenze
 * dichiarate dai file di test. Se qualcosa non si carica, il rosso appare QUI, dove si vede.
 *
 * Non sostituisce i test: garantisce che i test esistano ancora.
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
  const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js'));
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
