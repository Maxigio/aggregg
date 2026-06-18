'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const V = require('../backend/valuation');

// Comparabile minimale
const c = (prezzo, anno, km, extra = {}) => ({ prezzo, anno, km, venditore: 'privato', url: 'u' + Math.random(), fonte: 'subito', ...extra });

test('computeValuation: match stretto scelto quando ci sono abbastanza campioni', () => {
  // 8 comparabili dentro ±2 anni / ±20k km del target (2020, 30k)
  const comps = Array.from({ length: 8 }, (_, i) => c(10000 + i * 100, 2020, 30000));
  const r = V.computeValuation(comps, { anno: 2020, km: 30000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tightness, 'stretto');
  assert.strictEqual(r.n, 8);
  assert.ok(r.fascia.mediana >= 10000 && r.fascia.mediana <= 10800);
});

test('computeValuation: allarga se il match stretto ha pochi campioni', () => {
  const comps = [
    c(10000, 2020, 30000), c(10200, 2020, 32000),       // dentro stretto (2)
    c(9000, 2016, 90000), c(9200, 2016, 95000), c(9300, 2017, 88000),
    c(9400, 2017, 80000), c(9500, 2015, 100000), c(9600, 2015, 110000),  // fuori stretto
  ];
  const r = V.computeValuation(comps, { anno: 2020, km: 30000 });
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.tightness, 'stretto');   // ha dovuto allargare
  assert.strictEqual(r.n, 8);
});

test('computeValuation: esclude danni, km-0 e nuovo (like-for-like)', () => {
  const comps = [
    ...Array.from({ length: 6 }, () => c(10000, 2020, 30000)),
    c(3000, 2020, 30000, { danni: true }),   // incidentato → fuori
    c(15000, 2020, 0),                        // km-0 → fuori
    c(16000, 2020, 5, { nuovo: true }),       // nuovo → fuori
  ];
  const r = V.computeValuation(comps, { anno: 2020, km: 30000 });
  assert.strictEqual(r.n, 6);
  assert.strictEqual(r.fascia.mediana, 10000);   // i 3 esclusi non spostano la mediana
});

test('computeValuation: sotto soglia → ok=false, niente numero inventato', () => {
  const comps = [c(10000, 2020, 30000), c(10100, 2020, 31000)];   // solo 2
  const r = V.computeValuation(comps, { anno: 2020, km: 30000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.motivo, 'dati insufficienti');
  assert.strictEqual(r.fascia, null);
});

test('trimOutliers: i prezzi-spazzatura non spostano mediana/min/max', () => {
  const comps = [c(1, 2020, 30000), ...Array.from({ length: 10 }, (_, i) => c(10000 + i * 200, 2020, 30000)), c(999999, 2020, 30000)];
  const r = V.computeValuation(comps, { anno: 2020, km: 30000 });
  assert.ok(r.fascia.min >= 10000, 'il €1 è stato trimmato');
  assert.ok(r.fascia.max <= 12000, 'il €999.999 è stato trimmato');
  assert.ok(r.fascia.scartati >= 2);
});

test('sellerSplit: composizione conc vs privati', () => {
  const comps = [
    c(12000, 2020, 30000, { venditore: 'concessionario' }),
    c(12500, 2020, 30000, { venditore: 'concessionario' }),
    c(10000, 2020, 30000, { venditore: 'privato' }),
    c(10500, 2020, 30000, { venditore: 'privato' }),
    c(10200, 2020, 30000, { venditore: 'privato' }),
    c(11000, 2020, 30000, { venditore: 'privato' }),
  ];
  const r = V.computeValuation(comps, { anno: 2020, km: 30000 });
  assert.strictEqual(r.split.conc.n, 2);
  assert.strictEqual(r.split.priv.n, 4);
  assert.ok(r.split.conc.mediana > r.split.priv.mediana);   // conc più cari (come da realtà)
});

test('pricePosition: percentile e rango del prezzo di papà', () => {
  const comps = [c(9000, 2020, 30000), c(10000, 2020, 30000), c(11000, 2020, 30000), c(12000, 2020, 30000)];
  // papà a 11500 → 3 più economici di lui su 4
  const p = V.pricePosition(11500, comps);
  assert.strictEqual(p.posizione, 4);   // 4° dal più economico (3 sotto + lui)
  assert.strictEqual(p.su, 5);
  assert.strictEqual(p.percentile, 75); // 3/4 del mercato è più economico
});

test('pricePosition: set vuoto → null (niente numero senza campione)', () => {
  assert.strictEqual(V.pricePosition(10000, []), null);
  assert.strictEqual(V.pricePosition(10000, [c(5000, 2020, 30000, { danni: true })]), null); // l'unico è scartato
});

test('computeValuation: senza anno/km → tightness "modello" (non finge un match stretto)', () => {
  const comps = Array.from({ length: 10 }, (_, i) => c(9000 + i * 100, 2018 + (i % 5), 40000 + i * 5000));
  const r = V.computeValuation(comps, {});   // nessun target
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tightness, 'modello');
  assert.strictEqual(r.n, 10);
});

