'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const vm = require('node:vm');
const { configuraCopie, preparaCopie, leggiCredenzialiR2 } = require('../backend/nodi/backup-centro-run');
const { creaBackupPostgres } = require('../backend/nodi/backup-postgres-prova');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pg = { host: 'postgres', port: 5432, database: 'amr', ssl: false };
const ids = { database: 'd'.repeat(64), journal: 'e'.repeat(64) };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-backup-run-')); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = {};
  for (const [key, content] of Object.entries({ r2: 'AWS_ACCESS_KEY_ID=' + 'b'.repeat(32)
      + '\nAWS_SECRET_ACCESS_KEY=' + 'c'.repeat(64) + '\n', password: 'chiave-sintetica',
    pgpass: 'postgres:5432:amr:dump_prova:password-sintetica\n', restic: 'restic-sintetico', dump: 'dump-sintetico' })) {
    files[key] = path.join(dir, key);
    fs.writeFileSync(files[key], content, { flag: 'wx', mode: ['restic', 'dump'].includes(key) ? 0o500 : 0o600 });
  }
  const repositories = { endpoint: 'https://' + 'a'.repeat(32) + '.eu.r2.cloudflarestorage.com',
    database: { bucket: 'backup-db-prova', id: ids.database }, journal: { bucket: 'backup-journal-prova', id: ids.journal } };
  const env = { AMR_COPIE_R2_ENV: files.r2, AMR_COPIE_PASSWORD_FILE: files.password,
    AMR_COPIE_RESTIC: files.restic, AMR_COPIE_RESTIC_SHA256: sha(fs.readFileSync(files.restic)),
    AMR_COPIE_PG_DUMP: files.dump, AMR_COPIE_PG_DUMP_SHA256: sha(fs.readFileSync(files.dump)),
    AMR_COPIE_PG_PASSFILE: files.pgpass, AMR_COPIE_PG_USER: 'dump_prova', AMR_COPIE_REPOSITORY: JSON.stringify(repositories) };
  return { dir, files, repositories, env, config: configuraCopie(env, pg) };
}

function processi({ idErrato = false, dumpErrore = false } = {}) {
  const chiamate = [], dati = [];
  const spawn = (tipo) => (binario, args, opts) => {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.stdin = new PassThrough(); p.kill = () => true;
    let contenuto = Buffer.alloc(0);
    p.stdin.on('data', b => { contenuto = Buffer.concat([contenuto, b]); });
    chiamate.push({ tipo, binario, args, env: opts.env });
    const esegui = () => {
      p.stderr.end('segreto-sintetico-da-non-propagare');
      if (tipo === 'dump') {
        p.stdout.end('PGDMP-sintetico'); p.emit('close', dumpErrore ? 1 : 0); return;
      }
      const cat = opts.env.RESTIC_REPOSITORY.includes('/backup-db-prova/') ? 'database' : 'journal';
      if (args[1] === 'cat') p.stdout.end(JSON.stringify({ id: idErrato ? 'f'.repeat(64) : ids[cat] }));
      else if (args[1] === 'backup') {
        dati.push({ categoria: cat, contenuto, originale: contenuto.toString() });
        p.stdout.end(JSON.stringify({ message_type: 'summary', snapshot_id: '9'.repeat(64) }));
      } else assert.fail('comando inatteso: ' + args[1]);
      p.emit('close', 0);
    };
    if (tipo === 'dump') queueMicrotask(esegui);
    else p.stdin.once('finish', esegui);
    return p;
  };
  return { chiamate, dati, spawnRestic: spawn('restic'), spawnDump: spawn('dump') };
}

function outbox() {
  const jobs = ['journal', 'database'].map(categoria => ({ categoria, id: categoria + ':sintetico',
    lease: crypto.randomUUID(), journal: { versione: 1, confermata_il: new Date(Date.now() - 1000).toISOString() } }));
  const sql = [];
  const pool = { async query(q, args) {
    const fn = q.match(/amr_backup\.(\w+)/)[1]; sql.push({ fn, args });
    return { rows: [{ risultato: fn === 'claim' ? jobs.shift() || null : fn === 'retention_pending' ? [] : true }] };
  } };
  return { pool, sql };
}

