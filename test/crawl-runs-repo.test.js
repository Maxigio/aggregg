'use strict';
// F12 — log-run persistente. Gated su DATABASE_URL_TEST. crawl_runs è toccata
// SOLO da questo file → TRUNCATE sicuro (no race con altri test).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('crawl-runs-repo: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const runs = require('../backend/db/crawl-runs-repo');

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE crawl_runs RESTART IDENTITY'); });

test('startRun → in corso (finished_at NULL); finishRun → chiuso col riepilogo', async () => {
  const id = await runs.startRun('imac');
  assert.ok(id, 'startRun ritorna un id');
  let lr = await runs.lastRun('imac');
  assert.strictEqual(lr.id, id);
  assert.strictEqual(lr.finished_at, null, 'appena aperto = in corso');

  await runs.finishRun(id, { targets: 5, written: 42, errors: 1 });
  lr = await runs.lastRun('imac');
  assert.ok(lr.finished_at, 'finishRun timbra finished_at');
  assert.strictEqual(lr.targets, 5);
  assert.strictEqual(lr.written, 42);
  assert.strictEqual(lr.errors, 1);
});

test('lastRun: ritorna il più recente per nodo', async () => {
  const a = await runs.startRun('imac'); await runs.finishRun(a, { written: 1 });
  const b = await runs.startRun('imac'); await runs.finishRun(b, { written: 2 });
  const lr = await runs.lastRun('imac');
  assert.strictEqual(lr.id, b, 'ultimo per started_at');
  assert.strictEqual(lr.written, 2);
  assert.strictEqual(await runs.lastRun('surface'), null, 'nodo senza run → null');
});
