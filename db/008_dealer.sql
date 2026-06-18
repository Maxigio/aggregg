-- F32 Fase 2 — Console Concessionario: parco di papà (auto-importato dalla pagina
-- AS24, customerId 9345705) + snapshot delle valutazioni (per storico #7 + diff avvisi).

-- Parco veicoli del concessionario. url = annuncio AS24 (chiave naturale).
CREATE TABLE IF NOT EXISTS dealer_stock (
  url         TEXT PRIMARY KEY,
  customer_id TEXT,
  tipo        TEXT,                 -- 'auto' | 'moto'
  marca       TEXT,
  modello     TEXT,
  anno        INT,
  km          INT,
  my_price    INT,                  -- prezzo a cui papà lo vende (priceRaw AS24)
  posted_at   TIMESTAMPTZ,          -- data pubblicazione annuncio (se esposta); per l'età reale
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),   -- primo import nostro
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),   -- ultimo import in cui era ancora presente
  status      TEXT NOT NULL DEFAULT 'active',       -- active | sold | withdrawn (sparito dalla pagina)
  sold_at     TIMESTAMPTZ,
  note        TEXT,                 -- nota libera di papà (ruolo dealer)
  raw_json    JSONB                 -- payload grezzo dell'annuncio (recupero campi futuri)
);
CREATE INDEX IF NOT EXISTS idx_dealer_stock_status ON dealer_stock (status);

-- Snapshot valutazione per veicolo nel tempo: storico + base per il diff degli avvisi (#7).
-- rival_urls = set degli URL concorrenti like-for-like al momento → "nuovo concorrente"
-- si calcola dal diff con lo snapshot precedente (senza, non è rilevabile).
CREATE TABLE IF NOT EXISTS valuations (
  id          SERIAL PRIMARY KEY,
  stock_url   TEXT NOT NULL REFERENCES dealer_stock(url) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  n           INT,
  p25         INT,
  mediana     INT,
  p75         INT,
  region_used TEXT,
  tightness   TEXT,
  troncato    BOOL,
  rival_urls  TEXT[]
);
CREATE INDEX IF NOT EXISTS idx_valuations_stock_ts ON valuations (stock_url, ts DESC);
