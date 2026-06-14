-- F5 — partizione statica multi-nodo: ogni target appartiene a UN nodo.
-- NULL = di proprietà dell'iMac (default). Set disgiunti per costruzione →
-- zero overlap tra i nodi (il lease resta solo per concorrenza-stesso-nodo + recovery).
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS assigned_node TEXT;
-- Indice per i filtri-nodo del lease/due (assigned_node = $dev OR (NULL AND $dev='imac')).
CREATE INDEX IF NOT EXISTS idx_watchlist_assigned_node ON watchlist (assigned_node);
