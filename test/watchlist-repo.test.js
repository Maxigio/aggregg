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
