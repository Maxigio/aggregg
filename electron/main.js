const { app, BrowserWindow, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { fork, execFile, execFileSync } = require('child_process');

let mainWindow;
let serverProcess;

// Porta fissa non-standard per evitare conflitti con altri servizi locali
const PORT = 47321;

// ── Modalità portatile (§14): app da SSD → dati ACCANTO all'app, seguono il
// supporto su qualsiasi computer. Calcolata PRIMA di app.whenReady perché
// setPath('userData') va fatto prima del primo accesso a userData.
function computePortable() {
  let appDir;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    appDir = process.env.PORTABLE_EXECUTABLE_DIR;          // build Windows "portable" (exe in TEMP → questa è la dir reale)
  } else if (process.platform === 'darwin') {
    const exe = app.getPath('exe');                        // Foo.app/Contents/MacOS/Foo
    appDir = path.dirname(path.resolve(exe, '..', '..', '..'));  // dir che CONTIENE Foo.app
  } else {
    appDir = path.dirname(app.getPath('exe'));
  }
  const dataDir = path.join(appDir, 'AutoMotoRadar-Data');
  // Segnale PRIMARIO deterministico: marker .portable o cartella dati già presente.
  let portable = false;
  try { portable = !!process.env.PORTABLE_EXECUTABLE_DIR
                 || fs.existsSync(path.join(appDir, '.portable'))
                 || fs.existsSync(dataDir); } catch (_) {}
  // Fallback DEBOLE (solo se il marker manca): app su volume esterno macOS.
  if (!portable && process.platform === 'darwin' && appDir.startsWith('/Volumes/')) {
    console.log('[portable] euristica volume-esterno attiva (nessun marker .portable):', appDir);
    portable = true;
  }
  if (!portable) return false;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);                      // cache Electron + persistenza seguono il SSD
    console.log('[portable] dati in', dataDir);
    return true;
  } catch (e) {
    console.warn('[portable] scrittura fallita su', dataDir, '→ fallback userData ospite:', e.message);
    return false;
  }
}

// Solo in build pacchettizzata: in DEV (npm run electron) l'exe è dentro
// node_modules/electron (spesso su volume esterno) → l'euristica scatterebbe a vuoto.
const PORTABLE = app.isPackaged && computePortable();

// ── Funnel automatico: ON all'avvio, OFF alla chiusura ───────────────────────
// Espone l'app su internet (URL pubblico) SOLO se la password è impostata
// (auth.json in userData). Senza password → niente esposizione. App chiusa →
// `funnel reset`. Binario tailscale cercato in più path (Homebrew arm64/x64,
// /usr/local, bundle App Store) perché un'app lanciata da Finder ha PATH minimo.
function tailscaleBin() {
  const candidates = [
    '/opt/homebrew/bin/tailscale',                              // Homebrew Apple Silicon
    '/usr/local/bin/tailscale',                                 // Homebrew Intel / pkg
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',     // client App Store
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return 'tailscale';   // ultimo tentativo: PATH
}

/**
 * LA STESSA DOMANDA CHE SI FA IL BACKEND, non una che le somiglia.
 *
 * Qui si guardava solo se il file ESISTE; backend/auth.js:34 pretende invece che si LEGGA e si
 * PARSIFICHI, e backend/server.js lascia passare ogni rotta senza autenticazione quando quella
 * risposta e' no. Con un auth.json presente ma troncato o illeggibile le due condizioni
 * divergevano nel verso peggiore: Funnel acceso e login spento, cioe' l'app intera su un URL
 * pubblico senza password. Ed e' un guasto muto — l'unico segno sarebbe stata la scomparsa
 * della schermata di accesso, che chi usa l'app legge come "sono gia' entrato".
 * Si controllano anche i campi: un JSON valido ma senza hash non e' una password impostata.
 */
function authEnabled() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'auth.json'), 'utf8'));
    return !!(j && j.hash && j.salt);
  } catch (_) { return false; }
}

function enableFunnel() {
  if (!authEnabled()) {
    /**
     * NON ACCENDERLO NON BASTA: VA SPENTO.
     *
     * Il Funnel acceso con `--bg` e' stato persistente del demone Tailscale: sopravvive
     * alla morte dell'app e al riavvio del Mac, e l'unico punto che lo azzerava era
     * `before-quit`, che una chiusura non pulita non esegue. Quindi "password assente" e
     * "Funnel spento" non erano affatto la stessa cosa, e qui venivano trattate come tali:
     * bastava un blackout con la password impostata e un riavvio in cui auth.json non si
     * legge (l'SSD montato altrove) perche' l'URL pubblico restasse raggiungibile senza
     * login. Adesso, se la password non c'e', si spegne davvero.
     */
    console.log('[funnel] password non impostata o auth.json illeggibile → SPENGO l\'esposizione pubblica');
    disableFunnel();
    return;
  }
  execFile(tailscaleBin(), ['funnel', '--bg', String(PORT)], { timeout: 15000 }, (err, _out, stderr) => {
    if (err) console.warn('[funnel] attivazione fallita:', String(stderr || err.message).trim().split('\n')[0]);
    else     console.log('[funnel] attivo → URL pubblico pronto');
  });
}

function disableFunnel() {
  try { execFileSync(tailscaleBin(), ['funnel', 'reset'], { timeout: 3000, stdio: 'ignore' }); }
  catch (_) {}
}

function startServer() {
  const serverPath = path.join(__dirname, '../backend/server.js');
  serverProcess = fork(serverPath, [], {
    env: {
      ...process.env,
      PORT:           String(PORT),
      RESOURCES_PATH: process.resourcesPath,
      // Path scrivibile per persistenza session Subito (cookie DataDome)
      USER_DATA_PATH: app.getPath('userData'),
    },
  });
  serverProcess.on('error', err => console.error('[AMR Server]', err.message));
}

