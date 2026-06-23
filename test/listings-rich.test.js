'use strict';
// F50 Fase 1 — derivazione regione (pura, no DB). Verifica le 3 forme di provincia
// che le fonti producono: comune (Subito/AS24), sigla (Moto.it), CAP (AS24).
const test = require('node:test');
const assert = require('node:assert');
const { regioneFrom } = require('../backend/db/listings-repo');

test('regioneFrom: comune → regione (Subito/AS24)', () => {
  assert.equal(regioneFrom('Genova'), 'liguria');
  assert.equal(regioneFrom('Milano'), 'lombardia');
  assert.equal(regioneFrom('Torino'), 'piemonte');
});

test('regioneFrom: sigla provincia → regione (Moto.it)', () => {
  assert.equal(regioneFrom('BS'), 'lombardia');
  assert.equal(regioneFrom('RM'), 'lazio');
});

test('regioneFrom: CAP → regione (fallback AS24)', () => {
  assert.equal(regioneFrom(null, '10010'), 'piemonte');
});

test('regioneFrom: ignoto/vuoto → null (niente invenzioni)', () => {
  assert.equal(regioneFrom('Borgo Inesistente XYZ'), null);
  assert.equal(regioneFrom(null, null), null);
  assert.equal(regioneFrom(''), null);
});
