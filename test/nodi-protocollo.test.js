'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { creaCentro } = require('../backend/nodi/centro');

test('protocollo nodo: heartbeat obsoleti e boot sostituiti non modificano il lavoro corrente', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-protocollo-'));
  const centro = creaCentro({ directory, tokens: { a: 'a'.repeat(64) } });
  const server = centro.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => { centro.close(); server.closeAllConnections();
    await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  let protocollo = {};
  const req = (route, body, extra = protocollo) => fetch(url + '/_nodo/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: {
      'x-amr-node-token': 'a'.repeat(64), 'x-amr-node-id': 'a', 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const info = await (await req('registrazione')).json(), boot = crypto.randomUUID();
  assert.equal((await req('registrazione', { epoca: info.epoca, boot, precedente: null })).status, 200);
  protocollo = { 'x-amr-node-boot': boot, 'x-amr-center-epoch': info.epoca };
  const hb = (seq, lavoro) => req('heartbeat', { id: 'a', revisione: 'imac-1', sequenza: seq,
    fonti: { subito: { fermo: false }, autoscout: { fermo: false }, moto: { fermo: false } },
    occupato: !!lavoro, idLavoroAttivo: lavoro });
  await hb(1, null);
  const ricerca = centro.ricerca('aziendaA', { tipo: 'auto', marca: 'Fiat' });
  const job = await (await req('poll?id=a')).json();
  assert.ok(job.idLavoro);
  await hb(3, job.idLavoro);
  assert.equal((await (await hb(2, 'lavoro-precedente')).json()).accepted, false);
  assert.equal(centro.lavori.has(job.idLavoro), true);
  assert.equal(centro.nodi.get('a').occupato, true);
  // Retry della registrazione riuscita non azzera la sequenza già accettata.
  await req('registrazione', { epoca: info.epoca, boot, precedente: null });
  assert.equal(centro.nodi.get('a').sequenza, 3);
  const nuovo = crypto.randomUUID();
  await req('registrazione', { epoca: info.epoca, boot: nuovo, precedente: boot });
  assert.equal((await hb(4, job.idLavoro)).status, 409);
  assert.equal((await req('poll?id=a')).status, 409);
  assert.equal((await req('esito', { id: 'a', idLavoro: job.idLavoro, tentativo: job.tentativo,
    esito: { status: 200, body: {} } })).status, 409);
  assert.equal((await req('registrazione', { epoca: info.epoca, boot: crypto.randomUUID(), precedente: boot })).status, 409);
  protocollo['x-amr-node-boot'] = nuovo;
  const incerta = assert.rejects(ricerca, e => e.incerto);
  await hb(1, null); await incerta;
  let liberaPermessi;
  const seconda = centro.ricerca('aziendaA', { tipo: 'auto', marca: 'Ford' });
  const accodato = [...centro.lavori.values()][0];
  accodato.destinatari = new Set([() => new Promise(r => { liberaPermessi = r; })]);
  const pollPend = req('poll?id=a');
  for (let i=0;i<100&&!liberaPermessi;i++) await new Promise(r=>setTimeout(r,5));
  assert.ok(liberaPermessi);
  const terzo = crypto.randomUUID();
  await req('registrazione', { epoca: info.epoca, boot: terzo, precedente: nuovo });
  liberaPermessi();
  assert.equal((await pollPend).status, 409);
  assert.equal(accodato.iniziato, false);
  const interrotta = assert.rejects(seconda);
  centro.close(); await interrotta;
  protocollo['x-amr-center-epoch'] = crypto.randomUUID();
  assert.equal((await hb(2, null)).status, 409);
});
