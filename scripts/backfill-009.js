'use strict';
/**
 * F50 Fase 1 — backfill delle colonne ricche (mig 009) per i listings STORICI.
 * Riusa gli STESSI mapper degli scraper sul payload `raw_json` (keep-last) → i
 * campi backfillati combaciano con quelli dei nuovi crawl. COALESCE(new, old):
 * riempie solo i NULL, idempotente, non sovrascrive dati più freschi.
 *
 *   DATABASE_URL='postgres://postgres:3414@localhost/automotoradar?host=/tmp' \
 *   node scripts/backfill-009.js
 *
 * raw_json AS24 = `details` senza media → immagini restano vuote (le riempie il
 * prossimo crawl). Subito/Moto.it hanno le immagini nel raw → backfillate.
 */
const db = require('../backend/db/index');
const subito = require('../backend/scrapers/subito-api');
const as24 = require('../backend/scrapers/autoscout-graphql');
const moto = require('../backend/scrapers/motoit');
const { regioneFrom } = require('../backend/db/listings-repo');

const intOrNull = v => { if (v == null || v === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const boolOrNull = v => (v === true ? true : (v === false ? false : null));

function mapByFonte(fonte, raw) {
  if (fonte === 'subito') return subito._mapAd(raw);
  if (fonte === 'autoscout') return as24._mapListing({ details: raw });
  if (fonte === 'moto') return moto._mapCards([raw])[0] || null;
  return null;
}

const UPDATE_SQL = `UPDATE listings SET
  versione=COALESCE($2,versione), regione=COALESCE($3,regione), provincia=COALESCE($4,provincia),
  cap=COALESCE($5,cap), venditore=COALESCE($6,venditore), carburante=COALESCE($7,carburante),
  cambio=COALESCE($8,cambio), potenza_cv=COALESCE($9,potenza_cv), cilindrata=COALESCE($10,cilindrata),
  cilindri=COALESCE($11,cilindri), carrozzeria=COALESCE($12,carrozzeria), colore=COALESCE($13,colore),
  porte=COALESCE($14,porte), posti=COALESCE($15,posti), classe_emissioni=COALESCE($16,classe_emissioni),
  neopatentati=COALESCE($17,neopatentati), proprietari=COALESCE($18,proprietari),
  allestimento=COALESCE($19,allestimento), revisione=COALESCE($20,revisione),
  immagini=COALESCE($21::jsonb,immagini)
 WHERE url=$1`;

(async () => {
  await db.init();
  const client = await db.getClient();
  let last = '', seen = 0, updated = 0, errs = 0;
  try {
    for (;;) {
      const { rows } = await client.query(
        `SELECT url, fonte, raw_json FROM listings
          WHERE raw_json IS NOT NULL AND url > $1 ORDER BY url LIMIT 500`, [last]);
      if (!rows.length) break;
      await client.query('BEGIN');
      for (const r of rows) {
        last = r.url; seen++;
        let m;
        try { m = mapByFonte(r.fonte, r.raw_json); } catch (e) { errs++; continue; }
        if (!m) continue;
        const immagini = (Array.isArray(m.immagini) && m.immagini.length) ? JSON.stringify(m.immagini) : null;
        // review: SAVEPOINT per riga — senza, una query fallita aborta l'INTERA transazione e
        // tutte le righe successive del batch falliscono ('current transaction is aborted') fino
        // al COMMIT (che diventa ROLLBACK) → interi blocchi da 500 persi silenziosamente.
        try {
          await client.query('SAVEPOINT s');
          const res = await client.query(UPDATE_SQL, [
            r.url, m.variante || null, regioneFrom(m.provincia, m.zip), m.provincia || null,
            m.zip || null, m.venditore || null, m.carburante || null, m.cambio || null,
            intOrNull(m.potenzaCv), intOrNull(m.cilindrata), intOrNull(m.cilindri),
            m.carrozzeria || null, m.colore || null, m.porte != null ? String(m.porte) : null,
            intOrNull(m.posti), m.classeEmissioni || null, boolOrNull(m.neopatentati),
            intOrNull(m.proprietari), m.allestimento || null, m.revisione || null, immagini,
          ]);
          await client.query('RELEASE SAVEPOINT s');
          updated += res.rowCount || 0;
        } catch (e) { errs++; await client.query('ROLLBACK TO SAVEPOINT s').catch(() => {}); }
      }
      await client.query('COMMIT');
      if (seen % 10000 < 500) console.log(`[backfill] viste ${seen}, aggiornate ${updated}, errori ${errs}`);
    }
  } finally { client.release(); await db.close(); }
  console.log(`[backfill] FATTO. viste ${seen}, aggiornate ${updated}, errori ${errs}`);
})().catch(e => { console.error('[backfill] KO', e); process.exit(1); });
