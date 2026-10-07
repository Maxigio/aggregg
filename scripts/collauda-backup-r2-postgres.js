'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { creaRestic } = require('../backend/nodi/backup-restic');
const { creaBackupPostgres, creaDumpPostgres, creaStatoBackup } = require('../backend/nodi/backup-postgres-prova');
const { creaAziendePostgres } = require('../backend/nodi/aziende-postgres-prova');
const { creaColleghiPostgres } = require('../backend/nodi/colleghi-postgres-prova');
const { applicaJournalOrdinati, preparaJournalDaRepository } = require('../backend/nodi/ripristino-journal');
const { preparaSchema } = require('./nhost/prepara-schema-staging');
const PG = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';
const ENDPOINT = 'https://88508b25fc92046c93f7a33eaac1bc2c.eu.r2.cloudflarestorage.com';
const MAX = 10 * 1024 * 1024;
const ROLES = ['amr_accessi_lettore', 'amr_aziende_definitore', 'amr_aziende_scrittore',
  'amr_colleghi_definitore', 'amr_colleghi_scrittore', 'amr_backup_definitore', 'amr_backup_esecutore',
  'amr_gateway', 'amr_commerciale', 'amr_copie', 'amr_login_definitore'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

// File scelto esplicitamente: niente ricerca di credenziali o caricamento del .env AMR.
function leggiCredenziali(file) {
  let fd;
  try {
    if (!path.isAbsolute(file || '')) throw new Error();
    const parent = fs.lstatSync(path.dirname(file));
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid()) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw new Error();
    const env = {};
    for (const line of fs.readFileSync(fd, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const m = /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=([a-f0-9]+)$/.exec(line);
      if (!m || Object.hasOwn(env, m[1])) throw new Error();
      env[m[1]] = m[2];
    }
    if (!/^[a-f0-9]{32}$/.test(env.AWS_ACCESS_KEY_ID || '')
      || !/^[a-f0-9]{64}$/.test(env.AWS_SECRET_ACCESS_KEY || '')) throw new Error();
    return env;
  } catch { throw new Error('credenziali_collaudo_non_valide'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function validaConfigurazione({ host, restic, impronta, credenziali }) {
  if (host !== 'unix://' + path.join(os.homedir(), '.colima/amr-auth/docker.sock')
      || !path.isAbsolute(restic || '') || !/^[a-f0-9]{64}$/.test(impronta || '')
      || fs.lstatSync(restic).isSymbolicLink() || sha(fs.readFileSync(restic)) !== impronta) {
    throw new Error('collaudo_non_configurato');
  }
  return credenziali === undefined ? {} : leggiCredenziali(credenziali);
}

// Opt-in, due cluster nuovi. Nessun URL PostgreSQL esterno, dump di staging o portale.
async function collauda(config) {
  const aws = validaConfigurazione(config), { host, restic } = config;
  const id = crypto.randomUUID(), prefix = 'collaudo-pg-' + id;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-r2-pg-'));
  fs.chmodSync(directory, 0o700);
  const key = path.join(directory, 'restic-password'), pgEnv = path.join(directory, 'postgres.env');
  const pgPassword = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(key, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(pgEnv, 'POSTGRES_PASSWORD=' + pgPassword + '\n', { mode: 0o600, flag: 'wx' });
  const names = { rete: 'amr-r2-pg-' + id, source: 'amr-r2-pg-source-' + id, restore: 'amr-r2-pg-restore-' + id };
  const receipt = { versione: 1, id, modalita: config.credenziali ? 'r2' : 'locale',
    avviato_il: new Date().toISOString(), immagine: PG, restic_sha256: config.impronta,
    prefix, payload_bytes: 0, copie: [], prove: [], fase: 'fixture', ok: false };
  const pools = [], created = new Set();
  let networkAttempted = false, worker, writer, failure;
  const docker = (args, input) => new Promise((resolve, reject) => {
    const p = spawn('docker', ['--host', host, ...args],
      { env: { PATH: process.env.PATH, LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, limit = false, errors = '';
    const timer = setTimeout(() => { limit = true; p.kill('SIGKILL'); }, 60000);
    p.stderr.on('data', b => { if (errors.length < 16384) errors += b.toString().slice(0, 16384 - errors.length); });
    p.stdin.on('error', () => {}); p.stdin.end(input);
    p.stdout.on('data', b => {
      size += b.length;
      if (size > MAX) { limit = true; b.fill(0); p.kill('SIGKILL'); }
      else chunks.push(b);
    });
    p.once('error', () => { clearTimeout(timer); reject(new Error('docker_non_avviato')); });
    p.once('close', code => {
      clearTimeout(timer);
      const output = code === 0 && !limit ? Buffer.concat(chunks) : null;
      chunks.forEach(b => b.fill(0));
      const assente = /^Error(?: response from daemon)?: (?:No such (?:object|container|network): |network [a-z0-9-]+ not found)/m.test(errors);
      const motivo = ['must be owner', 'permission denied', 'already exists', 'does not exist',
        'unrecognized configuration parameter', 'invalid header', 'unsupported version', 'No public port',
        'transaction block', 'duplicate key', 'violates check constraint'].find(x => errors.includes(x));
      errors = '';
      output ? resolve(output) : reject(Object.assign(new Error('docker_non_confermato'), { dockerCode: code, azione: args[0], motivo, assente }));
    });
  });
  const repo = {};
  for (const [categoria, bucket] of [['database', 'amr-collaudo-backup-db'], ['journal', 'amr-collaudo-backup-journal']]) {
    const raw = creaRestic({ binario: restic, ambiente: { ...aws,
      RESTIC_PASSWORD_FILE: key,
      RESTIC_REPOSITORY: config.credenziali ? 's3:' + ENDPOINT + '/' + bucket + '/' + prefix : path.join(directory, 'repo-' + categoria),
    } });
    repo[categoria] = { ...raw, async copia(bytes, category, options) {
      // Contare tutte le copie, incluso il dump periodico creato dal worker.
      if (receipt.payload_bytes + bytes.length >= MAX) throw new Error('collaudo_payload_eccessivo');
      receipt.payload_bytes += bytes.length;
      const hash = sha(bytes), length = bytes.length, start = performance.now();
      const out = await raw.copia(bytes, category, options);
      receipt.copie.push({ categoria: category, snapshot: out.snapshot, bytes: length, sha256: hash,
        durata_ms: Math.round(performance.now() - start) });
      return out;
    } };
  }
  const fixture = async name => {
    // Registrare prima: il daemon può creare la risorsa anche se la risposta si perde.
    created.add(name);
    await docker(['create', '--pull=never', '--name', name, '--label', 'amr.collaudo=' + id,
      '--network', names.rete, '--memory', '512m', '--cpus', '1', '--env-file', pgEnv,
      '--tmpfs', '/var/lib/postgresql:rw,nosuid,size=256m', '-p', '127.0.0.1::5432', PG]);
    await docker(['start', name]);
    for (let i = 0; ; i++) {
      try { await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch { if (i === 59) throw new Error('postgres_non_pronto'); await new Promise(r => setTimeout(r, 250)); }
    }
    const address = (await docker(['port', name, '5432'])).toString().trim();
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const pool = new Pool({ host: '127.0.0.1', port: Number(address.split(':')[1]), user: 'postgres',
      database: 'postgres', password: pgPassword, max: 2, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
    pool.on('error', () => {}); pools.push(pool); return pool;
  };
  const readBusiness = async db => {
    const result = {};
    for (const [table, fields, order] of [
      ['aziende', 'id,nome,attiva,scadenza,moduli,referente,accettata_il,attivata_il', 'id'],
      ['membri', 'persona,azienda', 'persona'], ['persone', 'id,attiva,admin,epoca', 'id'],
      ['aziende_inviti', 'id,azienda,persona,accettata_il,scadenza', 'id'],
      ['colleghi_inviti', 'id,azienda,stato,persona,accettata_il,revocata_il,scadenza', 'id'],
    ]) result[table] = (await db.query('SELECT ' + fields + ' FROM amr_accessi.' + table + ' ORDER BY ' + order)).rows;
    return result;
  };
  try {
    // Docker non assegna le porte pubblicate alla rete internal. Bridge dedicato,
    // credenziale casuale e binding esplicito solo loopback per il client PG host.
    networkAttempted = true;
    await docker(['network', 'create', '--label', 'amr.collaudo=' + id, names.rete]);
    receipt.fase = 'avvio_source';
    const source = await fixture(names.source);
    receipt.fase = 'avvio_restore';
    const recovery = await fixture(names.restore);
    receipt.fase = 'schema_auth';
    await source.query('CREATE EXTENSION citext; CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email citext NOT NULL UNIQUE,'
      + 'email_verified boolean NOT NULL DEFAULT true,disabled boolean NOT NULL DEFAULT false);'
      + 'CREATE TABLE auth.refresh_tokens(id uuid PRIMARY KEY)');
    receipt.fase = 'schema_candidato';
    const schema = preparaSchema();
    receipt.release_schema = schema.release; receipt.schema = schema.impronte;
    await source.query(schema.sql);
    receipt.fase = 'inviti_sintetici';
    const people = {};
    for (const who of ['admin', 'first', 'reference', 'colleague']) {
      people[who] = crypto.randomUUID();
      await source.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [people[who], who + '@amr.invalid']);
    }
    await source.query('INSERT INTO auth.refresh_tokens VALUES($1)', [crypto.randomUUID()]);
    await source.query('INSERT INTO amr_accessi.persone(id,admin) VALUES($1,true)', [people.admin]);
    const admin = { persona: people.admin, epoca: 0, mfa: true };
    writer = await source.connect(); await writer.query('SET ROLE amr_commerciale');
    const business = creaAziendePostgres({ pool: writer }), colleagues = creaColleghiPostgres({ pool: writer });
    const invite = async (company, email) => business.invita(admin, { id: company, nome: 'Azienda sintetica',
      email, moduli: ['moto'], operazione: crypto.randomUUID() });
    const first = await invite('first', 'first@amr.invalid'), reference = await invite('second', 'reference@amr.invalid');
    await business.accetta(people.reference, reference.token, crypto.randomUUID());
    await business.attiva(admin, { id: 'second', operazione: crypto.randomUUID() });
    const colleague = await colleagues.invita(admin, { id: 'second', email: 'colleague@amr.invalid', operazione: crypto.randomUUID() });
    const pending = await colleagues.invita(admin, { id: 'second', email: 'pending@amr.invalid', operazione: crypto.randomUUID() });
    const dump = creaDumpPostgres({ binario: '/usr/bin/pg_dump', ambiente: { PGDATABASE: 'postgres' }, maxBytes: MAX,
      spawnProcesso: (_bin, args, options) => spawn('docker', ['--host', host, 'exec', names.source, 'pg_dump',
        '-U', 'postgres', '-d', 'postgres', ...args], options) });
    receipt.fase = 'backup';
    for (const r of Object.values(repo)) await r.inizializza();
    assert.notEqual(await repo.database.identita(), await repo.journal.identita());
    const baseline = await dump();
    try { await repo.database.copia(baseline, 'database'); }
    finally { baseline.fill(0); }
    await business.accetta(people.first, first.token, crypto.randomUUID());
    await business.attiva(admin, { id: 'first', operazione: crypto.randomUUID() });
    await colleagues.accetta(people.colleague, { token: colleague.token, operazione: crypto.randomUUID() });
    await business.rinnova(admin, { id: 'second', operazione: crypto.randomUUID() });
    await colleagues.revocaInvito(admin, { id: 'second', invito: pending.invito, operazione: crypto.randomUUID() });
    await colleagues.revoca(admin, { id: 'second', persona: people.colleague, operazione: crypto.randomUUID() });
    await business.revocaAzienda(admin, { id: 'first', operazione: crypto.randomUUID() });
    const expected = await readBusiness(source);
    // Il worker usa il suo ruolo limitato, non i privilegi del fixture owner.
    const backupClient = await source.connect();
    try {
      await backupClient.query('SET ROLE amr_backup_esecutore');
      worker = creaBackupPostgres({ pool: backupClient, repositoryJournal: repo.journal,
        repositoryDatabase: repo.database, dumpDatabase: dump, batch: 32 });
      const drained = await worker.drain();
      assert.equal(drained.ok, true); assert.equal(drained.fallite, 0);
    } finally {
      try { await worker?.stop(); }
      finally { backupClient.release(true); }
    }
    const status = await creaStatoBackup({ pool: writer }).stato(admin);
    assert.equal(status.configurato, true); assert.equal(status.journal.pending, 0);
    assert.equal(status.journal.stato, 'confermato'); assert.equal(status.database.stato, 'confermato');
    receipt.prove.push('outbox_e_stato_admin_confermati');
    for (const r of Object.values(repo)) await r.verifica();
    // La selezione deve funzionare senza outbox né ricevute come indice.
    // Fermare soltanto il source nuovo di questa esecuzione, non gli stack Auth.
    receipt.fase = 'source_indisponibile';
    writer.release(true); writer = undefined;
    await source.end(); pools.splice(pools.indexOf(source), 1);
    await docker(['stop', '--time', '10', names.source]);
    assert.equal((await docker(['inspect', '--format', '{{.State.Running}}', names.source])).toString().trim(), 'false');
    await assert.rejects(source.query('SELECT 1'));
    receipt.prove.push('source_spento_prima_del_recovery');
    receipt.fase = 'discovery_repository';
    const dumps = (await repo.database.elenca('database')).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    assert.equal(dumps.length, 2);
    // Si sceglie il dump più vecchio SOLO per provare il replay successivo.
    // In recovery operativa l'operatore dovrà scegliere un ID esatto validato.
    assert.ok(Date.parse(dumps[0].time) < Date.parse(dumps[1].time));
    const plan = await preparaJournalDaRepository({ repository: repo.journal });
    assert.equal(plan.journals.length, 13);
    receipt.discovery = { dump: dumps.length, journal: plan.journals.length,
      snapshot_journal: plan.snapshot, duplicati: plan.duplicati, solo_repository: true };
    receipt.prove.push('indice_da_repository_senza_outbox');
    receipt.fase = 'restore';
    const restoreAndRead = async (category, snapshot, filename) => {
      const dir = await repo[category].ripristina(snapshot, directory);
      fs.chmodSync(dir, 0o700);
      const file = path.join(dir, filename); fs.chmodSync(file, 0o600);
      const bytes = fs.readFileSync(file), saved = receipt.copie.find(c => c.snapshot === snapshot);
      assert.equal(bytes.length, saved.bytes); assert.equal(sha(bytes), saved.sha256);
      return bytes;
    };
    receipt.fase = 'restore_integrita_dump';
    const restored = await restoreAndRead('database', dumps[0].id, 'database.dump');
    receipt.fase = 'restore_ruoli';
    for (const role of ROLES) {
      const inherit = ['amr_accessi_lettore', 'amr_gateway', 'amr_commerciale', 'amr_copie'].includes(role) ? 'INHERIT' : 'NOINHERIT';
      await recovery.query('CREATE ROLE ' + role + ' NOLOGIN ' + inherit + ' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    }
    await recovery.query('GRANT amr_colleghi_scrittore TO amr_aziende_scrittore WITH INHERIT TRUE');
    await recovery.query('GRANT amr_accessi_lettore TO amr_gateway WITH INHERIT TRUE, SET FALSE;'
      + 'GRANT amr_aziende_scrittore, amr_colleghi_scrittore TO amr_commerciale WITH INHERIT TRUE, SET FALSE;'
      + 'GRANT amr_backup_esecutore TO amr_copie WITH INHERIT TRUE, SET FALSE');
    receipt.fase = 'restore_postgres';
    try { await docker(['exec', '-i', names.restore, 'pg_restore', '-U', 'postgres', '-d', 'postgres',
      '--exit-on-error', '--single-transaction'], restored); }
    finally { restored.fill(0); }
    // La funzione di finalizzazione è già nel dump del pacchetto completo.
    assert.notDeepEqual(await readBusiness(recovery), expected);
    receipt.fase = 'restore_journal';
    const journals = plan.journals;
    const client = await recovery.connect();
    try {
      // Senza l'accettazione iniziale, un journal successivo non deve inventare l'identità.
      receipt.fase = 'replay_journal_mancante';
      await assert.rejects(applicaJournalOrdinati({ client, journals: [journals.at(-1)] }),
        { codice: 'ripristino_accettazione_mancante' });
      receipt.fase = 'replay_ordinato';
      const applied = await applicaJournalOrdinati({ client, journals: [...journals].reverse() });
      assert.ok(applied.every(r => !r.giaEseguita));
      assert.equal(applied.filter(r => r.stato === 'applicato').length, 7);
      assert.equal(applied.filter(r => r.stato === 'superato').length, 6);
      receipt.fase = 'replay_equivalenza';
      const actual = await readBusiness(client);
      receipt.differenze = Object.fromEntries(Object.keys(expected).map(table => [table,
        [...new Set(expected[table].flatMap((row, i) => Object.keys(row).filter(field =>
          JSON.stringify(row[field]) !== JSON.stringify(actual[table][i]?.[field]))))],
      ]).filter(([table, fields]) => fields.length || expected[table].length !== actual[table].length));
      assert.deepEqual(actual, expected);
      receipt.fase = 'replay_idempotenza';
      assert.ok((await applicaJournalOrdinati({ client, journals })).every(r => r.giaEseguita));
      assert.deepEqual(await readBusiness(client), expected);
      receipt.prove.push('journal_mancante_blocca', 'replay_ordinato_equivalente', 'replay_idempotente', 'revoche_preservate');
      receipt.fase = 'accessi_restore';
      const previousEpoch = (await client.query('SELECT epoca FROM amr_accessi.persone WHERE id=$1', [people.admin])).rows[0].epoca;
      assert.equal((await client.query('SELECT count(*)::int n FROM auth.refresh_tokens')).rows[0].n, 1);
      await client.query('SELECT amr_backup.invalida_accessi_ripristinati()');
      assert.equal((await client.query('SELECT count(*)::int n FROM auth.refresh_tokens')).rows[0].n, 0);
      assert.equal((await client.query('SELECT epoca FROM amr_accessi.persone WHERE id=$1', [people.admin])).rows[0].epoca, previousEpoch + 1);
      receipt.fase = 'permessi_restore';
      const roles = (await client.query("SELECT rolname,rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname LIKE 'amr_%'")).rows;
      assert.equal(roles.length, ROLES.length); assert.ok(roles.every(r => !r.rolcanlogin && !r.rolsuper && !r.rolbypassrls));
      await client.query('SET ROLE amr_commerciale');
      await assert.rejects(client.query('SELECT * FROM auth.users'), { code: '42501' });
      await assert.rejects(client.query('SELECT * FROM amr_backup.outbox'), { code: '42501' });
      await assert.rejects(client.query('SELECT amr_accessi.aziende_elenco($1,$2,true)', [people.admin, previousEpoch]),
        e => e.code === 'P0001' && e.message === 'sessione_revocata');
      assert.equal((await client.query('SELECT amr_accessi.aziende_elenco($1,$2,true) AS risultato',
        [people.admin, previousEpoch + 1])).rows.length, 1);
      assert.equal((await creaStatoBackup({ pool: client }).stato({ ...admin, epoca: previousEpoch + 1 })).configurato, false);
      await client.query('RESET ROLE');
      receipt.prove.push('accessi_pre_restore_invalidati', 'permessi_web_preservati');
    } finally { client.release(true); }
    receipt.retention = {};
    for (const category of ['database', 'journal']) {
      const snapshot = receipt.copie.findLast(c => c.categoria === category).snapshot;
      receipt.retention[category] = await repo[category].retention(category, { snapshot });
      assert.equal(receipt.retention[category].eliminate, 0);
    }
    receipt.ok = true; receipt.fase = 'completato';
  } catch (e) {
    failure = e;
    receipt.errore = { codice: e?.codice, docker_code: e?.dockerCode, azione: e?.azione, motivo: e?.motivo,
      asserzione: e?.code === 'ERR_ASSERTION' || undefined,
      stato_sql: /^[0-9A-Z]{5}$/.test(e?.code || '') ? e.code : undefined };
  }
  finally {
    receipt.cleanup = true;
    try { await worker?.stop(); } catch { receipt.cleanup = false; }
    // Client esclusivo della fixture: distruggerlo evita un RESET ROLE fallito
    // e impedisce di restituire al pool una connessione con il ruolo di prova.
    if (writer) writer.release(true);
    const closed = await Promise.allSettled(pools.map(pool => pool.end()));
    if (closed.some(r => r.status === 'rejected')) receipt.cleanup = false;
    // Si eliminano soltanto risorse nuove con l'etichetta di questa esecuzione.
    for (const name of created) {
      try {
        const owner = (await docker(['inspect', '--format', '{{ index .Config.Labels "amr.collaudo" }}', name])).toString().trim();
        assert.equal(owner, id); await docker(['rm', '-f', '-v', name]);
      } catch (e) { if (!e.assente) receipt.cleanup = false; }
    }
    if (networkAttempted) try {
      const owner = (await docker(['network', 'inspect', '--format', '{{ index .Labels "amr.collaudo" }}', names.rete])).toString().trim();
      assert.equal(owner, id); await docker(['network', 'rm', names.rete]);
    } catch (e) { if (!e.assente) receipt.cleanup = false; }
    receipt.ok = receipt.ok && receipt.cleanup;
    receipt.concluso_il = new Date().toISOString();
    fs.writeFileSync(path.join(directory, 'esito.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  // Nessun raw errore SQL, stderr o stack: possono includere configurazione o payload.
  if (failure || !receipt.cleanup) throw Object.assign(new Error('collaudo_non_confermato'),
    { fase: receipt.fase, directory, codice: failure?.codice });
  return { directory, ...receipt };
}

if (require.main === module) {
  collauda({ host: process.env.AMR_TEST_BACKUP_DOCKER_HOST, restic: process.env.AMR_TEST_RESTIC,
    impronta: process.env.AMR_TEST_RESTIC_SHA256, credenziali: process.env.AMR_TEST_R2_ENV })
    .then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(JSON.stringify({ ok: false, errore: 'collaudo_non_confermato',
      fase: e.fase, codice: e.codice, directory: e.directory })); process.exitCode = 1; });
}
module.exports = { collauda, leggiCredenziali, validaConfigurazione };
