'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeResolver, makeModelResolver } = require('../backend/scrapers/brand-match');

test('makeResolver: match esatto-normalizzato (case/accenti)', () => {
  const r = makeResolver([{ name: 'BMW', value: 'BMW' }, { name: 'Citroën', value: 'Citroen' }]);
  assert.strictEqual(r('bmw'), 'BMW');
  assert.strictEqual(r('Citroen'), 'Citroen');   // accento normalizzato
});

test('makeResolver: NIENTE contenimento (no falsi match cross-brand)', () => {
  const r = makeResolver([{ name: 'Marshal Moto', value: 'Marshal' }, { name: 'Arctic Cat', value: 'Arctic' }]);
  assert.strictEqual(r('Mars'), null);   // "Mars" NON deve risolvere "Marshal"
  assert.strictEqual(r('Arc'), null);    // "Arc" NON deve risolvere "Arctic Cat"
});

test('makeResolver: alias risolve alla canonica', () => {
  const r = makeResolver([{ name: 'Betamotor', value: 'Betamotor' }], { alias: { beta: 'Betamotor' } });
  assert.strictEqual(r('Beta'), 'Betamotor');
  assert.strictEqual(r('betamotor'), 'Betamotor');
});

test('makeModelResolver: esatto + prefix bidirezionale', () => {
  const r = makeModelResolver([{ name: '320', value: 'm320' }, { name: 'Alp 4.0', value: 'alp40' }]);
  assert.strictEqual(r('320'), 'm320');          // esatto
  assert.strictEqual(r('320d'), 'm320');         // prefix (query più lunga)
  assert.strictEqual(r('alp 4.0'), 'alp40');     // normalizzazione punteggiatura/spazi
  assert.strictEqual(r('zz'), null);             // <3 char / nessun match
});
