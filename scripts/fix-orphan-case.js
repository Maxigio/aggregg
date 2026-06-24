#!/usr/bin/env node
'use strict';
/**
 * F60 — pulizia orfani CASE-variant. Righe market_size/listings con (tipo,marca,modello)
 * che NON matchano ESATTAMENTE una riga watchlist ma matchano case-insensitive: residui di
 * crawl ad-hoc fatti PRIMA della canonicalizzazione (M-C/1) — es. 'audi a3' minuscolo vs
 * il catalogo 'Audi A3'. Li RI-ETICHETTA al nome CANONICO della watchlist → la copertura
 * smette di mostrare doppioni e il conteggio si fonde in un'unica riga.
 *
 * DB-only, ZERO crawl, idempotente (2ª esecuzione → 0 orfani). url è PK di listings →
 * la UPDATE del nome non collide. market_size è timeseries → ri-etichettare preserva la
 * serie storica sotto il nome giusto.  Run:  node scripts/fix-orphan-case.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../backend/db');

async function main() {
  if (!db.isEnabled()) { console.error('[fix-orphan] DB non configurato (DATABASE_URL).'); process.exit(1); }
  await db.init();

  const orphans = (await db.query(`
    WITH keys AS (
      SELECT DISTINCT tipo, marca, modello FROM market_size
      UNION
      SELECT DISTINCT tipo, marca, modello FROM listings
    )
    SELECT DISTINCT ON (k.tipo, k.marca, k.modello)
           k.tipo, k.marca, k.modello, w.marca AS canon_marca, w.modello AS canon_modello
      FROM keys k
      JOIN watchlist w
        ON w.tipo = k.tipo
       AND lower(w.marca) = lower(k.marca)
       AND lower(w.modello) = lower(k.modello)
       AND (w.marca <> k.marca OR w.modello <> k.modello)   -- canonico DIVERSO (solo case)
     WHERE NOT EXISTS (SELECT 1 FROM watchlist w2
                        WHERE w2.tipo = k.tipo AND w2.marca = k.marca AND w2.modello = k.modello)
     ORDER BY k.tipo, k.marca, k.modello, w.id`)).rows;

  if (!orphans.length) { console.log('[fix-orphan] nessun orfano case-variant. Niente da fare.'); await db.close(); return; }

  let totL = 0, totM = 0;
  for (const o of orphans) {
    const lr = await db.query('UPDATE listings SET marca=$1, modello=$2 WHERE tipo=$3 AND marca=$4 AND modello=$5',
      [o.canon_marca, o.canon_modello, o.tipo, o.marca, o.modello]);
    const mr = await db.query('UPDATE market_size SET marca=$1, modello=$2 WHERE tipo=$3 AND marca=$4 AND modello=$5',
      [o.canon_marca, o.canon_modello, o.tipo, o.marca, o.modello]);
    totL += lr.rowCount; totM += mr.rowCount;
    console.log(`  ${o.tipo} ${o.marca}/${o.modello} -> ${o.canon_marca}/${o.canon_modello}  (listings ${lr.rowCount}, market_size ${mr.rowCount})`);
  }
  console.log(`[fix-orphan] FATTO. orfani: ${orphans.length} · listings ri-etichettati: ${totL} · market_size: ${totM}.`);
  await db.close();
}

main().catch(e => { console.error('[fix-orphan] FATAL', e.message); process.exit(1); });
