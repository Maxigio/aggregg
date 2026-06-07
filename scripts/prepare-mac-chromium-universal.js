#!/usr/bin/env node
/**
 * Prepara Chromium per una build mac UNIVERSALE: mette in pw-browsers/chromium-<rev>/
 * SIA chrome-mac-arm64 SIA chrome-mac-x64, così l'unica .app gira su Apple Silicon
 * e su Intel (resolveChromiumExecutable in utils.js sceglie per process.arch).
 *
 * Scarica entrambe le varianti dal CDN ufficiale Playwright (Chrome for Testing):
 *   https://cdn.playwright.dev/builds/cft/<ver>/mac-arm64/chrome-mac-arm64.zip
 *   https://cdn.playwright.dev/builds/cft/<ver>/mac-x64/chrome-mac-x64.zip
 *
 * Uso: node scripts/prepare-mac-chromium-universal.js  (oppure npm run prepare:mac-universal)
 */
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const PW_BROWSERS   = path.join(ROOT, 'pw-browsers');
const BROWSERS_JSON = path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json');

function chromiumMeta() {
  const j = JSON.parse(fs.readFileSync(BROWSERS_JSON, 'utf8'));
  const c = j.browsers.find(b => b.name === 'chromium');
  if (!c) throw new Error('chromium non trovato in browsers.json');
  if (!c.browserVersion) throw new Error('browserVersion non trovata in browsers.json');
  return { rev: c.revision, ver: c.browserVersion };
}

// arch: { slug: 'mac-arm64'|'mac-x64', dir: 'chrome-mac-arm64'|'chrome-mac-x64' }
function present(base, dir) {
  return [
    path.join(base, dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(base, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ].some(p => fs.existsSync(p));
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const handle = res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, handle).on('error', reject); return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} su ${url}`)); return; }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    };
    https.get(url, handle).on('error', reject);
  });
}

async function ensureArch(ver, rev, slug, dir) {
  const base = path.join(PW_BROWSERS, `chromium-${rev}`);
  if (present(base, dir)) { console.log(`[universal] ✓ ${dir} già presente.`); return; }
  fs.mkdirSync(base, { recursive: true });
  const url = `https://cdn.playwright.dev/builds/cft/${ver}/${slug}/${dir}.zip`;
  const zip = path.join(base, `${dir}.zip`);
  console.log(`[universal] Download ${dir}: ${url}`);
  await download(url, zip);
  if (process.platform !== 'darwin') throw new Error('Scompattazione automatica solo su macOS (build universale va fatta su Mac).');
  execSync(`unzip -o "${zip}" -d "${base}"`, { stdio: 'inherit' });
  for (const exe of [
    path.join(base, dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(base, dir, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ]) if (fs.existsSync(exe)) { fs.chmodSync(exe, 0o755); break; }
  fs.unlinkSync(zip);
  if (!present(base, dir)) throw new Error(`${dir} non trovato dopo il download.`);
  console.log(`[universal] ✓ ${dir} pronto.`);
}

(async () => {
  if (process.platform !== 'darwin')
    console.warn('[universal] Da lanciare su macOS (la build --universal richiede macOS).');
  const { rev, ver } = chromiumMeta();
  console.log(`[universal] Chromium rev ${rev} ver ${ver}`);
  await ensureArch(ver, rev, 'mac-arm64', 'chrome-mac-arm64');
  await ensureArch(ver, rev, 'mac-x64',   'chrome-mac-x64');
  console.log('[universal] ✓ Entrambe le arch in pw-browsers. Pronto per electron-builder --mac --universal.');
})().catch(err => { console.error('[universal] ERRORE:', err.message); process.exit(1); });
