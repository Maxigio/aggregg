'use strict';
const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-fonti-http-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
const salute = require('../backend/fonti-salute');
const as24 = require('../backend/scrapers/autoscout-graphql');
const motoit = require('../backend/scrapers/motoit');
const catalogo = require('../backend/scrapers/motoit-models');
const vetrina = require('../backend/scrapers/motoit-vetrina');
const subito = require('../backend/scrapers/subito-api');
const get = https.get, request = https.request;
afterEach(() => { https.get = get; https.request = request; salute.azzera(); });
after(() => { salute._reset(); fs.rmSync(dir, { recursive: true, force: true }); });
function finta(producer) {
  let n = 0;
  const impl = (...args) => {
    const cb = args.at(-1), req = new EventEmitter();
    req.setTimeout = () => {}; req.destroy = e => req.emit('error', e); req.write = () => {}; req.end = () => {};
    const r = producer(++n, args[0]);
    process.nextTick(() => {
      const res = new EventEmitter();
      Object.assign(res, { statusCode: r.status, headers: r.headers || {}, resume() {}, setEncoding() {} });
      cb(res);
      // Un 429 non deve aspettare nemmeno la fine del body.
      if (r.status !== 429) { res.emit('data', r.body || ''); res.emit('end'); }
      else res.emit('error', new Error('ECONNRESET dopo gli header')); // mai un'eccezione non gestita
    });
    return req;
  };
  https.get = https.request = impl;
  return () => n;
}
const nodo = i => ({ id: String(i), details: { prices: { public: { amountInEUR: { raw: 10000 } } },
  vehicle: { classification: { make: { formatted: 'Prova' }, model: { formatted: 'Modello' } } } } });
const graph = list => JSON.stringify({ data: { search: { listings: { listings: list, metadata: { totalItems: 200 } } } } });

test('AS24: il 429 arriva dagli header, ferma anche le count-query e conserva le pagine ricevute', async () => {
  const chiamate = finta(n => n === 1 ? { status: 200, body: graph(Array.from({ length: 50 }, (_, i) => nodo(i))) }
    : { status: 429, headers: { 'retry-after': '86400' } });
  const r = await as24({ tipo: 'auto', as24Customer: '1' }, { withMeta: true, maxPages: 5 });
  assert.equal(r.items.length, 50); assert.equal(r.bloccoParziale.status, 429); assert.equal(r.parzialeRete, true);
  assert.match(r.parziale, /429/);
  assert.equal(await as24.fetchTotalCount({ mmmv: '1|2', tipo: 'auto' }), null);
  await assert.rejects(as24({ tipo: 'moto', as24Customer: '1' }), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate(), 2);
  assert.ok(salute.fermo('autoscout').fino > Date.now() + 23 * 3600000);
});

test('Subito: il 429 HTTP senza fine body blocca anche una nuova ricerca ricambi', async () => {
  const chiamate = finta(() => ({ status: 429 }));
  await assert.rejects(subito({ tipo: 'auto', marca: 'Prova' }), { status: 429 });
  await assert.rejects(subito.searchAccessori('faro', { cat: 'moto' }), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate(), 1);
});

test('Moto.it: un 429 del menu ferma ricerca e vetrine senza nuove chiamate', async () => {
  const chiamate = finta(() => ({ status: 429 }));
  await catalogo.getBrandModels('marca-prova-429').catch(() => {});
  assert.equal(salute.fermo('moto').fermo, true);
  await assert.rejects(motoit._get('https://www.moto.it/moto-usate/ricerca'), { code: 'FONTE_IN_PAUSA' });
  await assert.rejects(vetrina.scheda('concessionario-prova'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate(), 1);
});

test('Moto.it: il parco mantiene le card ricevute prima del 429', async () => {
  const card = id => `<div class="dlr-card"><a data-target="#annuncio_${id}"></a><span class="dlr-card__info__title__brand">Yamaha</span><span class="dlr-card__info__title__model">MT-07</span><span class="dlr-card__extrainfo__price">5.000 €</span></div>`;
  const chiamate = finta(n => n === 1 ? { status: 200, body: `<html>${Array.from({ length: 12 }, (_, i) => card(1000 + i)).join('')}</html>` } : { status: 429 });
  const r = await vetrina.parco('prova', { maxPagine: 5 });
  assert.equal(r.items.length, 12); assert.equal(r.errorePagina.status, 429);
  assert.equal(r.troncato, false, 'errore, non raggiungimento del tetto'); assert.equal(chiamate(), 2);
});

test('AS24: l’unione conserva anche una grafia letta solo a metà, tutte fallite restano errore', async () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function scrapeAutoscoutUnion'), src.indexOf('// Auto e Moto usano sempre hades'));
  let fallisci = false;
  const contesto = vm.createContext({ scrapeAutoscoutSmart() { assert.fail('ripiego inatteso'); },
    async scrapeAutoscoutGraphql(p, opts) {
      assert.equal(opts.withMeta, true);
      const e = Object.assign(new Error('429'), { kind: 'blocked', status: 429 });
      if (fallisci) throw e;
      return p.autoscoutVersionText === 'prima' ? { items: [{ url: 'https://auto/1' }], parziale: 'pagina persa', bloccoParziale: e } : { items: [] };
    } });
  vm.runInContext(corpo, contesto);
  const r = await contesto.scrapeAutoscoutUnion({ autoscoutSpellings: ['prima', 'seconda'] });
  assert.equal(r.items.length, 1); assert.equal(r.bloccoParziale.status, 429); assert.match(r.parziale, /pagina persa/);
  fallisci = true;
  await assert.rejects(contesto.scrapeAutoscoutUnion({ autoscoutSpellings: ['prima', 'seconda'] }), { status: 429 });
});

