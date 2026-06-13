-- F3 — salute per-nodo: distingue gli IP (iMac vs worker Surface).
-- Un blocco è per-IP → la chiave salute diventa (node, fonte).
ALTER TABLE crawl_health ADD COLUMN IF NOT EXISTS node TEXT NOT NULL DEFAULT 'imac';
ALTER TABLE crawl_health DROP CONSTRAINT IF EXISTS crawl_health_pkey;
ALTER TABLE crawl_health ADD PRIMARY KEY (node, fonte);
