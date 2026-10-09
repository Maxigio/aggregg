'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
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

async function setup(t, opzioni = {}, verifica = async s => contesto(s), crea = creaCentro) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-limiti-ricerca-'));
  const sessions = new Map();
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64) };
  const centro = crea({ tokens, directory, timeoutMs: 3000, ...opzioni,
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
    sessions.set(cookie, { persona, azienda, scadenza: Date.now() + 3600000 }); return cookie;
  };
  const cerca = (cookie, query = 'tipo=auto&marca=Fiat', origine = url) => {
    const ctrl = new AbortController(); controllers.push(ctrl);
    const promise = fetch(origine + '/api/search?' + query, { headers: { cookie }, signal: ctrl.signal });
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
  const avvia = (cookie, id = randomUUID(), input = { tipo: 'auto', marca: 'Fiat' }) => fetch(url + '/api/ricerche', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id, input }) });
  const consulta = (cookie, id, method = 'GET') => fetch(url + '/api/ricerche/' + id, { method, headers: { cookie } });
  const conclusa = async (cookie, id) => {
    for (let i = 0; i < 100; i++) {
      const r = await consulta(cookie, id); assert.equal(r.status, 200); const data = await r.json();
      if (data.esito) return data;
      await pausa(5);
    }
    assert.fail('esito non ricevuto');
  };
  return { centro, sessione, cerca, nodo, heartbeat, attendi, poll, esito, url, avvia, consulta, conclusa };
}

for (const tipo of ['auto', 'moto'])
test(`protocollo breve ${tipo}: POST ripetuto e GET ripetuti non consegnano un secondo lavoro`, async t => {
  const f = await setup(t), cookie = f.sessione('persona-a'), id = randomUUID();
  await f.heartbeat('a'); await f.heartbeat('b');
  const input = { tipo, marca: 'MarcaSintetica' };
  const primi = await Promise.all([f.avvia(cookie, id, input), f.avvia(cookie, id, input)]);
  for (const r of primi) { assert.equal(r.status, 202); assert.equal((await r.json()).id, id); }
  const job = await f.poll(), record = f.centro.lavori.get(job.idLavoro);
  assert.equal(record.destinatari.size, 1);
  for (let i = 0; i < 3; i++) {
    assert.equal((await (await f.consulta(cookie, id)).json()).stato, 'in_corso');
    assert.equal((await f.avvia(cookie, id, input)).status, 202);
  }
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  await f.esito('a', job);
  const prima = await f.conclusa(cookie, id), seconda = await (await f.consulta(cookie, id)).json();
  assert.deepEqual(prima.esito, seconda.esito);
  assert.equal(prima.esito.status, 200); assert.equal(prima.esito.body.risultati[0].id, 'sintetico');
  assert.equal(typeof prima.esito.body.risultati[0].accessoDettagli, 'string');
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE operazione='ricerca'").get().n, 1);
});

test('protocollo breve: risposta del POST persa dopo ammissione, il GET ritrova lo stesso lavoro', async t => {
  const f = await setup(t), cookie = f.sessione('persona-a'), id = randomUUID();
  await f.heartbeat('a');
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(f.url + req.url, { method: req.method, headers: {
      cookie: req.headers.cookie, 'content-type': 'application/json' } }, risposta => {
      assert.equal(risposta.statusCode, 202);
      risposta.resume(); risposta.once('end', () => res.destroy());
    });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  await assert.rejects(fetch(`http://127.0.0.1:${proxy.address().port}/api/ricerche`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ id, input: { tipo: 'auto', marca: 'Fiat' } }) }));
  assert.equal((await (await f.consulta(cookie, id)).json()).stato, 'in_corso');
  const job = await f.poll(); await f.esito('a', job); await f.conclusa(cookie, id);
  assert.equal((await f.avvia(cookie, id)).status, 202);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 1);
});

test('protocollo breve: due aziende condividono solo l’esecuzione, GET ed autorizzazioni restano separati', async t => {
  const f = await setup(t), a = f.sessione('a'), b = f.sessione('b', 'b', 'aziendaB'),
    idA = randomUUID(), idB = randomUUID();
  await f.heartbeat('a');
  await f.avvia(a, idA); const job = await f.poll(); await f.avvia(b, idB);
  await f.attendi(() => f.centro.lavori.get(job.idLavoro).destinatari.size === 2);
  await f.esito('a', job);
  const outA = await f.conclusa(a, idA), outB = await f.conclusa(b, idB);
  assert.notEqual(outA.esito.body.risultati[0].accessoDettagli, outB.esito.body.risultati[0].accessoDettagli);
  assert.equal((await f.consulta(a, idB)).status, 404);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE operazione='ricerca'").get().n, 1);
});

