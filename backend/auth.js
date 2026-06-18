/**
 * Auth opzionale per esposizione pubblica (Tailscale Funnel).
 *
 * Dependency-free (solo `crypto`). Si attiva SOLO se è stata impostata una
 * password (`auth.json` presente): senza, l'app resta aperta in locale come
 * prima. Quando attiva, protegge TUTTE le rotte (nessuna scorciatoia loopback:
 * Funnel proxa a 127.0.0.1, indistinguibile dal desktop → la chiave a tutti).
 *
 * Storage: <USER_DATA_PATH>/auth.json (Electron) o data/ (dev) — stesso pattern
 * di saved.js. Contenuto: { salt, hash, secret }.
 *   - hash   = scrypt(password, salt)         → verifica password
 *   - secret = 32B random                     → firma HMAC del cookie di sessione
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'auth.json';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // cookie valido 30 giorni
const MIN_LEN = 10;
const ROLES = new Set(['full', 'demo']);   // 'full' = papà; 'demo' = ospite read-only

function filePath() {
  const userData = process.env.USER_DATA_PATH;
  if (userData && fs.existsSync(userData)) return path.join(userData, FILE);
  return path.join(__dirname, '..', 'data', FILE);
}

function load() {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (_) { return null; }
}

function isEnabled() { return load() !== null; }

// Imposta/aggiorna la password principale (usato da scripts/set-password.js).
// Preserva le credenziali demo se già presenti (non cancellare demoSalt/demoHash);
// il secret viene rigenerato (cambio password → vecchie sessioni invalidate).
function setPassword(pw) {
  if (!pw || String(pw).length < MIN_LEN) {
    throw new Error(`Password troppo corta (minimo ${MIN_LEN} caratteri).`);
  }
  const prev   = load() || {};
  const salt   = crypto.randomBytes(16).toString('hex');
  const hash   = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const p = filePath();
  fs.writeFileSync(p, JSON.stringify({ ...prev, salt, hash, secret }, null, 2));
  return p;
}

// Imposta/aggiorna la password DEMO (ospite read-only). Read-modify-write:
// preserva salt/hash/secret principali → NON invalida la sessione di papà.
function setDemoPassword(pw) {
  if (!pw || String(pw).length < MIN_LEN) {
    throw new Error(`Password demo troppo corta (minimo ${MIN_LEN} caratteri).`);
  }
  const cfg = load();
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
  cfg.demoSalt = crypto.randomBytes(16).toString('hex');
  cfg.demoHash = crypto.scryptSync(String(pw), cfg.demoSalt, 64).toString('hex');
  const p = filePath();
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

// Confronto scrypt timing-safe contro una coppia salt/hash (null-safe: se la
// credenziale non è impostata → false, niente scrypt su undefined).
function matchHash(pw, salt, hash) {
  if (!salt || !hash) return false;
  const got    = crypto.scryptSync(String(pw == null ? '' : pw), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return got.length === stored.length && crypto.timingSafeEqual(got, stored);
}

// Verifica la password e ritorna il RUOLO ('full' | 'demo') o null.
function verifyRole(pw) {
  const cfg = load();
  if (!cfg) return null;
  if (matchHash(pw, cfg.salt, cfg.hash)) return 'full';
  if (matchHash(pw, cfg.demoSalt, cfg.demoHash)) return 'demo';
  return null;
}

// Back-compat: true solo per la password principale (full).
function verifyPassword(pw) {
  const cfg = load();
  return cfg ? matchHash(pw, cfg.salt, cfg.hash) : false;
}

// Token cookie firmato col RUOLO dentro la firma: "<exp>.<role>.<hmac(secret, exp+'.'+role)>".
// Il ruolo è firmato → un demo non può alterare il cookie per diventare 'full'.
function makeToken(role = 'full') {
  const cfg = load();
  if (!cfg) return null;
  if (!ROLES.has(role)) role = 'full';
  const exp = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', cfg.secret).update(`${exp}.${role}`).digest('hex');
  return `${exp}.${role}.${sig}`;
}

// Ritorna il RUOLO ('full'|'demo') se il token è valido e non scaduto, altrimenti null.
// Back-compat: i vecchi token a 2 parti "<exp>.<sig>" sono trattati come 'full'.
function checkToken(v) {
  const cfg = load();
  if (!cfg || !v) return null;
  const parts = String(v).split('.');
  let exp, role, sig, signed;
  if (parts.length === 2) {            // vecchio formato <exp>.<sig> = full
    [exp, sig] = parts; role = 'full'; signed = exp;
  } else if (parts.length === 3) {     // <exp>.<role>.<sig>
    [exp, role, sig] = parts; signed = `${exp}.${role}`;
    if (!ROLES.has(role)) return null;
  } else {
    return null;
  }
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const expect = crypto.createHmac('sha256', cfg.secret).update(signed).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return role;
}

module.exports = {
  isEnabled, setPassword, setDemoPassword, verifyPassword, verifyRole,
  makeToken, checkToken, _filePath: filePath, MIN_LEN, TTL_MS,
};
