-- F50 Fase 1 — schema veicolo COMPLETO.
-- Gli scraper GIA' producono questi campi al top-level dell'output (verificato in
-- subito-api/autoscout-graphql/motoit mapper) ma upsertListings finora ne persisteva
-- solo 13 → il resto andava perso (solo in raw_json). Qui aggiungiamo le colonne per
-- tenerli queryabili: e' la base di ogni analisi di mercato (specie regionale).
-- Idempotente (ADD COLUMN IF NOT EXISTS). regione = DERIVATA da provincia/cap.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS versione         TEXT,
  ADD COLUMN IF NOT EXISTS regione          TEXT,
  ADD COLUMN IF NOT EXISTS provincia        TEXT,
  ADD COLUMN IF NOT EXISTS cap              TEXT,
  ADD COLUMN IF NOT EXISTS venditore        TEXT,     -- 'concessionario' | 'privato'
  ADD COLUMN IF NOT EXISTS carburante       TEXT,
  ADD COLUMN IF NOT EXISTS cambio           TEXT,
  ADD COLUMN IF NOT EXISTS potenza_cv       INT,
  ADD COLUMN IF NOT EXISTS cilindrata       INT,
  ADD COLUMN IF NOT EXISTS cilindri         INT,
  ADD COLUMN IF NOT EXISTS carrozzeria      TEXT,
  ADD COLUMN IF NOT EXISTS colore           TEXT,
  ADD COLUMN IF NOT EXISTS porte            TEXT,      -- nativo Subito "4/5" → TEXT
  ADD COLUMN IF NOT EXISTS posti            INT,
  ADD COLUMN IF NOT EXISTS classe_emissioni TEXT,
  ADD COLUMN IF NOT EXISTS neopatentati     BOOLEAN,
  ADD COLUMN IF NOT EXISTS proprietari      INT,
  ADD COLUMN IF NOT EXISTS allestimento     TEXT,
  ADD COLUMN IF NOT EXISTS revisione        TEXT,
  ADD COLUMN IF NOT EXISTS immagini         JSONB;     -- [{thumb, full}, ...]

-- Indici per le query di analisi di mercato.
CREATE INDEX IF NOT EXISTS idx_listings_regione ON listings(regione);
CREATE INDEX IF NOT EXISTS idx_listings_browse  ON listings(tipo, marca, modello, anno);