test('protocollo breve: ID isolato per sessione e azienda, stessa chiave con filtri diversi rifiutata', async t => {
  const f = await setup(t), a = f.sessione('a'), stessoUtente = f.sessione('altra-sessione', 'a'),
    b = f.sessione('b', 'b', 'aziendaB'), id = randomUUID();
  await f.heartbeat('a'); assert.equal((await f.avvia(a, id)).status, 202);
  const job = await f.poll();
  assert.equal((await f.avvia(a, id, { tipo: 'auto', marca: 'Ford' })).status, 409);
  for (const cookie of [stessoUtente, b]) {
    for (const method of ['GET', 'DELETE']) assert.equal((await f.consulta(cookie, id, method)).status, 404);
    assert.equal((await f.avvia(cookie, id)).status, 404);
  }
  await f.esito('a', job); await f.conclusa(a, id);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 1);
});

test('protocollo breve: quota resta occupata dopo il 202 e viene liberata alla conclusione', async t => {
  const f = await setup(t, { maxPersona: 1 }), cookie = f.sessione('a'), id = randomUUID();
  await f.heartbeat('a'); await f.heartbeat('b');
  assert.equal((await f.avvia(cookie, id)).status, 202);
  assert.equal((await f.avvia(cookie)).status, 429);
  assert.equal((await f.avvia(cookie, id)).status, 202, 'Un replay non occupa un altro posto');
  const job = await f.poll(); await f.esito('a', job); await f.conclusa(cookie, id);
  assert.equal((await f.avvia(cookie)).status, 202);
});

test('protocollo breve: permessi correnti prima della consegna, modulo non acquistato negato', async t => {
  let revocata = false;
  const f = await setup(t, {}, async s => {
    if (revocata) throw Object.assign(new Error('revocata'), { status: 403 });
    return { ...contesto(s), moduli: ['moto'] };
  }), cookie = f.sessione('a'), id = randomUUID();
  await f.heartbeat('a'); assert.equal((await f.avvia(cookie)).status, 403);
  assert.equal((await f.avvia(cookie, id, { tipo: 'moto', marca: 'Yamaha' })).status, 202);
  const job = await f.poll(); await f.esito('a', job); await f.conclusa(cookie, id);
  revocata = true;
  const r = await f.consulta(cookie, id); assert.equal(r.status, 403);
  assert.equal((await r.json()).esito, undefined);
});

test('protocollo breve: abbandono in coda ritira il lavoro, avviato termina senza nuovi recuperi', async t => {
  const f = await setup(t), cookie = f.sessione('a'), id = randomUUID();
  await f.heartbeat('a'); await f.heartbeat('b');
  assert.equal((await f.avvia(cookie, id)).status, 202);
  await f.attendi(() => f.centro.lavori.size === 1);
  assert.equal((await f.consulta(cookie, id, 'DELETE')).status, 200);
  await f.attendi(() => f.centro.lavori.size === 0);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  const secondo = randomUUID(); assert.equal((await f.avvia(cookie, secondo)).status, 202);
  const job = await f.poll(); assert.equal((await f.consulta(cookie, secondo, 'DELETE')).status, 200);
  await f.esito('a', job, risposta({ subito: { status: 'error', erroreHttp: 429 } }));
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  const r = await f.consulta(cookie, secondo); assert.equal(r.status, 410); assert.equal((await r.json()).esito, undefined);
});

