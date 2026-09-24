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
const competitor = require('../backend/competitor');
const ricambi = require('../backend/ricambi-core');
const salute = require('../backend/fonti-salute');
const routeCompetitor = require('../backend/competitor-route');
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
    salute.azzera('subito'); // secondo scenario indipendente: il primo ha già attivato la pausa
    const stato = await server._runSubito(params('moto', ['111', '222', '333']), 30000);
    assert.equal(stato.status, 'error');
    assert.match(stato.parziale, /Subito ha limitato temporaneamente le richieste/);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: due 403 effettivi fermano le famiglie successive', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const famiglia = new URL('https://local.invalid' + path).searchParams.get('bm');
    chiamate.push(famiglia);
    return famiglia === '111' ? ok([], 0) : { status: 403, body: '{}' };
  });
  try {
    const r = await subito(params('moto', ['111', '222', '333', '444']),
      { withMeta: true, senzaRecupero: true, pageDelayMs: 1 });
    assert.deepEqual(chiamate, ['111', '222', '333']);
    assert.equal(salute.fermo('subito').fermo, true);
    assert.match(r.parziale, /1 famiglia non chiesta dopo il blocco/);
    assert.equal(r.bloccoParziale?.status, 403);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: il 403 su una seconda pagina conta prima della famiglia seguente', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const q = new URL('https://local.invalid' + path).searchParams;
    const famiglia = q.get('bm'), start = Number(q.get('start'));
    chiamate.push([famiglia, start]);
    if (famiglia === '111' && !start) return ok(Array.from({ length: 50 }, (_, i) => annuncio(i)), 60);
    return { status: 403, body: '{}' };
  });
  try {
    const r = await subito(params('moto', ['111', '222', '333']),
      { withMeta: true, maxPages: 2, senzaRecupero: true, pageDelayMs: 1 });
    assert.deepEqual(chiamate, [['111', 0], ['111', 50], ['222', 0]]);
    assert.equal(r.items.length, 50);
    assert.equal(r.parzialeRete, true);
    assert.equal(r.bloccoParziale?.status, 403);
    assert.match(r.parziale, /1 famiglia non chiesta dopo il blocco/);
    assert.equal(salute.fermo('subito').fermo, true);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: una risposta buona fra due 403 azzera i colpi', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    const famiglia = new URL('https://local.invalid' + path).searchParams.get('bm');
    chiamate.push(famiglia);
    return famiglia === '111' || famiglia === '333'
      ? { status: 403, body: '{}' } : ok([annuncio(famiglia)], 1);
  });
  try {
    await subito(params('moto', ['111', '222', '333', '444']),
      { withMeta: true, senzaRecupero: true, pageDelayMs: 1 });
    assert.deepEqual(chiamate, ['111', '222', '333', '444']);
    assert.equal(salute.fermo('subito').fermo, false);
  } finally { subito._setHttpGetJson(null); }
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

test('Subito Moto: una pausa concorrente lascia il risultato parziale e non chiama altre famiglie', async () => {
  const chiamate = [];
  subito._setHttpGetJson(async path => {
    chiamate.push(new URL('https://local.invalid' + path).searchParams.get('bm'));
    salute.registra('subito', { errore: Object.assign(new Error('429 concorrente'), { status: 429 }) });
    return ok([annuncio(1)], 1);
  });
  try {
    const r = await subito(params('moto', ['111', '222', '333']),
      { withMeta: true, senzaRecupero: true, pageDelayMs: 1 });
    assert.deepEqual(chiamate, ['111']);
    assert.equal(r.parzialeRete, true);
    assert.equal(r.bloccoParziale?.code, 'FONTE_IN_PAUSA');
    assert.match(r.parziale, /2 famiglie non chieste dopo il blocco/);
    assert.match(r.parziale, /richieste sospese/);
  } finally { subito._setHttpGetJson(null); }
});

