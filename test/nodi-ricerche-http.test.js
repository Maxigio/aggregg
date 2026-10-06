'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { randomUUID } = require('node:crypto');
const { creaRicercheHttp } = require('../backend/nodi/ricerche-http');
const { creaLimitiRicerca } = require('../backend/nodi/limiti-ricerca');

async function fixture(t, opzioni = {}) {
  let ora = 0, chiamate = 0;
  const limiti = creaLimitiRicerca({ timeoutMs: 1000, maxPersona: opzioni.maxPendentiPersona ?? 1 });
  const s = { azienda: 'sintetica', persona: 'persona-sintetica' };
  const app = express();
  const servizio = creaRicercheHttp({ sessione: () => s, verifica: async identita => ({ azienda: identita.azienda }),
    valida: input => input, limiti, consegna: body => body, ora: () => ora,
    ttlRisultatoMs: 1000, ttlIdMs: 5000,
    ricerca: () => { chiamate++; return { status: 200, body: { risultati: [{ id: 'annuncio-sintetico' }] } }; },
    ...opzioni });
  servizio.mount(app);
  if (opzioni.secondoIngresso) servizio.mount(app, opzioni.secondoIngresso);
  const server = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.once('error', reject);
  });
  t.after(async () => {
    servizio.close(); limiti.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const avvia = (id = randomUUID(), identita, percorso = '/api/ricerche') => fetch(url + percorso, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(identita ? { 'x-identita-prova': identita } : {}) },
    body: JSON.stringify({ id, input: { tipo: 'auto', marca: 'Fiat' } }) });
  const consulta = (id, method = 'GET', identita, percorso = '/api/ricerche') => fetch(url + percorso + '/' + id,
    { method, headers: identita ? { 'x-identita-prova': identita } : {} });
  return { avvia, consulta, tempo: n => { ora = n; }, chiamate: () => chiamate };
}

test('ricerche HTTP: scadenza effettiva e tombstone impediscono il replay del risultato scaduto', async t => {
  const f = await fixture(t), id = randomUUID();
  assert.equal((await f.avvia(id)).status, 202);
  assert.equal((await (await f.consulta(id)).json()).esito.body.risultati[0].id, 'annuncio-sintetico');
  f.tempo(1000);
  let r = await f.consulta(id); assert.equal(r.status, 410);
  assert.equal((await r.json()).stato, 'scaduta');
  assert.equal((await f.avvia(id)).status, 202); assert.equal(f.chiamate(), 1);
  f.tempo(5000); r = await f.consulta(id); assert.equal(r.status, 404);
  assert.equal(f.chiamate(), 1);
});

test('ricerche HTTP: cap RAM esplicito conserva solo un errore, cleanup libera spazio', async t => {
  const f = await fixture(t, { maxByte: 90 }), primo = randomUUID(), secondo = randomUUID();
  await f.avvia(primo); await f.avvia(secondo);
  let data = await (await f.consulta(primo)).json(); assert.equal(data.esito.status, 200);
  data = await (await f.consulta(secondo)).json(); assert.equal(data.esito.status, 503);
  assert.equal(data.esito.body.codice, 'risultato_non_disponibile');
  assert.equal(data.esito.body.risultati, undefined);
  f.tempo(1000); const terzo = randomUUID(); await f.avvia(terzo);
  assert.equal((await (await f.consulta(terzo)).json()).esito.status, 200);
});

test('ricerche HTTP: cap degli ID non si aggira con esiti piccoli, scadenza libera il registro', async t => {
  const f = await fixture(t, { maxRegistri: 1 }), id = randomUUID();
  await f.avvia(id); assert.equal((await f.avvia()).status, 503); assert.equal(f.chiamate(), 1);
  f.tempo(5000); assert.equal((await f.avvia()).status, 202); assert.equal(f.chiamate(), 2);
});

