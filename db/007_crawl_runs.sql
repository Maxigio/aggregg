-- F12 — log-run persistente: ogni sweep iMac lascia una riga (radice della
-- dashboard onesta → niente più "ultimo sweep" letto da una var in-memory che
-- il restart azzera). started_at/finished_at NULL = run ancora in corso.
CREATE TABLE IF NOT EXISTS crawl_runs (
  id          SERIAL PRIMARY KEY,
  node        TEXT NOT NULL DEFAULT 'imac',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  targets     INT NOT NULL DEFAULT 0,
  written     INT NOT NULL DEFAULT 0,
  errors      INT NOT NULL DEFAULT 0
);
-- "ultimo run per nodo" = ORDER BY started_at DESC LIMIT 1 con questo indice.
CREATE INDEX IF NOT EXISTS idx_crawl_runs_node_started ON crawl_runs (node, started_at DESC);

-- F13 — venduto sui popolari: marcatore per-target "l'ultima sweep ha troncato?".
-- true → il crawler usa CRAWLER_PAGES_MAX al prossimo giro (escalation chirurgica
-- solo su chi tronca). Finché truncated, markGone resta spento DA SÉ (gate !truncated).
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS last_truncated BOOL;
-- Opzionale: quando la vista è COMPLETA su tutte le fonti del target → "popolato".
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS last_complete_at TIMESTAMPTZ;
