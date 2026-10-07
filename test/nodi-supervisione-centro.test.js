'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { creaCentro } = require('../backend/nodi/centro');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-supervisione-centro-'));
  const token = 'a'.repeat(64); let centro, server, origin;
  const avvia = async () => {
    centro = creaCentro({ tokens: { prova: token }, directory: dir, adminLocale: true });
    server = centro.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    origin = 'http://127.0.0.1:' + server.address().port;
  };
  const chiudi = async () => { centro.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); };
  await avvia(); t.after(async () => { await chiudi(); fs.rmSync(dir, { recursive: true, force: true }); });
  const richiesta = (route, body, headers = {}) => fetch(origin + route, { method: body ? 'POST' : 'GET',
    headers: { 'x-amr-node-id': 'prova', 'x-amr-node-token': token,
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const registra = async () => {
    const c = await (await richiesta('/_nodo/registrazione')).json(), boot = crypto.randomUUID();
    assert.equal((await richiesta('/_nodo/registrazione', { boot, precedente: c.boot, epoca: c.epoca })).status, 200);
    return { epoca: c.epoca, boot };
  };
  const hb = async contesto => assert.equal((await richiesta('/_nodo/heartbeat', {
    id: 'prova', revisione: 'imac-1', fonti: { subito: { fermo: false } }, sequenza: 1, occupato: false,
  }, { 'x-amr-node-boot': contesto.boot, 'x-amr-center-epoch': contesto.epoca })).status, 200);
  return { richiesta, registra, hb, get centro() { return centro; },
    restart: async () => { await chiudi(); await avvia(); },
    admin: async () => (await fetch(origin + '/api/admin')).json() };
}
const stato = (c, sequenza, extra = {}) => ({ ...c, sequenza, stato: 'attivo', motivo: null,
  restart: 0, prossimo: null, aggiornato: 0, ...extra });

test('centro supervisione: autenticazione, sequenza, boot/epoca e schema impediscono aggiornamenti tardivi', async t => {
  const f = await fixture(t), c = await f.registra(); await f.hb(c);
  const post = b => f.richiesta('/_nodo/supervisione', b);
  assert.equal((await f.richiesta('/_nodo/supervisione', stato(c, 1), { 'x-amr-node-token': 'errato' })).status, 401);
  assert.equal((await post(stato(c, 1, { token: 'vietato' }))).status, 400);
  assert.equal((await post(stato(c, 1, { restart: 6 }))).status, 400);
  assert.equal((await post(stato(c, 1, { motivo: 'testo libero privato' }))).status, 400);
  assert.equal((await post(stato(c, 2))).status, 200);
  assert.equal((await (await post(stato(c, 1, { stato: 'intervento', motivo: 'restart_esauriti' }))).json()).accepted, false);
  assert.equal(f.centro.nodi.get('prova').supervisione.stato, 'attivo');
  const nuovo = await f.registra(); await f.hb(nuovo);
  assert.equal((await post(stato(c, 3))).status, 409);
  assert.equal((await post(stato(nuovo, 1))).status, 200);
  await f.restart(); assert.equal((await post(stato(nuovo, 2))).status, 409);
});

test('centro supervisione: avviso di intervento sopravvive al riavvio e non include segreti', async t => {
  const f = await fixture(t), c = await f.registra(); await f.hb(c);
  assert.equal((await f.richiesta('/_nodo/supervisione', stato(c, 1, {
    stato: 'intervento', motivo: 'restart_esauriti', restart: 5 }))).status, 200);
  assert.equal((await f.admin()).nodi[0].supervisione.motivo, 'restart_esauriti');
  await f.restart(); const admin = await f.admin();
  assert.equal(admin.nodi[0].supervisione.restart, 5); assert.equal(admin.nodi[0].online, false);
  assert.equal(JSON.stringify(admin).includes('a'.repeat(64)), false);
  assert.ok(admin.eventi.some(x => x.codice === 'worker_intervento'));
});

test('centro supervisione: stato prima della registrazione conserva stop e pause persistite', async t => {
  const f = await fixture(t);
  f.centro.db.prepare('INSERT INTO sospensioni(nodo,fonte) VALUES(?,?)').run('prova','');
  f.centro.db.prepare('INSERT INTO sospensioni(nodo,fonte) VALUES(?,?)').run('prova','subito');
  const c = await (await f.richiesta('/_nodo/registrazione')).json();
  assert.equal((await f.richiesta('/_nodo/supervisione', stato(c, 1, { stato: 'avvio' }))).status, 200);
  assert.equal(f.centro.nodi.get('prova').sospeso, true);
  assert.equal(f.centro.nodi.get('prova').sospese.has('subito'), true);
  await f.registra();
  assert.equal(f.centro.nodi.get('prova').sospeso, true);
  assert.equal(f.centro.nodi.get('prova').sospese.has('subito'), true);
});

test('centro supervisione: stop ritira la coda e un nuovo worker non ripete il lavoro già partito', async t => {
  const f = await fixture(t), c = await f.registra(); await f.hb(c);
  const richiesta = f.centro.ricerca('aziendaB', { tipo: 'moto', marca: 'Honda', fonti: 'subito', fetta: '0' });
  await new Promise(r => setImmediate(r));
  assert.equal(f.centro.lavori.size, 1);
  const headers = { 'x-amr-node-boot': c.boot, 'x-amr-center-epoch': c.epoca };
  const job = await (await f.richiesta('/_nodo/poll?id=prova', null, headers)).json();
  assert.ok(job.idLavoro);
  assert.equal((await f.richiesta('/_nodo/supervisione', stato(c, 1, {
    stato: 'attesa_restart', motivo: 'crash', restart: 1, prossimo: Date.now() + 1000 }))).status, 200);
  const nuovo = await f.registra(); await f.hb(nuovo);
  await assert.rejects(richiesta, e => e.incerto === true);
  assert.equal(f.centro.lavori.size, 0);
  assert.equal((await f.richiesta('/_nodo/poll?id=prova', null, {
    'x-amr-node-boot': nuovo.boot, 'x-amr-center-epoch': nuovo.epoca })).status, 204);
  assert.equal(f.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(job.idLavoro).stato, 'incerto');
});
