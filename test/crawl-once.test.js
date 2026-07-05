'use strict';
// F60 — loop del drainer (drainQueue) con sweep INIETTATO → niente rete. Gated su
// DATABASE_URL_TEST (DB SCRATCH: beforeEach TRUNCATE crawl_queue; guard anti-prod).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('crawl-once: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const q = require('../backend/db/crawl-queue-repo');
const { drainQueue } = require('../scripts/crawl-once');

before(async () => {
  await db.init();
  const r = await db.query('SELECT count(*)::int n FROM listings');
  if (r && r.rows[0].n > 1000) throw new Error('DATABASE_URL_TEST punta a dati reali — usa un DB scratch');
});
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE crawl_queue RESTART IDENTITY'); });

const T = (o = {}) => ({ tipo: 'auto', marca: 'BMW', modello: 'X', ...o });
const FAST = { throttleMs: 0, pollMs: 0 };   // niente attese nel test

test('drainQueue: drena tutti i pending → done con written', async () => {
  await q.enqueue(T({ modello: 'A' }));
  await q.enqueue(T({ modello: 'B' }));
  const calls = [];
  const sweep = async (t, s) => { calls.push(`${t.marca} ${t.modello}`); s.written = 7; return { truncated: false, complete: true }; };
  const tot = await drainQueue({ sweep, ...FAST });
  assert.strictEqual(tot.targets, 2);
  assert.strictEqual(tot.written, 14);
  assert.strictEqual(calls.length, 2);
  const done = await db.query("SELECT count(*)::int n FROM crawl_queue WHERE status='done' AND written=7");
  assert.strictEqual(done.rows[0].n, 2);
});

test('drainQueue: sweep che throwa → markFail, il drain continua', async () => {
  await q.enqueue(T({ modello: 'boom' }));
  await q.enqueue(T({ modello: 'ok' }));
  const sweep = async (t, s) => { if (t.modello === 'boom') throw new Error('kaboom'); s.written = 3; return { truncated: false, complete: true }; };
  const tot = await drainQueue({ sweep, ...FAST });
  assert.strictEqual(tot.targets, 2);
  assert.strictEqual(tot.errors, 1);
  const fail = await db.query("SELECT error FROM crawl_queue WHERE modello='boom'");
  assert.match(fail.rows[0].error, /kaboom/);
  const ok = await db.query("SELECT status FROM crawl_queue WHERE modello='ok'");
  assert.strictEqual(ok.rows[0].status, 'done');
});

test('drainQueue: cancel DURANTE lo sweep → markFail annullato (non done)', async () => {
  const id = await q.enqueue(T({ modello: 'mid' }));
  // lo sweep simula un annullo arrivato mentre crawlava (setta cancel_requested sul job in corso)
  const sweep = async (t, s) => {
    await db.query("UPDATE crawl_queue SET status='cancel_requested' WHERE id=$1", [id]);
    s.written = 3;
    return { truncated: false, complete: true };
  };
  await drainQueue({ sweep, ...FAST });
  const row = await db.query('SELECT status, error FROM crawl_queue WHERE id=$1', [id]);
  assert.strictEqual(row.rows[0].status, 'fail', 'cancel a sweep finito → NON done');
  assert.match(row.rows[0].error, /annullato/);
});

test('drainQueue: job.pages → maxPages passato allo sweep (profondità per-run)', async () => {
  await q.enqueue(T({ modello: 'depth' }), { pages: 60 });
  let seen;
  const sweep = async (t, s) => { seen = t.maxPages; s.written = 1; return { truncated: false, complete: true }; };
  await drainQueue({ sweep, ...FAST });
  assert.strictEqual(seen, 60, 'maxPages dal job.pages');
});

test('drainQueue: job senza watchlist → sweep riceve {refresh:false} (glue M-M)', async () => {
  // Copre il GLUE drainer→sweepTarget (shouldRefresh + 3° argomento) senza dipendere da
  // watchlist (TRUNCATEd da watchlist-repo.test.js in parallelo → sarebbe race). Il ramo
  // refresh:true e2e è coperto per componenti: shouldRefresh (refresh-lane, puro) +
  // markSwept refresh (watchlist-repo) + pickNext.saturated_at (sub-select su PK).
  await q.enqueue(T({ modello: 'glue' }));
  let seen = null;
  const sweep = async (t, s, o) => { seen = o; s.written = 1; return { truncated: false, complete: true }; };
  await drainQueue({ sweep, ...FAST });
  assert.deepStrictEqual(seen, { refresh: false }, 'ad-hoc/mai-saturato → corsia piena, 3° arg presente');
});

test('drainQueue: coda vuota → 0 target, esce (double-empty-poll)', async () => {
  let n = 0;
  const tot = await drainQueue({ sweep: async () => { n++; return {}; }, ...FAST });
  assert.strictEqual(tot.targets, 0);
  assert.strictEqual(n, 0, 'nessuno sweep su coda vuota');
});