test('Moto.it: markup non leggibile durante la verifica non riapre la fonte', async () => {
  const now = Date.now;
  salute.erroreHttp('moto', 429);
  const fine = salute.fermo('moto').fino;
  Date.now = () => fine + 1;
  const chiamate = finta(() => ({ status: 200, body: '<html><div class="plist-head-title-info">30 annunci</div></html>' }));
  try {
    await assert.rejects(motoit._scrapeVia(['https://www.moto.it/moto-usate/ricerca']), /markup/);
    assert.equal(salute.fermo('moto').fermo, true);
    await assert.rejects(motoit._get('https://www.moto.it/moto-usate/ricerca'), { code: 'FONTE_IN_PAUSA' });
    assert.equal(chiamate(), 1);
  } finally { Date.now = now; }
});

test('AS24: una grafia fermata localmente non viene ricontata come blocco del portale', async () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '../backend/server.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function scrapeAutoscoutUnion'), src.indexOf('// Auto e Moto usano sempre hades'));
  const locale = Object.assign(new Error('verifica in corso'), { kind: 'blocked', code: 'FONTE_IN_PAUSA' });
  const c = vm.createContext({ async scrapeAutoscoutGraphql(p) {
    if (p.autoscoutVersionText === 'seconda') throw locale;
    return { items: [{ url: 'https://auto/1' }] };
  } });
  vm.runInContext(corpo, c);
  const r = await c.scrapeAutoscoutUnion({ autoscoutSpellings: ['prima', 'seconda'] });
  salute.registra('autoscout', { errore: r.bloccoParziale });
  salute.registra('autoscout', { errore: Object.assign(new Error('403'), { status: 403 }) });
  assert.equal(salute.fermo('autoscout').fermo, false, 'un solo 403 reale deve restare un solo colpo');
  assert.strictEqual(r.bloccoParziale, locale);
});

const verificaMoto = async lavoro => {
  const now = Date.now;
  salute.erroreHttp('moto', 429);
  const fine = salute.fermo('moto').fino;
  Date.now = () => fine + 1;
  try { await lavoro(); } finally { Date.now = now; }
};
const pagMoto = 'https://www.moto.it/moto-usate/ricerca';
for (const [nome, leggi] of [
  ['ricerca', () => motoit._scrapeVia([pagMoto])],
  ['parco', () => vetrina.parco('prova')],
  ['anagrafica', () => vetrina.scheda('prova')],
]) {
  test(`Moto.it: manutenzione HTTP 200 non sblocca la verifica di ${nome}`, async () => {
    const chiamate = finta(() => ({ status: 200, body: '<html><h1>Temporarily unavailable</h1></html>' }));
    await verificaMoto(async () => {
      await assert.rejects(leggi(), /riconoscibile/);
      assert.equal(salute.fermo('moto').fermo, true);
      await assert.rejects(motoit._get(pagMoto), { code: 'FONTE_IN_PAUSA' });
      assert.equal(chiamate(), 1);
    });
  });
}

test('Moto.it: una ricerca con zero annunci dichiarati sblocca la fonte', async () => {
  finta(() => ({ status: 200, body: '<span class="plist-head-title-info">0 annunci</span>' }));
  await verificaMoto(async () => {
    assert.deepEqual((await motoit._scrapeVia([pagMoto])).pages, []);
    assert.equal(salute.fermo('moto').fino, null);
  });
});

for (const inventario of [false, true]) {
  test(`Moto.it: la vetrina riconoscibile sblocca ${inventario ? 'il parco anche vuoto' : 'l’anagrafica'}`, async () => {
    const $ = require('cheerio').load(fs.readFileSync(path.join(__dirname, 'fixtures/motoit-vetrina.html'), 'utf8'));
    $('.dlr-card').remove(); // conserva la struttura del concessionario, non inventa un marcatore di zero
    finta(() => ({ status: 200, body: $.html() }));
    await verificaMoto(async () => {
      const r = inventario ? await vetrina.parco('prova') : await vetrina.scheda('prova');
      if (inventario) assert.deepEqual(r.items, []);
      else assert.equal(r.nome, 'Niko Moto');
      assert.equal(salute.fermo('moto').fino, null);
    });
  });
}
