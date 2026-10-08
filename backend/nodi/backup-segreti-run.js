'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const FILES = ['AMR_COPIE_R2_ENV', 'AMR_COPIE_PASSWORD_FILE', 'AMR_COPIE_PG_PASSFILE',
  'AMR_COPIE_RESTIC', 'AMR_COPIE_RESTIC_SHA256', 'AMR_COPIE_PG_DUMP', 'AMR_COPIE_PG_DUMP_SHA256'];
const errore = () => new Error('segreti_copie_non_validi');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

// Run fornisce segreti come ambiente. I soli file necessari ai subprocess
// nascono in una directory effimera privata, mai nel volume diagnostico.
function preparaSegreti(env, { temporanei = os.tmpdir(), metadati = '/opt/amr/backup-binaries.json' } = {}) {
  if (env.AMR_COPIE_SEGRETI === undefined) return { ambiente: env, chiudi() {} };
  let directory, identita, chiuso = false;
  const chiudi = () => {
    if (chiuso || !directory) return;
    const s = fs.lstatSync(directory);
    if (!s.isDirectory() || s.dev !== identita.dev || s.ino !== identita.ino || s.uid !== process.getuid()) throw errore();
    for (const nome of ['r2.env', 'restic-password', 'pgpass']) {
      try { fs.unlinkSync(path.join(directory, nome)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    fs.rmdirSync(directory); chiuso = true;
  };
  try {
    if (FILES.some(k => env[k] !== undefined) || typeof env.AMR_COPIE_SEGRETI !== 'string'
        || env.AMR_COPIE_SEGRETI.length > 4096 || !path.isAbsolute(temporanei)) throw errore();
    const segreti = JSON.parse(env.AMR_COPIE_SEGRETI);
    if (!exact(segreti, ['r2', 'passwordRestic', 'passwordDump'])
        || !exact(segreti.r2, ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'])
        || typeof segreti.r2.AWS_ACCESS_KEY_ID !== 'string' || !/^[a-f0-9]{32}$/.test(segreti.r2.AWS_ACCESS_KEY_ID)
        || [segreti.r2.AWS_SECRET_ACCESS_KEY, segreti.passwordRestic, segreti.passwordDump]
          .some(v => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) throw errore();
    const porta = Number(env.AMR_PG_PORT ?? 5432);
    if (!Number.isSafeInteger(porta) || porta < 1 || porta > 65535) throw errore();
    const pg = [env.AMR_PG_HOST, String(porta), env.AMR_PG_DATABASE, env.AMR_COPIE_PG_USER];
    if (pg.some(v => typeof v !== 'string' || !/^[a-zA-Z0-9_.-]{1,253}$/.test(v))) throw errore();
    let fd, binari;
    try {
      fd = fs.openSync(metadati, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const s = fs.fstatSync(fd);
      if (!s.isFile() || s.size > 4096 || (s.mode & 0o022) || ![0, process.getuid()].includes(s.uid)) throw errore();
      binari = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    if (!exact(binari, ['restic', 'pgDump'])
        || [binari.restic, binari.pgDump].some(v => !exact(v, ['path', 'sha256'])
          || !path.isAbsolute(v.path || '') || !/^[a-f0-9]{64}$/.test(v.sha256 || ''))
        || binari.restic.path !== '/usr/bin/restic' || binari.pgDump.path !== '/usr/lib/postgresql/18/bin/pg_dump') throw errore();
    directory = fs.mkdtempSync(path.join(temporanei, 'amr-copie-segreti-'));
    identita = fs.lstatSync(directory); fs.chmodSync(directory, 0o700);
    const scrivi = (nome, testo) => {
      const raw = Buffer.from(testo);
      try { fs.writeFileSync(path.join(directory, nome), raw, { flag: 'wx', mode: 0o600 }); }
      finally { raw.fill(0); }
    };
    scrivi('r2.env', Object.entries(segreti.r2).map(([k, v]) => k + '=' + v).join('\n') + '\n');
    scrivi('restic-password', segreti.passwordRestic);
    scrivi('pgpass', [...pg, segreti.passwordDump].join(':') + '\n');
    const ambiente = { ...env,
      AMR_COPIE_R2_ENV: path.join(directory, 'r2.env'), AMR_COPIE_PASSWORD_FILE: path.join(directory, 'restic-password'),
      AMR_COPIE_PG_PASSFILE: path.join(directory, 'pgpass'),
      AMR_COPIE_RESTIC: binari.restic.path, AMR_COPIE_RESTIC_SHA256: binari.restic.sha256,
      AMR_COPIE_PG_DUMP: binari.pgDump.path, AMR_COPIE_PG_DUMP_SHA256: binari.pgDump.sha256 };
    delete ambiente.AMR_COPIE_SEGRETI;
    return { ambiente, chiudi };
  } catch {
    try { chiudi(); } catch { throw new Error('segreti_copie_cleanup_non_confermato'); }
    throw errore();
  }
}
module.exports = { preparaSegreti };
