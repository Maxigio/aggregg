-- Contatore assenze consecutive per il rilevamento "venduto" robusto (K=2):
-- ogni sweep RIUSCITA che non rivede un annuncio attivo → miss_count++;
-- rivisto → azzerato; miss_count >= 2 → status='gone'.
ALTER TABLE listings ADD COLUMN IF NOT EXISTS miss_count INT NOT NULL DEFAULT 0;
