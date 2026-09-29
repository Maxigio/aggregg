'use strict';
// Contratto delle richieste native: la rotta reale, con le sole risposte delle fonti simulate.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-nodi-baseline-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
require('dotenv').config = () => ({ parsed: {} });
const subito = require('../backend/scrapers/subito-api');
const motoit = require('../backend/scrapers/motoit');
const salute = require('../backend/fonti-salute');
const { app } = require('../backend/server');
const handler = app.router.stack.find(l => l.route?.path === '/api/search').route.stack.at(-1).handle;
const originalGet = https.get, originalRequest = https.request, originalMotoGet = motoit._get;
const calls = [];
let unexpectedGet = 0;
let tipo;
let subitoStatus = 200;

const ad = () => ({ urn: 'id:ad:synthetic:list:123', subject: tipo === 'auto' ? 'Fiat Panda' : 'Yamaha MT-07',
  urls: { default: `https://www.subito.it/${tipo}/prova-123.htm` },
  features: [{ label: 'Prezzo', uri: '/price', values: [{ value: '10000 €' }] }] });
const listing = () => ({ id: 'as123', details: { webPage: 'https://www.autoscout24.it/annunci/prova-123',
  prices: { public: { amountInEUR: { raw: 10000 } } }, vehicle: { classification: {
    make: { formatted: tipo === 'auto' ? 'Fiat' : 'Yamaha' },
    model: { formatted: tipo === 'auto' ? 'Panda' : 'MT-07' },
  } } } });

subito._setHttpGetJson(async url => {
  calls.push({ fonte: 'subito', query: Object.fromEntries(new URL('https://mock.invalid' + url).searchParams) });
  if (subitoStatus !== 200) return { status: subitoStatus, headers: {}, body: '{}' };
  return { status: 200, headers: {}, body: JSON.stringify({ ads: [ad()], count_all: 1 }) };
});
https.get = () => { unexpectedGet++; throw new Error('Nessuna richiesta live ammessa'); };
https.request = (options, callback) => {
  assert.equal(options.host, 'listing-search.api.autoscout24.com');
  const request = new EventEmitter();
  let body = '';
  request.write = chunk => { body += chunk; };
  request.setTimeout = () => request;
  request.destroy = () => request;
  request.end = () => queueMicrotask(() => {
    calls.push({ fonte: 'autoscout', variables: JSON.parse(body).variables });
    const response = new EventEmitter();
    response.statusCode = 200; response.headers = {}; response.setEncoding = () => {};
    callback(response);
    response.emit('data', JSON.stringify({ data: { search: { listings: {
      listings: [listing()], metadata: { totalItems: 1 },
    } } } }));
    response.emit('end');
  });
  return request;
};
motoit._get = async url => {
  const parsed = new URL(url);
  calls.push({ fonte: 'moto', path: parsed.pathname, query: Object.fromEntries(parsed.searchParams) });
  return { status: 200, body: '<div class="plist-head-title-info">1 annuncio</div>'
    + '<div class="mcard--big"><a href="/moto-usate/yamaha/mt-07/101">MT-07</a>'
    + '<h3>Yamaha MT-07</h3><span class="price">5.000 €</span></div>' };
};
after(() => {
  subito._setHttpGetJson(null);
  motoit._get = originalMotoGet;
  https.get = originalGet;
  https.request = originalRequest;
  salute._reset();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function cerca(query) {
  let status = 200, data;
  await handler({ query, authId: 'baseline', authRole: 'full', ip: '127.0.0.1', headers: {},
    socket: { remoteAddress: '127.0.0.1' } }, {
    status(n) { status = n; return this; },
    json(value) { data = value; return this; },
    setHeader() {},
  });
  assert.equal(status, 200);
  return data;
}

test('Auto: Fiat Panda conserva i filtri nativi delle due fonti senza Moto.it', async () => {
  tipo = 'auto'; calls.length = 0; unexpectedGet = 0;
  const data = await cerca({ tipo, marca: 'Fiat', modello: 'Panda' });
  assert.equal(data.risultati.length, 2);
  assert.equal(data.sources.moto.status, 'skipped');
  assert.equal(unexpectedGet, 0);
  assert.deepEqual(calls.sort((a, b) => a.fonte.localeCompare(b.fonte)), [
    { fonte: 'autoscout', variables: { v: { classification: [{ make: 28, model: 1746 }], vehicleType: ['Car'] },
      loc: { country: ['Italy'] }, m: { page: 1, size: 50 } } },
    { fonte: 'subito', query: { c: '2', t: 's', lim: '50', start: '0', cb: '000008', cm: '000024', sort: 'priceasc' } },
  ]);
});

test('Moto: Yamaha MT-07 conserva i filtri nativi delle tre fonti', async () => {
  tipo = 'moto'; calls.length = 0; unexpectedGet = 0;
  const data = await cerca({ tipo, marca: 'Yamaha', modello: 'MT-07' });
  assert.equal(data.risultati.length, 3);
  assert.equal(unexpectedGet, 0);
  for (const source of ['subito', 'autoscout', 'moto']) {
    assert.equal(data.sources[source].status, 'ok');
    assert.equal(data.sources[source].count, 1);
  }
  assert.deepEqual(calls.sort((a, b) => a.fonte.localeCompare(b.fonte)), [
    { fonte: 'autoscout', variables: { v: { classification: [{ make: 50107, model: 70888 }], vehicleType: ['Bike'] },
      loc: { country: ['Italy'] }, m: { page: 1, size: 50 } } },
    { fonte: 'moto', path: '/moto-usate/ricerca',
      query: { brand: 'yamaha', model: 'yamaha|mt-07', sort: 'price-a' } },
    { fonte: 'subito', query: { c: '3', t: 's', lim: '50', start: '0', bb: '000015', bm: '002473', sort: 'priceasc' } },
  ]);
});

test('una sola fonte richiesta non avvia chiamate alle altre', async () => {
  tipo = 'moto'; calls.length = 0; unexpectedGet = 0;
  const data = await cerca({ tipo, marca: 'Yamaha', modello: 'MT-07', prezzoMin: '1',
    fetta: '0', fonti: 'subito' });
  assert.equal(data.risultati.length, 1);
  assert.deepEqual(calls.map(c => c.fonte), ['subito']);
  assert.equal(data.sources.subito.status, 'ok');
  assert.equal(data.sources.autoscout.status, 'skipped');
  assert.equal(data.sources.moto.status, 'skipped');
  assert.equal(unexpectedGet, 0);
});

test('Subito 429 conserva le porzioni riuscite delle altre fonti e segnala la pausa', async () => {
  tipo = 'moto'; calls.length = 0; unexpectedGet = 0; subitoStatus = 429;
  const data = await cerca({ tipo, marca: 'Yamaha', modello: 'MT-07', prezzoMin: '2' });
  assert.deepEqual(calls.map(c => c.fonte).sort(), ['autoscout', 'moto', 'subito']);
  assert.equal(data.sources.subito.erroreHttp, 429);
  assert.equal(data.sources.subito.pausa.fermo, true);
  assert.equal(data.sources.autoscout.status, 'ok');
  assert.equal(data.sources.moto.status, 'ok');
  assert.equal(data.risultati.length, 2);
  assert.equal(unexpectedGet, 0);
});
