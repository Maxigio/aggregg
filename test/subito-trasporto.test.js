'use strict';
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough, Duplex } = require('node:stream');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-subito-trasporto-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
require('dotenv').config = () => ({ parsed: {} });
const subito = require('../backend/scrapers/subito-api');
const salute = require('../backend/fonti-salute');
const get = https.get, request = https.request, now = Date.now;
https.request = () => assert.fail('rete non prevista nella prova');
afterEach(() => { https.get = get; Date.now = now; subito._setHttpGetJson(null); salute.azzera(); });
after(() => { https.request = request; salute._reset(); fs.rmSync(dir, { recursive: true, force: true }); });

// Si sostituisce solo la presa: parser, limiti, classificazione e salute restano reali.
// PassThrough conserva il comportamento error/close di uno stream distrutto.
function presa(producer) {
  const prese = [];
  https.get = (opts, cb) => {
    const req = new EventEmitter(), res = new PassThrough();
    const piano = producer(prese.length + 1, opts);
    const p = { req, res, bytes: 0, resume: 0, distruzioni: 0 };
    prese.push(p);
    Object.assign(res, { statusCode: piano.status, headers: piano.headers || {} });
    const resume = res.resume.bind(res);
    res.resume = () => { p.resume++; return resume(); };
    req.setTimeout = () => req;
    req.destroy = e => {
      if (req.destroyed) return req;
      req.destroyed = true; p.distruzioni++;
      res.destroy();
      // Gli eventi tardivi della presa non devono rimpiazzare il motivo HTTP.
      process.nextTick(() => {
        res.emit('aborted');
        res.emit('error', new Error('risposta interrotta dopo destroy'));
        req.emit('error', e || Object.assign(new Error('socket chiuso'), { code: 'ECONNRESET' }));
      });
      return req;
    };
    process.nextTick(() => {
      if (piano.primaHeader) { req.emit('error', piano.primaHeader); return; }
      cb(res);
      // Il contatore osserva i byte effettivamente consegnati al lettore.
      res.on('data', c => { p.bytes += Buffer.byteLength(c); });
      if (res.destroyed) return;
      if (piano.interrompi) {
        res.emit('aborted'); res.destroy(new Error('socket interrotto'));
      } else if (piano.lenta) {
        res.write(' ');
      } else if (piano.aperta) {
        res.write(Buffer.alloc(1024 * 1024, 'x'));
      } else res.end(piano.body || '');
    });
    return req;
  };
  return prese;
}
const cerca = () => subito({ tipo: 'auto', marca: 'Prova' }, { withMeta: true, senzaRecupero: true });
const corpoVuoto = JSON.stringify({ ads: [], count_all: 0 });

test('Subito: una risposta che resta attiva ma lentissima scade e chiude la presa', async () => {
  const nativeTimeout = global.setTimeout;
  const prese = presa(() => ({ status: 200, lenta: true }));
  global.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 45000 ? 25 : ms, ...args);
  try {
    await assert.rejects(Promise.race([
      cerca(), new Promise((_, reject) => nativeTimeout(() => reject(new Error('richiesta rimasta appesa')), 150)),
    ]), e => e.kind === 'transient' && /timeout/.test(e.message));
    assert.equal(prese[0].req.destroyed, true);
  } finally {
    global.setTimeout = nativeTimeout;
    prese[0]?.req.destroy();
  }
});

for (const caso of [
  { nome: 'oversized', body: 'x'.repeat(808291) },
  { nome: 'interrotto', interrompi: true },
]) {
  test(`Subito: 403 ${caso.nome} conserva lo status, conta una volta e chiude la presa`, async () => {
    const prese = presa(() => ({ ...caso, status: 403 }));
    for (let i = 0; i < 2; i++) {
      let errore;
      await assert.rejects(cerca(), e => { errore = e; return e.status === 403 && e.kind === 'blocked'; });
      salute.registra('subito', { errore }); // il riepilogo del chiamante non e' un secondo colpo
      await new Promise(setImmediate);
      assert.equal(salute.fermo('subito').fermo, i === 1);
      assert.equal(prese[i].req.destroyed, true);
      assert.equal(prese[i].bytes, 0, 'il body di errore non serve alla classificazione');
    }
    await assert.rejects(cerca(), { code: 'FONTE_IN_PAUSA' });
    assert.equal(prese.length, 2);
  });
}

test('Subito: il 429 chiude il download agli header e conserva Retry-After', async () => {
  const t = 2000000000000;
  Date.now = () => t;
  const prese = presa(() => ({ status: 429, headers: { 'retry-after': '86400' }, aperta: true }));
  await assert.rejects(subito.searchAccessori('faro prova', { cat: 'moto' }),
    e => e.status === 429 && e.kind === 'blocked' && e.retryAfter === '86400');
  await new Promise(setImmediate);
  assert.equal(prese[0].req.destroyed, true);
  assert.equal(prese[0].res.destroyed, true);
  assert.equal(prese[0].bytes, 0);
  assert.equal(salute.fermo('subito').fino, t + 86400000);
  await assert.rejects(cerca(), { code: 'FONTE_IN_PAUSA' });
  assert.equal(prese.length, 1);
});