test('computeValuation: NON allarga oltre un match stretto valido (≥minSample, <preferN)', () => {
  const stretti = Array.from({ length: 6 }, () => c(10000, 2020, 30000));
  const larghi  = Array.from({ length: 20 }, () => c(8000, 2016, 90000));
  const r = V.computeValuation([...stretti, ...larghi], { anno: 2020, km: 30000 });
  assert.strictEqual(r.tightness, 'stretto');   // resta stretto, non allarga ai 20 larghi
  assert.strictEqual(r.n, 6);
  assert.strictEqual(r.lowConfidence, true);     // pochi campioni → flag, non allargamento
});

test('computeValuation: posizione sul set windowed, non sull’intero mercato', () => {
  const stretti = [9000, 9500, 10000, 10500, 11000, 11500].map(p => c(p, 2020, 30000));
  const larghi  = Array.from({ length: 20 }, () => c(8000, 2016, 90000));   // economici ma fuori finestra
  const r = V.computeValuation([...stretti, ...larghi], { anno: 2020, km: 30000 }, { myPrice: 11200 });
  // papà a 11200: 5 dei 6 stretti più economici → 6° su 7 (i 20 larghi NON contano)
  assert.strictEqual(r.posizione.posizione, 6);
  assert.strictEqual(r.posizione.su, 7);
});

test('computeValuation: scarta i comparabili SENZA anno quando il target ha anno (rete anti-skew, F34)', () => {
  const conAnno = Array.from({ length: 6 }, () => c(10000, 2020, 30000));
  const senzaAnno = Array.from({ length: 6 }, () => c(2000, null, 30000));   // vecchie cheap senza anno (causa Hornet €1500)
  const r = V.computeValuation([...conAnno, ...senzaAnno], { anno: 2020, km: 30000 });
  assert.strictEqual(r.tightness, 'stretto');   // i 6 con anno bastano → resta stretto
  assert.strictEqual(r.n, 6);                    // le 6 senza anno NON entrano nella finestra stretta
  assert.strictEqual(r.fascia.mediana, 10000);   // mediana non abbassata dai relitti senza-anno
});

const CAPS = { autoscout: 100, subito: 100, moto: 52 };   // cap on-search reali (F33: moto 4×13)
test('inferTruncated: una fonte al suo cap → troncato true', () => {
  assert.strictEqual(V.inferTruncated({ moto: { count: 52 }, subito: { count: 10 } }, CAPS), true);   // moto al cap 52
  assert.strictEqual(V.inferTruncated({ subito: { count: 100 } }, CAPS), true);                        // subito al cap
});
test('inferTruncated: tutte sotto il cap → false (vista completa)', () => {
  assert.strictEqual(V.inferTruncated({ moto: { count: 26 }, subito: { count: 40 }, autoscout: { count: 30 } }, CAPS), false);
});
test('inferTruncated: fonte senza cap definito → ignorata (mai troncato)', () => {
  assert.strictEqual(V.inferTruncated({ sconosciuta: { count: 9999 } }, CAPS), false);
  assert.strictEqual(V.inferTruncated({}, CAPS), false);
});
