'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Isola la persistenza in una temp dir (saved.js usa USER_DATA_PATH).
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-saved-'));
const saved = require('../backend/saved');

const R = (url, prezzo, extra = {}) => ({ url, prezzo, anno: 2018, km: 80000, titolo: 'BMW 320d', ...extra });

test('computeAlerts: primo check (baseline) non genera avvisi', () => {
  const { alerts } = saved.computeAlerts({ seen: {}, alerted: [] }, [R('a', 10000), R('b', 9000)]);
  assert.strictEqual(alerts.length, 0);
});

test('computeAlerts: floor anti-scam scarta il prezzo-spazzatura', () => {
  const search = { seen: { x: 10000 }, alerted: [] };   // seen non-vuoto → non baseline
  const results = [R('x', 10000), R('y', 9500), R('scam', 500)];
  const { alerts } = saved.computeAlerts(search, results);
  assert.ok(!alerts.some(a => a.url === 'scam'), 'lo scam 500 non deve generare avvisi');
});

test('computeAlerts: dati incompleti (no anno/km) scartati', () => {
  const search = { seen: { x: 10000 }, alerted: [] };
  const { alerts } = saved.computeAlerts(search, [R('new1', 9000, { anno: null })]);
  assert.strictEqual(alerts.length, 0);
});

test('computeAlerts: nuovo + calo', () => {
  const search = { seen: { old: 10000 }, alerted: [] };
  const results = [R('old', 9000), R('new1', 9500)];   // old: calo 10000→9000; new1: nuovo
  const { alerts } = saved.computeAlerts(search, results);
  const motivi = Object.fromEntries(alerts.map(a => [a.url, a.motivo]));
  assert.strictEqual(motivi.old, 'calo');
  assert.strictEqual(motivi.new1, 'nuovo');
});

test('computeAlerts: dedup via alerted (niente ri-notifica)', () => {
  const search = { seen: { old: 10000 }, alerted: ['new1|nuovo'] };
  const { alerts } = saved.computeAlerts(search, [R('new1', 9500)]);
  assert.strictEqual(alerts.length, 0);
});

test('fingerprint stabile a parità di risultati, diverso al cambio prezzo', () => {
  const a = saved.fingerprint([R('a', 10000), R('b', 9000)]);
  const b = saved.fingerprint([R('a', 10000), R('b', 9000)]);
  const c = saved.fingerprint([R('a', 10000), R('b', 8000)]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test('CRUD + recordCheck: baseline silenziosa, poi nuovo', () => {
  const s = saved.addSaved({ params: { tipo: 'auto', marca: 'BMW' } });
  assert.ok(s.id);
  const base = [R('a', 10000), R('b', 9000), R('c', 9500)];
  assert.strictEqual(saved.recordCheck(s.id, base).length, 0, 'baseline = 0 avvisi');
  const next = [...base, R('d', 8800)];
  const al = saved.recordCheck(s.id, next);
  assert.deepStrictEqual(al.map(a => a.motivo), ['nuovo']);
  assert.ok(saved.removeSaved(s.id));
});
