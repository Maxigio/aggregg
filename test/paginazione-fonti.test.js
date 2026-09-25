'use strict';
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-pagine-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
require('dotenv').config = () => ({ parsed: {} });
const salute = require('../backend/fonti-salute');
const subito = require('../backend/scrapers/subito-api');
const autoscout = require('../backend/scrapers/autoscout-graphql');
const motoit = require('../backend/scrapers/motoit');
const server = require('../backend/server');
const request = https.request;
afterEach(() => { subito._setHttpGetJson(null); motoit._get = getMoto; https.request = request; salute.azzera(); });
after(() => { salute._reset(); fs.rmSync(dir, { recursive: true, force: true }); });
const getMoto = motoit._get;

const ad = i => ({ urls: { default: `https://www.subito.it/auto/prova-${i}.htm` },
  subject: `Prova ${i}`, features: [{ label: 'Prezzo', values: [{ value: '10000 €' }] }] });
const nodo = i => ({ id: String(i), details: { prices: { public: { amountInEUR: { raw: 10000 } } },
  vehicle: { classification: { make: { formatted: 'Prova' }, model: { formatted: 'Modello' } } } } });

test('Subito: 80 righe grezze in due pagine esauriscono la fonte', async () => {
  const avvii = [];
  subito._setHttpGetJson(async url => {
    const start = Number(new URL('https://test.invalid' + url).searchParams.get('start'));
    avvii.push(start);
    const ads = Array.from({ length: start ? 30 : 50 }, (_, i) => ad(start + i));
    return { status: 200, body: JSON.stringify({ ads, count_all: 80 }) };
  });
  const params = { tipo: 'auto', marca: 'Prova' };
  const prima = await subito(params, { withMeta: true, senzaRecupero: true });
  assert.deepEqual(avvii, [0]);
  assert.equal(prima.items.length, 50);
  assert.equal(prima.hasMore, true);
  const seconda = await subito(params, { withMeta: true, senzaRecupero: true, fetta: 1 });
  assert.deepEqual(avvii, [0, 50]);
  assert.equal(seconda.items.length, 30);
  assert.equal(seconda.hasMore, false);
});

test('AutoScout24: pagine piene mantengono continua la navigazione', async () => {
  let chiamate = 0;
  https.request = (...args) => {
    const cb = args.at(-1), req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.setTimeout = () => {};
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {};
      cb(res);
      const list = Array.from({ length: 50 }, (_, i) => nodo(chiamate * 50 + i));
      chiamate++;
      res.emit('data', JSON.stringify({ data: { search: { listings: { listings: list,
        metadata: { totalItems: 150 } } } } }));
      res.emit('end');
    });
    return req;
  };
  const r = await autoscout({ tipo: 'auto', as24Customer: '1' }, { withMeta: true });
  assert.equal(chiamate, 2);
  assert.equal(r.hasMore, true);
});

test('Moto.it: pagina vuota chiude anche con totale largo e righe filtrate', async () => {
  let n = 0;
  const card = `<div class="mcard--big"><a href="/moto-usate/yamaha/mt-07/101">MT-07</a>
    <h3>Yamaha MT-07</h3><span class="price">5.000 €</span></div>`;
  motoit._get = async () => ({ status: 200, body: n++ === 0
    ? `<div class="plist-head-title-info">100 annunci</div>${card}`
    : '<div class="plist-head-title-info">100 annunci</div>' });
  const r = await motoit._scrapeVia(['p1', 'p2', 'p3'], { fetta: 1 });
  assert.equal(r.pages.length, 1);
  assert.equal(r.hasMore, false);
});

test('pagina fallita: il retry non richiama una fonte che aveva completato la pagina', async () => {
  let richiesteSubito = 0, richiesteAs = 0;
  subito._setHttpGetJson(async () => {
    richiesteSubito++;
    return { status: 200, body: JSON.stringify({ ads: [ad(900)], count_all: 1 }) };
  });
  https.request = (...args) => {
    const cb = args.at(-1), req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.setTimeout = () => {};
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = ++richiesteAs === 1 ? 503 : 200;
      res.headers = {}; res.resume = () => {}; res.setEncoding = () => {};
      cb(res);
      if (res.statusCode === 200) {
        res.emit('data', JSON.stringify({ data: { search: { listings: { listings: [nodo(901)],
          metadata: { totalItems: 1 } } } } }));
        res.emit('end');
      }
    });
    return req;
  };
  const q = { tipo: 'auto', marca: 'Audi', fetta: 1, fonti: 'subito,autoscout' };
  const primo = await server._amrSearchFn(q);
  assert.equal(primo.sources.autoscout.status, 'error');
  assert.equal(primo.sources.subito.status, 'ok');
  const secondo = await server._amrSearchFn(q);
  assert.equal(secondo.sources.autoscout.status, 'ok');
  assert.equal(richiesteSubito, 1);
  assert.equal(richiesteAs, 2);
});

test('pagina successiva: una fonte esaurita non riceve altre richieste', async () => {
  let chiamateSubito = 0, chiamateAs = 0;
  subito._setHttpGetJson(async () => {
    chiamateSubito++;
    return { status: 200, body: JSON.stringify({ ads: [], count_all: 0 }) };
  });
  https.request = (...args) => {
    const cb = args.at(-1), req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.setTimeout = () => {};
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {}; res.setEncoding = () => {};
      cb(res); chiamateAs++;
      res.emit('data', JSON.stringify({ data: { search: { listings: { listings: [nodo(950)],
        metadata: { totalItems: 1 } } } } }));
      res.emit('end');
    });
    return req;
  };
  const r = await server._amrSearchFn({ tipo: 'auto', marca: 'Audi', fetta: 23, fonti: 'autoscout' });
  assert.equal(chiamateSubito, 0);
  assert.ok(chiamateAs > 0);
  assert.equal(r.sources.subito.status, 'skipped');
  assert.equal(r.sources.subito.hasMore, false);
});

test('la scelta delle fonti accetta solo nomi univoci nelle pagine successive', async () => {
  for (const q of [
    { fetta: 0, fonti: 'subito' },
    { fetta: 1, fonti: 'subito,subito' },
    { fetta: 1, fonti: '__proto__' },
    { fetta: 1, fonti: ['subito', 'moto'] },
  ]) {
    const r = await server._amrSearchFn({ tipo: 'auto', marca: 'Audi', ...q });
    assert.match(r.error, /fonti della pagina non valide/);
  }
});

test('i cursori Subito rifiutano offset arbitrari o incompleti', async () => {
  for (const cursori of [
    { subitoMainStart: '1', subitoRecuperoStart: '50' },
    { subitoMainStart: '2550', subitoRecuperoStart: '50' },
    { subitoMainStart: '50' },
    { subitoMainStart: '50', subitoRecuperoStart: '50', fetta: 0 },
    { subitoMainStart: '50', subitoRecuperoStart: '50', fonti: 'autoscout' },
  ]) {
    const r = await server._amrSearchFn({ tipo: 'auto', marca: 'Audi', fetta: 1,
      fonti: 'subito', ...cursori });
    assert.match(r.error, /cursori Subito non validi/);
  }
});