test('protocollo breve: rileggere un vecchio esito non riporta la pagina successiva al nodo precedente', async t => {
  let tempo = Date.now();
  const f = await setup(t, { ora: () => tempo }), cookie = f.sessione('a'),
    prima = randomUUID(), seconda = randomUUID();
  await f.heartbeat('a'); await f.heartbeat('b');
  await f.avvia(cookie, prima); let job = await f.poll(); await f.esito('a', job); await f.conclusa(cookie, prima);
  tempo += 10; f.centro.nodi.get('a').sospeso = true;
  await f.avvia(cookie, seconda); job = await f.poll('b'); await f.esito('b', job); await f.conclusa(cookie, seconda);
  f.centro.nodi.get('a').sospeso = false;
  assert.equal((await f.consulta(cookie, prima)).status, 200);
  await f.avvia(cookie, randomUUID(), { tipo: 'auto', marca: 'Fiat', fetta: '1', fonti: 'autoscout' });
  await f.attendi(() => f.centro.lavori.size === 1);
  const record = [...f.centro.lavori.values()][0];
  assert.equal(record.nodoAssegnato, 'b');
});

test('protocollo breve: prima consegna tardiva con timestamp uguali preserva il nodo più recente', async t => {
  const tempo = Date.now(), f = await setup(t, { ora: () => tempo }), cookie = f.sessione('a'),
    prima = randomUUID(), seconda = randomUUID();
  await f.heartbeat('a'); await f.heartbeat('b');
  await f.avvia(cookie, prima); let job = await f.poll(); await f.esito('a', job);
  assert.equal((await (await f.avvia(cookie, prima)).json()).stato, 'conclusa', 'Non consegna ancora R1');
  f.centro.nodi.get('a').sospeso = true;
  await f.avvia(cookie, seconda); job = await f.poll('b'); await f.esito('b', job); await f.conclusa(cookie, seconda);
  f.centro.nodi.get('a').sospeso = false;
  await f.conclusa(cookie, prima);
  await f.avvia(cookie, randomUUID(), { tipo: 'auto', marca: 'Fiat', fetta: '1', fonti: 'autoscout' });
  await f.attendi(() => f.centro.lavori.size === 1);
  assert.equal([...f.centro.lavori.values()][0].nodoAssegnato, 'b');
});

test('protocollo breve: deadline invariata dai GET, errore consultabile senza replay del lavoro', async t => {
  const f = await setup(t, { timeoutRicercaMs: 200 }), cookie = f.sessione('a'), id = randomUUID();
  await f.heartbeat('a'); assert.equal((await f.avvia(cookie, id)).status, 202);
  const job = await f.poll();
  for (let i = 0; i < 3; i++) { await f.consulta(cookie, id); await pausa(20); }
  const out = await f.conclusa(cookie, id);
  assert.equal(out.esito.status, 504); assert.equal(out.esito.body.incerto, true);
  assert.equal(out.esito.body.risultati, undefined);
  // Il timer del lavoro è distinto da quello della ricerca: come negli altri test di deadline,
  // l'esito tardivo si invia dopo che il lavoro è scaduto.
  await f.attendi(() => !f.centro.lavori.size);
  assert.equal((await f.esito('a', job)).status, 409);
  assert.equal((await f.avvia(cookie, id)).status, 202);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  assert.equal(f.centro.db.prepare('SELECT count(*) AS n FROM lavori').get().n, 1);
});

