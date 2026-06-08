'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const scrapeAutoscout = require('../backend/scrapers/autoscout-playwright');
const parseListing = scrapeAutoscout._parseListing;

// Item-campione nella forma del __NEXT_DATA__ AS24 (props.pageProps.listings[i]).
const ITEM = {
  url: '/annunci/bmw-118d-x',
  price: { priceFormatted: '€ 8.500' },
  location: { city: 'Milano' },
  vehicleDetails: [
    { iconName: 'mileage', data: '120.000 km' },
    { iconName: 'calendar', data: '01/2016' },
    { iconName: 'gas_pump', data: 'Diesel' },
  ],
  vehicle: {
    make: 'BMW',
    modelVersionInput: '118d 5p 2.0 Futura 143cv dpf',
    transmission: 'Manuale',
    fuel: 'Diesel',
    engineDisplacementInCCM: '1.995 cm³',
    variant: '118d',
  },
};

test('parseListing: titolo pulito da modelVersionInput', () => {
  const r = parseListing(ITEM);
  assert.strictEqual(r.titolo, 'BMW 118d 5p 2.0 Futura 143cv dpf');
  assert.strictEqual(r.fonte, 'autoscout');
});

test('parseListing: campi strutturati AS24 (cambio/cilindrata/variante)', () => {
  const r = parseListing(ITEM);
  assert.strictEqual(r.cambio, 'Manuale');
  assert.strictEqual(r.cilindrata, 1995);   // "1.995 cm³" → 1995
  assert.strictEqual(r.variante, '118d 5p 2.0 Futura 143cv dpf');
});

test('parseListing: senza url → null', () => {
  assert.strictEqual(parseListing({ vehicle: { make: 'BMW' } }), null);
});
