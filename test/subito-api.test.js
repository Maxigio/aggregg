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

test('mapAd: i km vengono dal valore esatto, non dalla fascia (payload hades vero)', () => {
  // Nel payload vero l'etichetta 'Km' e' DOPPIA: /mileage (fascia "95.000 - 99.999") e
  // /mileage_scalar (98000). La fascia viene prima, e cercando per label si prendeva quella:
  // un'auto con "Km 98.000 certificati" scritto dal venditore usciva come 95.000.
  const fx = require('./fixtures/subito-hades-sample.json');
  assert.strictEqual(mapAd(fx.ads[0]).km, 98000);

  const km = feats => mapAd({ urls: { default: 'u' }, features: feats }).km;
  const S = v => ({ uri: '/mileage_scalar', label: 'Km', values: [{ value: v }] });
  const F = v => ({ uri: '/mileage', label: 'Km', values: [{ value: v }] });
  assert.strictEqual(km([F('95.000 - 99.999'), S('98000 Km')]), 98000, 'lo scalare vince sulla fascia');
  assert.strictEqual(km([F('120.000 - 129.999')]), 120000, 'senza scalare, la fascia resta il ripiego');
  // 9999999 e' il segnaposto di "non dichiarato": stamparlo sarebbe peggio di non dire niente.
  assert.strictEqual(km([S('9999999 Km')]), null, 'il segnaposto non diventa un chilometraggio');
  assert.strictEqual(km([S('0 Km')]), 0, 'zero km e\' un dato vero (km 0), non un assente');
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
