'use strict';
// F60 — coda crawl manuale. Gated su DATABASE_URL_TEST. crawl_queue è toccata SOLO
// da questo file → TRUNCATE sicuro (no race con altri test).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('crawl-queue-repo: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const q = require('../backend/db/crawl-queue-repo');

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE crawl_queue RESTART IDENTITY'); });

const T = (o = {}) => ({ tipo: 'auto', marca: 'BMW', modello: 'Serie 3', ...o });

test('enqueue: inserisce pending; dedupe attivo per (tipo,marca,modello)', async () => {
  const id1 = await q.enqueue(T());
  assert.ok(id1, 'primo enqueue → id');
  const id2 = await q.enqueue(T());
  assert.strictEqual(id2, null, 'duplicato attivo → ON CONFLICT DO NOTHING → null');
  const c = await db.query('SELECT count(*)::int n FROM crawl_queue');
  assert.strictEqual(c.rows[0].n, 1, 'una sola riga');
});

test('enqueue: target incompleto/ad-hoc', async () => {
  assert.strictEqual(await q.enqueue({ tipo: 'auto', marca: 'BMW' }), null, 'senza modello → null');
  const id = await q.enqueue(T({ modello: 'X1', watchlist_id: null }));   // ad-hoc (no watchlist)
  assert.ok(id);
  const r = await db.query('SELECT watchlist_id FROM crawl_queue WHERE id=$1', [id]);
  assert.strictEqual(r.rows[0].watchlist_id, null, 'ad-hoc → watchlist_id NULL');
});

test('pickNext: priorità DESC poi FIFO; flip atomico pending→running', async () => {
  await q.enqueue(T({ modello: 'A' }), { priority: 0 });
  await q.enqueue(T({ modello: 'B' }), { priority: 5 });   // priorità più alta → prima
  const first = await q.pickNext();
  assert.strictEqual(first.modello, 'B');
  const row = await db.query('SELECT status FROM crawl_queue WHERE id=$1', [first.id]);
  assert.strictEqual(row.rows[0].status, 'running', 'pickNext flippa a running');
  const second = await q.pickNext();
  assert.strictEqual(second.modello, 'A');
  assert.strictEqual(await q.pickNext(), null, 'coda vuota → null');
});

test('markDone / markFail timbrano stato, written e finished_at', async () => {
  const id = await q.enqueue(T()); await q.pickNext();
  await q.markDone(id, { written: 42 });
  let r = await db.query('SELECT status, written, finished_at FROM crawl_queue WHERE id=$1', [id]);
  assert.strictEqual(r.rows[0].status, 'done');
  assert.strictEqual(r.rows[0].written, 42);
  assert.ok(r.rows[0].finished_at);

  const id2 = await q.enqueue(T({ modello: 'X' })); await q.pickNext();
  await q.markFail(id2, 'boom');
  r = await db.query('SELECT status, error FROM crawl_queue WHERE id=$1', [id2]);
  assert.strictEqual(r.rows[0].status, 'fail');
  assert.match(r.rows[0].error, /boom/);
});

test('reclaimStale: running con heartbeat vecchio → pending; fresco resta', async () => {
  await db.query(`INSERT INTO crawl_queue (tipo,marca,modello,status,started_at,heartbeat)
                  VALUES ('auto','A','old','running', now()-interval '30 min', now()-interval '30 min')`);
  await db.query(`INSERT INTO crawl_queue (tipo,marca,modello,status,started_at,heartbeat)
                  VALUES ('auto','A','fresh','running', now(), now())`);
  const n = await q.reclaimStale(15);
  assert.strictEqual(n, 1, 'solo il vecchio reclaimato');
  const old = await db.query(`SELECT status FROM crawl_queue WHERE modello='old'`);
  const fresh = await db.query(`SELECT status FROM crawl_queue WHERE modello='fresh'`);
  assert.strictEqual(old.rows[0].status, 'pending');
  assert.strictEqual(fresh.rows[0].status, 'running');
});

test('isCancelRequested: true solo per status cancel_requested', async () => {
  const id = await q.enqueue(T());
  assert.strictEqual(await q.isCancelRequested(id), false);
  await db.query(`UPDATE crawl_queue SET status='cancel_requested' WHERE id=$1`, [id]);
  assert.strictEqual(await q.isCancelRequested(id), true);
});

test('advisory lock: singleton drainer (2ª connessione non prende il lock)', async () => {
  const KEY = 414260060;
  const c1 = await db.getClient();
  const c2 = await db.getClient();
  try {
    const g1 = (await c1.query('SELECT pg_try_advisory_lock($1) g', [KEY])).rows[0].g;
    const g2 = (await c2.query('SELECT pg_try_advisory_lock($1) g', [KEY])).rows[0].g;
    assert.strictEqual(g1, true, 'primo prende il lock');
    assert.strictEqual(g2, false, 'secondo NO (singleton)');
    await c1.query('SELECT pg_advisory_unlock($1)', [KEY]);
    const g2b = (await c2.query('SELECT pg_try_advisory_lock($1) g', [KEY])).rows[0].g;
    assert.strictEqual(g2b, true, 'dopo unlock il secondo riesce');
    await c2.query('SELECT pg_advisory_unlock($1)', [KEY]);
  } finally {
    c1.release(); c2.release();
  }
});
