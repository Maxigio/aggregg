/**
 * Gestione session Subito (cookie DataDome + storage state Playwright).
 *
 * Subito è protetto da DataDome che identifica i browser headless. Il workaround
 * è un bootstrap interattivo una tantum: apriamo Chrome non-headless puntato a
 * subito.it, l'utente risolve il CAPTCHA, salviamo cookie+localStorage in un
 * file `<userData>/subito-session.json`, riusiamo quel file per ricerche
 * successive in modalità headless. Quando il cookie scade (~12-24h), nuovo
 * bootstrap.
 *
 * Path session:
 *   - In Electron packaged: <USER_DATA_PATH>/subito-session.json
 *     (USER_DATA_PATH viene passato come env da electron/main.js)
 *   - Dev/standalone: <repoRoot>/data/.subito-session.json
 *     (file gitignored)
 */
const fs   = require('fs');
const path = require('path');

const SESSION_FILE = 'subito-session.json';

function getSessionPath() {
  // 1) Electron production: USER_DATA_PATH iniettato da electron/main.js
  const userData = process.env.USER_DATA_PATH;
  if (userData && fs.existsSync(userData)) {
    return path.join(userData, SESSION_FILE);
  }
  // 2) Dev/standalone: data/ del repo
  return path.join(__dirname, '../../data/.subito-session.json');
}

/**
 * Carica lo storageState dal disco (oggetto pronto per `browserContext({storageState})`).
 * Ritorna null se il file non esiste o è invalido.
 */
function loadStorageState() {
  const file = getSessionPath();
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    // sanity check minima
    if (!json || !Array.isArray(json.cookies)) return null;
    return json;
  } catch (err) {
    console.warn('[subito-session] load failed: ' + err.message);
    return null;
  }
}

/**
 * Salva lo storageState (output di `context.storageState()`) sul disco.
 */
function saveStorageState(state) {
  const file = getSessionPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('[subito-session] save failed: ' + err.message);
    return false;
  }
}

/**
 * Rileva se la session ha un cookie DataDome valido (non scaduto).
 * Ritorna { hasDataDome: bool, expiresIn: secondi-residui-o-null }.
 * NB: cookie DataDome ha typically ~hours TTL.
 */
function inspectSession(state) {
  if (!state || !Array.isArray(state.cookies)) return { hasDataDome: false, expiresIn: null };
  const ddCookie = state.cookies.find(c => c.name === 'datadome' && /subito\.it$/i.test(c.domain || ''));
  if (!ddCookie) return { hasDataDome: false, expiresIn: null };
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof ddCookie.expires === 'number' ? ddCookie.expires : null;
  const expiresIn = exp != null ? Math.floor(exp - now) : null;
  return { hasDataDome: true, expiresIn };
}

/**
 * Cancella il file session (forza nuovo bootstrap).
 */
function clearSession() {
  const file = getSessionPath();
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (err) {
    console.warn('[subito-session] clear failed: ' + err.message);
    return false;
  }
}

// ─── Stato in-memory: blocked flag + last refresh ────────────────────────────
// Quando lo scraper Subito intercetta CAPTCHA, setta blocked=true. Il flag
// viene ripulito da un bootstrap o auto-refresh completato con successo.
let blockedFlag    = false;
let lastRefreshAt  = null;  // timestamp ms dell'ultimo refresh riuscito
let lastRefreshOk  = null;  // bool: ultimo tentativo di refresh
function isSubitoBlocked()    { return blockedFlag; }
function markSubitoBlocked()  { blockedFlag = true; }
function clearSubitoBlocked() { blockedFlag = false; }
function getLastRefresh()     { return { at: lastRefreshAt, ok: lastRefreshOk }; }
function recordRefresh(ok)    { lastRefreshAt = Date.now(); lastRefreshOk = ok; }

/**
 * Stato sintetico per UX. Combina presenza session, blocked flag e cookie TTL.
 * Ritorna uno tra:
 *  - 'never_configured': nessuna sessione ancora, serve bootstrap iniziale
 *  - 'blocked':          sessione presente ma scaduta/bloccata, serve nuovo bootstrap
 *  - 'expiring_soon':    cookie residuo < 30 minuti
 *  - 'ok':               tutto normale
 */
function getSessionHealth() {
  const state = loadStorageState();
  if (!state) return 'never_configured';
  if (blockedFlag) return 'blocked';
  const info = inspectSession(state);
  if (!info.hasDataDome) return 'never_configured';
  if (info.expiresIn != null && info.expiresIn < 30 * 60) return 'expiring_soon';
  return 'ok';
}

module.exports = {
  getSessionPath,
  loadStorageState,
  saveStorageState,
  inspectSession,
  clearSession,
  isSubitoBlocked,
  markSubitoBlocked,
  clearSubitoBlocked,
  getLastRefresh,
  recordRefresh,
  getSessionHealth,
};
