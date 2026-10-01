'use strict';

// Esperimento esplicito: nessun import del server AMR, nessun dotenv, nessun cloud.
// Le credenziali sintetiche esistono solo in RAM e nel compose temporaneo 0600.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const esegui = promisify(execFile);
const IMMAGINI = Object.freeze({
  postgres: 'postgres:16@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54',
  auth: 'nhost/auth:0.49.1@sha256:3365cb4c3f50018f88cb723133bd498a15a7975d8d7644ab199613360bb15976',
  graphql: 'nhost/graphql-engine:v2.46.0-ce@sha256:bfc3e5fd51e87f99dc0894976f16c14165d9c0fbd1fe503a3ebfbaf02600fed0',
  mail: 'jcalonso/mailhog:v1.0.1@sha256:f35c05c5e7bd005020a7865838c198c0fcb2ce1a64c5497c4c9c72dec5050cc9',
});

function configura({ password, jwt, admin, encryption }) {
  return { services: {
    postgres: { image: IMMAGINI.postgres, environment: { POSTGRES_PASSWORD: password },
      tmpfs: ['/var/lib/postgresql/data'], healthcheck: {
        test: ['CMD-SHELL', 'pg_isready -U postgres'], interval: '2s', timeout: '2s', retries: 40 } },
    graphql: { image: IMMAGINI.graphql, depends_on: { postgres: { condition: 'service_healthy' } },
      environment: { HASURA_GRAPHQL_DATABASE_URL: `postgres://postgres:${password}@postgres:5432/postgres`,
        HASURA_GRAPHQL_ADMIN_SECRET: admin, HASURA_GRAPHQL_JWT_SECRET: jwt,
        HASURA_GRAPHQL_ENABLE_TELEMETRY: 'false', HASURA_GRAPHQL_LOG_LEVEL: 'error' } },
    mail: { image: IMMAGINI.mail, ports: ['127.0.0.1:0:8025', '127.0.0.1:0:4000'] },
    auth: { image: IMMAGINI.auth, depends_on: { postgres: { condition: 'service_healthy' },
      graphql: { condition: 'service_healthy' }, mail: { condition: 'service_started' } },
      // Il client SMTP Nhost permette il test senza TLS solo su loopback:
      // condividere la rete del Mailhog evita di disattivare quel controllo.
      network_mode: 'service:mail', environment: {
        AUTH_HOST: '0.0.0.0', AUTH_PORT: '4000', AUTH_API_PREFIX: '/v1',
        AUTH_SERVER_URL: 'http://127.0.0.1:4000/v1', AUTH_CLIENT_URL: 'http://127.0.0.1:3000',
        AUTH_ANONYMOUS_USERS_ENABLED: 'false', AUTH_EMAIL_PASSWORDLESS_ENABLED: 'false',
        AUTH_EMAIL_SIGNIN_EMAIL_VERIFIED_REQUIRED: 'true', AUTH_GRAVATAR_ENABLED: 'false',
        AUTH_MFA_ENABLED: 'true', AUTH_MFA_TOTP_ISSUER: 'AMR collaudo',
        AUTH_ENCRYPTION_KEY: encryption,
        AUTH_PASSWORD_MIN_LENGTH: '15', AUTH_PASSWORD_HIBP_ENABLED: 'false',
        AUTH_ACCESS_TOKEN_EXPIRES_IN: '900', AUTH_REFRESH_TOKEN_EXPIRES_IN: '3600',
        AUTH_USER_DEFAULT_ALLOWED_ROLES: 'user,me', AUTH_USER_DEFAULT_ROLE: 'user',
        AUTH_SMTP_HOST: 'localhost', AUTH_SMTP_PORT: '1025', AUTH_SMTP_SECURE: 'false',
        AUTH_SMTP_AUTH_METHOD: 'LOGIN', AUTH_SMTP_USER: 'collaudo', AUTH_SMTP_PASS: 'collaudo',
        AUTH_SMTP_SENDER: 'collaudo@amr.invalid', AUTH_RATE_LIMIT_ENABLE: 'true',
        // Budget della fixture: verifica molti login nello stesso giro, non policy cloud.
        AUTH_RATE_LIMIT_BRUTE_FORCE_BURST: '30', AUTH_RATE_LIMIT_BRUTE_FORCE_INTERVAL: '5m',
        HASURA_GRAPHQL_ADMIN_SECRET: admin, HASURA_GRAPHQL_JWT_SECRET: jwt,
        HASURA_GRAPHQL_GRAPHQL_URL: 'http://graphql:8080/v1/graphql',
        HASURA_GRAPHQL_DATABASE_URL: `postgres://postgres:${password}@postgres:5432/postgres`,
        POSTGRES_MIGRATIONS_CONNECTION: `postgres://postgres:${password}@postgres:5432/postgres`,
      } },
  } };
}

