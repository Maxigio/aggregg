'use strict';
// Integrazione su DB reale di test. Richiede Postgres con automotoradar_test.
// La connessione arriva SOLO da DATABASE_URL_TEST (nessuna credenziale in chiaro
// nel repo). Senza la env → suite skippata. Run:
//   DATABASE_URL_TEST=postgres://postgres:PASS@localhost:5432/automotoradar_test node --test
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('listings-repo: SKIP — imposta DATABASE_URL_TEST per eseguire', { skip: true }, () => {});
  return;   // top-level return: Node avvolge il modulo in una funzione
}

// Override DATABASE_URL PRIMA di richiedere il modulo db (pool singleton).
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const repo = require('../backend/db/listings-repo');

const TARGET = { tipo: 'auto', marca: 'BMW', modello: '320d' };
const mkItem = (url, prezzo, extra = {}) => ({
  fonte: 'autoscout', url, prezzo, km: 120000, anno: 2015, ...extra,
});

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.query('TRUNCATE listings, price_points RESTART IDENTITY CASCADE');
});

async function row(url) {
  const r = await db.query('SELECT * FROM listings WHERE url=$1', [url]);
  return r.rows[0];
}
async function pricePoints(url) {
  const r = await db.query('SELECT prezzo FROM price_points WHERE url=$1 ORDER BY ts', [url]);
  return r.rows.map(x => x.prezzo);
}

test('insert nuovo: listing + 1 price_point + model_key + raw_json', async () => {
  await repo.upsertListings([mkItem('u1', 10000, { _raw: { foo: 1 } })], TARGET);
  const l = await row('u1');
  assert.strictEqual(l.last_price, 10000);
  assert.strictEqual(l.status, 'active');
  assert.strictEqual(l.model_key, 'auto|bmw|320d|2013-2015|100-150k');
  assert.deepStrictEqual(l.raw_json, { foo: 1 });
  assert.deepStrictEqual(await pricePoints('u1'), [10000]);
});

test('prezzo invariato: NESSUN nuovo price_point', async () => {
  await repo.upsertListings([mkItem('u1', 10000)], TARGET);
  await repo.upsertListings([mkItem('u1', 10000)], TARGET);
  assert.deepStrictEqual(await pricePoints('u1'), [10000]);
});

test('prezzo cambiato: append price_point + last_price aggiornato', async () => {
  await repo.upsertListings([mkItem('u1', 10000)], TARGET);
  await repo.upsertListings([mkItem('u1', 9500)], TARGET);
  assert.deepStrictEqual(await pricePoints('u1'), [10000, 9500]);
  assert.strictEqual((await row('u1')).last_price, 9500);
});

test('markGone: venduto solo dopo 2 assenze (K=2)', async () => {
  await repo.upsertListings([mkItem('u1', 10000), mkItem('u2', 8000)], TARGET);
  // sweep 1: u2 assente → miss_count 1, ancora active
  await repo.upsertListings([mkItem('u1', 10000)], TARGET);
  let r1 = await repo.markGone(TARGET, ['u1']);
  assert.strictEqual((await row('u2')).status, 'active');
  assert.strictEqual((await row('u2')).miss_count, 1);
  // sweep 2: u2 ancora assente → gone
  await repo.upsertListings([mkItem('u1', 10000)], TARGET);
  let r2 = await repo.markGone(TARGET, ['u1']);
  assert.strictEqual((await row('u2')).status, 'gone');
  assert.ok((await row('u2')).gone_at);
  assert.strictEqual((await row('u2')).last_price, 8000); // prezzo di vendita tenuto
  assert.strictEqual(r2.gone, 1);
});

test('annuncio ricomparso: torna active, miss_count azzerato', async () => {
  await repo.upsertListings([mkItem('u1', 10000), mkItem('u2', 8000)], TARGET);
  await repo.markGone(TARGET, ['u1']);          // u2 miss 1
  await repo.markGone(TARGET, ['u1']);          // u2 gone
  assert.strictEqual((await row('u2')).status, 'gone');
  await repo.upsertListings([mkItem('u2', 7900)], TARGET);  // riappare, prezzo nuovo
  const l = await row('u2');
  assert.strictEqual(l.status, 'active');
  assert.strictEqual(l.gone_at, null);
  assert.strictEqual(l.miss_count, 0);
  assert.deepStrictEqual(await pricePoints('u2'), [8000, 7900]);
});

test('prezzo null: scartato (no listing, no price_point)', async () => {
  await repo.upsertListings([mkItem('u9', null)], TARGET);
  assert.strictEqual(await row('u9'), undefined);
});
