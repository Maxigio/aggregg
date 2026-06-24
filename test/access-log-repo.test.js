'use strict';
// Integrazione gated su DATABASE_URL_TEST (come gli altri repo). Verifica record()
// (incl. roundtrip JSONB) e prune() per access_log (F50 Fase 4). SKIP senza
// DATABASE_URL_TEST → `node --test` NON tocca il DB prod (beforeEach fa TRUNCATE).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('access-log-repo: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const log = require('../backend/db/access-log-repo');

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE access_log RESTART IDENTITY'); });

test('record: login_ok + login_fail + search (roundtrip JSONB)', async () => {
  await log.record('login_ok', { role: 'demo', ip: '1.2.3.4', ua: 'probe' });
  await log.record('login_fail', { ip: '9.9.9.9', ua: 'curl' });
  await log.record('search', {
    role: 'demo', ip: '1.2.3.4', ua: 'probe',
    query: { tipo: 'moto', marca: 'Suzuki', modello: 'V-Strom 1050' }, resultCount: 7,
  });
  const r = await db.query('SELECT event, role, ip, query, result_count FROM access_log ORDER BY id');
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0].role, 'demo');
  assert.equal(r.rows[1].role, null);          // login_fail = nessun ruolo
  assert.equal(r.rows[2].result_count, 7);
  assert.equal(r.rows[2].query.modello, 'V-Strom 1050');   // JSONB → oggetto
});

test('record: no-op senza event', async () => {
  await log.record('', { ip: '1.1.1.1' });
  const r = await db.query('SELECT count(*)::int n FROM access_log');
  assert.equal(r.rows[0].n, 0);
});

test('prune: rimuove i vecchi, tiene i recenti', async () => {
  await log.record('login_ok', { role: 'full', ip: '1.1.1.1' });   // recente
  await db.query("INSERT INTO access_log (event, ts) VALUES ('login_ok', now() - interval '200 days')");
  const removed = await log.prune(90);
  assert.equal(removed, 1);
  const r = await db.query('SELECT count(*)::int n FROM access_log');
  assert.equal(r.rows[0].n, 1);
});
