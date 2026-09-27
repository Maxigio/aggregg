'use strict';
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// Handler, core e scraper veri; rete e dipendenze estranee a Subito controllate.
// Nessun server, credenziale o magazzino reale, anche senza preload esterno.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-rc-concorrenza-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
require('dotenv').config = () => ({ parsed: {} });
const https = require('node:https');
const getPrima = https.get, requestPrima = https.request;
https.get = https.request = () => { throw new Error('Rete non prevista nel test'); };
const salute = require('../backend/fonti-salute');
const sub = require('../backend/scrapers/subito-api');
const annullo = require('../backend/annullo');
const limite = require('../backend/limite-richieste');
beforeEach(() => { salute.azzera(); sub._setHttpGetJson(null); });
after(() => {
  sub._setHttpGetJson(null); salute._reset();
  https.get = getPrima; https.request = requestPrima;
  fs.rmSync(dir, { recursive: true, force: true });
});
function carica(file, deps, timers = {}) {
  const mod = { exports: {} };
  new Function('require', 'module', 'setTimeout', 'clearTimeout',
    fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))(id => {
    assert.ok(Object.hasOwn(deps, id), `import inatteso: ${id}`);
    return deps[id];
  }, mod, timers.setTimeout || setTimeout, timers.clearTimeout || clearTimeout);
  return mod.exports;
}
const tick = () => new Promise(r => setImmediate(r));
function differita() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function appFinta() {
  const handlers = {};
  return { handlers, get: (p, ...h) => { handlers[p] = h.at(-1); }, post() {}, delete() {} };
}
async function chiama(handler, req) {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler(req, res);
  return res;
}
const vuota = async () => ({ articoli: [] });
const oem = { normOen: q => q.replace(/\W/g, '').toUpperCase(), lookupOem: vuota };
const ebay = { searchEbay: async () => [{ nome: 'Faro controllo', fonte: 'ebay', prezzo: 10 }] };
function ricambi(core, timers) {
  core ||= carica('backend/ricambi-core.js', {
    './oem-lookup': oem, './cmsnl-lookup': { lookupCmsnl: vuota },
    './web-parts': { searchWebParts: vuota }, './scrapers/subito-api': sub,
    './ebay-scrape': ebay, './logger': { info() {}, warn() {} }, './fonti-salute': salute, './annullo': annullo,
  }, timers);
  const app = appFinta();
  carica('backend/ricambi-route.js', {
    './fonti-salute': salute, './ricambi-core': core, './oem-lookup': oem,
    './ebay-scrape': ebay, './limite-richieste': limite,
  }).mount(app, { chiaveLimite: r => 'u:' + r.authId });
  return req => chiama(app.handlers['/api/ricambi'], req);
}
function competitor(produci, voci) {
  const C = carica('backend/competitor.js', {
    https: {}, zlib: {}, cheerio: {}, fs, path, './utenti-db': {},
    './scrapers/subito-api': sub, './scrapers/autoscout-graphql': {},
    './scrapers/motoit-vetrina': {}, './scrapers/detail': {}, './fonti-salute': salute,
  });
  const comp = { ...C, leggi: u => voci[u] || [], ...(produci ? { parco: produci } : {}) };
  const app = appFinta();
  carica('backend/competitor-route.js', {
    './competitor': comp, './fonti-salute': salute, './limite-richieste': limite,
  }).mount(app, { chiaveLimite: r => 'u:' + r.authId });
  return (u = 'a', forza = false, gruppo = false, id = '123') => chiama(
    app.handlers[gruppo ? '/api/competitor/gruppo/:g/parco' : '/api/competitor/:id/parco'],
    { authId: u, params: gruppo ? { g: 'g' } : { id: 'subito:' + id }, query: forza ? { forza: '1' } : {} });
}
const richiesta = (u = 'a', query = {}) => ({ authId: u, query: { q: 'faro', mode: 'nome', ...query } });
const voce = extra => ({ fonte: 'subito', id: '123', nome: 'Voce', gruppo: 'g', schedaLetta: true, ...extra });
const ad = { urn: 'id:ad:test:123', subject: 'Faro test', urls: { default: 'https://www.subito.it/auto/faro-123.htm' },
  features: [{ uri: '/price', label: 'Prezzo', values: [{ value: '5000 €' }] }],
  advertiser: { type: '0', name: 'PRIVATO_SINTETICO', id: 'PRIVATO_SINTETICO' }, body: 'PRIVATO_SINTETICO' };
