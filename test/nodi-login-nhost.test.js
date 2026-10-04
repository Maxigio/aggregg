'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { mount } = require('../backend/nodi/login-nhost-prova');
const { creaClient } = require('../backend/nodi/nhost-auth-client');
const session = { session: { user: { id: 'persona', emailVerified: true }, accessToken: 'provider-access', refreshToken: 'provider-refresh' } };

async function setup(t, { client = {}, ruolo = { attiva: true, admin: false }, identita, cleanupMs } = {}) {
  const app = express();
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const origine = 'http://127.0.0.1:' + server.address().port;
  let now = Date.now();
  const auth = mount(app, { client: { login: async () => session, logout: async () => {}, ...client },
    identita: identita || (async () => ruolo), origine, ora: () => now, cleanupMs });
  t.after(async () => { auth.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const req = async (route, body, cookie, extra = {}) => { const r = await fetch(origine + '/api/auth/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { origin: origine, 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    r.cookieContesto = (cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('amr_accesso_prova='));
    return r;
  };
  const login = async cookie => {
    let contesto = (cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('amr_accesso_prova='));
    const bootstrap = await req('bootstrap', { login: true }, cookie);
    if (!bootstrap.ok) return bootstrap;
    contesto ||= getCookie(bootstrap, 'amr_accesso_prova');
    if (!(cookie || '').includes('amr_accesso_prova=')) cookie = [cookie, contesto].filter(Boolean).join('; ');
    const { tentativo } = await bootstrap.json();
    const r = await req('login', { email: 'persona@amr.invalid', password: 'password-sintetica', admin: true, tentativo }, cookie);
    r.cookieContesto = contesto; // Metadato dell'helper, distinto dagli header HTTP del login.
    return r;
  };
  return { req, login, auth, ruolo, avanza: ms => { now += ms; }, origine };
}
const getCookie = (r, name) => r.headers.getSetCookie().find(v => v.startsWith(name + '='))?.split(';')[0]
  || (name === 'amr_accesso_prova' ? r.cookieContesto : undefined);
const loginCookies = r => [r.cookieContesto, getCookie(r, 'amr_sessione_prova')].filter(Boolean).join('; ');

test('login Nhost: contesto assente, malformato o duplicato nega prima del provider', async t => {
  let chiamate = 0, cleanup = 0;
  const f = await setup(t, { client: {
    login: async () => { chiamate++; return session; },
    logout: async () => { cleanup++; },
  } });
  const body = { email: 'persona@amr.invalid', password: 'password-sintetica' };
  for (const cookie of [undefined, 'amr_accesso_prova=errato',
    'amr_accesso_prova=' + 'a'.repeat(64) + '; amr_accesso_prova=' + 'b'.repeat(64)]) {
    const r = await f.req('login', body, cookie);
    assert.equal(r.status, 401); assert.equal((await r.json()).codice, 'ripeti_login');
    assert.deepEqual(r.headers.getSetCookie(), []);
    assert.equal((await f.req('me', undefined, cookie)).status, 401);
  }
  assert.equal((await f.req('logout', {})).status, 200);
  assert.equal(chiamate, 0); assert.equal(cleanup, 0);
});

test('C03: solo bootstrap crea il contesto; letture e logout anonimi non lo sovrascrivono', async t => {
  const f = await setup(t);
  for (const route of ['me', 'pagina']) assert.deepEqual((await f.req(route)).headers.getSetCookie(), []);
  assert.ok((await f.req('logout', {})).headers.getSetCookie().every(v => !v.startsWith('amr_accesso_prova=')));
  const primo = await f.req('bootstrap', {}), contesto = getCookie(primo, 'amr_accesso_prova');
  assert.equal(primo.status, 200);
  const secondo = await f.req('bootstrap', {}, contesto);
  assert.equal(secondo.status, 200); assert.deepEqual(secondo.headers.getSetCookie(), []);
  const r = await f.login(contesto); assert.equal(r.status, 200);
  assert.equal(r.headers.getSetCookie().some(v => v.startsWith('amr_accesso_prova=')), false);
});

test('login Nhost: logout con contesto durante password pendente nega e pulisce una sola volta', { timeout: 5000 }, async t => {
  let entra, libera, chiamate = 0, cleanup = 0;
  const entrata = new Promise(r => { entra = r; }), attesa = new Promise(r => { libera = r; });
  const f = await setup(t, { client: {
    login: async () => { chiamate++; entra(); await attesa; return session; },
    logout: async () => { cleanup++; },
  } });
  const contesto = getCookie(await f.req('bootstrap', {}), 'amr_accesso_prova');
  const pending = f.login(contesto);
  try {
    await entrata;
    const out = await (await f.req('logout', {}, contesto)).json();
    assert.equal(out.provider.stato, 'pending');
    libera(); const r = await pending;
    assert.equal(r.status, 401); assert.deepEqual(r.headers.getSetCookie(), []);
    assert.equal(chiamate, 1); assert.equal(cleanup, 1);
    assert.equal((await f.req('me', undefined, contesto)).status, 401);
    assert.equal((await (await f.req('logout/stato', { id: out.provider.id }, contesto)).json()).provider.stato, 'confirmed');
  } finally { libera(); await pending.catch(() => {}); }
});

test('logout separato: risposta immediata, login successivo e altro dispositivo restano validi', { timeout: 5000 }, async t => {
  let numero = 0, completa;
  const revocate = [], attive = new Set();
  const f = await setup(t, { client: {
    login: async () => {
      const s = { ...session.session, accessToken: 'access-' + ++numero, refreshToken: 'refresh-' + numero };
      attive.add(s.refreshToken); return { session: s };
    },
    logout: async s => {
      revocate.push(s.refreshToken); await new Promise(r => { completa = r; }); attive.delete(s.refreshToken);
    },
  } });
  const altro = loginCookies(await f.login());
  const jar = new Map();
  const applicaCookie = r => {
    for (const header of r.headers.getSetCookie()) {
      const [nome, value] = header.split(';')[0].split('=');
      if (!value) jar.delete(nome); else jar.set(nome, value);
    }
  };
  const cookies = () => [...jar].map(([k, v]) => k + '=' + v).join('; ');
  applicaCookie(await f.req('bootstrap', {}));
  applicaCookie(await f.login(cookies()));
  const vecchia = cookies();
  const r = await f.req('logout', {}, cookies());
  const data = await r.json(); applicaCookie(r);
  assert.equal(data.provider.stato, 'pending'); assert.match(data.provider.id, /^[a-f0-9]{64}$/);
  assert.equal(jar.has('amr_sessione_prova'), false);
  assert.equal((await f.req('me', undefined, vecchia)).status, 401);
  assert.ok(completa); assert.deepEqual(revocate, ['refresh-2']);
  try {
    applicaCookie(await f.login(cookies()));
    assert.equal((await f.req('me', undefined, cookies())).status, 200);
    completa();
    const stato = await f.req('logout/stato', { id: data.provider.id }, cookies());
    assert.equal((await stato.json()).provider.stato, 'confirmed');
    assert.deepEqual(stato.headers.getSetCookie(), []);
    assert.equal((await f.req('me', undefined, cookies())).status, 200);
    assert.equal((await f.req('me', undefined, altro)).status, 200);
    assert.deepEqual([...attive], ['refresh-1', 'refresh-3']);
    assert.equal(JSON.stringify(data).includes('refresh-'), false);
    assert.equal(JSON.stringify(data).includes('persona'), false);
  } finally { completa(); }
});

test('logout separato: esito opaco vincolato al browser, con scadenza e senza cookie sullo status', async t => {
  const f = await setup(t);
  const cookie = loginCookies(await f.login());
  const r = await f.req('logout', {}, cookie), data = await r.json();
  const browser = getCookie(r, 'amr_accesso_prova');
  for (const estraneo of [undefined, cookie.split('; ').find(v => v.startsWith('amr_sessione_prova=')), getCookie(await f.req('bootstrap', {}), 'amr_accesso_prova')]) {
    assert.equal((await f.req('logout/stato', { id: data.provider.id }, estraneo)).status, 404);
  }
  assert.equal((await f.req('logout/stato', { id: 'errato' }, browser)).status, 404);
  assert.equal((await f.req('logout/stato', { id: data.provider.id }, browser, { origin: 'https://estraneo.invalid' })).status, 403);
  const stato = await f.req('logout/stato', { id: data.provider.id }, browser);
  assert.equal((await stato.json()).provider.stato, 'confirmed');
  assert.deepEqual(stato.headers.getSetCookie(), []);
  assert.equal(stato.headers.get('cache-control'), 'no-store');
  f.avanza(5 * 60000);
  assert.equal((await f.req('logout/stato', { id: data.provider.id }, browser)).status, 404);
  assert.deepEqual(await (await f.req('logout', {}, browser)).json(), { ok: true, provider: { stato: 'unconfirmed', id: null } });
});

test('logout separato: timeout non diventa conferma tardiva e close ritira gli esiti', { timeout: 5000 }, async t => {
  let completa;
  const f = await setup(t, { cleanupMs: 40, client: { logout: () => new Promise(r => { completa = r; }) } });
  const cookie = loginCookies(await f.login());
  const r = await f.req('logout', {}, cookie), data = await r.json();
  const browser = getCookie(r, 'amr_accesso_prova');
  await new Promise(r => setTimeout(r, 60));
  assert.equal((await (await f.req('logout/stato', { id: data.provider.id }, browser)).json()).provider.stato, 'unconfirmed');
  completa();
  const tardivo = await f.req('logout/stato', { id: data.provider.id }, browser);
  assert.equal((await tardivo.json()).provider.stato, 'unconfirmed');
  assert.deepEqual(tardivo.headers.getSetCookie(), []);
  f.auth.close();
  assert.equal((await f.req('logout/stato', { id: data.provider.id }, browser)).status, 404);
});

test('logout separato: password e MFA cancellate restano pending fino al cleanup della sessione tardiva', { timeout: 5000 }, async t => {
  for (const mfa of [false, true]) {
    let completaProvider, completaCleanup;
    const f = await setup(t, { client: {
      login: () => mfa ? Promise.resolve({ mfa: { ticket: 'ticket' } }) : new Promise(r => { completaProvider = r; }),
      mfa: () => new Promise(r => { completaProvider = r; }),
      logout: () => new Promise(r => { completaCleanup = r; }),
    } });
    const browser = getCookie(await f.req('bootstrap', {}), 'amr_accesso_prova');
    const cookies = mfa ? browser + '; ' + getCookie(await f.login(browser), 'amr_mfa_prova') : browser;
    const pending = mfa ? f.req('mfa', { otp: '123456' }, cookies) : f.login(cookies);
    for (let i = 0; i < 100 && !completaProvider; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(completaProvider);
    const data = await (await f.req('logout', {}, cookies)).json();
    assert.equal(data.provider.stato, 'pending');
    completaProvider(session);
    for (let i = 0; i < 100 && !completaCleanup; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(completaCleanup);
    try {
      assert.equal((await (await f.req('logout/stato', { id: data.provider.id }, browser)).json()).provider.stato, 'pending');
    } finally { completaCleanup(); }
    const obsoleta = await pending;
    assert.equal(obsoleta.status, 401); assert.deepEqual(obsoleta.headers.getSetCookie(), []);
    assert.equal((await (await f.req('logout/stato', { id: data.provider.id }, browser)).json()).provider.stato, 'confirmed');
  }
});

test('logout separato: quota senza coda, timeout non libera slot ancora occupati', { timeout: 5000 }, async t => {
  const completi = [];
  let numero = 0;
  const f = await setup(t, { cleanupMs: 40, client: {
    login: async () => ({ session: { ...session.session, refreshToken: 'refresh-' + ++numero } }),
    logout: () => new Promise(r => { completi.push(r); }),
  } });
  const esci = async () => {
    const cookie = loginCookies(await f.login());
    const r = await f.req('logout', {}, cookie);
    return { data: await r.json(), browser: getCookie(r, 'amr_accesso_prova') };
  };
  try {
    for (let i = 0; i < 4; i++) await esci();
    const esclusa = await esci(); assert.equal(completi.length, 4);
    assert.equal((await (await f.req('logout/stato', { id: esclusa.data.provider.id }, esclusa.browser)).json()).provider.stato, 'unconfirmed');
    await new Promise(r => setTimeout(r, 60));
    await esci(); assert.equal(completi.length, 4);
    // I quattro slot Auth restano disponibili per il cleanup di un login respinto.
    f.ruolo.attiva = false;
    const respinta = f.login();
    for (let i = 0; i < 100 && completi.length < 5; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(completi.length, 5); completi[4]();
    assert.equal((await respinta).status, 403); f.ruolo.attiva = true;
    completi[0](); await esci(); assert.equal(completi.length, 6);
  } finally { completi.forEach(r => r()); }
});

test('logout separato: memoria esiti limitata, saturazione non impedisce il logout locale', async t => {
  let numero = 0;
  const revocate = [];
  const f = await setup(t, { client: {
    login: async () => ({ session: { ...session.session, refreshToken: 'refresh-' + ++numero } }),
    logout: async s => { revocate.push(s.refreshToken); },
  } });
  const cookies = [];
  for (let i = 0; i < 100; i++) {
    if (i % 20 === 0) f.avanza(60000);
    cookies.push(loginCookies(await f.login()));
  }
  let primo;
  for (const cookie of cookies) {
    const r = await f.req('logout', {}, cookie);
    const data = await r.json(); assert.ok(data.provider.id);
    primo ||= { id: data.provider.id, browser: getCookie(r, 'amr_accesso_prova') };
  }
  f.avanza(60000);
  const nuova = loginCookies(await f.login());
  assert.deepEqual(await (await f.req('logout', {}, nuova)).json(), { ok: true, provider: { stato: 'unconfirmed', id: null } });
  assert.equal((await f.req('me', undefined, nuova)).status, 401);
  assert.equal(revocate.length, 101);
  assert.equal((await (await f.req('logout/stato', { id: primo.id }, primo.browser)).json()).provider.stato, 'confirmed');
  f.avanza(5 * 60000);
  const ultima = loginCookies(await f.login());
  assert.ok((await (await f.req('logout', {}, ultima)).json()).provider.id);
});

test('logout separato: token condiviso non revoca altra postazione e resta non confermato', async t => {
  let chiamate = 0;
  const f = await setup(t, { client: { logout: async () => { chiamate++; } } });
  const altra = loginCookies(await f.login());
  const cookie = loginCookies(await f.login());
  const r = await f.req('logout', {}, cookie), data = await r.json();
  const browser = getCookie(r, 'amr_accesso_prova');
  assert.equal((await (await f.req('logout/stato', { id: data.provider.id }, browser)).json()).provider.stato, 'unconfirmed');
  assert.equal(chiamate, 0);
  assert.equal((await f.req('me', undefined, altra)).status, 200);
  assert.equal((await f.req('me', undefined, cookie)).status, 401);
});

test('logout separato: provider di un login cancellato fallisce, nessuna conferma inventata', { timeout: 5000 }, async t => {
  let fallisci;
  const f = await setup(t, { client: { login: () => new Promise((_, reject) => { fallisci = reject; }) } });
  const browser = getCookie(await f.req('bootstrap', {}), 'amr_accesso_prova');
  const pending = f.login(browser);
  for (let i = 0; i < 100 && !fallisci; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(fallisci);
  const data = await (await f.req('logout', {}, browser)).json();
  assert.equal(data.provider.stato, 'pending');
  fallisci(Error('trasporto-sintetico'));
  assert.equal((await pending).status, 503);
  assert.equal((await (await f.req('logout/stato', { id: data.provider.id }, browser)).json()).provider.stato, 'unconfirmed');
});

test('close Auth: cleanup tardivo di login respinto preservato, nuovi login non chiamano il provider', { timeout: 5000 }, async t => {
  let completa, chiamate = 0, revocate = 0;
  const f = await setup(t, { client: {
    login: () => { chiamate++; return new Promise(r => { completa = r; }); },
    logout: async () => { revocate++; },
  } });
  const pending = f.login();
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa); f.auth.close(); completa(session);
  assert.equal((await pending).status, 401); assert.equal(revocate, 1);
  assert.equal((await f.login()).status, 503); assert.equal(chiamate, 1);
});

test('cleanup Auth: massimo otto chiamate reali, close non avvia retry né libera slot fittizi', { timeout: 5000 }, async t => {
  const completi = [];
  let numero = 0;
  const f = await setup(t, { cleanupMs: 40, client: {
    login: async () => ({ session: { ...session.session, refreshToken: 'refresh-' + ++numero } }),
    logout: () => new Promise(r => { completi.push(r); }),
  } });
  let esito;
  try {
    for (let i = 0; i < 4; i++) {
      const cookie = loginCookies(await f.login());
      const r = await f.req('logout', {}, cookie);
      esito = { data: await r.json(), browser: getCookie(r, 'amr_accesso_prova') };
    }
    f.ruolo.attiva = false;
    for (const r of await Promise.all(Array.from({ length: 4 }, () => f.login()))) assert.equal(r.status, 403);
    assert.equal(completi.length, 8);
    assert.equal((await f.login()).status, 403); assert.equal(completi.length, 8);
    f.auth.close();
    assert.equal((await f.req('logout/stato', { id: esito.data.provider.id }, esito.browser)).status, 404);
    assert.equal((await f.login()).status, 503);
    assert.equal(completi.length, 8);
  } finally { completi.forEach(r => r()); }
});

test('login Nhost: rotazione ritira solo il provider precedente, anche con MFA', async t => {
  for (const mfa of [false, true]) {
    let numero = 0;
    const attive = new Set(), revocate = [];
    const nuova = () => {
      const s = { ...session.session, accessToken: 'access-' + ++numero, refreshToken: 'refresh-' + numero };
      attive.add(s.refreshToken); return { session: s };
    };
    const f = await setup(t, { ruolo: { attiva: true, admin: mfa }, client: {
      login: async () => mfa ? { mfa: { ticket: 'ticket-sintetico' } } : nuova(),
      mfa: async () => nuova(),
      logout: async s => { revocate.push(s.refreshToken); attive.delete(s.refreshToken); },
    } });
    const accedi = async cookie => {
      const r = await f.login(cookie); assert.equal(r.status, 200);
      if (!mfa) return r;
      const finale = await f.req('mfa', { otp: '123456' },
        [cookie, getCookie(r, 'amr_mfa_prova'), r.cookieContesto].filter(Boolean).join('; '));
      assert.equal(finale.status, 200); return finale;
    };
    const altro = getCookie(await accedi(), 'amr_sessione_prova');
    const vecchia = getCookie(await accedi(), 'amr_sessione_prova');
    const nuovaCookie = getCookie(await accedi(vecchia), 'amr_sessione_prova');
    assert.deepEqual(revocate, ['refresh-2']);
    assert.deepEqual([...attive], ['refresh-1', 'refresh-3']);
    assert.equal((await f.req('me', undefined, vecchia)).status, 401);
    assert.equal((await f.req('me', undefined, nuovaCookie)).status, 200);
    assert.equal((await f.req('me', undefined, altro)).status, 200);
    await f.req('logout', {}, nuovaCookie);
    assert.deepEqual(revocate, ['refresh-2', 'refresh-3']);
    assert.deepEqual([...attive], ['refresh-1']);
  }
});

test('login Nhost: rotazione non revoca refresh token condivisi con sessioni attive', async t => {
  for (const condivisoConNuova of [true, false]) {
    let numero = 0;
    const revocate = [];
    const f = await setup(t, { client: {
      login: async () => ({ session: { ...session.session,
        accessToken: 'access-' + ++numero,
        refreshToken: numero < 3 || condivisoConNuova ? 'condiviso' : 'distinto' } }),
      logout: async s => { revocate.push(s.refreshToken); },
    } });
    const altro = loginCookies(await f.login());
    const vecchia = loginCookies(await f.login());
    const nuova = loginCookies(await f.login(vecchia));
    assert.deepEqual(revocate, []);
    assert.equal((await f.req('me', undefined, vecchia)).status, 401);
    for (const cookie of [altro, nuova]) assert.equal((await f.req('me', undefined, cookie)).status, 200);
  }
});

test('login Nhost: diniego della rotazione conserva la precedente e pulisce solo la respinta', async t => {
  let numero = 0;
  const revocate = [];
  const f = await setup(t, { client: {
    login: async () => ({ session: { ...session.session, accessToken: 'access-' + ++numero,
      refreshToken: 'refresh-' + numero } }),
    logout: async s => { revocate.push(s.refreshToken); },
  } });
  const vecchia = loginCookies(await f.login());
  f.ruolo.attiva = false;
  const r = await f.login(vecchia); assert.equal(r.status, 403);
  assert.equal(r.headers.getSetCookie().some(v => v.startsWith('amr_sessione_prova=')), false);
  assert.deepEqual(revocate, ['refresh-2']);
  f.ruolo.attiva = true;
  assert.equal((await f.req('me', undefined, vecchia)).status, 200);
});

test('login Nhost: cleanup della rotazione offline non revoca il nuovo accesso', async t => {
  let numero = 0;
  const revocate = [];
  const f = await setup(t, { client: {
    login: async () => ({ session: { ...session.session, accessToken: 'access-' + ++numero,
      refreshToken: 'refresh-' + numero } }),
    logout: async s => { revocate.push(s.refreshToken); throw Error('offline-sintetico'); },
  } });
  const vecchia = loginCookies(await f.login());
  const r = await f.login(vecchia);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
  assert.deepEqual(revocate, ['refresh-1']);
  assert.equal((await f.req('me', undefined, vecchia)).status, 401);
  assert.equal((await f.req('me', undefined, getCookie(r, 'amr_sessione_prova'))).status, 200);
});

test('login Nhost: cleanup pendente non blocca risposta e non annulla revoca o nuovo login', { timeout: 5000 }, async t => {
  let numero = 0, completaCleanup, avviato;
  const iniziato = new Promise(r => { avviato = r; });
  const revocate = [];
  const f = await setup(t, { client: {
    login: async () => ({ session: { ...session.session, accessToken: 'access-' + ++numero,
      refreshToken: 'refresh-' + numero } }),
    logout: async s => {
      revocate.push(s.refreshToken);
      if (s.refreshToken === 'refresh-1') {
        await new Promise(r => { completaCleanup = r; avviato(); });
      }
    },
  } });
  const vecchia = loginCookies(await f.login());
  const pending = f.login(vecchia);
  await iniziato;
  try {
    // La risposta deve arrivare prima che il cleanup venga sbloccato.
    const r = await pending; assert.equal(r.status, 200);
    const ruotata = getCookie(r, 'amr_sessione_prova');
    assert.equal((await f.req('me', undefined, ruotata)).status, 200);
    f.auth.revocaPersona('persona');
    assert.equal((await f.req('me', undefined, ruotata)).status, 401);
    const nuova = loginCookies(await f.login(ruotata));
    completaCleanup();
    assert.equal((await f.req('me', undefined, nuova)).status, 200);
    assert.deepEqual(revocate, ['refresh-1']);
    f.auth.close();
    assert.equal((await f.req('me', undefined, nuova)).status, 401);
  } finally { completaCleanup(); }
});

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
  const cookie = loginCookies(await f.login());
  const r = await f.req('logout', {}, cookie), data = await r.json();
  assert.equal(data.ok, true); assert.equal(data.provider.stato, 'pending');
  const stato = await f.req('logout/stato', { id: data.provider.id }, getCookie(r, 'amr_accesso_prova'));
  assert.equal((await stato.json()).provider.stato, 'unconfirmed');
  assert.equal((await f.req('me', undefined, cookie)).status, 401);
  const next = loginCookies(await f.login());
  f.ruolo.attiva = false; assert.equal((await f.req('me', undefined, next)).status, 403);
  f.ruolo.attiva = true; f.auth.revocaPersona('persona'); assert.equal((await f.req('me', undefined, next)).status, 401);
});

test('login Nhost: revoca avvenuta durante controllo asincrono prevale', async t => {
  let release, attendi = false;
  const f = await setup(t, { identita: async () => { if (attendi) await new Promise(r => { release = r; }); return { attiva: true }; } });
  const cookie = loginCookies(await f.login()); attendi = true;
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

test('login Nhost: logout durante MFA impedisce cookie tardivo e revoca il provider', async t => {
  let completa, revocate = 0;
  const f = await setup(t, { ruolo: { attiva: true, admin: true }, client: {
    login: async () => ({ mfa: { ticket: 'ticket-sintetico' } }),
    mfa: () => new Promise(r => { completa = r; }), logout: async () => { revocate++; },
  } });
  const cookie = getCookie(await f.login(), 'amr_mfa_prova');
  const pending = f.req('mfa', { otp: '123456' }, cookie);
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa);
  assert.equal((await f.req('logout', {}, cookie)).status, 200);
  completa(session);
  const r = await pending;
  assert.equal(r.status, 401); assert.equal(revocate, 1);
  assert.equal(r.headers.getSetCookie().some(v => v.startsWith('amr_sessione_prova=')), false);
});

test('login Nhost: revoca durante provider prevale, ma una nuova autenticazione resta possibile', async t => {
  let completa, revocate = 0;
  const f = await setup(t, { client: { login: () => new Promise(r => { completa = r; }),
    logout: async () => { revocate++; } } });
  const pending = f.login();
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa); f.auth.revocaPersona('persona'); completa(session);
  assert.equal((await pending).status, 401); assert.equal(revocate, 1);
  completa = null; const next = f.login();
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa); completa(session); assert.equal((await next).status, 200);
});

test('login Nhost: contesto browser cancella password pendente e nuovo login cancella la vecchia MFA', async t => {
  let completa, mfaCompleta, attende = true;
  const f = await setup(t, { client: {
    login: () => attende ? new Promise(r => { completa = r; }) : Promise.resolve({ mfa: { ticket: 'ticket' } }),
    mfa: () => new Promise(r => { mfaCompleta = r; }),
  } });
  const contesto = getCookie(await f.req('bootstrap', {}), 'amr_accesso_prova');
  const pending = f.login(contesto);
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa); await f.req('logout', {}, contesto); completa(session);
  assert.equal((await pending).status, 401);
  attende = false;
  const first = await f.login(contesto), old = getCookie(first, 'amr_mfa_prova');
  const pendingMfa = f.req('mfa', { otp: '123456' }, contesto + '; ' + old);
  for (let i = 0; i < 100 && !mfaCompleta; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(mfaCompleta);
  const next = await f.login(contesto + '; ' + old); assert.equal(next.status, 200);
  const nuovaMfa = getCookie(next, 'amr_mfa_prova');
  mfaCompleta(session);
  const obsoleta = await pendingMfa;
  assert.equal(obsoleta.status, 401);
  assert.equal(obsoleta.headers.getSetCookie().some(v => v.startsWith('amr_mfa_prova=')), false);
  mfaCompleta = null;
  const finale = f.req('mfa', { otp: '123456' }, contesto + '; ' + nuovaMfa);
  for (let i = 0; i < 100 && !mfaCompleta; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(mfaCompleta); mfaCompleta(session);
  assert.equal((await finale).status, 200);
});

test('login Nhost: diniego e scadenza revocano provider senza cambiare errore originale', async t => {
  let revocate = 0;
  const denied = await setup(t, { ruolo: { attiva: false }, client: {
    logout: async () => { revocate++; throw Error('provider offline'); },
  } });
  const r = await denied.login(); assert.equal(r.status, 403);
  assert.equal((await r.json()).codice, 'accesso_non_autorizzato'); assert.equal(revocate, 1);
  let completa;
  const stale = await setup(t, { client: { login: () => new Promise(r => { completa = r; }),
    logout: async () => { revocate++; } } });
  const pending = stale.login();
  for (let i = 0; i < 100 && !completa; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(completa); stale.avanza(3 * 60000); completa(session);
  assert.equal((await pending).status, 401); assert.equal(revocate, 2);
});

test('login Nhost: a cap pieno la rotazione valida riesce e un nuovo browser resta escluso', async t => {
  let numero = 0, cookie;
  const revocate = [];
  const f = await setup(t, { client: {
    login: async () => ({ session: { ...session.session, accessToken: 'access-' + ++numero,
      refreshToken: 'refresh-' + numero } }),
    logout: async s => { revocate.push(s.refreshToken); },
  } });
  for (let i = 0; i < 100; i++) {
    if (i % 20 === 0) f.avanza(60000);
    const r = await f.login(); assert.equal(r.status, 200); cookie = getCookie(r, 'amr_sessione_prova');
  }
  f.avanza(60000);
  const rotated = await f.login(cookie); assert.equal(rotated.status, 200);
  assert.equal((await f.req('me', undefined, cookie)).status, 401);
  assert.equal((await f.login()).status, 503);
  assert.deepEqual(revocate, ['refresh-100', 'refresh-102']);
  assert.equal((await f.req('me', undefined, getCookie(rotated, 'amr_sessione_prova'))).status, 200);
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

test('C03: logout annulla anche il tentativo preparato ma non ancora consegnato; nuovo handle valido e monouso', async t => {
  let chiamate = 0;
  const f = await setup(t, { client: { login: async () => { chiamate++; return session; } } });
  const prep = await f.req('bootstrap', { login: true });
  const contesto = getCookie(prep, 'amr_accesso_prova'), { tentativo } = await prep.json();
  await f.req('logout', {}, contesto);
  const body = { email: 'persona@amr.invalid', password: 'password-sintetica', tentativo };
  const vecchia = await f.req('login', body, contesto);
  assert.equal(vecchia.status, 401); assert.deepEqual(vecchia.headers.getSetCookie(), []);
  assert.equal(chiamate, 0);
  const nuova = await f.req('bootstrap', { login: true }, contesto);
  body.tentativo = (await nuova.json()).tentativo;
  const altro = getCookie(await f.req('bootstrap', {}), 'amr_accesso_prova');
  assert.equal((await f.req('login', body, altro)).status, 401);
  assert.equal((await f.req('login', body, contesto)).status, 200);
  assert.equal((await f.req('login', body, contesto)).status, 401);
  assert.equal(chiamate, 1);
  body.tentativo = (await (await f.req('bootstrap', { login: true }, contesto)).json()).tentativo;
  f.avanza(3 * 60000);
  assert.equal((await f.req('login', body, contesto)).status, 401);
  assert.equal(chiamate, 1);
});

test('C03: handle preparati in finestre precedenti non aggirano il limite delle chiamate al provider', async t => {
  let chiamate = 0;
  const f = await setup(t, { client: { login: async () => { chiamate++; return session; } } });
  const preparati = [];
  for (let finestra = 0; finestra < 2; finestra++) {
    if (finestra) f.avanza(60000);
    for (let i = 0; i < 20; i++) {
      const r = await f.req('bootstrap', { login: true }); assert.equal(r.status, 200);
      preparati.push({ cookie: getCookie(r, 'amr_accesso_prova'), tentativo: (await r.json()).tentativo });
    }
  }
  for (let i = 0; i < 21; i++) {
    const p = preparati[i];
    const r = await f.req('login', { email: 'persona@amr.invalid', password: 'password-sintetica', tentativo: p.tentativo }, p.cookie);
    assert.equal(r.status, i < 20 ? 200 : 429);
  }
  assert.equal(chiamate, 20);
});
