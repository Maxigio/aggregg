'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { creaTrasporto } = require('../backend/nodi/trasporto-prova');
const { creaClient } = require('../backend/nodi/nhost-auth-client');

function valuta(trasporto, { method = 'POST', host = trasporto.host, origin = trasporto.origine,
  peer = '203.0.113.9', encrypted = false, headers = {}, rawHeaders, path = '/api/auth/login' } = {}) {
  let status = 200, ammesso = false;
  const risposta = {};
  const req = { method, path, headers: { host, ...(origin !== undefined ? { origin } : {}), ...headers },
    socket: { remoteAddress: peer, encrypted }, ip: '10.0.0.1', protocol: 'https', secure: true };
  req.rawHeaders = rawHeaders || Object.entries(req.headers).flatMap(([k, v]) => [k, v]);
  trasporto.middleware(req, { set: (k, v) => { risposta[k] = v; }, sendStatus: n => { status = n; } }, () => { ammesso = true; });
  return { status, ammesso, risposta };
}

test('trasporto: origine pubblica e proxy solo espliciti, configurazioni ambigue negate', () => {
  for (const origine of [undefined, '', 'http://amr.invalid', 'https://amr.invalid/', 'https://amr.invalid?q=1',
    'https://u:p@amr.invalid', 'https://amr.invalid#x', 'ftp://amr.invalid', 'http://localhost:5000']) {
    assert.throws(() => creaTrasporto({ origine }));
  }
  for (const proxyAttendibili of [true, 1, 'loopback', ['*'], ['10.0.0.0/8'], ['loopback'], ['fe80::1%eth0'], [null], Array(33).fill('127.0.0.1')]) {
    assert.throws(() => creaTrasporto({ origine: 'https://amr.invalid', proxyAttendibili }));
  }
  assert.throws(() => creaTrasporto({ origine: 'http://127.0.0.1:5000', proxyAttendibili: ['127.0.0.1'] }));
  assert.equal(creaTrasporto({ origine: 'https://amr.invalid' }).secure, true);
});

test('trasporto: HTTP loopback preservato, niente spoofing verso modalita pubblica', () => {
  const tr = creaTrasporto({ origine: 'http://127.0.0.1:5000' });
  for (const peer of ['127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(valuta(tr, { peer }).status, 200);
    assert.equal(valuta(tr, { peer, headers: { 'x-forwarded-proto': 'https' } }).status, 200);
  }
  assert.equal(tr.secure, false);
  assert.equal(valuta(tr, { peer: '127.0.0.1' }).risposta['Strict-Transport-Security'], undefined);
  for (const peer of ['203.0.113.1', '::1', '127.0.0.2']) {
    assert.equal(valuta(tr, { peer, headers: { 'x-forwarded-for': '127.0.0.1' } }).status, 403);
  }
  assert.equal(valuta(tr, { peer: '127.0.0.1', host: 'localhost:5000' }).status, 403);
});

test('trasporto: HTTPS diretto richiede socket TLS, proxy usa solo IP reale esplicito e protocollo singolo', () => {
  const diretto = creaTrasporto({ origine: 'https://amr.invalid' });
  assert.equal(valuta(diretto, { encrypted: true }).status, 200);
  assert.equal(valuta(diretto).status, 403);
  assert.equal(valuta(diretto, { headers: { 'x-forwarded-proto': 'https' } }).status, 403);
  assert.equal(valuta(diretto, { encrypted: true, headers: { 'x-forwarded-proto': 'https' } }).status, 403);
  const tr = creaTrasporto({ origine: 'https://amr.invalid', proxyAttendibili: ['10.0.0.1', '::1'] });
  for (const peer of ['10.0.0.1', '::ffff:10.0.0.1', '::ffff:a00:1', '::1', '0:0:0:0:0:0:0:1']) {
    assert.equal(valuta(tr, { peer, headers: { 'x-forwarded-proto': 'https' } }).status, 200);
    assert.equal(tr.trustProxy(peer), true);
  }
  for (const proto of [undefined, 'http', 'https,http', 'https, https', 'HTTPS']) {
    assert.equal(valuta(tr, { peer: '10.0.0.1', headers: { 'x-forwarded-proto': proto } }).status, 403);
  }
  assert.equal(valuta(tr, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '10.0.0.1' } }).status, 403);
  assert.equal(valuta(tr, { peer: '10.0.0.2', headers: { 'x-forwarded-proto': 'https' } }).status, 403);
});