test('Subito: ClientRequest e IncomingMessage reali chiudono il socket sui rifiuti, senza un server', async () => {
  // Il solo socket e' in memoria: nessun DNS/TCP, ma gli eventi di chiusura sono
  // quelli del client HTTP di Node, non l'implementazione della finta precedente.
  for (const status of [403, 429, 503]) {
    salute.azzera();
    let inviata = false, req;
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, cb) {
        cb();
        if (inviata) return;
        inviata = true;
        process.nextTick(() => socket.push(`HTTP/1.1 ${status} Prova\r\nContent-Length: 999999\r\nRetry-After: 120\r\n\r\n`));
      },
    });
    socket.setTimeout = () => socket;
    const agent = new http.Agent();
    agent.createConnection = () => socket;
    https.get = (_opts, cb) => (req = http.get({ host: 'local.invalid',
      agent, lookup: () => assert.fail('nessun DNS nella prova') }, cb));
    try {
      await assert.rejects(cerca(), e => e.status === status && e.retryAfter === '120');
      await new Promise(setImmediate);
      assert.equal(req.destroyed, true);
      assert.equal(socket.destroyed, true);
    } finally { req?.destroy(); socket.destroy(); agent.destroy(); }
  }
});

test('Subito: il 429 del recupero chiude la presa anche quando la ricerca restituisce la pagina nativa', async () => {
  const prese = presa(n => n === 1 ? { status: 200, body: JSON.stringify({ count_all: 1, ads: [{
    subject: 'Prova Modello', urls: { default: 'https://www.subito.it/auto/prova-1.htm' },
    features: [{ label: 'Prezzo', values: [{ value: '5000 €' }] }],
  }] }) } : { status: 429, aperta: true });
  const r = await subito({ tipo: 'auto', marca: 'Prova', modello: 'Modello', subitoNodo: {
    marcaId: 'trasporto-recupero', famigliaIds: ['111'], generazioni: [{ id: '111' }],
  } }, { withMeta: true });
  await new Promise(setImmediate);
  assert.equal(r.items.length, 1);
  assert.equal(r.bloccoParziale.status, 429);
  assert.equal(prese.length, 2);
  assert.equal(prese[1].req.destroyed, true);
  assert.equal(prese[1].bytes, 0);
});

test('Subito: 401/503 non diventano body illeggibili e non provocano un blocco', async () => {
  for (const [status, kind] of [[401, 'auth'], [503, 'transient']]) {
    const prese = presa(() => ({ status, interrompi: true }));
    await assert.rejects(cerca(), e => e.status === status && e.kind === kind);
    assert.equal(prese[0].req.destroyed, true);
    assert.equal(salute.fermo('subito').fermo, false);
  }
});

test('Subito: il limite 808290 resta sui 200, con errore distinto dal JSON malformato e dal socket', async () => {
  for (const [piano, accetta] of [
    [{ status: 200, body: 'x'.repeat(808291) }, e => e.code === 'SUBITO_BODY_TOO_LARGE' && e.kind === 'error'],
    [{ status: 200, body: '{' }, e => e.status === 200 && e.kind === 'blocked'],
    [{ status: 200, interrompi: true }, e => e.status === null && e.kind === 'transient'],
    [{ primaHeader: Object.assign(new Error('socket'), { code: 'ECONNRESET' }) }, e => e.code === 'ECONNRESET' && e.kind === 'transient'],
  ]) {
    salute.azzera();
    presa(() => piano);
    await assert.rejects(cerca(), accetta);
  }
  salute.azzera();
  presa(() => ({ status: 200, body: corpoVuoto.padEnd(808290, ' ') }));
  assert.deepEqual((await cerca()).items, []);
  assert.equal(salute.fermo('subito').fermo, false);
});

test('Subito: dopo la pausa, un JSON valido vuoto sblocca e un JSON rotto no', async () => {
  let t = 2000000000000;
  Date.now = () => t;
  salute.erroreHttp('subito', 429);
  t = salute.fermo('subito').fino + 1;
  presa(() => ({ status: 200, body: '{' }));
  await assert.rejects(cerca(), { kind: 'blocked' });
  assert.equal(salute.fermo('subito').fermo, true);
  t = salute.fermo('subito').fino + 1;
  presa(() => ({ status: 200, body: corpoVuoto }));
  const r = await cerca();
  assert.deepEqual(r.items, []);
  assert.equal(r.total, 0);
  assert.equal(salute.fermo('subito').fino, null);
});

