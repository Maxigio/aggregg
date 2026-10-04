'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), https = require('node:https');
const express = require('express');
const { mount } = require('../backend/nodi/login-nhost-prova');

function certificato(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-https-sintetico-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=amr.invalid\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:amr.invalid\n');
  require('node:child_process').execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-days', '1', '-config', config, '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')],
  { stdio: 'ignore', timeout: 10000 });
  fs.chmodSync(path.join(dir, 'key.pem'), 0o600);
  return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
}

async function setup(t, { tls, proxyAttendibili = [], origine = 'https://amr.invalid', trasporto } = {}) {
  const app = express();
  let server, auth, numero = 0, mfa = false;
  t.after(async () => {
    auth?.close(); server?.closeAllConnections();
    if (server?.listening) await new Promise(r => server.close(r));
  });
  server = tls ? https.createServer(tls, app) : http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const session = () => ({ session: { user: { id: 'anna', emailVerified: true }, accessToken: 'access-' + ++numero, refreshToken: 'refresh-' + numero } });
  auth = mount(app, { origine, ...(trasporto ? { trasporto } : { proxyAttendibili }), cookiePath: '/', identita: async () => ({ attiva: true, epoca: 0 }),
    client: { login: async () => mfa ? { mfa: { ticket: 'ticket-sintetico' } } : session(), mfa: async () => session(), logout: async () => {} } });
  const raw = (route, body, cookie, extra = {}, ca = tls?.cert) => new Promise((resolve, reject) => {
    const r = (tls ? https : http).request({ hostname: '127.0.0.1', port: server.address().port,
      ca, path: '/api/auth/' + route, method: body === undefined ? 'GET' : 'POST',
      headers: { host: new URL(origine).host, ...(body === undefined ? {} : { origin: origine, 'content-type': 'application/json' }),
        ...(cookie ? { cookie } : {}), ...extra } }, res => {
      let raw = ''; res.setEncoding('utf8'); res.on('data', b => { raw += b; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw, json: () => JSON.parse(raw) }));
    });
    r.on('error', reject); r.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const req = async (route, body, cookie, extra, ca) => {
    const r = await raw(route, body, cookie, extra, ca);
    return ['login', 'mfa'].includes(route) ? require('./nodi-auth-finalizza.cjs').finalizza(r,
      conferma => raw('finalizza', { conferma }, cookie, extra, ca)) : r;
  };
  const login = async (cookies, extra) => {
    const bootstrap = await req('bootstrap', {login:true}, cookies, extra);
    const contesto = (cookies || '').split(';').map(v => v.trim()).find(v => v.startsWith('amr_accesso_prova='))
      || cookie(bootstrap);
    const r = await req('login', { email: 'anna@amr.invalid', password: 'password-sintetica', tentativo: bootstrap.status===200 ? bootstrap.json().tentativo : undefined },
      [cookies, cookie(bootstrap)].filter(Boolean).join('; '), extra);
    r.cookieContesto = contesto;
    return r;
  };
  return { req, login, auth, setMfa: () => { mfa = true; } };
}
const cookie = r => (r.headers['set-cookie'] || []).map(v => v.split(';')[0]).filter(v => !v.endsWith('=')).join('; ');

test('HTTPS TLS reale sintetico: cookie Secure su sessione/MFA/clear, rotte proprie e restart fail closed', async t => {
  const tls = certificato(t), f = await setup(t, { tls });
  await assert.rejects(f.req('me', undefined, undefined, {}, null), e => e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
  const r = await f.login(); assert.equal(r.status, 200);
  for (const h of r.headers['set-cookie']) { assert.match(h, /; Secure/); assert.match(h, /; HttpOnly/); assert.match(h, /SameSite=Strict/); }
  assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
  const c = r.cookieContesto + '; ' + cookie(r);
  const lista = await f.req('sessioni', undefined, c); assert.equal(lista.status, 200);
  assert.equal(lista.json().sessioni.length, 1);
  const revoca = await f.req('sessioni/revoca', { id: lista.json().sessioni[0].id }, c);
  assert.equal(revoca.status, 200); assert.equal(revoca.json().provider.stato, 'pending');
  assert.match(revoca.headers['set-cookie'].join(';'), /amr_sessione_prova=;/);
  for (const h of revoca.headers['set-cookie']) assert.match(h, /; Secure/);
  const stato = await f.req('logout/stato', { id: revoca.json().provider.id }, c);
  assert.equal(stato.json().provider.stato, 'confirmed'); assert.equal(stato.headers['set-cookie'], undefined);
  assert.equal((await f.req('me', undefined, c)).status, 401);
  f.setMfa(); const challenge = await f.login();
  assert.match(challenge.headers['set-cookie'].find(v => v.startsWith('amr_mfa_prova=')), /; Secure/);
  const finale = await f.req('mfa', { otp: '123456' }, challenge.cookieContesto + '; ' + cookie(challenge)); assert.equal(finale.status, 200);
  for (const h of finale.headers['set-cookie']) assert.match(h, /; Secure/);
  const precedente = cookie(finale); f.auth.close();
  const nuovo = await setup(t, { tls });
  assert.equal((await nuovo.req('me', undefined, precedente)).status, 401);
  assert.equal((await nuovo.req('sessioni', undefined, precedente)).status, 401);
});

test('HTTPS da proxy esplicito: Host/Origin/protocollo negati prima di login e revoca, niente cookie su rifiuto', async t => {
  const f = await setup(t, { trasporto: { origine: 'https://amr.invalid', proxyAttendibili: ['127.0.0.1'] } });
  for (const extra of [{}, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' },
    { 'x-forwarded-proto': 'https', host: 'evil.invalid' }, { 'x-forwarded-proto': 'https', origin: 'https://evil.invalid' }, { 'x-forwarded-proto': 'https', origin: '' }]) {
    const r = await f.login(undefined, extra); assert.equal(r.status, 403); assert.equal(r.headers['set-cookie'], undefined);
  }
  const viaProxy = { 'x-forwarded-proto': 'https' };
  const r = await f.login(undefined, viaProxy); assert.equal(r.status, 200);
  for (const h of r.headers['set-cookie']) assert.match(h, /; Secure/);
  const c = r.cookieContesto + '; ' + cookie(r), lista = await f.req('sessioni', undefined, c, viaProxy); assert.equal(lista.status, 200);
  const id = lista.json().sessioni[0].id;
  assert.equal((await f.req('sessioni/revoca', { id }, c, { ...viaProxy, origin: '' })).status, 403);
  assert.equal((await f.req('me', undefined, c, viaProxy)).status, 200);
  const revoca = await f.req('sessioni/revoca', { id }, c, viaProxy); assert.equal(revoca.status, 200);
  assert.equal((await f.req('me', undefined, c, viaProxy)).status, 401);
  const nonTrusted = await setup(t);
  assert.equal((await nonTrusted.login(undefined, viaProxy)).status, 403);
});

test('guard HTTPS aziende/colleghi/backup indipendenti da login: proxy, Origin e Host prima del dominio', async t => {
  for (const trusted of [true, false]) {
    const app = express(), server = http.createServer(app), chiamate = [];
    let colleghi, aziende;
    t.after(async () => { colleghi?.close(); aziende?.close(); server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r)); });
    const trasporto = { origine: 'https://amr.invalid', proxyAttendibili: trusted ? ['127.0.0.1'] : [] };
    const accessi = { sessione: () => ({ persona: 'sintetica', epoca: 0, mfa: true }),
      verifica: async () => { chiamate.push('verifica'); return { admin: true }; } };
    const elenco = async () => { chiamate.push('elenco'); return { aziende: [], colleghi: [] }; };
    aziende = require('../backend/nodi/aziende-prova-route').mount(app, { trasporto, accessi, account: { elenco } });
    colleghi = require('../backend/nodi/colleghi-prova-route').mount(app, { trasporto, accessi, account: { elenco } });
    require('../backend/nodi/backup-prova-route').mount(app, { trasporto, accessi, backup: {
      riprova: async () => { chiamate.push('riprova'); return { ok: true }; } } });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    async function request(route, method, extra = {}) {
      return new Promise((resolve, reject) => {
        const headers = { host: 'amr.invalid', 'x-forwarded-proto': 'https', 'content-type': 'application/json', origin: trasporto.origine, ...extra };
        if (headers.origin === null) delete headers.origin;
        const r = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/auth/' + route, method, headers }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        });
        r.on('error', reject); r.end(method === 'POST' ? '{}' : undefined);
      });
    }
    for (const [route, method] of [['aziende/elenco', 'GET'], ['colleghi/elenco', 'POST'], ['backup/riprova', 'POST']]) {
      for (const extra of [{ origin: 'https://evil.invalid' }, { host: 'evil.invalid' }, { 'x-forwarded-proto': 'http' }, { 'x-forwarded-proto': 'https,http' }]) {
        const prima = chiamate.length;
        assert.equal(await request(route, method, extra), 403);
        assert.equal(chiamate.length, prima);
      }
      if (method === 'POST') {
        const prima = chiamate.length;
        assert.equal(await request(route, method, { origin: '' }), 403);
        assert.equal(await request(route, method, { origin: null }), 403);
        assert.equal(chiamate.length, prima);
      }
      const prima = chiamate.length;
      assert.equal(await request(route, method), trusted ? 200 : 403);
      assert.equal(chiamate.length > prima, trusted);
    }
  }
});
