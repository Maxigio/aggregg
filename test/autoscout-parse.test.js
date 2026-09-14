'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const scrapeAutoscout = require('../backend/scrapers/autoscout-playwright');
const parseListing = scrapeAutoscout._parseListing;
// `classifica` e' pura e non apre nessun archivio: si puo' chiamare da qui senza toccare data/.
const salute = require('../backend/fonti-salute');
const As24BlockedError = scrapeAutoscout._As24BlockedError;

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

test('parseListing: il CAP esce come `zip`, senno\' il taglio regione non taglia il ripiego', () => {
  // Il gate del server e' /^\d{5}$/.test(String(r.zip || '')): una riga SENZA CAP passa
  // sempre, per scelta («non verificabile non vuol dire fuori regione»). Senza questo campo
  // il ripiego mostrava percio' come siciliani gli annunci che il cerchio AS24 pesca in
  // Calabria — con tanto di provincia giusta in riga, e nessuno a escluderli.
  const r = parseListing({ ...ITEM, location: { city: 'Reggio Calabria', zip: '89121' } });
  assert.strictEqual(r.zip, '89121');
  assert.ok(/^\d{5}$/.test(String(r.zip || '')), 'il CAP deve superare il gate di server.js');
  // Senza CAP resta null: la riga sopravvive al taglio, ed e' voluto.
  assert.strictEqual(parseListing(ITEM).zip, null);
});

test('parseListing: senza url → null', () => {
  assert.strictEqual(parseListing({ vehicle: { make: 'BMW' } }), null);
});

test('blocco: la respinta del ramo a browser arriva TAGGATA al freno anti-ban', () => {
  // Senza kind/status fonti-salute scendeva a leggere il messaggio, e li' /\b403\b/ NON
  // aggancia "AS24 bloccato: http_403" (fra `_` e `4` non c'e' confine di parola): l'esito
  // usciva 'errore', `colpi` restava a zero e la pausa non scattava MAI — il ramo a browser
  // continuava a bussare a una fonte che ci stava bloccando.
  assert.strictEqual(salute.classifica(new As24BlockedError('http_403')), 'bloccato');
  assert.strictEqual(salute.classifica(new As24BlockedError('http_429')), 'bloccato');
  // Un 5xx non e' un ban; un markup cambiato nemmeno (senno' ci toglie la fonte per ore).
  assert.strictEqual(salute.classifica(new As24BlockedError('http_503')), 'transitorio');
  assert.strictEqual(salute.classifica(new As24BlockedError('no_data')), 'errore');
  assert.strictEqual(salute.classifica(new As24BlockedError('no_listings')), 'errore');
  // E' 'soft_block' quello che risale davvero fino a runSource (le respinte delle singole
  // pagine sono catturate dentro): il genere lo eredita dalla pagina che l'ha causato.
  assert.strictEqual(salute.classifica(new As24BlockedError('soft_block', new As24BlockedError('http_403'))), 'bloccato');
  assert.strictEqual(salute.classifica(new As24BlockedError('soft_block', new As24BlockedError('no_data'))), 'errore');
});
