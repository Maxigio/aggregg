#!/usr/bin/env node
'use strict';
/**
 * Launcher nodo (F8). Gira in LOOP su un computer-nodo (Surface/massimo):
 *   1. git pull --ff-only  → auto-aggiorna il codice (codice vecchio = bug doloroso)
 *   2. assicura cheerio    → serve a Moto.it (3° sito)
 *   3. spawn worker.js     → PROCESSO NUOVO ogni giro = codice appena pullato + login fresco
 *   4. dorme intervalHours → ripete
 *
 * Config: worker/node.config.json (GITIGNORED). Copia node.config.example.json e compila.
 * Avvio: node worker/node-start.js   (o doppio-click start-node.command / start-node.bat)
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CFG_PATH = path.join(__dirname, 'node.config.json');
// F9 — bundle scaricato dal centrale (modo 'central'): vive accanto a node-start.js,
// così il nodo può girare ANCHE senza il repo (solo node-start.js + config + dist/).
const DIST = path.join(__dirname, 'dist');
const BUNDLE = path.join(DIST, 'worker-bundle.js');
const VERFILE = path.join(DIST, '.bundle-version');

function loadConfig() {
  let raw;
  try { raw = fs.readFileSync(CFG_PATH, 'utf8'); }
  catch (e) {
    console.error(`[launcher] config mancante: ${CFG_PATH}`);
    console.error('[launcher]   → copia worker/node.config.example.json in worker/node.config.json e compila.');
    process.exit(1);
  }
  let c;
  try { c = JSON.parse(raw); } catch (e) { console.error('[launcher] config JSON non valido:', e.message); process.exit(1); }
  for (const k of ['centralUrl', 'password', 'device']) {
    if (!c[k]) { console.error(`[launcher] config: campo obbligatorio mancante "${k}"`); process.exit(1); }
  }
  return Object.assign({
    updateMode: 'central',   // 'central' (scarica bundle, no git) | 'git' | 'none'
    mode: 'both', sources: 'all', intervalHours: 6, pages: 30, pageDelayMs: 1500,
    autoPull: true, branch: 'feat/ui-redesign-rating-grouping', maxMin: 30,
  }, c);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const firstLine = s => ((s || '') + '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';

// ─── F9 — modo 'central': scarica il bundle dal centrale (niente git/npm) ──────
// Richiesta http/https → {status, headers, body:Buffer}. Protocollo dall'URL.
function req(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const data = body != null ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : null;
    if (data) headers['content-length'] = data.length;
    const r = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('timeout centrale')));
    if (data) r.write(data);
    r.end();
  });
}

async function login(cfg) {
  const res = await req(cfg.centralUrl + '/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=' + encodeURIComponent(cfg.password),
  });
  const sc = res.headers['set-cookie'];
  if (!sc || !sc.length) throw new Error(`login fallito (status ${res.status}) — password giusta? centrale su?`);
  const cookie = sc.map(s => s.split(';')[0]).find(s => s.startsWith('amr_auth='));
  if (!cookie) throw new Error('login: cookie amr_auth assente');
  return cookie;
}

const readLocalVersion = () => { try { return fs.readFileSync(VERFILE, 'utf8').trim(); } catch (_) { return null; } };

// Scarica il bundle se la versione remota è cambiata. Verifica sha256 + rename atomico
// (niente esecuzione di un download parziale/corrotto). Ritorna il path del bundle locale.
async function centralUpdate(cfg) {
  const cookie = await login(cfg);
  const vr = await req(cfg.centralUrl + '/api/worker/bundle/version', { headers: { cookie, accept: 'application/json' } });
  if (vr.status !== 200) throw new Error('version → ' + vr.status);
  const remote = JSON.parse(vr.body.toString('utf8')).version;
  if (remote && remote === readLocalVersion() && fs.existsSync(BUNDLE)) {
    console.log('[launcher] bundle già aggiornato');
    return BUNDLE;
  }
  const br = await req(cfg.centralUrl + '/api/worker/bundle.js', { headers: { cookie } });
  if (br.status !== 200) throw new Error('bundle → ' + br.status);
  const sha = crypto.createHash('sha256').update(br.body).digest('hex');
  if (remote && sha !== remote) throw new Error('hash mismatch (download corrotto)');
  fs.mkdirSync(DIST, { recursive: true });
  const tmp = BUNDLE + '.tmp';
  fs.writeFileSync(tmp, br.body);
  fs.renameSync(tmp, BUNDLE);           // rename atomico
  fs.writeFileSync(VERFILE, sha);
  console.log(`[launcher] bundle aggiornato → v${sha.slice(0, 12)} (${br.body.length} byte)`);
  return BUNDLE;
}

// git pull --ff-only: aggiorna il codice. Mai bloccante: se fallisce → WARN rosso + continua.
function gitPull(branch) {
  const r = spawnSync('git', ['pull', '--ff-only', 'origin', branch], { cwd: REPO, encoding: 'utf8' });
  if (r.status === 0) {
    if (/Already up to date/i.test(r.stdout || '')) console.log('[launcher] git: già aggiornato');
    else console.log('[launcher] git: AGGIORNATO →', firstLine(r.stdout));
  } else {
    console.error('[launcher] 🔴 git pull FALLITO → uso il codice ATTUALE (forse vecchio):', firstLine(r.stderr || r.stdout || (r.error && r.error.message)));
    console.error('[launcher]    verifica auth git non-interattiva sul nodo (chiave SSH o remote HTTPS+token).');
  }
}

// cheerio serve a Moto.it. Se manca → install MIRATO (no full install = niente playwright).
function ensureCheerio() {
  try { require.resolve('cheerio'); return; } catch (_) { /* manca */ }
  console.log('[launcher] cheerio mancante → npm install cheerio …');
  const r = spawnSync('npm', ['install', 'cheerio'], { cwd: REPO, encoding: 'utf8', shell: true }); // shell:true per Windows (npm.cmd)
  if (r.status === 0) console.log('[launcher] cheerio installato');
  else console.error('[launcher] 🟡 npm install cheerio fallito (Moto.it sarà saltato):', firstLine(r.stderr));
}

