'use strict';
/**
 * I numeri del parco di un concessionario.
 *
 * Sono numeri che si leggono per decidere un prezzo, quindi qui non si controlla che la
 * funzione giri: si controlla che non menta. Le due bugie possibili le abbiamo viste tutte
 * e due su parchi veri — il nuovo che si mescola all'usato e alza la mediana, e il prezzo
 * civetta a 1 euro che diventa il "minimo" del piazzale.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { aggrega } = require('../backend/competitor');

const v = (o = {}) => ({ fonte: 'subito', tipo: 'auto', prezzo: 10000, anno: 2018, km: 50000, ...o });

test('il nuovo si conta, ma resta fuori dalle mediane', () => {
  const n = aggrega([
    v({ prezzo: 5000 }), v({ prezzo: 7000 }), v({ prezzo: 9000 }),
    v({ prezzo: 40000, nuovo: true }), v({ prezzo: 45000, nuovo: true }),
  ]);
  assert.equal(n.veicoli, 5);
  assert.equal(n.usato, 3);
  assert.equal(n.nuovo, 2);
  assert.equal(n.prezzo.mediana, 7000);          // non 9000: il nuovo non vota
  assert.equal(n.prezzo.max, 9000);
});

test('quando la fonte non dichiara la condizione, l\'annuncio sta con l\'usato', () => {
  // `nuovo: null` vuol dire "non l'ha detto": inventarsi un nuovo che nessuno ha
  // dichiarato toglierebbe annunci veri dalle mediane.
  const n = aggrega([v({ nuovo: null }), v({ nuovo: undefined }), v({ nuovo: false })]);
  assert.equal(n.usato, 3);
  assert.equal(n.nuovo, 0);
});

test('il prezzo civetta esce dal minimo e viene contato', () => {
  const n = aggrega([v({ prezzo: 1 }), v({ prezzo: 250 }), v({ prezzo: 4000 }), v({ prezzo: 8000 })]);
  assert.equal(n.prezzo.min, 4000);              // non 1: quello e' un cartello
  assert.equal(n.prezzo.civetta, 2);             // ma si dice che ce ne sono due
  assert.equal(n.prezzo.max, 8000);
});

test('un parco fatto di soli richiami non finge un prezzo', () => {
  const n = aggrega([v({ prezzo: 1 }), v({ prezzo: 1 })]);
  assert.equal(n.prezzo, null);                  // niente da dire, e lo si dice
  assert.equal(n.usato, 2);
});

test('la marca la dice la fonte, il titolo e\' solo la rete', () => {
  const n = aggrega([
    v({ marca: 'Alfa Romeo', titolo: 'Alfa Romeo Giulia 2.2' }),
    v({ marca: null, titolo: 'Land Rover Defender' }),
  ]);
  const nomi = n.marche.map(m => m.nome);
  assert.ok(nomi.includes('Alfa Romeo'), nomi.join('|'));   // non "Alfa"
  assert.ok(nomi.includes('Land'), nomi.join('|'));         // dal titolo si spezza: e' la rete, non il dato
});

test('la giacenza la calcola solo Autoscout, e dichiara su quanti', () => {
  const giorniFa = g => new Date(Date.now() - g * 86400000).toISOString();
  const n = aggrega([
    v({ fonte: 'autoscout', posted_at: giorniFa(30) }),
    v({ fonte: 'autoscout', posted_at: giorniFa(60) }),
    // Su Subito la data si azzera a ogni rilancio: non entra, nemmeno se c'e'.
    v({ fonte: 'subito', posted_at: giorniFa(1) }),
  ]);
  assert.equal(n.giacenza.su, 2);
  assert.equal(n.giacenza.suTotale, 3);
  assert.ok(n.giacenza.mediana >= 29 && n.giacenza.mediana <= 61);
});

test('come vende: garanzia e IVA esposta contate su chi le dichiara', () => {
  const n = aggrega([
    v({ garanziaMesi: 12, ivaEsposta: true }),
    v({ garanziaMesi: 0, ivaEsposta: false }),
    v({}),                                       // non dichiarate: non contano nel "su"
  ]);
  assert.deepEqual(n.garanzia, { si: 1, su: 2 });
  assert.deepEqual(n.ivaEsposta, { si: 1, su: 2 });
});

test('un parco vuoto non esplode e non inventa', () => {
  const n = aggrega([]);
  assert.equal(n.veicoli, 0);
  assert.equal(n.prezzo, null);
  assert.equal(n.giacenza, null);
  assert.deepEqual(n.marche, []);
  assert.equal(n.garanzia, null);
});