test('backup Run: assente compatibile, completo esplicito, typo e parziale rifiutati', t => {
  const f = fixture(t);
  assert.equal(configuraCopie({}, pg), null); assert.deepEqual(preparaCopie(null), {});
  assert.equal(f.config.pg.PGUSER, 'dump_prova'); assert.equal(f.config.pg.PGSSLMODE, 'disable');
  const tls = configuraCopie(f.env, { ...pg, ssl: { rejectUnauthorized: true } });
  assert.equal(tls.pg.PGSSLMODE, 'verify-full'); assert.equal(tls.pg.PGSSLROOTCERT, 'system');
  assert.ok(!('PGPASSWORD' in tls.pg));
  for (const key of Object.keys(f.env)) {
    const { [key]: _, ...partial } = f.env;
    assert.throws(() => configuraCopie(partial, pg), { message: 'configurazione_copie_non_valida' });
  }
  for (const patch of [{ AMR_COPIE_REPOSITORY: '{' }, { AMR_COPIE_REPOSITORY: 'null' },
    { AMR_COPIE_PG_USER: 'dump;DROP' }, { AMR_COPIE_RESTIC: '../binario' },
    { AMR_COPIE_RESTIC_SHA256: 'non-verificato' }, { AMR_COPIE_RETENTION: '1' }]) {
    assert.throws(() => configuraCopie({ ...f.env, ...patch }, pg), { message: 'configurazione_copie_non_valida' });
  }
});

test('backup Run: endpoint, bucket e identità chiusi, distinti, senza credenziali negli URL', t => {
  const f = fixture(t);
  const inputs = [
    { ...f.repositories, endpoint: 'http://r2.invalid' }, { ...f.repositories, endpoint: f.repositories.endpoint + '/altro' },
    { ...f.repositories, endpoint: f.repositories.endpoint + '?token=sintetico' },
    { ...f.repositories, endpoint: f.repositories.endpoint.replace('https://', 'https://user:pass@') },
    { ...f.repositories, journal: f.repositories.database },
    { ...f.repositories, journal: { ...f.repositories.journal, id: ids.database } },
    { ...f.repositories, database: { ...f.repositories.database, bucket: '../altro' } },
    { ...f.repositories, database: { ...f.repositories.database, bucket: 123 } },
    { ...f.repositories, database: { ...f.repositories.database, id: 'd'.repeat(8) } },
    { ...f.repositories, fallback: 'latest' },
  ];
  for (const r of inputs) assert.throws(() => configuraCopie({ ...f.env, AMR_COPIE_REPOSITORY: JSON.stringify(r) }, pg),
    { message: 'configurazione_copie_non_valida' });
});

test('backup Run: file riservati, symlink, permessi e binari alterati bloccano prima dei processi', t => {
  const f = fixture(t), spawnRestic = () => assert.fail('nessun processo');
  assert.doesNotThrow(() => preparaCopie(f.config, { spawnRestic }));
  for (const file of [f.files.r2, f.files.password, f.files.pgpass]) {
    fs.chmodSync(file, 0o644);
    assert.throws(() => preparaCopie(f.config, { spawnRestic }), { message: 'configurazione_copie_non_valida' });
    fs.chmodSync(file, 0o600);
  }
  const alias = path.join(f.dir, 'alias'); fs.symlinkSync(f.files.r2, alias);
  assert.throws(() => leggiCredenzialiR2(alias), { message: 'configurazione_copie_non_valida' });
  fs.chmodSync(f.dir, 0o755);
  assert.throws(() => preparaCopie(f.config, { spawnRestic }), { message: 'configurazione_copie_non_valida' });
  fs.chmodSync(f.dir, 0o700);
  assert.throws(() => preparaCopie({ ...f.config, resticSha256: '0'.repeat(64) }, { spawnRestic }),
    { message: 'configurazione_copie_non_valida' });
  fs.chmodSync(f.files.dump, 0o700); fs.appendFileSync(f.files.dump, 'alterazione');
  assert.throws(() => preparaCopie(f.config, { spawnRestic }), { message: 'configurazione_copie_non_valida' });
});

