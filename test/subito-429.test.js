'use strict';
const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const subito = require('../backend/scrapers/subito-api');
const prova = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-subito-429-'));
process.env.USER_DATA_PATH = prova;
process.env.AMR_LOG_DIR = prova;
require('dotenv').config = () => ({ parsed: {} });
const server = require('../backend/server');
const salute = require('../backend/fonti-salute');
afterEach(() => salute.azzera());
after(() => { salute._reset(); fs.rmSync(prova, { recursive: true, force: true }); });

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

test('Subito: risposta oltre soglia conserva il motivo specifico fino alla fonte', async () => {
  subito._setHttpGetJson(async () => {
    throw Object.assign(new Error('Subito ha inviato una risposta oltre il limite di dimensione.'),
      { code: 'SUBITO_BODY_TOO_LARGE', kind: 'error' });
  });
  try {
    const r = await server._runSubito(params(), 30000);
    assert.equal(r.status, 'error');
    assert.equal(r.items.length, 0);
    assert.equal(r.erroreCodice, 'SUBITO_BODY_TOO_LARGE');
    assert.match(r.reason, /oltre il limite di dimensione/);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: cinquanta annunci sono una pagina; il totale esatto non provoca un 429 superfluo', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    chiamate.push(start);
    return start ? limitato() : ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 50);
  });
  try {
    // Anche chi chiede esplicitamente piu' profondita' deve fermarsi al totale letto.
    const r = await subito(params(), { withMeta: true, maxPages: 2, senzaRecupero: true });
    assert.deepEqual(chiamate, [0]);
    assert.equal(r.items.length, 50);
    assert.equal(r.hasMore, false);
    assert.equal(r.truncated, false);
    assert.equal(r.parzialeRete, false);
    assert.equal(salute.fermo('subito')?.fermo, false);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: la pagina standard e Carica altri usano start=0 e start=50', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    chiamate.push(start);
    return ok(Array.from({ length: 50 }, (_, i) => annuncio(start + i)), 100);
  });
  try {
    const prima = await subito(params(), { withMeta: true, senzaRecupero: true });
    assert.deepEqual(chiamate, [0], 'la seconda pagina non parte senza interazione');
    assert.equal(prima.items.length, 50);
    assert.equal(prima.hasMore, true);
    assert.equal(prima.truncated, true);
    const seconda = await subito(params(), { withMeta: true, fetta: 1, senzaRecupero: true });
    assert.deepEqual(chiamate, [0, 50]);
    assert.equal(seconda.items.length, 50);
    assert.equal(seconda.hasMore, false);
    assert.equal(seconda.truncated, false);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Auto e Moto: i due cursori avanzano e si esauriscono indipendentemente', async () => {
  for (const tipo of ['auto', 'moto']) {
    const chiamate = [];
    const p = params(tipo, ['111']);
    p.subitoNodo.marcaId = `cursori-${tipo}`;
    p.subitoNodo.generazioni = [{ id: '111' }];
    subito._setHttpGetJson(async path => {
      const q = new URL('https://local.invalid' + path).searchParams;
      const ramo = q.get(tipo === 'auto' ? 'cm' : 'bm') === '000000' ? 'recupero' : 'nativo';
      const start = Number(q.get('start'));
      chiamate.push([ramo, start]);
      if (ramo === 'nativo') return ok(Array.from({ length: 50 }, (_, i) => annuncio(start + i)), 100);
      if (start < 100) return ok(Array.from({ length: 50 }, (_, i) => ({
        ...annuncio(1000 + start + i), subject: 'Altro veicolo',
      })), 101);
      return ok([annuncio(1200)], 101);
    });
    try {
      const prima = await subito(p, { withMeta: true });
      assert.deepEqual([prima.mainNextStart, prima.recuperoNextStart, prima.hasMore], [50, 50, true]);
      const seconda = await subito(p, { withMeta: true, fetta: 1,
        mainStart: prima.mainNextStart, recuperoStart: prima.recuperoNextStart });
      assert.deepEqual([seconda.mainNextStart, seconda.recuperoNextStart, seconda.hasMore], [null, 100, true]);
      assert.equal(seconda.items.length, 50, 'zero candidati nel recupero non chiude il suo cursore');
      const terza = await subito(p, { withMeta: true, fetta: 2,
        mainStart: seconda.mainNextStart, recuperoStart: seconda.recuperoNextStart });
      assert.deepEqual(chiamate, [
        ['nativo', 0], ['recupero', 0], ['nativo', 50], ['recupero', 50], ['recupero', 100],
      ]);
      assert.equal(terza.items.length, 1);
      assert.equal(terza.items[0].dichiarazione, 'senza-modello');
      assert.deepEqual([terza.mainNextStart, terza.recuperoNextStart, terza.hasMore], [null, null, false]);
    } finally { subito._setHttpGetJson(null); }
  }
});

