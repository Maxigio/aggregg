'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creaCentro } = require('../backend/nodi/centro');
const { creaBudgetRicerca, creaLimitiRicerca, TEMPO_RICERCA_MS } = require('../backend/nodi/limiti-ricerca');

const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));
function differita() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const contesto = s => ({ persona: s.persona, azienda: s.azienda,
  aziendaValida: true, moduli: ['auto', 'moto'] });
const risposta = (sources = {}) => ({ risultati: [{ id: 'sintetico', fonte: 'autoscout',
  url: 'https://www.autoscout24.it/annunci/sintetico' }], totale: 1,
  sources: { subito: { status: 'empty', count: 0 }, autoscout: { status: 'ok', count: 1 },
    moto: { status: 'empty', count: 0 }, ...sources } });

async function setup(t, opzioni = {}, verifica = async s => contesto(s)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-limiti-ricerca-'));
  const sessions = new Map();
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64) };
  const centro = creaCentro({ tokens, directory, timeoutMs: 3000, ...opzioni,
    inizializzaAccessi: () => ({ sessione: req => sessions.get(req.headers.cookie),
      verifica: (...args) => verifica(...args), close() {} }) });
  const server = await new Promise(resolve => {
    const s = centro.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const controllers = [];
  const richieste = [];
  t.after(async () => {
    centro.close();
    for (const c of controllers) c.abort();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled(richieste);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sessione = (cookie, persona = cookie, azienda = 'aziendaA') => {
    sessions.set(cookie, { persona, azienda }); return cookie;
  };
  const cerca = (cookie, query = 'tipo=auto&marca=Fiat') => {
    const ctrl = new AbortController(); controllers.push(ctrl);
    const promise = fetch(url + '/api/search?' + query, { headers: { cookie }, signal: ctrl.signal });
    promise.catch(() => {}); richieste.push(promise);
    return { promise, abort: () => ctrl.abort() };
  };
  const nodo = (id, route, body) => fetch(url + '/_nodo/' + route, {
    method: body ? 'POST' : 'GET', headers: { 'x-amr-node-token': tokens[id],
      'x-amr-node-id': id, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ id, ...body }) } : {}) });
  const heartbeat = (id, fonti = {}) => nodo(id, 'heartbeat', {
    revisione: 'imac-1', fonti, occupato: false });
  const attendi = async condizione => {
    for (let i = 0; i < 100; i++) {
      if (condizione()) return;
      await pausa(5);
    }
    assert.fail('condizione non raggiunta');
  };
  const poll = async (id = 'a') => {
    await attendi(() => centro.nodi.get(id)?.coda.length > 0);
    const r = await nodo(id, 'poll?id=' + id);
    assert.equal(r.status, 200); return r.json();
  };
  const esito = (id, job, body = risposta()) => nodo(id, 'esito', {
    idLavoro: job.idLavoro, tentativo: job.tentativo, esito: { status: 200, body } });
  return { centro, sessione, cerca, nodo, heartbeat, attendi, poll, esito };
}

test('O01: due richieste per persona anche tra sessioni, prima dei permessi asincroni', async t => {
  const gate = differita(); let verifiche = 0;
  const f = await setup(t, {}, async s => { verifiche++; await gate.promise; return contesto(s); });
  const cookieA = f.sessione('sessione-a', 'persona-a');
  const cookieB = f.sessione('sessione-b', 'persona-a');
  f.cerca(cookieA); f.cerca(cookieB);
  await f.attendi(() => verifiche >= 2);
  const terza = f.cerca(cookieA);
  const r = await Promise.race([terza.promise, pausa(150).then(() => null)]);
  assert.equal(r?.status, 429);
  assert.equal(verifiche, 2);
  assert.equal(f.centro.lavori.size, 0);
  gate.resolve();
});

test('O02: autorizzazione iniziale lenta scade e non accoda al completamento tardivo', async t => {
  const gate = differita();
  const f = await setup(t, { timeoutRicercaMs: 60 }, async s => { await gate.promise; return contesto(s); });
  await f.heartbeat('a');
  const r = await Promise.race([f.cerca(f.sessione('persona-a')).promise,
    pausa(200).then(() => null)]);
  assert.equal(r?.status, 504);
  assert.equal((await r.json()).codice, 'ricerca_scaduta');
  gate.resolve(); await pausa(20);
  assert.equal(f.centro.lavori.size, 0);
  assert.equal(f.centro.nodi.get('a').coda.length, 0);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 0);
});

