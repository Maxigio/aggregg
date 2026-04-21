#!/usr/bin/env node
/**
 * Prepara Chromium x64-Mac in pw-browsers/ prima del build DMG.
 *
 * Contesto: electron-builder impacchetta la cartella pw-browsers/ nel DMG.
 * Su un iMac Intel, `npx playwright install chromium` scarica nativamente la
 * variante chrome-mac (x64). Questo script verifica che sia presente e, se
 * manca, la scarica direttamente dalla CDN ufficiale Playwright.
 *
 * Uso: node scripts/prepare-mac-chromium.js
 */
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const PW_BROWSERS = path.join(ROOT, 'pw-browsers');
const BROWSERS_JSON = path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json');

// ─── Leggi la revisione Chromium dichiarata da playwright-core ────────────────
function chromiumRevision() {
  const j = JSON.parse(fs.readFileSync(BROWSERS_JSON, 'utf8'));
  const c = j.browsers.find(b => b.name === 'chromium');
  if (!c) throw new Error('chromium non trovato in browsers.json');
  return c.revision; // es. "1217"
}

// ─── Verifica presenza Chromium x64-Mac ───────────────────────────────────────
function macChromiumPresent(rev) {
  const exe = path.join(
    PW_BROWSERS,
    `chromium-${rev}`,
    'chrome-mac',
    'Chromium.app',
    'Contents',
    'MacOS',
    'Chromium'
  );
  return fs.existsSync(exe);
}

// ─── Scarica e decomprimi la build ufficiale ──────────────────────────────────
// URL pubblico: https://playwright.azureedge.net/builds/chromium/<rev>/chromium-mac.zip
async function downloadMacChromium(rev) {
  const url = `https://playwright.azureedge.net/builds/chromium/${rev}/chromium-mac.zip`;
  const destDir = path.join(PW_BROWSERS, `chromium-${rev}`);
  const zipPath = path.join(destDir, 'chromium-mac.zip');

  fs.mkdirSync(destDir, { recursive: true });
  console.log(`[prepare-mac] Download: ${url}`);

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Segui redirect
        https.get(res.headers.location, handle).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} su ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    };
    https.get(url, handle).on('error', reject);
  });

  console.log('[prepare-mac] Scompatto…');
  // Su macOS usa unzip nativo (presente di default); su altri sistemi stampa errore.
  if (process.platform === 'darwin') {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
    // Rendi eseguibile il binario (in caso unzip non preservasse i bit)
    const exe = path.join(destDir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    if (fs.existsSync(exe)) fs.chmodSync(exe, 0o755);
  } else {
    console.warn('[prepare-mac] Scompattazione automatica solo su macOS. Su altri OS, scompatta a mano.');
  }

  fs.unlinkSync(zipPath);
}

(async () => {
  if (process.platform !== 'darwin') {
    console.log('[prepare-mac] Attenzione: questo script è pensato per essere lanciato su macOS per buildare il DMG.');
    console.log('[prepare-mac] Si può comunque lanciare su altri OS per pre-scaricare lo zip.');
  }

  const rev = chromiumRevision();
  console.log(`[prepare-mac] Revisione Chromium richiesta: ${rev}`);

  if (macChromiumPresent(rev)) {
    console.log('[prepare-mac] ✓ Chromium x64-Mac già presente, skip download.');
    return;
  }

  // Prova prima via playwright CLI (nativo, corretto)
  try {
    console.log('[prepare-mac] Tento install via "npx playwright install chromium"…');
    execSync('npx playwright install chromium', {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PW_BROWSERS },
      stdio: 'inherit',
    });
    if (macChromiumPresent(rev)) {
      console.log('[prepare-mac] ✓ Installato via Playwright CLI.');
      return;
    }
  } catch (e) {
    console.warn(`[prepare-mac] Playwright CLI fallito: ${e.message}`);
  }

  // Fallback: download diretto dalla CDN
  console.log('[prepare-mac] Fallback: scarico direttamente dalla CDN Playwright…');
  await downloadMacChromium(rev);

  if (!macChromiumPresent(rev)) {
    throw new Error('[prepare-mac] Chromium x64-Mac ancora non trovato dopo il download. Ispeziona pw-browsers/.');
  }
  console.log('[prepare-mac] ✓ Chromium x64-Mac pronto.');
})().catch(err => {
  console.error('[prepare-mac] ERRORE:', err.message);
  process.exit(1);
});
