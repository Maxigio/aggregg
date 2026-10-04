'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { creaCentro } = require('../backend/nodi/centro');
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function attendi(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await pausa(5); }
  throw Error('fixture_non_pronta');
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-menu-http-'));
  let blocco, libera;
  const sessione = { persona: 'p', azienda: 'a', scadenza: Date.now() + 60000 };
  const centro = creaCentro({ directory, tokens: { n: 'n'.repeat(64) }, timeoutMs: 4000,
    inizializzaAccessi: () => ({ close() {}, sessione: () => sessione,
      async verifica() {
        if (blocco) { blocco = false; await new Promise(r => { libera = r; }); }
        return { azienda: 'a', aziendaValida: true, moduli: ['auto', 'moto'] };
      } }) });
  const server = centro.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { libera?.(); centro.close(); server.closeAllConnections();
    await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = (url, signal) => fetch(base + url, { signal });
  const node = (route, body) => fetch(base + '/_nodo/' + route, { headers: {
    'x-amr-node-id': 'n', 'x-amr-node-token': 'n'.repeat(64), 'content-type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify({ id: 'n', ...body }) } : {}) });
  await (await node('heartbeat', { revisione: 'imac-1', occupato: false, fonti: {} })).text();
  const poll = async () => { const r = await node('poll?id=n'); assert.equal(r.status, 200); return r.json(); };
  const esito = async job => { const r = await node('esito', { idLavoro: job.idLavoro, tentativo: job.tentativo,
    esito: { status: 200, body: { modelli: [] } } }); assert.equal(r.status, 200); await r.text(); };
  return { centro, req, node, poll, esito, blocca: () => { blocco = true; }, libera: () => libera?.(),
    attendePermessi: () => !!libera };
}
for (const route of ['brands?tipo=moto', 'models?tipo=moto&marca=Yamaha',
  'versioni?tipo=moto&marca=Yamaha&modello=MT-07', 'detail']) {
  test('HTTP abbandonato non consegna il lavoro accodato: ' + route, async t => {
    const f = await fixture(t);
    let url = '/api/' + route;
    if (route === 'detail') {
      const ricerca = f.req('/api/search?tipo=moto&marca=Yamaha');
      await attendi(() => f.centro.lavori.size === 1);
      const job = await f.poll();
      await (await f.node('esito', { idLavoro: job.idLavoro, tentativo: job.tentativo, esito: { status: 200,
        body: { risultati: [{ fonte: 'subito', url: 'https://www.subito.it/moto/fixture.htm' }], sources: {
          subito: { status: 'ok' }, autoscout: { status: 'empty' }, moto: { status: 'empty' } } } } })).text();
      const r = (await (await ricerca).json()).risultati[0];
      url = '/api/detail?' + new URLSearchParams({ url: r.url, accessoDettagli: r.accessoDettagli });
    }
    const ctrl = new AbortController(), p = f.req(url, ctrl.signal);
    const interrotta = assert.rejects(p, e => e.name === 'AbortError');
    await attendi(() => f.centro.lavori.size === 1);
    ctrl.abort(); await interrotta;
    await attendi(() => f.centro.lavori.size === 0);
    assert.equal(f.centro.nodi.get('n').coda.length, 0);
    assert.equal((await f.node('poll?id=n')).status, 204);
    assert.equal(f.centro.db.prepare('SELECT stato FROM lavori ORDER BY aggiornato DESC LIMIT 1').get().stato, 'interrotto');
  });
}
test('menu già consegnato termina anche quando il browser chiude la pagina', async t => {
  const f = await fixture(t), ctrl = new AbortController(), p = f.req('/api/models?tipo=moto&marca=Yamaha', ctrl.signal);
  const interrotta = assert.rejects(p);
  await attendi(() => f.centro.lavori.size === 1);
  const job = await f.poll(); ctrl.abort(); await interrotta; await pausa(30);
  assert.equal(f.centro.lavori.get(job.idLavoro).iniziato, true);
  await f.esito(job); assert.equal(f.centro.lavori.size, 0);
});
test('chiusura durante la verifica dei permessi impedisce l’accodamento', async t => {
  const f = await fixture(t); f.blocca();
  const ctrl = new AbortController(), p = f.req('/api/models?tipo=moto&marca=Yamaha', ctrl.signal);
  const interrotta = assert.rejects(p);
  await attendi(f.attendePermessi); ctrl.abort(); await interrotta; await pausa(30); f.libera(); await pausa(30);
  assert.equal(f.centro.lavori.size, 0);
  assert.equal((await f.node('poll?id=n')).status, 204);
});
test('chiusura durante la verifica al poll non consegna né lascia lavori in attesa', async t => {
  const f = await fixture(t), ctrl = new AbortController(), p = f.req('/api/models?tipo=moto&marca=Yamaha', ctrl.signal);
  const interrotta = assert.rejects(p);
  await attendi(() => f.centro.lavori.size === 1); f.blocca();
  const poll = f.node('poll?id=n'); await attendi(f.attendePermessi);
  ctrl.abort(); await interrotta; await attendi(() => f.centro.lavori.size === 0); f.libera();
  assert.equal((await poll).status, 204);
});
test('menu accodato riceve le sospensioni vigenti al momento della consegna', async t => {
  const f = await fixture(t), p = f.req('/api/models?tipo=moto&marca=Yamaha');
  await attendi(() => f.centro.lavori.size === 1);
  f.centro.nodi.get('n').sospese.add('moto');
  const job = await f.poll(); assert.deepEqual(job.fontiSospese, ['moto']);
  await f.esito(job); assert.equal((await p).status, 200);
});
