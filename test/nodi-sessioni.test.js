'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mount } = require('../backend/nodi/login-nhost-prova');

async function setup(t, { identita, logout = async () => {}, cleanupMs } = {}) {
  let server, accessi, now = Date.now(), numero = 0;
  const ruoli = { anna: { attiva: true, epoca: 0 }, bruno: { attiva: true, epoca: 0 } };
  const revocate = [], app = express();
  t.after(async () => {
    accessi?.close(); server?.closeAllConnections();
    if (server?.listening) await new Promise(r => server.close(r));
  });
  server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.once('error', reject);
  });
  const origine = 'http://127.0.0.1:' + server.address().port;
  accessi = mount(app, { origine, ora: () => now, cleanupMs,
    identita: identita ? id => identita(id, ruoli) : async id => ruoli[id],
    client: {
      login: async email => ({ session: { user: { id: email.split('@')[0], emailVerified: true },
        accessToken: 'access-' + ++numero, refreshToken: 'refresh-' + numero } }),
      logout: async s => { revocate.push(s.refreshToken); await logout(s); },
    },
  });
  const raw = (route, body, cookie, extra = {}) => fetch(origine + '/api/auth/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { origin: origine, 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}), ...extra,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const req = async (route, body, cookie, extra) => {
    const r = await raw(route, body, cookie, extra);
    return ['login', 'mfa'].includes(route) ? require('./nodi-auth-finalizza.cjs').finalizza(r,
      conferma => raw('finalizza', { conferma }, cookie, extra)) : r;
  };
  const login = async (persona = 'anna', cookie) => {
    let contesto = (cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('amr_accesso_prova='));
    const bootstrap = await req('bootstrap', { login: true }, cookie);
    if (bootstrap.status !== 200) return bootstrap;
    contesto ||= bootstrap.headers.getSetCookie().find(v => v.startsWith('amr_accesso_prova=')).split(';')[0];
    if (!(cookie || '').includes('amr_accesso_prova=')) cookie = [cookie, contesto].filter(Boolean).join('; ');
    const { tentativo } = await bootstrap.json();
    const r = await req('login', { email: persona + '@amr.invalid', password: 'password-sintetica', tentativo }, cookie);
    r.cookieContesto = contesto;
    return r;
  };
  return { req, login, accessi, ruoli, revocate, origine, avanza: ms => { now += ms; } };
}
function cookies(r, prima = '') {
  const jar = new Map(prima.split(';').map(v => v.trim().split('=')).filter(v => v[0]));
  if (r.cookieContesto) {
    const [key, value] = r.cookieContesto.split('='); jar.set(key, value);
  }
  for (const header of r.headers.getSetCookie()) {
    const [key, value] = header.split(';')[0].split('=');
    if (value) jar.set(key, value); else jar.delete(key);
  }
  return [...jar].map(([key, value]) => key + '=' + value).join('; ');
}
async function elenco(f, cookie) {
  const r = await f.req('sessioni', undefined, cookie); assert.equal(r.status, 200);
  return (await r.json()).sessioni;
}
async function stato(f, id, cookie) {
  const r = await f.req('logout/stato', { id }, cookie); assert.equal(r.status, 200);
  return (await r.json()).provider.stato;
}

test('sessioni: solo proprie, handle non autenticante, metadati minimi e nessun token', async t => {
  const f = await setup(t);
  const a = cookies(await f.login()), b = cookies(await f.login()), estranea = cookies(await f.login('bruno'));
  const lista = await elenco(f, a); assert.equal(lista.length, 2);
  assert.equal(lista.filter(s => s.corrente).length, 1);
  for (const s of lista) {
    assert.deepEqual(Object.keys(s).sort(), ['corrente', 'creata', 'id', 'scadenza']);
    assert.match(s.id, /^[a-f0-9]{64}$/); assert.equal(s.scadenza - s.creata, 15 * 60000);
    assert.equal(a.includes(s.id), false); assert.equal(b.includes(s.id), false);
    assert.equal((await f.req('sessioni', undefined, 'amr_sessione_prova=' + s.id)).status, 401);
  }
  const altraLista = await elenco(f, estranea); assert.equal(altraLista.length, 1);
  assert.equal(lista.some(s => s.id === altraLista[0].id), false);
  const response = await f.req('sessioni', undefined, a);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const payload = await response.text();
  for (const segreto of ['refresh-', 'access-', 'persona', 'chiave', 'amr_sessione']) assert.equal(payload.includes(segreto), false);
  const s = f.accessi.sessione({ headers: { cookie: a } });
  await assert.rejects(f.accessi.sessioniPersona({ ...s }), e => e.status === 401);
});

