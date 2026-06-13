-- F1.5 — salute crawler / rilevamento ban, riassunto per-fonte.
-- Una riga per fonte ('autoscout'|'subito'). Aggiornata a ogni fetch del crawler.
CREATE TABLE IF NOT EXISTS crawl_health (
  fonte           TEXT PRIMARY KEY,
  last_ok         TIMESTAMPTZ,
  last_event_at   TIMESTAMPTZ,
  last_outcome    TEXT,                 -- ok|empty|blocked|auth|transient|error
  last_blocked_at TIMESTAMPTZ,
  consec_fail     INT NOT NULL DEFAULT 0,
  ok_count        INT NOT NULL DEFAULT 0,
  empty_count     INT NOT NULL DEFAULT 0,
  blocked_count   INT NOT NULL DEFAULT 0,
  error_count     INT NOT NULL DEFAULT 0,
  blocked         BOOLEAN NOT NULL DEFAULT false,   -- ban-class corrente
  degraded        BOOLEAN NOT NULL DEFAULT false    -- fallimenti transient ripetuti (NON ban)
);
