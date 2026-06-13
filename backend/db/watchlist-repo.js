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
  // Ramp 1×/giorno: se c'è già stata un'attivazione nelle ultime ~20h, NON
  // attivare altri (evita over-ramp quando l'app viene riavviata più volte/giorno).
  const recent = await db.query(
    `SELECT 1 FROM watchlist WHERE activated_at > now() - interval '20 hours' LIMIT 1`
  );
  if (recent && recent.rows.length) return [];
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
  // Solo target NON spazzolati nelle ultime ~20h → cadenza 1×/giorno a prescindere
  // dai riavvii dell'app (un relaunch in giornata trova 0 due → sweep no-op).
  const r = await db.query(
    `SELECT id, tipo, marca, modello FROM watchlist
      WHERE activated_at IS NOT NULL AND enabled = true
        AND (last_swept IS NULL OR last_swept < now() - interval '20 hours')
        AND (leased_until IS NULL OR leased_until < now())   -- non toccare i target leasati da un worker
      ORDER BY last_swept NULLS FIRST, id`
  );
  return r ? r.rows : [];
}

// F3 — lease atomico di UN target mai crawlato (per il worker distribuito).
// FOR UPDATE SKIP LOCKED → due richieste concorrenti prendono target diversi.
async function leaseTarget(device) {
  if (!db.isEnabled() || !device) return null;
  let client;
  try { client = await db.getClient(); } catch (_) { return null; }
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, tipo, marca, modello FROM watchlist
        WHERE last_swept IS NULL AND enabled = true
          AND (leased_until IS NULL OR leased_until < now())
        ORDER BY id LIMIT 1
        FOR UPDATE SKIP LOCKED`
    );
    if (!r.rows.length) { await client.query('COMMIT'); return null; }
    const t = r.rows[0];
    await client.query(
      `UPDATE watchlist SET leased_by=$1, leased_until = now() + interval '15 minutes' WHERE id=$2`,
      [device, t.id]
    );
    await client.query('COMMIT');
    return t;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[watchlist] leaseTarget KO:', e.message);
    return null;
  } finally {
    client.release();
  }
}

// F3 — target completato dal worker: marca swept/attivato, libera il lease.
async function completeTarget(id) {
  if (!db.isEnabled()) return;
  await db.query(
    `UPDATE watchlist
        SET last_swept = now(),
            activated_at = COALESCE(activated_at, now()),
            leased_by = NULL, leased_until = NULL
      WHERE id = $1`,
    [id]
  );
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

module.exports = { insertTargets, seedFromFile, activateRamp, dueTargets, markSwept, counts, leaseTarget, completeTarget };
