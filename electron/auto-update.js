/**
 * Auto-update via GitHub Releases — versione "friendly per non tecnici".
 *
 * Strategia (app non firmata, senza Apple Developer ID):
 * - All'avvio (con delay di 10s per non rallentare il boot) interrogo
 *   https://api.github.com/repos/<owner>/<repo>/releases/latest
 * - Se la `tag_name` > versione locale → scarico il DMG in ~/Downloads,
 *   mostro dialog "Aggiornamento pronto — apri?" e, se sì, `shell.openPath()`
 *   il DMG (Finder mostra l'icona da trascinare in Applicazioni).
 * - La prima volta che l'app non firmata viene aperta, macOS chiede conferma
 *   (click-destro → Apri durante setup iniziale); dopo ricorda la scelta.
 *
 * Limite noto: senza firma non c'è auto-update silente in background.
 * Il papà deve fare 1 click per aggiornare + trascinare l'icona. Zero
 * Terminale, zero errori dopo il primo setup.
 */
const { app, dialog, shell, net, Notification } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const GITHUB_OWNER = 'Maxigio';
const GITHUB_REPO  = 'aggregg';
const CHECK_DELAY_MS = 10_000;

// Confronto versione SemVer semplice (x.y.z)
function versionGt(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url,
      headers: {
        'User-Agent': 'AutoMotoRadar-Updater',
        'Accept':     'application/vnd.github+json',
      },
    });
    let body = '';
    req.on('response', res => {
      res.on('data', c => body += c.toString());
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow' });
    const out = fs.createWriteStream(destPath);
    req.on('response', res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} su ${url}`));
        return;
      }
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkForUpdates(mainWindow) {
  try {
    const current = app.getVersion();
    const latest  = await fetchJson(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    );
    const latestTag = latest.tag_name || latest.name || '';
    if (!latestTag) return;
    if (!versionGt(latestTag, current)) {
      console.log(`[auto-update] Sei già aggiornato (${current} ≥ ${latestTag}).`);
      return;
    }

    // Trova il DMG (priorità a quello x64 / senza arch se c'è un solo asset)
    const dmg = (latest.assets || []).find(a =>
      /\.dmg$/i.test(a.name) && (/x64|intel/i.test(a.name) || (latest.assets || []).filter(x => /\.dmg$/i.test(x.name)).length === 1)
    ) || (latest.assets || []).find(a => /\.dmg$/i.test(a.name));
    if (!dmg) {
      console.warn('[auto-update] Nessun DMG trovato nella release.');
      return;
    }

    // Notifica discreta
    if (Notification.isSupported()) {
      new Notification({
        title: 'Auto Moto Radar',
        body:  `Nuova versione ${latestTag} disponibile. Clicca per aggiornare.`,
      }).show();
    }

    // Dialog principale
    const choice = await dialog.showMessageBox(mainWindow, {
      type:    'info',
      buttons: ['Aggiorna ora', 'Più tardi'],
      defaultId: 0,
      cancelId:  1,
      title:   'Nuova versione disponibile',
      message: `È disponibile la versione ${latestTag} (tu hai ${current}).`,
      detail:  'Ti scarichiamo l\'aggiornamento e apriamo il Finder: ti basterà trascinare l\'icona "Auto Moto Radar" nella cartella Applicazioni.',
    });
    if (choice.response !== 0) return;

    // Scarica in ~/Downloads
    const downloads = path.join(os.homedir(), 'Downloads');
    const destPath  = path.join(downloads, dmg.name);
    console.log(`[auto-update] Scarico ${dmg.browser_download_url} → ${destPath}`);

    // Progress dialog minimale (modale, indeterminato)
    dialog.showMessageBox(mainWindow, {
      type:    'info',
      buttons: [],
      title:   'Scarico aggiornamento…',
      message: `Sto scaricando la nuova versione ${latestTag}.`,
      detail:  'Un attimo… apro il Finder appena pronto.',
      noLink:  true,
    });

    await fetchToFile(dmg.browser_download_url, destPath);

    // Apri il DMG: macOS lo monta e apre una finestra con l'icona e il link ad Applicazioni
    await shell.openPath(destPath);

    dialog.showMessageBox(mainWindow, {
      type:    'info',
      buttons: ['Ho capito'],
      title:   'Aggiornamento pronto',
      message: `Nella finestra appena aperta, trascina l'icona "Auto Moto Radar" sopra la cartella "Applicazioni".`,
      detail:  'Quando chiedi conferma di sovrascrivere, clicca "Sostituisci". Poi chiudi questa app e riaprila: avrai la nuova versione.',
    });
  } catch (e) {
    // Mai bloccare l'app per un fallito check-update
    console.warn('[auto-update] Check fallito:', e.message);
  }
}

function scheduleUpdateCheck(mainWindow) {
  setTimeout(() => checkForUpdates(mainWindow), CHECK_DELAY_MS);
}

module.exports = { scheduleUpdateCheck, checkForUpdates };
