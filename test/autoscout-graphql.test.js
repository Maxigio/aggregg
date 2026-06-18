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
    seller: { type: 'Dealer' },
    vehicle: {
      classification: { make: { formatted: 'BMW' }, model: { formatted: '320d' }, modelVersionInput: '320d Attiva 150cv' },
      condition: {
        mileageInKm: { raw: 120000 }, firstRegistrationDate: { formatted: '01/2016' },
        numberOfPreviousOwnersExtended: { raw: 2 }, damage: { isCurrentlyDamaged: false },
      },
      engine: {
        transmissionType: { formatted: 'Manuale' }, engineDisplacementInCCM: { raw: 1995 },
        power: { hp: { raw: 150 } }, numberOfCylinders: 4,
      },
      fuels: { primary: { type: { raw: 'DIESEL', formatted: 'Diesel' } } },
      bodyColor: { formatted: 'Nero' },
      bodyType: { formatted: 'Berlina' },
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

test('mapListing: specs ricche native (potenza/cilindri/proprietari/colore/carrozzeria/venditore/danni)', () => {
  const r = mapListing(NODE);
  assert.strictEqual(r.potenzaCv, 150);          // power.hp.raw (buco AS24 riempito)
  assert.strictEqual(r.cilindri, 4);
  assert.strictEqual(r.proprietari, 2);
  assert.strictEqual(r.colore, 'Nero');
  assert.strictEqual(r.carrozzeria, 'Berlina');
  assert.strictEqual(r.venditore, 'concessionario');   // seller.type 'Dealer'
  assert.strictEqual(r.danni, false);                  // damage.isCurrentlyDamaged nativo
});

test('mapListing: venditore privato + danni fallback usageState quando damage assente', () => {
  const n = JSON.parse(JSON.stringify(NODE));
  n.details.seller.type = 'PrivateSeller';
  delete n.details.vehicle.condition.damage;
  n.details.vehicle.usageState = 'Wreck';
  const r = mapListing(n);
  assert.strictEqual(r.venditore, 'privato');
  assert.strictEqual(r.danni, true);             // fallback: usageState in {HadAccident,Wreck}
});

test('mapListing: specs ricche assenti → null (nessuna fabbricazione)', () => {
  const n = JSON.parse(JSON.stringify(NODE));
  n.details.seller = null;
  delete n.details.vehicle.engine.power;
  delete n.details.vehicle.engine.numberOfCylinders;
  delete n.details.vehicle.condition.numberOfPreviousOwnersExtended;
  delete n.details.vehicle.bodyColor;
  delete n.details.vehicle.bodyType;
  const r = mapListing(n);
  assert.strictEqual(r.potenzaCv, null);
  assert.strictEqual(r.cilindri, null);
  assert.strictEqual(r.proprietari, null);
  assert.strictEqual(r.colore, null);
  assert.strictEqual(r.carrozzeria, null);
  assert.strictEqual(r.venditore, null);
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

test('buildVariables: km NATIVO → mileageInKm {from,to}', () => {
  const v = buildVariables({ autoscoutMmmv: '13|7', kmMin: 50000, kmMax: 100000 }, 1);
  assert.deepStrictEqual(v.v.mileageInKm, { from: 50000, to: 100000 });
  // solo max → from default 0
  const v2 = buildVariables({ autoscoutMmmv: '13|7', kmMax: 80000 }, 1);
  assert.deepStrictEqual(v2.v.mileageInKm, { from: 0, to: 80000 });
  // niente km → niente campo
  assert.strictEqual(buildVariables({ autoscoutMmmv: '13|7' }, 1).v.mileageInKm, undefined);
});

test('buildVariables: anno NATIVO → firstRegistration in yyyymmdd', () => {
  const v = buildVariables({ autoscoutMmmv: '13|7', annoMin: 2015, annoMax: 2018 }, 1);
  assert.deepStrictEqual(v.v.firstRegistration, { from: 20150101, to: 20181231 });
  // solo min → to default fine-2100
  const v2 = buildVariables({ autoscoutMmmv: '13|7', annoMin: 2016 }, 1);
  assert.deepStrictEqual(v2.v.firstRegistration, { from: 20160101, to: 21001231 });
  assert.strictEqual(buildVariables({ autoscoutMmmv: '13|7' }, 1).v.firstRegistration, undefined);
});
