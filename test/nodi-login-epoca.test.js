'use strict';

const { test } = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const express = require('express');
const { mount } = require('../backend/nodi/login-nhost-prova');
const { creaAccessiPostgres } = require('../backend/nodi/accessi-postgres-prova');
const { creaClient } = require('../backend/nodi/nhost-auth-client');
const PERSONA = '00000000-0000-4000-8000-000000000001';
const ALTRA = '00000000-0000-4000-8000-000000000002';
const EMAIL = 'persona@amr.invalid';
const differita = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const applica = (r, cookie = '') => {
  const jar = new Map(cookie.split(';').map(v => v.trim().split('=')).filter(([k]) => k));
  for (const h of r.headers.getSetCookie()) {
    const [k,v] = h.split(';')[0].split('='); if (v) jar.set(k,v); else jar.delete(k);
  }
  return [...jar].map(([k,v]) => k + '=' + v).join('; ');
};

// HTTP loopback e adapter/client effettivi, SQL e risposte Auth controllati.
// Nessun DB, container, browser, file temporaneo o provider esterno.
async function setup(t, { mfa = false, legacy = false } = {}) {
  const stato = { attiva: true, admin: mfa, epoca: 0, azienda: 'A', azienda_valida: true, moduli: ['moto'] };
  const hooks = {}, chiamate = { login: 0, mfa: 0, logout: 0, sql: [] };
  let checkpointRows, providerPersona = PERSONA, now = Date.now();
  const pool = { async query(sql, params) {
    const tipo = sql.includes('inizio_login') ? 'inizio' : 'identita';
    chiamate.sql.push({ tipo, sql, params });
    const rows = structuredClone(tipo === 'inizio'
      ? checkpointRows === undefined ? [{ persona: PERSONA, epoca: stato.epoca }] : checkpointRows
      : params[0] === PERSONA ? [stato] : []);
    if (hooks.sql) await hooks.sql({ tipo, rows });
    return { rows };
  } };
  const identita = legacy ? async () => ({ ...stato, aziendaValida: stato.azienda_valida }) : creaAccessiPostgres({ pool });
  let numero = 0;
  const sessioneProvider = () => ({ session: { user: { id: providerPersona, emailVerified: true },
    accessToken: 'access-sintetico-' + ++numero, refreshToken: 'refresh-sintetico-' + numero } });
  const client = creaClient({ base: 'http://127.0.0.1/v1', richiesta: async (url, options) => {
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    let data;
    if (url.endsWith('/signin/email-password')) {
      chiamate.login++; assert.equal(body.email.toLowerCase(), EMAIL);
      if (hooks.login) {
        const risposta = await hooks.login(body);
        if (risposta) return risposta;
      }
      data = mfa ? { mfa: { ticket: 'ticket-sintetico' } } : sessioneProvider();
    } else if (url.endsWith('/signin/mfa/totp')) {
      chiamate.mfa++; assert.equal(body.ticket, 'ticket-sintetico'); assert.equal(body.otp, '123456');
      if (hooks.mfa) await hooks.mfa();
      data = sessioneProvider();
    } else {
      assert.ok(url.endsWith('/signout')); chiamate.logout++; data = {};
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const app = express(), server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origine = 'http://127.0.0.1:' + server.address().port;
  const accessi = mount(app, { origine, client, identita, ora: () => now });
  // Esercita il gate del modulo via HTTP; non sostituisce la route ricerca del centro.
  app.get('/api/prova-modulo', async (req, res) => {
    try { await accessi.verifica(accessi.sessione(req), { tipo: 'moto' }); res.json({ ok: true }); }
    catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'non_disponibile' }); }
  });
  t.after(async () => { accessi.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const raw = (route, body, cookie) => fetch(origine + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { origin: origine, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const post = async (route, body, cookie) => {
    const r = await raw('/api/auth/' + route, body, cookie);
    return { r, data: await r.json(), cookie: applica(r, cookie) };
  };
  const bootstrap = async cookie => {
    const a = await post('bootstrap', { login: true, email: EMAIL }, cookie);
    assert.equal(a.r.status, 200); assert.deepEqual(Object.keys(a.data), ['ok', 'tentativo']); return a;
  };
  const login = (a, email = EMAIL, password = 'sintetica') => post('login', { tentativo: a.data.tentativo, email, password }, a.cookie);
  const finalizza = a => post('finalizza', { conferma: a.data.conferma }, a.cookie);
  const accedi = async cookie => {
    const a = await login(await bootstrap(cookie)); assert.equal(a.r.status, 200);
    let b = await finalizza(a); assert.equal(b.r.status, 200);
    if (mfa) {
      assert.deepEqual(b.data, { mfa: true });
      const otp = await post('mfa', { otp: '123456' }, b.cookie); assert.equal(otp.r.status, 200);
      b = await finalizza(otp); assert.equal(b.r.status, 200);
    }
    return b;
  };
  const gate = cookie => raw('/api/prova-modulo', undefined, cookie);
  return { hooks, chiamate, stato, identita, accessi, post, bootstrap, login, finalizza, accedi, gate,
    revoca() { stato.epoca++; stato.azienda_valida = false; }, rinnova() { stato.azienda_valida = true; },
    checkpoint(rows) { checkpointRows = rows; }, provider(id) { providerPersona = id; }, avanza(ms) { now += ms; } };
}

test('C1: handle prima della revoca non adotta la nuova epoca dopo rinnovo', async t => {
  const f = await setup(t), a = await f.bootstrap(); f.revoca(); f.rinnova();
  const r = await f.login(a);
  assert.equal(r.r.status, 401); assert.equal(r.data.codice, 'ripeti_login');
  assert.deepEqual(r.r.headers.getSetCookie(), []); assert.equal(f.chiamate.login, 1);
  assert.equal(f.chiamate.logout, 1);
  assert.equal((await f.gate(a.cookie)).status, 401);
  const nuova = await f.accedi(a.cookie); assert.equal((await f.gate(nuova.cookie)).status, 200);
});

test('C1: provider password lento durante revoca e rinnovo viene ritirato', async t => {
  const f = await setup(t), a = await f.bootstrap(), dentro = differita(), libera = differita();
  f.hooks.login = async () => { dentro.resolve(); await libera.promise; };
  const pending = f.login(a);
  try { await dentro.promise; f.revoca(); f.rinnova(); libera.resolve();
    const r = await pending; assert.equal(r.r.status, 401); assert.deepEqual(r.r.headers.getSetCookie(), []);
    assert.equal(f.chiamate.logout, 1); assert.equal((await f.gate(a.cookie)).status, 401);
  } finally { libera.resolve(); await pending; }
});

test('C1: esito preparato precedente alla revoca non finalizza dopo rinnovo', async t => {
  const f = await setup(t), a = await f.login(await f.bootstrap()); assert.equal(a.r.status, 200);
  f.revoca(); f.rinnova(); const r = await f.finalizza(a);
  assert.equal(r.r.status, 401); assert.deepEqual(r.r.headers.getSetCookie(), []); assert.equal(f.chiamate.logout, 1);
  assert.equal((await f.finalizza(a)).r.status, 401);
});

test('C1 MFA: revoca prima di consegnare la challenge nega la prima finalizzazione', async t => {
  const f = await setup(t, { mfa: true }), a = await f.login(await f.bootstrap());
  assert.equal(a.r.status, 200); f.revoca(); f.rinnova(); const r = await f.finalizza(a);
  assert.equal(r.r.status, 401); assert.deepEqual(r.r.headers.getSetCookie(), []); assert.equal(f.chiamate.mfa, 0);
});

test('C1 MFA: challenge già consegnata mantiene il checkpoint precedente', async t => {
  const f = await setup(t, { mfa: true }), a = await f.finalizza(await f.login(await f.bootstrap()));
  assert.deepEqual(a.data, { mfa: true }); f.revoca(); f.rinnova();
  const r = await f.post('mfa', { otp: '123456' }, a.cookie);
  assert.equal(r.r.status, 401); assert.deepEqual(r.r.headers.getSetCookie(), []); assert.equal(f.chiamate.mfa, 0);
});

test('C1 MFA: OTP lento durante revoca e rinnovo non prepara una sessione nuova', async t => {
  const f = await setup(t, { mfa: true }), a = await f.finalizza(await f.login(await f.bootstrap()));
  const dentro = differita(), libera = differita();
  f.hooks.mfa = async () => { dentro.resolve(); await libera.promise; };
  const pending = f.post('mfa', { otp: '123456' }, a.cookie);
  try { await dentro.promise; f.revoca(); f.rinnova(); libera.resolve();
    const r = await pending; assert.equal(r.r.status, 401); assert.deepEqual(r.r.headers.getSetCookie(), []);
    assert.equal(f.chiamate.mfa, 1); assert.equal(f.chiamate.logout, 1);
  } finally { libera.resolve(); await pending; }
});

test('C1 MFA: esito OTP preparato prima della revoca non finalizza dopo rinnovo', async t => {
  const f = await setup(t, { mfa: true }), a = await f.finalizza(await f.login(await f.bootstrap()));
  const otp = await f.post('mfa', { otp: '123456' }, a.cookie); assert.equal(otp.r.status, 200);
  f.revoca(); f.rinnova(); const r = await f.finalizza(otp);
  assert.equal(r.r.status, 401); assert.deepEqual(r.r.headers.getSetCookie(), []); assert.equal(f.chiamate.logout, 1);
});

test('C1: nuovo login dopo revoca, anche MFA via client Nhost, autentica e attende rinnovo', async t => {
  for (const mfa of [false, true]) {
    const f = await setup(t, { mfa }); f.revoca();
    const a = await f.accedi(); assert.equal((await f.gate(a.cookie)).status, 403);
    f.rinnova(); assert.equal((await f.gate(a.cookie)).status, 200);
    assert.equal(f.chiamate.mfa, Number(mfa));
    assert.equal(f.accessi.sessione({ headers: { cookie: a.cookie } }).epoca, 1);
  }
});

test('C1: email diversa dall’handle nega prima del provider; case equivalente consentito', async t => {
  const f = await setup(t), a = await f.bootstrap();
  const diversa = await f.login(a, 'altra@amr.invalid'); assert.equal(diversa.r.status, 401);
  assert.equal(diversa.data.codice, 'accesso_negato'); assert.equal(f.chiamate.login, 0);
  const b = await f.login(await f.bootstrap(a.cookie), EMAIL.toUpperCase()); assert.equal(b.r.status, 200);
  assert.equal((await f.finalizza(b)).r.status, 200);
});

test('C1: UUID provider diverso dal checkpoint nega login e MFA con cleanup mirato', async t => {
  for (const mfa of [false, true]) {
    const f = await setup(t, { mfa }), a = await f.bootstrap(); f.provider(ALTRA);
    let r = await f.login(a);
    if (mfa) { const challenge = await f.finalizza(r); r = await f.post('mfa', { otp: '123456' }, challenge.cookie); }
    assert.equal(r.r.status, 401); assert.equal(r.data.codice, 'accesso_negato');
    assert.deepEqual(r.r.headers.getSetCookie(), []); assert.equal(f.chiamate.logout, 1);
  }
});

test('C1: persona assente o email ambigua non rivela il lookup nel bootstrap e non rifotografa', async t => {
  const f = await setup(t);
  for (const rows of [[], [{ persona: PERSONA, epoca: 0 }, { persona: ALTRA, epoca: 0 }]]) {
    f.checkpoint(rows); const a = await f.bootstrap();
    f.checkpoint([{ persona: PERSONA, epoca: 0 }]);
    const r = await f.login(a); assert.equal(r.r.status, 401); assert.equal(r.data.codice, 'accesso_negato');
    assert.deepEqual(r.r.headers.getSetCookie(), []);
  }
  assert.equal(f.chiamate.login, 2); assert.equal(f.chiamate.logout, 2);
  assert.equal(f.chiamate.sql.filter(c => c.tipo === 'inizio').length, 2);
});

test('C1 privacy: AMR presente, assente e ambiguo con password errata chiamano Auth una volta e negano ugualmente', async t => {
  for (const rows of [[{ persona: PERSONA, epoca: 0 }], [], [{ persona: PERSONA, epoca: 0 }, { persona: ALTRA, epoca: 0 }]]) {
    const f = await setup(t); f.checkpoint(rows);
    f.hooks.login = async body => {
      assert.equal(body.password, 'sintetica-errata');
      return new Response(JSON.stringify({ error: 'invalid-email-password', dettaglio: 'non-esporre' }), { status: 401 });
    };
    const a = await f.bootstrap(), r = await f.login(a, EMAIL, 'sintetica-errata');
    assert.equal(r.r.status, 401); assert.deepEqual(r.data, { codice: 'accesso_negato' });
    assert.deepEqual(r.r.headers.getSetCookie(), []);
    assert.equal(f.chiamate.login, 1); assert.equal(f.chiamate.logout, 0);
    assert.deepEqual(f.chiamate.sql.map(c => c.tipo), ['inizio']);
    assert.equal((await f.gate(a.cookie)).status, 401);
  }
});

test('C1: logout durante checkpoint SQL non emette handle tardivo', async t => {
  const f = await setup(t), contesto = await f.post('bootstrap', {}), dentro = differita(), libera = differita();
  f.hooks.sql = async ({ tipo }) => { if (tipo === 'inizio') { dentro.resolve(); await libera.promise; } };
  const pending = f.post('bootstrap', { login: true, email: EMAIL }, contesto.cookie);
  try { await dentro.promise; assert.equal((await f.post('logout', {}, contesto.cookie)).r.status, 200); libera.resolve();
    const r = await pending; assert.equal(r.r.status, 401); assert.equal(r.data.codice, 'ripeti_login');
    assert.ok(!('tentativo' in r.data)); assert.deepEqual(r.r.headers.getSetCookie(), []);
    assert.equal(f.chiamate.login, 0);
  } finally { libera.resolve(); await pending; }
});

test('C1: sostituzione durante checkpoint SQL preserva il nuovo handle', async t => {
  const f = await setup(t), contesto = await f.post('bootstrap', {}), dentro = differita(), libera = differita();
  let prima = true;
  f.hooks.sql = async ({ tipo }) => { if (tipo === 'inizio' && prima) { prima = false; dentro.resolve(); await libera.promise; } };
  const pending = f.post('bootstrap', { login: true, email: EMAIL }, contesto.cookie);
  try { await dentro.promise; const nuovo = await f.bootstrap(contesto.cookie); libera.resolve();
    const vecchio = await pending; assert.equal(vecchio.r.status, 401); assert.ok(!('tentativo' in vecchio.data));
    const a = await f.login(nuovo); assert.equal(a.r.status, 200); assert.equal((await f.finalizza(a)).r.status, 200);
  } finally { libera.resolve(); await pending; }
});

test('C1: scadenza e close durante checkpoint SQL non emettono handle tardivi', async t => {
  for (const close of [false, true]) {
    const f = await setup(t), contesto = await f.post('bootstrap', {}), dentro = differita(), libera = differita();
    f.hooks.sql = async ({ tipo }) => { if (tipo === 'inizio') { dentro.resolve(); await libera.promise; } };
    const pending = f.post('bootstrap', { login: true, email: EMAIL }, contesto.cookie);
    try { await dentro.promise; if (close) f.accessi.close(); else f.avanza(3 * 60000); libera.resolve();
      const r = await pending; assert.equal(r.r.status, 401); assert.ok(!('tentativo' in r.data));
    } finally { libera.resolve(); await pending; }
  }
});

test('C1: snapshot iniziale vecchio restituito dopo revoca resta vecchio', async t => {
  const f = await setup(t), dentro = differita(), libera = differita();
  f.hooks.sql = async ({ tipo }) => { if (tipo === 'inizio') { dentro.resolve(); await libera.promise; } };
  const pending = f.bootstrap();
  try { await dentro.promise; f.revoca(); f.rinnova(); libera.resolve(); const a = await pending;
    assert.equal((await f.login(a)).r.status, 401); assert.equal(f.chiamate.login, 1); assert.equal(f.chiamate.logout, 1);
  } finally { libera.resolve(); await pending; }
});

test('C1: snapshot finale obsoleto conserva epoca iniziale; il cookie resta negato dopo rinnovo', async t => {
  const f = await setup(t), a = await f.login(await f.bootstrap()), dentro = differita(), libera = differita();
  f.hooks.sql = async ({ tipo }) => { if (tipo === 'identita') { dentro.resolve(); await libera.promise; } };
  const pending = f.finalizza(a);
  try { await dentro.promise; f.revoca(); f.rinnova(); libera.resolve(); const r = await pending;
    assert.equal(r.r.status, 200); assert.equal(f.accessi.sessione({ headers: { cookie: r.cookie } }).epoca, 0);
    assert.equal((await f.gate(r.cookie)).status, 403);
  } finally { libera.resolve(); await pending; }
});

test('C1: SQL checkpoint mancante e verifica finale persa falliscono senza fallback', async t => {
  const f = await setup(t);
  f.hooks.sql = async () => { throw Object.assign(new Error('dettaglio-riservato'), { code: '42883' }); };
  const boot = await f.post('bootstrap', { login: true, email: EMAIL });
  assert.equal(boot.r.status, 503); assert.deepEqual(boot.data, { codice: 'autorizzazione_non_disponibile' });
  assert.equal(f.chiamate.login, 0);
  f.hooks.sql = null; const a = await f.login(await f.bootstrap(boot.cookie));
  f.hooks.sql = async () => { throw new Error('risposta-SQL-persa'); };
  const r = await f.finalizza(a); assert.equal(r.r.status, 503); assert.deepEqual(r.r.headers.getSetCookie(), []);
  assert.equal(f.chiamate.logout, 1); assert.equal((await f.finalizza(a)).r.status, 401);
});

test('C1: identita plain function conserva il protocollo sintetico storico senza email bootstrap', async t => {
  const f = await setup(t, { legacy: true }), a = await f.post('bootstrap', { login: true });
  assert.equal(a.r.status, 200); const b = await f.login(a); assert.equal(b.r.status, 200);
  const c = await f.finalizza(b); assert.equal(c.r.status, 200); assert.equal((await f.gate(c.cookie)).status, 200);
  assert.equal(f.chiamate.sql.length, 0);
});

test('C1 adapter: query parametrizzata, ambiguo negato e checkpoint minimo immutabile', async () => {
  let args, rows = [{ persona: PERSONA, epoca: 3, email: EMAIL, password_hash: 'non_esporre' }];
  const identita = creaAccessiPostgres({ pool: { query: async (...x) => { args = x; return { rows }; } } });
  assert.equal(typeof identita.inizioLogin, 'function'); assert.equal(Reflect.deleteProperty(identita, 'inizioLogin'), false);
  const c = await identita.inizioLogin(EMAIL.toUpperCase());
  assert.deepEqual(args, ['SELECT * FROM amr_accessi.inizio_login($1::text)', [EMAIL.toUpperCase()]]);
  assert.deepEqual(c, { persona: PERSONA, epoca: 3 }); assert.ok(Object.isFrozen(c));
  rows = [{ persona: PERSONA, epoca: 3 }, { persona: ALTRA, epoca: 3 }];
  assert.equal(await identita.inizioLogin(EMAIL), null); // Risultato ambiguo anche da schema divergente.
  rows = []; assert.equal(await identita.inizioLogin(EMAIL), null);
  for (const epoca of [null, undefined, '3', -1, 2147483648]) {
    rows = [{ persona: PERSONA, epoca }]; await assert.rejects(identita.inizioLogin(EMAIL), e => e.status === 503);
  }
});

test('C1 adapter: identita e checkpoint condividono il limite di attesa SQL', async () => {
  const releases = [], identita = creaAccessiPostgres({ pool: { query: () => new Promise(r => releases.push(r)) } });
  const pendenti = Array.from({ length: 32 }, (_, i) => i % 2 ? identita(PERSONA) : identita.inizioLogin(EMAIL));
  try {
    await assert.rejects(identita.inizioLogin(EMAIL), e => e.status === 503);
    await assert.rejects(identita(PERSONA), e => e.status === 503); assert.equal(releases.length, 32);
  } finally { releases.forEach(r => r({ rows: [] })); await Promise.all(pendenti); }
});

test('C1 frontend: bootstrap manda solo email e login usa la medesima email', async () => {
  const chiamate = [], nodes = Object.fromEntries(['login','mfa','stato','logout','prototipo'].map(id => [id, {
    hidden: false, elements: { password: { value: 'sintetica' }, otp: { value: '' }, email: { value: EMAIL } }, addEventListener() {},
  }]));
  const ctx = vm.createContext({ window: {}, AbortSignal, navigator: { locks: { request: async (name, options, fn) => fn() } },
    document: { querySelector: s => nodes[s.slice(1)], querySelectorAll: () => [] }, location: { replace() {} },
    fetch: async (url, options) => {
      chiamate.push({ url, body: options?.body ? JSON.parse(options.body) : undefined });
      return { ok: url.endsWith('/bootstrap'), status: url.endsWith('/bootstrap') ? 200 : 401,
        json: async () => url.endsWith('/bootstrap') ? { ok: true, tentativo: 'a'.repeat(64) } : { codice: 'accesso_negato' } };
    } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/nodi-bootstrap-prova.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/nodi-login-prova.js'), 'utf8'), ctx);
  await vm.runInContext(`manda('login', {email:${JSON.stringify(EMAIL)}, password:'sintetica'})`, ctx);
  assert.deepEqual(chiamate.find(c => c.body?.login).body, { login: true, email: EMAIL });
  assert.equal(chiamate.find(c => c.url.endsWith('/login')).body.email, EMAIL);
});
