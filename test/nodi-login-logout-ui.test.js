'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

function pagina({ leggi = async () => ({ stato: 'confirmed' }) } = {}) {
  const nodes = Object.fromEntries(['login', 'mfa', 'stato', 'logout', 'prototipo'].map(id => [id, {
    hidden: false, elements: { password: { value: '' }, otp: { value: '' }, email: { value: '' } }, addEventListener() {},
  }]));
  const timers = [], richieste = [], id = 'a'.repeat(64);
  const ctx = vm.createContext({ AbortSignal, setTimeout: fn => timers.push(fn),
    location: { replace() {} }, document: { querySelector: s => nodes[s.slice(1)], querySelectorAll: () => [] },
    fetch: async (url, options) => {
      richieste.push({ url, options });
      if (url.endsWith('/me')) return { ok: false };
      const data = url.endsWith('/logout/stato') ? { provider: await leggi() }
        : url.endsWith('/logout') ? { ok: true, provider: { stato: 'pending', id } } : { ok: true };
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/nodi-login-prova.js'), 'utf8'), ctx);
  return { ctx, nodes, timers, richieste, id, async tick() {
    assert.ok(timers.length); timers.shift()(); await new Promise(r => setImmediate(r));
  } };
}

test('logout UI: accesso locale subito chiuso, conferma separata con ID nel body', async () => {
  const f = pagina();
  await vm.runInContext("manda('logout', {})", f.ctx);
  assert.equal(f.nodes.login.hidden, false); assert.equal(f.nodes.logout.hidden, true);
  assert.equal(f.nodes.prototipo.hidden, true); assert.match(f.nodes.stato.textContent, /in corso/);
  await f.tick();
  assert.match(f.nodes.stato.textContent, /Nhost confermata/);
  const richiesta = f.richieste.find(r => r.url.endsWith('/logout/stato'));
  assert.deepEqual(JSON.parse(richiesta.options.body), { id: f.id });
  assert.equal(richiesta.options.method, 'POST');
  assert.equal(richiesta.options.credentials, 'same-origin');
  assert.equal(f.timers.length, 0);
});

test('logout UI: stato tardivo non sovrascrive un nuovo login', async () => {
  let completa;
  const f = pagina({ leggi: () => new Promise(r => { completa = r; }) });
  await vm.runInContext("manda('logout', {})", f.ctx); await f.tick();
  assert.ok(completa);
  await vm.runInContext("manda('login', {})", f.ctx);
  const stato = f.nodes.stato.textContent;
  completa({ stato: 'unconfirmed' }); await new Promise(r => setImmediate(r));
  assert.equal(f.nodes.stato.textContent, stato);
  assert.equal(f.nodes.prototipo.hidden, false); assert.equal(f.timers.length, 0);
});

test('logout UI: letture limitate, errore o mancata conferma non diventano successo', async () => {
  for (const tipo of ['pending', 'unconfirmed', 'errore']) {
    const f = pagina({ leggi: async () => { if (tipo === 'errore') throw Error('offline'); return { stato: tipo }; } });
    await vm.runInContext("manda('logout', {})", f.ctx);
    for (let i = 0; i < 6 && f.timers.length; i++) await f.tick();
    assert.match(f.nodes.stato.textContent, /non confermata/);
    assert.equal(f.nodes.login.hidden, false); assert.equal(f.nodes.prototipo.hidden, true);
    assert.equal(f.timers.length, 0);
    assert.equal(f.richieste.filter(r => r.url.endsWith('/logout/stato')).length, tipo === 'pending' ? 6 : 1);
  }
});
