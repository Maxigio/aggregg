#!/usr/bin/env node
'use strict';
/**
 * Fill Moto.it LOCALE sull'iMac (F1.7b). Loop sul lease (target last_swept NULL,
 * = i moto resettati), crawla SOLO Moto.it, upsert, completa. Direct DB (no HTTP).
 * Coordinato col worker Surface via lease (FOR UPDATE SKIP LOCKED → zero overlap).
 *
 * Prereq: `UPDATE watchlist SET last_swept=NULL, leased_by=NULL, leased_until=NULL WHERE tipo='moto'`.
 * Run: node scripts/fill-moto-local.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../backend/db');
const wl = require('../backend/db/watchlist-repo');
const repo = require('../backend/db/listings-repo');
const health = require('../backend/db/health-repo');
const crawler = require('../backend/crawler');
const scrapeMotoIt = require('../backend/scrapers/motoit');

const PAGES      = parseInt(process.env.FILL_PAGES || '10', 10);
const PAGE_DELAY = parseInt(process.env.FILL_PAGE_DELAY_MS || '1500', 10);
const THROTTLE   = parseInt(process.env.FILL_THROTTLE_MS || '1500', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!db.isEnabled()) { console.error('DB non configurato (DATABASE_URL).'); process.exit(1); }
  console.log(`[fill-moto iMac] inizio (pagine=${PAGES}, delay-pagina=${PAGE_DELAY}ms)`);
  let done = 0, skip = 0;
  for (;;) {
    const t = await wl.leaseTarget('imac');
    if (!t) { console.log(`[fill-moto iMac] nessun target → FINE. moto fatti: ${done}, saltati: ${skip}.`); break; }
    if (t.tipo !== 'moto') { console.log(`  skip non-moto ${t.marca} ${t.modello}`); await wl.completeTarget(t.id); skip++; continue; }
    console.log(`[${done + 1}] ${t.marca} ${t.modello}`);
    try {
      const mt = await crawler._resolveMotoit(t);
      if (!mt) { console.log('  marca non su Moto.it → skip'); }
      else {
        const { items, truncated } = await scrapeMotoIt(
          { tipo: 'moto', marca: t.marca, modello: t.modello, motoitBrandSlug: mt.brandSlug, motoitModelSlug: mt.modelSlug },
          { maxPages: PAGES, withMeta: true, attachRaw: true, pageDelayMs: PAGE_DELAY }
        );
        const r = await repo.upsertListings(items, t);
        console.log(`  moto.it: ${items.length} annunci${truncated ? ' (troncato)' : ''} → ${r.written} scritti`);
        await health.record('moto', { count: items.length, node: 'imac' });
      }
      done++;
    } catch (e) {
      console.warn(`  Moto.it errore: ${e.message}`);
      await health.record('moto', { error: e, node: 'imac' });
    }
    await wl.completeTarget(t.id);
    await sleep(THROTTLE);
  }
  await db.close();
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
