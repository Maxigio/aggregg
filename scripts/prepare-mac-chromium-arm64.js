#!/usr/bin/env node
/**
 * Prepara Chromium arm64-Mac in pw-browsers/ prima del build DMG per Apple Silicon.
 *
 * Contesto: electron-builder impacchetta la cartella pw-browsers/ nel DMG.
 * Su un Mac Apple Silicon, `npx playwright install chromium` scarica nativamente
 * la variante arm64 (chrome-mac-arm64). Questo script verifica che sia presente e,
 * se manca, la scarica direttamente dalla CDN ufficiale Playwright.
 *
 * Uso: node scripts/prepare-mac-chromium-arm64.js
 *      oppure: npm run prepare:mac-arm64
 */
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT          = path.join(__dirname, '..');
const PW_BROWSERS   = path.join(ROOT, 'pw-browsers');
const BROWSERS_JSON = path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json');

// ─── Leggi la revisione Chromium dichiarata da playwright-core ────────────────
function chromiumRevision() {
  const j = JSON.parse(fs.readFileSync(BROWSERS_JSON, 'utf8'));
  const c = j.browsers.find(b => b.name === 'chromium');
  if (!c) throw new Error('chromium non trovato in browsers.json');
  return c.revision; // es. "1217"
}

// ─── Verifica presenza Chromium arm64-Mac (supporta vecchio e nuovo formato) ──
// Vecchio formato (rev < ~1217):   chrome-mac-arm64/Chromium.app/...
// Nuovo formato Chrome for Testing: chrome-mac-arm64/Google Chrome for Testing.app/...
function arm64ChromiumPresent(rev) {
  const base = path.join(PW_BROWSERS, `chromium-${rev}`);
  const candidates = [
    path.join(base, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
    path.join(base, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
  ];
  return candidates.some(p => fs.existsSync(p));
}

// ─── Scarica e decomprimi la build arm64 ufficiale ───────────────────────────
async function downloadArm64Chromium(rev) {
  const url     = `https://playwright.azureedge.net/builds/chromium/${rev}/chromium-mac-arm64.zip`;
  const destDir = path.join(PW_BROWSERS, `chromium-${rev}`);
  const zipPath = path.join(destDir, 'chromium-mac-arm64.zip');

  fs.mkdirSync(destDir, { recursive: true });
  console.log(`[prepare-mac-arm64] Download: ${url}`);

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(zipPath);
    const handle = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
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

  console.log('[prepare-mac-arm64] Scompatto…');
  if (process.platform === 'darwin') {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'inherit' });
    // Rendi eseguibile (in caso unzip non preservasse i bit)
    const exeCandidates = [
      path.join(destDir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(destDir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
    for (const exe of exeCandidates) {
      if (fs.existsSync(exe)) {
        fs.chmodSync(exe, 0o755);
        console.log(`[prepare-mac-arm64] chmod +x: ${exe}`);
        break;
      }
    }
  } else {
    console.warn('[prepare-mac-arm64] Scompattazione automatica solo su macOS. Su altri OS, scompatta a mano.');
  }

  fs.unlinkSync(zipPath);
}

(async () => {
  if (process.platform !== 'darwin') {
    console.log('[prepare-mac-arm64] Attenzione: questo script è pensato per essere lanciato su macOS.');
    console.log('[prepare-mac-arm64] Su un Mac Intel, cross-compila per arm64; su Apple Silicon compila nativo.');
  }

  const rev = chromiumRevision();
  console.log(`[prepare-mac-arm64] Revisione Chromium richiesta: ${rev}`);

  if (arm64ChromiumPresent(rev)) {
    console.log('[prepare-mac-arm64] ✓ Chromium arm64-Mac già presente, skip download.');
    return;
  }

  // Prova prima via playwright CLI (se siamo su arm64 scarica nativamente arm64)
  try {
    console.log('[prepare-mac-arm64] Tento install via "npx playwright install chromium"…');
    execSync('npx playwright install chromium', {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: PW_BROWSERS },
      stdio: 'inherit',
    });
    if (arm64ChromiumPresent(rev)) {
      console.log('[prepare-mac-arm64] ✓ Installato via Playwright CLI.');
      return;
    }
    console.log('[prepare-mac-arm64] Playwright CLI non ha scaricato la variante arm64 (probabile Mac Intel). Uso CDN fallback.');
  } catch (e) {
    console.warn(`[prepare-mac-arm64] Playwright CLI fallito: ${e.message}`);
  }

  // Fallback: download diretto dalla CDN (funziona anche da Mac Intel → cross-compila per arm64)
  console.log('[prepare-mac-arm64] Scarico arm64 direttamente dalla CDN Playwright…');
  await downloadArm64Chromium(rev);

  if (!arm64ChromiumPresent(rev)) {
    throw new Error('[prepare-mac-arm64] Chromium arm64-Mac ancora non trovato dopo il download. Ispeziona pw-browsers/.');
  }
  console.log('[prepare-mac-arm64] ✓ Chromium arm64-Mac pronto.');
})().catch(err => {
  console.error('[prepare-mac-arm64] ERRORE:', err.message);
  process.exit(1);
});
