'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { creaRestic } = require('../../backend/nodi/backup-restic');
const { globalsPerRestore } = require('../collauda-backup-staging-locale');
const { sha, MAX } = require('./esporta-backup-staging');
const HOST = 'unix://' + path.join(os.homedir(), '.colima/amr-auth/docker.sock');
const PG = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';
const PARENT = path.join(os.homedir(), 'AMR-backup-staging');

function privato(file, directory = true) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)
      || !(directory ? stat.isDirectory() : stat.isFile())) throw new Error('percorso_non_privato');
  if (process.platform === 'darwin') {
    const elenco = execFileSync('/bin/ls', ['-lde', file], { timeout:2000, maxBuffer:16384 }).toString();
    // Gli attributi estesi mostrano @ al posto di + anche quando esistono ACL.
    if (elenco.split(/\s/, 1)[0].includes('+') || /^\s*\d+:\s/m.test(elenco)) throw new Error('acl_non_privata');
  }
}
const senzaACL = file => {
  if (process.platform === 'darwin') execFileSync('/bin/chmod', ['-N', file], { timeout:2000, stdio:'ignore' });
};
function sincronizza(file) {
  const fd = fs.openSync(file, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function scrivi(directory, info) {
  const file = path.join(directory, 'esito.json');
  const nuovo = path.join(directory, 'esito-' + crypto.randomBytes(6).toString('hex') + '.tmp');
  fs.writeFileSync(nuovo, JSON.stringify(info, null, 2) + '\n', { mode:0o600, flag:'wx' });
  senzaACL(nuovo); sincronizza(nuovo); fs.renameSync(nuovo, file); sincronizza(directory);
}
function leggi(directory, parent) {
  privato(parent);
  if (path.dirname(directory) !== parent || !/^copia-[a-zA-Z0-9]+$/.test(path.basename(directory))) {
    throw new Error('checkpoint_non_atteso');
  }
  privato(directory); privato(path.join(directory, 'esito.json'), false);
  const stat = fs.statSync(path.join(directory, 'esito.json'));
  if (stat.size > 16384) throw new Error('checkpoint_non_atteso');
  const info = JSON.parse(fs.readFileSync(path.join(directory, 'esito.json'), 'utf8'));
  if (info.versione !== 1 || !/^[a-f0-9]{40}$/.test(info.release || '')
      || !/^[a-z0-9]{20}$/.test(info.database || '') || info.cifrato !== true) throw new Error('checkpoint_non_atteso');
  privato(path.join(directory, 'chiave-restic'), false);
  for (const categoria of ['postgres', 'volume']) {
    const copia = info.copie?.[categoria];
    if (!copia || !/^[a-f0-9]{64}$/.test(copia.sha256 || '') || !/^[a-f0-9]{64}$/.test(copia.snapshot || '')
        || !Number.isSafeInteger(copia.byte) || copia.byte <= 0 || copia.byte > MAX) throw new Error('checkpoint_non_atteso');
    privato(path.join(directory, 'repo-' + categoria));
  }
  return info;
}
const repo = (directory, categoria, restic) => creaRestic({ binario:restic, ambiente:{
  RESTIC_REPOSITORY:path.join(directory, 'repo-' + categoria), RESTIC_PASSWORD_FILE:path.join(directory, 'chiave-restic'),
} });

// Il checkpoint precede qualsiasi attesa cloud. Un errore successivo non elimina
// copie o chiave; restore=false distingue conservazione da ripristino collaudato.
async function cifra({ postgres, volume, release, database }, { parent = PARENT, restic } = {}) {
  const buffers = { postgres, volume };
  let directory;
  try {
    if (Object.values(buffers).some(b => !Buffer.isBuffer(b) || !b.length || b.length > MAX)
        || !/^[a-f0-9]{40}$/.test(release || '') || !/^[a-z0-9]{20}$/.test(database || '')) throw new Error('copia_non_valida');
    if (!path.isAbsolute(parent)) throw new Error('percorso_non_privato');
    if (!fs.existsSync(parent)) { fs.mkdirSync(parent, { mode:0o700 }); senzaACL(parent); sincronizza(path.dirname(parent)); }
    privato(parent);
    directory = fs.mkdtempSync(path.join(parent, 'copia-')); senzaACL(directory); fs.chmodSync(directory, 0o700); sincronizza(parent);
    const key = path.join(directory, 'chiave-restic');
    fs.writeFileSync(key, crypto.randomBytes(32).toString('hex'), { mode:0o600, flag:'wx' });
    senzaACL(key); sincronizza(key); sincronizza(directory);
    const info = { versione:1, conservazione:'temporanea_imac', data:new Date().toISOString(), release, database,
      copie:{}, cifrato:false, restore:false };
    scrivi(directory, info);
    for (const categoria of Object.keys(buffers)) {
      const r = repo(directory, categoria, restic), bytes = buffers[categoria], impronta = sha(bytes);
      await r.inizializza();
      info.copie[categoria] = { byte:bytes.length, sha256:impronta, snapshot:(await r.copia(bytes, 'database')).snapshot };
      bytes.fill(0); scrivi(directory, info); await r.verifica();
    }
    info.cifrato = true; scrivi(directory, info);
    return { ok:true, directory, copie:info.copie, cifrato:true, restore:false };
  } catch {
    throw Object.assign(new Error('checkpoint_non_confermato'), { directory });
  } finally { Object.values(buffers).forEach(b => { if (Buffer.isBuffer(b)) b.fill(0); }); }
}

function comandi() {
  const fine = performance.now() + 720000; let fineCleanup;
  const esegui = (bin, args, input) => new Promise((resolve, reject) => {
    const durata = Math.min(fineCleanup ? 30000 : 120000, Math.floor((fineCleanup || fine) - performance.now()));
    if (durata <= 0) return reject(new Error('deadline'));
    const p = spawn(bin, args, { env:{ PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C' }, stdio:['pipe','pipe','pipe'] });
    const chunks = []; let size = 0, errore = false;
    p.stdout.on('data', b => { size += b.length; if (size > MAX) { errore = true; p.kill('SIGKILL'); } else chunks.push(b); });
    p.stderr.resume(); p.stdin.on('error', () => {}); p.stdin.end(input);
    const timer = setTimeout(() => { errore = true; p.kill('SIGKILL'); }, durata);
    p.once('error', () => { errore = true; });
    p.once('close', code => {
      clearTimeout(timer); const b = Buffer.concat(chunks); chunks.forEach(x => x.fill(0));
      if (code !== 0 || errore) { b.fill(0); reject(new Error('comando_non_confermato')); } else resolve(b);
    });
  });
  return { esegui, cleanup:() => { fineCleanup = performance.now() + 90000; } };
}

// Solo ripristino in risorse nuove sul Docker locale, senza rete né porte.
// La copia cifrata rimane intatta anche quando verifica o cleanup falliscono.
async function verifica(directory, { parent = PARENT, restic, platform = 'linux/amd64' } = {}) {
  const info = leggi(directory, parent);
  if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Error('platform_non_attesa');
  const id = 'amr-restore-backup-' + crypto.randomBytes(6).toString('hex');
  const proprietario = crypto.randomBytes(32).toString('hex');
  const runner = comandi(), esegui = runner.esegui;
  const docker = (args, input) => esegui('/usr/local/bin/docker', ['--host', HOST, ...args], input);
  let temp, cleanup = true, fase = 'decifra', errore; const riservati = [];
  try {
    info.restore = false; scrivi(directory, info);
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restore-privato-')); senzaACL(temp); fs.chmodSync(temp, 0o700);
    const restored = {};
    for (const categoria of ['postgres', 'volume']) {
      const r = repo(directory, categoria, restic); await r.verifica();
      restored[categoria] = path.join(await r.ripristina(info.copie[categoria].snapshot, temp), 'database.dump');
      const b = fs.readFileSync(restored[categoria]);
      try { assert.equal(b.length, info.copie[categoria].byte); assert.equal(sha(b), info.copie[categoria].sha256); }
      finally { b.fill(0); }
    }
    fase = 'archivio';
    const members = (await esegui('/usr/bin/tar', ['-tf', restored.postgres])).toString().trim().split('\n');
    assert.deepEqual(members, ['database.dump','globals.sql','manifest.json']);
    const estrai = async n => { const b = await esegui('/usr/bin/tar', ['-xOf', restored.postgres, n]); riservati.push(b); return b; };
    const meta = JSON.parse((await estrai('manifest.json')).toString());
    assert.equal(meta.versione, 1); assert.equal(meta.release, info.release); assert.equal(meta.postgres.database, info.database);
    assert.ok(/^[a-z_][a-z0-9_]{0,62}$/.test(meta.postgres.bootstrap));
    const dump = await estrai('database.dump'), globals = await estrai('globals.sql');
    assert.equal(sha(dump), meta.file['database.dump'].sha256); assert.equal(sha(globals), meta.file['globals.sql'].sha256);
    assert.equal(info.copie.volume.sha256, meta.file['lavori-prototipo.db'].sha256);
    fase = 'postgres';
    await docker(['run','--platform',platform,'-d','--name',id,'--network','none','--tmpfs',
      '/var/lib/postgresql:rw,noexec,nosuid,size=512m','--label','amr.backup.restore=' + proprietario,'-e','POSTGRES_USER=' + meta.postgres.bootstrap,
      '-e','POSTGRES_HOST_AUTH_METHOD=trust',PG]);
    let pronto = false;
    for (let i = 0; i < 40; i++) {
      try { await docker(['exec',id,'pg_isready','-h','127.0.0.1','-U',meta.postgres.bootstrap]); pronto = true; break; }
      catch { await new Promise(r => setTimeout(r, 300)); }
    }
    assert.ok(pronto);
    const sql = s => docker(['exec','-i',id,'psql','-X','-v','ON_ERROR_STOP=1','-U',meta.postgres.bootstrap,'-d','postgres','-At'], s);
    const restoreGlobals = globalsPerRestore(globals, meta.postgres.bootstrap); riservati.push(restoreGlobals);
    await sql(restoreGlobals);
    await docker(['exec','-i',id,'pg_restore','-U',meta.postgres.bootstrap,'-d','postgres','--create','--exit-on-error'], dump);
    fase = 'conti';
    const counts = (await docker(['exec','-i',id,'psql','-X','-v','ON_ERROR_STOP=1','-U',meta.postgres.bootstrap,'-d',info.database,'-At'],
      Buffer.from('SELECT count(*) FROM auth.users;SELECT count(*) FROM amr_accessi.aziende;'))).toString().trim().split('\n').map(Number);
    assert.deepEqual(counts, [meta.postgres.utenti_auth, meta.postgres.aziende]);
    const db = new DatabaseSync(restored.volume, { readOnly:true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      for (const n of ['lavori','eventi','sospensioni','token_revocati']) assert.equal(db.prepare('SELECT count(*) AS n FROM ' + n).get().n, meta.sqlite[n]);
    } finally { db.close(); }
    info.restore = true; info.acquisizione = meta.acquisizione; info.postgres = meta.postgres.versione;
  } catch { errore = Object.assign(new Error('restore_non_confermato'), { fase, directory }); }
  finally {
    runner.cleanup(); riservati.forEach(b => b.fill(0));
    try {
      const nomi = () => docker(['ps','-a','--format','{{.Names}}']).then(b => b.toString().trim().split('\n'));
      if ((await nomi()).includes(id)) {
        const proprieta = (await docker(['inspect','--format','{{.Id}} {{index .Config.Labels "amr.backup.restore"}}',id])).toString().trim().split(' ');
        if (proprieta[1] === proprietario && /^[a-f0-9]{64}$/.test(proprieta[0])) {
          await docker(['rm','-f',proprieta[0]]);
          if ((await nomi()).includes(id)) cleanup = false;
        }
      }
    } catch { cleanup = false; }
    if (temp) try { fs.rmSync(temp, { recursive:true, force:true }); } catch { cleanup = false; }
    info.cleanup = cleanup; if (!cleanup) info.restore = false;
    try { scrivi(directory, info); }
    catch { errore ||= Object.assign(new Error('ricevuta_non_confermata'), { fase:'ricevuta', directory }); }
    if (!cleanup) errore ||= Object.assign(new Error('cleanup_non_confermato'), { fase:'cleanup', directory });
  }
  if (errore) throw errore;
  return { ok:true, directory, copie:info.copie, cifrato:true, restore:true, networkRestore:'none' };
}
if (require.main === module) {
  let chunks = [], size = 0;
  process.stdin.on('data', b => {
    size += b.length;
    if (size > 2 * MAX * 1.4 + 65536) { chunks.forEach(x => x.fill(0)); chunks = []; process.stdin.destroy(); process.exitCode = 1; }
    else chunks.push(b);
  });
  process.stdin.on('end', async () => {
    try {
      const b = Buffer.concat(chunks); chunks.forEach(x => x.fill(0)); chunks = [];
      let input; try { input = JSON.parse(b.toString()); } finally { b.fill(0); }
      const opts = { restic:process.env.AMR_BACKUP_RESTIC };
      let result;
      if (input.azione === 'cifra') {
        const postgres = Buffer.from(input.postgres, 'base64'), volume = Buffer.from(input.volume, 'base64');
        input.postgres = input.volume = '';
        result = await cifra({ postgres, volume, release:input.release, database:input.database }, opts);
      } else if (input.azione === 'verifica') result = await verifica(input.directory, opts);
      else throw new Error('azione_non_valida');
      console.log(JSON.stringify(result));
    } catch (e) {
      console.log(JSON.stringify({ ok:false, codice:['checkpoint_non_confermato','restore_non_confermato','cleanup_non_confermato','ricevuta_non_confermata'].includes(e.message) ? e.message : 'ingresso_non_valido',
        fase:e.fase, directory:e.directory })); process.exitCode = 1;
    }
  });
}
module.exports = { cifra, verifica };
