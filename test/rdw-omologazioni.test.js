'use strict';
/**
 * La normalizzazione del numero di omologazione.
 *
 * E' l'unico pezzo puro, ed e' quello che decide se una ricerca trova o no: Safety Gate
 * scrive il numero in forme diverse — con l'intervallo di revisioni, col codice del
 * costruttore fra parentesi, senza estensione — e l'RDW lo conserva in forma canonica.
 * Sbagliare qui vuol dire "nessuna versione trovata" su un'omologazione che c'e'.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { _base } = require('../backend/scrapers/rdw-omologazioni');

test('toglie l\'intervallo di revisioni e il codice del costruttore', () => {
  assert.strictEqual(_base('e4*168/2013*00131*01-*04 (RA1)'), 'e4*168/2013*00131');
  assert.strictEqual(_base('e1*2018/858*00500*00-*01 (MMCLAE)'), 'e1*2018/858*00500');
  assert.strictEqual(_base('e13*2007/46*0900*12-*14 (9YA)'), 'e13*2007/46*0900');
});

test('regge le forme senza estensione', () => {
  assert.strictEqual(_base('e4*2018/858*00060*'), 'e4*2018/858*00060');
  assert.strictEqual(_base('e1*2007/46*1801'), 'e1*2007/46*1801');
  assert.strictEqual(_base('e2*2007/46*0031'), 'e2*2007/46*0031');
});

test('un intervallo scritto a parole tiene il PRIMO numero, non un ibrido', () => {
  // nell'archivio c'e' davvero "e2*2018/858*00084 à e2*2018/858*00087"
  assert.strictEqual(_base('e2*2018/858*00084 à e2*2018/858*00087'), 'e2*2018/858*00084');
});

test('quello che non e\' un\'omologazione resta null, non diventa una ricerca a caso', () => {
  assert.strictEqual(_base('spazzatura'), null);
  assert.strictEqual(_base(''), null);
  assert.strictEqual(_base(null), null);
  assert.strictEqual(_base('KBA 12345'), null);
});
