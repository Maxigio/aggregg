'use strict';
/**
 * Salute crawler / rilevamento ban (F1.5). Riassunto per-fonte in `crawl_health`.
 *
 * - classifyOutcome(err, count): categorizza un esito di fetch (PURA, testabile).
 * - record(fonte, {error, count}): aggiorna i contatori + flag blocked/degraded.
 *   blocked = ban-class (403/429/non-JSON); degraded = fallimenti transient
 *   ripetuti (rete/server, NON ban). Loud-log alla transizione a blocked.
 * - getHealth(): righe + sommario {ok, blocked[], degraded[]}.
 */
const db = require('./index');

const KINDS = new Set(['blocked', 'auth', 'transient', 'error']);

// Categoria di un esito. Usa err.kind/err.status (taggati dagli scraper); regex
// sul messaggio solo come fallback (robusto a cambi di testo).
function classifyOutcome(error, count = 0) {
  if (!error) return count > 0 ? 'ok' : 'empty';
  if (error.kind && KINDS.has(error.kind)) return error.kind;
  const s = error.status;
  if (s === 403 || s === 429) return 'blocked';
  if (s === 401) return 'auth';
  if (typeof s === 'number' && s >= 500) return 'transient';
  const m = String(error.message || '');
  if (/non-?json|blocco|\b403\b|\b429\b/i.test(m)) return 'blocked';
  if (/\b401\b|credenziale/i.test(m)) return 'auth';
  if (/timeout|ECONN|socket|network|HTTP 5\d\d/i.test(m)) return 'transient';
  return 'error';
}

const DEGRADE_AT = 3;   // fallimenti transient/error consecutivi → degraded

async function record(fonte, { error = null, count = 0 } = {}) {
  if (!db.isEnabled()) return null;
  const outcome = classifyOutcome(error, count);

  const prevRes = await db.query('SELECT * FROM crawl_health WHERE fonte=$1', [fonte]);
  const prev = (prevRes && prevRes.rows[0]) || {};
  let consec = prev.consec_fail || 0;
  let okC = prev.ok_count || 0, emptyC = prev.empty_count || 0;
  let blkC = prev.blocked_count || 0, errC = prev.error_count || 0;
  let blocked = prev.blocked || false, degraded = prev.degraded || false;
  let setLastOk = false, setLastBlocked = false;

  if (outcome === 'ok') {
    consec = 0; blocked = false; degraded = false; okC++; setLastOk = true;
  } else if (outcome === 'empty') {
    emptyC++;                      // neutro: non fallimento, non successo
  } else if (outcome === 'blocked') {
    blkC++; consec++; blocked = true; setLastBlocked = true;
  } else {                         // transient | error | auth
    errC++; consec++;
    if (consec >= DEGRADE_AT) degraded = true;
  }
  const becameBlocked = outcome === 'blocked' && !prev.blocked;

  await db.query(
    `INSERT INTO crawl_health
       (fonte, last_ok, last_event_at, last_outcome, last_blocked_at,
        consec_fail, ok_count, empty_count, blocked_count, error_count, blocked, degraded)
     VALUES ($1,
        CASE WHEN $2 THEN now() ELSE NULL END, now(), $3,
        CASE WHEN $4 THEN now() ELSE NULL END,
        $5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (fonte) DO UPDATE SET
        last_ok        = CASE WHEN $2 THEN now() ELSE crawl_health.last_ok END,
        last_event_at  = now(),
        last_outcome   = $3,
        last_blocked_at= CASE WHEN $4 THEN now() ELSE crawl_health.last_blocked_at END,
        consec_fail    = $5, ok_count = $6, empty_count = $7,
        blocked_count  = $8, error_count = $9, blocked = $10, degraded = $11`,
    [fonte, setLastOk, outcome, setLastBlocked, consec, okC, emptyC, blkC, errC, blocked, degraded]
  );

  if (becameBlocked) {
    const code = error && error.status ? ' ' + error.status : '';
    console.error(`🔴 [health] POSSIBILE BLOCCO su ${fonte} (${outcome}${code}) — crawler continua ma controlla /api/crawler/health`);
  }
  return outcome;
}

async function getHealth() {
  if (!db.isEnabled()) return { ok: true, enabled: false, blocked: [], degraded: [], fonti: [] };
  const r = await db.query('SELECT * FROM crawl_health ORDER BY fonte');
  const rows = (r && r.rows) || [];
  const blocked = rows.filter(x => x.blocked).map(x => x.fonte);
  const degraded = rows.filter(x => x.degraded).map(x => x.fonte);
  return { ok: blocked.length === 0, enabled: true, blocked, degraded, fonti: rows };
}

module.exports = { classifyOutcome, record, getHealth };
