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
  const r = await subito({ tipo: 'auto', marca: 'Prova' }, { withMeta: true, senzaRecupero: true });
  assert.deepEqual(avvii, [0, 50]);
  assert.equal(r.items.length, 80);
  assert.equal(r.hasMore, false);
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
  const q = { tipo: 'auto', marca: 'Audi', fetta: 1 };
  const primo = await server._amrSearchFn(q);
  assert.equal(primo.sources.autoscout.status, 'error');
  assert.equal(primo.sources.subito.status, 'ok');
  const secondo = await server._amrSearchFn(q);
  assert.equal(secondo.sources.autoscout.status, 'ok');
  assert.equal(richiesteSubito, 1);
  assert.equal(richiesteAs, 2);
});