test('sessioni: revoca altra postazione immediata, cleanup mirato e nuovo login preservato', { timeout: 5000 }, async t => {
  let completa;
  const f = await setup(t, { logout: s => s.refreshToken === 'refresh-2' ? new Promise(r => { completa = r; }) : Promise.resolve() });
  const a = cookies(await f.login()), b = cookies(await f.login()), estranea = cookies(await f.login('bruno'));
  const id = (await elenco(f, a)).find(s => !s.corrente).id;
  const r = await f.req('sessioni/revoca', { id }, a); assert.equal(r.status, 200);
  assert.deepEqual(r.headers.getSetCookie(), []);
  const out = await r.json(); assert.equal(out.provider.stato, 'pending'); assert.ok(completa);
  try {
    assert.equal((await f.req('me', undefined, b)).status, 401);
    assert.equal((await f.req('me', undefined, a)).status, 200);
    assert.equal((await f.req('me', undefined, estranea)).status, 200);
    const nuovaB = cookies(await f.login('anna', b), b);
    completa();
    assert.equal(await stato(f, out.provider.id, a), 'confirmed');
    assert.equal((await f.req('me', undefined, nuovaB)).status, 200);
    assert.equal((await f.req('me', undefined, a)).status, 200);
    assert.deepEqual(f.revocate, ['refresh-2']);
    assert.equal((await f.req('sessioni/revoca', { id }, a)).status, 404);
  } finally { completa(); }
});

test('sessioni: revoca corrente usa logout, altro dispositivo e login successivo restano validi', { timeout: 5000 }, async t => {
  let completa;
  const f = await setup(t, { logout: () => new Promise(r => { completa = r; }) });
  const a = cookies(await f.login()), b = cookies(await f.login());
  const id = (await elenco(f, a)).find(s => s.corrente).id;
  const r = await f.req('sessioni/revoca', { id }, a); assert.equal(r.status, 200);
  assert.match(r.headers.getSetCookie().join(';'), /amr_sessione_prova=;/);
  const fuori = cookies(r, a); assert.equal(fuori.includes('amr_sessione_prova='), false);
  const out = await r.json(); assert.equal(out.provider.stato, 'pending'); assert.ok(completa);
  try {
    assert.equal((await f.req('me', undefined, a)).status, 401);
    assert.equal((await f.req('me', undefined, b)).status, 200);
    const nuovo = cookies(await f.login('anna', fuori), fuori);
    completa();
    const statoResponse = await f.req('logout/stato', { id: out.provider.id }, nuovo);
    assert.equal((await statoResponse.json()).provider.stato, 'confirmed');
    assert.deepEqual(statoResponse.headers.getSetCookie(), []);
    assert.equal((await f.req('me', undefined, nuovo)).status, 200);
    assert.equal((await f.req('me', undefined, b)).status, 200);
    assert.deepEqual(f.revocate, ['refresh-1']);
  } finally { completa(); }
});

test('sessioni: ID estranei negati anche al ruolo Admin, senza invocare il provider', async t => {
  const f = await setup(t);
  const a = cookies(await f.login()), altra = cookies(await f.login('bruno'));
  const id = (await elenco(f, altra))[0].id;
  for (const tentativo of [id, 'f'.repeat(64)]) {
    assert.equal((await f.req('sessioni/revoca', { id: tentativo }, a)).status, 404);
  }
  // Non c'è un percorso privilegiato: nemmeno una sessione Admin con MFA può revocare altre persone.
  const s = f.accessi.sessione({ headers: { cookie: a } });
  f.ruoli.anna.admin = true; s.mfa = true;
  assert.equal((await f.req('sessioni/revoca', { id }, a)).status, 404);
  assert.deepEqual(f.revocate, []); assert.equal((await f.req('me', undefined, altra)).status, 200);
});