// Spawn del worker come PROCESSO NUOVO (process.execPath = path assoluto del node → ok Windows).
// Watchdog: se non esce entro maxMin → lo termino, poi prossimo giro (no loop bloccato da stallo rete).
// Spawn del worker come PROCESSO NUOVO (process.execPath = path assoluto del node → ok Windows).
// scriptPath = bundle (modo central) o worker.js (modo git/none). Watchdog max-runtime.
function runWorker(cfg, scriptPath) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, {
      CENTRAL_URL: cfg.centralUrl, CRAWL_PASSWORD: cfg.password, DEVICE: cfg.device,
      WORKER_MODE: cfg.mode, WORKER_SOURCES: cfg.sources,
      WORKER_PAGES: String(cfg.pages), WORKER_PAGE_DELAY_MS: String(cfg.pageDelayMs),
    });
    const child = spawn(process.execPath, [scriptPath], { cwd: path.dirname(scriptPath), env, stdio: 'inherit' });
    const wd = setTimeout(() => {
      console.error(`[launcher] 🟡 watchdog: worker oltre ${cfg.maxMin}min → lo termino.`);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
    }, cfg.maxMin * 60000);
    child.on('exit', code => { clearTimeout(wd); resolve(code); });
    child.on('error', err => { clearTimeout(wd); console.error('[launcher] spawn worker errore:', err.message); resolve(-1); });
  });
}

// Prepara il codice da eseguire secondo updateMode. Ritorna lo scriptPath, o null (salta il giro).
async function prepareScript(cfg) {
  if (cfg.updateMode === 'central') {
    try { return await centralUpdate(cfg); }
    catch (e) {
      console.error('[launcher] 🔴 update centrale fallito:', e.message);
      if (fs.existsSync(BUNDLE)) { console.error('[launcher]    uso il bundle locale esistente'); return BUNDLE; }
      console.error('[launcher]    nessun bundle locale → salto il giro');
      return null;
    }
  }
  if (cfg.updateMode === 'git') {
    if (cfg.autoPull) gitPull(cfg.branch);
    ensureCheerio();
  }
  return path.join(REPO, 'worker', 'worker.js');   // git/none: usa il repo locale
}

(async () => {
  const cfg = loadConfig();
  console.log(`[launcher] nodo '${cfg.device}' → ${cfg.centralUrl} · intervallo ${cfg.intervalHours}h · updateMode=${cfg.updateMode}`);
  for (;;) {
    const scriptPath = await prepareScript(cfg);
    if (scriptPath) {
      console.log('[launcher] avvio worker …');
      await runWorker(cfg, scriptPath);
    }
    console.log(`[launcher] giro finito. Prossimo tra ${cfg.intervalHours}h. (Ctrl-C per fermare)`);
    await sleep(cfg.intervalHours * 3600 * 1000);
  }
})();