test('Subito Moto: 403 e 503 di famiglie diverse restano entrambi nella risposta', async () => {
  const stati = [403, 503, 200];
  subito._setHttpGetJson(async () => {
    const status = stati.shift();
    return status === 200 ? ok([annuncio(3)], 1) : { status, body: '{}' };
  });
  try {
    const r = await server._runSubito(params('moto', ['111', '222', '333']), 30000);
    assert.deepEqual(r.erroriSubito.map(e => [e.famiglia, e.fase, e.http]),
      [[1, 'pagina', 403], [2, 'pagina', 503]]);
    assert.equal(r.bloccoParziale?.status, 403);
    assert.equal(salute.fermo('subito').fermo, false);
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
    paginaErrore: null,
    SOURCE_STATUS: { error: { cls: 'src-bad', txt: 'errore' } },
    FONTE_LABEL: { subito: 'Subito' }, SKIP_REASON_TXT: {},
    escapeHtml: s => String(s),
  };
  vm.runInNewContext(src.slice(inizio, fine) + '\nrenderSourceStatus();', stato);
  assert.match(stato.fonteBreakdown.innerHTML, /src-avviso/);
  assert.match(stato.fonteBreakdown.innerHTML, /Subito ha limitato temporaneamente le richieste/);
});

test('Ricambi: la pausa Subito non invia richieste e lascia funzionare eBay', async () => {
  const errore = Object.assign(new Error('429 simulato'), { status: 429, kind: 'blocked' });
  salute.registra('subito', { errore });
  salute.registra('subito', { errore });
  let chiamate = 0;
  subito._setHttpGetJson(async () => { chiamate++; return ok([], 0); });
  try {
    const r = await ricambi.searchRicambi('faro prova', { mode: 'nome', veicolo: 'auto',
      ebay: async () => ({ articoli: [{ nome: 'faro prova', fonte: 'ebay' }] }),
      web: async () => { throw new Error('il web non deve partire'); },
    });
    assert.equal(chiamate, 0);
    assert.equal(r.sources.subito.status, 'blocked');
    assert.match(r.sources.subito.reason, /sospese|pausa/);
    assert.equal(r.sources.ebay.status, 'ok');
    assert.equal(r.count, 1);
  } finally { subito._setHttpGetJson(null); }
});

test('Ricambi: i 429 aggiornano la pausa condivisa e il tentativo successivo non parte', async () => {
  let chiamate = 0;
  subito._setHttpGetJson(async () => { chiamate++; return limitato(); });
  const opts = { mode: 'nome', veicolo: 'moto',
    ebay: async () => ({ articoli: [] }), web: async () => ({ articoli: [] }) };
  try {
    const primo = await ricambi.searchRicambi('faro prova', opts);
    assert.equal(primo.sources.subito.httpStatus, 429);
    assert.equal(salute.fermo('subito').fermo, true);
    await ricambi.searchRicambi('faro prova', opts);
    assert.equal(salute.fermo('subito').fermo, true);
    await ricambi.searchRicambi('faro prova', opts);
    assert.equal(chiamate, 1);
  } finally { subito._setHttpGetJson(null); }
});

function rotteParco(voci, parco, risolviVetrina = async () => { throw new Error('rilettura inattesa'); }) {
  const handlers = {};
  const app = Object.fromEntries(['get', 'post', 'delete'].map(m => [m,
    (p, ...h) => { handlers[m + ' ' + p] = h.at(-1); }]));
  routeCompetitor.mount(app, { competitor: {
    leggi: () => voci, scrivi: () => {}, parco, risolviVetrina, aggrega: competitor.aggrega,
  }, chiaveLimite: () => voci[0].id });
  return async (rotta, params, query = {}) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handlers['get ' + rotta]({ params, query }, res);
    return res;
  };
}

for (const parziale of [true, false]) test(`Competitor: gruppo ferma Subito dopo 429 ${parziale ? 'parziale' : 'totale'}, continua AS24`, async () => {
  const prefisso = parziale ? 'gruppo-parziale' : 'gruppo-totale';
  const voci = ['subito', 'subito', 'autoscout'].map((fonte, i) => ({
    fonte, id: prefisso + i, gruppo: prefisso, nome: 'Vetrina ' + i, schedaLetta: true,
  }));
  const chiamate = [];
  const errore = Object.assign(new Error('limite fonte'), { status: 429, kind: 'blocked' });
  const scr = async p => {
    chiamate.push(p.subitoUid || p.as24Customer);
    if (p.subitoUid) {
      if (!parziale) throw errore;
      return { items: [{ url: 'https://www.subito.it/auto/prova.htm' }], parzialeRete: true,
        bloccoParziale: errore, parziale: 'Messaggio modificabile senza codice numerico' };
    }
    return { items: [{ url: 'https://www.autoscout24.it/annunci/prova' }] };
  };
  const chiedi = rotteParco(voci, voce => competitor.parco(voce, { scrapeSubito: scr, scrapeAs24: scr }));
  const r = await chiedi('/api/competitor/gruppo/:g/parco', { g: prefisso });
  assert.equal(r.code, 200);
  assert.ok(!chiamate.includes(voci[1].id), 'la seconda vetrina Subito non va interrogata');
  assert.ok(chiamate.includes(voci[2].id), 'le altre fonti continuano');
  assert.ok(r.body.errori.some(e => e.id === voci[1].id));
  if (parziale) {
    assert.equal(r.body.parti[0].passateKo[0].status, 429);
    assert.ok(r.body.veicoli.some(v => v.url.includes('subito')));
  }
});