const pagina = () => ({ status: 200, body: JSON.stringify({ ads: [ad], count_all: 1 }) });
const parco = (id, extra = {}) => ({ veicoli: [{ id, prezzo: 5000, url: 'https://example.invalid/' + id }], totaleFonte: 1, ...extra });

test('S4 Ricambi: due schede, una Hades e un posto; cache calda gia condivisa fra account', async () => {
  const gate = differita(); let calls = 0;
  sub._setHttpGetJson(async () => { calls++; await gate.promise; return pagina(); });
  const r = ricambi();
  const a = r(richiesta()), b = r(richiesta());
  await tick(); assert.equal(calls, 1);
  gate.resolve();
  const risposte = await Promise.all([a, b]);
  for (const { body } of risposte) {
    assert.equal(body.restanti, 9);
    assert.equal(body.sources.subito.total, 1);
    assert.equal(body.sources.subito.status, 'ok');
    assert.ok(!JSON.stringify(body).includes('PRIVATO_SINTETICO'));
  }
  const altraPersona = await r(richiesta('b'));
  assert.equal(altraPersona.body.restanti, 10);
  assert.equal(calls, 1);
});

test('S4 Ricambi: account, veicolo, modo e query effettiva distinguono i lavori', async () => {
  const gate = differita(); const calls = [];
  sub._setHttpGetJson(async p => { calls.push(p); await gate.promise; return pagina(); });
  const r = ricambi();
  const jobs = [richiesta(), richiesta('b'), richiesta('a', { veicolo: 'moto' }),
    richiesta('a', { mode: 'prodotto' }), richiesta('a', { q: 'faro altro' }),
    richiesta('a', { mode: 'oem', q: '12-34' }), richiesta('a', { mode: 'oem', q: '12 34' })].map(r);
  await tick(); assert.equal(calls.length, 7);
  assert.ok(calls.some(p => new URL(p, 'https://test.invalid').searchParams.get('c') === '36'));
  gate.resolve(); await Promise.all(jobs);
});

test('S4 Ricambi: fallimento condiviso si libera e il tentativo successivo riparte', async () => {
  const gate = differita(); let calls = 0;
  sub._setHttpGetJson(async () => {
    calls++; if (calls === 1) { await gate.promise; return { status: 503, body: '' }; }
    return pagina();
  });
  const r = ricambi();
  const a = r(richiesta()), b = r(richiesta());
  await tick(); gate.resolve();
  for (const x of await Promise.all([a, b])) {
    assert.equal(x.body.sources.subito.status, 'error'); assert.equal(x.body.restanti, 9);
  }
  assert.equal((await r(richiesta())).body.sources.subito.status, 'ok');
  assert.equal(calls, 2);
});

test('S4 Ricambi: il 429 condiviso conserva avviso, stato HTTP e pausa senza congelarli in cache', async () => {
  const gate = differita(); let calls = 0;
  sub._setHttpGetJson(async () => { calls++; await gate.promise; return { status: 429, body: '' }; });
  const r = ricambi();
  const a = r(richiesta()), b = r(richiesta());
  await tick(); gate.resolve();
  for (const x of await Promise.all([a, b])) {
    assert.equal(x.body.sources.subito.status, 'blocked');
    assert.equal(x.body.sources.subito.httpStatus, 429);
    assert.equal(x.body.sources.subito.pausa.fermo, true);
    assert.match(x.body.sources.subito.reason, /429/);
    assert.equal(x.body.restanti, 9);
  }
  const locale = await r(richiesta());
  assert.equal(locale.body.sources.subito.status, 'blocked');
  assert.equal(locale.body.sources.subito.httpStatus, undefined, 'pausa locale non e un nuovo HTTP 429');
  assert.equal(locale.body.restanti, 8, 'un nuovo lavoro eBay non riusa l errore come cache');
  assert.equal(calls, 1);
});

