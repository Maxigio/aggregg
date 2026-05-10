/**
 * Bootstrap interattivo Subito: apre una finestra Chrome NON-headless puntata
 * a subito.it, l'utente risolve manualmente il CAPTCHA DataDome, e quando la
 * pagina viene servita correttamente (presenza di __NEXT_DATA__ + cookie
 * DataDome valido) salviamo lo storageState per le ricerche headless.
 *
 * Strategia:
 *   - Polling ogni 1.5s su due condizioni che devono essere AMBEDUE soddisfatte:
 *     1. document.getElementById('__NEXT_DATA__') esiste → la pagina vera
 *        è stata servita (non la challenge page)
 *     2. context.cookies() include `datadome` per subito.it → l'utente ha
 *        davvero superato il challenge ed ha ricevuto un cookie persistente
 *   - Senza il cookie DataDome il "bootstrap" non vale niente: le ricerche
 *     headless successive verrebbero bloccate. Continuiamo a pollare.
 *   - Timeout 5 minuti, dopo i quali falliamo con reason 'timeout'.
 *
 * Logging: tutto va su <USER_DATA_PATH>/bootstrap.log così l'utente può
 * inviare il log allo sviluppatore in caso di problemi sul Mac di destinazione.
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
const TIMEOUT_MS     = 5 * 60 * 1000;  // 5 minuti
const POLL_INTERVAL  = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Log su file (per debug su Mac dell'utente finale) ────────────────────
function bootstrapLogPath() {
  const userData = process.env.USER_DATA_PATH;
  const dir = userData && fs.existsSync(userData) ? userData : path.join(__dirname, '../../data');
  return path.join(dir, 'bootstrap.log');
}

function fileLog(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(bootstrapLogPath(), line);
  } catch (_) { /* non-fatal */ }
}

/**
 * @param {{ onProgress?: (msg: string) => void }} opts
 * @returns {Promise<{ ok: boolean, reason?: string, timeMs?: number, hint?: string }>}
 */
async function runBootstrap(opts = {}) {
  const log = msg => {
    const line = '[subito-bootstrap] ' + msg;
    console.log(line);
    fileLog(msg);
    if (opts.onProgress) opts.onProgress(msg);
  };

  // Reset log file per ogni bootstrap (così il log riflette l'ultima sessione)
  try { fs.writeFileSync(bootstrapLogPath(), `=== Bootstrap iniziato ${new Date().toISOString()} ===\n`); } catch (_) {}

  log('Path Chromium: ' + PW_BROWSERS);
  log('Avvio Chrome con UI per risolvere CAPTCHA Subito…');

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: resolveChromiumExecutable(PW_BROWSERS),
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--window-size=1280,900',
      ],
    });
  } catch (err) {
    log('FATAL: impossibile lanciare Chrome: ' + err.message);
    return { ok: false, reason: 'chrome_launch_failed', error: err.message };
  }

  // NON ereditare storageState esistente: il bootstrap deve produrre una
  // sessione fresca, non riusare cookie potenzialmente scaduti che inducono
  // DataDome a rifiutare anche un challenge corretto.
  const ctxOpts = {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:    'it-IT',
    viewport:  { width: 1280, height: 900 },
  };
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();

  const t0 = Date.now();
  let result;

  try {
    log('Naviga a ' + BOOTSTRAP_URL);
    const resp = await page.goto(BOOTSTRAP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log('Pagina caricata, status HTTP ' + (resp?.status() || '?'));

    log('Attendo che l\'utente risolva eventuali verifiche anti-bot nella finestra Chrome…');
    log('(condizioni richieste: __NEXT_DATA__ presente + cookie DataDome valido)');

    // Polling: aspettiamo CONTEMPORANEAMENTE entrambe le condizioni.
    let lastSeen = { nextData: null, datadome: null };
    while (Date.now() - t0 < TIMEOUT_MS) {
      // Se l'utente ha chiuso la finestra → fallisci subito
      if (page.isClosed()) {
        log('La finestra è stata chiusa dall\'utente prima del completamento.');
        result = { ok: false, reason: 'window_closed', hint: 'Riprova senza chiudere la finestra Chrome.' };
        break;
      }

      // Condizione 1: __NEXT_DATA__ nella pagina
      const hasNextData = await page.evaluate(() => !!document.getElementById('__NEXT_DATA__')).catch(() => false);
      // Condizione 2: cookie datadome per subito.it
      const cookies = await context.cookies().catch(() => []);
      const ddCookie = cookies.find(c => c.name === 'datadome' && /subito\.it$/i.test(c.domain || ''));
      const hasDataDome = !!ddCookie;

      // Log dei cambi di stato (evita spam)
      if (lastSeen.nextData !== hasNextData || lastSeen.datadome !== hasDataDome) {
        log(`  · __NEXT_DATA__: ${hasNextData ? '✓' : '✗'}   datadome cookie: ${hasDataDome ? '✓' : '✗'}`);
        lastSeen = { nextData: hasNextData, datadome: hasDataDome };
      }

      if (hasNextData && hasDataDome) {
        log('Entrambe le condizioni soddisfatte: salvo la sessione.');
        const fresh = await context.storageState();
        const info  = session.inspectSession(fresh);
        const hours = info.expiresIn != null ? Math.floor(info.expiresIn / 3600) : '?';
        log(`Cookie DataDome valido per ~${hours}h.`);
        session.saveStorageState(fresh);
        session.clearSubitoBlocked();
        result = { ok: true, timeMs: Date.now() - t0, expiresInHours: hours };
        break;
      }

      await sleep(POLL_INTERVAL);
    }

    if (!result) {
      const elapsed = Math.floor((Date.now() - t0) / 1000);
      log(`Timeout dopo ${elapsed}s. Stato finale: __NEXT_DATA__=${lastSeen.nextData} datadome=${lastSeen.datadome}`);
      let hint;
      if (lastSeen.nextData && !lastSeen.datadome) {
        hint = 'La pagina si è caricata ma il sito non ha rilasciato il cookie DataDome. Riprova: ricarica la pagina (Cmd+R nella finestra Chrome) o naviga manualmente in subito.it/auto e clicca un annuncio.';
      } else if (!lastSeen.nextData) {
        hint = 'La pagina non è stata mai servita correttamente. Probabilmente il CAPTCHA non è stato completato: riprova facendo attenzione a risolvere completamente la verifica.';
      } else {
        hint = 'Riprova il bootstrap.';
      }
      result = { ok: false, reason: 'timeout', timeMs: Date.now() - t0, hint, finalState: lastSeen };
    }
  } catch (err) {
    log('ERRORE bootstrap: ' + err.message + '\nStack: ' + err.stack);
    result = { ok: false, reason: 'error', error: err.message };
  } finally {
    try { await context.close(); } catch (_) {}
    try { await browser.close(); } catch (_) {}
  }

  log('Result: ' + JSON.stringify(result));
  return result;
}

module.exports = { runBootstrap, bootstrapLogPath };

// CLI entry
if (require.main === module) {
  runBootstrap({ onProgress: msg => process.stdout.write('  → ' + msg + '\n') })
    .then(res => {
      console.log('\nResult:', JSON.stringify(res));
      console.log('Log file:', bootstrapLogPath());
      process.exit(res.ok ? 0 : 1);
    })
    .catch(err => { console.error(err); process.exit(2); });
}
