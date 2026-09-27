'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Modulo intero: veri fetchPage/riconosci/mapAd/cache, HTTP sintetico. Salute e cataloghi
// restano fuori da queste prove, che non aprono archivi né leggono credenziali.
function prepara() {
  const file = path.join(__dirname, '..', 'backend/scrapers/subito-api.js');
  const requireScraper = createRequire(file);
  const deps = {
    https: { get() { assert.fail('rete reale vietata'); } },
    '../budget-richieste': { conta() {} },
    '../fonti-salute': { richiesta: (_fonte, fn) => fn(), registra() {} },
    './versioni-unificate': { _perMarca: () => null },
    '../filtri-auto': { perSubito: () => ({}), chiaveCache: () => '' },
    '../province-sigla': { risolvi: () => null },
  };
  const reali = new Set(['./utils', '../annullo', './subito-nodo', './versione-dedotta']);
  const mod = { exports: {} }, chiamate = [], timer = new Set();
  const context = {
    module: mod, URLSearchParams, Buffer,
    console: { log() {}, warn() {} },
    require(id) {
      if (Object.hasOwn(deps, id)) return deps[id];
      assert.ok(reali.has(id), 'dipendenza inattesa: ' + id);
      return requireScraper(id);
    },
    setTimeout(fn, ms) { const t = setTimeout(fn, ms); timer.add(t); return t; },
    clearTimeout(t) { clearTimeout(t); timer.delete(t); },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const scrape = mod.exports;
  let wire;
  scrape._setHttpGetJson(async p => {
    const q = Object.fromEntries(new URL('https://mock.invalid' + p).searchParams);
    chiamate.push(q);
    return { status: 200, body: JSON.stringify(await wire(q)) };
  });
  return { scrape, chiamate, risposta(fn) { wire = fn; }, chiudi() { for (const t of timer) clearTimeout(t); } };
}

const params = (tipo, marcaId = '013') => ({ tipo, marca: 'Marca prova', modello: 'Modello prova',
  subitoNodo: { marcaId, famigliaIds: ['213'], generazioni: [{ id: '213' }] } });
const annuncio = (tipo, id, modello = '000000', rotto = false) => ({
  urn: `id:ad:synthetic:list:${id}`, subject: 'Marca prova Modello prova',
  urls: { default: `https://www.subito.it/annunci/synthetic-${id}.htm` },
  advertiser: { company: false },
  features: rotto ? [null] : [
    { uri: tipo === 'auto' ? '/car' : '/bike', values: [
      { label: 'Marca', key: '013', value: 'Marca prova' },
      { label: 'Modello', key: modello, value: 'Modello prova' },
      { label: 'Versione', key: '022', value: 'Base' },
    ] },
    { uri: '/price', label: 'Prezzo', values: [{ value: '1000 €' }] },
  ],
});
const recupero = q => (q.cm || q.bm) === '000000';
const retry = { withMeta: true, mainStart: null, recuperoStart: 0 };

for (const tipo of ['auto', 'moto']) {
  test(`${tipo}: una pagina recupero malformata si può riprovare senza attendere il TTL né ripetere la nativa`, async t => {
    const h = prepara(); t.after(() => h.chiudi());
    let rotto = true;
    h.risposta(q => ({ ads: [recupero(q) ? annuncio(tipo, 2, '000000', rotto) : annuncio(tipo, 1, '213')], count_all: 1 }));
    const primo = await h.scrape(params(tipo), { withMeta: true });
    assert.equal(primo.parzialeRete, true);
    assert.equal(primo.recuperoNextStart, 0);
    assert.deepEqual(Array.from(primo.items, x => x.id), ['subito:1']);
    assert.equal(primo.erroriSubito[0].fase, 'recupero');
    assert.equal(h.chiamate.length, 2);

    rotto = false;
    const secondo = await h.scrape(params(tipo), retry);
    assert.equal(secondo.parzialeRete, false);
    assert.equal(secondo.recuperoNextStart, null);
    assert.deepEqual(Array.from(secondo.items, x => x.id), ['subito:2']);
    assert.equal(h.chiamate.length, 3);
    assert.equal(h.chiamate.filter(q => !recupero(q)).length, 1);
    await h.scrape(params(tipo), retry);
    assert.equal(h.chiamate.length, 3, 'la pagina sana resta in cache');
  });
}

test('espellere una pagina guasta non svuota altre query; gli errori profondi non cancellano la prima pagina sana', async t => {
  const h = prepara(); t.after(() => h.chiudi());
  const sana = params('moto'), guasta = { ...sana, prezzoMax: 5000 };
  h.risposta(q => ({ ads: [annuncio('moto', 2, '000000', !!q.pe || q.start === '50')], count_all: 1 }));
  assert.equal((await h.scrape(sana, retry)).parzialeRete, false);
  assert.equal((await h.scrape(guasta, retry)).parzialeRete, true);
  assert.equal((await h.scrape(sana, retry)).parzialeRete, false);
  assert.equal(h.chiamate.length, 2, 'la query sana non deve essere riscaricata');
  assert.equal((await h.scrape(sana, { ...retry, recuperoStart: 50 })).parzialeRete, true);
  assert.equal((await h.scrape(sana, retry)).parzialeRete, false);
  assert.equal(h.chiamate.length, 3, 'la pagina profonda non è la prima pagina');

  h.risposta(() => { throw Object.assign(new Error('risposta interrotta'), { kind: 'transient' }); });
  assert.equal((await h.scrape(sana, { ...retry, recuperoStart: 50 })).parzialeRete, true);
  assert.equal((await h.scrape(sana, retry)).parzialeRete, false);
  assert.equal(h.chiamate.length, 4, 'un errore prima di ricevere la pagina non invalida la cache');
});

test('due consumatori condividono il guasto e poi un solo nuovo recupero; nessun retry automatico', async t => {
  const h = prepara(); t.after(() => h.chiudi());
  let rispondi;
  h.risposta(() => new Promise(resolve => { rispondi = resolve; }));
  const p = params('moto');
  const a = h.scrape(p, retry), b = h.scrape(p, retry);
  assert.equal(h.chiamate.length, 1);
  rispondi({ ads: [annuncio('moto', 2, '000000', true)], count_all: 1 });
  assert.ok((await Promise.all([a, b])).every(r => r.parzialeRete && r.recuperoNextStart === 0));
  assert.equal(h.chiamate.length, 1, 'il guasto non causa tentativi impliciti');

  const c = h.scrape(p, retry), d = h.scrape(p, retry);
  assert.equal(h.chiamate.length, 2, 'i due retry condividono una nuova richiesta');
  rispondi({ ads: [annuncio('moto', 2)], count_all: 1 });
  const esiti = await Promise.all([c, d]);
  assert.ok(esiti.every(r => !r.parzialeRete && r.items[0].id === 'subito:2'));
  await h.scrape(p, retry);
  assert.equal(h.chiamate.length, 2);
});

test('una fonte ancora malformata rimane un errore dichiarato e richiede un nuovo tentativo esplicito', async t => {
  const h = prepara(); t.after(() => h.chiudi());
  h.risposta(() => ({ ads: [annuncio('auto', 2, '000000', true)], count_all: 1 }));
  for (let n = 1; n <= 3; n++) {
    const r = await h.scrape(params('auto'), retry);
    assert.equal(r.parzialeRete, true);
    assert.equal(r.recuperoNextStart, 0);
    assert.ok(r.parziale);
    assert.equal(r.erroriSubito[0].fase, 'recupero');
    assert.equal(h.chiamate.length, n);
  }
});
