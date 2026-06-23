'use strict';
// F50 quick-fix qualità — applica i 3 fix ai listings ESISTENTI (overwrite, non COALESCE).
//   DATABASE_URL='postgres://postgres:3414@localhost/automotoradar?host=/tmp' node scripts/fix-009-quality.js
const db = require('../backend/db/index');
const { regioneFrom } = require('../backend/db/listings-repo');
const { normCarburante } = require('../backend/normalize');

(async () => {
  await db.init();
  const c = await db.getClient();
  try {
    // 1) regione Subito dal campo NATIVO geo.region.friendly_name (slug già giusto) — set-based
    const r1 = await c.query(`UPDATE listings SET regione = lower(raw_json->'geo'->'region'->>'friendly_name')
      WHERE fonte='subito' AND regione IS NULL AND raw_json->'geo'->'region'->>'friendly_name' IS NOT NULL`);
    console.log('[fix] regione Subito (nativa):', r1.rowCount);

    // 2) regione AS24/Moto via regioneFrom migliorata (sigla / "(Regione)") — poche righe, per-row
    const { rows } = await c.query(`SELECT url, provincia, cap FROM listings
      WHERE fonte IN ('autoscout','moto') AND regione IS NULL AND provincia IS NOT NULL`);
    let asMoto = 0;
    for (const row of rows) {
      const reg = regioneFrom(row.provincia, row.cap);
      if (reg) { await c.query('UPDATE listings SET regione=$2 WHERE url=$1', [row.url, reg]); asMoto++; }
    }
    console.log('[fix] regione AS24/Moto (derivata):', asMoto, '/', rows.length);

    // 3) carburante → set canonico (set-based per valore distinto)
    const { rows: carbs } = await c.query(`SELECT DISTINCT carburante FROM listings WHERE carburante IS NOT NULL`);
    let carbRows = 0;
    for (const { carburante } of carbs) {
      const canon = normCarburante(carburante);
      if (canon !== carburante) {
        const u = await c.query('UPDATE listings SET carburante=$2 WHERE carburante=$1', [carburante, canon]);
        carbRows += u.rowCount || 0;
      }
    }
    console.log('[fix] carburante normalizzato:', carbRows, 'righe (da', carbs.length, 'valori)');

    // 4) outlier numerici → null (set-based)
    const cv = await c.query(`UPDATE listings SET potenza_cv=NULL WHERE potenza_cv IS NOT NULL AND (potenza_cv<1 OR potenza_cv>1500)`);
    const cc = await c.query(`UPDATE listings SET cilindrata=NULL WHERE cilindrata IS NOT NULL AND (cilindrata<50 OR cilindrata>9000)`);
    console.log('[fix] outlier potenza_cv:', cv.rowCount, '· cilindrata:', cc.rowCount);
  } finally { c.release(); await db.close(); }
  console.log('[fix] FATTO');
})().catch(e => { console.error('[fix] KO', e); process.exit(1); });