test('Competitor: un 429 nella rilettura della scheda non avvia il parco', async () => {
  let scarichi = 0;
  const voci = [{ fonte: 'subito', id: 'scheda429', url: 'https://www.subito.it/shops/123-prova' }];
  const chiedi = rotteParco(voci, async () => { scarichi++; return { veicoli: [] }; },
    async () => { throw Object.assign(new Error('limite fonte'), { status: 429, kind: 'blocked' }); });
  const r = await chiedi('/api/competitor/:id/parco', { id: 'subito:scheda429' });
  assert.equal(scarichi, 0);
  assert.equal(r.body.ok, false);
});

test('Competitor: la pagina della vetrina conserva il 429, lo registra una volta e rispetta la pausa', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const originale = https.get;
  let chiamate = 0;
  https.get = (_url, _opts, callback) => {
    chiamate++;
    const req = new EventEmitter();
    req.setTimeout = () => {};
    process.nextTick(() => callback(Object.assign(new EventEmitter(), { statusCode: 429, headers: {}, resume() {} })));
    return req;
  };
  try {
    const url = 'https://www.subito.it/shops/123-prova';
    await assert.rejects(competitor.risolviVetrina(url), e => e.status === 429 && e.message === subito.AVVISO_429);
    assert.equal(salute.fermo('subito').fermo, true);
    await assert.rejects(competitor.risolviVetrina(url), e => e.code === 'FONTE_IN_PAUSA');
    assert.equal(salute.fermo('subito').fermo, true);
    await assert.rejects(competitor.risolviVetrina(url), e => e.code === 'FONTE_IN_PAUSA');
    assert.equal(chiamate, 1);
  } finally { https.get = originale; }
});

test('Competitor: dopo un 429 i dati in cache restano disponibili e un blocco vecchio non ferma il gruppo', async () => {
  const voci = ['a', 'b'].map(id => ({ fonte: 'subito', id: 'cache429-' + id, gruppo: 'cache429', schedaLetta: true }));
  const chiamate = [];
  const chiedi = rotteParco(voci, async v => {
    chiamate.push(v.id);
    return { veicoli: [{ url: 'https://www.subito.it/auto/' + v.id + '.htm' }],
      passateKo: v === voci[0] ? [{ tipo: 'auto', status: 429, motivo: 'avviso senza numero' }] : [] };
  });
  await chiedi('/api/competitor/:id/parco', { id: 'subito:' + voci[1].id });
  const primo = await chiedi('/api/competitor/gruppo/:g/parco', { g: 'cache429' });
  assert.equal(primo.body.veicoli.length, 2);
  assert.equal(primo.body.parti[1].daCache, true);
  assert.deepEqual(chiamate, [voci[1].id, voci[0].id]);
  // La prima vetrina e' ora in cache con un vecchio 429. Una terza non in cache deve partire.
  voci.push({ fonte: 'subito', id: 'cache429-c', gruppo: 'cache429', schedaLetta: true });
  const secondo = await chiedi('/api/competitor/gruppo/:g/parco', { g: 'cache429' });
  assert.equal(secondo.body.parti.length, 3);
  assert.equal(chiamate.at(-1), 'cache429-c');
});

test('Schermo Competitor: il messaggio 429 resta visibile anche senza il numero nel testo', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
  const inizio = src.indexOf('function cpGruppoNumeriHTML(');
  const fine = src.indexOf('\nfunction cpGruppoHTML(', inizio);
  assert.ok(inizio >= 0 && fine > inizio);
  const contesto = { cpRiga: () => '', cpNum: String, escapeHtml: String };
  vm.runInNewContext(src.slice(inizio, fine), contesto);
  const html = contesto.cpGruppoNumeriHTML({ parti: [{ voce: { nome: 'Prova' },
    passateKo: [{ tipo: 'auto', status: 429, motivo: 'Testo approvato senza numero' }] }] }, [{}]);
  assert.match(html, /Testo approvato senza numero/);
});