const accessorio = n => ({ subject: `Faro prova ${n}`,
  urn: `id:ad:prova:list:${n}`, urls: { default: `https://www.subito.it/accessori-auto/prova-${n}.htm` },
  features: [{ label: 'Prezzo', values: [{ value: 'non leggibile' }] }],
});

test('mapAd: prezzo illeggibile e solo un booleano, distinto da assente, richiesta e zero', () => {
  for (const [prezzo, atteso] of [
    [undefined, [null, false, false]], ['non leggibile', [null, false, true]],
    ['su richiesta', [null, true, false]], ['0 €', [0, false, false]], ['25 €', [25, false, false]],
  ]) {
    const ad = accessorio(1);
    ad.features = prezzo === undefined ? [] : [{ uri: '/price', label: 'Prezzo', values: [{ value: prezzo }] }];
    ad.advertiser = { company: false, name: 'privato sintetico', user_id: '999' };
    ad.body = 'descrizione privata sintetica';
    const r = subito._mapAd(ad);
    assert.deepEqual([r.prezzo, !!r.prezzoSuRichiesta, r.prezzoIlleggibile], atteso);
    assert.equal(r.venditoreId, null);
    assert.equal(r.venditoreNome, null);
    assert.equal(r.descrizione, null);
    assert.equal(Object.hasOwn(r, 'prezzoRaw'), false);
  }
});

test('searchAccessori: withMeta conserva totale e avvisi nativi; senza opzione resta un array', async () => {
  let chiamate = 0;
  subito._setHttpGetJson(async () => {
    chiamate++;
    return { status: 200, body: JSON.stringify({ ads: Array.from({ length: 50 }, (_, i) => accessorio(i)), count_all: 75 }) };
  });
  const r = await subito.searchAccessori('faro prova', { cat: 'auto', withMeta: true });
  assert.equal(chiamate, 1);
  assert.equal(r.items.length, 50);
  assert.equal(r.total, 75);
  assert.equal(r.truncated, true);
  assert.equal(r.hasMore, true);
  assert.match(r.sospetto, /50 annunci.*prezzo/);
  const vecchio = await subito.searchAccessori('faro prova', { cat: 'auto' });
  assert.equal(chiamate, 2);
  assert.deepEqual(vecchio, r.items);
});

test('searchAccessori: il totale mancante non diventa zero, quello completo non e troncato', async () => {
  for (const totale of [undefined, 50]) {
    subito._setHttpGetJson(async () => ({ status: 200,
      body: JSON.stringify({ ads: Array.from({ length: 50 }, (_, i) => accessorio(i)), count_all: totale }) }));
    const r = await subito.searchAccessori('faro prova', { cat: 'moto', withMeta: true });
    assert.equal(r.total, totale ?? null);
    assert.equal(r.truncated, totale === undefined);
  }
});

test('searchAccessori: due categorie sommano solo totali noti e dichiarano un ramo fallito', async () => {
  let motoKo = false, totaleMoto;
  const chiamate = [];
  subito._setHttpGetJson(async p => {
    const cat = new URL('https://local.invalid' + p).searchParams.get('c');
    chiamate.push(cat);
    return cat === '36' && motoKo ? { status: 503, body: '' }
      : { status: 200, body: JSON.stringify({ ads: [accessorio(Number(cat))], count_all: cat === '5' ? 1 : totaleMoto }) };
  });
  assert.equal((await subito.searchAccessori('faro prova', { withMeta: true })).total, null);
  totaleMoto = 1;
  const completo = await subito.searchAccessori('faro prova', { withMeta: true });
  assert.equal(completo.items.length, 2);
  assert.equal(completo.total, 2);
  assert.equal(completo.parzialeRete, false);
  motoKo = true;
  const monco = await subito.searchAccessori('faro prova', { withMeta: true });
  assert.equal(monco.items.length, 1);
  assert.equal(monco.total, null);
  assert.equal(monco.parzialeRete, true);
  assert.match(monco.parziale, /categorie/);
  assert.equal(monco.erroriSubito[0].http, 503);
  assert.deepEqual(chiamate, ['5', '36', '5', '36', '5', '36']);
  const vecchio = await subito.searchAccessori('faro prova');
  assert.equal(vecchio.length, 1, 'il contratto preesistente conserva il ramo riuscito');
});

test('searchAccessori: withMeta non nasconde un fallimento totale e la query vuota non va in rete', async () => {
  let chiamate = 0;
  subito._setHttpGetJson(async () => { chiamate++; return { status: 503, body: '' }; });
  assert.deepEqual(await subito.searchAccessori(''), []);
  const vuota = await subito.searchAccessori('', { withMeta: true });
  assert.deepEqual(vuota.items, []);
  assert.equal(vuota.total, null, 'nessuna risposta Hades letta');
  assert.equal(chiamate, 0);
  await assert.rejects(subito.searchAccessori('faro prova', { withMeta: true }), { status: 503 });
  assert.equal(chiamate, 2);
});
