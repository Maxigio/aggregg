const { app, BrowserWindow, shell, net } = require('electron');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const { scheduleUpdateCheck } = require('./auto-update');

let mainWindow;
let serverProcess;

// Porta fissa non-standard per evitare conflitti con altri servizi locali
const PORT = 47321;

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
      const req = http.get({ host: 'localhost', port: PORT, path: '/api/subito/status', timeout: 1500 }, res => {
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
    if (!url.startsWith(`http://localhost:${PORT}`) && !url.startsWith('data:')) {
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
  if (app.isPackaged) scheduleUpdateCheck(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill();
  if (process.platform !== 'darwin') app.quit();
});
