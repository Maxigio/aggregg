'use strict';
// F32 Fase 2 — repo dealer_stock. Gated su DATABASE_URL_TEST. dealer_stock è toccata
// SOLO da questo file → TRUNCATE sicuro (no race con altri test).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('dealer-repo: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const dealer = require('../backend/dealer');

const veh = (url, prezzo, extra = {}) => ({
  url, customerId: '999', tipo: 'moto', marca: 'Suzuki', modello: 'V-Strom 1050',
  anno: 2020, km: 30000, prezzo, posted_at: null, raw: { url }, ...extra,
});

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE dealer_stock RESTART IDENTITY CASCADE'); });

test('upsertStock: inserisce e listStock ritorna gli attivi', async () => {
  await dealer.upsertStock([veh('u/1', 8700), veh('u/2', 7900, { modello: '890 Adventure', marca: 'KTM' })]);
  const stock = await dealer.listStock();
  assert.strictEqual(stock.length, 2);
  assert.deepStrictEqual(stock.map(r => r.my_price).sort((a, b) => a - b), [7900, 8700]);
});

test('upsertStock: idempotente (stesso url) → aggiorna prezzo, non duplica', async () => {
  await dealer.upsertStock([veh('u/1', 8700)]);
  await dealer.upsertStock([veh('u/1', 8200)]);   // stesso url, prezzo nuovo
  const stock = await dealer.listStock();
  assert.strictEqual(stock.length, 1, 'niente riga duplicata');
  assert.strictEqual(stock[0].my_price, 8200, 'prezzo aggiornato');
});

test('markDisappeared: marca withdrawn SOLO gli url spariti del customer', async () => {
  await dealer.upsertStock([veh('u/1', 8700), veh('u/2', 7900), veh('u/3', 5000)]);
  // import successivo: u/3 sparito dalla pagina
  const n = await dealer.markDisappeared('999', ['u/1', 'u/2']);
  assert.strictEqual(n, 1, 'un solo veicolo marcato withdrawn');
  const stock = await dealer.listStock();   // solo active
  assert.strictEqual(stock.length, 2);
  assert.ok(!stock.find(r => r.url === 'u/3'), 'u/3 non è più active');
});

test('markDisappeared: customer diverso non viene toccato', async () => {
  await dealer.upsertStock([veh('u/1', 8700, { customerId: '999' }), veh('u/x', 4000, { customerId: '111' })]);
  await dealer.markDisappeared('999', []);   // tutti i 999 spariti
  const stock = await dealer.listStock();
  assert.ok(stock.find(r => r.url === 'u/x'), "l'altro concessionario resta attivo");
});

test('setNote / setStatus: nota salvata; venduto esce da listStock + sold_at', async () => {
  await dealer.upsertStock([veh('u/1', 8700)]);
  await dealer.setNote('u/1', 'permuta interessante');
  await dealer.setStatus('u/1', 'sold');
  const stock = await dealer.listStock();
  assert.strictEqual(stock.length, 0, 'venduto non è più active');
  const row = (await db.query("SELECT note, status, sold_at FROM dealer_stock WHERE url='u/1'")).rows[0];
  assert.strictEqual(row.note, 'permuta interessante');
  assert.strictEqual(row.status, 'sold');
  assert.ok(row.sold_at, 'sold_at timbrato');
});
