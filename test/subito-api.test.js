'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const scrape = require('../backend/scrapers/subito-api');
const mapAd = scrape._mapAd;
const buildPath = scrape._buildPath;

const f = (label, value) => ({ label, values: [{ value }] });
const AD = {
  subject: 'BMW 320d Touring Luxury',
  urls: { default: 'https://www.subito.it/auto/bmw-320d-roma-123.htm' },
  geo: { region: { friendly_name: 'lazio' }, city: { value: 'Roma' } },
  features: [
    f('Prezzo', '9.500 €'),
    f('Km', '190.000 - 199.999'),
    f('Immatricolazione', '05/2013'),
    f('Carburante', 'Diesel'),
    f('Cambio', 'Automatico'),
    f('Auto', 'BMW'),
  ],
};

test('mapAd: shape coerente con gli altri scraper', () => {
  const r = mapAd(AD);
  assert.strictEqual(r.fonte, 'subito');
  assert.strictEqual(r.titolo, 'BMW 320d Touring Luxury');
  assert.strictEqual(r.prezzo, 9500);
  assert.strictEqual(r.km, 190000);        // estremo inferiore del bucket
  assert.strictEqual(r.anno, 2013);        // da "05/2013"
  assert.strictEqual(r.carburante, 'Diesel');
  assert.strictEqual(r.cambio, 'Automatico');
  assert.strictEqual(r.provincia, 'Roma');
  assert.strictEqual(r.url, 'https://www.subito.it/auto/bmw-320d-roma-123.htm');
});

test('mapAd: km esatto "124000 Km" → 124000', () => {
  const ad = JSON.parse(JSON.stringify(AD));
  ad.features = [f('Prezzo', '7000 €'), f('Km', '124000 Km'), f('Immatricolazione', '01/2016')];
  assert.strictEqual(mapAd(ad).km, 124000);
});

test('mapAd: senza url → null', () => {
  const ad = JSON.parse(JSON.stringify(AD)); ad.urls = {};
  assert.strictEqual(mapAd(ad), null);
});

test('buildPath: categoria auto=2 / moto=3 + query', () => {
  assert.match(buildPath({ tipo: 'auto', marca: 'BMW', modello: '320d' }, 0), /[?&]c=2&/);
  assert.match(buildPath({ tipo: 'auto', marca: 'BMW', modello: '320d' }, 0), /q=BMW\+320d/);
  assert.match(buildPath({ tipo: 'moto', marca: 'Honda' }, 50), /[?&]c=3&/);
  assert.match(buildPath({ tipo: 'moto', marca: 'Honda' }, 50), /start=50/);
});