test('S4 Ricambi: un rigetto del core libera la Promise condivisa anche fuori dagli envelope fonte', async t => {
  const gate = differita(); let calls = 0;
  t.mock.method(console, 'error', () => {});
  const r = ricambi({ searchRicambi: async () => {
    calls++; if (calls === 1) return gate.promise;
    return { sources: {}, count: 0, articoli: [] };
  } });
  const a = r(richiesta()), b = r(richiesta());
  await tick(); gate.reject(new Error('errore core sintetico'));
  for (const x of await Promise.all([a, b])) assert.equal(x.code, 500);
  assert.equal((await r(richiesta())).code, 200);
  assert.equal(calls, 2);
});

test('S4 Competitor: singolo/gruppo/forza si uniscono, quota e metadati restano corretti', async () => {
  const gate = differita(); const calls = [];
  sub._setHttpGetJson(async p => { calls.push(p); await gate.promise; return pagina(); });
  const voci = { a: [voce({ nome: 'Nome A', mio: true })], b: [voce({ nome: 'Nome B', gruppo: 'altro' })] };
  const c = competitor(null, voci);
  const a = c(), b = c('a', true), g = c('a', true, true);
  await tick(); assert.equal(calls.length, 1);
  gate.resolve();
  const esiti = await Promise.all([a, b, g]);
  assert.equal(calls.length, 2, 'solo categoria Auto e Moto');
  for (const x of esiti) assert.equal(x.body.scarichiRestanti, 5);
  const personale = await c('b');
  assert.equal(personale.body.voce.nome, 'Nome B');
  assert.equal(personale.body.voce.mio, undefined);
  assert.equal(personale.body.voce.gruppo, 'altro');
  assert.equal(personale.body.scarichiRestanti, 6);
  assert.equal((await c('assente')).code, 404);
  await c('a', true);
  assert.equal(calls.length, 4, 'forza dopo completamento avvia nuovo scarico');
});

test('S4 Competitor: attesa gia pagata resta accessibile a budget esaurito; rifiuto non si incolla', async () => {
  const gate = differita(); let calls = 0;
  const c = competitor(async () => { calls++; return calls === 6 ? gate.promise : parco('ok'); }, { a: [voce()] });
  for (let i = 0; i < 5; i++) await c('a', true);
  const a = c('a', true); await tick();
  const b = c('a', true, true); await tick();
  assert.equal(calls, 6);
  gate.resolve(parco('ultimo'));
  for (const x of await Promise.all([a, b])) assert.equal(x.body.scarichiRestanti, 0);
  assert.equal((await c('a', true)).code, 429);
  assert.equal(calls, 6);
});

test('S4 Competitor: errore e revoca appartenenza non lasciano un lavoro riutilizzabile', async () => {
  const gate = differita(); let calls = 0;
  const voci = { a: [voce()] };
  const c = competitor(async () => { calls++; return calls === 1 ? gate.promise : parco('nuovo'); }, voci);
  const a = c(), b = c('a', true);
  await tick(); gate.reject(Object.assign(new Error('errore controllato'), { status: 503 }));
  for (const x of await Promise.all([a, b])) assert.equal(x.code, 502);
  assert.equal((await c()).body.scarichiRestanti, 4);
  assert.equal(calls, 2);
  voci.a = [];
  assert.equal((await c()).code, 404, 'cache condivisa non scavalca appartenenza');
});

for (const inverso of [false, true]) test(`S5: due account, ordine completamento ${inverso ? 'B-A' : 'A-B'}, cache finale B`, async () => {
  const gates = [];
  const c = competitor(() => { const d = differita(); gates.push(d); return d.promise; },
    { a: [voce({ nome: 'A' })], b: [voce({ nome: 'B', mio: true })] });
  const a = c('a', true), b = c('b', true); await tick(); assert.equal(gates.length, 2);
  if (inverso) { gates[1].resolve(parco('B')); await b; gates[0].resolve(parco('A')); await a; }
  else { gates[0].resolve(parco('A')); await a; gates[1].resolve(parco('B')); await b; }
  const hit = await c('a');
  assert.equal(hit.body.veicoli[0].id, 'B');
  assert.equal(hit.body.voce.nome, 'A'); assert.equal(hit.body.voce.mio, undefined);
});