// Solo laboratorio: i punti di taglio sono espliciti, non una simulazione
// della configurazione privata Nhost. Il browser fa un GET; il proxy può farne due.
async function proxyControllato(t, origine) {
  const ingressi = [], pendenti = new Set();
  const server = http.createServer((req, res) => {
    const ingresso = { tentativi: [], interrompi: null, riprova: null };
    let corrente;
    ingressi.push(ingresso);
    function inoltra() {
      const tentativo = { interrotto: false, chiuso: false };
      ingresso.tentativi.push(tentativo);
      const upstream = http.get(origine + req.url, {
        headers: { cookie: req.headers.cookie }, agent: false,
      }, risposta => {
        res.writeHead(risposta.statusCode, risposta.headers);
        risposta.on('error', () => res.destroy()); risposta.pipe(res);
      });
      corrente = upstream;
      pendenti.add(upstream);
      upstream.on('error', () => { if (!tentativo.interrotto) res.destroy(); });
      upstream.once('close', () => { tentativo.chiuso = true; pendenti.delete(upstream); });
      ingresso.interrompi = () => {
        assert.equal(res.headersSent, false);
        tentativo.interrotto = true; upstream.destroy();
      };
    }
    ingresso.riprova = () => {
      assert.equal(ingresso.tentativi.length, 1, 'un solo retry del proxy');
      assert.equal(ingresso.tentativi[0].chiuso, true);
      assert.equal(res.headersSent, false); inoltra();
    };
    res.once('close', () => {
      if (!res.writableEnded) corrente?.destroy();
    });
    inoltra();
  });
  t.after(async () => {
    for (const p of pendenti) p.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, ingressi };
}

for (const tipo of ['auto', 'moto'])
test(`diagnosi ingress ${tipo}: un solo GET browser, retry dopo il taglio crea due lavori avviati`, async t => {
  const f = await setup(t), proxy = await proxyControllato(t, f.url);
  await f.heartbeat('a'); await f.heartbeat('b');
  const cookie = f.sessione('persona-a');
  const richiesta = f.cerca(cookie, `tipo=${tipo}&marca=MarcaSintetica`, proxy.url);
  const primo = await f.poll('a'), record = f.centro.lavori.get(primo.idLavoro);
  assert.equal(proxy.ingressi.length, 1); assert.equal(record.destinatari.size, 1);
  proxy.ingressi[0].interrompi();
  await f.attendi(() => !record.destinatari.size && proxy.ingressi[0].tentativi[0].chiuso);
  assert.equal(f.centro.nodi.get('a').occupato, true, 'il lavoro già avviato termina');
  proxy.ingressi[0].riprova();
  const secondo = await f.poll('b');
  assert.notEqual(primo.idLavoro, secondo.idLavoro);
  assert.deepEqual(primo.input, secondo.input);
  assert.equal(primo.azienda, secondo.azienda);
  // Conteggia consegne reali del centro, non inventa un numero di chiamate ai portali.
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE stato='in_corso'").get().n, 2);
  assert.equal((await f.esito('a', primo, risposta({ subito: { status: 'error', erroreHttp: 429 } }))).status, 200);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204, 'nessun recupero del lavoro abbandonato');
  const nuovo = { ...risposta(), risultati: [{ id: 'secondo', fonte: 'autoscout',
    url: 'https://www.autoscout24.it/annunci/secondo-sintetico' }] };
  await f.esito('b', secondo, nuovo);
  const ricevuta = await richiesta.promise;
  assert.equal(ricevuta.status, 200);
  assert.deepEqual((await ricevuta.json()).risultati.map(r => r.id), ['secondo']);
  assert.equal(proxy.ingressi.length, 1); assert.equal(proxy.ingressi[0].tentativi.length, 2);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE operazione='ricerca'").get().n, 2);
  assert.equal(f.centro.lavori.size, 0);
});

test('diagnosi ingress: taglio prima del poll non duplica un lavoro avviato', async t => {
  const f = await setup(t), proxy = await proxyControllato(t, f.url);
  await f.heartbeat('a');
  const richiesta = f.cerca(f.sessione('persona-a'), undefined, proxy.url);
  await f.attendi(() => f.centro.lavori.size === 1);
  const id = [...f.centro.lavori.keys()][0];
  proxy.ingressi[0].interrompi();
  await f.attendi(() => f.centro.lavori.size === 0 && proxy.ingressi[0].tentativi[0].chiuso);
  assert.equal(f.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(id).stato, 'interrotto');
  proxy.ingressi[0].riprova();
  const job = await f.poll(); await f.esito('a', job);
  assert.equal((await richiesta.promise).status, 200);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE stato='concluso'").get().n, 1);
});

test('diagnosi ingress: con un nodo il retry aspetta, poi consegna la stessa ricerca una seconda volta', async t => {
  const f = await setup(t), proxy = await proxyControllato(t, f.url);
  await f.heartbeat('a');
  const richiesta = f.cerca(f.sessione('persona-a'), undefined, proxy.url);
  const primo = await f.poll(), record = f.centro.lavori.get(primo.idLavoro);
  proxy.ingressi[0].interrompi();
  await f.attendi(() => !record.destinatari.size && proxy.ingressi[0].tentativi[0].chiuso);
  proxy.ingressi[0].riprova();
  await f.attendi(() => f.centro.nodi.get('a').coda.length === 1);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  await f.esito('a', primo);
  const secondo = await f.poll();
  assert.notEqual(secondo.idLavoro, primo.idLavoro); assert.deepEqual(secondo.input, primo.input);
  await f.esito('a', secondo); assert.equal((await richiesta.promise).status, 200);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE stato='concluso'").get().n, 2);
});

