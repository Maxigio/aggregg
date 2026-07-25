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

// ── Passaggio di proprietà: costo della pratica agganciato al MARGINE ──────────
// Il passaggio non tocca il prezzo di rivendita: è un costo che l'operatore sostiene,
// quindi si sottrae al margine. Senza questo, il margine mostrato era più alto del reale.
test('pricing: margine in EURO, non solo la percentuale', () => {
  const r = pricing(10000, { comm: 0, commUnit: 'eur', spese: 0, margine: 15, iva: false });
  assert.strictEqual(r.rivendita, 11500);
  assert.strictEqual(r.margineEuro, 1500);
  assert.strictEqual(r.margineNetto, 1500);      // nessun passaggio impostato
  assert.strictEqual(r.passaggio, null);
});

test('pricing: il passaggio si sottrae al margine, NON al prezzo di rivendita', () => {
  const r = pricing(10000, { comm: 0, commUnit: 'eur', spese: 0, margine: 15, iva: false, passaggio: 223.05 });
  assert.strictEqual(r.rivendita, 11500, 'il prezzo di vendita non cambia');
  assert.strictEqual(r.finale, 10000);
  assert.strictEqual(r.margineEuro, 1500);
  assert.strictEqual(r.margineNetto, 1276.95);   // 1500 − 223,05
  assert.strictEqual(r.passaggio, 223.05);
});

test('pricing: senza margine non c\'è margine netto da mostrare', () => {
  const r = pricing(10000, { comm: 0, commUnit: 'eur', spese: 0, margine: 0, iva: false, passaggio: 223.05 });
  assert.strictEqual(r.rivendita, null);
  assert.strictEqual(r.margineEuro, null);
  assert.strictEqual(r.margineNetto, null);
});

test('pricing: passaggio negativo o non numerico ignorato', () => {
  for (const p of [-50, 'abc', null, undefined]) {
    const r = pricing(10000, { comm: 0, commUnit: 'eur', spese: 0, margine: 10, iva: false, passaggio: p });
    assert.strictEqual(r.passaggio, null, `passaggio ${p}`);
    assert.strictEqual(r.margineNetto, 1000);
  }
});

test('pricing: il passaggio può azzerare o superare il margine (si vede, non si nasconde)', () => {
  const r = pricing(1000, { comm: 0, commUnit: 'eur', spese: 0, margine: 10, iva: false, passaggio: 300 });
  assert.strictEqual(r.margineEuro, 100);
  assert.strictEqual(r.margineNetto, -200, 'un margine negativo va mostrato: e\' un affare da scartare');
});

test('priceAdjActive: il solo passaggio impostato conta come leva attiva', () => {
  assert.strictEqual(priceAdjActive({ comm: 0, spese: 0, margine: 0, iva: false, passaggio: 223 }), true);
  assert.strictEqual(priceAdjActive({ comm: 0, spese: 0, margine: 0, iva: false, passaggio: 0 }), false);
});

// Il costo del passaggio e' un dato del SINGOLO annuncio: dipende da potenza e provincia di
// quel veicolo. Con un unico valore applicato a tutta la lista, righe di province diverse
// mostravano un utile che non esisteva — e quel numero finiva anche in CSV e PDF.
test('passaggio per annuncio: due veicoli, due costi, due margini netti', () => {
  const cfg = { comm: 0, commUnit: 'eur', spese: 0, margine: 10, iva: false, passaggio: 0 };
  const perRiga = (base, pass) => pricing(base, Object.assign({}, cfg, { passaggio: pass }));

  // stessa auto, due province: Bolzano 0% vs Napoli 30% su 190 kW
  const bz = require('../backend/ipt').calcola({ provincia: 'BZ', kW: 90 }).totaleNoto;
  const na = require('../backend/ipt').calcola({ provincia: 'NA', kW: 190 }).totaleNoto;
  assert.ok(na > bz + 400, 'le due pratiche devono costare davvero diverso');

  const a = perRiga(20000, bz), b = perRiga(20000, na);
  assert.strictEqual(a.margineEuro, b.margineEuro, 'il margine lordo non dipende dalla pratica');
  assert.ok(a.margineNetto > b.margineNetto, 'il netto sì');
  assert.ok(Math.abs((a.margineNetto - b.margineNetto) - (na - bz)) < 0.01,
    'la differenza tra i netti e\' esattamente la differenza tra le due pratiche');

  // annuncio senza calcolo: resta il valore scritto a mano nel menu, non quello di un altro veicolo
  const senza = pricing(20000, cfg);
  assert.strictEqual(senza.margineNetto, senza.margineEuro, 'nessuna pratica impostata → netto = lordo');
  assert.strictEqual(senza.passaggio, null);
});
