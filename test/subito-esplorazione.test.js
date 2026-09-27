'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-esplorazione-'));
process.env.USER_DATA_PATH = base;
process.env.AMR_LOG_DIR = base;
process.env.AMR_WHATSAPP = '0';
require('dotenv').config = () => ({ parsed: {} });
const { app } = require('../backend/server');
const subito = require('../backend/scrapers/subito-api');
const salute = require('../backend/fonti-salute');
after(() => { subito._setHttpGetJson(null); salute.azzera(); fs.rmSync(base, { recursive: true, force: true }); });

test('esplorazione Moto: una pagina a clic, separata dalla ricerca e senza dati personali strutturati', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  subito._setHttpGetJson(async p => {
    const q = new URL(`https://test.invalid${p}`).searchParams;
    calls.push(q);
    const start = Number(q.get('start'));
    const ad = n => ({
      urn: `id:ad:prova:list:${n}`,
      subject: `Moto prova ${n}`,
      body: 'descrizione privata',
      advertiser: { company: false, name: 'Nome privato', user_id: 123 },
      urls: { default: `https://www.subito.it/moto/prova-${n}.htm` },
      features: [{ uri: '/bike', values: [
        { label: 'Marca', key: '000013', value: 'Suzuki' },
        { label: 'Modello', key: '000000', value: 'Altro modello' },
      ] }],
    });
    return { status: 200, body: JSON.stringify({ count_all: 51,
      ads: start ? [ad(51)] : Array.from({ length: 50 }, (_, i) => ad(i + 1)) }) };
  });
  try {
    const q = 'tipo=moto&marca=Suzuki&modello=SV%20650&versione=S';
    assert.equal(calls.length, 0, 'il montaggio della rotta non consulta Hades');
    const prima = await (await fetch(`${origin}/api/subito/senza-modello?${q}&start=0`)).json();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].get('bb'), '000013');
    assert.equal(calls[0].get('bm'), '000000');
    assert.equal(calls[0].has('q'), false);
    assert.deepEqual([prima.items.length, prima.hasMore, prima.nextStart], [50, true, 50]);
    assert.equal(JSON.stringify(prima).includes('Nome privato'), false);
    assert.equal(JSON.stringify(prima).includes('descrizione privata'), false);
    const seconda = await (await fetch(`${origin}/api/subito/senza-modello?${q}&start=50`)).json();
    assert.deepEqual([seconda.items.length, seconda.hasMore, seconda.nextStart], [1, false, null]);
    assert.deepEqual(calls.map(x => x.get('start')), ['0', '50']);
    const noModel = await fetch(`${origin}/api/subito/senza-modello?tipo=moto&marca=Suzuki`);
    assert.equal(noModel.status, 400);
    assert.equal(calls.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('schermo: niente richiesta automatica; errore riprovabile e righe esterne ai risultati', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
  const codice = src.slice(src.indexOf('let senzaModelloStart = 0;'), src.indexOf('/**\n * "CARICA ALTRI ANNUNCI"'));
  class Element {
    constructor() {
      this.children = [];
      this.classes = new Set();
      this.classList = {
        add: c => this.classes.add(c),
        toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c),
        contains: c => this.classes.has(c),
      };
    }
    replaceChildren() { this.children = []; }
    append(...children) { this.children.push(...children); }
  }
  const elements = Object.fromEntries(['subitoSenzaModello', 'senzaModelloLista',
    'senzaModelloStato', 'senzaModelloCarica'].map(k => [k, new Element()]));
  const calls = [];
  const replies = [
    { ok: false, status: 502, body: { error: 'Fonte temporaneamente non disponibile' } },
    { ok: true, status: 200, body: { items: [
      { id: 'subito:1', titolo: 'Prova', url: 'https://www.subito.it/auto/prova-1.htm', prezzo: 100 },
      { id: 'subito:2', titolo: 'Nocivo', url: 'javascript:alert(1)', prezzo: 100 },
    ], hasMore: true, nextStart: 50 } },
    { ok: true, status: 200, body: { items: [
      { id: 'subito:1', titolo: 'Duplicato', url: 'https://www.subito.it/auto/prova-1.htm' },
    ], hasMore: false, nextStart: null } },
  ];
  const main = [{ id: 'auto:1' }];
  const ctx = vm.createContext({ URL, URLSearchParams, Date, setTimeout: () => 1, clearTimeout() {},
    searchGen: 1, searchActive: true, lastSearchParams: { tipo: 'auto', marca: 'Ford', modello: 'Fiesta' },
    lastSources: { subito: { status: 'ok', famigliaNome: 'Fiesta' } }, currentResults: main,
    eurRound: n => `€ ${n}`,
    document: { getElementById: k => elements[k] || null, createElement: () => new Element() },
    fetch: async url => { calls.push(url); const r = replies.shift(); return { ok: r.ok, status: r.status,
      json: async () => r.body }; },
  });
  vm.runInContext(codice, ctx);
  vm.runInContext('mostraSenzaModello()', ctx);
  assert.equal(calls.length, 0);
  await vm.runInContext('caricaSenzaModello()', ctx);
  assert.equal(elements.senzaModelloLista.children.length, 0);
  assert.equal(vm.runInContext('senzaModelloStart', ctx), 0);
  vm.runInContext('senzaModelloAttesa = 0', ctx);
  await vm.runInContext('caricaSenzaModello()', ctx);
  assert.equal(elements.senzaModelloLista.children.length, 1, 'URL estranea respinta');
  assert.equal(elements.senzaModelloLista.children[0].children[0].textContent, 'Prova');
  assert.equal(vm.runInContext('senzaModelloStart', ctx), 50);
  await vm.runInContext('caricaSenzaModello()', ctx);
  assert.equal(elements.senzaModelloLista.children.length, 1, 'ID duplicato non aggiunto');
  assert.equal(ctx.currentResults, main, 'la ricerca principale resta identica');
  assert.deepEqual(calls.map(u => new URL('https://test.invalid' + u).searchParams.get('start')), ['0', '0', '50']);
});
