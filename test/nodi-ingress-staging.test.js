'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const https = require('node:https'), http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { collaudaIngress } = require('../scripts/nhost/collauda-ingress-staging');
const SENTINELLA = 'dato-riservato-sintetico-NON-STAMPARE';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ingress-prova-'));
  const cnf = path.join(directory, 'tls.cnf'), key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  fs.writeFileSync(cnf, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', cnf, '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 });
  fs.chmodSync(key, 0o600);
  let centro, auth, backend, modo = '', origine, chiamate = 0;
  const richieste = [];
  const tls = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  const server = https.createServer(tls, (req, res) => {
    richieste.push({ url: req.url, cookie: req.headers.cookie, body: '' });
    const traccia = richieste.at(-1); req.on('data', b => { traccia.body += b; });
    if (modo === 'attesa') return;
    if (modo === 'redirect') { res.writeHead(302, { location: origine + '/secondo?' + SENTINELLA }); return res.end(SENTINELLA); }
    if (modo === 'body_grande') { res.writeHead(200); return res.end('x'.repeat(65537) + SENTINELLA); }
    if (modo === 'header_grande') { res.writeHead(200, { 'x-sintetico': 'x'.repeat(17000) + SENTINELLA }); return res.end('ok'); }
    if (modo === 'interrotto') { res.writeHead(200, { 'content-length': '10000' }); res.write(SENTINELLA); return setImmediate(() => res.destroy()); }
    const headers = { ...req.headers };
    for (const k of Object.keys(headers)) if (k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-')) delete headers[k];
    headers['x-forwarded-proto'] = 'https';
    if (modo === 'origin_ignorata') headers.origin = origine;
    if (modo === 'falso404' && req.url === '/api/test/config') { res.writeHead(404); return res.end(SENTINELLA); }
    const upstream = http.request({ hostname: '127.0.0.1', port: backend.address().port,
      method: req.method, path: req.url, headers, agent: false }, r => {
      const h = { ...r.headers };
      if (modo.startsWith('hsts:')) h['strict-transport-security'] = modo.slice(5);
      if (req.url === '/api/auth/bootstrap' && r.statusCode === 200) {
        if (modo === 'cookie_non_secure') h['set-cookie'] = h['set-cookie'].map(v => v.replace(/; Secure/g, ''));
        if (modo === 'cookie_duplicato') h['set-cookie'].push(h['set-cookie'][0]);
        if (modo === 'cookie_domain') h['set-cookie'] = h['set-cookie'].map(v => v + '; Domain=estranea.invalid');
        if (modo === 'cookie_personale') h['set-cookie'] = ['persona=' + SENTINELLA + '; Secure; HttpOnly; Path=/; SameSite=Strict'];
      }
      res.writeHead(r.statusCode, h); r.on('error', () => res.destroy()); r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); }); req.pipe(upstream);
  });
  t.after(async () => {
    auth?.close(); centro?.close();
    for (const s of [server, backend]) { s?.closeAllConnections(); if (s?.listening) await new Promise(r => s.close(r)); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
  origine = 'https://127.0.0.1:' + server.address().port;
  const trasporto = { origine, proxyAttendibili: ['127.0.0.1'] };
  centro = require('../backend/nodi/centro').creaCentro({ directory: path.join(directory, 'centro'),
    compatibilita: { protocollo: 1, release: 'b'.repeat(40), codice: 'c'.repeat(64), cataloghi: 'd'.repeat(64) },
    tokens: { sintetico: 'a'.repeat(64) }, trasporto,
    inizializzaAccessi: app => (auth = require('../backend/nodi/login-nhost-prova').mount(app, {
      origine, trasporto, cookiePath: '/', identita: async () => { chiamate++; throw new Error(SENTINELLA); },
      client: Object.fromEntries(['login', 'mfa', 'logout'].map(k => [k, async () => { chiamate++; throw new Error(SENTINELLA); }])),
    })) });
  backend = http.createServer(centro.app);
  await new Promise((r, j) => { backend.once('error', j); backend.listen(0, '127.0.0.1', r); });
  return { origine, ca: tls.cert, cert, richieste, chiamate: () => chiamate,
    contaLavori: () => {
      const db = new (require('node:sqlite').DatabaseSync)(path.join(directory, 'centro/lavori-prototipo.db'), { readOnly: true });
      try { return db.prepare('SELECT count(*) AS n FROM lavori').get().n; } finally { db.close(); }
    },
    modo: value => { modo = value; richieste.length = 0; } };
}

test('ingress: percorso HTTPS reale con centro e guard esistenti; niente login, annunci o cookie reinviati', async t => {
  const f = await fixture(t), esito = await collaudaIngress(f);
  assert.equal(esito.ok, true, JSON.stringify(esito));
  assert.equal(esito.controlli.length, 16); assert.equal(f.richieste.length, 16);
  assert.ok(f.richieste.every(r => r.cookie === undefined)); assert.equal(f.chiamate(), 0);
  assert.equal(f.contaLavori(), 0);
  assert.equal(f.richieste.filter(r => r.url === '/api/auth/bootstrap').every(r => r.body === '{}'), true);
  assert.ok(esito.nonVerificati.includes('peer_proxy')); assert.ok(esito.nonVerificati.includes('ricerche'));
  assert.doesNotMatch(JSON.stringify(esito), /amr_accesso_prova|set-cookie|SENTINELLA/);
});

test('ingress: HSTS non accetta interi parziali, disattivazione o direttive duplicate', async t => {
  const f = await fixture(t);
  for (const hsts of ['max-age=1.5', 'max-age=0; max-age=31536000', 'max-age=0',
    'max-age=31536000; includeSubDomains; includeSubDomains', 'max-age=31536000xxx']) {
    f.modo('hsts:' + hsts); const r = await collaudaIngress(f);
    assert.equal(r.ok, false, hsts); assert.equal(r.controlli.at(-1).nome, 'modalita_nhost');
  }
  for (const hsts of ['max-age=31536000', 'max-age="31536000"; includeSubDomains; preload']) {
    f.modo('hsts:' + hsts); assert.equal((await collaudaIngress(f)).ok, true, hsts);
  }
});

test('ingress: rifiuta configurazioni implicite, HTTP, credenziali o URL applicative prima della rete', async () => {
  for (const origine of [undefined, 'http://127.0.0.1:3000', 'https://utente:segreto@amr.invalid',
    'https://amr.invalid/', 'https://amr.invalid/api', 'https://amr.invalid?token=sintetico', 'https://amr.invalid#x']) {
    await assert.rejects(collaudaIngress({ origine }), /origine_non_valida/);
  }
  await assert.rejects(collaudaIngress({ origine: 'https://amr.invalid', timeoutMs: 0 }), /limiti_non_validi/);
  await assert.rejects(collaudaIngress({ origine: 'https://amr.invalid', totaleMs: 60001 }), /limiti_non_validi/);
});

test('ingress: certificate non fidato fallisce; redirect non seguito, niente raw nel report', async t => {
  const f = await fixture(t);
  const tls = await collaudaIngress({ origine: f.origine });
  assert.equal(tls.ok, false); assert.equal(tls.controlli[0].codice, 'tls_non_valido');
  assert.equal(f.richieste.length, 0);
  f.modo('redirect'); const r = await collaudaIngress(f);
  assert.equal(r.ok, false); assert.equal(r.controlli[0].status, 302);
  assert.equal(f.richieste.length, 1); assert.doesNotMatch(JSON.stringify(r), new RegExp(SENTINELLA));
});

test('ingress: falso 404, cookie deboli/duplicati e Origin ignorata sono failure, non PASS', async t => {
  const f = await fixture(t);
  for (const [modo, nome] of [['falso404', 'modalita_nhost'], ['cookie_non_secure', 'cookie_bootstrap'],
    ['cookie_duplicato', 'cookie_bootstrap'], ['cookie_domain', 'cookie_bootstrap'],
    ['cookie_personale', 'cookie_bootstrap'], ['origin_ignorata', 'origine_assente']]) {
    f.modo(modo); const esito = await collaudaIngress(f);
    assert.equal(esito.ok, false, modo); assert.equal(esito.controlli.at(-1).nome, nome, modo);
    assert.equal(esito.controlli.at(-1).codice, 'risposta_inattesa');
    assert.equal(f.richieste.length, esito.controlli.length); assert.equal(f.chiamate(), 0);
    assert.doesNotMatch(JSON.stringify(esito), new RegExp(SENTINELLA));
  }
});

test('ingress: body/header limitati e risposta interrotta non diventano una prova riuscita', async t => {
  const f = await fixture(t);
  for (const [modo, codice] of [['body_grande', 'risposta_troppo_grande'],
    ['header_grande', 'header_troppo_grandi'], ['interrotto', 'risposta_interrotta']]) {
    f.modo(modo); const r = await collaudaIngress(f);
    assert.equal(r.ok, false); assert.equal(r.controlli[0].codice, codice);
    assert.equal(f.richieste.length, 1); assert.doesNotMatch(JSON.stringify(r), new RegExp(SENTINELLA));
  }
});

test('ingress: deadline reale e interruzione chiudono la richiesta senza retry', async t => {
  const f = await fixture(t); f.modo('attesa');
  const r = await collaudaIngress({ ...f, timeoutMs: 150 });
  assert.equal(r.ok, false); assert.equal(r.controlli[0].codice, 'timeout');
  assert.equal(f.richieste.length, 1); assert.ok(r.durataMs < 2000);
  f.modo('attesa');
  const totale = await collaudaIngress({ ...f, timeoutMs: 1000, totaleMs: 150 });
  assert.equal(totale.controlli[0].codice, 'timeout'); assert.ok(totale.durataMs < 2000);
  f.modo('attesa'); const controller = new AbortController(); controller.abort(new Error(SENTINELLA));
  const annullato = await collaudaIngress({ ...f, signal: controller.signal });
  assert.equal(annullato.controlli[0].codice, 'interrotto'); assert.equal(f.richieste.length, 0);
  assert.doesNotMatch(JSON.stringify(annullato), new RegExp(SENTINELLA));
});

test('ingress CLI: output allowlisted e exit failure, senza caricare env o stampare sentinelle', async t => {
  const f = await fixture(t); f.modo('cookie_personale');
  const script = path.join(__dirname, '../scripts/nhost/collauda-ingress-staging.js');
  let errore;
  try { await promisify(execFile)(process.execPath, [script, '--origine', f.origine],
    { env: { PATH: process.env.PATH, HOME: '/private/tmp', NODE_EXTRA_CA_CERTS: f.cert }, timeout: 10000 }); }
  catch (e) { errore = e; }
  assert.equal(errore?.code, 1); assert.equal(errore.stderr, '');
  assert.doesNotMatch(errore.stdout, new RegExp(SENTINELLA)); assert.doesNotMatch(errore.stdout, /amr_accesso_prova|set-cookie/);
  assert.equal(JSON.parse(errore.stdout).controlli.at(-1).nome, 'cookie_bootstrap');
  try { await promisify(execFile)(process.execPath, [script, '--origine', 'https://utente:' + SENTINELLA + '@amr.invalid'],
    { env: { PATH: process.env.PATH, HOME: '/private/tmp' }, timeout: 5000 }); }
  catch (e) { assert.equal(e.code, 1); assert.doesNotMatch(e.stdout + e.stderr, new RegExp(SENTINELLA)); }
});