test('backup Run: parser R2 condiviso conserva i rifiuti del collaudo', t => {
  const f = fixture(t), legacy = require('../scripts/collauda-backup-r2-postgres').leggiCredenziali;
  assert.deepEqual(leggiCredenzialiR2(f.files.r2), legacy(f.files.r2));
  const valido = fs.readFileSync(f.files.r2);
  for (const extra of ['AWS_ACCESS_KEY_ID=' + 'b'.repeat(32), 'NHOST_ADMIN_SECRET=segreto-sintetico', 'export AWS_SECRET_ACCESS_KEY=x']) {
    fs.writeFileSync(f.files.r2, Buffer.concat([valido, Buffer.from(extra + '\n')]));
    assert.throws(() => leggiCredenzialiR2(f.files.r2), { message: 'configurazione_copie_non_valida' });
    assert.throws(() => legacy(f.files.r2), { message: 'credenziali_collaudo_non_valide' });
  }
});

test('backup Run: i controlli ACL non ereditano i segreti del processo centrale', t => {
  const f = fixture(t), modulo = { exports: {} }, chiamate = [];
  const leggiModulo = require('node:module').createRequire(require.resolve('../backend/nodi/backup-centro-run'));
  vm.runInNewContext(fs.readFileSync(require.resolve('../backend/nodi/backup-centro-run'), 'utf8'), {
    module: modulo, Buffer,
    process: { platform: 'darwin', getuid: () => process.getuid(), env: { SEGRETO_PROVA: 'sentinella-sintetica' } },
    require: id => id === 'node:child_process' ? { execFileSync(bin, args, opts) {
      chiamate.push({ bin, args, opts }); return Buffer.from('-rw------- 1 utente gruppo 1 file\n');
    } } : leggiModulo(id),
  });
  modulo.exports.leggiCredenzialiR2(f.files.r2);
  assert.equal(chiamate.length, 2);
  for (const c of chiamate) {
    assert.ok(c.opts.env, 'ambiente ACL esplicito');
    assert.deepEqual(JSON.parse(JSON.stringify(c.opts.env)), { LANG: 'C', TZ: 'UTC' });
  }
});

test('backup Run: ricontrolla binari e file riservati prima di passarli ai processi', async t => {
  for (const caso of ['restic', 'dump', 'password', 'pgpass', 'r2']) {
    const f = fixture(t), p = processi(), copie = preparaCopie(f.config, p);
    if (['restic', 'dump'].includes(caso)) {
      fs.chmodSync(f.files[caso], 0o700); fs.appendFileSync(f.files[caso], 'alterato-dopo-avvio');
    } else fs.chmodSync(f.files[caso], 0o644);
    await assert.rejects(caso === 'dump' || caso === 'pgpass' ? copie.dumpDatabase() : copie.repositoryDatabase.identita(),
      { message: 'backup_non_disponibile' });
    assert.equal(p.chiamate.length, 0);
  }
});

test('backup Run: worker reale copia entrambi i job con ambienti separati, senza init o delete', async t => {
  const f = fixture(t), p = processi(), o = outbox();
  const worker = creaBackupPostgres({ pool: o.pool, ...preparaCopie(f.config, p) });
  assert.equal(p.chiamate.length, 0);
  assert.deepEqual(await worker.drain(), { ok: true, completate: 2, fallite: 0 });
  assert.deepEqual(o.sql.find(q => q.fn === 'configura').args, [true, false]);
  assert.equal(o.sql.filter(q => q.fn === 'completa').length, 2);
  assert.deepEqual(p.dati.map(x => x.categoria), ['journal', 'database']);
  assert.equal(p.dati[1].originale, 'PGDMP-sintetico');
  for (const c of p.chiamate) {
    assert.ok(!c.args.join(' ').includes('b'.repeat(32))); assert.ok(!c.args.join(' ').includes('c'.repeat(64)));
    assert.ok(!c.env.HOME); assert.ok(!c.env.PGPASSWORD); assert.ok(!c.env.AMR_NODI_TOKENS);
    if (c.tipo === 'restic') { assert.equal(c.env.AWS_DEFAULT_REGION, 'auto'); assert.ok(!c.env.PGUSER); }
    else { assert.equal(c.env.PGUSER, 'dump_prova'); assert.equal(c.env.PGPASSFILE, f.files.pgpass); assert.ok(!c.env.AWS_SECRET_ACCESS_KEY); }
  }
  assert.ok(p.chiamate.filter(c => c.tipo === 'restic').every(c => ['cat', 'backup'].includes(c.args[1])));
});

