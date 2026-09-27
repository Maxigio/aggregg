'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Si sostituiscono soltanto le dipendenze: parco e aggrega sono eseguiti dal
// modulo originale, senza database, cataloghi, credenziali o richieste reali.
function competitor() {
  const mod = { exports: {} };
  const deps = { https: {}, zlib: {}, cheerio: {}, fs, path,
    './utenti-db': {}, './scrapers/autoscout-graphql': {}, './scrapers/subito-api': {},
    './scrapers/motoit-vetrina': {}, './scrapers/detail': {}, './fonti-salute': {},
  };
  new Function('require', 'module', fs.readFileSync(path.join(__dirname, '../backend/competitor.js'), 'utf8'))(id => {
    assert.ok(Object.hasOwn(deps, id), `import inatteso: ${id}`);
    return deps[id];
  }, mod);
  return mod.exports;
}
const freno = () => ({ fermo: () => ({ fermo: false }), registra() {} });
const voce = { fonte: 'subito', id: '123', nome: 'Vetrina sintetica' };
const riga = extra => ({ id: 'subito:1', prezzo: 5000, ...extra });

test('Competitor: gli avvisi del parser non diventano annunci persi né errori di rete', async () => {
  const C = competitor();
  const calls = [];
  const warning = '1 annuncio ha un campo prezzo che non riesco a leggere';
  const p = await C.parco(voce, { salute: freno(), scrapeSubito: async (params, opts) => {
    calls.push({ params, opts });
    return params.tipo === 'auto'
      ? { items: [riga({ prezzo: null })], total: 1, sospetto: warning }
      : { items: [], total: 0 };
  } });
  assert.deepEqual(p.avvisiLettura, [{ tipo: 'auto', motivo: warning }]);
  assert.equal(p.illeggibili, 0, 'il prezzo non letto non elimina la card');
  assert.deepEqual(p.passateKo, []);
  assert.equal(p.veicoli.length, 1);
  assert.equal(p.totaleFonte, 1);
  assert.equal(C.aggrega(p.veicoli).veicoli, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.opts.withMeta === true));
});

test('Competitor: prezzi in parte illeggibili conservano tutti i veicoli e il solo prezzo leggibile nei numeri', async () => {
  const C = competitor();
  const warning = '1 annuncio ha un campo prezzo non leggibile';
  const p = await C.parco(voce, { salute: freno(), scrapeSubito: async params => params.tipo === 'auto'
    ? { items: [riga({ prezzo: null }), riga({ id: 'subito:2', prezzo: 8000 })], total: 2, parziale: warning }
    : { items: [], total: 0 },
  });
  assert.deepEqual(p.avvisiLettura, [{ tipo: 'auto', motivo: warning }]);
  assert.equal(p.veicoli.length, 2);
  assert.equal(C.aggrega(p.veicoli).prezzo.mediana, 8000);
  assert.equal(p.illeggibili, 0);
  assert.deepEqual(p.passateKo, []);
});

test('Competitor: nello stesso scarico il prezzo illeggibile e la pagina caduta restano due avvisi distinti', async () => {
  const C = competitor();
  const p = await C.parco(voce, { salute: freno(), scrapeSubito: async params => params.tipo === 'auto'
    ? { items: [riga({ prezzo: null, prezzoIlleggibile: true })], total: 80,
      parzialeRete: true, parziale: 'pagina successiva non ricevuta', erroreHttp: 503 }
    : { items: [], total: 0 },
  });
  assert.equal(p.avvisiLettura.length, 1);
  assert.equal(p.avvisiLettura[0].tipo, 'auto');
  assert.match(p.avvisiLettura[0].motivo, /1.*prezzo.*legg/i);
  assert.equal(p.passateKo.length, 1);
  assert.equal(p.passateKo[0].motivo, 'pagina successiva non ricevuta');
  assert.equal(p.illeggibili, 0);
  assert.equal(p.totaleFonte, null);
});

test('Competitor: importi normali, zero, assenti e su richiesta non diventano avvisi di parser', async () => {
  const C = competitor();
  const p = await C.parco(voce, { salute: freno(), scrapeSubito: async params => params.tipo === 'auto'
    ? { items: [riga({}), riga({ prezzo: 0 }), riga({ prezzo: null }), riga({ prezzo: null, prezzoSuRichiesta: true })], total: 4 }
    : { items: [], total: 0 },
  });
  assert.deepEqual(p.avvisiLettura, []);
  assert.deepEqual(p.passateKo, []);
  assert.equal(p.veicoli.length, 4);
  assert.equal(p.totaleFonte, 4);
});
