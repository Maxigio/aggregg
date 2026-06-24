-- F60 — coda crawl MANUALE. La TUI owner ENQUEUE (DB-puro, SQL rispecchiato in
-- tools/owner/amradmin/actions.py); il drainer one-shot (scripts/crawl-once.js)
-- DRENA: pickNext → sweepTarget → markDone|markFail. Rimpiazza lo scheduler 24h
-- (ora gated dietro CRAWLER_AUTO, default OFF).
--   status: pending → running → done|fail (|cancel_requested).
--   watchlist_id NULL = target AD-HOC (non in watchlist) → no markSwept dopo.
--   heartbeat + reclaim 15min = stessa logica del lease worker (crash-recovery).
CREATE TABLE IF NOT EXISTS crawl_queue (
  id             BIGSERIAL PRIMARY KEY,
  tipo           TEXT NOT NULL,                -- 'auto' | 'moto'
  marca          TEXT NOT NULL,
  modello        TEXT NOT NULL,
  watchlist_id   INT,                          -- NULL = ad-hoc; se presente → markSwept dopo il crawl
  last_truncated BOOL,                         -- propaga l'escalation cap (DEEP_PAGES_MAX) per i re-run
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','running','done','fail','cancel_requested')),
  priority       INT NOT NULL DEFAULT 0,       -- ordinamento: più alto = prima
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  heartbeat      TIMESTAMPTZ,                  -- battito del drainer; stale > 15min = reclaim
  written        INT NOT NULL DEFAULT 0,
  error          TEXT
);
-- pick: pending in ordine priorità poi FIFO
CREATE INDEX IF NOT EXISTS idx_crawl_queue_pick
  ON crawl_queue (priority DESC, enqueued_at) WHERE status = 'pending';
-- dedupe: un solo job ATTIVO per (tipo,marca,modello) → no 5× dello stesso target
CREATE UNIQUE INDEX IF NOT EXISTS uq_crawl_queue_active
  ON crawl_queue (tipo, marca, modello) WHERE status IN ('pending','running');
