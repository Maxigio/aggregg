'use strict';
/**
 * Crawler proattivo (cuore della data-platform).
 *
 * 1×/giorno spazzola i target ATTIVI della watch-list su AS24 GraphQL + Subito
 * hades (SOLO API, niente Playwright → conservativo), paginazione profonda,
 * scrive listings/price_points/raw_json e rileva i venduti.
 *
 * Ramp: ogni run mette in rotazione ≤RAMP_PER_DAY nuovi target → backfill
 * iniziale spalmato, traffico gentile (anti-blocco).
 *
 * Serializzazione: passa per `withLock` (lo stesso mutex dei saved-check in
 * server.js) → mai scrape concorrenti. Su errore di una fonte: skip quella fonte
 * per quel target (NIENTE markGone → non marca venduti annunci non spazzolati).
 */
const path = require('path');
const db = require('./db');
const wl = require('./db/watchlist-repo');
const repo = require('./db/listings-repo');
const health = require('./db/health-repo');
const runs = require('./db/crawl-runs-repo');
const marketSize = require('./db/market-size-repo');   // F50 copertura: tetto per (target,fonte)
const scrapeAutoscoutGraphql = require('./scrapers/autoscout-graphql');
const scrapeSubitoApi = require('./scrapers/subito-api');
const scrapeMotoIt = require('./scrapers/motoit');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { resolveMotoitModelSlug } = require('./scrapers/motoit-models');
const { norm, makeResolver, makeModelResolver, loadAliasMap } = require('./scrapers/brand-match');

const modelsData = require('../data/models.json');

const DEEP_PAGES   = parseInt(process.env.CRAWLER_PAGES || '10', 10);   // cap profondità/target
const DEEP_PAGES_MAX = parseInt(process.env.CRAWLER_PAGES_MAX || '30', 10); // F13: cap esteso sui target che troncano
const FULL_PAGES_MAX = parseInt(process.env.CRAWLER_PAGES_FULL || '200', 10) || 200; // M-C/2: tetto di sicurezza full-depth (anti-runaway). `|| 200`: env non-numerico → NaN → fallback (NaN romperebbe Math.min e il full crawlerebbe a depth di default, muto)
const RAMP_PER_DAY = parseInt(process.env.CRAWLER_RAMP  || '10', 10);   // nuovi target/giorno
const THROTTLE_MS  = parseInt(process.env.CRAWLER_THROTTLE_MS || '1500', 10);
const BACKOFF_HOURS = parseInt(process.env.CRAWLER_BACKOFF_HOURS || '6', 10); // F14: salta fonte blocked per Nh
const REFRESH_PAGES = parseInt(process.env.CRAWLER_REFRESH_PAGES || '1', 10) || 1; // M-M: corsia refresh (pagina-1) per i target saturi → freschezza cheap, niente re-crawl pieno a vuoto
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;   // dopo il boot, non subito

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Risoluzione metadata AS24 (mmmv) dal catalogo, come runSearchCore ─────────
const brandResolvers = {};   // cache per tipo
function brandResolver(tipo) {
  if (brandResolvers[tipo]) return brandResolvers[tipo];
  const brands = modelsData[tipo] || {};
  const cand = Object.entries(brands).map(([nome, entry]) => ({ name: nome, value: entry }));
  const r = makeResolver(cand, { alias: loadAliasMap(tipo) });
  brandResolvers[tipo] = r;
  return r;
}

// Ritorna { mmmv } per AS24 (livello modello → fallback brand-only makeId|||).
function resolveAutoscout(target) {
  const brandEntry = brandResolver(target.tipo)(target.marca);
  const makeId = brandEntry && brandEntry.autoscout && brandEntry.autoscout.makeId;
  if (!makeId) return null;   // marca non su AS24 → niente AS24 per questo target
  let mmmv = `${makeId}|||`;
  if (brandEntry.models && brandEntry.models.length) {
    const mr = makeModelResolver(brandEntry.models.map(m => ({ name: m.nome, value: m })));
    const me = mr(target.modello);
    if (me && me.mmmvAutoscout) mmmv = me.mmmvAutoscout;
  }
  return { mmmv };
}

