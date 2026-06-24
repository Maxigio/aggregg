#!/usr/bin/env node
'use strict';
/**
 * F60 — drainer one-shot della coda crawl (crawl_queue). Lo spawna la TUI owner
 * (tools/owner/amradmin/drainer.py) STACCATO: sopravvive alla chiusura della TUI.
 * Direct-DB come scripts/fill-moto-local.js (NIENTE HTTP). Sequenziale (1 IP, ~27s/target).
 *
 * SINGLETON: advisory lock di SESSIONE su una connessione DEDICATA, tenuta per tutto
 *   il drain. NON via db.query (il Pool la riciclerebbe e perderebbe il lock). Un 2º
 *   drainer esce subito. Crash → l'OS chiude il socket → Postgres rilascia il lock.
 * CRASH dei job: heartbeat + reclaimStale(15min) all'avvio (= lease worker). Doppio
 *   crawl da reclaim = data-safe (upsert idempotente ON CONFLICT url), solo traffico.
 *
 * Run manuale: node scripts/crawl-once.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../backend/db');
const wl = require('../backend/db/watchlist-repo');
const queue = require('../backend/db/crawl-queue-repo');
const crawler = require('../backend/crawler');
const runs = require('../backend/db/crawl-runs-repo');

const LOCK_KEY = 414260060;   // chiave fissa singleton (int4 → pg_try_advisory_lock(bigint))
const THROTTLE_MS = parseInt(process.env.CRAWLER_THROTTLE_MS || '1500', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!db.isEnabled()) { console.error('[drainer] DB non configurato (DATABASE_URL).'); process.exit(1); }

  // SINGLETON: lock di SESSIONE su connessione dedicata (NON db.query → il pool la riciclerebbe).
  const lockClient = await db.getClient();
  const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY])).rows[0].got;
  if (!got) {
    console.log('[drainer] altro drainer già attivo → esco.');
    lockClient.release(); await db.close(); process.exit(0);
  }

  const runId = await runs.startRun('imac').catch(() => null);
  const tot = { targets: 0, written: 0, errors: 0 };
  try {
    const reclaimed = await queue.reclaimStale();
    if (reclaimed) console.log(`[drainer] reclaim di ${reclaimed} job 'running' orfani (drainer crashato).`);

    let emptyPolls = 0;
    for (;;) {
      const job = await queue.pickNext();
      if (!job) {
        if (++emptyPolls >= 2) break;      // doppio poll vuoto prima di uscire (chiude la finestra di re-spawn)
        await sleep(1500);
        continue;
      }
      emptyPolls = 0;

      if (await queue.isCancelRequested(job.id)) {
        await queue.markFail(job.id, 'annullato');
        console.log(`[drainer] ${job.marca} ${job.modello} → annullato`);
        continue;
      }

      console.log(`[drainer] ${job.tipo} ${job.marca} ${job.modello}${job.watchlist_id ? '' : ' (ad-hoc)'}…`);
      const stats = { written: 0, as: 0, sub: 0, errors: 0 };
      try {
        const meta = await crawler.sweepTarget(
          { tipo: job.tipo, marca: job.marca, modello: job.modello, last_truncated: job.last_truncated }, stats);
        if (job.watchlist_id) await wl.markSwept(job.watchlist_id, { truncated: meta.truncated, complete: meta.complete });
        await queue.markDone(job.id, { written: stats.written });
        console.log(`  → ${stats.written} scritti (AS24 ${stats.as} · Subito ${stats.sub} · err ${stats.errors})`);
        tot.written += stats.written;
      } catch (e) {
        await queue.markFail(job.id, e.message);
        console.warn(`  → FALLITO: ${e.message}`);
        tot.errors++;
      }
      tot.targets++;
      await sleep(THROTTLE_MS);
    }
    console.log(`[drainer] coda vuota → FINE. target: ${tot.targets}, scritti: ${tot.written}, errori: ${tot.errors}.`);
  } finally {
    if (runId) await runs.finishRun(runId, tot).catch(() => {});
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lockClient.release();
    await db.close().catch(() => {});
  }
})().catch(e => { console.error('[drainer] FATAL', e.message); process.exit(1); });
