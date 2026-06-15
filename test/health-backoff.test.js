'use strict';
// F14 — isBackedOff. Gated su DATABASE_URL_TEST. NON usa TRUNCATE su crawl_health
// (la tocca anche listings-repo.test.js → race): isola con un nodo UNICO e pulisce
// solo le proprie righe.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const TEST_URL = process.env.DATABASE_URL_TEST;
if (!TEST_URL) {
  test('health-backoff: SKIP — imposta DATABASE_URL_TEST', { skip: true }, () => {});
  return;
}
process.env.DATABASE_URL = TEST_URL;
const db = require('../backend/db');
const health = require('../backend/db/health-repo');

const NODE = 'zzz_backoff_test';   // nodo isolato → niente collisione con altri test
const FONTE = 'autoscout';

async function setHealth({ blocked, blockedAgoHours }) {
  await db.query('DELETE FROM crawl_health WHERE node=$1', [NODE]);
  await db.query(
    `INSERT INTO crawl_health (node, fonte, last_event_at, last_outcome, blocked,
        last_blocked_at)
     VALUES ($1, $2, now(), $3, $4,
        CASE WHEN $4 THEN now() - ($5 || ' hours')::interval ELSE NULL END)`,
    [NODE, FONTE, blocked ? 'blocked' : 'ok', blocked, String(blockedAgoHours || 0)]
  );
}

before(async () => { await db.init(); });
after(async () => { await db.query('DELETE FROM crawl_health WHERE node=$1', [NODE]); await db.close(); });

test('blocco RECENTE (< Nh) → back-off attivo (salta)', async () => {
  await setHealth({ blocked: true, blockedAgoHours: 1 });
  assert.strictEqual(await health.isBackedOff(NODE, FONTE, 6), true);
});

test('blocco VECCHIO (> Nh) → back-off scaduto (riprova)', async () => {
  await setHealth({ blocked: true, blockedAgoHours: 10 });
  assert.strictEqual(await health.isBackedOff(NODE, FONTE, 6), false);
});

test('fonte non bloccata → niente back-off', async () => {
  await db.query('DELETE FROM crawl_health WHERE node=$1', [NODE]);
  await db.query(
    `INSERT INTO crawl_health (node, fonte, last_event_at, last_outcome, blocked) VALUES ($1,$2, now(), 'ok', false)`,
    [NODE, FONTE]
  );
  assert.strictEqual(await health.isBackedOff(NODE, FONTE, 6), false);
});