test('limiti: default 60 secondi, configurazione validata, clock monotono e identità sintetiche', () => {
  assert.equal(TEMPO_RICERCA_MS, 60000);
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, '60', 2147483648]) {
    assert.throws(() => creaLimitiRicerca({ timeoutMs }), /timeout ricerca non valido/);
  }
  let mono = 0;
  const budget = creaBudgetRicerca({ timeoutMs: 100, oraMono: () => mono });
  assert.equal(budget.restante(), 100);
  mono = 99; assert.equal(budget.restante(), 1);
  mono = 100; assert.throws(() => budget.controlla(), e => e.codice === 'ricerca_scaduta');
  budget.chiudi();
  const limiti = creaLimitiRicerca();
  try {
    const a = limiti.ammetti({ identita: { persona: 'persona-a' } });
    const b = limiti.ammetti({ identita: { persona: 'persona-a' } });
    assert.throws(() => limiti.ammetti({ identita: { persona: 'persona-a' } }), e => e.status === 429);
    a.termina(); b.termina();
    const sessione = {}, prima = limiti.ammetti(sessione), seconda = limiti.ammetti(sessione);
    assert.throws(() => limiti.ammetti(sessione), e => e.status === 429);
    limiti.ammetti({}).termina(); // Sessione sintetica diversa, senza una persona disponibile.
    prima.termina(); seconda.termina();
    const account = limiti.ammetti({ identita: 'account-a' });
    limiti.ammetti({ identita: 'account-a' });
    assert.throws(() => limiti.ammetti({ identita: 'account-a' }), e => e.status === 429);
    account.termina(); account.termina(); // Rilascio idempotente.
  } finally { limiti.close(); }
});

test('O01: quote configurabili, interi positivi sicuri senza tetti operativi arbitrari', () => {
  for (const nome of ['maxPersona', 'maxTotale']) {
    for (const valore of [0, -1, NaN, Infinity, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => creaLimitiRicerca({ [nome]: valore }), new RegExp(nome + ' non valido'));
      assert.throws(() => creaCentro({ [nome]: valore }), new RegExp(nome + ' non valido'));
    }
  }
  const grandi = creaLimitiRicerca({ maxPersona: 100, maxTotale: 1000 }); grandi.close();
  const limiti = creaLimitiRicerca({ maxPersona: 3, maxTotale: 4 });
  try {
    const a = Array.from({ length: 3 }, () => limiti.ammetti({ persona: 'a' }));
    assert.throws(() => limiti.ammetti({ persona: 'a' }), e => e.status === 429);
    const b = limiti.ammetti({ persona: 'b' });
    assert.throws(() => limiti.ammetti({ persona: 'c' }), e => e.status === 429);
    a[0].termina(); a[0].termina();
    limiti.ammetti({ persona: 'c' });
    assert.throws(() => limiti.ammetti({ persona: 'd' }), e => e.status === 429);
    b.termina();
  } finally { limiti.close(); }
  const globale = creaLimitiRicerca({ maxPersona: 4, maxTotale: 1 });
  try {
    globale.ammetti({ persona: 'a' });
    assert.throws(() => globale.ammetti({ persona: 'b' }), e => e.status === 429);
  } finally { globale.close(); }
});

test('O01: creaCentro applica le quote configurate anche prima dei permessi', async t => {
  const gate = differita(); t.after(() => gate.resolve());
  let verifiche = 0;
  const f = await setup(t, { maxPersona: 1, maxTotale: 2 }, async s => {
    verifiche++; await gate.promise; return contesto(s);
  });
  const a = f.sessione('sessione-a', 'persona-a'), b = f.sessione('sessione-b', 'persona-b');
  const pa = f.cerca(a); await f.attendi(() => verifiche === 1);
  assert.equal((await f.cerca(a).promise).status, 429);
  const pb = f.cerca(b); await f.attendi(() => verifiche === 2);
  assert.equal((await f.cerca(f.sessione('persona-c')).promise).status, 429);
  assert.equal(verifiche, 2);
  gate.resolve();
  assert.equal((await pa.promise).status, 503); assert.equal((await pb.promise).status, 503);
});

