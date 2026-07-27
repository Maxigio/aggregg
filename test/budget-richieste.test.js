'use strict';
const test = require('node:test');
const assert = require('node:assert');
const budget = require('../backend/budget-richieste');

test('conta fuori da una ricerca non fa niente (crawler, test, altre rotte)', () => {
  assert.equal(budget.corrente(), null);
  budget.conta('subito');                     // non deve esplodere ne' sporcare niente
  assert.equal(budget.corrente(), null);
});

test('conta per fonte dentro una ricerca', async () => {
  const righe = [];
  await budget.perRicerca('moto Triumph Bonneville', async () => {
    budget.conta('subito'); budget.conta('subito');
    budget.conta('as24'); budget.conta('as24'); budget.conta('as24');
    budget.conta('motoit');
    const c = budget.corrente();
    assert.equal(c.tot, 6);
    assert.deepEqual(c.per, { subito: 2, as24: 3, motoit: 1 });
  }, r => righe.push(r));
  assert.equal(righe.length, 1);
  assert.match(righe[0], /^\[budget\] moto Triumph Bonneville → /);
  assert.match(righe[0], /as24 3/);
  assert.match(righe[0], /= 6/);
});

test('due ricerche in parallelo non si mescolano i conti', async () => {
  const righe = [];
  const uno = budget.perRicerca('auto A', async () => {
    budget.conta('subito');
    await new Promise(r => setTimeout(r, 10));
    budget.conta('subito');                    // dopo un await: il contesto deve reggere
    return budget.corrente().tot;
  }, r => righe.push(r));
  const due = budget.perRicerca('auto B', async () => {
    budget.conta('as24');
    await new Promise(r => setTimeout(r, 5));
    return budget.corrente().tot;
  }, r => righe.push(r));
  assert.deepEqual(await Promise.all([uno, due]), [2, 1]);
  assert.equal(righe.length, 2);
});

test('la nota accompagna la fonte nella riga', async () => {
  const righe = [];
  await budget.perRicerca('moto X', async () => {
    budget.conta('motoit', 'menu cache-miss');
    budget.conta('motoit');
  }, r => righe.push(r));
  assert.match(righe[0], /motoit 2 \(menu cache-miss\)/);
});

test('sopra il tetto lo dichiara ma NON interrompe la ricerca', async () => {
  const righe = [];
  const esito = await budget.perRicerca('auto pesante', async () => {
    for (let i = 0; i < budget.TETTO + 1; i++) budget.conta('subito');
    return 'finita lo stesso';
  }, r => righe.push(r));
  assert.equal(esito, 'finita lo stesso');
  assert.match(righe[0], /SOPRA IL TETTO/);
});

test('una ricerca caduta scrive comunque quante richieste ha bruciato', async () => {
  const righe = [];
  await assert.rejects(
    budget.perRicerca('auto rotta', async () => {
      budget.conta('subito'); budget.conta('as24');
      throw new Error('fonte giu');
    }, r => righe.push(r)),
    /fonte giu/);
  assert.equal(righe.length, 1);
  assert.match(righe[0], /= 2/);
  assert.match(righe[0], /caduta: fonte giu/);
});

test('riga leggibile: fonti ordinate per costo, totale in fondo', () => {
  const r = budget.riga({ tot: 8, per: { subito: 2, as24: 3, motoit: 3 }, note: {} });
  assert.equal(r, 'as24 3 · motoit 3 · subito 2 = 8');
  assert.equal(budget.riga({ tot: 0, per: {}, note: {} }), 'nessuna richiesta = 0');
});
