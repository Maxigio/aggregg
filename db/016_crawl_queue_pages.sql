-- F60 M-C/2 — profondità scelta per-run: quante pagine crawlare per questo job.
-- NULL = default (DEEP_PAGES/MAX del crawler); N = N pagine; 'full' dalla TUI è
-- mappato al tetto di sicurezza (CRAWLER_PAGES_FULL). Il drainer la passa a sweepTarget.
ALTER TABLE crawl_queue ADD COLUMN IF NOT EXISTS pages INT;
