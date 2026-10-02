'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { creaCentro } = require('../backend/nodi/centro');
const parser = require('../backend/ricerca-parametri');

test('pagine distribuite: i cursori Subito non raggiungono il parser delle altre fonti', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cursori-'));
  const centro = creaCentro({ directory: dir, tokens: { a: 'a'.repeat(64), b: 'b'.repeat(64) }, timeoutMs: 1000 });
  const chiamate = [];
  const pendenti = [];
  const modulo = { exports: {} };
  const vuota = () => ({ risultati: [], sources: Object.fromEntries(
    ['subito', 'autoscout', 'moto'].map(f => [f, { status: 'empty', hasMore: false }])) });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/nodi/operazioni.js'), 'utf8'), {
    module: modulo,
    require: nome => nome === '../ricerca-parametri' ? parser
      : nome === '../ricerca-coordinatore' ? { runSearch: async params => {
        chiamate.push(params);
        return vuota();
      } }
      : nome === './componi-ricerca' ? require('../backend/nodi/componi-ricerca')
        : { mount() {}, fermo: () => ({}) },
  });
  async function rotta(percorso, metodo, id, body = {}, query = {}) {
    let status = 200, dato;
    const handler = centro.app.router.stack.find(x => x.route?.path === percorso
      && x.route.methods[metodo]).route.stack.at(-1).handle;
    await handler({ body: { id, ...body }, query, get: k => k === 'x-amr-node-id' ? id : undefined }, {
      status(n) { status = n; return this; }, set() { return this; },
      json(v) { dato = v; return this; }, sendStatus(n) { status = n; return this; },
    });
    return { status, dato };
  }
  async function poll(id) {
    for (let n = 0; n < 50; n++) {
      const r = await rotta('/_nodo/poll', 'get', id, {}, { id });
      if (r.status === 200) return r.dato;
      assert.equal(r.status, 204);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail('lavoro non assegnato');
  }
  async function termina(id, lavoro, esito) {
    assert.equal((await rotta('/_nodo/esito', 'post', id, {
      idLavoro: lavoro.idLavoro, tentativo: lavoro.tentativo, esito,
    })).status, 200);
  }
  try {
    for (const id of ['a', 'b']) await rotta('/_nodo/heartbeat', 'post', id, {
      revisione: 'imac-1', occupato: false,
      fonti: Object.fromEntries(['subito', 'autoscout', 'moto'].map(f => [f, { fermo: false }])),
    });
    for (const fonti of ['autoscout,subito', 'subito,autoscout']) {
      const marca = fonti.startsWith('autoscout') ? 'OrdineA' : 'OrdineB';
      const prima = centro.ricerca('aziendaA', { tipo: 'auto', marca });
      const a = await poll('a');
      await termina('a', a, { status: 200, body: { ...vuota(), sources: {
        ...vuota().sources, subito: { status: 'error', erroreHttp: 429 },
      } } });
      const b = await poll('b');
      await termina('b', b, { status: 200, body: vuota() });
      assert.equal((await prima).status, 200);
      const input = { tipo: 'auto', marca, fetta: '1', fonti,
        subitoMainStart: '50', subitoRecuperoStart: '-1' };
      assert.equal(parser.parseSearchParams(input).errors, undefined);
      const pagina = centro.ricerca('aziendaA', input);
      pendenti.push(pagina);
      pagina.catch(() => {});
      const ordine = fonti.startsWith('autoscout') ? ['a', 'b'] : ['b', 'a'];
      for (const id of ordine) {
        const lavoro = await poll(id);
        const esito = await modulo.exports.esegui(lavoro);
        // Usa il parser vero sul payload che il centro consegna al worker.
        assert.equal(esito.status, 200, JSON.stringify(lavoro.input));
        const params = chiamate.at(-1);
        if (id === 'b') {
          assert.equal(params.subitoMainStart, 50);
          assert.equal(params.subitoRecuperoStart, null);
        } else {
          assert.equal(params.subitoMainStart, undefined);
          assert.equal(params.subitoRecuperoStart, undefined);
          assert.equal(params.fontiPagina, 'autoscout');
        }
        await termina(id, lavoro, esito);
      }
      assert.equal((await pagina).status, 200);
    }
    // Controprova: un payload non valido non diventa valido allentando il parser.
    assert.ok(parser.parseSearchParams({ tipo: 'auto', marca: 'Prova', fetta: '1',
      fonti: 'autoscout', subitoMainStart: '50' }).errors);
    assert.equal(chiamate.length, 4);
  } finally {
    centro.close();
    await Promise.allSettled(pendenti);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
