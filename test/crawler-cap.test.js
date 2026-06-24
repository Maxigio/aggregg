'use strict';
// M-C/2 — capForTarget PURO (profondità per-run). No rete, no DB: testa SOLO il clamp
// 'full'(9999)→tetto di sicurezza e il fallback F13. Difende l'anti-runaway: se un
// regress togliesse Math.min, un :run full crawlerebbe 9999 pagine e qui si rompe.
const { test } = require('node:test');
const assert = require('node:assert');
const { _capForTarget: cap } = require('../backend/crawler');

// stesse default del crawler (env non settato nei test)
const FULL = parseInt(process.env.CRAWLER_PAGES_FULL || '200', 10) || 200;
const DEEP = parseInt(process.env.CRAWLER_PAGES || '10', 10);
const DEEPMAX = parseInt(process.env.CRAWLER_PAGES_MAX || '30', 10);

test('capForTarget: maxPages clampato al tetto di sicurezza (full=9999 → FULL)', () => {
  assert.strictEqual(cap({ maxPages: 9999 }), FULL, "'full' clampa al safety cap");
  assert.strictEqual(cap({ maxPages: FULL + 100 }), FULL, 'sopra il tetto → tetto');
  assert.strictEqual(cap({ maxPages: 5 }), 5, 'sotto il tetto → passa intatto');
  assert.ok(cap({ maxPages: 9999 }) < 9999, 'mai 9999 pagine (anti-runaway)');
});

test('capForTarget: senza maxPages → default F13 (esteso se troncò)', () => {
  assert.strictEqual(cap({}), DEEP, 'nessun override → cap medio');
  assert.strictEqual(cap({ last_truncated: true }), DEEPMAX, 'troncò → cap esteso');
  assert.strictEqual(cap({ maxPages: 0 }), DEEP, '0 è falsy → default (NON zero pagine)');
});
