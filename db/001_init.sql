-- F1 — schema iniziale data-platform prezzi.
-- Idempotente (IF NOT EXISTS): il runner applica una volta sola via _migrations,
-- ma le tabelle restano sicure a riesecuzione.

CREATE TABLE IF NOT EXISTS listings (
  url         TEXT PRIMARY KEY,
  fonte       TEXT,                 -- 'autoscout' | 'subito' | 'moto'
  tipo        TEXT,                 -- 'auto' | 'moto'
  marca       TEXT,
  modello     TEXT,
  model_key   TEXT,                 -- tipo|marca|modello|fascia_anno|fascia_km
  anno        INT,
  km          INT,
  nuovo       BOOLEAN,
  danni       BOOLEAN,              -- AS24: usageState in (HadAccident,Wreck); Subito: NULL
  posted_at   TIMESTAMPTZ,          -- data pubblicazione dalla fonte (se esposta)
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_price  INT,
  status      TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'gone' (gone ≈ venduto)
  gone_at     TIMESTAMPTZ,
  raw_json    JSONB                 -- ultima foto grezza (keep-last, sovrascritta)
);

CREATE TABLE IF NOT EXISTS price_points (
  url     TEXT NOT NULL REFERENCES listings(url) ON DELETE CASCADE,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  prezzo  INT NOT NULL
);

-- Watch-list dei target del crawler (curata + ramp 10/giorno).
CREATE TABLE IF NOT EXISTS watchlist (
  id           SERIAL PRIMARY KEY,
  tipo         TEXT NOT NULL,       -- 'auto' | 'moto'
  marca        TEXT NOT NULL,
  modello      TEXT NOT NULL,
  activated_at TIMESTAMPTZ,         -- NULL = non ancora in rotazione
  last_swept   TIMESTAMPTZ,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (tipo, marca, modello)
);

CREATE INDEX IF NOT EXISTS idx_price_points_url_ts ON price_points (url, ts);
CREATE INDEX IF NOT EXISTS idx_listings_modelkey   ON listings (model_key, status, nuovo);
CREATE INDEX IF NOT EXISTS idx_listings_status_seen ON listings (status, last_seen);
