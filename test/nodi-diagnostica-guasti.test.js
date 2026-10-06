'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

async function prepara(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-diagnostica-guasti-'));
  const file = path.resolve(__dirname, '../backend/nodi/centro.js'), copia = { exports: {} };
  const intervalli = new Map();
  // Il callback di retention resta quello vero. Solo la sua attesa di un'ora
  // viene pilotata; HTTP, SQLite, abort e timer delle ricerche restano reali.
  vm.compileFunction(fs.readFileSync(file, 'utf8'),
    ['exports', 'require', 'module', '__filename', '__dirname', 'setInterval', 'clearInterval'],
    { filename: file })(copia.exports, createRequire(file), copia, file, path.dirname(file),
    (fn, ms) => { const timer = setInterval(ms === 3600000 ? () => {} : fn, ms);
      intervalli.set(timer, { fn, ms }); return timer; },
    timer => { intervalli.delete(timer); clearInterval(timer); });
  const centro = copia.exports.creaCentro({ directory, tokens: { locale: 'a'.repeat(64) }, adminLocale: true });
  centro.app.set('env', 'production');
  const server = await new Promise(resolve => {
    const s = centro.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(async () => {
    try { centro.db.exec('PRAGMA query_only=OFF'); } catch {}
    centro.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const nodiHeaders = { 'content-type': 'application/json', 'x-amr-node-id': 'locale',
    'x-amr-node-token': 'a'.repeat(64) };
  const node = (route, body) => fetch(url + route, { headers: nodiHeaders,
    ...(body ? { method: 'POST', body: JSON.stringify({ id: 'locale', ...body }) } : {}) });
  assert.equal((await node('/_nodo/heartbeat', { revisione: 'imac-1',
    fonti: { subito: { fermo: false }, autoscout: { fermo: false }, moto: { fermo: false } } })).status, 200);
  const login = await fetch(url + '/api/test/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ azienda: 'aziendaA' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const stato = async () => (await fetch(url + '/api/admin/diagnostica')).json();
  const ricerca = () => centro.ricerca('aziendaA', { tipo: 'moto', marca: 'Sintetica' });
  const poll = async () => {
    for (let n = 0; n < 100; n++) {
      const r = await node('/_nodo/poll?id=locale');
      if (r.status === 200) return r.json();
      assert.equal(r.status, 204); await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('lavoro non consegnato');
  };
  const esito = job => node('/_nodo/esito', { idLavoro: job.idLavoro, tentativo: job.tentativo,
    esito: { status: 200, body: { risultati: [], totale: 0, sources: {
      subito: { status: 'empty', count: 0 }, autoscout: { status: 'empty', count: 0 },
      moto: { status: 'empty', count: 0 } }, versioneConto: null, versionePerFonte: null } } });
  return { centro, url, node, ricerca, poll, esito, stato, cookie, intervalli };
}

test('diagnostica: una scrittura rifiutata non perde il risultato e la lacuna resta dichiarata', async t => {
  const p = await prepara(t), avvisi = t.mock.method(console, 'error', () => {});
  const sana = (await p.stato()).diagnostica;
  assert.equal(sana.incompleta, false);
  p.centro.db.exec('PRAGMA query_only=ON');
  const pending = p.ricerca(), job = await p.poll();
  assert.equal((await p.esito(job)).status, 200);
  assert.equal((await pending).status, 200);
  assert.equal(p.centro.lavori.size, 0);
  assert.equal(p.centro.nodi.get('locale').occupato, false);
  const stato = (await p.stato()).diagnostica;
  assert.equal(stato.incompleta, true);
  assert.equal(stato.fallimenti, 3); // attesa, consegna, completamento
  assert.equal(stato.ultimoErrore.fase, 'lavoro');
  assert.equal(avvisi.mock.callCount(), 1);
  assert.equal((await fetch(p.url + '/api/admin')).status, 200);
  assert.equal((await p.stato()).diagnostica.ultimoErrore.fase, 'pulizia');
  p.centro.db.exec('PRAGMA query_only=OFF');
  const seconda = p.ricerca(), nuovoJob = await p.poll();
  await p.esito(nuovoJob); assert.equal((await seconda).status, 200);
  assert.equal(p.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(nuovoJob.idLavoro).stato, 'concluso');
  assert.equal((await p.stato()).diagnostica.incompleta, true);
  assert.equal(avvisi.mock.callCount(), 1);
});

test('diagnostica: retention fallita non esce dal timer e torna a riuscire', async t => {
  const p = await prepara(t), avvisi = t.mock.method(console, 'error', () => {});
  const pulisci = [...p.intervalli.values()].find(x => x.ms === 3600000).fn;
  const prima = (await p.stato()).diagnostica.ultimaPulizia;
  p.centro.db.exec('PRAGMA query_only=ON');
  assert.doesNotThrow(() => { pulisci(); pulisci(); });
  const guasta = (await p.stato()).diagnostica;
  assert.equal(guasta.ultimaPulizia, prima);
  assert.equal(guasta.ultimoErrore.fase, 'pulizia');
  assert.equal(guasta.fallimenti, 2);
  assert.equal(avvisi.mock.callCount(), 1);
  p.centro.db.exec('PRAGMA query_only=OFF');
  pulisci();
  assert.equal((await p.stato()).diagnostica.ultimaPulizia >= prima, true);
  assert.equal((await p.stato()).diagnostica.incompleta, true);
});

test('diagnostica: abort e close completano il cleanup con registro in sola lettura', async t => {
  const p = await prepara(t); t.mock.method(console, 'error', () => {});
  p.centro.db.exec('PRAGMA query_only=ON');
  const pending = p.ricerca(), job = await p.poll();
  const rifiutata = assert.rejects(pending, e => e.incerto === true && e.message === 'centro interrotto');
  assert.doesNotThrow(() => p.centro.close());
  await rifiutata;
  assert.equal(p.centro.lavori.size, 0);
  assert.equal(p.intervalli.size, 0);
  assert.equal(p.centro.db.isOpen, false);
  assert.doesNotThrow(() => p.centro.close());
  assert.equal(typeof job.idLavoro, 'string');
});

test('diagnostica: una tabella illeggibile non impedisce di consultare il suo stato RAM', async t => {
  const p = await prepara(t); t.mock.method(console, 'error', () => {});
  p.centro.db.exec('DROP TABLE lavori');
  const pending = p.ricerca(), job = await p.poll();
  await p.esito(job); assert.equal((await pending).status, 200);
  const r = await fetch(p.url + '/api/admin/diagnostica');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.diagnostica.incompleta, true);
  assert.deepEqual(Object.keys(body.diagnostica.ultimoErrore).sort(), ['fase', 'istante']);
  assert.equal(JSON.stringify(body).includes('no such table'), false);
});

test('diagnostica: errore eventi non produce log ripetuti e le sospensioni restano obbligatorie', async t => {
  const p = await prepara(t), avvisi = t.mock.method(console, 'error', () => {});
  const headers = { cookie: p.cookie, 'content-type': 'application/json', 'x-amr-local-admin': '1' };
  p.centro.db.exec('PRAGMA query_only=ON');
  const sospendi = () => fetch(p.url + '/api/admin/nodi/locale', { method: 'POST', headers,
    body: JSON.stringify({ sospeso: true }) });
  // Una scrittura operativa non è un semplice log: nessun successo fittizio.
  assert.equal((await sospendi()).status, 500);
  const revoca = await fetch(p.url + '/api/admin/nodi/locale/revoca-token', {
    method: 'POST', headers, body: '{}' });
  assert.equal(revoca.status, 500);
  assert.equal(p.centro.db.prepare('SELECT count(*) AS n FROM token_revocati').get().n, 0);
  p.centro.db.exec('PRAGMA query_only=OFF');
  p.centro.db.exec("CREATE TEMP TRIGGER errore_eventi BEFORE INSERT ON eventi BEGIN SELECT RAISE(ABORT,'guasto_sintetico'); END");
  assert.equal((await sospendi()).status, 200);
  assert.equal((await sospendi()).status, 200);
  assert.equal((await p.stato()).diagnostica.ultimoErrore.fase, 'evento');
  assert.equal(avvisi.mock.calls.filter(c => c.arguments[0] === '[nodi] raccolta diagnostica incompleta').length, 1);
});