test('Subito: meno di 50 annunci, totale assente e filtri locali non cambiano il numero di pagine', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    chiamate.push(start);
    return ok(Array.from({ length: 37 }, (_, i) => annuncio(i)), 37);
  });
  try {
    const corta = await subito(params(), { withMeta: true, senzaRecupero: true });
    assert.deepEqual(chiamate, [0]);
    assert.equal(corta.items.length, 37);
    assert.equal(corta.hasMore, false);
  } finally { subito._setHttpGetJson(null); }

  chiamate.length = 0;
  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    chiamate.push(start);
    const ads = start ? [] : Array.from({ length: 50 }, (_, i) => ({
      ...annuncio(i), geo: { region: { friendly_name: 'Veneto' } },
    }));
    return { status: 200, body: JSON.stringify({ ads }) }; // count_all assente
  });
  try {
    const filtrata = await subito({ ...params(), regione: 'lombardia' },
      { withMeta: true, senzaRecupero: true });
    assert.deepEqual(chiamate, [0]);
    assert.equal(filtrata.items.length, 0);
    assert.equal(filtrata.hasMore, true, 'il filtro locale non rende esaurita la fonte');
    assert.equal(filtrata.total, null);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: seconda pagina 429 conserva la prima e dichiara il blocco', async () => {
  const chiamate = [];
  salute.azzera('subito');
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

test('Subito: una voce ambigua fa una sola ricerca testuale, Auto e Moto', async () => {
  for (const tipo of ['auto', 'moto']) {
    const chiamate = [];
    subito._setHttpGetJson(async path => {
      const q = new URL('https://local.invalid' + path).searchParams;
      chiamate.push(q);
      return ok([annuncio(tipo)], 1);
    });
    try {
      const r = await subito(params(tipo, ['111', '222', '333']),
        { withMeta: true, senzaRecupero: true });
      assert.equal(r.items.length, 1);
      assert.equal(chiamate.length, 1);
      assert.equal(chiamate[0].get('q'), 'Prova Modello');
      assert.equal(chiamate[0].get(tipo === 'auto' ? 'cm' : 'bm'), null);
      assert.equal(chiamate[0].get(tipo === 'auto' ? 'cb' : 'bb'), null);
    } finally { subito._setHttpGetJson(null); }
  }
});

test('Subito Moto: la pausa locale non diventa una famiglia interrogata', async () => {
  salute.registra('subito', { errore: Object.assign(new Error('429'), { status: 429 }) });
  const chiamate = [];
  subito._setHttpGetJson(async path => { chiamate.push(path); return ok([], 0); });
  try {
    await assert.rejects(() => subito(params('moto', ['111', '222']),
      { withMeta: true, senzaRecupero: true, pageDelayMs: 1 }),
    e => e.code === 'FONTE_IN_PAUSA');
    assert.deepEqual(chiamate, []);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: pagina e recupero falliti nella stessa famiglia sono due errori', async () => {
  subito._setHttpGetJson(async path => {
    const q = new URL('https://local.invalid' + path).searchParams;
    if (q.get('bm') === '000000') return { status: 503, body: '{}' };
    return Number(q.get('start')) ? { status: 403, body: '{}' }
      : ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 60);
  });
  try {
    const p = params('moto', ['111']);
    p.subitoNodo.marcaId = 'errori-recupero';
    p.subitoNodo.generazioni = [{ id: '111' }];
    const r = await subito(p, { withMeta: true, maxPages: 2 });
    assert.deepEqual(r.erroriSubito.map(e => [e.fase, e.http]),
      [['pagina', 403], ['recupero', 503]]);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: un body illeggibile con HTTP 200 non viene presentato come errore HTTP 200', async () => {
  subito._setHttpGetJson(async () => ({ status: 200, body: '{' }));
  try {
    const r = await server._runSubito(params(), 30000);
    assert.equal(r.status, 'error');
    assert.deepEqual(r.erroriSubito.map(e => [e.http, e.tipo]), [[null, 'blocked']]);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito: il timeout complessivo e transitorio e permette di riprovare la pagina', async () => {
  subito._setHttpGetJson(() => new Promise(() => {}));
  try {
    const r = await server._runSubito(params(), 10, 'subito');
    assert.equal(r.status, 'timeout');
    assert.equal(r.erroreTipo, 'transient');
    assert.equal(r.items.length, 0);
    assert.equal(salute.stato().fonti.find(f => f.fonte === 'subito')?.esito, 'transitorio');
    assert.equal(salute.fermo('subito').fermo, false);
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

test('Subito: il 429 sulla prima pagina e sulla pagina richiesta dopo hanno stati diversi', async () => {
  subito._setHttpGetJson(async () => limitato());
  try {
    const negato = await server._runSubito(params(), 30000);
    assert.equal(negato.status, 'error');
    assert.equal(negato.items.length, 0);
    assert.match(negato.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }

  salute.azzera('subito');
  subito._setHttpGetJson(async path => {
    const start = Number(new URL('https://local.invalid' + path).searchParams.get('start'));
    return start === 0 ? ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 60) : limitato();
  });
  try {
    const prima = await server._runSubito(params(), 30000);
    assert.equal(prima.status, 'ok');
    assert.equal(prima.items.length, 50);
    assert.equal(prima.hasMore, true);
    assert.equal(prima.parziale, null);
    const seconda = await server._runSubito({ ...params(), fetta: 1 }, 30000);
    assert.equal(seconda.status, 'error');
    assert.equal(seconda.items.length, 0);
    assert.match(seconda.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }
});

test('Schermo Auto/Moto: il 429 senza annunci compare negli avvisi sulla ricerca', () => {
  const src = require('../scripts/build-frontend').frontendSourceSync().js;
  const inizio = src.indexOf('function renderSourceStatus()');
  const fine = src.indexOf('\n// ─── Spec (dettaglio)', inizio);
  assert.ok(inizio >= 0 && fine > inizio);
  const stato = {
    fonteBreakdown: { innerHTML: '' }, searchAlerts: { innerHTML: '', classList: { toggle() {} } },
    lastSources: { subito: { status: 'error', parziale: subito.AVVISO_429 } },
    paginaErrore: null,
    SOURCE_STATUS: { error: { cls: 'src-bad', txt: 'errore' } },
    FONTE_LABEL: { subito: 'Subito' }, SKIP_REASON_TXT: {},
    escapeHtml: s => String(s),
    renderSearchAlerts(avvisi) { stato.searchAlerts.innerHTML = avvisi.join(' '); },
  };
  vm.runInNewContext(src.slice(inizio, fine) + '\nrenderSourceStatus();', stato);
  assert.equal(stato.fonteBreakdown.innerHTML.includes('src-avviso'), false);
  assert.match(stato.searchAlerts.innerHTML, /Subito ha limitato temporaneamente le richieste/);
});
