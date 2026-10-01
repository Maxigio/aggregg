'use strict';

// Esperimento esplicito: nessun import del server AMR, nessun caricamento del suo .env.
// Il collaudo manuale legge soltanto il file dedicato; quello automatico genera dati sintetici.
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

function configura({ password, jwt, admin, encryption, postgresDiretto = false }) {
  return { services: {
    postgres: { image: IMMAGINI.postgres, ...(postgresDiretto ? { ports: ['127.0.0.1:0:5432'] } : {}), environment: { POSTGRES_PASSWORD: password },
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

const ENV_COLLAUDO = path.join(__dirname, '../.env.collaudo-nhost');
function credenzialiLocali(file = ENV_COLLAUDO) {
  let config;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) throw new Error();
    if (process.platform !== 'win32' && (stat.mode & 0o077)) {
      throw Object.assign(new Error(), { permessi: true });
    }
    // parse non modifica process.env e non interpreta il file come comandi shell.
    config = require('dotenv').parse(fs.readFileSync(file));
  } catch (e) {
    throw new Error(e.permessi ? 'Il file del collaudo richiede permessi 600'
      : 'File .env del collaudo assente o non leggibile');
  }
  if (Object.keys(config).some(k => !['AMR_COLLAUDO_EMAIL', 'AMR_COLLAUDO_PASSWORD'].includes(k))) {
    throw new Error('Il file del collaudo ammette soltanto email e password dedicate');
  }
  const email = config.AMR_COLLAUDO_EMAIL, password = config.AMR_COLLAUDO_PASSWORD;
  if (typeof email !== 'string' || email.length > 254
      || !/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    throw new Error('Configura AMR_COLLAUDO_EMAIL nel file dedicato');
  }
  if (typeof password !== 'string' || password.length < 15 || password.length > 50
      || Buffer.byteLength(password) > 72 || /[\r\n\0]/.test(password)) {
    throw new Error('Configura AMR_COLLAUDO_PASSWORD: 15–50 caratteri, massimo 72 byte, una sola riga');
  }
  return { email, password };
}

async function collauda({ manuale = false } = {}) {
  const host = process.env.AMR_NHOST_DOCKER_HOST;
  if (!host?.startsWith('unix:///') || !host.includes('/amr-auth/')) {
    throw new Error('Impostare AMR_NHOST_DOCKER_HOST sul socket del profilo isolato amr-auth');
  }
  const credenziali = manuale ? credenzialiLocali() : null;
  const password = credenziali?.password ?? crypto.randomBytes(20).toString('hex');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-nhost-locale-'));
  fs.chmodSync(directory, 0o700);
  const file = path.join(directory, 'compose.json');
  const progetto = 'amr-auth-' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(file, JSON.stringify(configura({ password: crypto.randomBytes(32).toString('hex'), postgresDiretto: true,
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
  let serverLogin, loginProva, centro, pool;
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
        if (manuale) throw new Error('Auth terminato durante avvio');
        const raw = await docker('logs', '--no-color', 'auth');
        const righe = raw.split('\n').filter(r => /error|failed/i.test(r) && !r.includes('"flags"'));
        diagnosi = righe.slice(-2).join(' ').replace(/[a-f0-9]{32,}/gi, '[omesso]');
        throw new Error('Auth terminato durante avvio');
      }
      if (i >= 60) throw new Error('Auth non pronto');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    fase = 'registrazione sintetica';
    const email = credenziali ? credenziali.email : `persona-${crypto.randomBytes(4).toString('hex')}@amr.invalid`;
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
    const hashInfo = await sql(`SELECT length(password_hash)::text || ':' || left(password_hash,7)
      FROM auth.users WHERE id='${preMfa.user.id}';`);
    assert.match(hashInfo, /^60:\$2[aby]\$10\$$/);
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
    fase = 'verifica JWT precedente';
    const oldToken = await chiama('/token/verify', { token: preMfa.accessToken });
    if (oldToken.status !== 200) {
      const messaggio = typeof oldToken.data?.message === 'string' ? oldToken.data.message.toLowerCase() : '';
      diagnosi += ' · byte richiesta ' + Buffer.byteLength(JSON.stringify({ token: preMfa.accessToken }))
        + ' · indizi: ' + ['body','payload','schema','token','header','size','length','required','maximum','signature','json'].filter(k => messaggio.includes(k)).join(',');
    }
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
    await sql(fs.readFileSync(path.join(__dirname, '../backend/nodi/schema-accessi-prova.sql'), 'utf8'));
    await sql(`INSERT INTO amr_accessi.persone(id,admin) VALUES ('${preMfa.user.id}',true);`);
    const readerPassword = crypto.randomBytes(32).toString('hex');
    await sql(`CREATE ROLE amr_gateway LOGIN PASSWORD '${readerPassword}' IN ROLE amr_accessi_lettore;`);
    const pgAddress = await docker('port', 'postgres', '5432');
    assert.match(pgAddress, /^127\.0\.0\.1:\d+$/);
    pool = new (require('pg').Pool)({ host: '127.0.0.1', port: Number(pgAddress.split(':')[1]),
      user: 'amr_gateway', password: readerPassword, database: 'postgres', max: 4,
      connectionTimeoutMillis: 2000, query_timeout: 3000 });
    pool.on('error', () => {});
    const identita = require('../backend/nodi/accessi-postgres-prova').creaAccessiPostgres({ pool });
    assert.equal((await identita(preMfa.user.id)).admin, true);
    await assert.rejects(pool.query('SELECT * FROM auth.users'));
    await assert.rejects(pool.query('SELECT * FROM amr_accessi.persone'));
    risultati.push('Ruolo PostgreSQL del centro: legge solo la funzione dei permessi, nessun accesso a utenti/hash/tabelle');
    serverLogin = require('node:http').createServer();
    await new Promise(resolve => serverLogin.listen(0, '127.0.0.1', resolve));
    const origineLogin = 'http://127.0.0.1:' + serverLogin.address().port;
    const authClient = require('../backend/nodi/nhost-auth-client').creaClient({ base });
    const nodeToken = crypto.randomBytes(32).toString('hex');
    let prepara = manuale;
    centro = require('../backend/nodi/centro').creaCentro({ tokens: { locale: nodeToken },
      directory: path.join(directory, 'centro'), adminLocale: true,
      inizializzaAccessi: app => {
        loginProva = require('../backend/nodi/login-nhost-prova').mount(app, {
          client: authClient, origine: origineLogin, identita, cookiePath: '/',
        });
        // Solo fixture manuale loopback: il segreto sintetico è visibile nel browser,
        // mai nella console. Questa pagina scompare dopo la preparazione.
        if (manuale) {
          const qr = require('qrcode-generator')(0, 'M');
          qr.addData('otpauth://totp/' + encodeURIComponent('AMR collaudo:' + email)
            + '?secret=' + encodeURIComponent(generated.data.totpSecret)
            + '&issuer=' + encodeURIComponent('AMR collaudo') + '&algorithm=SHA1&digits=6&period=30');
          qr.make();
          app.get('/api/auth/prepara', (req, res) => {
            if (!prepara) return res.redirect(303, '/api/auth/pagina');
            res.set('Content-Security-Policy', res.get('Content-Security-Policy') + '; img-src data:');
            res.type('html').send('<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
              + '<title>Preparazione locale</title><link rel="stylesheet" href="/api/auth/pagina.css"></head><body><main>'
              + '<h1>Account locale di collaudo</h1><p>Email: ' + email + '</p>'
              + '<p>La password è quella configurata nel file dedicato.</p>'
              + '<p>Nella tua app autenticatore aggiungi un account e scansiona questo QR:</p>'
              + '<img src="' + qr.createDataURL(4) + '" alt="QR per configurare l’autenticatore">'
              + '<p>In alternativa, inserisci manualmente questo segreto:</p><code>'
              + generated.data.totpSecret + '</code><p>Inserimento manuale: TOTP, 6 cifre, SHA1, 30 secondi.</p>'
              + '<p>Verifica che l’app generi un codice a sei cifre prima di chiudere questa pagina.</p>'
              + '<form method="post" action="/api/auth/prepara/chiudi"><label><input type="checkbox" name="conferma" value="si" required> Ho salvato l’account nell’autenticatore</label>'
              + '<button>Conferma e apri login</button></form>'
              + '<p>Account e database sono temporanei: terminando questo processo vengono eliminati.</p></main></body></html>');
          });
          app.post('/api/auth/prepara/chiudi', require('express').urlencoded({ limit: '1kb' }), (req, res) => {
            if (req.body?.conferma !== 'si') return res.redirect(303, '/api/auth/prepara');
            prepara = false; res.redirect(303, '/api/auth/pagina');
          });
        }
        return loginProva;
      } });
    serverLogin.on('request', centro.app);
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
    fase = 'autorizzazioni reali nel centro';
    const req = (route, cookie, method = 'GET', body) => fetch(origineLogin + route, {
      method, headers: { ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { origin: origineLogin, 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    assert.equal((await req('/api/test/login', null, 'POST', { azienda: 'aziendaA' })).status, 404);
    assert.equal((await req('/api/admin')).status, 401);
    const ownerLogin = await richiestaLogin('login', { email, password });
    assert.equal(ownerLogin.status, 200);
    const ownerMfaCookie = ownerLogin.headers.getSetCookie().find(v => v.startsWith('amr_mfa_prova=')).split(';')[0];
    const ownerMfa = await richiestaLogin('mfa', { otp: totp(generated.data.totpSecret) }, ownerMfaCookie);
    assert.equal(ownerMfa.status, 200);
    const ownerCookie = ownerMfa.headers.getSetCookie().find(v => v.startsWith('amr_sessione_prova=')).split(';')[0];
    assert.equal((await req('/api/admin', ownerCookie)).status, 200);
    // L'admin non ottiene automaticamente una licenza aziendale.
    assert.equal((await req('/api/search?tipo=moto&marca=Yamaha', ownerCookie)).status, 403);
    await richiestaLogin('logout', {}, ownerCookie);
    const registraCliente = async suffisso => {
      const e = `cliente-${suffisso}-${crypto.randomBytes(4).toString('hex')}@amr.invalid`;
      const p = crypto.randomBytes(20).toString('hex');
      assert.equal((await chiama('/signup/email-password', { email: e, password: p })).status, 200);
      let m;
      for (let i = 0; i < 40 && !m; i++) {
        const elenco = await (await fetch(`http://${mailAddress}/api/v2/messages`, { signal: AbortSignal.timeout(3000) })).json();
        m = elenco.items?.find(v => v.Raw.To.includes(e));
        if (!m) await new Promise(r => setTimeout(r, 100));
      }
      assert.ok(m);
      const html = m.Content.Body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h,16)));
      const ticket = html.match(/ticket=([^&\s"<>]+)/)?.[1]; assert.ok(ticket);
      const v = await fetch(base + '/verify?ticket=' + ticket + '&redirectTo=' + encodeURIComponent('http://127.0.0.1:3000'), { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      assert.ok([200,302,303,307].includes(v.status));
      const auth = await chiama('/signin/email-password', { email: e, password: p });
      assert.equal(auth.status, 200);
      const id = auth.data.session.user.id;
      await sql(`INSERT INTO amr_accessi.persone(id) VALUES ('${id}');
        INSERT INTO amr_accessi.aziende(id,scadenza,moduli) VALUES ('${suffisso}',now()+interval '1 day',
          ARRAY[${suffisso === 'A' ? "'auto','moto'" : "'moto'"}]);
        INSERT INTO amr_accessi.membri VALUES ('${id}','${suffisso}');`);
      const r = await richiestaLogin('login', { email: e, password: p });
      assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
      return { id, cookie: r.headers.getSetCookie().find(v => v.startsWith('amr_sessione_prova=')).split(';')[0] };
    };
    const a = await registraCliente('A'), b = await registraCliente('B');
    assert.equal((await req('/api/search?tipo=auto&marca=Fiat', b.cookie)).status, 403);
    assert.equal((await req('/api/admin', a.cookie)).status, 403);
    assert.equal(centro.lavori.size, 0);
    const node = (route, method = 'GET', body) => fetch(origineLogin + route, { method,
      headers: { 'x-amr-node-id': 'locale', 'x-amr-node-token': nodeToken,
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify({ id: 'locale', ...body }) } : {}), signal: AbortSignal.timeout(15000) });
    const hb = async () => assert.equal((await node('/_nodo/heartbeat','POST', {
      revisione: 'imac-1', occupato: false, simulato: false, fonti: { subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false} }
    })).status, 200);
    const attendiJob = async () => {
      for (let i = 0; i < 100 && !centro.lavori.size; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(centro.lavori.size, 1);
    };
    const poll = async () => { await hb(); const r = await node('/_nodo/poll?id=locale'); assert.equal(r.status,200); return r.json(); };
    const risposta = { risultati:[{id:'sintetico',fonte:'subito',url:'https://www.subito.it/moto/sintetico.htm'}],
      sources:{subito:{status:'ok',count:1},autoscout:{status:'empty',count:0},moto:{status:'empty',count:0}},totale:1 };
    const consegna = async job => assert.equal((await node('/_nodo/esito','POST', {
      idLavoro:job.idLavoro,tentativo:job.tentativo,esito:{status:200,body:risposta}
    })).status,200);
    const cerca = cookie => req('/api/search?tipo=moto&marca=Yamaha&modello=MT-07',cookie);
    const interrotto = async r => {
      assert.equal(r.status,403); const x=await r.json(); assert.equal(x.interrotto,true); assert.ok(!('risultati' in x));
    };
    await hb();
    const riuscita = cerca(a.cookie); await attendiJob(); await consegna(await poll());
    assert.equal((await riuscita).status,200);
    const accodata = cerca(a.cookie); await attendiJob();
    await sql("UPDATE amr_accessi.aziende SET scadenza=now()-interval '1 second' WHERE id='A';");
    assert.equal((await node('/_nodo/poll?id=locale')).status,204); await interrotto(await accodata);
    await sql("UPDATE amr_accessi.aziende SET scadenza=now()+interval '1 day' WHERE id='A';");
    const condivisaA = cerca(a.cookie); await attendiJob(); const condivisaB = cerca(b.cookie);
    for(let i=0;i<100;i++) {
      if (centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n) break;
      await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n,1);
    const job=await poll();
    await sql(`UPDATE amr_accessi.persone SET epoca=epoca+1 WHERE id='${a.id}';`);
    await consegna(job); await interrotto(await condivisaA);
    assert.equal((await condivisaB).status,200);
    assert.equal(centro.lavori.size,0);
    await assert.rejects(sql(`INSERT INTO amr_accessi.membri VALUES ('${b.id}','A');`));
    risultati.push('Centro reale: login sintetico escluso; admin MFA; moduli separati; scadenza in coda e revoca in volo senza annunci; ricerca condivisa consegnata solo al destinatario autorizzato');
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
    console.log('Collaudo locale completato: login Nhost e permessi PostgreSQL collegati al centro.');
    if (manuale) {
      console.log('Preparazione account: ' + origineLogin + '/api/auth/prepara');
      console.log('Il processo resta aperto. Ctrl+C elimina account, database e container sintetici.');
      await new Promise(resolve => {
        const chiudi = () => { process.off('SIGINT', chiudi); process.off('SIGTERM', chiudi); resolve(); };
        process.once('SIGINT', chiudi); process.once('SIGTERM', chiudi);
      });
    }
  } catch (e) {
    // Non stampare Error/stdout/stderr: potrebbero includere token o password sintetiche.
    if (!manuale && fase === 'registrazione sintetica') {
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
    const punto = /collauda-nhost-locale\.js:\d+:\d+/.exec(e.stack || '')?.[0] || '';
    const confronto = typeof e.actual === 'number' && typeof e.expected === 'number'
      ? ` · ricevuto ${e.actual}, atteso ${e.expected}` : '';
    throw new Error('Collaudo interrotto nella fase: ' + fase + (punto ? ' · ' + punto : '') + confronto + (diagnosi ? ' · ' + diagnosi : ''));
  } finally {
    if (centro) centro.close(); else loginProva?.close();
    await pool?.end();
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

if (require.main === module) collauda({ manuale: process.argv.includes('--manuale') }).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { configura, IMMAGINI, totp, credenzialiLocali };
