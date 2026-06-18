'use strict';
// F17 — buildPath Subito con filtri NATIVI hades. Puro (niente rete/DB): sempre eseguito.
const { test } = require('node:test');
const assert = require('node:assert');
const subitoApi = require('../backend/scrapers/subito-api');
const buildPath = subitoApi._buildPath;

// Helper: estrae i query param dal path costruito.
function qp(path) {
  const qs = path.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(qs));
}

test('base: solo c/t/lim/start/q, nessun filtro nativo', () => {
  const p = qp(buildPath({ tipo: 'auto', marca: 'alfa romeo', modello: 'giulietta' }, 0));
  assert.strictEqual(p.c, '2');
  assert.strictEqual(p.q, 'alfa romeo giulietta');
  assert.strictEqual(p.start, '0');
  assert.ok(!('r' in p), 'niente regione');
  assert.ok(!('ps' in p) && !('sort' in p), 'niente prezzo/sort');
});

test('regione mappata → r=<key> (piemonte=2, case/space-insensitive)', () => {
  assert.strictEqual(qp(buildPath({ tipo: 'auto', regione: 'piemonte' }, 0)).r, '2');
  assert.strictEqual(qp(buildPath({ tipo: 'auto', regione: 'Piemonte' }, 0)).r, '2');
  assert.strictEqual(qp(buildPath({ tipo: 'moto', regione: 'emilia-romagna' }, 0)).r, '8');
  assert.strictEqual(qp(buildPath({ tipo: 'auto', regione: 'sicilia' }, 0)).r, '20');
});

test('regione NON mappata → nessun r (post-filtro client copre)', () => {
  assert.ok(!('r' in qp(buildPath({ tipo: 'auto', regione: 'atlantide' }, 0))));
});

test('prezzo/anno nativi → ps/pe/ys/ye', () => {
  const p = qp(buildPath({ tipo: 'auto', prezzoMin: 3000, prezzoMax: 6000, annoMin: 2015, annoMax: 2018 }, 0));
  assert.strictEqual(p.ps, '3000');
  assert.strictEqual(p.pe, '6000');
  assert.strictEqual(p.ys, '2015');
  assert.strictEqual(p.ye, '2018');
});

test('km nativo → ms/me come CHIAVE CATEGORIA (non km raw)', () => {
  const p = qp(buildPath({ tipo: 'auto', kmMin: 50000, kmMax: 100000 }, 0));
  assert.strictEqual(p.ms, '11', 'categoria che contiene 50000 (50.000–54.999)');
  assert.strictEqual(p.me, '21', 'categoria che contiene 100000 (100.000–109.999)');
  const q = qp(buildPath({ tipo: 'auto' }, 0));
  assert.ok(!('ms' in q) && !('me' in q), 'senza km niente ms/me');
});

test('sort valido passa, invalido viene scartato', () => {
  assert.strictEqual(qp(buildPath({ tipo: 'auto', _sort: 'priceasc' }, 0)).sort, 'priceasc');
  assert.ok(!('sort' in qp(buildPath({ tipo: 'auto', _sort: 'price_asc' }, 0))), 'valore non valido scartato');
  assert.ok(!('sort' in qp(buildPath({ tipo: 'auto' }, 0))), 'senza _sort niente sort (crawler invariato)');
});

test('start = offset pagina', () => {
  assert.strictEqual(qp(buildPath({ tipo: 'auto', marca: 'x' }, 100)).start, '100');
});

test('caso reale F17: Giulietta Piemonte 3-6k anno>=2015 priceasc', () => {
  const p = qp(buildPath({
    tipo: 'auto', marca: 'alfa romeo', modello: 'giulietta',
    regione: 'piemonte', prezzoMin: 3000, prezzoMax: 6000, annoMin: 2015, _sort: 'priceasc',
  }, 0));
  assert.strictEqual(p.r, '2');
  assert.strictEqual(p.ps, '3000');
  assert.strictEqual(p.pe, '6000');
  assert.strictEqual(p.ys, '2015');
  assert.strictEqual(p.sort, 'priceasc');
});