// Risoluzione slug Moto.it dal catalogo (come runSearchCore). Ritorna
// {brandSlug, modelSlug} o null se la marca non è su Moto.it.
async function resolveMotoit(target) {
  const brandEntry = brandResolver(target.tipo)(target.marca);
  const brandSlug = (brandEntry && brandEntry.motoit && brandEntry.motoit.brandSlug)
    || resolveMotoitSlug(target.marca) || null;
  if (!brandSlug) return null;
  let modelSlug = null;
  if (brandEntry && brandEntry.models && brandEntry.models.length) {
    const mr = makeModelResolver(brandEntry.models.map(m => ({ name: m.nome, value: m })));
    const me = mr(target.modello);
    if (me && me.slugMotoIt) modelSlug = me.slugMotoIt;
  }
  if (!modelSlug) {
    try { modelSlug = await resolveMotoitModelSlug(brandSlug, target.modello) || null; } catch (_) { /* brand-only */ }
  }
  return { brandSlug, modelSlug };
}

// Guard anti-rumore per Subito (free-text): tiene l'annuncio solo se tutti i
// token significativi del modello (len>=2) compaiono nel titolo normalizzato.
//
// I token si ricavano dal nome GREZZO (solo accenti appianati), NON da norm():
// norm() elimina già ogni separatore, quindi lo split successivo non spezzava mai
// nulla e il guard finiva per pretendere il nome intero attaccato
// ("africatwincrf1000l") come sottostringa del titolo → scartava annunci veri
// ("Honda CRF 1000 L Africa Twin"). Misurato: scartava l'80% dei risultati
// corretti di "Serie 3" e il 26% di quelli di "800MT".
// Nota: i modelli mono-token ("800MT", "200") si comportano come prima.
const deaccent = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
function titleMatchesModel(titolo, modello) {
  const nt = norm(titolo);
  const tokens = deaccent(modello).split(/[^a-z0-9]+/).filter(t => t.length >= 2);
  if (!tokens.length) return true;
  return tokens.every(tok => nt.includes(tok));
}

// ─── Sweep di un singolo target ───────────────────────────────────────────────
// Ritorna {truncated, complete}: truncated=una fonte ha visto solo una parte (cap)
// → F13 escalation cap al giro dopo + markGone spento DA SÉ. complete=tutte le
// fonti previste viste intere e nessuna saltata per back-off → "popolato".
// M-C/2 — profondità per-run (PURO → testabile): se il job porta `maxPages` (dalla coda)
// usa quello clampato al tetto di sicurezza FULL_PAGES_MAX (anti-runaway: 'full'=9999 → 200);
// altrimenti F13 default (esteso a DEEP_PAGES_MAX se l'ultima sweep aveva troncato).
function capForTarget(target) {
  return target.maxPages
    ? Math.min(target.maxPages, FULL_PAGES_MAX)
    : (target.last_truncated ? DEEP_PAGES_MAX : DEEP_PAGES);
}

