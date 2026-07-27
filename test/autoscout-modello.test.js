'use strict';
// Il modello dichiarato da AS24 contro quello cercato. Puro: niente rete.
const { test } = require('node:test');
const assert = require('node:assert');
const { combaciaModello } = require('../backend/scrapers/autoscout-graphql');

test('stesse parole in ordine diverso: AS24 scrive "390 Duke", l\'utente "Duke 390"', () => {
  assert.strictEqual(combaciaModello('390 Duke', 'Duke 390'), true);
  assert.strictEqual(combaciaModello('Duke 390', '390 Duke'), true);
});

test('uguale', () => {
  assert.strictEqual(combaciaModello('MT-07', 'MT-07'), true);
  assert.strictEqual(combaciaModello('SV 650', 'sv650'), true, 'lo spazio non conta');
});

test('AS24 piu granulare: "Bonneville T100" risponde a "Bonneville"', () => {
  assert.strictEqual(combaciaModello('Bonneville T100', 'Bonneville'), true);
});

test('e viceversa: "Bonneville" risponde a "Bonneville T100"', () => {
  assert.strictEqual(combaciaModello('Bonneville', 'Bonneville T100'), true);
});

test('modelli diversi → false, ed e\' il caso del ramo allargato', () => {
  assert.strictEqual(combaciaModello('Alp 250', 'R-12'), false);
  assert.strictEqual(combaciaModello('RR 50', 'R-12'), false);
  assert.strictEqual(combaciaModello('Monster 821', 'Scrambler 1100'), false);
});

test('NIENTE sottostringa: "r12" sta dentro "gsr125" ma sono due moto', () => {
  assert.strictEqual(combaciaModello('GSR 125', 'R 12'), false);
  assert.strictEqual(combaciaModello('R 1250 GS', 'R 125'), false);
});

test('"Altro" e\' il secchio catch-all di AS24: non decide, non marca', () => {
  assert.strictEqual(combaciaModello('Altro', 'Bonneville'), null);
  assert.strictEqual(combaciaModello('other', 'Bonneville'), null);
});

test('senza dato non si inventa un giudizio', () => {
  assert.strictEqual(combaciaModello(null, 'Bonneville'), null);
  assert.strictEqual(combaciaModello('MT-07', ''), null);
  assert.strictEqual(combaciaModello('', ''), null);
});
