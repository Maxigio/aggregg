/**
 * Bootstrap interattivo Subito: apre una finestra Chrome NON-headless puntata
 * a subito.it, l'utente risolve manualmente il CAPTCHA DataDome, e quando la
 * pagina viene servita correttamente (presenza di __NEXT_DATA__) salviamo lo
 * storageState (cookie + localStorage) per le ricerche headless successive.
 *
 * Uso da CLI:
 *   node backend/scrapers/subito-bootstrap.js
 *
 * Uso programmatico (dal server Express):
 *   const { runBootstrap } = require('./subito-bootstrap');
 *   const result = await runBootstrap({ onProgress: msg => console.log(msg) });
 *   // result = { ok: true } | { ok: false, reason: '...' }
 */

const path = require('path');
const fs   = require('fs');
const { chromium } = require('playwright-extra');
const stealth     = require('puppeteer-extra-plugin-stealth')();
const { resolveChromiumExecutable } = require('./utils');
const session = require('./subito-session');

chromium.use(stealth);

const _respath = process.env.RESOURCES_PATH || process.resourcesPath;
const PW_BROWSERS = _respath && fs.existsSync(path.join(_respath, 'pw-browsers'))
  ? path.join(_respath, 'pw-browsers')
  : path.join(__dirname, '../../pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = PW_BROWSERS;

const BOOTSTRAP_URL  = 'https://www.subito.it/annunci-italia/vendita/auto/';
const TIMEOUT_MS     = 5 * 60 * 1000;  // 5 minuti per risolvere il CAPTCHA
const POLL_INTERVAL  = 1500;           // ogni 1.5s controlla se la sfida è risolta

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {{ onProgress?: (msg: string) => void }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, timeMs?: number }>}
 */
async function runBootstrap(opts = {}) {
  const log = msg => {
    const line = '[subito-bootstrap] ' + msg;
    console.log(line);
    if (opts.onProgress) opts.onProgress(msg);
  };

  log('Avvio Chrome con UI per risolvere CAPTCHA Subito…');

  const browser = await chromium.launch({
    executablePath: resolveChromiumExecutable(PW_BROWSERS),
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,900',
    ],
  });

  // Eredita storageState esistente (potrebbe avere sessione parziale)
  const existing = session.loadStorageState();
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'it-IT',
    viewport:  { width: 1280, height: 900 },
  };
  if (existing) ctxOpts.storageState = existing;
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  const t0 = Date.now();
  let result;

  try {
    log('Naviga a ' + BOOTSTRAP_URL);
    await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    log('In attesa che risolvi il CAPTCHA nella finestra Chrome appena aperta…');

    // Polling: aspettiamo che __NEXT_DATA__ appaia (indica che la pagina reale
    // è stata servita, quindi la challenge è stata risolta).
    while (Date.now() - t0 < TIMEOUT_MS) {
      try {
        const hasNextData = await page.evaluate(() =>
          !!document.getElementById('__NEXT_DATA__')
        ).catch(() => false);

        if (hasNextData) {
          log('CAPTCHA risolto! Salvo la sessione…');
          const fresh = await context.storageState();
          const ddInfo = session.inspectSession(fresh);
          if (!ddInfo.hasDataDome) {
            log('Attenzione: cookie DataDome non presente nello state. Procedo lo stesso.');
          } else if (ddInfo.expiresIn != null) {
            const hours = Math.floor(ddInfo.expiresIn / 3600);
            log('Cookie DataDome valido per ~' + hours + 'h.');
          }
          session.saveStorageState(fresh);
          session.clearSubitoBlocked();
          result = { ok: true, timeMs: Date.now() - t0 };
          break;
        }
      } catch (err) {
        // page chiusa dall'utente, etc.
        log('Errore durante polling: ' + err.message);
        break;
      }

      // Se l'utente ha chiuso la finestra
      if (page.isClosed()) {
        result = { ok: false, reason: 'window_closed' };
        break;
      }

      await sleep(POLL_INTERVAL);
    }

    if (!result) {
      result = { ok: false, reason: 'timeout', timeMs: Date.now() - t0 };
      log('Timeout (' + Math.floor(TIMEOUT_MS / 1000) + 's) — bootstrap non completato.');
    }
  } catch (err) {
    log('ERRORE bootstrap: ' + err.message);
    result = { ok: false, reason: 'error', error: err.message };
  } finally {
    try { await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }

  return result;
}

module.exports = { runBootstrap };

// CLI entry
if (require.main === module) {
  runBootstrap({ onProgress: msg => process.stdout.write('  → ' + msg + '\n') })
    .then(res => {
      console.log('\nResult:', JSON.stringify(res));
      process.exit(res.ok ? 0 : 1);
    })
    .catch(err => { console.error(err); process.exit(2); });
}
