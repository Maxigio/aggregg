'use strict';
// M-M — corsia refresh (pagina-1) per i target saturi. `shouldRefresh` è la DECISIONE
// (pura, niente DB/rete → sempre eseguita). La SQL di saturazione (markSwept refresh) è
// testata in watchlist-repo.test.js (file proprietario di watchlist → no race su TRUNCATE).
const { test } = require('node:test');
const assert = require('node:assert');

const { shouldRefresh } = require('../scripts/crawl-once');

const NOW = 1_700_000_000_000;            // istante fisso → niente flake
const daysAgo = d => new Date(NOW - d * 86400000).toISOString();

test('shouldRefresh: saturo DI RECENTE (2g) senza gap → refresh', () => {
  assert.strictEqual(shouldRefresh({ saturated_at: daysAgo(2) }, NOW), true);
});

test('shouldRefresh: saturazione SCADUTA (10g > 7) → no refresh (deep crawl per il venduto)', () => {
  assert.strictEqual(shouldRefresh({ saturated_at: daysAgo(10) }, NOW), false);
});

test('shouldRefresh: mai saturato → no refresh (crawl pieno)', () => {
  assert.strictEqual(shouldRefresh({ saturated_at: null }, NOW), false);
  assert.strictEqual(shouldRefresh({}, NOW), false);
});

test('shouldRefresh: profondità esplicita (:run …full|pN) batte la saturazione', () => {
  assert.strictEqual(shouldRefresh({ saturated_at: daysAgo(2), pages: 60 }, NOW), false);
});

test('shouldRefresh: tronca (gap reale) → no refresh (deep crawl)', () => {
  assert.strictEqual(shouldRefresh({ saturated_at: daysAgo(2), last_truncated: true }, NOW), false);
});

test('shouldRefresh: saturated_at nel FUTURO (clock skew) → no refresh', () => {
  assert.strictEqual(shouldRefresh({ saturated_at: daysAgo(-1) }, NOW), false);
});
