'use strict';
// Integrazione gated su DATABASE_URL_TEST (come listings-repo). Verifica la
// cadenza 1×/giorno: ramp e dueTargets non si ripetono entro ~20h (F1.6).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('watchlist-repo: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const wl = require('../backend/db/watchlist-repo');

const SEED = [
  { tipo: 'auto', marca: 'Fiat', modello: 'Panda' },
  { tipo: 'auto', marca: 'Fiat', modello: '500' },
  { tipo: 'auto', marca: 'Ford', modello: 'Focus' },
];

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.query('TRUNCATE watchlist RESTART IDENTITY');
  await wl.insertTargets(SEED);
});

test('activateRamp: max 1×/giorno (2° giro entro 20h → [])', async () => {
  const a1 = await wl.activateRamp(2);
  assert.strictEqual(a1.length, 2);
  const a2 = await wl.activateRamp(2);
  assert.strictEqual(a2.length, 0, 'già rampato in giornata → niente nuove attivazioni');
});

test('activateRamp: dopo ~21h riprende', async () => {
  await wl.activateRamp(2);
  await db.query("UPDATE watchlist SET activated_at = now() - interval '21 hours' WHERE activated_at IS NOT NULL");
  const a = await wl.activateRamp(2);
  assert.strictEqual(a.length, 1, 'resta 1 target spento → attivato');
});

test('dueTargets: salta i target swept <20h, riprende dopo', async () => {
  await wl.activateRamp(3);
  let due = await wl.dueTargets();
  assert.strictEqual(due.length, 3, 'mai swept → tutti due');
  for (const t of due) await wl.markSwept(t.id);
  due = await wl.dueTargets();
  assert.strictEqual(due.length, 0, 'appena swept → nessuno due (no re-sweep in giornata)');
  await db.query("UPDATE watchlist SET last_swept = now() - interval '21 hours'");
  due = await wl.dueTargets();
  assert.strictEqual(due.length, 3, 'dopo 21h → di nuovo due');
});

test('leaseTarget: target diversi + completeTarget libera e marca swept', async () => {
  const a = await wl.leaseTarget('surface');
  const b = await wl.leaseTarget('surface');
  assert.ok(a && b);
  assert.notStrictEqual(a.id, b.id, 'lease successivi danno target diversi (no doppioni)');
  await wl.completeTarget(a.id);
  const row = (await db.query('SELECT last_swept, leased_until, activated_at FROM watchlist WHERE id=$1', [a.id])).rows[0];
  assert.ok(row.last_swept, 'completeTarget marca swept');
  assert.strictEqual(row.leased_until, null, 'lease liberato');
  assert.ok(row.activated_at, 'attivato (entra nel daily dell\'iMac)');
});

test('dueTargets esclude i target attualmente leasati', async () => {
  await wl.activateRamp(3);
  const leased = await wl.leaseTarget('surface');
  const due = await wl.dueTargets();
  assert.ok(!due.some(t => t.id === leased.id), 'iMac non tocca il target che il worker sta facendo');
});