test('diagnosi ingress: un altro destinatario mantiene la condivisione anche dopo il taglio', async t => {
  const f = await setup(t), proxy = await proxyControllato(t, f.url);
  await f.heartbeat('a'); await f.heartbeat('b');
  const cookieA = f.sessione('persona-a'), cookieB = f.sessione('persona-b', 'persona-b', 'aziendaB');
  const a = f.cerca(cookieA, undefined, proxy.url), job = await f.poll();
  const record = f.centro.lavori.get(job.idLavoro), b = f.cerca(cookieB);
  await f.attendi(() => record.destinatari.size === 2);
  proxy.ingressi[0].interrompi();
  await f.attendi(() => record.destinatari.size === 1 && proxy.ingressi[0].tentativi[0].chiuso);
  proxy.ingressi[0].riprova();
  await f.attendi(() => record.destinatari.size === 2);
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  await f.esito('a', job);
  const [ra, rb] = await Promise.all([a.promise, b.promise]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  const [ba, bb] = await Promise.all([ra.json(), rb.json()]);
  assert.deepEqual(ba.risultati.map(r => r.id), bb.risultati.map(r => r.id));
  assert.equal(typeof ba.risultati[0].accessoDettagli, 'string');
  assert.equal(typeof bb.risultati[0].accessoDettagli, 'string');
  assert.notEqual(ba.risultati[0].accessoDettagli, bb.risultati[0].accessoDettagli);
  assert.equal(f.centro.db.prepare("SELECT count(*) AS n FROM lavori WHERE operazione='ricerca'").get().n, 1);
});

test('diagnosi ingress: il 504 applicativo in coda attraversa il proxy senza annunci', async t => {
  let mono = 0;
  const f = await setup(t, { timeoutRicercaMs: 60000, oraMono: () => mono });
  const proxy = await proxyControllato(t, f.url);
  await f.heartbeat('a');
  const richiesta = f.cerca(f.sessione('persona-a'), undefined, proxy.url);
  await f.attendi(() => f.centro.lavori.size === 1);
  mono = 60000;
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  const r = await richiesta.promise, body = await r.json();
  assert.equal(r.status, 504); assert.equal(body.codice, 'ricerca_scaduta');
  assert.equal(body.risultati, undefined); assert.equal(body.incerto, false);
  assert.equal(proxy.ingressi.length, 1); assert.equal(proxy.ingressi[0].tentativi.length, 1);
});

test('diagnosi ingress: deadline reale sul lavoro avviato consegna esito incerto, senza annunci', async t => {
  const f = await setup(t, { timeoutRicercaMs: 500 }), proxy = await proxyControllato(t, f.url);
  await f.heartbeat('a');
  const richiesta = f.cerca(f.sessione('persona-a'), undefined, proxy.url);
  const job = await f.poll();
  const r = await richiesta.promise, body = await r.json();
  assert.equal(r.status, 504); assert.equal(body.incerto, true);
  assert.equal(body.codice, 'ricerca_scaduta'); assert.equal(body.risultati, undefined);
  await f.attendi(() => !f.centro.lavori.size);
  assert.equal((await f.esito('a', job)).status, 409);
  assert.equal(proxy.ingressi[0].tentativi.length, 1);
  assert.equal(f.centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(job.idLavoro).stato, 'incerto');
});

test('deadline: il timer del lavoro conserva la causa anche se precede quello della ricerca', async t => {
  const vm = require('node:vm'), file = path.resolve(__dirname, '../backend/nodi/centro.js');
  for (const localePiuBreve of [false, true]) {
    const timers = [], copia = { exports: {} };
    vm.compileFunction(fs.readFileSync(file, 'utf8'),
      ['exports', 'require', 'module', '__filename', '__dirname', 'setTimeout'], { filename: file })(
      copia.exports, require('node:module').createRequire(file), copia, file, path.dirname(file), (fn, ms) => {
        const id = setTimeout(() => {}, 3600000).unref();
        timers.push({ fn: () => { clearTimeout(id); fn(); }, ms }); return id;
      });
    let mono = 0;
    const f = await setup(t, { timeoutRicercaMs: 60000,
      timeoutMs: localePiuBreve ? 1000 : 90000, oraMono: () => mono }, undefined, copia.exports.creaCentro);
    await f.heartbeat('a');
    const richiesta = f.cerca(f.sessione('persona-a')), job = await f.poll();
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, localePiuBreve ? 1000 : 60000);
    // Solo il callback del lavoro viene eseguito: la deadline globale non ha ancora eseguito il proprio.
    mono = timers[0].ms; timers[0].fn();
    const r = await richiesta.promise, body = await r.json();
    assert.equal(r.status, 504); assert.equal(body.incerto, true);
    assert.equal(body.codice, localePiuBreve ? undefined : 'ricerca_scaduta');
    assert.equal(body.risultati, undefined);
    assert.equal((await f.esito('a', job)).status, 409);
  }
});

