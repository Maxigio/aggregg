'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { creaCentro } = require('../backend/nodi/centro');
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function attendi(fn) {
  for (let i = 0; i < 300; i++) { if (fn()) return; await pausa(5); }
  throw Error('fixture_non_pronta');
}

test('poll disconnesso lascia il job in coda; il retry consegna solo al destinatario valido', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-poll-'));
  let ritarda = false, liberaA, liberaB;
  const verificati = [];
  const sessioni = new Map(['a', 'b'].map(persona => [persona, { persona, azienda: 'aziendaA' }]));
  const centro = creaCentro({ directory, tokens: { n: 'n'.repeat(64) }, timeoutMs: 10000,
    timeoutRicercaMs: 12000, inizializzaAccessi: () => ({ close() {},
      sessione: req => sessioni.get(req.headers.cookie),
      verifica: async s => {
        if (s.revocata) throw Object.assign(Error('revocato_sintetico'), { status: 403 });
        if (ritarda) {
          verificati.push(s.persona);
          if (s.persona === 'a') {
            await new Promise(r => { liberaA = r; });
            s.revocata = true;
            throw Object.assign(Error('revocato_sintetico'), { status: 403 });
          }
          if (!liberaB) await new Promise(r => { liberaB = r; });
        }
        return { azienda: s.azienda, aziendaValida: true, moduli: ['auto'] };
      } }) });
  const server = centro.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    liberaA?.(); liberaB?.(); centro.close(); server.closeAllConnections();
    await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'x-amr-node-id': 'n', 'x-amr-node-token': 'n'.repeat(64), 'content-type': 'application/json' };
  const node = (route, body, signal) => fetch(base + '/_nodo/' + route, { headers, signal,
    ...(body ? { method: 'POST', body: JSON.stringify({ id: 'n', ...body }) } : {}) });
  await (await node('heartbeat', { revisione: 'imac-1', occupato: false, fonti: {} })).text();
  const a = fetch(base + '/api/search?tipo=auto&marca=Fiat', { headers: { cookie: 'a' } });
  const b = fetch(base + '/api/search?tipo=auto&marca=Fiat', { headers: { cookie: 'b' } });
  await attendi(() => [...centro.lavori.values()][0]?.destinatari.size === 2);
  const job = [...centro.lavori.values()][0];
  ritarda = true;
  const controller = new AbortController();
  const poll = node('poll?id=n', undefined, controller.signal);
  // Attaccare il rejection handler prima dell'abort evita un rifiuto non gestito.
  const interrotto = assert.rejects(poll, e => e.name === 'AbortError');
  await attendi(() => liberaA);
  controller.abort(); await interrotto;
  await pausa(30); liberaA();
  await attendi(() => liberaB); liberaB();
  await attendi(() => !centro.nodi.get('n').pollInCorso);
  assert.equal(job.iniziato, false);
  assert.equal(centro.nodi.get('n').occupato, false);
  assert.equal(centro.nodi.get('n').coda[0], job);
  assert.equal(job.destinatari.size, 1);
  const r = await node('poll?id=n'); assert.equal(r.status, 200);
  const consegnato = await r.json(); assert.equal(consegnato.idLavoro, job.idLavoro);
  assert.deepEqual(verificati, ['a', 'b', 'b']);
  // La revoca è ancora verificata sul chiamante prima della risposta finale.
  ritarda = false;
  await (await node('esito', { idLavoro: job.idLavoro, tentativo: consegnato.tentativo,
    esito: { status: 200, body: { risultati: [], sources: {
      subito: { status: 'empty', hasMore: false }, autoscout: { status: 'empty', hasMore: false },
      moto: { status: 'skipped', hasMore: false },
    } } } })).text();
  const ra = await a, rb = await b;
  assert.equal(ra.status, 403); await ra.text();
  assert.equal(rb.status, 200); await rb.text();
});
