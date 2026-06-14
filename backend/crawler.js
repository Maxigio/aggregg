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
const scrapeAutoscoutGraphql = require('./scrapers/autoscout-graphql');
const scrapeSubitoApi = require('./scrapers/subito-api');
const scrapeMotoIt = require('./scrapers/motoit');
const { resolveMotoitSlug } = require('./scrapers/motoit-brands');
const { resolveMotoitModelSlug } = require('./scrapers/motoit-models');
const { norm, makeResolver, makeModelResolver, loadAliasMap } = require('./scrapers/brand-match');

const modelsData = require('../data/models.json');

const DEEP_PAGES   = parseInt(process.env.CRAWLER_PAGES || '10', 10);   // cap profondità/target
const RAMP_PER_DAY = parseInt(process.env.CRAWLER_RAMP  || '10', 10);   // nuovi target/giorno
const THROTTLE_MS  = parseInt(process.env.CRAWLER_THROTTLE_MS || '1500', 10);
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
function titleMatchesModel(titolo, modello) {
  const nt = norm(titolo);
  const tokens = norm(modello).split('-').filter(t => t.length >= 2);
  if (!tokens.length) return true;
  return tokens.every(tok => nt.includes(tok));
}

// ─── Sweep di un singolo target ───────────────────────────────────────────────
async function sweepTarget(target, stats) {
  const opts = { maxPages: DEEP_PAGES, attachRaw: true, sortByDate: true, withMeta: true };

  // AS24 (solo se la marca è su AS24)
  const as = resolveAutoscout(target);
  if (as) {
    try {
      const { items, truncated } = await scrapeAutoscoutGraphql({ tipo: target.tipo, mmmvAutoscout: as.mmmv }, opts);
      const r = await repo.upsertListings(items, target);
      // markGone SOLO con vista completa: se troncato al cap, l'assenza di un
      // annuncio non è affidabile (potrebbe essere oltre il cap) → niente venduto.
      if (!truncated) await repo.markGone(target, items.map(i => i.url), { fonte: 'autoscout' });
      else console.log(`[crawler] AS24 ${target.marca} ${target.modello}: vista parziale (cap) → skip venduto`);
      stats.written += r.written;
      stats.as += items.length;
      await health.record('autoscout', { count: items.length });
    } catch (e) {
      console.warn(`[crawler] AS24 fallito ${target.marca} ${target.modello}: ${e.message}`);
      await health.record('autoscout', { error: e });
    }
  }
  await sleep(THROTTLE_MS);

  // Subito hades
  try {
    const { items: raw, truncated } = await scrapeSubitoApi({ tipo: target.tipo, marca: target.marca, modello: target.modello }, { maxPages: DEEP_PAGES, attachRaw: true, withMeta: true });
    const items = raw.filter(i => titleMatchesModel(i.titolo, target.modello));
    const r = await repo.upsertListings(items, target);
    // Nota: il guard sul titolo riduce `items` ma il filtro è deterministico per
    // annuncio (non è un troncamento di vista) → markGone resta valido se !truncated.
    if (!truncated) await repo.markGone(target, items.map(i => i.url), { fonte: 'subito' });
    else console.log(`[crawler] Subito ${target.marca} ${target.modello}: vista parziale (cap) → skip venduto`);
    stats.written += r.written;
    stats.sub += items.length;
    await health.record('subito', { count: raw.length });
  } catch (e) {
    console.warn(`[crawler] Subito fallito ${target.marca} ${target.modello}: ${e.message}`);
    await health.record('subito', { error: e });
  }

  // Moto.it — SOLO per i moto (sito specialista, HTTP-first cheerio). Deep
  // sequenziale con delay tra le pagine (anti-ban). Su blocco → throw taggato.
  if (target.tipo === 'moto') {
    await sleep(THROTTLE_MS);
    try {
      const mt = await resolveMotoit(target);
      if (!mt) { console.log(`[crawler] Moto.it ${target.marca}: marca non su Moto.it → skip`); }
      else {
        const { items, truncated } = await scrapeMotoIt(
          { tipo: 'moto', marca: target.marca, modello: target.modello, motoitBrandSlug: mt.brandSlug, motoitModelSlug: mt.modelSlug },
          { maxPages: DEEP_PAGES, withMeta: true, attachRaw: true, pageDelayMs: THROTTLE_MS }
        );
        const r = await repo.upsertListings(items, target);
        if (!truncated) await repo.markGone(target, items.map(i => i.url), { fonte: 'moto' });
        else console.log(`[crawler] Moto.it ${target.marca} ${target.modello}: vista parziale (cap) → skip venduto`);
        stats.written += r.written;
        stats.moto = (stats.moto || 0) + items.length;
        await health.record('moto', { count: items.length });
      }
    } catch (e) {
      console.warn(`[crawler] Moto.it fallito ${target.marca} ${target.modello}: ${e.message}`);
      await health.record('moto', { error: e });
    }
  }
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
  try {
    const stats = await _sweepAllCore({ withLock });
    lastStats = stats;
    return stats;
  } catch (e) {
    lastError = e.message;
    throw e;
  } finally {
    running = false;
    lastFinishedAt = new Date().toISOString();
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

  const stats = { written: 0, as: 0, sub: 0 };
  const runOne = t => async () => {
    await sweepTarget(t, stats);
    await wl.markSwept(t.id);
  };
  for (const t of targets) {
    const task = runOne(t);
    if (withLock) await withLock(task); else await task();
    await sleep(THROTTLE_MS);
  }
  console.log(`[crawler] sweep fine: ${stats.written} scritti (AS24 ${stats.as} · Subito ${stats.sub})`);
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

module.exports = { start, sweepAll, sweepTarget, isRunning, status, _titleMatchesModel: titleMatchesModel, _resolveAutoscout: resolveAutoscout, _resolveMotoit: resolveMotoit };
