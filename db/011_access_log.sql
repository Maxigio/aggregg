-- F50 Fase 4 — log eventi/accessi (append-only).
-- Il server registra qui CHI si connette (login full/demo) e COSA cerca (search),
-- così l'owner-tool (DB-puro) può mostrarlo. Niente account/username nel sistema:
-- role='full' = owner, role='demo' = utenti demo ("provademo2026"), distinti per
-- ip+user_agent+ts. Solo locale, MAI esposto via rotta pubblica.
CREATE TABLE IF NOT EXISTS access_log (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
  event        TEXT NOT NULL,        -- 'login_ok' | 'login_fail' | 'search'
  role         TEXT,                 -- 'full' | 'demo' | NULL (login_fail: password errata)
  ip           TEXT,
  user_agent   TEXT,
  query        JSONB,                -- per event='search': parametri ricerca normalizzati
  result_count INT                   -- per event='search': n. risultati
);
CREATE INDEX IF NOT EXISTS idx_access_log_ts      ON access_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_role_ts ON access_log (role, ts DESC);
