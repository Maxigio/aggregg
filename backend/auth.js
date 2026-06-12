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

// Imposta/aggiorna la password (usato da scripts/set-password.js).
function setPassword(pw) {
  if (!pw || String(pw).length < MIN_LEN) {
    throw new Error(`Password troppo corta (minimo ${MIN_LEN} caratteri).`);
  }
  const salt   = crypto.randomBytes(16).toString('hex');
  const hash   = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const p = filePath();
  fs.writeFileSync(p, JSON.stringify({ salt, hash, secret }, null, 2));
  return p;
}

function verifyPassword(pw) {
  const cfg = load();
  if (!cfg) return false;
  const got    = crypto.scryptSync(String(pw == null ? '' : pw), cfg.salt, 64);
  const stored = Buffer.from(cfg.hash, 'hex');
  return got.length === stored.length && crypto.timingSafeEqual(got, stored);
}

// Token cookie firmato: "<exp>.<hmac(secret, exp)>".
function makeToken() {
  const cfg = load();
  if (!cfg) return null;
  const exp = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', cfg.secret).update(String(exp)).digest('hex');
  return `${exp}.${sig}`;
}

function checkToken(v) {
  const cfg = load();
  if (!cfg || !v) return false;
  const dot = String(v).indexOf('.');
  if (dot < 0) return false;
  const exp = String(v).slice(0, dot);
  const sig = String(v).slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const expect = crypto.createHmac('sha256', cfg.secret).update(exp).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isEnabled, setPassword, verifyPassword, makeToken, checkToken, _filePath: filePath, MIN_LEN, TTL_MS };
