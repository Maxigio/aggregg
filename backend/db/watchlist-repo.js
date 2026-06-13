'use strict';
/**
 * Gestione tabella `watchlist` (target del crawler) + ramp.
 *
 * - seedFromFile / syncTargets: popolano la watch-list (idempotenti).
 * - activateRamp(n): mette in rotazione fino a n target ancora spenti
 *   (activated_at IS NULL) → backfill iniziale spalmato (10/giorno).
 * - dueTargets(): target attivi da spazzolare.
 * - markSwept(id): timestamp ultima sweep.
 */
const fs = require('fs');
const path = require('path');
const db = require('./index');

const SEED_FILE = path.join(__dirname, '..', '..', 'data', 'watchlist-seed.json');

// Inserisce un elenco di {tipo,marca,modello}. ON CONFLICT DO NOTHING → idempotente.
async function insertTargets(targets) {
  if (!db.isEnabled() || !Array.isArray(targets) || !targets.length) return 0;
  let n = 0;
  for (const t of targets) {
    if (!t || !t.tipo || !t.marca || !t.modello) continue;
    const r = await db.query(
      `INSERT INTO watchlist (tipo, marca, modello) VALUES ($1,$2,$3)
       ON CONFLICT (tipo, marca, modello) DO NOTHING`,
      [t.tipo, t.marca, t.modello]
    );
    if (r && r.rowCount) n += r.rowCount;
  }
  return n;
}

async function seedFromFile() {
  let seed = [];
  try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); }
  catch (e) { console.warn('[watchlist] seed non letto:', e.message); return 0; }
  return insertTargets(seed);
}

// Mette in rotazione fino a n target spenti (activated_at IS NULL). Postgres non
// ha ORDER/LIMIT diretti su UPDATE → sottoquery sugli id.
async function activateRamp(n = 10) {
  if (!db.isEnabled()) return [];
  const r = await db.query(
    `UPDATE watchlist SET activated_at = now()
      WHERE id IN (
        SELECT id FROM watchlist
         WHERE activated_at IS NULL AND enabled = true
         ORDER BY id LIMIT $1
      )
      RETURNING id, tipo, marca, modello`,
    [n]
  );
  return r ? r.rows : [];
}

async function dueTargets() {
  if (!db.isEnabled()) return [];
  const r = await db.query(
    `SELECT id, tipo, marca, modello FROM watchlist
      WHERE activated_at IS NOT NULL AND enabled = true
      ORDER BY last_swept NULLS FIRST, id`
  );
  return r ? r.rows : [];
}

async function markSwept(id) {
  if (!db.isEnabled()) return;
  await db.query('UPDATE watchlist SET last_swept = now() WHERE id = $1', [id]);
}

async function counts() {
  if (!db.isEnabled()) return { total: 0, active: 0, pending: 0 };
  const r = await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE activated_at IS NOT NULL)::int active,
            count(*) FILTER (WHERE activated_at IS NULL)::int pending
       FROM watchlist`
  );
  return r ? r.rows[0] : { total: 0, active: 0, pending: 0 };
}

module.exports = { insertTargets, seedFromFile, activateRamp, dueTargets, markSwept, counts };
