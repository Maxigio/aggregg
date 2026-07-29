'use strict';
// F18 — mapAd espone versione/venditore/potenza SOLO da dati nativi. Puro: sempre eseguito.
const { test } = require('node:test');
const assert = require('node:assert');
const mapAd = require('../backend/scrapers/subito-api')._mapAd;

// Ad auto realistico (forma hades): feature 'Auto' con sub-Versione, Potenza, advertiser.company.
const adAuto = {
  subject: 'Alfa romeo Giulietta',
  urls: { default: 'https://www.subito.it/auto/giulietta-x.htm' },
  advertiser: { company: true },
  images: [
    { uri: 'imgid:a', cdn_base_url: 'https://images.sbito.it/api/v1/sbt-ads-images-pro/images/ab/abc' },
    { uri: 'imgid:b', cdn_base_url: 'https://images.sbito.it/api/v1/sbt-ads-images-pro/images/cd/cde' },
    { uri: 'imgid:nourl' },   // senza cdn_base_url → scartata (no fabbricazione)
  ],
  features: [
    { label: 'Prezzo', values: [{ key: '5500', value: '5500 €' }] },
    // `uri` e `key` NON sono decorazioni: i tre livelli si leggono da li' (subito-nodo.js),
    // e senza il pacchetto risulta un annuncio che non dichiara ne' marca ne' versione.
    { type: 'pack', uri: '/car', label: 'Auto', values: [
      { label: 'Marca', key: '000010', value: 'ALFA ROMEO' },
      { label: 'Modello', key: '001234', value: 'Giulietta' },
      { label: 'Versione', key: '098765', value: '1.6 JTDm-2 105 CV Progression' },
    ]},
    { label: 'Potenza', values: [{ label: 'Potenza', value: '77 kW / 105 Cv' }] },
    { label: 'Cambio', values: [{ value: 'Manuale' }] },
    { label: 'Colore', values: [{ value: 'Bianco' }] },
    { label: 'Carrozzeria', values: [{ value: 'Berlina' }] },
    { label: 'Numero di porte', values: [{ value: '4/5' }] },
    { label: 'Posti', values: [{ value: '5' }] },
    { label: 'Classe emissioni', values: [{ value: 'Euro 6' }] },
    { label: 'Per neopatentati', values: [{ value: 'Sì' }] },
    { label: 'Condizioni del veicolo', values: [{ value: 'Usato' }] },
  ],
};

const adMoto = {
  subject: 'Honda CB 1000 R',
  urls: { default: 'https://www.subito.it/moto/cb1000-y.htm' },
  advertiser: { company: false },
  features: [
    { label: 'Prezzo', values: [{ key: '7000', value: '7000 €' }] },
    { type: 'pack', uri: '/bike', label: 'Moto', values: [
      { label: 'Marca', key: '000050', value: 'Honda' },
      { label: 'Modello', key: '002222', value: 'CB 1000 R' },
      // key 000000 = "non dichiarato". Subito non lascia il campo vuoto: ci mette il
      // proprio segnaposto, ed e' il caso di 874 annunci su 959 senza versione.
      { label: 'Versione', key: '000000', value: 'Altro allestimento' },
    ]},
    { label: 'Tipologia', values: [{ value: 'Naked' }] },
    { label: 'Condizioni del veicolo', values: [{ value: 'Nuovo' }] },
  ],
};

// Ad SENZA versione/potenza/venditore → tutto null (prova: niente fabbricazione).
const adSpoglio = {
  subject: 'Auto generica',
  urls: { default: 'https://www.subito.it/auto/z.htm' },
  features: [{ label: 'Prezzo', values: [{ key: '1000', value: '1000 €' }] }],
};

test('auto: variante/venditore/potenzaCv nativi', () => {
  const m = mapAd(adAuto);
  assert.strictEqual(m.variante, '1.6 JTDm-2 105 CV Progression');
  assert.strictEqual(m.venditore, 'concessionario');   // company=true
  assert.strictEqual(m.potenzaCv, 105);                // "77 kW / 105 Cv" → 105
});

test('auto: specs ricche native (colore/carrozzeria/porte/posti/emissioni/neopatentati/nuovo)', () => {
  const m = mapAd(adAuto);
  assert.strictEqual(m.colore, 'Bianco');
  assert.strictEqual(m.carrozzeria, 'Berlina');
  assert.strictEqual(m.porte, '4/5');           // stringa nativa
  assert.strictEqual(m.posti, 5);               // digits
  assert.strictEqual(m.classeEmissioni, 'Euro 6');
  assert.strictEqual(m.neopatentati, true);     // 'Sì' → bool
  assert.strictEqual(m.nuovo, false);           // 'Usato' → false
});

test('moto: versione sotto feature Moto + venditore privato + carrozzeria da Tipologia + nuovo', () => {
  const m = mapAd(adMoto);
  // "Altro allestimento" e' il SEGNAPOSTO di Subito (key 000000), non una versione:
  // stampato accanto alla potenza si leggeva come un dato dichiarato dal venditore.
  assert.strictEqual(m.variante, null);
  assert.strictEqual(m.venditore, 'privato');            // company=false
  assert.strictEqual(m.potenzaCv, null);                 // niente Potenza → null
  assert.strictEqual(m.carrozzeria, 'Naked');            // moto: feat 'Tipologia'
  assert.strictEqual(m.nuovo, true);                     // 'Nuovo' → true
});

test('immagini: URL webp da cdn_base_url + rule; entry senza url scartata', () => {
  const m = mapAd(adAuto);
  assert.strictEqual(m.immagini.length, 2);   // la terza (senza cdn_base_url) scartata
  assert.strictEqual(m.immagini[0].thumb, 'https://images.sbito.it/api/v1/sbt-ads-images-pro/images/ab/abc?rule=gallery-mobile-1x-auto');
  assert.strictEqual(m.immagini[0].full,  'https://images.sbito.it/api/v1/sbt-ads-images-pro/images/ab/abc?rule=fullscreen-1x-auto');
});

test('immagini assenti → [] (no fabbricazione)', () => {
  assert.deepStrictEqual(mapAd(adSpoglio).immagini, []);
});

test('campi assenti → null (nessuna fabbricazione)', () => {
  const m = mapAd(adSpoglio);
  assert.strictEqual(m.variante, null);
  assert.strictEqual(m.venditore, null);   // advertiser assente
  assert.strictEqual(m.potenzaCv, null);
  // specs ricche assenti → null/null (no fabbricazione)
  assert.strictEqual(m.colore, null);
  assert.strictEqual(m.carrozzeria, null);
  assert.strictEqual(m.porte, null);
  assert.strictEqual(m.posti, null);
  assert.strictEqual(m.classeEmissioni, null);
  assert.strictEqual(m.neopatentati, null);
  assert.strictEqual(m.nuovo, null);       // 'Condizioni' assente → null (non false)
});

test('potenza solo-kW → null (non inventa i CV)', () => {
  const ad = { ...adSpoglio, features: [{ label: 'Potenza', values: [{ value: '60 kW' }] }] };
  assert.strictEqual(mapAd(ad).potenzaCv, null);
});
