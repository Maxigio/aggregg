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
 * CRASH dei job: reclaimStale(15min) all'avvio (= lease worker). Doppio crawl da
 *   reclaim = data-safe (upsert idempotente ON CONFLICT url), solo traffico.
 *
 * Il LOOP è in `drainQueue` (esportato, sweep iniettabile) → testabile senza rete.
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
const POLL_MS = 1500;         // attesa tra due poll vuoti (chiude la finestra di re-spawn)
const SATURATED_DAYS = 7;     // = tools/owner/amradmin/constants.py SATURATED_DAYS (finestra saturazione)
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * M-M — decide la CORSIA di crawl per un job. Un target saturo DI RECENTE (0 nuovi all'ultimo
 * crawl pieno, <SATURATED_DAYS) e senza gap reale → REFRESH pagina-1 (cheap: prende solo i nuovi
 * in cima) invece del crawl pieno che riscrive tutto per 0 nuovi. Escluso: `:run …full|pN`
 * (job.pages = override esplicito), i tronca (gap reale → deep crawl), i mai-saturati. PURO →
 * testabile senza rete/DB. saturated_at arriva da crawl_queue.pickNext (sub-select su watchlist).
 */
function shouldRefresh(job, nowMs = Date.now()) {
  if (job.pages) return false;            // profondità esplicita → l'utente vuole il crawl pieno
  if (job.last_truncated) return false;   // gap reale (cap pagine colpito) → deep, non refresh
  if (!job.saturated_at) return false;    // mai saturato (o ad-hoc senza watchlist) → crawl pieno
  const ageMs = nowMs - new Date(job.saturated_at).getTime();
  return ageMs >= 0 && ageMs < SATURATED_DAYS * 86400000;   // saturo di recente → refresh
}

/**
 * Drena la coda finché vuota. `sweep(target, stats, {refresh})` esegue il crawl (default:
 * crawler.sweepTarget; refresh = corsia pagina-1 M-M, decisa da shouldRefresh) —
 * iniettabile per i test. Ritorna {targets, written, errors}.
 */
async function drainQueue({ sweep, throttleMs = THROTTLE_MS, pollMs = POLL_MS, log = () => {} } = {}) {
  const tot = { targets: 0, written: 0, inserted: 0, errors: 0 };
  await queue.reclaimStale();
  let emptyPolls = 0;
  for (;;) {
    const job = await queue.pickNext();
    if (!job) {
      if (++emptyPolls >= 2) break;     // doppio poll vuoto prima di uscire
      await sleep(pollMs);
      continue;
    }
    emptyPolls = 0;

    if (await queue.isCancelRequested(job.id)) {   // annullato tra pickNext e qui (raro)
      await queue.markFail(job.id, 'annullato');
      log(`${job.marca} ${job.modello} → annullato`);
      continue;
    }

    const refresh = shouldRefresh(job);   // M-M: saturo recente → corsia refresh (pagina-1)
    log(`${job.tipo} ${job.marca} ${job.modello}${job.watchlist_id ? '' : ' (ad-hoc)'}${refresh ? ' [refresh]' : ''}…`);
    const stats = { written: 0, inserted: 0, as: 0, sub: 0, errors: 0 };
    try {
      const meta = await sweep(
        { tipo: job.tipo, marca: job.marca, modello: job.modello, last_truncated: job.last_truncated,
          maxPages: job.pages || undefined }, stats, { refresh });   // M-C/2 profondità + M-M corsia
      // M-M: in refresh la vista è parziale (pagina-1) → NON propagare truncated (sennò poison
      // last_truncated = falso gap) né complete; il flag `refresh` dice a markSwept di non
      // ri-timbrare saturated_at (la finestra scorre → deep crawl a scadenza per il venduto).
      if (job.watchlist_id) await wl.markSwept(job.watchlist_id, {
        truncated: refresh ? undefined : (meta && meta.truncated),
        complete: refresh ? false : (meta && meta.complete),
        skipped: meta && meta.skipped, inserted: stats.inserted, written: stats.written, refresh });
      // re-check DOPO lo sweep: se l'utente ha annullato mentre crawlava, NON timbrare done
      // (lo sweep non si può interrompere a metà → il dato c'è, ma onoriamo l'annullo).
      if (await queue.isCancelRequested(job.id)) {
        await queue.markFail(job.id, 'annullato (a sweep finito)');
        log(`  → annullato (sweep completato, ${stats.written} scritti)`);
      } else {
        await queue.markDone(job.id, { written: stats.written, inserted: stats.inserted });
        log(`  → ${refresh ? 'refresh ' : ''}${stats.written} scritti, ${stats.inserted} nuovi (AS24 ${stats.as} · Subito ${stats.sub} · err ${stats.errors})`);
      }
      tot.written += stats.written;
      tot.inserted += stats.inserted;
    } catch (e) {
      await queue.markFail(job.id, e.message);
      log(`  → FALLITO: ${e.message}`);
      tot.errors++;
    }
    tot.targets++;
    await sleep(throttleMs);
  }
  return tot;
}

async function main() {
  if (!db.isEnabled()) { console.error('[drainer] DB non configurato (DATABASE_URL).'); process.exit(1); }

  // SINGLETON: lock di SESSIONE su connessione dedicata (NON db.query → il pool la riciclerebbe).
  const lockClient = await db.getClient();
  const got = (await lockClient.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY])).rows[0].got;
  if (!got) {
    console.log('[drainer] altro drainer già attivo → esco.');
    lockClient.release(); await db.close(); process.exit(0);
  }

  const runId = await runs.startRun('imac').catch(() => null);
  let tot = { targets: 0, written: 0, errors: 0 };
  try {
    tot = await drainQueue({ sweep: (t, s, o) => crawler.sweepTarget(t, s, o), log: m => console.log(`[drainer] ${m}`) });
    console.log(`[drainer] coda vuota → FINE. target: ${tot.targets}, scritti: ${tot.written} (${tot.inserted} nuovi), errori: ${tot.errors}.`);
  } finally {
    if (runId) await runs.finishRun(runId, tot).catch(() => {});
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    lockClient.release();
    await db.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch(e => { console.error('[drainer] FATAL', e.message); process.exit(1); });
}

module.exports = { drainQueue, shouldRefresh };