test('O01: timeout/disconnessione non liberano verifiche realmente ancora in volo', async t => {
  const gate = differita(); t.after(() => gate.resolve());
  let verifiche = 0;
  const f = await setup(t, { timeoutRicercaMs: 100 }, async s => {
    verifiche++; await gate.promise; return contesto(s);
  });
  const cookie = f.sessione('persona-a');
  const a = f.cerca(cookie), b = f.cerca(cookie);
  await f.attendi(() => verifiche === 2);
  a.abort();
  assert.equal((await b.promise).status, 504);
  assert.equal((await f.cerca(cookie, 'tipo=auto&marca=Fiat&persona=falsa').promise).status, 429);
  assert.equal(verifiche, 2);
  gate.resolve(); await pausa(20);
  assert.equal((await f.cerca(cookie).promise).status, 503); // Ora l'ammissione passa: nessun nodo.
  assert.equal(f.centro.lavori.size, 0);
});

test('O01: cap di 60 destinatari anche su un solo job condiviso, callback rimossa sul close', async t => {
  const f = await setup(t);
  await f.heartbeat('a');
  const richieste = Array.from({ length: 60 }, (_, i) => f.cerca(f.sessione('persona-' + i)));
  await f.attendi(() => [...f.centro.lavori.values()][0]?.destinatari.size === 60);
  assert.equal(f.centro.lavori.size, 1);
  const lavoro = [...f.centro.lavori.values()][0];
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 60);
  const extra = f.sessione('persona-extra');
  assert.equal((await f.cerca(extra).promise).status, 429);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 60);
  richieste[1].abort();
  await f.attendi(() => lavoro.destinatari.size === 59);
  const ammessa = f.cerca(extra);
  await f.attendi(() => lavoro.destinatari.size === 60);
  const job = await f.poll(); await f.esito('a', job);
  assert.equal((await ammessa.promise).status, 200);
  for (const [i, richiesta] of richieste.entries()) {
    if (i !== 1) assert.equal((await richiesta.promise).status, 200);
  }
  assert.equal(lavoro.destinatari.size, 0);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso')").get().n, 0);
});

test('O01: cap globale anche prima delle autorizzazioni, non solo sulle callback', async t => {
  const gate = differita(); t.after(() => gate.resolve());
  let verifiche = 0;
  const f = await setup(t, {}, async s => { verifiche++; await gate.promise; return contesto(s); });
  const richieste = Array.from({ length: 60 }, (_, i) => f.cerca(f.sessione('persona-' + i)));
  await f.attendi(() => verifiche === 60);
  assert.equal((await f.cerca(f.sessione('persona-extra')).promise).status, 429);
  assert.equal(verifiche, 60); assert.equal(f.centro.lavori.size, 0);
  gate.resolve();
  for (const richiesta of richieste) assert.equal((await richiesta.promise).status, 503);
});

test('O01: coda piena di dieci persone resta consegnabile sotto le nuove quote', async t => {
  const f = await setup(t);
  await f.heartbeat('a');
  const richieste = Array.from({ length: 10 }, (_, i) => f.cerca(f.sessione('persona-' + i), 'tipo=auto&marca=Marca' + i));
  await f.attendi(() => f.centro.nodi.get('a').coda.length === 10);
  for (let i = 0; i < 10; i++) {
    const job = await f.poll(); await f.esito('a', job);
  }
  for (const richiesta of richieste) assert.equal((await richiesta.promise).status, 200);
});

test('O01: ultimo destinatario disconnesso elimina il job accodato e permette una nuova ricerca', async t => {
  const f = await setup(t); await f.heartbeat('a');
  const cookie = f.sessione('persona-a'), richiesta = f.cerca(cookie);
  await f.attendi(() => f.centro.lavori.size === 1);
  const id = [...f.centro.lavori.keys()][0];
  richiesta.abort(); await f.attendi(() => f.centro.lavori.size === 0);
  assert.equal(f.centro.nodi.get('a').coda.length, 0);
  assert.equal(f.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(id).stato, 'interrotto');
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  const nuova = f.cerca(cookie), job = await f.poll();
  assert.notEqual(job.idLavoro, id);
  await f.esito('a', job); assert.equal((await nuova.promise).status, 200);
});

