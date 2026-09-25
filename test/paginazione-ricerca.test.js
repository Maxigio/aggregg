'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const pagina = app.slice(app.indexOf('let fettaPresa = 0;'), app.indexOf('\nasync function doSearch()'));
const riga = id => ({ fonte: 'subito', url: `https://www.subito.it/auto/prova-${id}.htm`, prezzo: 1000 + id });

function schermo(risposte, sources = { subito: { status: 'ok', count: 50, totale: 1000, hasMore: true } }) {
  const richieste = [], urls = [], avvisi = [];
  const pulsante = { disabled: false, textContent: '' };
  const box = { classList: { toggle(_classe, nascosto) { box.nascosto = nascosto; } }, querySelector: () => pulsante };
  const ctx = vm.createContext({
    URLSearchParams, setTimeout: () => 1, clearTimeout() {},
    searchGen: 1, searchActive: true, lastSearchParams: { tipo: 'auto', marca: 'Prova' },
    currentResults: Array.from({ length: 50 }, (_, i) => riga(i)), lastSources: sources,
    FONTE_LABEL: { subito: 'Subito', autoscout: 'AutoScout24', moto: 'Moto.it' },
    document: { getElementById: id => id === 'caricaAltri' ? box : null },
    renderSourceStatus() {}, renderResults() {}, initPrezzoSlider() {},
    toast: s => avvisi.push(s), manigliePrezzoStrette: () => null, prezzoSliderInstance: null,
    fetch: async url => { urls.push(url); richieste.push(Number(new URL('https://prova.invalid' + url).searchParams.get('fetta')));
      return { ok: true, json: async () => { const r = risposte.shift(); return { ...r, sources: {
        subito: { status: 'skipped' }, autoscout: { status: 'skipped' }, moto: { status: 'skipped' }, ...r.sources,
      } }; } }; },
  });
  vm.runInContext(pagina, ctx);
  return { ctx, richieste, urls, avvisi, box, pulsante };
}

test('chiede la pagina solo alle fonti ancora aperte e conserva la fonte esaurita', async () => {
  const s = schermo([{ risultati: [{ fonte: 'autoscout', url: 'https://autoscout24.it/nuovo', prezzo: 2000 }],
    sources: { autoscout: { status: 'ok', count: 1, hasMore: true } } }], {
    subito: { status: 'ok', count: 50, hasMore: false },
    autoscout: { status: 'ok', count: 20, hasMore: true },
  });
  await s.ctx.caricaAltri();
  assert.equal(new URL('https://prova.invalid' + s.urls[0]).searchParams.get('fonti'), 'autoscout');
  assert.equal(s.ctx.lastSources.subito.status, 'ok');
  assert.equal(s.ctx.lastSources.subito.hasMore, false);
  assert.equal(s.ctx.currentResults.length, 51);
});

test('dopo che Subito si esaurisce, il pulsante unico continua solo con AutoScout', async () => {
  const s = schermo([
    { risultati: [riga(50)], sources: {
      subito: { status: 'ok', hasMore: false },
      autoscout: { status: 'ok', hasMore: true },
    } },
    { risultati: [{ fonte: 'autoscout', url: 'https://autoscout24.it/2', prezzo: 2000 }],
      sources: { autoscout: { status: 'ok', hasMore: false } } },
  ], {
    subito: { status: 'ok', hasMore: true },
    autoscout: { status: 'ok', hasMore: true },
  });
  await s.ctx.caricaAltri();
  assert.equal(s.pulsante.textContent, 'Carica altro');
  await s.ctx.caricaAltri();
  assert.deepEqual(s.urls.map(url => new URL('https://prova.invalid' + url).searchParams.get('fonti')),
    ['subito,autoscout', 'autoscout']);
  assert.equal(s.box.nascosto, true);
});

test('una fonte vuota ed esaurita resta vuota mentre avanzano le altre', async () => {
  const s = schermo([{ risultati: [], sources: { autoscout: { status: 'empty', hasMore: false } } }], {
    subito: { status: 'empty', count: 0, hasMore: false },
    autoscout: { status: 'ok', count: 20, hasMore: true },
  });
  await s.ctx.caricaAltri();
  assert.equal(s.ctx.lastSources.subito.status, 'empty');
  assert.equal(s.ctx.lastSources.subito.hasMore, false);
});

test('pagina intermedia fallita: nessuna riga nuova, stessa pagina riprovabile', async () => {
  const s = schermo([
    { risultati: Array.from({ length: 25 }, (_, i) => riga(i + 50)), sources: {
      subito: { status: 'ok', count: 25, totale: 1000, hasMore: true, parzialeRete: true,
        parziale: 'pagina 2 caduta', erroreTipo: 'transient' },
    } },
    { risultati: Array.from({ length: 50 }, (_, i) => riga(i + 50)), sources: {
      subito: { status: 'ok', count: 50, totale: 1000, hasMore: true },
    } },
  ]);
  await s.ctx.caricaAltri();
  assert.equal(s.ctx.currentResults.length, 50);
  assert.equal(vm.runInContext('fettaPresa', s.ctx), 0);
  assert.match(s.pulsante.textContent, /Riprova/);
  vm.runInContext('paginaErrore.dopo = 0', s.ctx);
  await s.ctx.caricaAltri();
  assert.deepEqual(s.richieste, [1, 1]);
  assert.equal(s.ctx.currentResults.length, 100);
});

