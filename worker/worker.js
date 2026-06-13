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
const { URL } = require('url');
const scrapeAS  = require('../backend/scrapers/autoscout-graphql');
const scrapeSub = require('../backend/scrapers/subito-api');

const CENTRAL = process.env.CENTRAL_URL;
const PASSWORD = process.env.CRAWL_PASSWORD;
const DEVICE   = process.env.DEVICE || 'worker';
const PAGES    = parseInt(process.env.WORKER_PAGES || '30', 10);
const THROTTLE = parseInt(process.env.WORKER_THROTTLE_MS || '1500', 10);

if (!CENTRAL || !PASSWORD) {
  console.error('Servono le env CENTRAL_URL e CRAWL_PASSWORD.');
  process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Richiesta HTTPS generica → {status, headers, body}.
function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = body != null ? Buffer.from(body, 'utf8') : null;
    if (data) headers['content-length'] = data.length;
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method, headers,
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout centrale')));
    if (data) req.write(data);
    req.end();
  });
}

// Login → cookie di sessione (amr_auth). /login risponde 302 + Set-Cookie.
async function login() {
  const res = await httpsRequest(CENTRAL + '/login', {
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
  const res = await httpsRequest(CENTRAL + path, { headers: { cookie, accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`GET ${path} → ${res.status}`);
  return JSON.parse(res.body);
}
async function postJson(cookie, path, obj) {
  const res = await httpsRequest(CENTRAL + path, {
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

async function run() {
  console.log(`[worker ${DEVICE}] login a ${CENTRAL} …`);
  const cookie = await login();
  console.log(`[worker ${DEVICE}] connesso. Pagine/target=${PAGES}. Inizio fill.`);
  const opts = { maxPages: PAGES, withMeta: true, attachRaw: false };
  let done = 0;

  for (;;) {
    const t = await getJson(cookie, `/api/crawl/lease?device=${encodeURIComponent(DEVICE)}`);
    if (t.none) { console.log(`[worker ${DEVICE}] nessun target rimasto → fine. Completati: ${done}.`); break; }
    console.log(`[${++done}] ${t.tipo} ${t.marca} ${t.modello} (id ${t.id})`);

    const sources = [];
    if (t.mmmv) {
      sources.push(await crawlSource('autoscout', () => scrapeAS({ tipo: t.tipo, mmmvAutoscout: t.mmmv }, opts)));
      await sleep(THROTTLE);
    } else {
      console.log('  autoscout: saltato (marca non su AS24)');
    }
    sources.push(await crawlSource('subito', () => scrapeSub({ tipo: t.tipo, marca: t.marca, modello: t.modello }, opts)));

    const r = await postJson(cookie, '/api/crawl/ingest', { id: t.id, device: DEVICE, sources });
    console.log(`  → ingest: ${r.written} scritti sul centrale`);

    // Se entrambe le fonti sono bloccate → fermati, non insistere (anti-ban).
    if (sources.every(s => s.error && s.error.kind === 'blocked')) {
      console.error(`[worker ${DEVICE}] entrambe le fonti BLOCCATE → mi fermo per non peggiorare.`);
      break;
    }
    await sleep(THROTTLE);
  }
}

run().catch(e => { console.error(`[worker ${DEVICE}] errore fatale:`, e.message); process.exit(1); });
