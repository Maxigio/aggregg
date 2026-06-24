-- F60 coverage-driven — "saturazione": un target il cui ultimo crawl ha ri-preso
-- l'esistente senza NULLA di nuovo (written>0 AND inserted=0) è SATURO: ri-crawlarlo
-- spreca richieste. Il suggeritore lo salta (richeck dopo SATURATED_DAYS); torna NULL
-- appena un crawl porta righe nuove. Guard written>0 = niente falsa-saturazione su
-- crawl vuoto/errore. Lo timbra watchlist-repo.markSwept dal drainer.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS saturated_at TIMESTAMPTZ;
