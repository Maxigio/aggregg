'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pricing, priceAdjActive, PRICE_DEFAULT } = require('../frontend/pricing.js');

test('pricing: default → finale = base, extra null', () => {
  const r = pricing(10000, PRICE_DEFAULT);
  assert.strictEqual(r.finale, 10000);
  assert.strictEqual(r.rivendita, null);
  assert.strictEqual(r.imponibile, null);
  assert.strictEqual(r.ivaQuota, null);
});

test('pricing: commissione € (+) e spese € (−)', () => {
  const r = pricing(10000, { comm: 500, commUnit: 'eur', spese: 300, margine: 0, iva: false });
  assert.strictEqual(r.finale, 10200);   // 10000 + 500 − 300
});

test('pricing: commissione in %', () => {
  const r = pricing(10000, { comm: 10, commUnit: 'pct', spese: 0, margine: 0, iva: false });
  assert.strictEqual(r.finale, 11000);   // 10000 + 10%
});

test('pricing: clamp a 0 quando spese > base', () => {
  const r = pricing(100, { comm: 0, commUnit: 'eur', spese: 500, margine: 0, iva: false });
  assert.strictEqual(r.finale, 0);
});

test('pricing: margine → prezzo di rivendita', () => {
  const r = pricing(10000, { comm: 0, commUnit: 'eur', spese: 0, margine: 20, iva: false });
  assert.strictEqual(r.rivendita, 12000);   // 10000 × 1.20
});

test('pricing: scorporo IVA 22% (imponibile + quota)', () => {
  const r = pricing(1220, { comm: 0, commUnit: 'eur', spese: 0, margine: 0, iva: true });
  assert.ok(Math.abs(r.imponibile - 1000) < 1e-9);
  assert.ok(Math.abs(r.ivaQuota - 220) < 1e-9);
});

test('pricing: base non numerica → null (niente aggiustamento su "trattabile")', () => {
  assert.strictEqual(pricing(null, PRICE_DEFAULT), null);
  assert.strictEqual(pricing(undefined, PRICE_DEFAULT), null);
  assert.strictEqual(pricing('12,50', PRICE_DEFAULT), null);
});

test('priceAdjActive: vero solo se una leva è impostata', () => {
  assert.strictEqual(priceAdjActive(PRICE_DEFAULT), false);
  assert.strictEqual(priceAdjActive({ ...PRICE_DEFAULT, comm: 100 }), true);
  assert.strictEqual(priceAdjActive({ ...PRICE_DEFAULT, iva: true }), true);
});
