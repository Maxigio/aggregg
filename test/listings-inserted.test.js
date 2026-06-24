'use strict';
// M-E — onestà "written": upsertListings ritorna `inserted` (righe NUOVE, xmax=0) vs
// `written` (righe toccate). Gated su DATABASE_URL_TEST (scratch). Tocca solo URL sentinel
// 'test-mE://…' e li ripulisce → safe anche su DB popolato (niente TRUNCATE).
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('listings-inserted: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const repo = require('../backend/db/listings-repo');

const URLS = ['test-mE://e1', 'test-mE://e2'];
const TARGET = { tipo: 'auto', marca: '__ME_TEST__', modello: 'inserted' };
const ITEMS = URLS.map((url, i) => ({ url, fonte: 'subito', prezzo: 1000 + i, anno: 2020, km: 100 }));
const cleanup = async () => {
  await db.query('DELETE FROM price_points WHERE url = ANY($1)', [URLS]);
  await db.query('DELETE FROM listings WHERE url = ANY($1)', [URLS]);
};

before(async () => { await db.init(); await cleanup(); });   // init applica anche mig 017 (idempotente)
after(async () => { await cleanup(); await db.close(); });

test('upsertListings: primo upsert → inserted = written (righe NUOVE)', async () => {
  const r = await repo.upsertListings(ITEMS, TARGET);
  assert.strictEqual(r.written, 2, 'due righe scritte');
  assert.strictEqual(r.inserted, 2, 'entrambe NUOVE (xmax=0)');
});

test('upsertListings: re-upsert stessi url → inserted 0, written invariato', async () => {
  const r = await repo.upsertListings(ITEMS, TARGET);
  assert.strictEqual(r.written, 2, 'riscritte (upsert ON CONFLICT)');
  assert.strictEqual(r.inserted, 0, 'nessuna NUOVA → 0 nuovi (onestà written)');
});
