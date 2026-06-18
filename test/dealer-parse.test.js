'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDealerStock } = require('../backend/dealer');

// Costruisce una pagina con __NEXT_DATA__ come quella reale di AS24.
const page = obj => `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(obj)}</script></body></html>`;

const sample = page({
  props: { pageProps: {
    dealerInfoPage: { customerId: 9345705 },
    listings: [
      { url: '/annunci/suzuki-v-strom-1050-abc', prices: { public: { priceRaw: 8700 } },
        vehicle: { articleType: 'Motorbike', make: 'Suzuki', model: 'V-Strom 1050',
                   firstRegistrationDate: { raw: '2020-06-01' }, mileageInKm: { raw: 32000 } } },
      { url: '/annunci/ktm-890-adventure-xyz', prices: { public: { priceRaw: 7900 } },
        vehicle: { articleType: 'Motorbike', make: 'KTM', model: '890 Adventure',
                   firstRegistrationDate: { raw: '2021-04-01' }, mileageInKm: { raw: 16000 } } },
    ],
  } },
});

test('parseDealerStock: estrae customerId + veicoli mappati', () => {
  const { customerId, vehicles } = parseDealerStock(sample);
  assert.strictEqual(customerId, '9345705');
  assert.strictEqual(vehicles.length, 2);
  const v = vehicles[0];
  assert.strictEqual(v.marca, 'Suzuki');
  assert.strictEqual(v.modello, 'V-Strom 1050');
  assert.strictEqual(v.anno, 2020);              // da firstRegistrationDate.raw
  assert.strictEqual(v.km, 32000);
  assert.strictEqual(v.prezzo, 8700);
  assert.strictEqual(v.tipo, 'moto');            // articleType Motorbike → moto
  assert.match(v.url, /^https:\/\/www\.autoscout24\.it\/annunci\//);  // url assoluto
  assert.strictEqual(v.customerId, '9345705');
});

test('parseDealerStock: scarta annunci senza marca/modello', () => {
  const p = page({ props: { pageProps: { listings: [
    { url: '/annunci/ok', prices: { public: { priceRaw: 5000 } }, vehicle: { articleType: 'Motorbike', make: 'Honda', model: 'Hornet', mileageInKm: { raw: 30000 }, firstRegistrationDate: { raw: '2010-01-01' } } },
    { url: '/annunci/rotto', vehicle: { articleType: 'Motorbike' } },   // niente make/model → scartato
  ] } } });
  assert.strictEqual(parseDealerStock(p).vehicles.length, 1);
});

test('parseDealerStock: GUARD __NEXT_DATA__ assente → lancia (no svuotamento)', () => {
  assert.throws(() => parseDealerStock('<html>blocco antibot</html>'), /__NEXT_DATA__ assente/);
});

test('parseDealerStock: GUARD listings vuota → lancia (sospetto blocco)', () => {
  assert.throws(() => parseDealerStock(page({ props: { pageProps: { listings: [] } } })), /0 annunci/);
});

test('parseDealerStock: GUARD listings non-array → lancia', () => {
  assert.throws(() => parseDealerStock(page({ props: { pageProps: {} } })), /non è un array/);
});

test('parseDealerStock: GUARD JSON non valido → lancia', () => {
  assert.throws(() => parseDealerStock('<script id="__NEXT_DATA__" type="application/json">{rotto</script>'), /JSON non valido/);
});
