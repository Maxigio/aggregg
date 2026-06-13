'use strict';
/**
 * Connessione Postgres + runner migrazioni (best-effort).
 *
 * Best-effort = se `DATABASE_URL` manca o il DB è giù: il modulo NON lancia,
 * `isEnabled()` → false e le query diventano no-op. Le ricerche dell'app
 * funzionano comunque (la persistenza prezzi è un extra, non un blocco).
 *
 * Migrazioni: file `db/NNN_*.sql` applicati in ordine, una volta sola, tracciati
 * in `_migrations`. Idempotente: ri-eseguire init() non riapplica i già visti.
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'db');

let pool = null;
let enabled = false;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  pool = new Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30000 });
  // Un errore sul pool (es. DB riavviato) NON deve abbattere il processo.
  pool.on('error', err => console.error('[db] pool error:', err.message));
  enabled = true;
  return pool;
}

// Crea il pool lazy e riflette la presenza di DATABASE_URL (no connessione
// immediata: pg.Pool connette al primo query). Sicuro da chiamare a freddo.
function isEnabled() { return getPool() != null; }

// Query best-effort: se il DB non c'è/è giù → null, niente throw verso il chiamante
// opportunistico. I percorsi che DEVONO sapere dell'errore usano getClient().
async function query(text, params) {
  const p = getPool();
  if (!p) return null;
  try {
    return await p.query(text, params);
  } catch (e) {
    console.error('[db] query fallita:', e.message);
    return null;
  }
}

async function getClient() {
  const p = getPool();
  if (!p) throw new Error('DB non configurato (DATABASE_URL mancante)');
  return p.connect();
}

// Applica le migrazioni non ancora viste. Ritorna l'elenco applicato.
async function init() {
  const p = getPool();
  if (!p) { console.warn('[db] DATABASE_URL mancante → init saltato'); return []; }
  await p.query(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const done = new Set((await p.query('SELECT name FROM _migrations')).rows.map(r => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+.*\.sql$/.test(f)).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    const client = await p.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      applied.push(f);
      console.log('[db] migrazione applicata:', f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migrazione ${f} fallita: ${e.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

async function close() { if (pool) { await pool.end(); pool = null; enabled = false; } }

module.exports = { getPool, isEnabled, query, getClient, init, close };
