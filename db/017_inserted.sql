-- F60 M-E — onestà "written": distinguere righe NUOVE da quelle solo ri-aggiornate.
-- `inserted` = veri INSERT (xmax=0) del crawl; `written` resta = righe toccate (upsert).
-- Così la dashboard mostra "X nuovi · Y aggiornati" invece di "21 scritti" fuorviante
-- (l'upsert ON CONFLICT DO UPDATE riscrive tutto a ogni sweep).
ALTER TABLE crawl_runs  ADD COLUMN IF NOT EXISTS inserted INT;
ALTER TABLE crawl_queue ADD COLUMN IF NOT EXISTS inserted INT;
