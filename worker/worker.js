'use strict';
/**
 * Worker fill distribuito (F3) — gira su un 2° device (es. Surface).
 *
 * Prende 1 target mai crawlato dal coordinatore (lease), lo crawla dal PROPRIO
 * IP (AS24 + Subito, solo API HTTP), e rimanda i risultati (ingest). Loop finché
 * non ci sono più target. Niente DB, niente npm install: usa solo `https` +
 * i due scraper standalone del repo.
 *
 * Avvio (dalla root del repo clonato):
 *   CENTRAL_URL=https://<funnel-url> CRAWL_PASSWORD=... DEVICE=surface \
 *   WORKER_PAGES=30 node worker/worker.js
 */
const https = require('https');
const http  = require('http');
const { URL } = require('url');
const scrapeAS  = require('../backend/scrapers/autoscout-graphql');
const scrapeSub = require('../backend/scrapers/subito-api');

const CENTRAL = process.env.CENTRAL_URL;
const PASSWORD = process.env.CRAWL_PASSWORD;
const DEVICE   = process.env.DEVICE || 'worker';
const PAGES    = parseInt(process.env.WORKER_PAGES || '30', 10);
const THROTTLE = parseInt(process.env.WORKER_THROTTLE_MS || '1500', 10);
const PAGE_DELAY = parseInt(process.env.WORKER_PAGE_DELAY_MS || '1500', 10);   // pausa tra le pagine
const MAX_TARGETS = parseInt(process.env.WORKER_MAX_TARGETS || '0', 10);        // 0 = illimitato (test usa un numero piccolo)
const SOURCES = (process.env.WORKER_SOURCES || 'all').toLowerCase();            // 'all' | 'moto'
// F5 — mode del lease: 'fill' (backfill never-swept), 'due' (refresh >20h), 'both'.
//  - 'both' = prima drena fill (popola i target nuovi assegnati al nodo), poi due
//    (rinfresca gli stantii) → il nodo si tiene popolato + fresco in un solo run.
const MODE = (process.env.WORKER_MODE || 'both').toLowerCase();
const MODES = MODE === 'fill' ? ['fill'] : MODE === 'due' ? ['due'] : ['fill', 'due'];

// Scraper Moto.it caricato LAZY (richiede cheerio sul nodo). Null se manca.
let _motoScraper;
function getMotoScraper() {
  if (_motoScraper !== undefined) return _motoScraper;
  try { _motoScraper = require('../backend/scrapers/motoit'); }
  catch (e) { console.log('  moto.it: scraper non caricabile (manca cheerio? `npm install cheerio`):', e.message); _motoScraper = null; }
  return _motoScraper;
}

if (!CENTRAL || !PASSWORD) {
  console.error('Servono le env CENTRAL_URL e CRAWL_PASSWORD.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Richiesta HTTP/HTTPS verso il centrale → {status, headers, body}.
// Protocollo dall'URL → testabile in locale (http) e robusto in prod (https Funnel).
function req(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const data = body != null ? Buffer.from(body, 'utf8') : null;
    if (data) headers['content-length'] = data.length;
    const r = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method, headers,
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('timeout centrale')));
    if (data) r.write(data);
    r.end();
  });
}

// Login → cookie di sessione (amr_auth). /login risponde 302 + Set-Cookie.
async function login() {
  const res = await req(CENTRAL + '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(PASSWORD),
  });
  const sc = res.headers['set-cookie'];
  if (!sc || !sc.length) throw new Error(`login fallito (status ${res.status}) — password giusta? Funnel acceso?`);
  const cookie = sc.map(s => s.split(';')[0]).find(s => s.startsWith('amr_auth='));
  if (!cookie) throw new Error('login: cookie amr_auth assente');
  return cookie;
}