test('ricerche HTTP: due ingressi condividono cap RAM, registro ID e cleanup', async t => {
  const percorso = '/api/admin/ricerche';
  const f = await fixture(t, { maxRegistri: 2, maxByte: 90,
    secondoIngresso: { percorso, contesto: 'proprietario',
      aziendaSessione: () => 'diagnostica:fixture', verifica: async () => ({ azienda: 'diagnostica:fixture' }) } });
  const a = randomUUID(), b = randomUUID();
  await f.avvia(a); assert.equal((await f.avvia(b, undefined, percorso)).status, 202);
  assert.equal((await (await f.consulta(a)).json()).esito.status, 200);
  assert.equal((await (await f.consulta(b, 'GET', undefined, percorso)).json()).esito.body.codice, 'risultato_non_disponibile');
  assert.equal((await f.avvia()).status, 503, 'Cap ID unico anche fra contesti');
  assert.equal((await f.consulta(a, 'GET', undefined, percorso)).status, 404);
  f.tempo(1000);
  assert.equal((await f.consulta(a)).status, 410); assert.equal((await f.consulta(b, 'GET', undefined, percorso)).status, 410);
  assert.equal((await f.avvia()).status, 503, 'Le tombstone restano conteggiate');
  f.tempo(5000); assert.equal((await f.avvia(randomUUID(), undefined, percorso)).status, 202);
});

test('ricerche HTTP: 50 ID per persona fra sessioni, 100 per azienda e posti separati', async t => {
  const sessioni = {
    a: { persona: 'p-a', azienda: 'azienda-a' },
    a2: { persona: 'p-a', azienda: 'azienda-a' },
    collega: { persona: 'p-collega', azienda: 'azienda-a' },
    b: { persona: 'p-b', azienda: 'azienda-b' },
  };
  const f = await fixture(t, { sessione: req => sessioni[req.headers['x-identita-prova'] || 'a'] });
  const id = randomUUID();
  for (let n = 0; n < 50; n++) assert.equal((await f.avvia(n === 0 ? id : randomUUID(), n % 2 ? 'a2' : 'a')).status, 202);
  let r = await f.avvia(randomUUID(), 'a2'); assert.equal(r.status, 429);
  assert.equal((await r.json()).codice, 'troppe_ricerche_registrate');
  assert.equal((await f.avvia(id, 'a')).status, 202, 'Retry valido anche a quota piena');
  assert.equal(f.chiamate(), 50);
  for (let n = 0; n < 50; n++) assert.equal((await f.avvia(randomUUID(), 'collega')).status, 202);
  const terzo = { persona: 'p-terzo', azienda: 'azienda-a' }; sessioni.terzo = terzo;
  r = await f.avvia(randomUUID(), 'terzo'); assert.equal(r.status, 429);
  assert.equal((await r.json()).codice, 'troppe_ricerche_registrate');
  assert.equal((await f.avvia(randomUUID(), 'b')).status, 202, 'A non occupa i posti di B');
  assert.equal(f.chiamate(), 101);
});

test('ricerche HTTP: errori e DELETE conservano le quote fino alla scadenza ID', async t => {
  let chiamate = 0;
  const f = await fixture(t, { maxRegistriPersona: 1, maxRegistriAzienda: 1,
    ricerca: () => { chiamate++; throw new Error('errore controllato'); } }), id = randomUUID();
  assert.equal((await f.avvia(id)).status, 202);
  assert.equal((await (await f.consulta(id)).json()).esito.status, 503);
  assert.equal((await f.consulta(id, 'DELETE')).status, 200);
  f.tempo(1000);
  assert.equal((await f.avvia()).status, 429, 'TTL del body non libera la tombstone');
  assert.equal((await f.avvia(id)).status, 202); assert.equal(chiamate, 1);
  f.tempo(5000); assert.equal((await f.avvia()).status, 202); assert.equal(chiamate, 2);
});

for (const stessoId of [false, true])
test(`ricerche HTTP: quota atomica dopo autorizzazioni concorrenti, stesso ID=${stessoId}`, async t => {
  let sblocca, entrati = 0, pronti;
  const gate = new Promise(resolve => { sblocca = resolve; }); t.after(sblocca);
  const entrambe = new Promise(resolve => { pronti = resolve; });
  const f = await fixture(t, { maxPendentiPersona: 2, maxRegistriPersona: 1, maxRegistriAzienda: 1,
    verifica: async () => { if (++entrati === 2) pronti(); await gate; return { azienda: 'sintetica' }; } });
  const id = randomUUID(), a = f.avvia(id), b = f.avvia(stessoId ? id : randomUUID());
  await entrambe; sblocca();
  const risposte = await Promise.all([a, b]);
  assert.deepEqual(risposte.map(r => r.status).sort(), stessoId ? [202, 202] : [202, 429]);
  assert.equal(f.chiamate(), 1);
});

