'use strict';
// Traduzione di livello: il nodo Subito → i codici-modello di Autoscout. Puro.
const { test } = require('node:test');
const assert = require('node:assert');
const { codiciAs24, unisciCodici } = require('../backend/scrapers/as24-modelli');
const { _buildVariables } = require('../backend/scrapers/autoscout-graphql');

const IX = {
  auto: { bmw: { serie3: ['13|1639||', '13|1640||', '13|1641||'], ka: ['29|1761||'] } },
  moto: { yamaha: { mt07: ['50107|70888||'] } },
};

test('una voce Subito puo\' valere PIU\' modelli Autoscout', () => {
  assert.deepEqual(codiciAs24('auto', 'BMW', 'Serie 3', { indice: IX }), ['13|1639||', '13|1640||', '13|1641||']);
});

test('la grafia della marca e del modello non conta', () => {
  assert.deepEqual(codiciAs24('auto', 'bmw', 'serie 3', { indice: IX }), ['13|1639||', '13|1640||', '13|1641||']);
  assert.deepEqual(codiciAs24('auto', 'B M W', 'SERIE-3', { indice: IX }), ['13|1639||', '13|1640||', '13|1641||']);
});

test('quello che il ponte non ha torna vuoto, non null: e\' un\'informazione', () => {
  assert.deepEqual(codiciAs24('auto', 'BMW', 'Modello Inventato', { indice: IX }), []);
  assert.deepEqual(codiciAs24('moto', 'Beta', 'R-12', { indice: IX }), []);
  assert.deepEqual(codiciAs24('auto', 'Marca Inventata', 'X', { indice: IX }), []);
});

test('il tipo separa: una moto non pesca fra le auto', () => {
  assert.deepEqual(codiciAs24('moto', 'BMW', 'Serie 3', { indice: IX }), []);
});

// ── unione ───────────────────────────────────────────────────────────────────
test('il codice dell\'app viene PRIMA, poi quelli del ponte, senza doppioni', () => {
  assert.deepEqual(unisciCodici('13|1641||', ['13|1639||', '13|1641||']), ['13|1641||', '13|1639||']);
});

test('senza codice dell\'app restano quelli del ponte', () => {
  assert.deepEqual(unisciCodici(null, ['29|1761||']), ['29|1761||']);
});

test('i codici brand-only ("13|||") non sono codici-modello e si scartano', () => {
  assert.deepEqual(unisciCodici('13|||', ['13|||']), []);
  assert.deepEqual(unisciCodici('13|||', ['13|1639||']), ['13|1639||']);
});

test('niente da unire → lista vuota, e chi chiama resta come prima', () => {
  assert.deepEqual(unisciCodici(null, []), []);
  assert.deepEqual(unisciCodici(undefined, undefined), []);
});

// ── la query verso Autoscout ─────────────────────────────────────────────────
test('piu modelli → una sola query con la lista, e i filtri restano gli stessi', () => {
  const p = { tipo: 'auto', mmmvAutoscout: '13|1639||', autoscoutModelli: ['13|1639||', '13|1640||', '13|1641||'],
    annoMin: 2015, annoMax: 2020, kmMax: 90000, prezzoMax: 25000 };
  const v = _buildVariables(p, 1, {});
  assert.deepEqual(v.v.classification, [{ make: 13, model: 1639 }, { make: 13, model: 1640 }, { make: 13, model: 1641 }]);
  assert.deepEqual(v.v.vehicleType, ['Car']);
  assert.deepEqual(v.v.firstRegistration, { from: 20150101, to: 20201231 });
  assert.deepEqual(v.v.mileageInKm, { from: 0, to: 90000 });
  assert.deepEqual(v.pr.price, { from: 1, to: 25000 });
});

test('un modello solo → ramo di prima, identico', () => {
  const uno = _buildVariables({ tipo: 'moto', mmmvAutoscout: '50107|70888||' }, 1, {});
  const lista = _buildVariables({ tipo: 'moto', mmmvAutoscout: '50107|70888||', autoscoutModelli: ['50107|70888||'] }, 1, {});
  assert.deepEqual(lista.v.classification, uno.v.classification);
  assert.deepEqual(lista.v.classification, [{ make: 50107, model: 70888 }]);
});

test('codici malformati nella lista non finiscono nella query', () => {
  const v = _buildVariables({ tipo: 'auto', mmmvAutoscout: '13|1639||', autoscoutModelli: ['13|1639||', '13|||', 'boh'] }, 1, {});
  assert.deepEqual(v.v.classification, [{ make: 13, model: 1639 }], 'uno solo valido → ramo normale');
});
