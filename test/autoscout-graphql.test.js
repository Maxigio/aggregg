'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const scrape = require('../backend/scrapers/autoscout-graphql');
const mapListing = scrape._mapListing;
const buildVariables = scrape._buildVariables;

// Nodo nella forma del payload GraphQL AS24 (search.listings.listings[i]).
const NODE = {
  details: {
    webPage: 'https://www.autoscout24.it/annunci/bmw-320d-x',
    prices: { public: { amountInEUR: { raw: 8500 }, onRequestOnly: false } },
    location: { city: 'Milano', zip: '20100' },
    vehicle: {
      classification: { make: { formatted: 'BMW' }, model: { formatted: '320d' }, modelVersionInput: '320d Attiva 150cv' },
      condition: { mileageInKm: { raw: 120000 }, firstRegistrationDate: { formatted: '01/2016' } },
      engine: { transmissionType: { formatted: 'Manuale' }, engineDisplacementInCCM: { raw: 1995 } },
      fuels: { primary: { type: { raw: 'DIESEL', formatted: 'Diesel' } } },
    },
  },
};

test('mapListing: shape completa coerente con gli altri scraper', () => {
  const r = mapListing(NODE);
  assert.strictEqual(r.fonte, 'autoscout');
  assert.strictEqual(r.titolo, 'BMW 320d Attiva 150cv');
  assert.strictEqual(r.prezzo, 8500);
  assert.strictEqual(r.km, 120000);
  assert.strictEqual(r.anno, 2016);          // da "01/2016"
  assert.strictEqual(r.carburante, 'Diesel');
  assert.strictEqual(r.cambio, 'Manuale');
  assert.strictEqual(r.cilindrata, 1995);
  assert.strictEqual(r.provincia, 'Milano');
  assert.strictEqual(r.variante, '320d Attiva 150cv');
  assert.strictEqual(r.url, 'https://www.autoscout24.it/annunci/bmw-320d-x');
});

test('mapListing: scarta onRequestOnly e prezzo nullo', () => {
  const onReq = JSON.parse(JSON.stringify(NODE));
  onReq.details.prices.public.onRequestOnly = true;
  assert.strictEqual(mapListing(onReq), null);

  const noPrice = JSON.parse(JSON.stringify(NODE));
  noPrice.details.prices.public.amountInEUR = null;
  assert.strictEqual(mapListing(noPrice), null);
});

test('mapListing: carburante via fallback raw/fuelCategory', () => {
  const n = JSON.parse(JSON.stringify(NODE));
  n.details.vehicle.fuels = { primary: { type: { raw: 'PETROL', formatted: null } } };
  assert.strictEqual(mapListing(n).carburante, 'PETROL');
  n.details.vehicle.fuels = { fuelCategory: { formatted: 'Benzina' } };
  assert.strictEqual(mapListing(n).carburante, 'Benzina');
});

test('buildVariables: make/model da mmmv + vehicleType + Italia', () => {
  const v = buildVariables({ tipo: 'auto', autoscoutMmmv: '13|7|x|y', prezzoMin: 1000, prezzoMax: 30000 }, 1);
  assert.deepStrictEqual(v.v.classification, [{ make: 13, model: 7 }]);
  assert.deepStrictEqual(v.v.vehicleType, ['Car']);
  assert.deepStrictEqual(v.loc.country, ['Italy']);
  assert.deepStrictEqual(v.pr.price, { from: 1000, to: 30000 });
  assert.deepStrictEqual(v.m, { page: 1, size: 50 });
});

test('buildVariables: brand-only (no modelId) e moto→Bike', () => {
  const v = buildVariables({ tipo: 'moto', autoscoutMmmv: '50011|||' }, 2);
  assert.deepStrictEqual(v.v.classification, [{ make: 50011 }]);
  assert.deepStrictEqual(v.v.vehicleType, ['Bike']);
  assert.strictEqual(v.pr, undefined);   // niente prezzo → niente filtro price
  assert.strictEqual(buildVariables({ autoscoutMmmv: '' }, 1), null);   // senza makeId → null
});
