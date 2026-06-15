'use strict';
/**
 * F12 — log persistente degli sweep (tabella `crawl_runs`). Sostituisce lo stato
 * in-memory `lastStats` del crawler (che il restart azzerava → dashboard bugiarda).
 *
 * - startRun(node): apre una riga (finished_at NULL = in corso) → id.
 * - finishRun(id, {targets,written,errors}): chiude la riga col riepilogo reale.
 * - lastRun(node): ultimo run del nodo (per la dashboard).
 */
const db = require('./index');

async function startRun(node = 'imac') {
  if (!db.isEnabled()) return null;
  const r = await db.query(
    `INSERT INTO crawl_runs (node) VALUES ($1) RETURNING id`,
    [node]
  );
  return r && r.rows.length ? r.rows[0].id : null;
}

async function finishRun(id, { targets = 0, written = 0, errors = 0 } = {}) {
  if (!db.isEnabled() || !id) return;
  await db.query(
    `UPDATE crawl_runs
        SET finished_at = now(), targets = $2, written = $3, errors = $4
      WHERE id = $1`,
    [id, targets, written, errors]
  );
}

async function lastRun(node = 'imac') {
  if (!db.isEnabled()) return null;
  const r = await db.query(
    `SELECT id, node, started_at, finished_at, targets, written, errors
       FROM crawl_runs WHERE node = $1 ORDER BY started_at DESC LIMIT 1`,
    [node]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

module.exports = { startRun, finishRun, lastRun };