test('O01: disconnessione del creatore lascia terminare il job condiviso utile a un altro', async t => {
  const f = await setup(t); await f.heartbeat('a');
  const a = f.cerca(f.sessione('persona-a')), b = f.cerca(f.sessione('persona-b'));
  await f.attendi(() => [...f.centro.lavori.values()][0]?.destinatari.size === 2);
  const job = await f.poll(), record = f.centro.lavori.get(job.idLavoro);
  a.abort(); await f.attendi(() => record.destinatari.size === 1);
  assert.equal(f.centro.lavori.has(job.idLavoro), true);
  assert.equal(f.centro.nodi.get('a').occupato, true);
  assert.equal((await f.esito('a', job)).status, 200);
  const r = await b.promise; assert.equal(r.status, 200);
  assert.equal((await r.json()).risultati.length, 1);
  assert.equal(record.destinatari.size, 0);
});

test('O01: tutti disconnessi dopo avvio, termina e scarta senza recuperi né riuso del job abbandonato', async t => {
  const f = await setup(t); await f.heartbeat('a'); await f.heartbeat('b');
  const cookie = f.sessione('persona-a'), richiesta = f.cerca(cookie);
  const job = await f.poll(), record = f.centro.lavori.get(job.idLavoro);
  richiesta.abort(); await f.attendi(() => record.destinatari.size === 0);
  assert.equal(f.centro.lavori.has(job.idLavoro), true);
  const nuova = f.cerca(cookie);
  await f.attendi(() => f.centro.nodi.get('a').coda.length === 1);
  assert.equal((await f.esito('a', job, risposta({ subito: { status: 'error', erroreHttp: 429 } }))).status, 200);
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  const nuovoJob = await f.poll(); assert.notEqual(nuovoJob.idLavoro, job.idLavoro);
  await f.esito('a', nuovoJob); assert.equal((await nuova.promise).status, 200);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE operazione='fonte'").get().n, 0);
});

test('O02: scadenza esatta in coda, nessuna consegna al worker e stato interrotto', async t => {
  let mono = 0;
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono });
  await f.heartbeat('a');
  const richiesta = f.cerca(f.sessione('persona-a'));
  await f.attendi(() => f.centro.lavori.size === 1);
  const id = [...f.centro.lavori.keys()][0]; mono = 1000;
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  const r = await richiesta.promise, body = await r.json();
  assert.equal(r.status, 504); assert.equal(body.incerto, false); assert.equal(body.interrotto, true);
  assert.equal(f.centro.lavori.size, 0);
  assert.equal(f.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(id).stato, 'interrotto');
});

test('O02: permessi del poll tardivi non avviano il lavoro già scaduto', async t => {
  let mono = 0, chiamate = 0; const gate = differita(), entrata = differita();
  t.after(() => gate.resolve());
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono }, async s => {
    if (++chiamate === 4) { entrata.resolve(); await gate.promise; }
    return contesto(s);
  });
  await f.heartbeat('a'); const richiesta = f.cerca(f.sessione('persona-a'));
  await f.attendi(() => f.centro.lavori.size === 1);
  const poll = f.nodo('a', 'poll?id=a'); await entrata.promise;
  mono = 1000; gate.resolve();
  assert.equal((await poll).status, 204); assert.equal((await richiesta.promise).status, 504);
  assert.equal(f.centro.lavori.size, 0); assert.equal(f.centro.nodi.get('a').occupato, false);
});

test('O02: primario e recuperi consumano un solo budget, senza nuovi job alla scadenza', async t => {
  let mono = 0;
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono });
  await f.heartbeat('a'); await f.heartbeat('b');
  const richiesta = f.cerca(f.sessione('persona-a'), 'tipo=moto&marca=Yamaha');
  const primary = await f.poll(); mono = 350;
  await f.esito('a', primary, risposta(Object.fromEntries(['subito', 'autoscout', 'moto']
    .map(fonte => [fonte, { status: 'error', erroreHttp: 429 }]))));
  const first = await f.poll('b'); assert.equal(first.fonte, 'subito'); mono = 700;
  await f.esito('b', first);
  const second = await f.poll('b'); assert.equal(second.fonte, 'autoscout'); mono = 1000;
  await f.esito('b', second);
  const r = await richiesta.promise; assert.equal(r.status, 504);
  assert.equal((await r.json()).risultati, undefined);
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 3);
});