test('trasporto: Host e Origin esatti, Forwarded-Host non autorizza, header duplicati negati', () => {
  const tr = creaTrasporto({ origine: 'https://amr.invalid:8443', proxyAttendibili: ['10.0.0.1'] });
  const input = { peer: '10.0.0.1', headers: { 'x-forwarded-proto': 'https' } };
  for (const host of ['amr.invalid', 'amr.invalid:8443.evil.invalid', 'evil.invalid', 'amr.invalid:443']) {
    assert.equal(valuta(tr, { ...input, host, headers: { ...input.headers, 'x-forwarded-host': tr.host } }).status, 403);
  }
  for (const origin of ['null', '', 'https://amr.invalid', 'https://amr.invalid:8443.evil.invalid', 'http://amr.invalid:8443']) {
    assert.equal(valuta(tr, { ...input, origin }).status, 403);
  }
  assert.equal(valuta(tr, { ...input, method: 'GET', headers: { ...input.headers, origin: undefined } }).status, 200);
  assert.equal(valuta(tr, { ...input, headers: { ...input.headers, origin: undefined } }).status, 403);
  for (const name of ['host', 'origin', 'x-forwarded-proto']) {
    assert.equal(valuta(tr, { ...input, rawHeaders: [name, 'valore', name, 'valore'] }).status, 403);
  }
});

test('client Nhost: HTTPS con origine Auth esplicita, prefissi fissi e segreti solo nel body/header server', async () => {
  for (const prefisso of ['', '/v1', '/v1/auth']) {
    const requests = [];
    const c = creaClient({ base: 'https://auth.amr.invalid' + prefisso, origineAuth: 'https://auth.amr.invalid',
      richiesta: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({ ok: true }) }; } });
    await c.login('anna@amr.invalid', 'password-sintetica');
    await c.mfa('ticket-sintetico', '123456');
    await c.logout({ accessToken: 'access-sintetico', refreshToken: 'refresh-sintetico' });
    await c.registra('anna@amr.invalid', 'password-sintetica', 'https://amr.invalid/account');
    await c.reinviaVerifica('anna@amr.invalid', 'https://amr.invalid/account');
    assert.equal(requests.length, 5);
    assert.equal(requests[0].url, 'https://auth.amr.invalid' + prefisso + '/signin/email-password');
    assert.equal(requests[2].url, 'https://auth.amr.invalid' + prefisso + '/signout');
    assert.equal(requests[2].options.headers.authorization, 'Bearer access-sintetico');
    assert.deepEqual(JSON.parse(requests[2].options.body), { refreshToken: 'refresh-sintetico' });
    for (const r of requests) { assert.equal(r.options.redirect, 'error'); assert.ok(r.options.signal); assert.equal(r.url.includes('sintetico'), false); }
  }
  for (const base of ['https://evil.invalid/v1', 'https://auth.amr.invalid/v1/', 'https://auth.amr.invalid/a/../v1',
    'https://auth.amr.invalid/v1?x=1', 'https://auth.amr.invalid/v1#x', 'https://u:p@auth.amr.invalid/v1',
    'https://auth.amr.invalid/v1%2fauth', 'https://auth.amr.invalid//v1', 'http://auth.amr.invalid/v1']) {
    assert.throws(() => creaClient({ base, origineAuth: 'https://auth.amr.invalid' }));
  }
  assert.throws(() => creaClient({ base: 'https://auth.amr.invalid/v1' }));
  const c = creaClient({ base: 'https://auth.amr.invalid/v1', origineAuth: 'https://auth.amr.invalid',
    richiesta: async () => { throw Error('TLS/password-sintetica'); } });
  await assert.rejects(c.login('anna@amr.invalid', 'password-sintetica'), e => e.status === 503 && e.message === 'identita_non_disponibile');
});

