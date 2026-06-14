'use strict';
/**
 * Gestione tabella `watchlist` (target del crawler) + ramp.
 *
 * - seedFromFile / syncTargets: popolano la watch-list (idempotenti).
 * - activateRamp(n): mette in rotazione fino a n target ancora spenti
 *   (activated_at IS NULL) → backfill iniziale spalmato (10/giorno).
 * - dueTargets(): target attivi da spazzolare.
 * - markSwept(id): timestamp ultima sweep.
 */
const fs = require('fs');
const path = require('path');
const db = require('./index');

const SEED_FILE = path.join(__dirname, '..', '..', 'data', 'watchlist-seed.json');

// Inserisce un elenco di {tipo,marca,modello}. ON CONFLICT DO NOTHING → idempotente.
async function insertTargets(targets) {
  if (!db.isEnabled() || !Array.isArray(targets) || !targets.length) return 0;
  let n = 0;
  for (const t of targets) {
    if (!t || !t.tipo || !t.marca || !t.modello) continue;
    const r = await db.query(
      `INSERT INTO watchlist (tipo, marca, modello) VALUES ($1,$2,$3)
       ON CONFLICT (tipo, marca, modello) DO NOTHING`,
      [t.tipo, t.marca, t.modello]
    );
    if (r && r.rowCount) n += r.rowCount;
  }
  return n;
}

async function seedFromFile() {
  let seed = [];
  try { seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')); }
  catch (e) { console.warn('[watchlist] seed non letto:', e.message); return 0; }
  return insertTargets(seed);
}

// Mette in rotazione fino a n target spenti (activated_at IS NULL). Postgres non
// ha ORDER/LIMIT diretti su UPDATE → sottoquery sugli id.
async function activateRamp(n = 10) {
  if (!db.isEnabled()) return [];
  // Ramp 1×/giorno: se c'è già stata un'attivazione nelle ultime ~20h, NON
  // attivare altri (evita over-ramp quando l'app viene riavviata più volte/giorno).
  const recent = await db.query(
    `SELECT 1 FROM watchlist WHERE activated_at > now() - interval '20 hours' LIMIT 1`
  );
  if (recent && recent.rows.length) return [];
  const r = await db.query(
    `UPDATE watchlist SET activated_at = now()
      WHERE id IN (
        SELECT id FROM watchlist
         WHERE activated_at IS NULL AND enabled = true
         ORDER BY id LIMIT $1
      )
      RETURNING id, tipo, marca, modello`,
    [n]
  );
  return r ? r.rows : [];
}

// F5 — partizione statica: ogni nodo spazzola SOLO i suoi target.
// Filtro nodo: assigned_node = $device, oppure NULL (= di proprietà iMac) se device='imac'.
const NODE_FILTER = `(assigned_node = $1 OR (assigned_node IS NULL AND $1 = 'imac'))`;

async function dueTargets(device = 'imac') {
  if (!db.isEnabled()) return [];
  // Solo target NON spazzolati nelle ultime ~20h → cadenza 1×/giorno a prescindere
  // dai riavvii dell'app (un relaunch in giornata trova 0 due → sweep no-op).
  // F5: filtrati per nodo (l'iMac vede i suoi + i NULL).
  const r = await db.query(
    `SELECT id, tipo, marca, modello FROM watchlist
      WHERE ${NODE_FILTER}
        AND activated_at IS NOT NULL AND enabled = true
        AND (last_swept IS NULL OR last_swept < now() - interval '20 hours')
        AND (leased_until IS NULL OR leased_until < now())   -- non toccare i target leasati da un worker
      ORDER BY last_swept NULLS FIRST, id`,
    [device]
  );
  return r ? r.rows : [];
}

// F5 — lease atomico di UN target del NODO, mode-aware. Generalizza leaseTarget.
//  - mode='fill' (keep-ready/backfill): target mai spazzolato (last_swept IS NULL),
//    ignora il ramp → un nodo remoto popola subito i target che gli assegni.
//  - mode='due'  (daily refresh): target attivato e stantio (>20h) → rispetta il ramp.
// FOR UPDATE SKIP LOCKED → due richieste concorrenti prendono target diversi.
async function leaseDueTarget(device, mode = 'fill') {
  if (!db.isEnabled() || !device) return null;
  // Condizione di candidatura secondo il mode (oltre a nodo+enabled+lease-libero).
  const cond = mode === 'due'
    ? `activated_at IS NOT NULL AND (last_swept IS NULL OR last_swept < now() - interval '20 hours')`
    : `last_swept IS NULL`;
  let client;
  try { client = await db.getClient(); } catch (_) { return null; }
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, tipo, marca, modello FROM watchlist
        WHERE ${NODE_FILTER} AND enabled = true
          AND (leased_until IS NULL OR leased_until < now())
          AND (${cond})
        ORDER BY last_swept NULLS FIRST, id LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [device]
    );
    if (!r.rows.length) { await client.query('COMMIT'); return null; }
    const t = r.rows[0];
    await client.query(
      `UPDATE watchlist SET leased_by=$1, leased_until = now() + interval '15 minutes' WHERE id=$2`,
      [device, t.id]
    );
    await client.query('COMMIT');
    return t;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[watchlist] leaseDueTarget KO:', e.message);
    return null;
  } finally {
    client.release();
  }
}

// Retro-compat F3: leaseTarget = fill-mode (mai-spazzolati del nodo). Usato da
// scripts/fill-moto-local.js. NB: ora è node-filtered (imac vede imac+NULL).
function leaseTarget(device) { return leaseDueTarget(device, 'fill'); }