// TOTP soltanto per il test: non diventa un autenticatore o codice di login AMR.
function totp(secret, adesso = Date.now()) {
  const alfabeto = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret.replace(/=+$/, '').toUpperCase()]
    .map(c => { const n = alfabeto.indexOf(c); assert.ok(n >= 0); return n.toString(2).padStart(5, '0'); }).join('');
  const key = Buffer.from(bits.match(/.{8}/g).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(adesso / 30000)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

async function collauda() {
  const host = process.env.AMR_NHOST_DOCKER_HOST;
  if (!host?.startsWith('unix:///') || !host.includes('/amr-auth/')) {
    throw new Error('Impostare AMR_NHOST_DOCKER_HOST sul socket del profilo isolato amr-auth');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-nhost-locale-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'compose.json');
  const progetto = 'amr-auth-' + crypto.randomBytes(6).toString('hex');
  const password = crypto.randomBytes(20).toString('hex');
  fs.writeFileSync(file, JSON.stringify(configura({ password: crypto.randomBytes(32).toString('hex'),
    jwt: JSON.stringify({ type: 'HS256', key: crypto.randomBytes(32).toString('hex') }),
    admin: crypto.randomBytes(32).toString('hex'),
    encryption: crypto.randomBytes(32).toString('hex') })), { mode: 0o600 });
  // Il daemon è esplicito; il contesto Docker globale e quello CRM non cambiano.
  const args = ['--host', host, 'compose', '--project-name', progetto, '-f', file];
  const docker = async (...extra) => (await esegui('docker', [...args, ...extra],
    { timeout: 600000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  const sql = async testo => {
    const child = require('node:child_process').spawn('docker', [...args, 'exec', '-T', 'postgres',
      'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', b => { out += b; });
    // Gli errori SQL possono contenere dati: il test registra solo l'esito.
    child.stderr.resume(); child.stdin.on('error', () => {}); child.stdin.end(testo);
    const timer = setTimeout(() => child.kill(), 20000);
    return new Promise((resolve, reject) => {
      child.on('error', () => { clearTimeout(timer); reject(new Error('psql non avviato')); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim())
        : reject(new Error('verifica PostgreSQL fallita')); });
    });
  };
  let fase = 'avvio';
  const risultati = [];
  let diagnosi = '';
  let serverLogin, loginProva;
  try {
    await docker('up', '-d', '--wait', 'postgres', 'mail');
    await sql('CREATE SCHEMA auth;');
    const authAddress = await docker('port', 'mail', '4000');
    const mailAddress = await docker('port', 'mail', '8025');
    assert.match(authAddress, /^127\.0\.0\.1:\d+$/);
    assert.match(mailAddress, /^127\.0\.0\.1:\d+$/);
    const base = `http://${authAddress}/v1`;
    const compose = JSON.parse(fs.readFileSync(file, 'utf8'));
    compose.services.auth.environment.AUTH_SERVER_URL = base;
    fs.writeFileSync(file, JSON.stringify(compose), { mode: 0o600 });
    await docker('up', '-d');
    const chiama = async (endpoint, body, token) => {
      const r = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
      const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
      diagnosi = 'HTTP ' + r.status + (typeof data?.error === 'string'
        ? ' · ' + data.error.replace(/[^a-z0-9_-]/gi, '') : '');
      return { status: r.status, data };
    };
    fase = 'disponibilità Auth';
    for (let i = 0; ; i++) {
      try { if ((await fetch(`http://${authAddress}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) break; }
      catch {}
      const stato = JSON.parse(await docker('ps', '-a', '--format', 'json', 'auth'));
      if (stato.State === 'exited') {
        const raw = await docker('logs', '--no-color', 'auth');
        const righe = raw.split('\n').filter(r => /error|failed/i.test(r) && !r.includes('"flags"'));
        diagnosi = righe.slice(-2).join(' ').replace(/[a-f0-9]{32,}/gi, '[omesso]');
        throw new Error('Auth terminato durante avvio');
      }
      if (i >= 60) throw new Error('Auth non pronto');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    fase = 'registrazione sintetica';
    const email = `persona-${crypto.randomBytes(4).toString('hex')}@amr.invalid`;
    const signup = await chiama('/signup/email-password', { email, password });
    diagnosi = 'HTTP ' + signup.status + (typeof signup.data?.error === 'string'
      ? ' · ' + signup.data.error.replace(/[^a-z0-9_-]/gi, '') : '');
    assert.equal(signup.status, 200);
    diagnosi = ''; fase = 'login prima della verifica';
    const denied = await chiama('/signin/email-password', { email, password });
    assert.ok(denied.status >= 400);
    // Mail locale: nessun messaggio inviato a un destinatario o SMTP reale.
    fase = 'mail locale'; let messages;
    for (let i = 0; i < 20; i++) {
      messages = await (await fetch(`http://${mailAddress}/api/v2/messages`, { signal: AbortSignal.timeout(3000) })).json();
      if (messages.items?.length) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(messages.items?.length);
    const mail = messages.items[0].Content.Body.replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    assert.ok(mail.includes(base + '/verify'));
    const match = mail.match(/ticket=([^&\s"<>]+)/); assert.ok(match);
    fase = 'conferma email';
    const verify = await fetch(base + '/verify?ticket=' + match[1]
      + '&redirectTo=' + encodeURIComponent('http://127.0.0.1:3000'),
      { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    diagnosi = 'HTTP ' + verify.status;
    assert.ok([200, 302, 303, 307].includes(verify.status));
    diagnosi = '';
    fase = 'login dopo la verifica';
    const signin = await chiama('/signin/email-password', { email, password });
    assert.equal(signin.status, 200); assert.ok(signin.data?.session?.accessToken);
    const preMfa = signin.data.session;
    assert.equal(preMfa.user.emailVerified, true);
    risultati.push('Email: login negato prima della verifica; consentito dopo verifica della mail locale');

    fase = 'hash password';
    const hashInfo = await sql(`SELECT (password_hash <> '${password}')::text || ':' || left(password_hash,7)
      FROM auth.users WHERE email='${email}';`);
    assert.match(hashInfo, /^true:\$2[aby]\$10\$$/);
    risultati.push('Password: hash bcrypt con costo 10, distinto dal segreto');

    fase = 'generazione segreto MFA';
    const generated = await chiama('/mfa/totp/generate', undefined, preMfa.accessToken);
    assert.equal(generated.status, 200); assert.ok(generated.data?.totpSecret);
    fase = 'attivazione MFA';
    const mfa = await chiama('/user/mfa', { activeMfaType: 'totp', code: totp(generated.data.totpSecret) }, preMfa.accessToken);
    assert.equal(mfa.status, 200);
    fase = 'login con MFA attiva';
    const challenge = await chiama('/signin/email-password', { email, password });
    assert.equal(challenge.status, 200); assert.ok(challenge.data?.mfa?.ticket); assert.ok(!challenge.data.session);
    fase = 'MFA codice errato';
    const codiceAttuale = totp(generated.data.totpSecret);
    const codiceErrato = String((Number(codiceAttuale) + 500000) % 1000000).padStart(6, '0');
    const bad = await chiama('/signin/mfa/totp', { ticket: challenge.data.mfa.ticket, otp: codiceErrato });
    assert.ok(bad.status >= 400);
    const ticketConsumato = await chiama('/signin/mfa/totp', {
      ticket: challenge.data.mfa.ticket, otp: totp(generated.data.totpSecret) });
    assert.equal(ticketConsumato.status, 401);
    assert.equal(ticketConsumato.data?.error, 'invalid-ticket');
    // Il ticket è consumato anche se il codice è errato: il retry riparte dal login.
    const nuovoChallenge = await chiama('/signin/email-password', { email, password });
    assert.equal(nuovoChallenge.status, 200); assert.ok(nuovoChallenge.data?.mfa?.ticket);
    fase = 'MFA codice valido';
    const verified = await chiama('/signin/mfa/totp', { ticket: nuovoChallenge.data.mfa.ticket, otp: totp(generated.data.totpSecret) });
    assert.equal(verified.status, 200); assert.ok(verified.data?.session?.accessToken);
    risultati.push('MFA: ticket senza sessione, codice errato negato, TOTP valido completa il login');
    const claims = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    // Decodifica per osservazione soltanto: non è verifica JWT né gate di accesso.
    const names = Object.keys(claims(verified.data.session.accessToken)).sort();
    risultati.push('Claim top-level osservati dopo MFA: ' + names.join(', '));
    assert.deepEqual(claims(preMfa.accessToken)['https://hasura.io/jwt/claims'],
      claims(verified.data.session.accessToken)['https://hasura.io/jwt/claims']);
    risultati.push('I claim Hasura sono identici prima/dopo MFA: nessuna attestazione della challenge osservata');
    const oldToken = await chiama('/token/verify', { token: preMfa.accessToken });
    assert.equal(oldToken.status, 200);
    risultati.push('JWT emesso prima di attivare MFA: verifica HTTP ' + oldToken.status);

    fase = 'logout e revoca';
    const session = verified.data.session;
    const signout = await chiama('/signout', { refreshToken: session.refreshToken }, session.accessToken);
    assert.equal(signout.status, 200);
    const refresh = await chiama('/token', { refreshToken: session.refreshToken });
    assert.ok(refresh.status >= 400);
    const stillValid = await chiama('/token/verify', { token: session.accessToken });
    assert.equal(stillValid.status, 200);
    risultati.push('Logout: refresh negato; verifica del precedente access JWT HTTP ' + stillValid.status);
    fase = 'pagina AMR e sessione server-side';
    const app = require('express')();
    serverLogin = await new Promise(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const origineLogin = 'http://127.0.0.1:' + serverLogin.address().port;
    const authClient = require('../backend/nodi/nhost-auth-client').creaClient({ base });
    const clientOsservato = { ...authClient, login: async (...input) => {
      try { return await authClient.login(...input); }
      catch (e) { diagnosi = e.tipoTrasporto || e.codice || 'errore'; throw e; }
    } };
    loginProva = require('../backend/nodi/login-nhost-prova').mount(app, {
      client: clientOsservato, origine: origineLogin,
      identita: async id => ({ attiva: id === preMfa.user.id, admin: true }),
    });
    const richiestaLogin = (endpoint, body, cookie) => fetch(origineLogin + '/api/auth/' + endpoint, {
      method: body === undefined ? 'GET' : 'POST', headers: {
        ...(body === undefined ? {} : { origin: origineLogin, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000) });
    const challengeAmr = await richiestaLogin('login', { email, password });
    fase = 'login AMR → Auth';
    diagnosi += ' · HTTP ' + challengeAmr.status + ' · ' + String((await challengeAmr.clone().json()).codice || 'esito senza errore');
    assert.equal(challengeAmr.status, 200); assert.deepEqual(await challengeAmr.json(), { mfa: true });
    const cookieMfa = challengeAmr.headers.getSetCookie().find(v => v.startsWith('amr_mfa_prova=')).split(';')[0];
    assert.equal((await richiestaLogin('me', undefined, cookieMfa)).status, 401);
    const mfaAmr = await richiestaLogin('mfa', { otp: totp(generated.data.totpSecret) }, cookieMfa);
    fase = 'MFA AMR → Auth';
    diagnosi = 'HTTP ' + mfaAmr.status + ' · ' + String((await mfaAmr.clone().json()).codice || 'esito senza errore');
    assert.equal(mfaAmr.status, 200); assert.deepEqual(await mfaAmr.json(), { ok: true });
    const cookieSessione = mfaAmr.headers.getSetCookie().find(v => v.startsWith('amr_sessione_prova=')).split(';')[0];
    assert.match(cookieSessione, /=([a-f0-9]{64})$/);
    assert.equal((await richiestaLogin('me', undefined, cookieSessione)).status, 200);
    const uscitaAmr = await richiestaLogin('logout', {}, cookieSessione);
    assert.equal(uscitaAmr.status, 200); assert.equal((await uscitaAmr.json()).providerRevocato, true);
    assert.equal((await richiestaLogin('me', undefined, cookieSessione)).status, 401);
    assert.equal((await richiestaLogin('pagina')).status, 200);
    risultati.push('AMR → Auth reale: challenge server, cookie opaco, sessione MFA; logout rende il cookie riusato non valido');
    fase = 'concorrenza PostgreSQL';
    await sql(fs.readFileSync(path.join(__dirname, '../test/fixtures/nhost-quote.sql'), 'utf8'));
    const esito = p => p.then(value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }));
    const attendiStato = async (nome, condizione) => {
      for (let i = 0; i < 40; i++) {
        if (await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${nome}' AND ${condizione};`) === '1') return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('sovrapposizione PostgreSQL non dimostrata');
    };
    const prima = esito(sql(`SET application_name='amr_quota_a'; BEGIN;
      SELECT 1 FROM amr_prova.aziende WHERE id=1 FOR UPDATE;
      SELECT pg_sleep(4); SELECT amr_prova.prenota('primo'); COMMIT;`));
    await attendiStato('amr_quota_a', "wait_event='PgSleep'");
    const seconda = esito(sql("SET application_name='amr_quota_b'; SELECT amr_prova.prenota('secondo');"));
    await attendiStato('amr_quota_b', "wait_event_type='Lock'");
    const concorrenti = await Promise.all([prima, seconda]);
    assert.equal(concorrenti.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(await sql('SELECT count(*) FROM amr_prova.inviti;'), '1');
    assert.equal(await sql('SELECT count(*) FROM amr_prova.membri;'), '2');
    await sql('INSERT INTO amr_prova.aziende VALUES (2);');
    await assert.rejects(sql("INSERT INTO amr_prova.membri VALUES ('collega',2);"));
    assert.equal(await sql('SELECT count(*) FROM amr_prova.membri;'), '2');
    await sql("SET ROLE amr_collaudo_senza_permessi; SELECT 1;");
    await assert.rejects(sql('SET ROLE amr_collaudo_senza_permessi; SELECT * FROM amr_prova.membri;'));
    risultati.push('PostgreSQL: attesa del lock osservata, un solo ultimo posto; appartenenza univoca e ruolo senza permessi negato');
    for (const r of risultati) console.log('OK · ' + r);
    console.log('Collaudo locale completato; nessuna integrazione del provider nel centro ancora attivata.');
  } catch (e) {
    // Non stampare Error/stdout/stderr: potrebbero includere token o password sintetiche.
    if (fase === 'registrazione sintetica') {
      const raw = await docker('logs', '--no-color', 'auth').catch(() => '');
      for (const line of raw.split('\n')) {
        const start = line.indexOf('{'); if (start < 0) continue;
        let entry; try { entry = JSON.parse(line.slice(start)); } catch { continue; }
        if (entry.level !== 'ERROR') continue;
        const safe = (String(entry.msg || '') + ' ' + String(entry.error || ''))
          .replace(/postgres:\/\/[^\s]+/g, '[connessione omessa]')
          .replace(/[a-f0-9]{32,}/gi, '[omesso]')
          .replace(/\$2[aby]\$[^\s"]+/g, '[hash omesso]')
          .replace(/eyJ[A-Za-z0-9_.-]+/g, '[token omesso]');
        diagnosi += ' · ' + safe.slice(0, 500);
      }
    }
    const confronto = typeof e.actual === 'number' && typeof e.expected === 'number'
      ? ` · ricevuto ${e.actual}, atteso ${e.expected}` : '';
    throw new Error('Collaudo interrotto nella fase: ' + fase + confronto + (diagnosi ? ' · ' + diagnosi : ''));
  } finally {
    loginProva?.close();
    if (serverLogin) {
      serverLogin.closeAllConnections();
      await new Promise(resolve => serverLogin.close(resolve));
    }
    try {
      await docker('down', '--volumes', '--remove-orphans');
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Conservare il compose protetto permette di riprovare la pulizia.
      console.error('Pulizia container non riuscita; configurazione protetta conservata: ' + directory);
    }
  }
}

if (require.main === module) collauda().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { configura, IMMAGINI, totp };