test('backup Run: identità cambiata impedisce tutte le copie; errore dump lascia il journal riuscito', async t => {
  for (const scenario of [{ idErrato: true }, { dumpErrore: true }]) {
    const f = fixture(t), p = processi(scenario), o = outbox();
    const worker = creaBackupPostgres({ pool: o.pool, ...preparaCopie(f.config, p) });
    const r = await worker.drain();
    assert.equal(r.completate, scenario.idErrato ? 0 : 1); assert.equal(r.fallite, scenario.idErrato ? 2 : 1);
    assert.equal(p.dati.length, scenario.idErrato ? 0 : 1);
    assert.ok(o.sql.filter(q => q.fn === 'fallisce').every(q => q.args[2] === 'backup_non_disponibile'));
    assert.ok(!JSON.stringify(r).includes('segreto-sintetico'));
  }
});

test('entrypoint Run: configurazione raggiunge il worker, due job e chiusura dei tre pool', async t => {
  const f = fixture(t), manifest = { protocollo: 1, release: 'b'.repeat(40), codice: 'c'.repeat(64), cataloghi: 'd'.repeat(64) };
  // Eseguibili sintetici: attraversano spawn senza alcuna connessione esterna.
  fs.chmodSync(f.files.restic, 0o700); fs.chmodSync(f.files.dump, 0o700);
  fs.writeFileSync(f.files.restic, '#!' + process.execPath + '\nconst a=process.argv.slice(2);'
    + 'if(a[1]==="cat")console.log(JSON.stringify({id:process.env.RESTIC_REPOSITORY.includes("/backup-db-prova/")?"'
    + ids.database + '":"' + ids.journal + '"}));'
    + 'else if(a[1]==="backup"){process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({message_type:"summary",snapshot_id:"'
    + '9'.repeat(64) + '"})));}else process.exit(1);\n');
  fs.writeFileSync(f.files.dump, '#!' + process.execPath + '\nprocess.stdout.write("PGDMP-sintetico");\n');
  const env = { ...f.env, AMR_COPIE_RESTIC_SHA256: sha(fs.readFileSync(f.files.restic)),
    AMR_COPIE_PG_DUMP_SHA256: sha(fs.readFileSync(f.files.dump)),
    AMR_CENTRO_ORIGINE: 'https://amr.invalid', AMR_NHOST_AUTH_URL: 'https://auth.amr.invalid/v1',
    AMR_NODI_TOKENS: JSON.stringify({ locale: 'a'.repeat(64) }), AMR_NODI_RELEASE_FILE: path.join(f.dir, 'release.json'),
    AMR_NODI_DATA_DIR: path.join(f.dir, 'centro'), AMR_CENTRO_REPLICHE: '1', AMR_CENTRO_PROXY_IP: '127.0.0.1',
    AMR_PG_HOST: 'postgres', AMR_PG_DATABASE: 'amr', AMR_PG_RETE_PRIVATA: '1',
    ...Object.fromEntries(['LETTURA', 'COMMERCIALE', 'BACKUP'].flatMap(r => [
      ['AMR_PG_' + r + '_USER', r.toLowerCase()], ['AMR_PG_' + r + '_PASSWORD', 'password-sintetica']])) };
  fs.writeFileSync(env.AMR_NODI_RELEASE_FILE, JSON.stringify(manifest));
  const o = outbox(); let chiusi = 0, servizio;
  class Pool extends EventEmitter {
    async query(q, args) { return o.pool.query(q, args); }
    async connect() { const c = new EventEmitter(); c.query = async () => {}; c.release = () => {}; return c; }
    async end() { chiusi++; }
  }
  try {
    const config = require('../backend/nodi/config-centro-run').configura(env);
    servizio = await require('../backend/nodi/centro-run').creaServizio(config, { Pool, verificaRelease: v => v });
    const fine = Date.now() + 10000;
    while (o.sql.filter(q => q.fn === 'completa').length < 2 && Date.now() < fine) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(o.sql.find(q => q.fn === 'configura').args, [true, false]);
    assert.equal(o.sql.filter(q => q.fn === 'completa').length, 2);
  } finally { await servizio?.close(); }
  assert.equal(chiusi, 3);
  const config = require('../backend/nodi/config-centro-run').configura(env);
  await assert.rejects(require('../backend/nodi/centro-run').creaServizio({ ...config,
    copie: { ...config.copie, r2Env: path.join(f.dir, 'assente') } }, { Pool, verificaRelease: v => v }),
  { message: 'centro_run_non_avviato' });
  assert.equal(chiusi, 6);
});
