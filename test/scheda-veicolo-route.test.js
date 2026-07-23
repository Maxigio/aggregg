'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { matchModel, pickGen } = require('../backend/scheda-veicolo-route');

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

test('pickGen: nell\'anno preferisce la carrozzeria base (no variante)', () => {
  const gens = [
    { name: 'Golf VII Variant', slug: 'v', years: [2013, 2020] },
    { name: 'Golf VII', slug: 'b', years: [2012, 2020] },
  ];
  assert.strictEqual(pickGen(gens, 2015).slug, 'b');
});

test('pickGen: sceglie la generazione che copre l\'anno', () => {
  const gens = [
    { name: 'Golf VII', slug: '7', years: [2012, 2020] },
    { name: 'Golf V', slug: '5', years: [2003, 2008] },
  ];
  assert.strictEqual(pickGen(gens, 2005).slug, '5');
});

test('pickGen: senza anno → base più recente (gens ordinata dal più recente)', () => {
  const gens = [
    { name: 'Golf VIII', slug: '8', years: [2019, 2024] },
    { name: 'Golf VII', slug: '7', years: [2012, 2020] },
  ];
  assert.strictEqual(pickGen(gens, null).slug, '8');
});

test('pickGen: tolleranza +2 anni oltre il fine-produzione (facelift)', () => {
  const gens = [{ name: 'Golf VII', slug: '7', years: [2012, 2020] }];
  assert.strictEqual(pickGen(gens, 2022).slug, '7');
});
