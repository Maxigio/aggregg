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
const comuneRegione = require('../../data/comune-regione.json');  // { norm(comune)|CAP : regione-slug }
const province      = require('../../data/province.json');        // { 'BS': { regione, ... } } (sigla)
const { normCarburante, clampCv, clampCc } = require('../normalize');
const VALID_REG = new Set(Object.values(province).map(p => p.regione));   // {sicilia, lazio, ...}

// norm coerente con scripts/build-comune-regione.js (le chiavi del JSON usano questa).
function normComune(s) {
  return String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
// regione DERIVATA (fallback quando la fonte non la dà nativa): CAP → sigla → "(Regione)" → comune. null se ignoto.
function regioneFrom(provincia, cap) {
  if (cap != null && comuneRegione[String(cap).trim()]) return comuneRegione[String(cap).trim()];
  if (provincia != null) {
    const raw = String(provincia).trim();
    const code = raw.toUpperCase();
    if (code.length === 2 && province[code]) return province[code].regione;             // sigla (Moto.it: BS)
    const par = raw.match(/\(([^)]+)\)\s*$/);                                            // "Padova (Veneto)"
    if (par) { const rs = normComune(par[1]); if (VALID_REG.has(rs)) return rs; }
    const base = raw.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*-\s*.*$/, '').trim();    // togli "(...)" / " - ..."
    const k = normComune(base);
    if (k && comuneRegione[k]) return comuneRegione[k];                                  // comune (Subito/AS24)
  }
  return null;
}
const intOrNull  = v => { if (v == null || v === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const boolOrNull = v => (v === true ? true : (v === false ? false : null));

const UPSERT_SQL = `
WITH prev AS (
  SELECT last_price FROM listings WHERE url = $1
),
up AS (
  INSERT INTO listings
    (url, fonte, tipo, marca, modello, model_key, anno, km, nuovo, danni, posted_at, last_price, raw_json,
     versione, regione, provincia, cap, venditore, carburante, cambio, potenza_cv, cilindrata, cilindri,
     carrozzeria, colore, porte, posti, classe_emissioni, neopatentati, proprietari, allestimento, revisione, immagini)
  VALUES
    ($1,  $2,    $3,   $4,    $5,      $6,        $7,   $8, $9,    $10,   $11,       $12,        $13::jsonb,
     $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
     $24, $25, $26, $27, $28, $29, $30, $31, $32, $33::jsonb)
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
    versione         = COALESCE(EXCLUDED.versione, listings.versione),
    regione          = COALESCE(EXCLUDED.regione, listings.regione),
    provincia        = COALESCE(EXCLUDED.provincia, listings.provincia),
    cap              = COALESCE(EXCLUDED.cap, listings.cap),
    venditore        = COALESCE(EXCLUDED.venditore, listings.venditore),
    carburante       = COALESCE(EXCLUDED.carburante, listings.carburante),
    cambio           = COALESCE(EXCLUDED.cambio, listings.cambio),
    potenza_cv       = COALESCE(EXCLUDED.potenza_cv, listings.potenza_cv),
    cilindrata       = COALESCE(EXCLUDED.cilindrata, listings.cilindrata),
    cilindri         = COALESCE(EXCLUDED.cilindri, listings.cilindri),
    carrozzeria      = COALESCE(EXCLUDED.carrozzeria, listings.carrozzeria),
    colore           = COALESCE(EXCLUDED.colore, listings.colore),
    porte            = COALESCE(EXCLUDED.porte, listings.porte),
    posti            = COALESCE(EXCLUDED.posti, listings.posti),
    classe_emissioni = COALESCE(EXCLUDED.classe_emissioni, listings.classe_emissioni),
    neopatentati     = COALESCE(EXCLUDED.neopatentati, listings.neopatentati),
    proprietari      = COALESCE(EXCLUDED.proprietari, listings.proprietari),
    allestimento     = COALESCE(EXCLUDED.allestimento, listings.allestimento),
    revisione        = COALESCE(EXCLUDED.revisione, listings.revisione),
    immagini         = COALESCE(EXCLUDED.immagini, listings.immagini),
    status     = 'active',
    gone_at    = NULL,
    miss_count = 0
  RETURNING (xmax = 0) AS inserted   -- xmax=0 = vero INSERT; ≠0 = UPDATE (ON CONFLICT). Ceiling: un UPDATE concorrente potrebbe falsare il flag, accettabile per una metrica.
),
pp AS (
  INSERT INTO price_points (url, prezzo)
  SELECT $1, $12
  WHERE $12 IS NOT NULL
    AND (NOT EXISTS (SELECT 1 FROM prev)
         OR (SELECT last_price FROM prev) IS DISTINCT FROM $12)
)
SELECT inserted FROM up;   -- pp è data-modifying → Postgres lo esegue comunque (non referenziato qui)
`;

/**
 * @param items array forma-standard scraper {fonte,prezzo,km,anno,url,...,_raw,danni,nuovo,posted_at}
 * @param target {tipo, marca, modello} (watch-list o params ricerca)
 * @returns {written, inserted, withRaw} conteggi (best-effort: 0 se DB giù). inserted = righe NUOVE (xmax=0).
 */
async function upsertListings(items, target) {
  if (!db.isEnabled() || !Array.isArray(items) || !items.length) return { written: 0, inserted: 0, withRaw: 0 };
  const t = target || {};
  let written = 0, inserted = 0, withRaw = 0;
  let client;
  try {
    client = await db.getClient();
  } catch (_) {
    return { written: 0, inserted: 0, withRaw: 0 };   // DB non configurato → no-op
  }
  try {
    for (const it of items) {
      if (!it || !it.url || it.prezzo == null) continue;
      const mk = modelKey(t.tipo, t.marca, t.modello, it.anno, it.km);
      const raw = it._raw != null ? JSON.stringify(it._raw) : null;
      const regione  = it.regione || regioneFrom(it.provincia, it.zip);   // it.regione = nativa (Subito geo.region)
      const immagini = (Array.isArray(it.immagini) && it.immagini.length) ? JSON.stringify(it.immagini) : null;
      try {
        const up = await client.query(UPSERT_SQL, [
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
          it.variante || null,                          // $14 versione
          regione,                                      // $15 regione (derivata)
          it.provincia || null,                         // $16
          it.zip || null,                               // $17 cap (AS24)
          it.venditore || null,                         // $18
          normCarburante(it.carburante),                // $19 (canonico)
          it.cambio || null,                            // $20
          clampCv(it.potenzaCv),                        // $21 (outlier→null)
          clampCc(it.cilindrata),                       // $22 (outlier→null)
          intOrNull(it.cilindri),                       // $23
          it.carrozzeria || null,                       // $24
          it.colore || null,                            // $25
          it.porte != null ? String(it.porte) : null,   // $26
          intOrNull(it.posti),                          // $27
          it.classeEmissioni || null,                   // $28
          boolOrNull(it.neopatentati),                  // $29
          intOrNull(it.proprietari),                    // $30
          it.allestimento || null,                      // $31
          it.revisione || null,                         // $32
          immagini,                                     // $33
        ]);
        written++;
        if (up.rows[0] && up.rows[0].inserted) inserted++;   // riga NUOVA (xmax=0) vs ri-aggiornata
        if (raw) withRaw++;
      } catch (e) {
        console.error('[listings-repo] upsert fallita per', it.url, '-', e.message);
      }
    }
  } finally {
    client.release();
  }
  return { written, inserted, withRaw };
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

module.exports = { upsertListings, markGone, regioneFrom };
