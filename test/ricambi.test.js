'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { mount } = require('../backend/ricambi-route');

const normOen = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// envelope multi-fonte finto
const env = (oen, { autodoc = 'empty', web = 'empty', articoli = [] } = {}) => ({
  oen, tipoPezzo: null, categoria: null,
  sources: { autodoc: { status: autodoc, count: 0 }, web: { status: web, count: 0 } },
  articoli, count: articoli.length,
});

function makeServer(searchRicambi, clientIp = () => 'ip-test') {
  const app = express();
  mount(app, { searchRicambi, normOen, clientIp });
  return new Promise(res => { const s = app.listen(0, () => res(s)); });
}
async function get(s, p) {
  const r = await fetch(`http://localhost:${s.address().port}${p}`);
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('oen vuoto → 400', async () => {
  const s = await makeServer(async () => { throw new Error('non deve essere chiamato'); });
  try { assert.strictEqual((await get(s, '/api/ricambi?oen=')).status, 400); }
  finally { s.close(); }
});

test('successo → 200 + envelope; codice normalizzato passato al core', async () => {
  let seen = null, calls = 0;
  const s = await makeServer(async (oen) => { calls++; seen = oen; return env(oen, { autodoc: 'ok', web: 'ok', articoli: [{ fonte: 'autodoc', nome: 'x' }, { fonte: 'web', nome: 'y' }] }); });
  try {
    const r = await get(s, '/api/ricambi?oen=1k0 905 851 b');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.count, 2);
    assert.strictEqual(r.body.sources.autodoc.status, 'ok');
    assert.strictEqual(seen, '1k0 905 851 b');   // la route passa q raw; il core normalizza internamente
    assert.strictEqual(calls, 1);
  } finally { s.close(); }
});

test('cache: risultato "buono" non ri-chiama il core; OEN diverso sì', async () => {
  let calls = 0;
  const s = await makeServer(async (oen) => { calls++; return env(oen, { autodoc: 'ok', articoli: [{ fonte: 'autodoc', nome: 'a' }] }); });
  try {
    await get(s, '/api/ricambi?oen=ABC123');
    await get(s, '/api/ricambi?oen=abc-123');   // stessa chiave normalizzata → cache
    assert.strictEqual(calls, 1);
    await get(s, '/api/ricambi?oen=DIVERSO9');
    assert.strictEqual(calls, 2);
  } finally { s.close(); }
});

test('NON cacha se una fonte è in errore transitorio → ritenta', async () => {
  let calls = 0;
  const s = await makeServer(async (oen) => { calls++; return env(oen, { autodoc: 'blocked', web: 'ok', articoli: [{ fonte: 'web', nome: 'w' }] }); });
  try {
    await get(s, '/api/ricambi?oen=X1');
    await get(s, '/api/ricambi?oen=X1');   // stesso OEN, ma la 1ª non era cacheable → ri-chiama
    assert.strictEqual(calls, 2);
  } finally { s.close(); }
});

test('core lancia → 500', async () => {
  const s = await makeServer(async () => { throw new Error('crash'); });
  try { assert.strictEqual((await get(s, '/api/ricambi?oen=CRASH1')).status, 500); }
  finally { s.close(); }
});

test('rate-limit: 11ª richiesta (OEN distinti, stesso IP) → 429', async () => {
  const s = await makeServer(async (oen) => env(oen, { autodoc: 'empty', web: 'empty' }));
  try {
    for (let i = 1; i <= 10; i++) assert.strictEqual((await get(s, `/api/ricambi?oen=CODE${i}`)).status, 200, `richiesta ${i}`);
    assert.strictEqual((await get(s, '/api/ricambi?oen=CODE11')).status, 429);
  } finally { s.close(); }
});
