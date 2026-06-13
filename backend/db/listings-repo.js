'use strict';
/**
 * Scritture su `listings` + `price_points`.
 *
 * - upsertListings(items, target): UPSERT per-url atomico; append a price_points
 *   SOLO se il prezzo è cambiato (confronto vs last_price PRIMA dell'update, via
 *   CTE che legge lo snapshot pre-statement). Aggiorna raw_json (keep-last),
 *   azzera miss_count (annuncio rivisto), riattiva annunci ri-comparsi.
 * - markGone(target, seenUrls): sul set di un target, incrementa miss_count per
 *   gli attivi non visti, poi marca gone quelli a miss_count>=2. SOLO su sweep
 *   riuscita (decide il chiamante) per non marcare venduti annunci vivi.
 */
const db = require('./index');
const { modelKey } = require('../model-key');

const UPSERT_SQL = `
WITH prev AS (
  SELECT last_price FROM listings WHERE url = $1
),
up AS (
  INSERT INTO listings
    (url, fonte, tipo, marca, modello, model_key, anno, km, nuovo, danni, posted_at, last_price, raw_json)
  VALUES
    ($1,  $2,    $3,   $4,    $5,      $6,        $7,   $8, $9,    $10,   $11,       $12,        $13::jsonb)
  ON CONFLICT (url) DO UPDATE SET
    fonte      = EXCLUDED.fonte,
    tipo       = EXCLUDED.tipo,
    marca      = EXCLUDED.marca,
    modello    = EXCLUDED.modello,
    model_key  = EXCLUDED.model_key,
    anno       = EXCLUDED.anno,
    km         = EXCLUDED.km,
    nuovo      = EXCLUDED.nuovo,
    danni      = COALESCE(EXCLUDED.danni, listings.danni),
    posted_at  = COALESCE(listings.posted_at, EXCLUDED.posted_at),
    last_seen  = now(),
    last_price = EXCLUDED.last_price,
    raw_json   = COALESCE(EXCLUDED.raw_json, listings.raw_json),
    status     = 'active',
    gone_at    = NULL,
    miss_count = 0
  RETURNING url
)
INSERT INTO price_points (url, prezzo)
SELECT $1, $12
WHERE $12 IS NOT NULL
  AND (NOT EXISTS (SELECT 1 FROM prev)
       OR (SELECT last_price FROM prev) IS DISTINCT FROM $12);
`;

/**
 * @param items array forma-standard scraper {fonte,prezzo,km,anno,url,...,_raw,danni,nuovo,posted_at}
 * @param target {tipo, marca, modello} (watch-list o params ricerca)
 * @returns {written, withRaw} conteggi (best-effort: 0 se DB giù)
 */
async function upsertListings(items, target) {
  if (!db.isEnabled() || !Array.isArray(items) || !items.length) return { written: 0, withRaw: 0 };
  const t = target || {};
  let written = 0, withRaw = 0;
  let client;
  try {
    client = await db.getClient();
  } catch (_) {
    return { written: 0, withRaw: 0 };   // DB non configurato → no-op
  }
  try {
    for (const it of items) {
      if (!it || !it.url || it.prezzo == null) continue;
      const mk = modelKey(t.tipo, t.marca, t.modello, it.anno, it.km);
      const raw = it._raw != null ? JSON.stringify(it._raw) : null;
      try {
        await client.query(UPSERT_SQL, [
          it.url,
          it.fonte || null,
          t.tipo || null,
          t.marca || null,
          t.modello || null,
          mk,
          it.anno != null ? it.anno : null,
          it.km != null ? it.km : null,
          it.nuovo === true ? true : (it.nuovo === false ? false : null),
          it.danni === true ? true : (it.danni === false ? false : null),
          it.posted_at || null,
          it.prezzo,
          raw,
        ]);
        written++;
        if (raw) withRaw++;
      } catch (e) {
        console.error('[listings-repo] upsert fallita per', it.url, '-', e.message);
      }
    }
  } finally {
    client.release();
  }
  return { written, withRaw };
}

/**
 * Rilevamento venduto su un target. CHIAMARE SOLO se la sweep è riuscita.
 * @param target {tipo, marca, modello}
 * @param seenUrls array di url visti in QUESTA sweep
 * @param opts.fonte se presente, limita a quella fonte (così il fallimento di
 *        una fonte non marca "venduti" gli annunci dell'altra, non spazzolata)
 * @returns {missed, gone} conteggi
 */
async function markGone(target, seenUrls, opts = {}) {
  if (!db.isEnabled()) return { missed: 0, gone: 0 };
  const t = target || {};
  if (!t.tipo || !t.marca || !t.modello) return { missed: 0, gone: 0 };
  const urls = Array.isArray(seenUrls) ? seenUrls : [];
  const fonte = opts.fonte || null;
  let client;
  try { client = await db.getClient(); } catch (_) { return { missed: 0, gone: 0 }; }
  try {
    await client.query('BEGIN');
    // 1) incrementa assenze sugli attivi del target (fonte) non visti ora
    const miss = await client.query(
      `UPDATE listings SET miss_count = miss_count + 1
        WHERE tipo=$1 AND marca=$2 AND modello=$3 AND status='active'
          AND ($5::text IS NULL OR fonte=$5)
          AND url <> ALL($4::text[])`,
      [t.tipo, t.marca, t.modello, urls, fonte]
    );
    // 2) marca venduti quelli a 2+ assenze consecutive
    const gone = await client.query(
      `UPDATE listings SET status='gone', gone_at=now()
        WHERE tipo=$1 AND marca=$2 AND modello=$3 AND status='active'
          AND ($4::text IS NULL OR fonte=$4) AND miss_count >= 2`,
      [t.tipo, t.marca, t.modello, fonte]
    );
    await client.query('COMMIT');
    return { missed: miss.rowCount || 0, gone: gone.rowCount || 0 };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[listings-repo] markGone fallita:', e.message);
    return { missed: 0, gone: 0 };
  } finally {
    client.release();
  }
}

module.exports = { upsertListings, markGone, _UPSERT_SQL: UPSERT_SQL };
