-- F50 copertura ground-truth — dimensione di mercato per (target, fonte) nel tempo.
-- Il crawler, a ogni sweep, registra QUANTI annunci la fonte HA per il target
-- (Subito count_all · Moto.it "N annunci" · AS24 listingsByQueryString.totalItems).
-- = TETTO della copertura: total vs ingeriti = quanto manca. Timeseries (append) →
-- copertura "adesso" = latest per target (DISTINCT ON), + storia della dimensione mercato.
CREATE TABLE IF NOT EXISTS market_size (
  id      BIGSERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  tipo    TEXT,
  marca   TEXT,
  modello TEXT,
  fonte   TEXT NOT NULL,          -- 'subito' | 'moto' | 'autoscout'
  total   INT  NOT NULL           -- annunci che la fonte HA per la query
);
CREATE INDEX IF NOT EXISTS idx_market_size_target ON market_size (tipo, marca, modello, fonte, ts DESC);
