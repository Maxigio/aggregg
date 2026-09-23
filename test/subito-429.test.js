'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const subito = require('../backend/scrapers/subito-api');
const prova = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-subito-429-'));
after(() => fs.rmSync(prova, { recursive: true, force: true }));
process.env.USER_DATA_PATH = prova;
process.env.AMR_LOG_DIR = prova;
require('dotenv').config = () => ({ parsed: {} });
const server = require('../backend/server');
const competitor = require('../backend/competitor');
const ricambi = require('../backend/ricambi-core');

const params = (tipo = 'auto', famiglie = null) => ({
  tipo, marca: 'Prova', modello: 'Modello',
  ...(famiglie ? { subitoNodo: { marcaId: '987654', famigliaIds: famiglie } } : {}),
});
const annuncio = n => ({
  urls: { default: `https://www.subito.it/auto/prova-${n}.htm` },
  subject: `Prova Modello ${n}`,
  features: [{ label: 'Prezzo', values: [{ value: '10000 €' }] }],
});
const ok = (ads, count_all = ads.length) => ({ status: 200, body: JSON.stringify({ ads, count_all }) });
const limitato = () => ({ status: 429, body: '{}' });

test('Subito: ads vuoto e risposta valida restano un risultato vuoto', async () => {
  subito._setHttpGetJson(async () => ok([], 0));
  try {
    const r = await server._runSubito(params(), 30000);
    assert.equal(r.status, 'empty');
    assert.equal(r.parziale, null);
    assert.equal(r.items.length, 0);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: seconda pagina 429 conserva la prima e dichiara il blocco', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    chiamate.push(start);
    return start === 0 ? ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 60) : limitato();
  });
  try {
    const r = await subito(params(), { withMeta: true, maxPages: 2, senzaRecupero: true });
    assert.deepEqual(chiamate, [0, 50]);
    assert.equal(r.items.length, 50);
    assert.equal(r.parzialeRete, true);
    assert.equal(r.bloccoParziale?.status, 429);
    assert.match(r.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: 429 ferma le famiglie moto ancora in coda e non dichiara un vuoto completo', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const famiglia = new URL('https://local.invalid' + path).searchParams.get('bm');
    chiamate.push(famiglia);
    return famiglia === '222' ? limitato() : ok([], 0);
  });
  try {
    const r = await subito(params('moto', ['111', '222', '333']), { withMeta: true, maxPages: 1, senzaRecupero: true });
    assert.deepEqual(chiamate, ['111', '222']);
    assert.equal(r.items.length, 0);
    assert.equal(r.parzialeRete, true);
    assert.equal(r.bloccoParziale?.status, 429);
    assert.match(r.parziale, /Subito ha limitato temporaneamente le richieste/);
    const stato = await server._runSubito(params('moto', ['111', '222', '333']), 30000);
    assert.equal(stato.status, 'error');
    assert.match(stato.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: 429 nel recupero conserva il risultato principale e arriva al freno', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const modello = new URL('https://local.invalid' + path).searchParams.get('cm');
    chiamate.push(modello);
    return modello === '000000' ? limitato() : ok([annuncio(1)], 1);
  });
  try {
    const r = await subito({ ...params(), subitoNodo: {
      marcaId: '987654', famigliaIds: ['111'], generazioni: [{ id: '111' }],
    } }, { withMeta: true, maxPages: 1 });
    assert.deepEqual(chiamate, ['111', '000000']);
    assert.equal(r.items.length, 1);
    assert.equal(r.parzialeRete, true);
    assert.equal(r.bloccoParziale?.status, 429);
    assert.match(r.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: il 429 sulla prima pagina e il risultato parziale hanno stati diversi', async () => {
  subito._setHttpGetJson(async () => limitato());
  try {
    const negato = await server._runSubito(params(), 30000);
    assert.equal(negato.status, 'error');
    assert.equal(negato.items.length, 0);
    assert.match(negato.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }

  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    return start === 0 ? ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 60) : limitato();
  });
  try {
    const parziale = await server._runSubito(params(), 30000);
    assert.equal(parziale.status, 'ok');
    assert.equal(parziale.items.length, 50);
    assert.match(parziale.parziale, /Subito ha limitato temporaneamente le richieste/);
    assert.equal(server._cacheable({ sources: { subito: parziale }, totale: 50 }), false);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: il 429 sulla seconda pagina di una famiglia ferma le altre famiglie', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const q = new URL('https://local.invalid' + path).searchParams;
    chiamate.push([q.get('bm'), Number(q.get('start'))]);
    return Number(q.get('start')) === 0
      ? ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 60) : limitato();
  });
  try {
    const r = await subito(params('moto', ['111', '222']), { withMeta: true, maxPages: 2, senzaRecupero: true });
    assert.deepEqual(chiamate, [['111', 0], ['111', 50]]);
    assert.equal(r.items.length, 50);
    assert.equal(r.total, 60);
    assert.equal(r.bloccoParziale.status, 429);
    assert.equal(r.parziale.match(/Subito ha limitato temporaneamente le richieste/g).length, 1);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: un 429 dopo un 403 resta il motivo del blocco visibile', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const famiglia = new URL('https://local.invalid' + path).searchParams.get('bm');
    chiamate.push(famiglia);
    return famiglia === '111' ? { status: 403, body: '{}' } : limitato();
  });
  try {
    const r = await server._runSubito(params('moto', ['111', '222', '333']), 30000);
    assert.deepEqual(chiamate, ['111', '222']);
    assert.equal(r.status, 'error');
    assert.match(r.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }
});

