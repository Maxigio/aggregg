-- F60 fix-review — un job 'cancel_requested' è ANCORA attivo (il drainer sta
-- finendo lo sweep in corso), quindi va incluso nel dedupe: senza, accodare lo
-- stesso target mentre lo si annulla creava un doppione (poi crawlato due volte).
DROP INDEX IF EXISTS uq_crawl_queue_active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_crawl_queue_active
  ON crawl_queue (tipo, marca, modello)
  WHERE status IN ('pending', 'running', 'cancel_requested');