for (const composta of [false, true]) for (const primaPersona of ['a', 'b'])
test('affinità: revoca lenta di A non blocca B; creatore ' + primaPersona + ', composta ' + composta, async t => {
  let mono = 0, finale = false;
  const gate = differita(); t.after(() => gate.resolve());
  const f = await setup(t, { timeoutRicercaMs: 60000, oraMono: () => mono }, async s => {
    if (finale && s.persona === 'a') {
      await gate.promise;
      throw Object.assign(new Error('revoca_sintetica'), { status: 403 });
    }
    return contesto(s);
  });
  await f.heartbeat('a');
  if (composta) await f.heartbeat('b');
  const cookieA = f.sessione('cookie-a', 'a', 'aziendaA'), cookieB = f.sessione('cookie-b', 'b', 'aziendaB');
  const richieste = { [primaPersona]: f.cerca(primaPersona === 'a' ? cookieA : cookieB) };
  await f.attendi(() => f.centro.lavori.size === 1);
  const secondaPersona = primaPersona === 'a' ? 'b' : 'a';
  richieste[secondaPersona] = f.cerca(secondaPersona === 'a' ? cookieA : cookieB);
  await f.attendi(() => [...f.centro.lavori.values()][0]?.destinatari.size === 2);
  const job = await f.poll();
  if (composta) {
    await f.esito('a', job, risposta({ subito: { status: 'error', erroreHttp: 429, count: 0 } }));
    const alternativo = await f.poll('b'); mono = 58000; finale = true;
    await f.esito('b', alternativo, { ...risposta({ subito: { status: 'ok', count: 1 } }),
      risultati: [{ id: 'subito-sintetico', fonte: 'subito', url: 'https://www.subito.it/annunci/sintetico' }] });
  } else { mono = 58000; finale = true; await f.esito('a', job); }
  const anticipataB = await Promise.race([richieste.b.promise, pausa(500).then(() => null)]);
  mono = 61000; gate.resolve();
  const [ra, rb] = await Promise.all([richieste.a.promise, richieste.b.promise]);
  const [bodyA, bodyB] = await Promise.all([ra.json(), rb.json()]);
  assert.equal(rb.status, 200);
  assert.equal(anticipataB?.status, 200, 'B deve rispondere mentre A attende');
  assert.equal(bodyB.risultati.length, composta ? 2 : 1);
  assert.ok([403, 504].includes(ra.status));
  assert.equal(bodyA.risultati, undefined);
  assert.equal(Object.hasOwn(bodyB, 'registraAffinita'), false);
});

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
  // Il vecchio job termina su A; la nuova ricerca distinta può usare B libero.
  await f.attendi(() => f.centro.nodi.get('b').coda.length === 1);
  const nuovoJob = await f.poll('b'); assert.notEqual(nuovoJob.idLavoro, job.idLavoro);
  assert.equal((await f.esito('a', job, risposta({ subito: { status: 'error', erroreHttp: 429 } }))).status, 200);
  assert.equal((await f.nodo('a', 'poll?id=a')).status, 204);
  assert.equal((await f.nodo('b', 'poll?id=b')).status, 204);
  await f.esito('b', nuovoJob); assert.equal((await nuova.promise).status, 200);
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

test('O02: budget comprende il controllo finale HTTP, nessun annuncio alla scadenza', async t => {
  let mono = 0, finale = false, entrata = false; const gate = differita();
  t.after(() => gate.resolve());
  const f = await setup(t, { timeoutRicercaMs: 1000, oraMono: () => mono }, async s => {
    if (finale) { entrata = true; await gate.promise; }
    return contesto(s);
  });
  await f.heartbeat('a'); const richiesta = f.cerca(f.sessione('persona-a')), job = await f.poll();
  finale = true; await f.esito('a', job); await f.attendi(() => entrata);
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