test('429: ferma la pagina e impedisce un tentativo prima della pausa', async () => {
  const s = schermo([{ risultati: Array.from({ length: 25 }, (_, i) => riga(i + 50)), sources: {
    subito: { status: 'ok', count: 25, totale: 1000, hasMore: true, parzialeRete: true,
      parziale: 'richieste limitate', erroreTipo: 'blocked', erroreHttp: 429,
      pausa: { fermo: true, fino: Date.now() + 60_000 } },
  } }]);
  await s.ctx.caricaAltri();
  assert.equal(s.ctx.currentResults.length, 50);
  assert.equal(s.pulsante.disabled, true);
  assert.match(s.avvisi.at(-1), /Subito|429|limitat/i);
  await s.ctx.caricaAltri();
  assert.deepEqual(s.richieste, [1]);
});

test('fonte esaurita: il totale grezzo non confronta le righe filtrate', () => {
  const s = schermo([], { subito: { status: 'ok', totale: 80, count: 20, hasMore: false } });
  s.ctx.currentResults = Array.from({ length: 20 }, (_, i) => riga(i));
  assert.equal(s.ctx.altriDisponibili(), false);
});

test('oltre la fetta massima non richiede di nuovo la stessa pagina', async () => {
  const s = schermo([]);
  vm.runInContext('fettaPresa = 50', s.ctx);
  s.ctx.renderAltriBtn();
  assert.equal(s.pulsante.disabled, true);
  assert.match(s.pulsante.textContent, /limite/i);
  await s.ctx.caricaAltri();
  assert.deepEqual(s.richieste, []);
});

test('nessuna riga visibile ma la fonte ha altre pagine: il pulsante resta accessibile', () => {
  const s = schermo([], { subito: { status: 'empty', totale: 500, count: 0, hasMore: true } });
  s.ctx.currentResults = [];
  s.ctx.renderAltriBtn();
  assert.equal(s.box.nascosto, false);
  const html = fs.readFileSync(path.join(__dirname, '../frontend/index.html'), 'utf8');
  assert.ok(html.indexOf('id="caricaAltri"') > html.indexOf('id="noResults"'),
    'il pulsante deve essere visibile anche quando resultsSection è nascosta');
});

test('un errore di una fonte non pubblica neppure gli annunci delle altre', async () => {
  const s = schermo([{ risultati: [riga(50), { fonte: 'autoscout', url: 'https://autoscout24.it/1' }], sources: {
    subito: { status: 'ok', hasMore: true },
    autoscout: { status: 'timeout', erroreTipo: 'transient', hasMore: null },
  } }]);
  await s.ctx.caricaAltri();
  assert.equal(s.ctx.currentResults.length, 50);
  assert.equal(vm.runInContext('fettaPresa', s.ctx), 0);
  assert.match(s.pulsante.textContent, /Riprova/);
});

test('403 e formato illeggibile interrompono la pagina, senza ripetizione automatica', async () => {
  for (const stato of [
    { status: 'error', erroreTipo: 'blocked', erroreHttp: 403 },
    { status: 'error', erroreTipo: 'error' },
  ]) {
    const s = schermo([{ risultati: [], sources: { subito: stato } }]);
    await s.ctx.caricaAltri();
    assert.equal(vm.runInContext('fettaPresa', s.ctx), 0);
    assert.equal(s.box.nascosto, true);
    assert.equal(vm.runInContext('paginaErrore.riprovabile', s.ctx), false);
  }
});

test('403 e 503 sulla stessa fonte: la pagina elenca entrambi e non promette un retry immediato', async () => {
  const s = schermo([{ risultati: [], sources: { subito: {
    status: 'error', parzialeRete: true, erroreTipo: 'transient', erroreHttp: 503,
    errori: [{ famiglia: 1, fase: 'pagina', http: 403, tipo: 'blocked' },
      { famiglia: 2, fase: 'pagina', http: 503, tipo: 'transient' }],
  } } }]);
  await s.ctx.caricaAltri();
  assert.equal(vm.runInContext('paginaErrore.riprovabile', s.ctx), false);
  assert.match(s.avvisi.at(-1), /403/);
  assert.match(s.avvisi.at(-1), /503/);
  assert.equal(vm.runInContext('fettaPresa', s.ctx), 0);
});

test('pagina completa senza annunci supera i filtri e può chiudere la fonte', async () => {
  const s = schermo([{ risultati: [], sources: { subito: {
    status: 'empty', totale: 80, count: 0, hasMore: false,
  } } }]);
  await s.ctx.caricaAltri();
  assert.equal(vm.runInContext('fettaPresa', s.ctx), 1);
  assert.equal(s.box.nascosto, true);
  assert.equal(s.ctx.currentResults.length, 50);
});

test('pausa della fonte malformata: nessuna data invalida e nessuna raffica', async () => {
  const s = schermo([{ risultati: [], sources: { subito: {
    status: 'error', erroreTipo: 'blocked', erroreHttp: 429,
    pausa: { fermo: true, fino: '<non-una-data>' },
  } } }]);
  await s.ctx.caricaAltri();
  assert.equal(s.pulsante.disabled, true);
  assert.doesNotMatch(s.avvisi.at(-1), /Invalid Date|non-una-data/);
  assert.equal(vm.runInContext('fettaPresa', s.ctx), 0);
});

test('un 403 insieme a un 429 resta definitivo e non promette un retry', async () => {
  const s = schermo([{ risultati: [], sources: {
    subito: { status: 'error', erroreTipo: 'blocked', erroreHttp: 429,
      pausa: { fermo: true, fino: Date.now() + 60_000 } },
    autoscout: { status: 'error', erroreTipo: 'blocked', erroreHttp: 403 },
  } }]);
  await s.ctx.caricaAltri();
  assert.equal(s.box.nascosto, true);
  assert.match(s.avvisi.at(-1), /403/);
  assert.doesNotMatch(s.avvisi.at(-1), /Riprova dal/);
});
