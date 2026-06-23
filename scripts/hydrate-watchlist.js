'use strict';
/**
 * F50 Fase 2 — idrata la watchlist con TUTTO il catalogo (data/models.json),
 * dando a ogni target una `priority` = liquidità di mercato della marca
 * (autoscout.totalAnnunci, livello marca). DB-only, ZERO crawl: inserisce righe
 * con activated_at = NULL e assigned_node = NULL. Il ramp è l'UNICO gate di
 * attivazione: né dueTargets né il lease fill-mode (ora guardato) toccano queste
 * righe finché il ramp non le attiva (10/giorno, interleave auto/moto) → il
 * carico di crawl NON cambia.
 *
 * Idempotente sull'ESISTENZA delle righe (ON CONFLICT DO NOTHING). NON ricalcola
 * le priority su una ri-esecuzione (l'INSERT salta i conflitti, il backfill tocca
 * solo priority IS NULL): è una idratazione one-time. Se il catalogo cambia
 * liquidità serve un refresh esplicito.
 *
 *   DATABASE_URL='postgres://postgres:3414@localhost/automotoradar?host=/tmp' \
 *     node scripts/hydrate-watchlist.js
 */
const catalog = require('../data/models.json');
const { candidates } = require('../backend/candidate-targets');

// (tipo|marca) → annunci totali della marca (liquidità). Solo livello marca:
// nessun modello ha un conteggio proprio (verificato). Marche senza dato → 0.
// PURO (testabile senza DB).
function marcaLiquidity(cat) {
  const liq = new Map();
  for (const tipo of ['auto', 'moto']) {
    const brands = cat[tipo] || {};
    for (const marca of Object.keys(brands)) {
      const v = brands[marca] && brands[marca].autoscout && brands[marca].autoscout.totalAnnunci;
      liq.set(tipo + '|' + marca, Number.isFinite(v) ? v : 0);
    }
  }
  return liq;
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function main() {
  const db = require('../backend/db/index');
  await db.init();   // applica mig 010 (priority + indice)
  // db.query è best-effort (torna null se il DB cade/erra) → qui fail-loud: una
  // idratazione parziale che si spaccia per riuscita è peggio di un errore.
  const q = async (sql, params) => {
    const r = await db.query(sql, params);
    if (r == null) throw new Error('query DB fallita (null) — vedi log [db] sopra');
    return r;
  };
  const liq = marcaLiquidity(catalog);

  // watchlist esistente (per dedup dei candidati + conteggio iniziale)
  const ex = await q('SELECT tipo, marca, modello FROM watchlist');
  const existing = ex.rows;
  const before = existing.length;

  // catalogo - esistenti - modelli morti (coverage 0), già normalizzato/dedupato
  const { items, total } = candidates(catalog, existing, { limit: 1e9 });
  console.log(`[hydrate] catalogo: ${total} candidati nuovi (watchlist attuale: ${before})`);

  // INSERT a batch con priority. Multi-row VALUES + ON CONFLICT DO NOTHING.
  let inserted = 0;
  for (const batch of chunk(items, 500)) {
    const vals = [];
    const params = [];
    batch.forEach((it, i) => {
      const b = i * 4;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
      params.push(it.tipo, it.marca, it.modello, liq.get(it.tipo + '|' + it.marca) || 0);
    });
    const r = await q(
      `INSERT INTO watchlist (tipo, marca, modello, priority) VALUES ${vals.join(',')}
       ON CONFLICT (tipo, marca, modello) DO NOTHING`,
      params
    );
    inserted += r.rowCount || 0;
  }

  // Backfill priority anche sulle righe preesistenti (priority IS NULL), set-based
  // via mappa (tipo,marca)→priority. Match su marca esatta del catalogo.
  const mapRows = [...liq.entries()].map(([k, v]) => { const [t, m] = k.split('|'); return [t, m, v]; });
  let updated = 0;
  for (const batch of chunk(mapRows, 500)) {
    const vals = [];
    const params = [];
    batch.forEach((row, i) => {
      const b = i * 3;
      vals.push(`($${b + 1},$${b + 2},$${b + 3}::int)`);
      params.push(row[0], row[1], row[2]);
    });
    const r = await q(
      `UPDATE watchlist w SET priority = m.pri
         FROM (VALUES ${vals.join(',')}) AS m(tipo, marca, pri)
        WHERE w.tipo = m.tipo AND w.marca = m.marca AND w.priority IS NULL`,
      params
    );
    updated += r.rowCount || 0;
  }

  const after = await q('SELECT count(*)::int n FROM watchlist');
  console.log(`[hydrate] inserted=${inserted} · backfill-priority(preesistenti)=${updated} · watchlist ${before} → ${after.rows[0].n}`);
  await db.close();
  console.log('[hydrate] FATTO');
}

module.exports = { marcaLiquidity };

if (require.main === module) {
  main().catch(e => { console.error('[hydrate] KO', e); process.exit(1); });
}