async function sweepTarget(target, stats, { refresh = false } = {}) {
  // M-M corsia refresh: target saturo (0 nuovi all'ultimo crawl pieno) → solo pagina-1
  // sortByDate (i nuovi stanno in cima), niente split/markGone/marketSize. Decide il drainer
  // (shouldRefresh). `:run …full|pN` (target.maxPages) e i tronca NON sono refresh.
  const cap = refresh ? REFRESH_PAGES : capForTarget(target);
  const opts = { maxPages: cap, attachRaw: true, sortByDate: true, withMeta: true };
  let anyTrunc = false, skippedAny = false;

  // AS24 (solo se la marca è su AS24)
  const as = resolveAutoscout(target);
  if (as) {
    if (await health.isBackedOff('imac', 'autoscout', BACKOFF_HOURS)) {
      console.log(`[crawler] AS24 in back-off (blocked recente) → salto ${target.marca} ${target.modello}`);
      skippedAny = true;
    } else if (refresh) try {
      // M-M corsia refresh: 1 pagina sortByDate → prende i nuovi in cima. Niente count/split
      // (un saturo grande spaccherebbe in 34pp/fetta = non più cheap), niente markGone (vista
      // parziale → il venduto lo ripiglia il deep crawl a saturazione scaduta), niente marketSize.
      const part = await scrapeAutoscoutGraphql({ tipo: target.tipo, mmmvAutoscout: as.mmmv }, opts);
      const r = await repo.upsertListings(part.items, target);
      stats.written += r.written;
      stats.inserted = (stats.inserted || 0) + r.inserted;
      stats.as += part.items.length;
      await health.record('autoscout', { count: part.items.length });
    } catch (e) {
      console.warn(`[crawler] AS24 refresh fallito ${target.marca} ${target.modello}: ${e.message}`);
      skippedAny = true;   // review: fonte non vista → NON dichiarare complete/saturo
      stats.errors++;
      await health.record('autoscout', { error: e });
    } else try {
      // M-K: AS24 `listings()` si ferma a ~1629/query → per i target grandi spezziamo la
      // query (per anno, poi prezzo) così ogni sotto-sweep sta sotto il tetto ed è
      // paginabile per intero. La count-query (cheap) serve sia a decidere lo split sia
      // al tetto copertura → 1 sola chiamata. Le fette dedupano nell'upsert (url = PK).
      const countFn = (range) => scrapeAutoscoutGraphql.fetchTotalCount({ mmmv: as.mmmv, tipo: target.tipo, ...range });
      let total = null;
      try { total = await countFn({}); } catch (_) { /* count KO → sweep singola */ }
      // Il tetto ignoto non e' un dettaglio: senza, non si spezza la query (quindi sui
      // best-seller si spazzola col cap corto) e `marketSize.record` non scrive nessuna
      // riga, cioe' la copertura smette di essere misurata. Va detto, non dedotto.
      if (total == null) console.warn(`[crawler] AS24 ${target.marca} ${target.modello}: conteggio non disponibile → niente split e niente copertura per questo giro`);
      const buckets = (total != null && total > scrapeAutoscoutGraphql.SPLIT_OVER)
        ? await scrapeAutoscoutGraphql.planBuckets(countFn, {})
        : [{}];
      // sweep-fetta: servono ≥ SPLIT_OVER/PAGE_SIZE pagine (≈30) altrimenti un bucket
      // grande tronca col cap default (DEEP_PAGES=10) → maxPages alzato + delay gentile.
      const sweepOpts = buckets.length > 1
        ? { ...opts, maxPages: Math.max(cap, 34), pageDelayMs: THROTTLE_MS }
        : opts;
      const items = [];
      let truncated = false;
      for (let i = 0; i < buckets.length; i++) {
        if (i > 0) await sleep(THROTTLE_MS);   // gentile tra le fette
        const b = buckets[i];
        const part = await scrapeAutoscoutGraphql({
          tipo: target.tipo, mmmvAutoscout: as.mmmv,
          annoMin: b.annoMin, annoMax: b.annoMax, prezzoMin: b.prezzoMin, prezzoMax: b.prezzoMax,
        }, sweepOpts);
        items.push(...part.items);
        if (part.truncated) truncated = true;
      }
      const r = await repo.upsertListings(items, target);
      // markGone SOLO con vista completa (nessuna fetta troncata): con lo split le fette
      // stanno sotto il tetto → di norma complete; se una tronca, niente venduto.
      // onlyDated sui crawl splittati: le fette filtrano per anno → gli annunci anno=NULL non
      // sono in nessuna fetta e NON vanno marcati venduti (li rivede una sweep non-splittata).
      if (!truncated) await repo.markGone(target, items.map(i => i.url), { fonte: 'autoscout', onlyDated: buckets.length > 1 });
      else { anyTrunc = true; console.log(`[crawler] AS24 ${target.marca} ${target.modello}: vista parziale → skip venduto`); }
      stats.written += r.written;
      stats.inserted = (stats.inserted || 0) + r.inserted;   // M-E: righe NUOVE (onestà written)
      stats.as += items.length;
      if (buckets.length > 1) console.log(`[crawler] AS24 ${target.marca} ${target.modello}: split ${buckets.length} fette (tot ~${total}) → ${items.length} raccolti`);
      await health.record('autoscout', { count: items.length });
      // F50 copertura: tetto = count totale (usato-only), già preso sopra per lo split.
      try { await marketSize.record(target, 'autoscout', total); } catch (_) { /* la copertura non tocca mai il crawl */ }
    } catch (e) {
      console.warn(`[crawler] AS24 fallito ${target.marca} ${target.modello}: ${e.message}`);
      skippedAny = true;   // review: AS24 non spazzolato → il target NON è complete né saturabile
      stats.errors++;
      await health.record('autoscout', { error: e });
    }
  }
  await sleep(THROTTLE_MS);

  // Subito hades
  if (await health.isBackedOff('imac', 'subito', BACKOFF_HOURS)) {
    console.log(`[crawler] Subito in back-off (blocked recente) → salto ${target.marca} ${target.modello}`);
    skippedAny = true;
  } else try {
    const { items: raw, truncated, total } = await scrapeSubitoApi({ tipo: target.tipo, marca: target.marca, modello: target.modello }, { maxPages: cap, attachRaw: true, withMeta: true });
    const items = raw.filter(i => titleMatchesModel(i.titolo, target.modello));
    const r = await repo.upsertListings(items, target);
    // Nota: il guard sul titolo riduce `items` ma il filtro è deterministico per
    // annuncio (non è un troncamento di vista) → markGone resta valido se !truncated.
    if (!truncated) await repo.markGone(target, items.map(i => i.url), { fonte: 'subito' });
    else { anyTrunc = true; console.log(`[crawler] Subito ${target.marca} ${target.modello}: vista parziale (cap ${cap}) → skip venduto`); }
    stats.written += r.written;
    stats.inserted = (stats.inserted || 0) + r.inserted;   // M-E: righe NUOVE
    stats.sub += items.length;
    await health.record('subito', { count: raw.length });
    await marketSize.record(target, 'subito', total);   // F50 copertura: count_all (gratis)
  } catch (e) {
    console.warn(`[crawler] Subito fallito ${target.marca} ${target.modello}: ${e.message}`);
    skippedAny = true;   // review: Subito non spazzolato → NON complete/saturo
    stats.errors++;
    await health.record('subito', { error: e });
  }

  // Moto.it — SOLO per i moto (sito specialista, HTTP-first cheerio). Deep
  // sequenziale con delay tra le pagine (anti-ban). Su blocco → throw taggato.
  if (target.tipo === 'moto') {
    await sleep(THROTTLE_MS);
    if (await health.isBackedOff('imac', 'moto', BACKOFF_HOURS)) {
      console.log(`[crawler] Moto.it in back-off (blocked recente) → salto ${target.marca} ${target.modello}`);
      skippedAny = true;
    } else try {
      const mt = await resolveMotoit(target);
      if (!mt) { console.log(`[crawler] Moto.it ${target.marca}: marca non su Moto.it → skip`); }
      else if (!mt.modelSlug) {
        // review: senza modelSlug la query è brand-only → Moto.it torna TUTTI gli annunci del
        // brand e upsertListings li etichetta col modello del target (nessun guard-titolo come
        // Subito) → dati inquinati. Skip la fonte e segnala 'non completo' (non è un no-op sano).
        console.log(`[crawler] Moto.it ${target.marca} ${target.modello}: modello non risolto → skip (niente brand-only)`);
        skippedAny = true;
      }
      else {
        const { items, truncated, total } = await scrapeMotoIt(
          { tipo: 'moto', marca: target.marca, modello: target.modello, motoitBrandSlug: mt.brandSlug, motoitModelSlug: mt.modelSlug },
          { maxPages: cap, withMeta: true, attachRaw: true, pageDelayMs: THROTTLE_MS }
        );
        const r = await repo.upsertListings(items, target);
        if (!truncated) await repo.markGone(target, items.map(i => i.url), { fonte: 'moto' });
        else { anyTrunc = true; console.log(`[crawler] Moto.it ${target.marca} ${target.modello}: vista parziale (cap ${cap}) → skip venduto`); }
        stats.written += r.written;
        stats.inserted = (stats.inserted || 0) + r.inserted;   // M-E: righe NUOVE
        stats.moto = (stats.moto || 0) + items.length;
        await health.record('moto', { count: items.length });
        await marketSize.record(target, 'moto', total);   // F50 copertura: "N annunci" (gratis)
      }
    } catch (e) {
      console.warn(`[crawler] Moto.it fallito ${target.marca} ${target.modello}: ${e.message}`);
      skippedAny = true;   // review: Moto.it non spazzolato → NON complete/saturo
      stats.errors++;
      await health.record('moto', { error: e });
    }
  }

  return { truncated: anyTrunc, complete: !anyTrunc && !skippedAny, skipped: skippedAny };
}

