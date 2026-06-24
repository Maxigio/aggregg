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

// La ristrutturazione UPSERT_SQL (pp = CTE data-modifying NON referenziata) deve
// continuare a scrivere price_points: 1 punto al 1° insert, NESSUN doppione a prezzo
// invariato, +1 a prezzo cambiato (regressione = storia prezzi rotta in silenzio).
test('upsertListings: price_points scritto + dedup prezzo (CTE pp ancora attiva)', async () => {
  await db.query('DELETE FROM price_points WHERE url=$1', [URLS[0]]);   // self-contained (no dip. ordine)
  await db.query('DELETE FROM listings WHERE url=$1', [URLS[0]]);
  const one = [{ url: URLS[0], fonte: 'subito', prezzo: 1000, anno: 2020, km: 100 }];
  await repo.upsertListings(one, TARGET);
  const n1 = (await db.query('SELECT count(*)::int n FROM price_points WHERE url=$1', [URLS[0]])).rows[0].n;
  assert.strictEqual(n1, 1, '1° insert → 1 price_point');
  await repo.upsertListings(one, TARGET);   // stesso prezzo → niente doppione
  const n2 = (await db.query('SELECT count(*)::int n FROM price_points WHERE url=$1', [URLS[0]])).rows[0].n;
  assert.strictEqual(n2, 1, 'prezzo invariato → nessun price_point in più');
  await repo.upsertListings([{ ...one[0], prezzo: 1200 }], TARGET);   // prezzo nuovo → +1
  const n3 = (await db.query('SELECT count(*)::int n FROM price_points WHERE url=$1', [URLS[0]])).rows[0].n;
  const lp = (await db.query('SELECT last_price FROM listings WHERE url=$1', [URLS[0]])).rows[0].last_price;
  assert.strictEqual(n3, 2, 'prezzo cambiato → +1 price_point');
  assert.strictEqual(lp, 1200, 'last_price aggiornato');
});
