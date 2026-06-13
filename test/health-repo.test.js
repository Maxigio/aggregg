'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { classifyOutcome } = require('../backend/db/health-repo');

const tagged = (msg, status, kind) => Object.assign(new Error(msg), { status, kind });

// ─── classifyOutcome (PURA, sempre eseguita) ──────────────────────────────────
test('classifyOutcome: nessun errore → ok/empty da count', () => {
  assert.strictEqual(classifyOutcome(null, 5), 'ok');
  assert.strictEqual(classifyOutcome(null, 0), 'empty');
});

test('classifyOutcome: usa err.kind se presente', () => {
  assert.strictEqual(classifyOutcome(tagged('x', 429, 'blocked')), 'blocked');
  assert.strictEqual(classifyOutcome(tagged('x', 401, 'auth')), 'auth');
});

test('classifyOutcome: da status quando manca kind', () => {
  assert.strictEqual(classifyOutcome({ status: 403, message: '' }), 'blocked');
  assert.strictEqual(classifyOutcome({ status: 429, message: '' }), 'blocked');
  assert.strictEqual(classifyOutcome({ status: 401, message: '' }), 'auth');
  assert.strictEqual(classifyOutcome({ status: 503, message: '' }), 'transient');
});

test('classifyOutcome: fallback sul messaggio', () => {
  assert.strictEqual(classifyOutcome(new Error('Subito hades: body non-JSON (blocco?)')), 'blocked');
  assert.strictEqual(classifyOutcome(new Error('timeout')), 'transient');
  assert.strictEqual(classifyOutcome(new Error('AS24 GraphQL errors: boom')), 'error');
});

// ─── record (INTEGRAZIONE, gated su DATABASE_URL_TEST) ─────────────────────────
const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('health-repo record: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;   // top-level return: Node avvolge il modulo in una funzione
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const health = require('../backend/db/health-repo');

before(async () => { await db.init(); });
after(async () => { await db.close(); });
beforeEach(async () => { await db.query('TRUNCATE crawl_health'); });

const row = async fonte => (await db.query('SELECT * FROM crawl_health WHERE fonte=$1', [fonte])).rows[0];

test('record: blocco (429) → blocked=true + last_blocked_at', async () => {
  await health.record('subito', { error: tagged('429', 429, 'blocked') });
  const r = await row('subito');
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.blocked_count, 1);
  assert.ok(r.last_blocked_at);
});

test('record: ok dopo blocco → azzera blocked + consec_fail, set last_ok', async () => {
  await health.record('subito', { error: tagged('429', 429, 'blocked') });
  await health.record('subito', { count: 5 });
  const r = await row('subito');
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.consec_fail, 0);
  assert.strictEqual(r.ok_count, 1);
  assert.ok(r.last_ok);
});

test('record: 3 transient consecutivi → degraded=true, blocked=false', async () => {
  for (let i = 0; i < 3; i++) await health.record('autoscout', { error: tagged('timeout', null, 'transient') });
  const r = await row('autoscout');
  assert.strictEqual(r.degraded, true);
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.consec_fail, 3);
});

test('getHealth: sommario blocked/degraded taggato per nodo', async () => {
  await health.record('subito', { error: tagged('403', 403, 'blocked') });           // node imac
  await health.record('autoscout', { count: 10 });                                    // node imac
  await health.record('subito', { count: 7, node: 'surface' });                        // altro nodo
  const h = await health.getHealth();
  assert.strictEqual(h.ok, false);
  assert.deepStrictEqual(h.blocked, ['imac/subito']);
  assert.strictEqual(h.nodi.length, 3);   // (imac,subito)+(imac,autoscout)+(surface,subito)
});