// Polling: aspetta che il server Express risponda su /api/subito/status (endpoint
// leggero che non richiede browser pronto). Un setTimeout fisso era troppo
// fragile su Mac lenti (papà vedeva schermata bianca con backend non ancora
// avviato; refresh manuale dopo qualche secondo la mostrava). Polling intelligente
// → loadURL avviene esattamente quando il backend è up, indipendentemente dal Mac.
function waitForBackend(maxSeconds = 60) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tryOnce = () => {
      const req = http.get({ host: 'localhost', port: PORT, path: '/api/health', timeout: 1500 }, res => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() - started >= maxSeconds * 1000) return resolve(false);
        setTimeout(tryOnce, 250);
      });
      req.on('error', () => {
        if (Date.now() - started >= maxSeconds * 1000) return resolve(false);
        setTimeout(tryOnce, 250);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tryOnce();
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width:     1280,
    height:    820,
    minWidth:  960,
    minHeight: 600,
    title:     'Auto Moto Radar',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
    },
    backgroundColor: '#f1f5f9',
    show: false, // mostra solo dopo che la pagina è carica
  });

  // Mostra subito una splash inline mentre aspettiamo il backend.
  // (data URL con HTML statico → niente file extra da distribuire.)
  const splashHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <html><head><style>
      body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
             background:#f1f5f9; font-family:-apple-system,BlinkMacSystemFont,sans-serif; color:#475569; }
      .box { text-align:center; }
      .spinner { width:32px; height:32px; border:3px solid #cbd5e1; border-top-color:#1e40af;
                 border-radius:50%; animation:spin 0.8s linear infinite; margin:0 auto 16px; }
      @keyframes spin { to { transform:rotate(360deg); } }
      h2 { font-size:1.05rem; font-weight:500; margin:0; }
    </style></head><body>
      <div class="box"><div class="spinner"></div><h2>Avvio Auto Moto Radar…</h2></div>
    </body></html>
  `)}`;
  mainWindow.loadURL(splashHtml);
  mainWindow.show();  // splash visibile da subito

  // Aspetta che il backend sia up (max 60s) prima di caricare la UI vera
  const ready = await waitForBackend();
  if (ready) {
    mainWindow.loadURL(`http://localhost:${PORT}`);
    enableFunnel();   // backend su → accendi l'URL pubblico (se password impostata)
  } else {
    // Fallback: mostra un messaggio di errore comprensibile invece di schermata bianca
    const errHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
      <html><head><style>
        body { margin:0; padding:40px; font-family:-apple-system,sans-serif; color:#1e293b; background:#f1f5f9; }
        h1 { color:#dc2626; } code { background:#e2e8f0; padding:2px 6px; border-radius:4px; }
      </style></head><body>
        <h1>⚠️ Il backend non si è avviato</h1>
        <p>L'applicazione non è riuscita a connettersi al motore interno entro 60 secondi.</p>
        <p>Prova a chiudere completamente l'app (<code>⌘ + Q</code>) e riaprirla. Se il problema persiste, contatta lo sviluppatore.</p>
      </body></html>
    `)}`;
    mainWindow.loadURL(errHtml);
  }

  // Link esterni (annunci) si aprono nel browser di sistema, non in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Confronto di ORIGIN, non di prefisso: `http://localhost:47321@evil.com/x` supera un
    // startsWith ma il suo host vero e' evil.com, e la navigazione restava in-window.
    // Le due concessioni di prima restano identiche: l'app locale e i data: URL.
    let interna = false;
    if (url.startsWith('data:')) interna = true;
    else { try { interna = new URL(url).origin === `http://localhost:${PORT}`; } catch (_) { interna = false; } }
    if (!interna) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  startServer();
  createWindow();
  // Check aggiornamenti GitHub Releases dopo che la UI è pronta (10s di delay).
  // Non blocca l'uso dell'app; se rete assente, fallisce silente.
  // OFF in modalità portatile: l'updater scaricherebbe/installerebbe un DMG che
  // rompe il workflow da-SSD (l'app non è in /Applications).
  // L'AGGIORNAMENTO AUTOMATICO E' STACCATO. Serviva a offrire il DMG di una release nuova:
  // il DMG non si distribuisce piu', quindi quel controllo interrogava GitHub a ogni avvio e
  // poteva aprire una finestra che proponeva di scaricare un installatore che nessuno usa.
  // Il modulo `electron/auto-update.js` e' stato tolto insieme al target `dmg` in
  // package.json: se un giorno torna un canale di distribuzione, si riscrive per quello.

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      // review: riaprendo dal Dock, se il backend è morto (crash/exit) riavvialo, sennò la
      // finestra caricherebbe un server inesistente ('Il backend non si è avviato').
      if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) startServer();
      createWindow();
    }
  });
});

// review: su macOS chiudere la finestra NON deve uccidere il backend (l'app resta viva nel
// Dock): tenendolo vivo, 'activate' ritrova un server funzionante e il Funnel resta valido.
// La pulizia vera avviene al quit (before-quit). Su Win/Linux chiudere l'ultima finestra = quit.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// review: Cmd-Q / menu Quit → uccidi ANCHE il backend, non solo il Funnel. Prima il node forked
// restava orfano su :47321 → EADDRINUSE al riavvio + l'app parlava col server VECCHIO (codice
// pre-update). shutdown() spegne Funnel e backend.
function shutdown() {
  disableFunnel();
  if (serverProcess) { try { serverProcess.kill(); } catch (_) {} serverProcess = null; }
}
app.on('before-quit', shutdown);
