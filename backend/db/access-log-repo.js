'use strict';
/**
 * F50 Fase 4 — log eventi/accessi (tabella `access_log`).
 *
 * record(event, {role, ip, ua, query, resultCount}): un INSERT best-effort.
 * Il logging NON deve MAI rompere login/ricerca → try/catch interno e no-op se il
 * DB è giù. Append-only (un evento = una riga). Letto SOLO dall'owner-tool DB-puro.
 */
const db = require('./index');

async function record(event, { role = null, ip = null, ua = null, query = null, resultCount = null } = {}) {
  if (!db.isEnabled() || !event) return;
  try {
    // il try/catch copre ANCHE il JSON.stringify sincrono qui sotto (db.query da
    // solo non lo proteggerebbe: il throw avverrebbe costruendo gli argomenti).
    await db.query(
      `INSERT INTO access_log (event, role, ip, user_agent, query, result_count)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [event, role, ip, ua, query != null ? JSON.stringify(query) : null, resultCount]
    );
  } catch (e) {
    console.error('[access-log] record fallita:', e.message);   // mai propagare
  }
}

// Retention: cancella eventi più vecchi di `days`. NON schedulato (come il backup
// va messo in un job launchd/cron); per ora chiamabile a mano. Ritorna righe rimosse.
async function prune(days = 90) {
  if (!db.isEnabled()) return 0;
  const r = await db.query(
    `DELETE FROM access_log WHERE ts < now() - make_interval(days => $1)`,
    [days]
  );
  return r ? r.rowCount : 0;
}

module.exports = { record, prune };