test('sessioni: epoca attuale obbligatoria, sessioni di epoche precedenti escluse', async t => {
  const f = await setup(t);
  const a = cookies(await f.login()), b = cookies(await f.login());
  const id = (await elenco(f, a)).find(s => !s.corrente).id;
  f.ruoli.anna.epoca++;
  assert.equal((await f.req('sessioni', undefined, a)).status, 403);
  assert.equal((await f.req('sessioni/revoca', { id }, a)).status, 403);
  const nuova = cookies(await f.login());
  assert.equal((await elenco(f, nuova)).length, 1);
  assert.equal((await f.req('sessioni/revoca', { id }, nuova)).status, 404);
  assert.equal((await f.req('me', undefined, b)).status, 403);
  assert.deepEqual(f.revocate, []);
});

test('sessioni: revoca durante verifica asincrona prevale, nessuna mutazione o cleanup', { timeout: 5000 }, async t => {
  let attendi = false, completa;
  const f = await setup(t, { identita: async (id, ruoli) => {
    const ruolo = { ...ruoli[id] };
    if (attendi) await new Promise(r => { completa = r; });
    return ruolo;
  } });
  const a = cookies(await f.login()), b = cookies(await f.login());
  const id = (await elenco(f, a)).find(s => !s.corrente).id;
  attendi = true; const pending = f.req('sessioni/revoca', { id }, a);
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa); f.accessi.revocaPersona('anna'); attendi = false; completa();
  const r = await pending; assert.equal(r.status, 401); assert.deepEqual(r.headers.getSetCookie(), []);
  assert.deepEqual(f.revocate, []);
  assert.equal((await f.req('me', undefined, b)).status, 401);
});

test('sessioni: ricontrollo dopo il provider nega conferma se identità o epoca del chiamante cambiano', { timeout: 5000 }, async t => {
  for (const modifica of ['epoca', 'disattiva', 'revoca']) {
    let completa;
    const f = await setup(t, { logout: () => new Promise(r => { completa = r; }) });
    const a = cookies(await f.login()), b = cookies(await f.login());
    const id = (await elenco(f, a)).find(s => !s.corrente).id;
    const out = await (await f.req('sessioni/revoca', { id }, a)).json(); assert.ok(completa);
    if (modifica === 'epoca') f.ruoli.anna.epoca++;
    else if (modifica === 'disattiva') f.ruoli.anna.attiva = false;
    else f.accessi.revocaPersona('anna');
    completa();
    assert.equal(await stato(f, out.provider.id, a), 'unconfirmed');
    assert.equal((await f.req('me', undefined, b)).status, 401);
    assert.notEqual((await f.req('sessioni', undefined, a)).status, 200);
    assert.deepEqual(f.revocate, ['refresh-2']);
  }
});

test('sessioni: ricontrollo finale asincrono non conferma una sessione chiamante ruotata', { timeout: 5000 }, async t => {
  let completaProvider, completaIdentita, blocca = false;
  const f = await setup(t, {
    logout: s => s.refreshToken === 'refresh-2' ? new Promise(r => { completaProvider = r; }) : Promise.resolve(),
    identita: async (id, ruoli) => {
      const ruolo = { ...ruoli[id] };
      if (blocca) { blocca = false; await new Promise(r => { completaIdentita = r; }); }
      return ruolo;
    },
  });
  const a = cookies(await f.login()), b = cookies(await f.login());
  const id = (await elenco(f, a)).find(s => !s.corrente).id;
  const out = await (await f.req('sessioni/revoca', { id }, a)).json(); assert.ok(completaProvider);
  blocca = true; completaProvider();
  for (let i = 0; i < 100 && !completaIdentita; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completaIdentita);
  try {
    const nuova = cookies(await f.login('anna', a), a);
    completaIdentita();
    assert.equal(await stato(f, out.provider.id, nuova), 'unconfirmed');
    assert.equal((await f.req('me', undefined, nuova)).status, 200);
    assert.equal((await f.req('me', undefined, b)).status, 401);
    assert.deepEqual(f.revocate, ['refresh-2', 'refresh-1']);
  } finally { completaIdentita(); }
});