test('O02: scadenza durante controllo di failover non avvia un secondo nodo', async t => {
  let mono = 0, chiamate = 0;
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono }, async s => {
    if (++chiamate === 5) mono = 1000;
    return contesto(s);
  });
  await f.heartbeat('a'); await f.heartbeat('b');
  const richiesta = f.cerca(f.sessione('persona-a')), job = await f.poll();
  await f.esito('a', job, risposta({ subito: { status: 'error', erroreHttp: 429 } }));
  assert.equal((await richiesta.promise).status, 504);
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 1);
});

for (const controllo of [5, 6]) test(`O02: budget comprende il controllo ${controllo === 5 ? 'affinità' : 'finale HTTP'}, nessun annuncio alla scadenza`, async t => {
  let mono = 0, chiamate = 0; const gate = differita(), entrata = differita();
  t.after(() => gate.resolve());
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono }, async s => {
    if (++chiamate === controllo) { entrata.resolve(); await gate.promise; }
    return contesto(s);
  });
  await f.heartbeat('a'); const richiesta = f.cerca(f.sessione('persona-a')), job = await f.poll();
  await f.esito('a', job); await entrata.promise;
  mono = 1000; gate.resolve();
  const r = await richiesta.promise, body = await r.json();
  assert.equal(r.status, 504); assert.equal(body.codice, 'ricerca_scaduta');
  assert.equal(body.risultati, undefined); assert.equal(body.incerto, false); assert.equal(body.interrotto, true);
  assert.equal(f.centro.lavori.size, 0);
});

test('O02: job avviato senza conferma alla deadline è incerto, tardivo rifiutato e nessun replay', async t => {
  const f = await setup(t, { timeoutRicercaMs: 120 });
  await f.heartbeat('a'); const richiesta = f.cerca(f.sessione('persona-a')), job = await f.poll();
  const r = await richiesta.promise, body = await r.json();
  assert.equal(r.status, 504); assert.equal(body.incerto, true); assert.equal(body.interrotto, false);
  await f.attendi(() => f.centro.lavori.size === 0);
  assert.equal(f.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(job.idLavoro).stato, 'incerto');
  assert.equal((await f.esito('a', job)).status, 409);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 1);
});

test('O02: aderire tardi a una ricerca condivisa non prolunga la deadline del job', async t => {
  let mono = 0;
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono });
  await f.heartbeat('a');
  const a = f.cerca(f.sessione('persona-a')), job = await f.poll();
  mono = 700; const b = f.cerca(f.sessione('persona-b'));
  await f.attendi(() => f.centro.lavori.get(job.idLavoro)?.destinatari.size === 2);
  mono = 1000; await f.esito('a', job);
  for (const richiesta of [a, b]) {
    const r = await richiesta.promise; assert.equal(r.status, 504);
    assert.equal((await r.json()).risultati, undefined);
  }
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE operazione='ricerca'").get().n, 1);
});

test('O02: anche la ricerca sintetica diretta senza callback non parte dopo la scadenza', async t => {
  let mono = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-limiti-diretta-'));
  const c = creaCentro({ tokens: { a: 'a'.repeat(64) }, directory,
    timeoutRicercaMs: 1000, oraMono: () => mono });
  t.after(() => { c.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  c.nodi.set('a', { id: 'a', visto: Date.now(), revisione: 'imac-1', coda: [],
    fonti: {}, sospese: new Set(), occupato: false });
  const pending = c.ricerca('aziendaA', { tipo: 'auto', marca: 'Fiat' });
  assert.equal(c.lavori.size, 1); mono = 1000;
  const handler = c.app.router.stack.find(l => l.route?.path === '/_nodo/poll').route.stack[0].handle;
  let status;
  await handler({ query: { id: 'a' }, get: k => k === 'x-amr-node-id' ? 'a' : undefined },
    { sendStatus: n => { status = n; }, json: () => assert.fail('job scaduto consegnato') });
  assert.equal(status, 204);
  await assert.rejects(pending, e => e.codice === 'ricerca_scaduta');
  assert.equal(c.lavori.size, 0);
  assert.equal(c.db.prepare('SELECT stato FROM lavori').get().stato, 'interrotto');
});
