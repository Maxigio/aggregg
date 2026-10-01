'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mount } = require('../backend/nodi/login-nhost-prova');
const { creaClient } = require('../backend/nodi/nhost-auth-client');
const session = { session: { user: { id: 'persona', emailVerified: true }, accessToken: 'provider-access', refreshToken: 'provider-refresh' } };

async function setup(t, { client = {}, ruolo = { attiva: true, admin: false }, identita } = {}) {
  const app = express();
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origine = 'http://127.0.0.1:' + server.address().port;
  let now = Date.now();
  const auth = mount(app, { client: { login: async () => session, logout: async () => {}, ...client },
    identita: identita || (async () => ruolo), origine, ora: () => now });
  t.after(async () => { auth.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const req = (route, body, cookie, extra = {}) => fetch(origine + '/api/auth/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { origin: origine, 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = cookie => req('login', { email: 'persona@amr.invalid', password: 'password-sintetica', admin: true }, cookie);
  return { req, login, auth, ruolo, avanza: ms => { now += ms; }, origine };
}
const getCookie = (r, name) => r.headers.getSetCookie().find(v => v.startsWith(name + '=')).split(';')[0];

test('login Nhost: token solo server, cookie opaco, ruolo client ignorato, JWT diretto negato', async t => {
  const f = await setup(t), r = await f.login(); assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const cookie = getCookie(r, 'amr_sessione_prova'); assert.match(cookie, /=([a-f0-9]{64})$/);
  const headers = r.headers.getSetCookie().join(';'); assert.match(headers, /HttpOnly/); assert.match(headers, /SameSite=Strict/);
  assert.equal((await f.req('me', undefined, null, { authorization: 'Bearer provider-access' })).status, 401);
  assert.deepEqual(await (await f.req('me', undefined, cookie)).json(), { persona: 'persona', admin: false, mfa: false });
  const rotated = await f.login(cookie); assert.equal(rotated.status, 200);
  assert.equal((await f.req('me', undefined, cookie)).status, 401);
  f.avanza(15 * 60000); assert.equal((await f.req('me', undefined, getCookie(rotated, 'amr_sessione_prova'))).status, 401);
});

test('login Nhost: origine estranea o assente, JSON malformato e email non verificata negati', async t => {
  const f = await setup(t); let chiamate = 0;
  const data = { email: 'a@amr.invalid', password: 'prova' };
  for (const origin of ['https://estraneo.invalid', '']) assert.equal((await f.req('login', data, null, { origin })).status, 403);
  const r = await fetch(f.origine + '/api/auth/login', { method: 'POST', headers: { origin: f.origine, 'content-type': 'application/json' }, body: '{' });
  assert.equal(r.status, 400); assert.equal(JSON.stringify(await r.json()).includes('SyntaxError'), false);
  const other = await setup(t, { client: { login: async () => { chiamate++; return { session: { ...session.session, user: { id: 'persona', emailVerified: false } } }; } } });
  assert.equal((await other.login()).status, 401); assert.equal(chiamate, 1);
});

test('login Nhost: Admin senza MFA negato; challenge server monouso, due invii non duplicano MFA', async t => {
  const denied = await setup(t, { ruolo: { attiva: true, admin: true } }); assert.equal((await denied.login()).status, 403);
  let count = 0, finish;
  const f = await setup(t, { ruolo: { attiva: true, admin: true }, client: {
    login: async () => ({ mfa: { ticket: 'ticket-del-provider' } }),
    mfa: async ticket => { assert.equal(ticket, 'ticket-del-provider'); count++; await new Promise(r => { finish = r; }); return session; },
  } });
  const challenge = await f.login(); assert.deepEqual(await challenge.json(), { mfa: true });
  const cookie = getCookie(challenge, 'amr_mfa_prova');
  const first = f.req('mfa', { otp: '123456', ticket: 'ticket-iniettato' }, cookie);
  for (let i = 0; i < 100 && !finish; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(finish); assert.equal((await f.req('mfa', { otp: '123456' }, cookie)).status, 401);
  finish(); const r = await first; assert.equal(r.status, 200); assert.equal(count, 1);
  assert.equal((await (await f.req('me', undefined, getCookie(r, 'amr_sessione_prova'))).json()).mfa, true);
});

test('login Nhost: logout revoca anche con provider offline, revoca persona e ruolo aggiornato', async t => {
  const f = await setup(t, { client: { logout: async () => { throw new Error('offline'); } } });
  const cookie = getCookie(await f.login(), 'amr_sessione_prova');
  assert.deepEqual(await (await f.req('logout', {}, cookie)).json(), { ok: true, providerRevocato: false });
  assert.equal((await f.req('me', undefined, cookie)).status, 401);
  const next = getCookie(await f.login(), 'amr_sessione_prova');
  f.ruolo.attiva = false; assert.equal((await f.req('me', undefined, next)).status, 403);
  f.ruolo.attiva = true; f.auth.revocaPersona('persona'); assert.equal((await f.req('me', undefined, next)).status, 401);
});

test('login Nhost: revoca avvenuta durante controllo asincrono prevale', async t => {
  let release, attendi = false;
  const f = await setup(t, { identita: async () => { if (attendi) await new Promise(r => { release = r; }); return { attiva: true }; } });
  const cookie = getCookie(await f.login(), 'amr_sessione_prova'); attendi = true;
  const pending = f.req('me', undefined, cookie);
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(release); f.auth.revocaPersona('persona'); release(); assert.equal((await pending).status, 401);
});

test('login Nhost: revoca durante creazione non produce una nuova sessione', async t => {
  let release;
  const f = await setup(t, { identita: async () => { await new Promise(r => { release = r; }); return { attiva: true }; } });
  const pending = f.login();
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(release); f.auth.revocaPersona('persona'); release();
  const r = await pending; assert.equal(r.status, 401);
  assert.equal(r.headers.getSetCookie().some(v => v.startsWith('amr_sessione_prova=')), false);
});

test('login Nhost: limite tentativi e pagina locale protetta', async t => {
  const f = await setup(t);
  const page = await f.req('pagina'); assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store'); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /autocomplete="current-password"/);
  for (let i = 0; i < 20; i++) assert.equal((await f.login()).status, 200);
  const limited = await f.login(); assert.equal(limited.status, 429); assert.equal(limited.headers.get('retry-after'), '60');
  f.avanza(60000); assert.equal((await f.login()).status, 200);
});

test('login Nhost: massimo quattro chiamate contemporanee, nessuna coda illimitata', async t => {
  const releases = [];
  const f = await setup(t, { client: { login: async () => {
    await new Promise(resolve => releases.push(resolve)); return session;
  } } });
  const pending = Array.from({ length: 4 }, () => f.login());
  try {
    for (let i = 0; i < 100 && releases.length < 4; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(releases.length, 4);
    assert.equal((await f.login()).status, 429);
  } finally { releases.forEach(r => r()); }
  for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
});

test('client Auth: localhost obbligatorio, redirect vietati ed errori senza dettagli sensibili', async () => {
  assert.throws(() => creaClient({ base: 'https://esempio.invalid/v1' }));
  let opt;
  const c = creaClient({ base: 'http://127.0.0.1:4000/v1', richiesta: async (url, options) => {
    opt = options; throw new Error('password-segreta nel trasporto'); } });
  await assert.rejects(c.login('a@amr.invalid', 'segreta'), e => e.status === 503 && !e.message.includes('segreta'));
  assert.equal(opt.redirect, 'error');
  const unavailable = creaClient({ base: 'http://127.0.0.1:4000/v1', richiesta: async () => ({ ok: false,
    status: 503, json: async () => ({ error: 'dettagli-da-non-inoltrare' }) }) });
  await assert.rejects(unavailable.login('a@amr.invalid', 'segreta'), e => e.status === 503
    && e.codice === 'identita_non_disponibile' && !e.message.includes('dettagli'));
  const throttled = creaClient({ base: 'http://127.0.0.1:4000/v1', richiesta: async () =>
    new Response('Too many requests', { status: 429 }) });
  await assert.rejects(throttled.login('a@amr.invalid', 'segreta'), e => e.status === 429 && e.codice === 'troppi_tentativi');
  const knownDelay = creaClient({ base: 'http://127.0.0.1:4000/v1', richiesta: async () =>
    new Response('Too many requests', { status: 429, headers: { 'retry-after': '300' } }) });
  await assert.rejects(knownDelay.login('a@amr.invalid', 'segreta'), e => e.riprovaFra === 300);
});