// F3 — target completato dal worker: marca swept/attivato, libera il lease.
async function completeTarget(id) {
  if (!db.isEnabled()) return;
  await db.query(
    `UPDATE watchlist
        SET last_swept = now(),
            activated_at = COALESCE(activated_at, now()),
            leased_by = NULL, leased_until = NULL
      WHERE id = $1`,
    [id]
  );
}

async function markSwept(id) {
  if (!db.isEnabled()) return;
  await db.query('UPDATE watchlist SET last_swept = now() WHERE id = $1', [id]);
}

// ─── F5 — CRUD admin ──────────────────────────────────────────────────────────
// Lista completa per il pannello (con stato lease/nodo).
async function listAll() {
  if (!db.isEnabled()) return [];
  const r = await db.query(
    `SELECT id, tipo, marca, modello, assigned_node, enabled,
            activated_at, last_swept, leased_by, leased_until
       FROM watchlist ORDER BY tipo, marca, modello`
  );
  return r ? r.rows : [];
}

// Aggiunge un target (idempotente su tipo+marca+modello). assigned_node opzionale.
// Ritorna la riga creata/esistente, o null.
async function addOne({ tipo, marca, modello, assigned_node = null }) {
  if (!db.isEnabled() || !tipo || !marca || !modello) return null;
  const r = await db.query(
    `INSERT INTO watchlist (tipo, marca, modello, assigned_node)
       VALUES ($1,$2,$3,$4)
     ON CONFLICT (tipo, marca, modello)
       DO UPDATE SET assigned_node = COALESCE(EXCLUDED.assigned_node, watchlist.assigned_node)
     RETURNING id, tipo, marca, modello, assigned_node, enabled`,
    [tipo, marca, modello, assigned_node]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

// Aggiorna enabled e/o assigned_node. Campi assenti → invariati (COALESCE).
// assigned_node: passare null lo azzera (= iMac) SOLO se la chiave è presente.
async function updateOne(id, { enabled, assigned_node } = {}) {
  if (!db.isEnabled() || !id) return null;
  const setNode = assigned_node !== undefined;   // distingue "non passato" da "null esplicito"
  const r = await db.query(
    `UPDATE watchlist
        SET enabled = COALESCE($2, enabled),
            assigned_node = CASE WHEN $4 THEN $3 ELSE assigned_node END
      WHERE id = $1
      RETURNING id, tipo, marca, modello, assigned_node, enabled`,
    [id, enabled === undefined ? null : enabled, setNode ? assigned_node : null, setNode]
  );
  return r && r.rows.length ? r.rows[0] : null;
}

async function removeOne(id) {
  if (!db.isEnabled() || !id) return false;
  // NB: nessuna FK listings→watchlist (i listing sono keyed by url) → restano.
  const r = await db.query('DELETE FROM watchlist WHERE id = $1', [id]);
  return !!(r && r.rowCount);
}

// F8 — assegnazione bulk: un colpo solo su molti id (node può essere null = iMac).
async function assignMany(ids, node) {
  if (!db.isEnabled() || !Array.isArray(ids) || !ids.length) return { updated: 0 };
  const clean = ids.map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!clean.length) return { updated: 0 };
  const r = await db.query(
    `UPDATE watchlist SET assigned_node = $2 WHERE id = ANY($1::int[]) RETURNING id`,
    [clean, node]
  );
  return { updated: r ? r.rowCount : 0 };
}

// F8 — auto-distribuzione round-robin dei target tra i nodi dati. Ordine per
// (tipo,marca,modello) → ogni nodo riceve un MIX equo auto+moto (diff ≤1). Se
// `ids` assente → tutti i target enabled. TX: 1 UPDATE per nodo. {assignments,total}.
async function autoDistribute(nodes, ids) {
  if (!db.isEnabled() || !Array.isArray(nodes) || !nodes.length) return { assignments: [], total: 0 };
  const sel = (Array.isArray(ids) && ids.length)
    ? await db.query(`SELECT id FROM watchlist WHERE id = ANY($1::int[]) ORDER BY tipo, marca, modello`, [ids.map(n => parseInt(n, 10)).filter(Number.isInteger)])
    : await db.query(`SELECT id FROM watchlist WHERE enabled = true ORDER BY tipo, marca, modello`);
  const rows = sel ? sel.rows : [];
  const buckets = nodes.map(() => []);
  rows.forEach((r, i) => buckets[i % nodes.length].push(r.id));
  let client;
  try { client = await db.getClient(); } catch (_) { return { assignments: [], total: 0 }; }
  try {
    await client.query('BEGIN');
    for (let i = 0; i < nodes.length; i++) {
      if (buckets[i].length) {
        await client.query(`UPDATE watchlist SET assigned_node = $1 WHERE id = ANY($2::int[])`, [nodes[i], buckets[i]]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[watchlist] autoDistribute KO:', e.message);
    return { assignments: [], total: 0 };
  } finally {
    client.release();
  }
  return { assignments: nodes.map((n, i) => ({ node: n, count: buckets[i].length })), total: rows.length };
}

async function counts() {
  if (!db.isEnabled()) return { total: 0, active: 0, pending: 0 };
  const r = await db.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE activated_at IS NOT NULL)::int active,
            count(*) FILTER (WHERE activated_at IS NULL)::int pending
       FROM watchlist`
  );
  return r ? r.rows[0] : { total: 0, active: 0, pending: 0 };
}

module.exports = {
  insertTargets, seedFromFile, activateRamp, dueTargets, markSwept, counts,
  leaseTarget, leaseDueTarget, completeTarget,
  listAll, addOne, updateOne, removeOne, assignMany, autoDistribute,
};
