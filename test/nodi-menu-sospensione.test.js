'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
// Istanza isolata dei moduli reali: cataloghi sintetici e trasporto senza rete.
function carica(rel, mocks) {
  const filename = path.resolve(__dirname, '..', rel), req = createRequire(filename), module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__dirname,__filename){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })(
    name => Object.hasOwn(mocks, name) ? mocks[name] : req(name), module, module.exports, path.dirname(filename), filename);
  return module.exports;
}
function fixture(locale = false, attesa = null) {
  let calls = 0;
  const models = carica('backend/scrapers/motoit-models.js', {
    './motoit-http': { get: async () => { calls++; await attesa; return { body: JSON.stringify({ result: 'OK', data: [{ value: 'yamaha|fixture', text: 'Fixture' }] }) }; } },
    '../fonti-salute': { richiesta: async (_, fn) => fn(), registra() {} },
    '../../data/motoit-catalogo.json': { marche: locale ? { yamaha: { modelli: { fixture: { nome: 'Fixture' } } } } : {} },
  });
  const menu = carica('backend/menu-ricerca-route.js', { './scrapers/motoit-models': models,
    '../data/models.json': { moto: { Yamaha: { models: [], motoit: { brandSlug: 'yamaha' } } } } });
  const ops = carica('backend/nodi/operazioni.js', { '../menu-ricerca-route': menu });
  return { ops, get calls() { return calls; } };
}
const job = { operazione: 'modelli', input: { tipo: 'moto', marca: 'Yamaha' }, fontiSospese: ['moto'] };
test('pausa manuale del centro impedisce il fallback HTTP senza avvelenare cache o salute', async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const out = await f.ops.esegui(job); assert.equal(out.status, 200);
    assert.match(out.body.fonteMotoitKo, /sospesa dall.operatore/); assert.equal(f.calls, 0);
  }
  const ok = await f.ops.esegui({ ...job, fontiSospese: [] }); assert.equal(f.calls, 1); assert.equal(ok.body.modelli.length, 1);
  assert.deepEqual((await f.ops.esegui(job)).body, ok.body); assert.equal(f.calls, 1);
  await assert.rejects(f.ops.esegui({ ...job, fontiSospese: 'moto' }), /sospensioni non valide/);
});
test('pausa manuale conserva catalogo locale e download già iniziato senza nuove chiamate', async () => {
  const local = fixture(true); assert.equal((await local.ops.esegui(job)).body.modelli.length, 1); assert.equal(local.calls, 0);
  let libera; const f = fixture(false, new Promise(r => { libera = r; }));
  const avviata = f.ops.esegui({ ...job, fontiSospese: [] });
  const sospesa = f.ops.esegui(job); libera();
  assert.deepEqual(await sospesa, await avviata); assert.equal(f.calls, 1);
});
