'use strict';
// F11 — candidate-targets è PURO (niente DB): sempre eseguito.
const { test } = require('node:test');
const assert = require('node:assert');
const { candidates, coverage } = require('../backend/candidate-targets');

const CAT = {
  auto: {
    Volkswagen: { models: [
      { nome: 'Golf', sites: ['subito', 'autoscout'], modelIdAS: 10 },   // cov 2
      { nome: 'Polo', sites: ['subito', 'autoscout'], modelIdAS: 11 },   // cov 2
      { nome: 'Fantasma', sites: [] },                                    // cov 0 → scartato
    ]},
    'Alfa Romeo': { models: [
      { nome: 'Giulia', sites: ['subito'] },                             // cov 1 (solo subito)
    ]},
  },
  moto: {
    Honda: { models: [
      { nome: 'SH 125', sites: ['subito', 'autoscout'], modelIdAS: 30, slugMotoIt: 'sh-125' }, // cov 3
    ]},
  },
};

test('coverage: conta subito + autoscout + moto.it (0..3)', () => {
  assert.strictEqual(coverage({ sites: ['subito', 'autoscout'], modelIdAS: 1, slugMotoIt: 'x' }), 3);
  assert.strictEqual(coverage({ sites: ['subito', 'autoscout'] }), 2);
  assert.strictEqual(coverage({ sites: ['subito'] }), 1);
  assert.strictEqual(coverage({ sites: [], modelIdAS: 9 }), 1);   // modelIdAS conta come autoscout
  assert.strictEqual(coverage({ sites: [] }), 0);
});

test('scarta i morti (coverage 0)', () => {
  const { items } = candidates(CAT, [], { tipo: 'auto', limit: 50 });
  assert.ok(!items.some(i => i.modello === 'Fantasma'), 'Fantasma (0 fonti) non deve comparire');
});

test('esclude ciò che è già in watchlist (match normalizzato: spazi/maiuscole)', () => {
  // "alfa romeo"/"giulia" minuscolo con spazio ≠ catalogo "Alfa Romeo" come stringa,
  // ma norm li rende uguali → escluso.
  const existing = [{ tipo: 'auto', marca: 'alfa romeo', modello: 'giulia' }];
  const { items } = candidates(CAT, existing, { tipo: 'auto', limit: 50 });
  assert.ok(!items.some(i => i.modello === 'Giulia'), 'Giulia già in watchlist (via norm) → escluso');
  assert.ok(items.some(i => i.modello === 'Golf'), 'Golf non in watchlist → resta candidato');
});

test('filtro tipo + marca', () => {
  const moto = candidates(CAT, [], { tipo: 'moto', limit: 50 });
  assert.ok(moto.items.every(i => i.tipo === 'moto'));
  const vw = candidates(CAT, [], { marca: 'volkswagen', limit: 50 });
  assert.ok(vw.items.every(i => i.marca === 'Volkswagen'));
});

test('ordina per copertura desc (moto.it cov3 prima)', () => {
  const { items } = candidates(CAT, [], { limit: 50 });
  assert.strictEqual(items[0].modello, 'SH 125', 'cov3 in cima');
  assert.strictEqual(items[0].coverage, 3);
  // copertura non crescente lungo la lista
  for (let i = 1; i < items.length; i++) assert.ok(items[i].coverage <= items[i - 1].coverage);
});

test('paginazione: total = tutto il pool, items = la fetta', () => {
  const { items, total } = candidates(CAT, [], { tipo: 'auto', limit: 1, offset: 0 });
  assert.strictEqual(total, 3, 'Golf+Polo+Giulia (Fantasma scartato)');
  assert.strictEqual(items.length, 1);
});
