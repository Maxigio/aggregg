'use strict';
/**
 * Le misure della redazione: il filtro per modello.
 *
 * Qui non si prova la rete, si prova la sola cosa che decide cosa vedi: quali prove
 * "possono" essere di questo modello. Il rischio e' l'opposto di quello che sembra — non
 * scartare troppo, ma tenere dentro una prova di un'altra moto e farla passare per la tua.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { _perModello } = require('../backend/prove-route');

const V = [
  { nome: 'Golf VII 1.0 TSI' }, { nome: 'Golf VI R 2.0 TFSI DSG 3p' },
  { nome: 'Golf GTI Clubsport' }, { nome: 'Polo 1.4 TDI' }, { nome: 'up! 1.0 3 p' },
];

test('tiene solo le voci che contengono TUTTE le parole del modello', () => {
  assert.equal(_perModello(V, 'Golf').length, 3);
  assert.equal(_perModello(V, 'Golf GTI').length, 1);
  assert.equal(_perModello(V, 'Polo').length, 1);
});

test('un modello che la fonte non ha non tira dentro niente', () => {
  // Meglio "nessun rilevamento" che il rilevamento di un'altra macchina.
  assert.deepEqual(_perModello(V, 'Passat'), []);
  assert.deepEqual(_perModello(V, 'Golf Cabriolet'), []);
});

test('senza modello non si filtra: le voci restano quelle della marca', () => {
  assert.equal(_perModello(V, '').length, V.length);
  assert.equal(_perModello(V, null).length, V.length);
});

test('le parole si confrontano intere, non come pezzi di altre', () => {
  // "up" non deve agganciare "Clubsport" solo perche' contiene quelle due lettere.
  assert.equal(_perModello(V, 'up').length, 1);
  assert.equal(_perModello(V, 'up')[0].nome, 'up! 1.0 3 p');
});