// ─── Sweep completa ───────────────────────────────────────────────────────────
// Stato esposto (per il trigger remoto + dashboard admin). Il guard `running`
// impedisce sweep concorrenti: il tick schedulato e il trigger manuale lo condividono.
let running = false;
let lastStartedAt = null;
let lastFinishedAt = null;
let lastStats = null;
let lastError = null;
function isRunning() { return running; }
function status() { return { running, lastStartedAt, lastFinishedAt, lastStats, lastError }; }

async function sweepAll({ withLock } = {}) {
  if (!db.isEnabled()) { console.warn('[crawler] DB non attivo → sweep saltata'); return null; }
  if (running) { console.log('[crawler] sweep già in corso → trigger ignorato'); return { skipped: 'running' }; }
  running = true;
  lastStartedAt = new Date().toISOString();
  lastError = null;
  // F12 — log-run persistente: apre la riga ORA, la chiude nel finally (anche se
  // _sweepAllCore crasha → niente run "appeso" con finished_at NULL per sempre).
  const runId = await runs.startRun('imac').catch(() => null);
  let stats = { written: 0, as: 0, sub: 0, errors: 0, targets: 0 };
  try {
    stats = await _sweepAllCore({ withLock });
    lastStats = stats;
    return stats;
  } catch (e) {
    lastError = e.message;
    stats.errors = (stats.errors || 0) + 1;
    throw e;
  } finally {
    running = false;
    lastFinishedAt = new Date().toISOString();
    if (runId) await runs.finishRun(runId, { targets: stats.targets || 0, written: stats.written || 0, errors: stats.errors || 0 }).catch(() => {});
  }
}

