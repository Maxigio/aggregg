'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { creaRestic } = require('./backup-restic');
const { creaDumpPostgres } = require('./backup-postgres-prova');

const CAMPI = ['R2_ENV', 'PASSWORD_FILE', 'RESTIC', 'RESTIC_SHA256', 'PG_DUMP',
  'PG_DUMP_SHA256', 'PG_PASSFILE', 'PG_USER', 'REPOSITORY'];
const HEX = /^[a-f0-9]{64}$/;
const errore = () => new Error('configurazione_copie_non_valida');

// Nessuna attivazione implicita: una configurazione parziale non diventa
// un backup disabilitato apparentemente valido. La retention resta dry-run.
function configuraCopie(env, pg) {
  const presenti = Object.keys(env).filter(k => k.startsWith('AMR_COPIE_'));
  if (!presenti.length) return null;
  try {
    if (presenti.some(k => !CAMPI.includes(k.slice('AMR_COPIE_'.length)))) throw errore();
    if (CAMPI.some(k => typeof env['AMR_COPIE_' + k] !== 'string' || !env['AMR_COPIE_' + k])) throw errore();
    for (const k of ['R2_ENV', 'PASSWORD_FILE', 'RESTIC', 'PG_DUMP', 'PG_PASSFILE']) {
      if (!path.isAbsolute(env['AMR_COPIE_' + k])) throw errore();
    }
    if (!HEX.test(env.AMR_COPIE_RESTIC_SHA256) || !HEX.test(env.AMR_COPIE_PG_DUMP_SHA256)
        || !/^[a-zA-Z0-9_-]{1,63}$/.test(env.AMR_COPIE_PG_USER)) throw errore();
    const r = JSON.parse(env.AMR_COPIE_REPOSITORY);
    if (!r || Object.keys(r).sort().join(',') !== 'database,endpoint,journal' || typeof r.endpoint !== 'string') throw errore();
    const u = new URL(r.endpoint);
    if (!/^https:\/\/[a-f0-9]{32}\.eu\.r2\.cloudflarestorage\.com$/.test(r.endpoint)
        || u.origin !== r.endpoint) throw errore();
    for (const k of ['database', 'journal']) {
      if (!r[k] || Object.keys(r[k]).sort().join(',') !== 'bucket,id'
          || typeof r[k].bucket !== 'string' || typeof r[k].id !== 'string'
          || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(r[k].bucket)
          || !HEX.test(r[k].id)) throw errore();
    }
    if (r.database.bucket === r.journal.bucket || r.database.id === r.journal.id) throw errore();
    return { restic: env.AMR_COPIE_RESTIC, resticSha256: env.AMR_COPIE_RESTIC_SHA256,
      pgDump: env.AMR_COPIE_PG_DUMP, pgDumpSha256: env.AMR_COPIE_PG_DUMP_SHA256,
      passwordFile: env.AMR_COPIE_PASSWORD_FILE, r2Env: env.AMR_COPIE_R2_ENV, repository: r,
      pg: { PGHOST: pg.host, PGPORT: String(pg.port), PGDATABASE: pg.database,
        PGUSER: env.AMR_COPIE_PG_USER, PGPASSFILE: env.AMR_COPIE_PG_PASSFILE,
        PGSSLMODE: pg.ssl === false ? 'disable' : 'verify-full',
        ...(pg.ssl === false ? {} : { PGSSLROOTCERT: 'system' }) } };
  } catch { throw errore(); }
}

function leggiPrivato(file) {
  let fd;
  try {
    if (!path.isAbsolute(file || '')) throw errore();
    const parent = fs.lstatSync(path.dirname(file));
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid()) throw errore();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size < 1 || s.size > 4096 || (s.mode & 0o777) !== 0o600
        || s.uid !== process.getuid()) throw errore();
    if (process.platform === 'darwin') {
      for (const p of [path.dirname(file), file]) {
        const acl = execFileSync('/bin/ls', ['-lde', p], {
          env: { LANG: 'C', TZ: 'UTC' }, timeout: 2000, maxBuffer: 16384 }).toString();
        if (acl.split(/\s/, 1)[0].includes('+') || /^\s*\d+:\s/m.test(acl)) throw errore();
      }
    }
    return fs.readFileSync(fd);
  } catch { throw errore(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Stesso formato del file R2 già usato nel collaudo, senza dotenv o shell.
function leggiCredenzialiR2(file) {
  const raw = leggiPrivato(file);
  try {
    const env = {};
    for (const line of raw.toString('utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const m = /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=([a-f0-9]+)$/.exec(line);
      if (!m || Object.hasOwn(env, m[1])) throw errore();
      env[m[1]] = m[2];
    }
    if (!/^[a-f0-9]{32}$/.test(env.AWS_ACCESS_KEY_ID || '') || !HEX.test(env.AWS_SECRET_ACCESS_KEY || '')) throw errore();
    return env;
  } finally { raw.fill(0); }
}

function verificaBinario(file, impronta) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size < 1 || !(s.mode & 0o111) || (s.mode & 0o022) || ![0, process.getuid()].includes(s.uid)
        || s.size > 128 * 1024 * 1024
        || crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex') !== impronta) throw errore();
  } catch { throw errore(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Prepara soltanto le dipendenze. Non crea repository, file, ruoli o copie;
// i job esistenti mantengono lease, CAS, errori e azzeramento dei buffer.
function preparaCopie(config, { spawnRestic, spawnDump } = {}) {
  if (config === null || config === undefined) return {};
  verificaBinario(config.restic, config.resticSha256);
  verificaBinario(config.pgDump, config.pgDumpSha256);
  for (const file of [config.passwordFile, config.pg.PGPASSFILE]) leggiPrivato(file).fill(0);
  const aws = leggiCredenzialiR2(config.r2Env);
  // Ricontrolla le sostituzioni avvenute dopo il setup. Non elimina la corsa
  // fra controllo e spawn: in produzione i binari devono essere immutabili.
  const resticProtetto = (...args) => {
    verificaBinario(config.restic, config.resticSha256);
    for (const file of [config.passwordFile, config.r2Env]) leggiPrivato(file).fill(0);
    return (spawnRestic || spawn)(...args);
  };
  const dumpProtetto = (...args) => {
    verificaBinario(config.pgDump, config.pgDumpSha256);
    leggiPrivato(config.pg.PGPASSFILE).fill(0);
    return (spawnDump || spawn)(...args);
  };
  const repository = categoria => {
    const { bucket, id } = config.repository[categoria];
    const r = creaRestic({ binario: config.restic, spawnProcesso: resticProtetto, ambiente: { ...aws,
      AWS_DEFAULT_REGION: 'auto', RESTIC_PASSWORD_FILE: config.passwordFile,
      RESTIC_REPOSITORY: 's3:' + config.repository.endpoint + '/' + bucket + '/restic' } });
    return { ...r, async identita() {
      if (await r.identita() !== id) throw new Error('backup_non_disponibile');
      return id;
    } };
  };
  return { repositoryDatabase: repository('database'), repositoryJournal: repository('journal'),
    dumpDatabase: creaDumpPostgres({ binario: config.pgDump, ambiente: config.pg, spawnProcesso: dumpProtetto }) };
}
module.exports = { configuraCopie, preparaCopie, leggiCredenzialiR2 };
