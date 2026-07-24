'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { matchModel } = require('../backend/scheda-veicolo-route');

test('matchModel: esatto sul nome pulito dagli anni', () => {
  const models = [{ name: 'Golf 1974 -', slug: 'g' }];
  assert.strictEqual(matchModel(models, 'Golf').slug, 'g');
});

test('matchModel: nome corto (A3) via esatto', () => {
  const models = [{ name: 'A3 2003 -', slug: 'a3' }];
  assert.strictEqual(matchModel(models, 'A3').slug, 'a3');
});

test('matchModel: prefisso mono-direzionale — "Classe A" NON matcha "CLA"', () => {
  const models = [{ name: 'CLA', slug: 'cla' }];
  assert.strictEqual(matchModel(models, 'Classe A'), null);   // query non è prefisso del candidato
});

test('matchModel: query prefisso del candidato', () => {
  const models = [{ name: 'Golf 1974 -', slug: 'g' }];
  assert.strictEqual(matchModel(models, 'Gol').slug, 'g');
});

test('matchModel: a parità di prefisso vince il nome più corto', () => {
  const models = [{ name: 'Golf Plus', slug: 'plus' }, { name: 'Golf', slug: 'base' }];
  assert.strictEqual(matchModel(models, 'Golf').slug, 'base');   // esatto batte il prefisso più lungo
});