test('ricerche HTTP: ripulisce gli ID scaduti durante una verifica lenta', async t => {
  let lenta = false, sblocca, entrata;
  const gate = new Promise(resolve => { sblocca = resolve; }); t.after(sblocca);
  const iniziata = new Promise(resolve => { entrata = resolve; });
  const f = await fixture(t, { maxRegistriPersona: 1, maxRegistriAzienda: 1,
    verifica: async () => { if (lenta) { entrata(); await gate; } return { azienda: 'sintetica' }; } });
  await f.avvia(); f.tempo(4000); lenta = true;
  const attesa = f.avvia(); await iniziata; f.tempo(5000); sblocca();
  assert.equal((await attesa).status, 202); assert.equal(f.chiamate(), 2);
});

for (const nome of ['maxRegistriPersona', 'maxRegistriAzienda'])
test(`ricerche HTTP: ${nome} richiede un intero positivo`, () => {
  for (const valore of [0, -1, 1.5, NaN, Infinity, '50']) {
    assert.throws(() => creaRicercheHttp({ [nome]: valore }), /limiti esiti non validi/);
  }
});

test('ricerche HTTP: errore sincrono del coordinatore termina e libera la quota, senza stack al client', async t => {
  const f = await fixture(t, { ricerca: () => { throw new Error('segreto-sintetico-non-esporre'); } });
  const id = randomUUID(); assert.equal((await f.avvia(id)).status, 202);
  const data = await (await f.consulta(id)).json(); assert.equal(data.esito.status, 503);
  assert.doesNotMatch(JSON.stringify(data), /segreto-sintetico/);
  assert.equal((await f.avvia()).status, 202, 'Il posto non resta incollato al throw');
  assert.equal((await f.consulta(id, 'DELETE')).status, 200, 'DELETE è valido anche dopo il completamento');
});

test('ricerche HTTP: esito non serializzabile resta un errore controllato e libera la quota', async t => {
  const f = await fixture(t, { ricerca: () => ({ status: 200, body: { valore: 1n } }) }), id = randomUUID();
  await f.avvia(id);
  assert.equal((await (await f.consulta(id)).json()).esito.status, 503);
  assert.equal((await f.avvia()).status, 202);
});

test('ricerche HTTP: timeout ID precedente al risultato è rifiutato', () => {
  assert.throws(() => creaRicercheHttp({ ttlRisultatoMs: 2000, ttlIdMs: 1000 }));
});

test('ricerche HTTP: DELETE ripetuto non rinnova la retention né prolunga il blocco del registro', async t => {
  const f = await fixture(t, { maxRegistri: 1 }), id = randomUUID();
  await f.avvia(id); await f.consulta(id, 'DELETE');
  f.tempo(4000); assert.equal((await f.consulta(id, 'DELETE')).status, 200);
  f.tempo(5000); assert.equal((await f.avvia()).status, 202);
});

for (const method of ['GET', 'DELETE', 'POST'])
test(`ricerche HTTP: ${method} con permessi lenti non usa un registro eliminato e sostituito`, async t => {
  let blocca = false, sblocca, entrata;
  const iniziata = new Promise(resolve => { entrata = resolve; });
  const gate = new Promise(resolve => { sblocca = resolve; }); t.after(sblocca);
  const f = await fixture(t, { verifica: async () => {
    if (blocca) { blocca = false; entrata(); await gate; }
    return { azienda: 'sintetica' };
  } }), id = randomUUID();
  await f.avvia(id); f.tempo(4000); blocca = true;
  const precedente = method === 'POST' ? f.avvia(id) : f.consulta(id, method);
  await iniziata; f.tempo(5000);
  assert.equal((await f.avvia(id)).status, 202); sblocca();
  assert.equal((await precedente).status, 404, 'La risposta non deve attestare la nuova operazione');
  assert.equal((await (await f.consulta(id)).json()).stato, 'conclusa'); assert.equal(f.chiamate(), 2);
});