test('sessioni: handle ritirati e scaduti non indirizzano sessioni nuove', async t => {
  const f = await setup(t);
  const a = cookies(await f.login()), b = cookies(await f.login());
  const id = (await elenco(f, a)).find(s => !s.corrente).id;
  const ruotata = cookies(await f.login('anna', b), b);
  assert.equal((await f.req('sessioni/revoca', { id }, a)).status, 404);
  assert.equal((await f.req('me', undefined, ruotata)).status, 200);
  assert.deepEqual(f.revocate, ['refresh-2']);
  f.avanza(15 * 60000);
  assert.equal((await f.req('sessioni', undefined, a)).status, 401);
  const nuova = cookies(await f.login()); assert.equal((await elenco(f, nuova)).length, 1);
  assert.equal((await f.req('sessioni/revoca', { id }, nuova)).status, 404);
});

test('sessioni: controlli HTTP, JSON e input non bypassabili, errori sanitizzati', async t => {
  const f = await setup(t), a = cookies(await f.login());
  const id = (await elenco(f, a))[0].id;
  assert.equal((await f.req('sessioni')).status, 401);
  assert.equal((await f.req('sessioni/revoca', { id })).status, 401);
  for (const origin of ['', 'https://estraneo.invalid']) {
    assert.equal((await f.req('sessioni/revoca', { id }, a, { origin })).status, 403);
  }
  const hostEstraneo = await new Promise((resolve, reject) => {
    const r = require('node:http').request(f.origine + '/api/auth/sessioni', {
      headers: { host: 'estraneo.invalid', cookie: a },
    }, response => { response.resume(); resolve(response.statusCode); });
    r.on('error', reject); r.end();
  });
  assert.equal(hostEstraneo, 403);
  for (const body of [{}, { id: 3 }, { id: 'invalid' }]) assert.equal((await f.req('sessioni/revoca', body, a)).status, 400);
  const malformed = await fetch(f.origine + '/api/auth/sessioni/revoca', { method: 'POST',
    headers: { origin: f.origine, cookie: a, 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400); assert.equal(JSON.stringify(await malformed.json()).includes('SyntaxError'), false);
  assert.equal((await f.req('sessioni/revoca', { id, extra: 'x'.repeat(5000) }, a)).status, 413);
});

test('sessioni: lettore offline, concorrenza e rate limit indipendenti dal login', { timeout: 5000 }, async t => {
  let attendi = false, offline = false;
  const completi = [];
  const f = await setup(t, { identita: async (id, ruoli) => {
    if (offline) throw Error('postgres-secret-sintetico');
    if (attendi) await new Promise(r => completi.push(r));
    return ruoli[id];
  } });
  const a = cookies(await f.login());
  offline = true;
  const guasto = await f.req('sessioni', undefined, a); assert.equal(guasto.status, 503);
  assert.equal(JSON.stringify(await guasto.json()).includes('secret'), false); offline = false;
  attendi = true; const pending = Array.from({ length: 3 }, () => f.req('sessioni', undefined, a));
  try {
    for (let i = 0; i < 100 && completi.length < 3; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(completi.length, 3); assert.equal((await f.req('sessioni', undefined, a)).status, 429);
  } finally { attendi = false; completi.forEach(r => r()); }
  for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
  f.avanza(60000);
  for (let i = 0; i < 30; i++) assert.equal((await f.req('sessioni', undefined, a)).status, 200);
  const limitata = await f.req('sessioni', undefined, a);
  assert.equal(limitata.status, 429); assert.equal(limitata.headers.get('retry-after'), '60');
  assert.equal((await f.login()).status, 200);
  f.avanza(60000); assert.equal((await f.req('sessioni', undefined, a)).status, 200);
});