for (const nuovoParziale of [false, true]) test(`S5: completezza prevale anche in concorrenza (nuovo parziale=${nuovoParziale})`, async () => {
  const gates = [];
  const c = competitor(() => { const d = differita(); gates.push(d); return d.promise; }, { a: [voce()], b: [voce()] });
  const a = c('a', true), b = c('b', true); await tick();
  const ko = { passateKo: [{ tipo: 'moto', status: 503, motivo: 'pagina mancante' }] };
  gates[1].resolve(parco('B', nuovoParziale ? ko : {})); await b;
  gates[0].resolve(parco('A', nuovoParziale ? {} : ko)); await a;
  const hit = await c();
  assert.equal(hit.body.passateKo, null);
  assert.equal(hit.body.veicoli[0].id, nuovoParziale ? 'A' : 'B');
});

test('S5: espulsione cache non permette alla risposta superata di reinserirsi', async () => {
  const gate = differita(); let calls = 0;
  const voci = { a: [voce()], b: [voce()], altri: Array.from({ length: 8 }, (_, i) => voce({ id: String(200 + i) })) };
  const c = competitor(async v => { calls++; return calls === 1 ? gate.promise : parco(v.id + ':' + calls); }, voci);
  const a = c(); await tick(); await c('b', true);
  // Account distinti per non aggirare il limite di sei scarichi dell'app.
  for (let i = 0; i < 8; i++) {
    voci['u' + i] = [voci.altri[i]];
    await c('u' + i, false, false, String(200 + i));
  }
  gate.resolve(parco('superata')); await a;
  const finale = await c('b');
  assert.equal(finale.body.daCache, false);
  assert.notEqual(finale.body.veicoli[0].id, 'superata');
});

test('S6: timeout del lavoro Ricambi chiude Hades, le singole schede non possiedono il segnale', async t => {
  const sockets = [], timers = [];
  t.mock.method(https, 'get', (options, cb) => {
    const request = new EventEmitter(), response = new EventEmitter();
    Object.assign(request, { destroyed: false, setTimeout(ms) { this.idleMs = ms; },
      destroy(err) { this.destroyed = true; if (err) this.emit('error', err); } });
    Object.assign(response, { statusCode: 200, headers: {}, setEncoding() {} });
    options.signal?.addEventListener('abort', () => request.destroy(Object.assign(new Error('annullato'), { code: 'ABORT_ERR' })), { once: true });
    sockets.push({ request, response, signal: options.signal });
    process.nextTick(() => cb(response));
    return request;
  });
  const r = ricambi(null, {
    setTimeout: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; },
    clearTimeout: x => { x.cleared = true; },
  });
  const scheda1 = new AbortController(), scheda2 = new AbortController();
  const a = annullo.dentro(scheda1.signal, () => r(richiesta()));
  const b = annullo.dentro(scheda2.signal, () => r(richiesta()));
  await tick(); assert.equal(sockets.length, 1);
  const socket = sockets[0];
  assert.ok(socket.signal); assert.notEqual(socket.signal, scheda1.signal);
  assert.equal(socket.request.idleMs, 12000);
  scheda1.abort();
  assert.equal(socket.signal.aborted, false); assert.equal(socket.request.destroyed, false);
  socket.response.emit('data', '{"ads":[');
  const scadenza = timers.find(x => !x.cleared);
  assert.equal(scadenza.ms, 45000); scadenza.fn();
  for (const x of await Promise.all([a, b])) {
    assert.equal(x.body.sources.subito.status, 'timeout');
    assert.equal(x.body.sources.ebay.status, 'ok');
    assert.equal(x.body.restanti, 9);
  }
  assert.equal(socket.request.destroyed, true);
  assert.equal(socket.signal.aborted, true);
  assert.equal(scheda2.signal.aborted, false);
  // Il timeout non diventa una cache: la ricerca seguente apre un nuovo trasporto.
  const retry = r(richiesta()); await tick(); assert.equal(sockets.length, 2);
  sockets[1].response.emit('data', pagina().body); sockets[1].response.emit('end');
  assert.equal((await retry).body.sources.subito.status, 'ok');
  assert.equal(sockets[1].signal.aborted, false);
});
