'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const crypto = require('node:crypto'), http = require('node:http');
const { execFileSync } = require('node:child_process');
const { Pool } = require('pg');
const { FILES } = require('../scripts/nhost/prepara-schema-staging');
const root = path.resolve(__dirname, '..');
const host = process.env.AMR_TEST_REFERENTE_DOCKER_HOST;
const image = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';

// Opt-in: un solo container nuovo, immagine già presente, porta solo loopback.
// Mai leggere .env, usare il cluster manuale o fermare container altrui.
test('referente PG18: sessioni precedenti, rollback, concorrenza e journal',
  { skip: !host && 'Impostare AMR_TEST_REFERENTE_DOCKER_HOST', timeout: 60000 }, async t => {
    assert.match(host, /^unix:\/\/.*\/amr-auth\/docker\.sock$/);
    const name = 'amr-referente-prova-' + crypto.randomBytes(6).toString('hex');
    const docker = (args, input) => {
      try { return execFileSync('docker', ['--host', host, ...args], {
        input, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
      catch { throw new Error('fixture_postgres_non_disponibile'); }
    };
    const estranei = () => docker(['ps', '--format', '{{.ID}}']).split('\n').filter(Boolean).sort();
    const prima = estranei(), pools = [];
    let tentato = false, centro, server, directory;
    t.after(async () => {
      try {
        centro?.close();
        if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
        await Promise.all(pools.map(p => p.end()));
      } finally {
        try {
          if (tentato) {
            // Un timeout di run non prova che il daemon non abbia creato la fixture.
            try { docker(['rm', '-f', name]); } catch {
              assert.equal(docker(['ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.ID}}']), '');
            }
          }
          assert.deepEqual(estranei(), prima, 'container estranei modificati');
        } finally {
          if (directory) {
            assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
            fs.rmSync(directory, { recursive: true });
          }
        }
      }
    });
    tentato = true;
    docker(['run', '--pull=never', '--rm', '-d', '--name', name,
      '--memory', '512m', '--cpus', '1', '--tmpfs', '/var/lib/postgresql:rw,nosuid,size=256m',
      '-p', '127.0.0.1::5432', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image]);
    let pronta = false;
    for (let n = 0; n < 100 && !pronta; n++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); pronta = true; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.equal(pronta, true);
    const porta = docker(['port', name, '5432/tcp']); assert.match(porta, /^127\.0\.0\.1:\d+$/);
    const config = { host: '127.0.0.1', port: Number(porta.split(':')[1]), database: 'postgres',
      max: 4, statement_timeout: 3000, lock_timeout: 2000, connectionTimeoutMillis: 2000 };
    const pool = user => { const p = new Pool({ ...config, user }); pools.push(p); return p; };
    const sql = pool('postgres');
    await sql.query(`CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text UNIQUE NOT NULL,
        email_verified boolean NOT NULL DEFAULT true,disabled boolean NOT NULL DEFAULT false,
        password_hash text,locale varchar(3) NOT NULL DEFAULT 'en');`);
    for (const file of FILES.filter(f => !f.endsWith('/schema-referente-sessioni.sql'))) {
      await sql.query(fs.readFileSync(path.join(root, file), 'utf8'));
    }
    await sql.query(`CREATE ROLE prova_reader LOGIN IN ROLE amr_accessi_lettore;
      CREATE ROLE prova_writer LOGIN IN ROLE amr_aziende_scrittore;`);
    const writer = pool('prova_writer'), reader = pool('prova_reader');
    const account = require('../backend/nodi/aziende-postgres-prova').creaAziendePostgres({ pool: writer });
    const identita = require('../backend/nodi/accessi-postgres-prova').creaAccessiPostgres({ pool: reader });
    async function persona(email, admin = false) {
      const id = crypto.randomUUID();
      await sql.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [id, email]);
      await sql.query('INSERT INTO amr_accessi.persone(id,admin,epoca) VALUES($1,$2,$3)', [id, admin, admin ? 0 : 3]);
      return id;
    }
    const owner = await persona('admin@amr.invalid', true);
    const manager = { persona: owner, epoca: 0, mfa: true };
    await persona('prima@amr.invalid'); const seconda = await persona('seconda@amr.invalid');
    server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
    const origine = 'http://127.0.0.1:' + server.address().port;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-referente-pg-'));
    const nodoToken = crypto.randomBytes(32).toString('hex');
    const client = { login: async email => ({ session: { user: {
      id: (await sql.query('SELECT id FROM auth.users WHERE email=$1', [email])).rows[0].id,
      emailVerified: true }, accessToken: crypto.randomUUID(), refreshToken: crypto.randomUUID() } }),
      logout: async () => ({}) };
    centro = require('../backend/nodi/centro').creaCentro({ directory, tokens: { prova: nodoToken },
      inizializzaAccessi: app => require('../backend/nodi/login-nhost-prova').mount(app,
        { origine, cookiePath: '/', identita, client }) });
    server.on('request', centro.app);
    const call = (url, body, cookie) => fetch(origine + url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin: origine, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    function cookies(response, precedente = '') {
      const map = new Map(precedente.split(';').map(s => s.trim().split('=')).filter(([k]) => k));
      for (const value of response.headers.getSetCookie()) {
        const [k, v] = value.split(';')[0].split('='); if (v) map.set(k, v); else map.delete(k);
      }
      return [...map].map(([k, v]) => k + '=' + v).join('; ');
    }
    async function login(email) {
      const b = await call('/api/auth/bootstrap', { login: true }), jar = cookies(b);
      const l = await call('/api/auth/login', { email, password: 'password-sintetica', tentativo: (await b.json()).tentativo }, jar);
      assert.equal(l.status, 200);
      const f = await call('/api/auth/finalizza', { conferma: (await l.json()).conferma }, jar);
      assert.equal(f.status, 200); return cookies(f, jar);
    }
    async function invita(id, email) {
      return account.invita(manager, { id, email, nome: 'Azienda sintetica', moduli: ['moto'], operazione: crypto.randomUUID() });
    }
    const vecchia = await login('prima@amr.invalid'), primaInvito = await invita('prima', 'prima@amr.invalid');
    const primaPersona = (await sql.query('SELECT id FROM auth.users WHERE email=$1', ['prima@amr.invalid'])).rows[0].id;
    await account.accetta(primaPersona, primaInvito.token);
    assert.equal((await call('/api/auth/me', undefined, vecchia)).status, 200, 'baseline: sessione non invalidata');
    await sql.query(fs.readFileSync(path.join(root, 'backend/nodi/schema-referente-sessioni.sql'), 'utf8'));
    const primaMigrazione = await identita(primaPersona);
    assert.equal(primaMigrazione.epoca, 3, 'migrazione non modifica dati preesistenti');
    const cookie = await login('seconda@amr.invalid'), invito = await invita('seconda', 'seconda@amr.invalid');
    const transazione = await writer.connect();
    try {
      await transazione.query('BEGIN');
      await require('../backend/nodi/aziende-postgres-prova').creaAziendePostgres({ pool: transazione }).accetta(seconda, invito.token);
      await transazione.query('ROLLBACK');
    } finally { transazione.release(); }
    assert.equal((await identita(seconda)).epoca, 3, 'rollback non cambia epoca');
    assert.equal((await call('/api/auth/me', undefined, cookie)).status, 200);
    const primo = await writer.connect(), secondo = await writer.connect();
    try {
      await primo.query('BEGIN');
      await require('../backend/nodi/aziende-postgres-prova').creaAziendePostgres({pool: primo}).accetta(seconda, invito.token);
      const pid = (await primo.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const altro = (await secondo.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const inAttesa = require('../backend/nodi/aziende-postgres-prova').creaAziendePostgres({pool: secondo})
        .accetta(seconda, invito.token).catch(e => e);
      let bloccato = false;
      for (let n = 0; n < 100 && !bloccato; n++) {
        bloccato = (await sql.query('SELECT $1 = ANY(pg_blocking_pids($2)) ok', [pid, altro])).rows[0].ok;
        if (!bloccato) await new Promise(r => setTimeout(r, 10));
      }
      assert.equal(bloccato, true, 'contesa SQL non osservata');
      await primo.query('COMMIT');
      assert.equal((await inAttesa).codice, 'invito_non_valido');
    } finally {
      await primo.query('ROLLBACK'); primo.release(); secondo.release();
    }
    assert.equal((await identita(seconda)).epoca, 4, 'una sola invalidazione');
    assert.equal((await call('/api/auth/me', undefined, cookie)).status, 403);
    assert.equal((await call('/api/ricerche', { id: crypto.randomUUID(), input: { tipo: 'moto', marca: 'Ducati' } }, cookie)).status, 403);
    await account.attiva(manager, { id: 'seconda', operazione: crypto.randomUUID() });
    const fresh = await login('seconda@amr.invalid');
    assert.equal((await call('/api/auth/me', undefined, fresh)).status, 200);
    const nodo = (verbo, body) => fetch(origine + '/_nodo/' + verbo, { method: body ? 'POST' : 'GET',
      headers: { 'x-amr-node-id': 'prova', 'x-amr-node-token': nodoToken, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ id: 'prova', ...body }) } : {}) });
    assert.equal((await nodo('heartbeat', { revisione: 'imac-1', occupato: false,
      fonti: { subito: { fermo: false }, autoscout: { fermo: false }, moto: { fermo: false } } })).status, 200);
    const ricerca = crypto.randomUUID();
    assert.equal((await call('/api/ricerche', { id: ricerca, input: { tipo: 'moto', marca: 'Ducati' } }, fresh)).status, 202);
    let job;
    for (let n = 0; n < 100 && !job; n++) {
      const r = await nodo('poll?id=prova'); if (r.status === 200) job = await r.json(); else await new Promise(r => setTimeout(r, 5));
    }
    assert.ok(job);
    await nodo('esito', { idLavoro: job.idLavoro, tentativo: job.tentativo, esito: { status: 200,
      body: { risultati: [], sources: { subito: { status: 'empty' }, autoscout: { status: 'empty' }, moto: { status: 'empty' } } } } });
    const esito = await (await call('/api/ricerche/' + ricerca, undefined, fresh)).json();
    assert.equal(esito.esito.status, 200);
    const journal = (await sql.query("SELECT journal FROM amr_backup.outbox WHERE journal->>'tipo'='accetta' AND journal->'azienda'->>'id'='seconda'")).rows;
    assert.equal(journal.length, 1); assert.equal(journal[0].journal.persone.find(p => p.id === seconda).epoca, 4);
    assert.equal((await sql.query("SELECT has_function_privilege('public','amr_accessi.aziende_accetta(uuid,text)','EXECUTE') ok")).rows[0].ok, false);
    await assert.rejects(writer.query('SELECT * FROM amr_accessi.persone'), { code: '42501' });
    t.diagnostic('PG reale, Auth e nodo sintetici: baseline, rollback, epoch e ricerca HTTP dopo nuovo login; nessun portale');
    // Solo il DB della fixture corrente: rendere vuoto il dominio prima del
    // collaudo colleghi consente di riusare tutte le sue prove con la migrazione.
    await sql.query(`BEGIN; DELETE FROM amr_backup.outbox;
      DELETE FROM amr_accessi.membri; DELETE FROM amr_accessi.aziende_operazioni;
      DELETE FROM amr_accessi.aziende_inviti; DELETE FROM amr_accessi.aziende; COMMIT;`);
    const risultati = await require('./nodi-colleghi-pg.test').provaColleghiPostgres({
      sql: q => sql.query(q), pool: writer, identita });
    for (const risultato of risultati) t.diagnostic(risultato);
  });
