const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const { scheduleUpdateCheck } = require('./auto-update');

let mainWindow;
let serverProcess;

// Porta fissa non-standard per evitare conflitti con altri servizi locali
const PORT = 47321;

function startServer() {
  const serverPath = path.join(__dirname, '../backend/server.js');
  serverProcess = fork(serverPath, [], {
    env: { ...process.env, PORT: String(PORT) },
  });
  serverProcess.on('error', err => console.error('[AMR Server]', err.message));
}

function createWindow() {
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

  // Aspetta che il server Express sia pronto, poi carica la UI
  setTimeout(() => {
    mainWindow.loadURL(`http://localhost:${PORT}`);
  }, 1200);

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Link esterni (annunci) si aprono nel browser di sistema, non in Electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://localhost:${PORT}`)) {
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
