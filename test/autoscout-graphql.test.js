'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
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
    media: { images: [
      { __typename: 'StandardImage', formats: { webp: { size420x315: 't1', size800x600: 'f1' } } },
      { __typename: 'StandardImage', formats: { webp: { size420x315: 't2' } } },   // senza size800x600 → full=thumb
      { __typename: 'Video' },                                                      // non-StandardImage → scartata
    ] },
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
  // La provincia e' una SIGLA, non il comune: era il campo su cui i due rami AS24
  // divergevano (GraphQL teneva il primo segmento di "Gussago - Brescia - BS", il ramo a
  // browser la coda), e finivano nella stessa colonna, nello stesso CSV e nello stesso
  // raggruppamento. Ora la ricava `province-sigla.risolvi` per entrambi.
  assert.strictEqual(r.provincia, 'MI');
  assert.strictEqual(r.variante, '320d Attiva 150cv');
  assert.strictEqual(r.url, 'https://www.autoscout24.it/annunci/bmw-320d-x');
});

test('mapListing: importo numerico leggibile e stringa invalida non confusi', () => {
  const n = JSON.parse(JSON.stringify(NODE));
  n.details.prices.public.amountInEUR.raw = '8500';
  assert.strictEqual(mapListing(n).prezzo, 8500);
  n.details.prices.public.amountInEUR.raw = 'prezzo da concordare';
  assert.strictEqual(mapListing(n), null);
});

// F50 Fase 0: il nome-modello entra nel titolo. Prima, con modelVersionInput vuoto (~74% delle
// moto AS24) il titolo era la sola marca e il post-filter di server.js scartava l'annuncio.
const nodeCls = cls => ({ details: { ...NODE.details, vehicle: { ...NODE.details.vehicle, classification: cls } } });

test('mapListing: allestimento vuoto → il titolo include il nome-modello (non solo la marca)', () => {
  const r = mapListing(nodeCls({ make: { formatted: 'Yamaha' }, model: { formatted: 'TMAX 500' }, modelVersionInput: null }));
  assert.strictEqual(r.titolo, 'Yamaha TMAX 500');   // prima: 'Yamaha' → scartato dal post-filter
  assert.strictEqual(r.variante, null);              // il campo grezzo resta invariato
});

test('mapListing: allestimento che già contiene il modello → nessuna duplicazione', () => {
  const r = mapListing(nodeCls({ make: { formatted: 'CFMOTO' }, model: { formatted: '800 MT' }, modelVersionInput: 'CFMOTO 800MT-X BASSA 830' }));
  assert.strictEqual(r.titolo, 'CFMOTO CFMOTO 800MT-X BASSA 830');   // invariato rispetto a prima
});

test('mapListing: modello catch-all "Altro" → escluso dal titolo (rumore AS24)', () => {
  const r = mapListing(nodeCls({ make: { formatted: 'Honda' }, model: { formatted: 'Altro' }, modelVersionInput: 'Africa Twin RD04' }));
  assert.strictEqual(r.titolo, 'Honda Africa Twin RD04');
});

test('mapListing: modello e allestimento distinti → entrambi nel titolo', () => {
  const r = mapListing(nodeCls({ make: { formatted: 'Honda' }, model: { formatted: 'XRV 750' }, modelVersionInput: 'Africa Twin RD07a' }));
  assert.strictEqual(r.titolo, 'Honda XRV 750 Africa Twin RD07a');
});

test('mapListing: senza modello né allestimento → resta il fallback', () => {
  const r = mapListing(nodeCls({ make: { formatted: '' }, model: null, modelVersionInput: null }));
  assert.strictEqual(r.titolo, 'Annuncio senza titolo');
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

test('mapListing: immagini webp native (StandardImage only, fallback full=thumb)', () => {
  const r = mapListing(NODE);
  assert.strictEqual(r.immagini.length, 2);                     // Video scartato
  assert.deepStrictEqual(r.immagini[0], { thumb: 't1', full: 'f1' });
  assert.deepStrictEqual(r.immagini[1], { thumb: 't2', full: 't2' });   // no size800 → full=thumb
});

test('mapListing: media assente → immagini [] (no fabbricazione)', () => {
  const n = JSON.parse(JSON.stringify(NODE));
  delete n.details.media;
  assert.deepStrictEqual(mapListing(n).immagini, []);
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

test('mapListing: campi personali strutturati del privato non escono neppure nel raw', () => {
  const n = JSON.parse(JSON.stringify(NODE));
  n.details.seller = { type: 'PrivateSeller', id: 'privato-123', companyName: 'Nome privato' };
  n.details.description = 'Testo del privato';
  const r = mapListing(n, { attachRaw: true });
  assert.equal(r.venditore, 'privato');
  assert.equal(r.venditoreId, null);
  assert.equal(r.venditoreNome, null);
  assert.equal(r.descrizione, null);
  assert.equal(r._raw.description, undefined);
  assert.deepEqual(r._raw.seller, { type: 'PrivateSeller' });
  assert.equal(r.url, n.details.webPage);
  const dealer = mapListing({ details: { ...n.details, seller: { ...n.details.seller, type: 'Dealer' } } });
  assert.equal(dealer.descrizione, 'Testo del privato');
  assert.equal(dealer.venditoreId, 'privato-123');
  const sconosciuto = mapListing({ details: { ...n.details,
    seller: { ...n.details.seller, type: 'NotDealer' } } }, { attachRaw: true });
  assert.equal(sconosciuto.descrizione, null);
  assert.equal(sconosciuto.venditoreId, null);
  assert.equal(sconosciuto._raw.seller.id, undefined);
});

test('scheda: una riga AutoScout privata non mostra il testo anche se arriva da una cache vecchia', () => {
  const app = require('../scripts/build-frontend').frontendSourceSync().js;
  const da = app.indexOf('function testoHTML(r)');
  const fino = app.indexOf('\n/**', da);
  assert.ok(da >= 0 && fino > da);
  const c = vm.createContext({ miniHTML: (...args) => args.join(' '), escapeHtml: s => s });
  vm.runInContext(app.slice(da, fino), c);
  const r = { fonte: 'autoscout', venditore: 'privato', descrizione: 'Dato personale', url: '/1' };
  assert.equal(c.testoHTML(r), '');
  assert.equal(c.testoHTML({ ...r, venditore: null }), '');
  assert.match(c.testoHTML({ ...r, venditore: 'concessionario' }), /Dato personale/);
  assert.match(c.testoHTML({ ...r, fonte: 'moto' }), /Dato personale/);
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

test('mapListing: "prezzo su richiesta" resta, e lo dichiara', () => {
  // Scartandolo qui spariva anche dall'elenco degli annunci VISTI del crawler: un annuncio
  // ancora in vetrina che toglie il cartellino veniva archiviato come venduto dopo due
  // passate. Ora esce senza prezzo e col flag; e' il DB che lo salta (`it.prezzo == null`).
  const onReq = JSON.parse(JSON.stringify(NODE));
  onReq.details.prices.public.onRequestOnly = true;
  onReq.details.prices.public.amountInEUR = null;
  const r = mapListing(onReq);
  assert.ok(r, 'l\'annuncio non si butta');
  assert.strictEqual(r.prezzo, null);
  assert.strictEqual(r.prezzoSuRichiesta, true);
  assert.ok(r.url);

  // Il prezzo assente SENZA "su richiesta" resta scartato: li' non sappiamo cosa manchi.
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
