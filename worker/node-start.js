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
const { spawn, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const CFG_PATH = path.join(__dirname, 'node.config.json');

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
    mode: 'both', sources: 'all', intervalHours: 6, pages: 30, pageDelayMs: 1500,
    autoPull: true, branch: 'feat/ui-redesign-rating-grouping', maxMin: 30,
  }, c);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const firstLine = s => ((s || '') + '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';

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
function runWorker(cfg) {
  return new Promise(resolve => {
    const env = Object.assign({}, process.env, {
      CENTRAL_URL: cfg.centralUrl, CRAWL_PASSWORD: cfg.password, DEVICE: cfg.device,
      WORKER_MODE: cfg.mode, WORKER_SOURCES: cfg.sources,
      WORKER_PAGES: String(cfg.pages), WORKER_PAGE_DELAY_MS: String(cfg.pageDelayMs),
    });
    const child = spawn(process.execPath, [path.join(REPO, 'worker', 'worker.js')], { cwd: REPO, env, stdio: 'inherit' });
    const wd = setTimeout(() => {
      console.error(`[launcher] 🟡 watchdog: worker oltre ${cfg.maxMin}min → lo termino.`);
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
    }, cfg.maxMin * 60000);
    child.on('exit', code => { clearTimeout(wd); resolve(code); });
    child.on('error', err => { clearTimeout(wd); console.error('[launcher] spawn worker errore:', err.message); resolve(-1); });
  });
}

(async () => {
  const cfg = loadConfig();
  console.log(`[launcher] nodo '${cfg.device}' → ${cfg.centralUrl} · intervallo ${cfg.intervalHours}h · autoPull=${cfg.autoPull}`);
  for (;;) {
    if (cfg.autoPull) gitPull(cfg.branch);
    ensureCheerio();
    console.log('[launcher] avvio worker …');
    await runWorker(cfg);
    console.log(`[launcher] giro finito. Prossimo tra ${cfg.intervalHours}h. (Ctrl-C per fermare)`);
    await sleep(cfg.intervalHours * 3600 * 1000);
  }
})();
