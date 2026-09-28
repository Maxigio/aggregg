'use strict';
// Logger centralizzato AMR — niente dipendenze.
// I messaggi del server finiscono su file rotante, ring-buffer e /api/logs anche
// quando il processo non ha un terminale collegato.
// installConsoleTee() specchia ANCHE i ~119 console.* esistenti su file+buffer senza toccarli.
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[(process.env.LOG_LEVEL || (process.env.DEBUG === '1' ? 'debug' : 'info')).toLowerCase()] || LEVELS.info;

// `AMR_LOG_DIR` esiste per i TEST: puntare USER_DATA_PATH a una cartella temporanea
// isolerebbe anche auth.json, e le prove sull'accesso si auto-salterebbero. Con questa
// variabile si sposta il solo log — che era il problema: i test requirono server.js, che
// installa il tee, e ogni run appendeva al registro operativo vero (373 boot fantasma
// contati, piu' righe ERROR che un operatore avrebbe letto come guasti dell'app).
/**
 * LA STESSA FORMULA DELLE ALTRE SETTE COPIE. Qui `USER_DATA_PATH` era creduto sulla parola
 * mentre auth/saved/competitor/cache-disco controllano `existsSync` prima di fidarsi: con
 * una variabile che punta a una cartella inesistente il logger la CREAVA al boot (ensureStream
 * fa mkdir ricorsivo), e da quel momento le altre sette — che prima ripiegavano su data/ —
 * la trovavano esistente e ci migravano dentro. Un log poteva spostare i dati dell'utente.
 */
const basePersistente = () => {
  const ud = process.env.USER_DATA_PATH;
  return (ud && fs.existsSync(ud)) ? ud : path.join(__dirname, '..', 'data');
};
const LOG_DIR = process.env.AMR_LOG_DIR || path.join(basePersistente(), 'logs');
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

/**
 * Byte scritti da quando il file e' aperto. Serve perche' il tetto va controllato
 * DURANTE la scrittura, non solo all'apertura: `if (stream) return stream` faceva
 * saltare il controllo per tutta la vita del processo, e un processo che resta su per
 * ore scriveva senza limite. Un singolo amr.log e' arrivato a 52 GB e ha riempito il
 * disco — il tetto di 5 MB c'era, ma valeva solo al boot.
 */
let scritti = 0;

function ensureStream() {
  // Oltre il tetto si ruota SEMPRE, senza chiedere al disco quanto e' grande il file:
  // le scritture sono bufferizzate, `statSync` vede molto meno di quanto e' gia' stato
  // scritto, e la rotazione non scattava mai. Su POSIX il rename segue il descrittore
  // aperto, quindi cio' che resta nel buffer finisce nel file ruotato.
  if (stream && scritti > MAX_BYTES) {
    try { stream.end(); } catch {}
    stream = null;
    try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    scritti = 0;
  }
  if (stream) return stream;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  try {
    // all'avvio il file c'e' gia' da prima: qui la dimensione su disco e' quella vera
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
      try { fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });   // disco pieno/RO → degrada a solo console
    scritti = 0;
  } catch { stream = null; }
  return stream;
}

const fmtArg = a => {
  if (a instanceof Error) return a.stack || a.message || String(a);
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
};

/**
 * Scrivere su una PIPE CHIUSA non deve poter generare un altro log.
 *
 * Successo davvero, ed e' costato 52 GB in una notte: un processo orfano (lanciato in
 * background e poi rimasto senza chi lo ascoltava) scrive su stdout → EPIPE →
 * `uncaughtException` → emit → scrive di nuovo su stdout → EPIPE → all'infinito.
 * 68 MB al secondo, finche' il disco non finisce e non si scrive piu' niente, nemmeno
 * il resto dell'applicazione.
 *
 * La scrittura sul FILE era gia' protetta; questa no. Un errore mentre si registra un
 * errore va ingoiato: se la console non riceve piu' niente non c'e' nessuno a cui
 * dirlo, e insistere e' l'unico modo di fare danno.
 */
function suConsole(level, args) {
  try {
    (level === 'error' ? orig.error : level === 'warn' ? orig.warn : orig.log)(...args);
  } catch (_) { /* pipe chiusa, terminale sparito: non c'e' nessuno da avvisare */ }
}

// viaTee=true → lo stdout è già stato stampato dal wrapper console.* (non ristampare)
function emit(level, args, viaTee) {
  const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${args.map(fmtArg).join(' ')}`);
  ring.push(line); if (ring.length > RING_MAX) ring.shift();
  const s = ensureStream();
  if (s) { try { s.write(line + '\n'); scritti += line.length + 1; } catch {} }
  if (!viaTee) suConsole(level, args);
}

/**
 * EPIPE/EBADF su stdout non e' un errore dell'applicazione: e' "non ti ascolta piu'
 * nessuno". Registrarlo riempirebbe il file di una riga per ogni tentativo, e sono
 * milioni. Si ignora del tutto.
 */
const soloPipeRotta = e => !!e && (e.code === 'EPIPE' || e.code === 'EBADF')
  && /write|epipe/i.test(String(e.syscall || e.message || ''));

function log(level, ...args) { if (LEVELS[level] >= threshold()) emit(level, args, false); }

// Aggancia tee dei console.* + handler di processo (una volta). Chiamato da server.js al boot.
function install() {
  if (installed) return logger;
  installed = true;
  process.on('uncaughtException', e => { if (!soloPipeRotta(e)) emit('error', ['[uncaught]', e], false); });
  process.on('unhandledRejection', e => { if (!soloPipeRotta(e)) emit('error', ['[unhandledRejection]', e], false); });
  console.log = (...a) => { suConsole('info', a); emit('info', a, true); };
  console.info = (...a) => { suConsole('info', a); emit('info', a, true); };
  console.warn = (...a) => { suConsole('warn', a); emit('warn', a, true); };
  console.error = (...a) => { suConsole('error', a); emit('error', a, true); };
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