async function getJson(cookie, path) {
  const res = await req(CENTRAL + path, { headers: { cookie, accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`GET ${path} → ${res.status}`);
  return JSON.parse(res.body);
}
async function postJson(cookie, path, obj) {
  const res = await req(CENTRAL + path, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(obj),
  });
  if (res.status !== 200) throw new Error(`POST ${path} → ${res.status}: ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

// Crawla una fonte; ritorna {fonte, items, truncated} o {fonte, items:[], error}.
async function crawlSource(fonte, fn) {
  try {
    const { items, truncated } = await fn();
    console.log(`  ${fonte}: ${items.length} annunci${truncated ? ' (troncato al cap)' : ''}`);
    return { fonte, items, truncated };
  } catch (e) {
    const tag = e.kind === 'blocked' ? '🔴 BLOCCATO' : (e.kind || 'errore');
    console.log(`  ${fonte}: ${tag} — ${e.message}`);
    return { fonte, items: [], truncated: false, error: { status: e.status || null, kind: e.kind || 'error', message: e.message } };
  }
}

// Riprova una chiamata di rete fino a `tries` volte (backoff). Non per i 200.
async function withRetry(label, fn, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      console.log(`  ${label}: tentativo ${i}/${tries} fallito (${e.message})`);
      if (i < tries) await sleep(2000 * i);
    }
  }
  throw last;
}

// Crawla+ingesta UN target. Ritorna 'ok' | 'skip' | 'blocked' | 'central-down'.
async function processTarget(cookie, t, opts, n, mode) {
  console.log(`[${n}] ${t.tipo} ${t.marca} ${t.modello} (id ${t.id})`);
  try {
    const doAuto = SOURCES === 'all';
    const doMoto = SOURCES === 'all' || SOURCES === 'moto';
    const sources = [];

    if (doAuto && t.mmmv) {
      sources.push(await crawlSource('autoscout', () => scrapeAS({ tipo: t.tipo, mmmvAutoscout: t.mmmv }, opts)));
      await sleep(THROTTLE);
    } else if (doAuto) {
      console.log('  autoscout: saltato (marca non su AS24)');
    }
    if (doAuto) {
      sources.push(await crawlSource('subito', () => scrapeSub({ tipo: t.tipo, marca: t.marca, modello: t.modello }, opts)));
    }
    // Moto.it (solo target moto con slug dal lease)
    if (doMoto && t.tipo === 'moto' && t.motoitBrandSlug) {
      const sm = getMotoScraper();
      if (sm) {
        await sleep(THROTTLE);
        sources.push(await crawlSource('moto', () => sm(
          { tipo: 'moto', marca: t.marca, modello: t.modello, motoitBrandSlug: t.motoitBrandSlug, motoitModelSlug: t.motoitModelSlug },
          { maxPages: PAGES, withMeta: true, attachRaw: false, pageDelayMs: PAGE_DELAY }
        )));
      }
    }

    const r = await withRetry('ingest', () => postJson(cookie, '/api/crawl/ingest', { id: t.id, device: DEVICE, sources, mode }));
    console.log(`  → ingest: ${r.written} scritti sul centrale`);

    // Tutte le fonti tentate sono bloccate → segnala stop (anti-ban).
    const tried = sources.filter(s => s.error || s.items.length >= 0);
    if (tried.length && tried.every(s => s.error && s.error.kind === 'blocked')) return 'blocked';
    return 'ok';
  } catch (e) {
    console.error(`  target id ${t.id} SALTATO: ${e.message} (resta riprovabile dopo, il lease scade in 15min)`);
    return 'skip';
  }
}

// Drena tutti i target di un dato mode finché ce ne sono (o limite/blocco/centrale giù).
// Aggiorna lo state condiviso. Ritorna true se può proseguire, false se stop globale.
async function drain(cookie, mode, opts, state) {
  console.log(`[worker ${DEVICE}] mode=${mode} → inizio.`);
  for (;;) {
    if (MAX_TARGETS && state.done + state.skipped >= MAX_TARGETS) {
      console.log(`[worker ${DEVICE}] raggiunto WORKER_MAX_TARGETS=${MAX_TARGETS} → stop.`);
      return false;
    }
    // Il lease DEVE riuscire per proseguire: se il centrale è irraggiungibile → esci pulito.
    let t;
    try { t = await withRetry('lease', () => getJson(cookie, `/api/crawl/lease?device=${encodeURIComponent(DEVICE)}&mode=${mode}`)); }
    catch (e) { console.error(`[worker ${DEVICE}] centrale irraggiungibile → esco. (${e.message})`); return false; }
    if (t.none) { console.log(`[worker ${DEVICE}] mode=${mode}: nessun target rimasto.`); return true; }

    const outcome = await processTarget(cookie, t, opts, state.done + state.skipped + 1, mode);
    if (outcome === 'ok' || outcome === 'blocked') state.done++; else state.skipped++;
    if (outcome === 'blocked') {
      console.error(`[worker ${DEVICE}] tutte le fonti BLOCCATE → mi fermo per non peggiorare.`);
      return false;
    }
    await sleep(THROTTLE);
  }
}

async function run() {
  console.log(`[worker ${DEVICE}] login a ${CENTRAL} …`);
  const cookie = await login();
  console.log(`[worker ${DEVICE}] connesso. Pagine/target=${PAGES}, pausa-pagina=${PAGE_DELAY}ms, modi=[${MODES.join(',')}]. Inizio.`);
  // pageDelayMs = pausa TRA le pagine (anti-ban su crawl profondo).
  const opts = { maxPages: PAGES, withMeta: true, attachRaw: false, pageDelayMs: PAGE_DELAY };
  const state = { done: 0, skipped: 0 };

  for (const mode of MODES) {
    const cont = await drain(cookie, mode, opts, state);
    if (!cont) break;   // limite/blocco/centrale giù → non passare al mode successivo
  }
  if (state.done + state.skipped === 0) {
    console.warn(`[worker ${DEVICE}] ⚠️ 0 target per '${DEVICE}'. Nessun target assegnato a questo nodo → assegnali dal pannello admin (nodo ${DEVICE}).`);
  }
  console.log(`[worker ${DEVICE}] FINE. Completati: ${state.done}, saltati: ${state.skipped}.`);
}

run().catch(e => { console.error(`[worker ${DEVICE}] errore fatale:`, e.message); process.exit(1); });
