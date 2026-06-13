'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { norm, bucketAnno_v1, bucketKm_v1, modelKey } = require('../backend/model-key');

test('norm: lowercase, accenti, separatori', () => {
  assert.strictEqual(norm('Citroën'), 'citroen');
  assert.strictEqual(norm('Mercedes-Benz'), 'mercedes-benz');
  assert.strictEqual(norm('R 1250 GS'), 'r-1250-gs');
  assert.strictEqual(norm('  Serie 3 '), 'serie-3');
  assert.strictEqual(norm(null), '');
});

test('bucketAnno_v1: bande di 3 anni ancorate ai multipli di 3', () => {
  assert.strictEqual(bucketAnno_v1(2013), '2013-2015');
  assert.strictEqual(bucketAnno_v1(2015), '2013-2015');
  assert.strictEqual(bucketAnno_v1(2016), '2016-2018');
  assert.strictEqual(bucketAnno_v1(2024), '2022-2024');
  assert.strictEqual(bucketAnno_v1(null), 'na');
  assert.strictEqual(bucketAnno_v1(1800), 'na');
});

test('bucketKm_v1: fasce crescenti', () => {
  assert.strictEqual(bucketKm_v1(0), '0-15k');
  assert.strictEqual(bucketKm_v1(14999), '0-15k');
  assert.strictEqual(bucketKm_v1(15000), '15-30k');
  assert.strictEqual(bucketKm_v1(120000), '100-150k');
  assert.strictEqual(bucketKm_v1(149999), '100-150k');
  assert.strictEqual(bucketKm_v1(150000), '150-200k');
  assert.strictEqual(bucketKm_v1(250000), '200k+');
  assert.strictEqual(bucketKm_v1(null), 'na');
  assert.strictEqual(bucketKm_v1(-5), 'na');
});

test('modelKey: composizione completa con tipo davanti', () => {
  assert.strictEqual(modelKey('auto', 'BMW', '320d', 2015, 120000), 'auto|bmw|320d|2013-2015|100-150k');
  assert.strictEqual(modelKey('moto', 'BMW', 'R 1250 GS', 2021, 18000), 'moto|bmw|r-1250-gs|2019-2021|15-30k');
});

test('modelKey: null se manca marca o modello (no grouping ambiguo)', () => {
  assert.strictEqual(modelKey('auto', 'BMW', '', 2015, 1000), null);
  assert.strictEqual(modelKey('auto', '', 'Serie 3', 2015, 1000), null);
});

test('modelKey: anno/km mancanti → segmenti "na"', () => {
  assert.strictEqual(modelKey('auto', 'Fiat', 'Panda', null, null), 'auto|fiat|panda|na|na');
});