test('Competitor: una passata Subito parziale per 429 conserva le auto e non avvia le moto', async () => {
  const chiamate = [], saluteVista = [];
  const e = Object.assign(new Error('Subito hades HTTP 429'), { kind: 'blocked', status: 429 });
  const r = await competitor.parco({ fonte: 'subito', id: 'venditore-prova' }, {
    scrapeSubito: async ({ tipo }) => {
      chiamate.push(tipo);
      return { items: [{ url: 'https://www.subito.it/auto/prova.htm', titolo: 'Auto prova' }],
        total: 100, truncated: false, parzialeRete: true, bloccoParziale: e, parziale: subito.AVVISO_429 };
    },
    salute: { fermo: () => ({ fermo: false }), registra: (_, stato) => saluteVista.push(stato), MOTIVO_PAUSA: 'in pausa' },
  });
  assert.deepEqual(chiamate, ['auto']);
  assert.equal(r.veicoli.length, 1);
  assert.equal(r.troncato, false);
  assert.equal(r.totaleFonte, null);
  assert.match(r.passateKo[0].motivo, /Subito ha limitato temporaneamente le richieste/);
  assert.equal(saluteVista[0].errore.status, 429);
});

test('Ricambi: il 429 Subito diventa un blocco con avviso visibile, non un mercato vuoto', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => { chiamate.push(path); return limitato(); });
  try {
    const r = await ricambi.searchRicambi('faro prova', {
      mode: 'nome', veicolo: 'auto',
      ebay: async () => ({ articoli: [] }), web: async () => ({ articoli: [] }),
    });
    assert.equal(chiamate.length, 1);
    assert.equal(r.sources.subito.status, 'blocked');
    assert.equal(r.sources.subito.reason, subito.AVVISO_429);
    assert.equal(r.count, 0);
  } finally { subito._setHttpGetJson(null); }
});

test('Schermo Auto/Moto: il 429 senza annunci compare come avviso sotto le fonti', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
  const inizio = src.indexOf('function renderSourceStatus()');
  const fine = src.indexOf('\n// ─── Spec (dettaglio)', inizio);
  assert.ok(inizio >= 0 && fine > inizio);
  const stato = {
    fonteBreakdown: { innerHTML: '' },
    lastSources: { subito: { status: 'error', parziale: subito.AVVISO_429 } },
    SOURCE_STATUS: { error: { cls: 'src-bad', txt: 'errore' } },
    FONTE_LABEL: { subito: 'Subito' }, SKIP_REASON_TXT: {},
    escapeHtml: s => String(s),
  };
  vm.runInNewContext(src.slice(inizio, fine) + '\nrenderSourceStatus();', stato);
  assert.match(stato.fonteBreakdown.innerHTML, /src-avviso/);
  assert.match(stato.fonteBreakdown.innerHTML, /Subito ha limitato temporaneamente le richieste/);
});
