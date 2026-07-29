'use strict';
/**
 * Dal testo scritto al codice-versione di Moto.it.
 *
 * Il rischio qui e' mostrare una moto diversa da quella chiesta: se il testo aggancia
 * piu' voci di catalogo e ne scegliamo una, l'utente vede un periodo di produzione al
 * posto di un altro senza accorgersene. Per questo i casi che contano sono quelli in cui
 * la funzione deve restituirle TUTTE e lasciare decidere allo slug dell'annuncio.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { risolvi, slugVersione, slugDaUrl } = require('../backend/scrapers/motoit-versione');

// Catalogo vero (Moto.it, Yamaha MT-07): la stessa moto spezzata per periodo.
const MT07 = [
  { name: 'MT-07 (2014 - 16)', code: 'R9Lybg' },
  { name: 'MT-07 (2017 - 18)', code: 'nh087y' },
  { name: 'MT-07 (2018 - 20)', code: '7QZm2b' },
  { name: 'MT-07 (2021 - 24)', code: '88SFrS' },
  { name: 'MT-07 ABS (2014 - 16)', code: 'DfEo2y' },
  { name: 'MT-07 Moto Cage (2015 - 17)', code: 'fpFXkb' },
];
const ctx = { marca: 'Yamaha', modello: 'MT-07' };

test('lo slug e\' quello che Moto.it mette nell\'URL dell\'annuncio', () => {
  assert.equal(slugVersione('MT-07 (2014 - 16)'), 'mt-07-2014-16');
  assert.equal(slugVersione('SH 125 i ABS (2013-17)'), 'sh-125-i-abs-2013-17');
  assert.equal(slugDaUrl('https://www.moto.it/moto-usate/yamaha/mt-07/mt-07-2014-16/10077230'), 'mt-07-2014-16');
  assert.equal(slugDaUrl('https://www.moto.it/moto-usate/yamaha/mt-07'), null);
});

test('una parola d\'allestimento aggancia una versione sola', () => {
  const r = risolvi(MT07, 'Moto Cage', ctx);
  assert.equal(r.versioni.length, 1);
  assert.equal(r.versioni[0].code, 'fpFXkb');
  assert.deepEqual(r.scartate, []);
});

test('una parola che copre piu\' periodi le restituisce TUTTE', () => {
  // "ABS" sta in una sola voce qui; l'anno invece ne tiene due
  const r = risolvi(MT07, '2014', ctx);
  assert.equal(r.versioni.length, 2);                       // MT-07 e MT-07 ABS, stesso periodo
  assert.ok(r.versioni.every(v => /2014/.test(v.nome)));
});

test('le parole di marca e modello NON contano', () => {
  // Senza toglierle, "yamaha mt 07" combacerebbe con tutto e sembrerebbe un successo:
  // e' il modello, che avevamo gia' filtrato.
  const r = risolvi(MT07, 'Yamaha MT-07', ctx);
  assert.deepEqual(r.versioni, []);
  assert.deepEqual(r.tenute, []);
});

test('la parola che azzererebbe si scarta invece di svuotare tutto', () => {
  const r = risolvi(MT07, 'Moto Cage depotenziata', ctx);
  assert.equal(r.versioni.length, 1);
  assert.deepEqual(r.scartate, ['depotenziata']);            // e chi chiama puo' dirlo
});

test('un testo che il catalogo non conosce NON filtra niente', () => {
  // Meglio nessun filtro che una moto a caso: chi chiama lascia la fonte larga.
  const r = risolvi(MT07, 'akrapovic tenuta benissimo', ctx);
  assert.deepEqual(r.versioni, []);
  assert.equal(r.scartate.length, 3);
});

test('piu\' parole restringono', () => {
  const uno = risolvi(MT07, 'MT-07', { marca: 'Yamaha', modello: '' }).versioni.length;
  const due = risolvi(MT07, 'MT-07 ABS', { marca: 'Yamaha', modello: '' }).versioni.length;
  assert.ok(uno > due, `${uno} → ${due}`);
  assert.equal(due, 1);
});

test('non esplode su catalogo vuoto o testo vuoto', () => {
  assert.deepEqual(risolvi([], 'abs', ctx).versioni, []);
  assert.deepEqual(risolvi(MT07, '', ctx).versioni, []);
  assert.deepEqual(risolvi(null, null, null).versioni, []);
});