test('trasporto: guard separati non implicano alcuna esenzione Origin per Auth', () => {
  const tr = creaTrasporto({ origine: 'https://amr.invalid', proxyAttendibili: ['10.0.0.1'] });
  const input = { peer: '10.0.0.1', headers: { 'x-forwarded-proto': 'https', origin: undefined, authorization: 'Bearer sintetico' } };
  assert.equal(valuta(tr, input).status, 403);
  assert.equal(valuta({ ...tr, middleware: tr.verificaTrasporto }, input).status, 200);
  assert.equal(valuta({ ...tr, middleware: tr.verificaOrigine }, input).status, 403);
  assert.equal(valuta({ ...tr, middleware: tr.verificaTrasporto }, { ...input, peer: '10.0.0.2' }).status, 403);
  const { trasportoPerRotta } = require('../backend/nodi/trasporto-prova');
  assert.equal(trasportoPerRotta({ origine: tr.origine, trasporto: { origine: tr.origine, proxyAttendibili: ['10.0.0.1'] } }).secure, true);
  assert.throws(() => trasportoPerRotta({ origine: 'https://evil.invalid', trasporto: { origine: tr.origine } }));
  assert.throws(() => creaTrasporto({ origine: tr.origine, proxy: [], proxyAttendibili: [] }));
});

test('ingress Nhost: rotazione peer ammessa solo con protocollo singolo, Host/Origin invariati', () => {
  const tr = creaTrasporto({ origine: 'https://amr.invalid', ingress: 'nhost' });
  const headers = { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1',
    'x-forwarded-host': 'evil.invalid' };
  for (const peer of ['10.110.1.21', '10.110.1.249', '203.0.113.9', '::ffff:10.110.1.21']) {
    assert.equal(valuta(tr, { peer, headers }).status, 200);
    assert.equal(tr.trustProxy(peer), false);
  }
  assert.equal(tr.secure, true);
  assert.equal(valuta(tr, { headers }).risposta['Strict-Transport-Security'], 'max-age=31536000');
  for (const proto of [undefined, 'http', 'HTTPS', 'https,http', 'https, https']) {
    assert.equal(valuta(tr, { headers: { ...headers, 'x-forwarded-proto': proto } }).status, 403);
  }
  assert.equal(valuta(tr, { headers, host: 'evil.invalid' }).status, 403);
  assert.equal(valuta(tr, { headers, origin: 'https://evil.invalid' }).status, 403);
  assert.equal(valuta(tr, { headers: { ...headers, origin: undefined } }).status, 403);
  assert.equal(valuta(tr, { method: 'GET', headers: { ...headers, origin: undefined } }).status, 200);
  assert.equal(valuta(tr, { peer: 'non-un-ip', headers }).status, 403);
  for (const name of ['host', 'origin', 'x-forwarded-proto']) {
    assert.equal(valuta(tr, { headers, rawHeaders: [name, 'valore', name, 'valore'] }).status, 403);
  }
  // Il solo header non attiva la modalita nella configurazione precedente.
  const vecchio = creaTrasporto({ origine: tr.origine, proxy: ['10.110.1.249'] });
  assert.equal(valuta(vecchio, { peer: '10.110.1.21', headers }).status, 403);
});

test('ingress Nhost: attivazione esplicita HTTPS, nessuna configurazione mista', () => {
  for (const ingress of ['', null, false, 'Nhost', 'altro']) {
    assert.throws(() => creaTrasporto({ origine: 'https://amr.invalid', ingress }));
  }
  assert.throws(() => creaTrasporto({ origine: 'http://127.0.0.1:5000', ingress: 'nhost' }));
  assert.throws(() => creaTrasporto({ origine: 'https://amr.invalid', ingress: 'nhost', proxy: ['127.0.0.1'] }));
  assert.throws(() => creaTrasporto({ origine: 'https://amr.invalid', ingress: 'nhost', proxy: null }));
});
