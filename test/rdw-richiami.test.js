'use strict';
/**
 * L'aggancio marca+modello dei richiami RDW.
 *
 * Il rischio qui non e' perdere una campagna: e' AGGANCIARNE UNA SBAGLIATA, cioe' dire a
 * un operatore che l'auto in piazzale ha un richiamo che riguarda un altro modello. Per
 * questo i casi che contano sono i falsi positivi, e stanno quasi tutti qui sotto.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { _combaciaModello: mod, _combaciaMarca: marca, cerca, stato } = require('../backend/scrapers/rdw-richiami');

test('modello: l\'ordine delle parole non conta ("Serie 3" ↔ "3 SERIE")', () => {
  assert.ok(mod(['3 SERIE'], 'Serie 3'));
  assert.ok(mod(['1 SERIE'], 'Serie 1'));
  // il tipo puo' essere piu' specifico del nome cercato: e' giusto che agganci
  assert.ok(mod(['3 SERIE GRAN TURISMO'], 'Serie 3'));
  assert.ok(mod(['MULTISTRADA V4 PIKES PEAK'], 'Multistrada'));
});

test('modello: spazi diversi, stessa moto ("Z900" ↔ "Z 900")', () => {
  assert.ok(mod(['Z 900'], 'Z900'));
  assert.ok(mod(['Z900'], 'Z 900'));
  assert.ok(mod(['MT-07'], 'MT 07'));
});

test('modello: MAI per sottostringa — sono i falsi positivi che fanno danno', () => {
  assert.ok(!mod(['500X'], '500'), '"500" non e\' una "500X"');
  assert.ok(!mod(['GSR125'], 'R12'), 'la sottostringa dentro un altro modello');
  assert.ok(!mod(['GOLFINO'], 'Golf'));
  assert.ok(!mod(['3 SERIE'], 'Serie 5'), 'stesse parole? no: il numero e\' diverso');
  assert.ok(!mod(['X3'], 'Serie 3'));
  assert.ok(!mod([], 'Golf'));
  assert.ok(!mod(['GOLF'], ''));
});

test('marca: normalizzata, senza contenimento', () => {
  assert.ok(marca(['MERCEDES-BENZ'], 'Mercedes Benz'));
  assert.ok(marca(['VOLKSWAGEN'], 'volkswagen'));
  assert.ok(!marca(['VOLKSWAGEN'], 'wagen'), 'un pezzo di nome non e\' la marca');
  assert.ok(!marca([], 'BMW'));
});

test('cerca: l\'anno si accetta ma NON filtra, e lo dichiara', () => {
  const s = stato();
  if (!s.pronto) return;   // senza archivio costruito non c'e' niente da provare
  const senza = cerca({ marca: 'Volkswagen', modello: 'Golf' });
  const con = cerca({ marca: 'Volkswagen', modello: 'Golf', anno: 2015 });
  assert.strictEqual(con.totale, senza.totale, 'la fonte non porta la finestra di produzione');
  assert.strictEqual(con.annoIgnorato, true, 'e deve dirlo a chi chiama');
  assert.strictEqual(senza.annoIgnorato, false);
});

test('cerca: ogni campagna trovata ha davvero un modello che combacia', () => {
  const s = stato();
  if (!s.pronto) return;
  for (const q of [{ marca: 'BMW', modello: 'Serie 3' }, { marca: 'Fiat', modello: '500' }, { marca: 'Toyota', modello: 'Yaris' }]) {
    const r = cerca(q);
    assert.ok(r.totale > 0, `${q.marca} ${q.modello}: nessuna campagna`);
    for (const c of r.campagne) {
      assert.ok(mod(c.modelli, q.modello), `campagna ${c.rif} agganciata senza un modello che combacia`);
      assert.ok(marca(c.marche, q.marca), `campagna ${c.rif} agganciata senza la marca`);
    }
  }
});

test('cerca: senza archivio risponde un motivo, non un elenco vuoto', () => {
  const s = stato();
  if (s.pronto) { assert.ok(s.campagne > 0 && s.marche > 0); return; }
  assert.strictEqual(cerca({ marca: 'BMW' }).ok, false);
});
