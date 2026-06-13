-- F3 — lease per il fill distribuito (coordinamento iMac ↔ worker).
-- Un target "preso" da un device per leased_until → nessun altro lo crawla.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS leased_by    TEXT;
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ;
