-- F50 copertura — indice per il count `ingeriti` di queries.coverage().
-- coverage() esegue, per ogni (target,fonte) latest in market_size, un
--   count(*) FROM listings WHERE fonte=? AND tipo=? AND marca=? AND modello=? AND status='active'
-- (fino a 300 LATERAL per refresh della CoverageScreen). Senza un indice che copra
-- queste 4 colonne d'uguaglianza era una scansione per-modello → rischio statement_timeout.
-- Parziale su status='active' = esattamente le righe contate (archivio `gone` escluso).
CREATE INDEX IF NOT EXISTS idx_listings_coverage
  ON listings (tipo, marca, modello, fonte)
  WHERE status = 'active';
