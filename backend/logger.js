'use strict';
// Logger centralizzato AMR — niente dipendenze.
// Risolve due problemi reali: (1) in Electron lo stdout del server forkato viene scartato
// → qui si scrive anche su FILE rotante; (2) i catch della pipeline ricambi inghiottono gli
// errori → ora chiamano logger.error e finiscono su file + ring-buffer + /api/logs.
// installConsoleTee() specchia ANCHE i ~119 console.* esistenti su file+buffer senza toccarli.
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[(process.env.LOG_LEVEL || (process.env.DEBUG === '1' ? 'debug' : 'info')).toLowerCase()] || LEVELS.info;

const LOG_DIR = path.join(process.env.USER_DATA_PATH || path.join(__dirname, '..', 'data'), 'logs');
const LOG_FILE = path.join(LOG_DIR, 'amr.log');
const MAX_BYTES = 5 * 1024 * 1024;   // ruota amr.log → amr.log.1 oltre i 5MB
const RING_MAX = 500;

const ring = [];
let stream = null;
let installed = false;
// riferimenti ORIGINALI (catturati prima del tee) → il logger stampa con questi, mai con console.* (no ricorsione)
const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

// redazione segreti dalle righe persistite/servite (file + ring + /api/logs)
const REDACT = [/sk-ant-[\w-]{10,}/g, /EAA[A-Za-z0-9]{20,}/g, /Bearer\s+[\w.\-]{10,}/gi];
const redact = s => REDACT.reduce((x, re) => x.replace(re, '***'), s);

function ensureStream() {
  if (stream) return stream;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });   // disco pieno/RO → degrada a solo console
  } catch { stream = null; }
  return stream;
}

const fmtArg = a => {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};

// viaTee=true → lo stdout è già stato stampato dal wrapper console.* (non ristampare)
function emit(level, args, viaTee) {
  const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${args.map(fmtArg).join(' ')}`);
  ring.push(line); if (ring.length > RING_MAX) ring.shift();
  const s = ensureStream(); if (s) { try { s.write(line + '\n'); } catch {} }
  if (!viaTee) (level === 'error' ? orig.error : level === 'warn' ? orig.warn : orig.log)(...args);
}

function log(level, ...args) { if (LEVELS[level] >= threshold()) emit(level, args, false); }

// Aggancia tee dei console.* + handler di processo (una volta). Chiamato da server.js al boot.
function install() {
  if (installed) return logger;
  installed = true;
  process.on('uncaughtException', e => emit('error', ['[uncaught]', e], false));
  process.on('unhandledRejection', e => emit('error', ['[unhandledRejection]', e], false));
  console.log = (...a) => { orig.log(...a); emit('info', a, true); };
  console.info = (...a) => { orig.log(...a); emit('info', a, true); };
  console.warn = (...a) => { orig.warn(...a); emit('warn', a, true); };
  console.error = (...a) => { orig.error(...a); emit('error', a, true); };
  emit('info', ['[logger] attivo → ' + LOG_FILE + ' (livello ' + Object.keys(LEVELS).find(k => LEVELS[k] === threshold()) + ')'], false);
  return logger;
}

const logger = {
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  tail: (n = 100) => ring.slice(-Math.max(1, Math.min(n, RING_MAX))),
  file: () => LOG_FILE,
  install,
};

module.exports = logger;

// self-check: `node backend/logger.js`
if (require.main === module) {
  const assert = require('node:assert');
  logger.error('[test]', new Error('boom'));
  logger.info('[test]', 'token sk-ant-abcdefghijklmnop dovrebbe sparire');
  const t = logger.tail(10);
  assert.ok(t.some(l => l.includes('ERROR') && l.includes('boom')), 'error in ring');
  assert.ok(t.some(l => l.includes('***') && !l.includes('sk-ant-abcdefghijklmnop')), 'segreto redatto');
  assert.ok(t.every(l => /^\d{4}-\d\d-\d\dT/.test(l)), 'timestamp ISO');
  console.log('logger self-check OK →', logger.file());
}
