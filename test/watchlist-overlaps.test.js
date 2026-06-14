'use strict';
// F6 — findOverlaps: pura, niente DB → sempre eseguito.
const { test } = require('node:test');
const assert = require('node:assert');
const { findOverlaps } = require('../backend/watchlist-overlaps');

const has = (pairs, ma, mb) => pairs.some(p =>
  (p.a.modello === ma && p.b.modello === mb) || (p.a.modello === mb && p.b.modello === ma));

test('substring: A4 ⊂ A4 Avant flaggato', () => {
  const o = findOverlaps([
    { id: 1, tipo: 'auto', marca: 'Audi', modello: 'A4' },
    { id: 2, tipo: 'auto', marca: 'Audi', modello: 'A4 Avant' },
  ]);
  assert.strictEqual(o.length, 1);
  assert.strictEqual(o[0].reason, 'substring');
});

test('NON flagga modelli distinti stesso brand (A1 vs A4)', () => {
  const o = findOverlaps([
    { id: 1, tipo: 'auto', marca: 'Audi', modello: 'A1' },
    { id: 2, tipo: 'auto', marca: 'Audi', modello: 'A4' },
  ]);
  assert.strictEqual(o.length, 0);
});

test('serie ⊇ membro: BMW Serie 3 ⊇ 320d / 318i', () => {
  const o = findOverlaps([
    { id: 1, tipo: 'auto', marca: 'BMW', modello: 'Serie 3' },
    { id: 2, tipo: 'auto', marca: 'BMW', modello: '320d' },
    { id: 3, tipo: 'auto', marca: 'BMW', modello: '318i' },
    { id: 4, tipo: 'auto', marca: 'BMW', modello: 'Serie 5' },
  ]);
  assert.ok(has(o, 'Serie 3', '320d'), 'Serie 3 ⊇ 320d');
  assert.ok(has(o, 'Serie 3', '318i'), 'Serie 3 ⊇ 318i');
  assert.ok(!has(o, 'Serie 5', '320d'), 'Serie 5 non c\'entra con 320d');
});

test('brand diversi non si incrociano (BMW i3 vs Hyundai i30)', () => {
  const o = findOverlaps([
    { id: 1, tipo: 'auto', marca: 'BMW', modello: 'i3' },
    { id: 2, tipo: 'auto', marca: 'Hyundai', modello: 'i30' },
  ]);
  assert.strictEqual(o.length, 0);
});

test('tipo diverso non si incrocia', () => {
  const o = findOverlaps([
    { id: 1, tipo: 'auto', marca: 'Honda', modello: 'SH' },
    { id: 2, tipo: 'moto', marca: 'Honda', modello: 'SH 125' },
  ]);
  assert.strictEqual(o.length, 0);
});
