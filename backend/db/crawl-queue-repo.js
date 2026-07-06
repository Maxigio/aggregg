'use strict';
/**
 * F60 — coda crawl manuale (tabella crawl_queue). La TUI owner ENQUEUE (DB-puro,
 * SQL rispecchiato in tools/owner/amradmin/actions.py); il drainer one-shot
 * (scripts/crawl-once.js) DRENA: pickNext → sweepTarget → markDone|markFail.
 * Best-effort come gli altri repo (db.query → null se DB giù; mai throw).
 */
const db = require('./index');

const STALE_MIN = 15;   // heartbeat oltre cui un 'running' è considerato morto (= lease worker)

// Enqueue idempotente: un solo job ATTIVO per (tipo,marca,modello) via uq_crawl_queue_active
// (ON CONFLICT DO NOTHING senza target → cattura anche l'indice unico PARZIALE).
async function enqueue(target, { priority = 0, pages = null } = {}) {
  if (!db.isEnabled() || !target || !target.tipo || !target.marca || !target.modello) return null;
  const r = await db.query(
    `INSERT INTO crawl_queue (tipo, marca, modello, watchlist_id, last_truncated, priority, pages)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [target.tipo, target.marca, target.modello,
     target.watchlist_id != null ? target.watchlist_id : null,
     target.last_truncated != null ? target.last_truncated : null,
     priority,
     Number.isInteger(pages) ? pages : null]
  );
  return r && r.rows.length ? r.rows[0].id : null;
}

// Prende il prossimo job: flip ATOMICO pending→running (FOR UPDATE SKIP LOCKED).
async function pickNext() {
  if (!db.isEnabled()) return null;
  const r = await db.query(
    `WITH next AS (
       SELECT id FROM crawl_queue
        WHERE status = 'pending'
        ORDER BY priority DESC, enqueued_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1)
     UPDATE crawl_queue q
        SET status = 'running', started_at = now(), heartbeat = now()
       FROM next WHERE q.id = next.id
     RETURNING q.id, q.tipo, q.marca, q.modello, q.watchlist_id, q.last_truncated, q.pages,
               (SELECT w.saturated_at FROM watchlist w WHERE w.id = q.watchlist_id) AS saturated_at`
  );
  return r && r.rows.length ? r.rows[0] : null;
}

async function markDone(id, { written = 0, inserted = 0 } = {}) {
  if (!db.isEnabled() || !id) return;
  await db.query(
    `UPDATE crawl_queue SET status='done', finished_at=now(), heartbeat=now(), written=$2, inserted=$3 WHERE id=$1`,
    [id, written, inserted]);
}

async function markFail(id, error) {
  if (!db.isEnabled() || !id) return;
  await db.query(
    `UPDATE crawl_queue SET status='fail', finished_at=now(), error=$2 WHERE id=$1`,
    [id, String(error == null ? '' : error).slice(0, 500)]);
}

// Avvio drainer: i 'running' con heartbeat vecchio = job di un drainer crashato → ripristina pending.
async function reclaimStale(minutes = STALE_MIN) {
  if (!db.isEnabled()) return 0;
  const stale = `(heartbeat IS NULL OR heartbeat < now() - ($1 * interval '1 minute'))`;
  // running stantio (drainer morto) → torna pending, ri-crawlabile
  const r1 = await db.query(
    `UPDATE crawl_queue SET status='pending', started_at=NULL, heartbeat=NULL
      WHERE status='running' AND ${stale}`, [minutes]);
  // review: cancel_requested stantio = drainer morto DURANTE l'annullo (un cancel_requested viene
  // SOLO da un running → ha sempre heartbeat). Senza questo resta 'attivo' nell'indice unico
  // uq_crawl_queue_active e né cancel() né clear_pending lo toccano → re-enqueue del target
  // bloccato per sempre. L'utente voleva annullarlo → chiudilo 'fail', non ri-eseguirlo.
  const r2 = await db.query(
    `UPDATE crawl_queue SET status='fail', finished_at=now(), error='annullato (drainer interrotto)'
      WHERE status='cancel_requested' AND ${stale}`, [minutes]);
  return (r1 ? r1.rowCount : 0) + (r2 ? r2.rowCount : 0);
}

async function isCancelRequested(id) {
  if (!db.isEnabled() || !id) return false;
  const r = await db.query(`SELECT 1 FROM crawl_queue WHERE id=$1 AND status='cancel_requested'`, [id]);
  return !!(r && r.rows.length);
}

module.exports = { enqueue, pickNext, markDone, markFail, reclaimStale, isCancelRequested, STALE_MIN };
