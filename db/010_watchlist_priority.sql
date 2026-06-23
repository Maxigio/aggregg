-- F50 Fase 2 — priorità di attivazione per LIQUIDITÀ di mercato.
-- La watchlist è la coda dei target; il ramp ne attiva pochi/giorno. Con il
-- catalogo intero (~14k) in coda, CONTA quali attivare prima. `priority` =
-- annunci totali della MARCA su Autoscout (data/models.json autoscout.totalAnnunci;
-- la liquidità esiste solo a livello marca, NON per-modello → verificato).
-- Materializzata sulla riga perché il catalogo è un file JSON, non joinabile in SQL.
-- Idempotente.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS priority INT;

-- Indice parziale che serve il window del ramp (activateRamp): solo le righe
-- ancora da attivare, partizionate per tipo (interleave auto/moto) e ordinate
-- per liquidità desc poi id. Lead con `tipo` per servire il PARTITION BY.
CREATE INDEX IF NOT EXISTS idx_watchlist_ramp
  ON watchlist (tipo, priority DESC NULLS LAST, id)
  WHERE activated_at IS NULL AND enabled;
