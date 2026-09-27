'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Si eseguono core e rotta veri con le sole porte esterne sostituite: nessun
// import di scraper/cataloghi/credenziali e nessuna connessione alle fonti.
function carica(file, deps) {
  const mod = { exports: {} };
  new Function('require', 'module', fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))(id => {
    assert.ok(Object.hasOwn(deps, id), `import inatteso: ${id}`);
    return deps[id];
  }, mod);
  return mod.exports;
}
function ambiente(t, risposta) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ricambi-meta-'));
  const prima = { USER_DATA_PATH: process.env.USER_DATA_PATH, AMR_LOG_DIR: process.env.AMR_LOG_DIR };
  process.env.USER_DATA_PATH = dir;
  process.env.AMR_LOG_DIR = dir;
  t.after(() => {
    for (const [k, v] of Object.entries(prima)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const chiamate = [];
  const salute = { fermo: () => ({ fermo: false }), registra() {}, conStatoFonti: x => x };
  const vuota = async () => ({ articoli: [] });
  const normOen = s => s.replace(/\W/g, '').toUpperCase();
  const oem = { normOen, lookupOem: vuota };
  const ebay = { searchEbay: async () => [] };
  const core = carica('backend/ricambi-core.js', {
    './oem-lookup': oem, './cmsnl-lookup': { lookupCmsnl: vuota },
    './web-parts': { searchWebParts: vuota }, './ebay-scrape': ebay,
    './logger': { info() {}, warn() {} }, './fonti-salute': salute,
    './annullo': require('../backend/annullo'),
    './scrapers/subito-api': { searchAccessori: async (q, opts) => {
      chiamate.push({ q, opts });
      const r = await risposta();
      return opts.withMeta ? r : r.items;
    } },
  });
  const handlers = {};
  carica('backend/ricambi-route.js', {
    './fonti-salute': salute, './ricambi-core': core, './oem-lookup': oem,
    './ebay-scrape': ebay, './limite-richieste': require('../backend/limite-richieste'),
  }).mount({ get: (p, ...h) => { handlers[p] = h.at(-1); } }, { clientIp: () => 'isolato' });
  async function chiedi(query = {}) {
    const req = { query: { q: 'faro', mode: 'nome', ...query } };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handlers['/api/ricambi'](req, res);
    return res;
  }
  return { core, chiamate, chiedi };
}
const item = (i, extra = {}) => ({ titolo: `Faro ${i}`, prezzo: 25, prezzoSuRichiesta: false,
  prezzoIlleggibile: false, venditore: 'privato', url: `https://www.subito.it/accessori/faro-${i}.htm`, ...extra });
const pagina = (items, extra = {}) => ({ items, total: items.length, truncated: false,
  hasMore: false, sospetto: null, parziale: null, parzialeRete: false, ...extra });

test('prezzo Ricambi: numerico, zero, richiesta, assente e illeggibile restano distinti; niente campi privati', async t => {
  const h = ambiente(t, () => pagina([
    item(1), item(2, { prezzo: 0 }), item(3, { prezzo: null, prezzoSuRichiesta: true }),
    item(4, { prezzo: null }), item(5, { prezzo: null, prezzoIlleggibile: true,
      desc: 'dato privato sintetico', venditoreId: 'privato-id', venditoreNome: 'nome privato sintetico', _raw: { secret: 'no' } }),
  ]));
  const { body, code } = await h.chiedi();
  assert.equal(code, 200);
  assert.deepEqual(body.articoli.map(x => [x.prezzo, x.prezzoSuRichiesta, x.prezzoIlleggibile]), [
    [25, false, false], [0, false, false], [null, true, false], [null, false, false], [null, false, true],
  ]);
  for (const r of body.articoli) for (const campo of ['desc', 'venditoreNome', 'venditoreId', '_raw']) {
    assert.equal(Object.hasOwn(r, campo), false);
  }
  assert.equal(h.chiamate.length, 1);
});

test('50 su 75: conserva copertura grezza, filtro locale e metadati nella cache senza nuove richieste', async t => {
  const items = Array.from({ length: 50 }, (_, i) => item(i, { titolo: i < 30 ? `Faro ${i}` : `Bullone ${i}` }));
  const h = ambiente(t, () => pagina(items, { total: 75, truncated: true, hasMore: true }));
  const a = await h.chiedi(), b = await h.chiedi();
  for (const { body } of [a, b]) {
    assert.equal(body.count, 30);
    assert.equal(body.sources.subito.count, 30);
    assert.equal(body.sources.subito.total, 75);
    assert.equal(body.sources.subito.truncated, true);
    assert.equal(body.sources.subito.hasMore, true);
  }
  assert.equal(h.chiamate.length, 1);
  assert.deepEqual(h.chiamate[0].opts, { cat: 'auto', withMeta: true });
});

test('copertura Ricambi: vuoto valido, totale ignoto e lista completa non diventano la stessa risposta', async t => {
  let r = pagina([]);
  const h = ambiente(t, () => r);
  const vuota = await h.chiedi();
  assert.equal(vuota.body.sources.subito.total, 0);
  assert.equal(vuota.body.sources.subito.hasMore, false);
  r = pagina([item(1)], { total: null, hasMore: true, truncated: true });
  const ignota = await h.chiedi({ q: 'faro ignoto' });
  assert.equal(ignota.body.sources.subito.total, null);
  assert.equal(ignota.body.sources.subito.hasMore, true);
  r = pagina([item(1)]);
  const completa = await h.chiedi({ q: 'faro completo', veicolo: 'moto' });
  assert.equal(completa.body.sources.subito.total, 1);
  assert.equal(completa.body.sources.subito.truncated, false);
  assert.equal(h.chiamate.at(-1).opts.cat, 'moto');
});

test('avvisi Ricambi: il parser conserva le righe e gli avvisi anche in cache', async t => {
  const avviso = '1 annuncio ha un campo prezzo non leggibile';
  const h = ambiente(t, () => pagina([item(1, { prezzo: null, prezzoIlleggibile: true })], { sospetto: avviso }));
  const prima = await h.chiedi(), cache = await h.chiedi();
  assert.equal(prima.body.sources.subito.status, 'ok');
  assert.equal(prima.body.sources.subito.sospetto, avviso);
  assert.equal(cache.body.sources.subito.sospetto, avviso);
  assert.equal(cache.body.articoli.length, 1);
  assert.equal(h.chiamate.length, 1);
});

test('errore dopo una risposta parziale: non congela in cache il risultato incompleto di rete', async t => {
  const avviso = 'Subito non ha restituito tutte le pagine della ricerca.';
  const h = ambiente(t, () => pagina([item(1)], { parziale: avviso, parzialeRete: true }));
  const a = await h.chiedi();
  await h.chiedi();
  assert.equal(a.body.sources.subito.parzialeRete, true);
  assert.equal(a.body.sources.subito.parziale, avviso);
  assert.equal(h.chiamate.length, 2);
});

test('errore Ricambi: una fonte illeggibile senza annunci non viene dichiarata vuota o cachata', async t => {
  const h = ambiente(t, () => pagina([], { sospetto: 'risposta illeggibile' }));
  const a = await h.chiedi();
  await h.chiedi();
  assert.equal(a.body.sources.subito.status, 'error');
  assert.equal(a.body.sources.subito.reason, 'risposta illeggibile');
  assert.equal(h.chiamate.length, 2);
});