async function _sweepAllCore({ withLock } = {}) {
  await wl.seedFromFile();
  await syncSavedSearches();
  const activated = await wl.activateRamp(RAMP_PER_DAY);
  // F5 — partizione: l'iMac spazzola SOLO i suoi target (assigned_node='imac' o NULL).
  const targets = await wl.dueTargets('imac');
  const c = await wl.counts();
  console.log(`[crawler] sweep avvio: ${targets.length} attivi (+${activated.length} nuovi) · ${c.pending} in coda`);

  // ⚠️ `stats` è CONDIVISO tra tutti i target di questa sweep (accumula). Va bene perché
  // qui markSwept è la forma LEGACY (no written/inserted) → la saturazione NON si attiva.
  // NON aggiungere inserted/written a questo markSwept senza prima dare a ogni target uno
  // `stats` proprio: altrimenti la saturazione vedrebbe i conteggi cumulativi (target N =
  // somma 1..N) e sbaglierebbe. Il drainer (crawl-once.js) usa già uno stats per-job.
  const stats = { written: 0, as: 0, sub: 0, errors: 0, targets: targets.length };
  const runOne = t => async () => {
    const meta = await sweepTarget(t, stats);
    // F13 — persisti truncated/complete: pilota l'escalation cap del prossimo giro
    // e distingue "popolato" (vista completa) da "in fill" sulla dashboard.
    await wl.markSwept(t.id, { truncated: meta.truncated, complete: meta.complete });
  };
  for (const t of targets) {
    const task = runOne(t);
    if (withLock) await withLock(task); else await task();
    await sleep(THROTTLE_MS);
  }
  console.log(`[crawler] sweep fine: ${stats.written} scritti (AS24 ${stats.as} · Subito ${stats.sub} · err ${stats.errors})`);
  return stats;
}

// Importa nella watch-list i target delle ricerche salvate (marca+modello presenti).
async function syncSavedSearches() {
  try {
    const saved = require('./saved');
    const list = saved.listSaved ? saved.listSaved() : [];
    const targets = list
      .map(s => s.params || {})
      .filter(p => p.tipo && p.marca && p.modello)
      .map(p => ({ tipo: p.tipo, marca: p.marca, modello: p.modello }));
    if (targets.length) await wl.insertTargets(targets);
  } catch (e) {
    console.warn('[crawler] sync saved-searches saltato:', e.message);
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
let timer = null;
function start({ withLock } = {}) {
  if (!db.isEnabled()) { console.warn('[crawler] DATABASE_URL assente → crawler OFF'); return; }
  if (timer) return;
  const tick = () => sweepAll({ withLock }).catch(e => console.error('[crawler] sweep errore:', e.message));
  setTimeout(tick, FIRST_RUN_DELAY_MS);                 // primo run differito post-boot
  timer = setInterval(tick, SWEEP_INTERVAL_MS);          // poi 1×/giorno
  if (timer.unref) timer.unref();
  console.log(`[crawler] schedulato (ogni 24h, primo run tra ${FIRST_RUN_DELAY_MS / 1000}s, ${DEEP_PAGES} pag/target)`);
}

module.exports = { start, sweepAll, sweepTarget, isRunning, status, _titleMatchesModel: titleMatchesModel, _resolveAutoscout: resolveAutoscout, _resolveMotoit: resolveMotoit, _capForTarget: capForTarget };
