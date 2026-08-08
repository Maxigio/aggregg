'use strict';
/**
 * LE VERSIONI SUGGERIBILI (backend/versioni-menu.js) — eseguite sul catalogo vero.
 * La regola: i suggerimenti sono i nomi-versione della famiglia RISOLTA (stesso
 * risolutore della ricerca, ponte degli ospiti compreso), senza la testa che ripete il
 * modello, senza il segnaposto «Altro allestimento», senza doppioni; famiglia non
 * risolta → lista vuota, mai l'elenco di un altro veicolo.
 */
const test = require('node:test');
const assert = require('node:assert');
const { versioniDi } = require('../backend/versioni-menu');
const { norm } = require('../backend/scrapers/brand-match');

test('si suggerisce l\'ALLESTIMENTO, non la stringa-motore: la coda dopo il marcatore di potenza', () => {
  const v = versioniDi('auto', 'Abarth', '124 Spider');
  assert.ok(v.length >= 3, 'attesi allestimenti per la 124 Spider, avuti ' + v.length);
  assert.ok(v.includes('GT') && v.includes('Scorpione'), 'attesi «GT» e «Scorpione», avuti: ' + v.join(' | '));
  assert.ok(!v.some(x => /^124 Spider/i.test(x)), 'la testa «124 Spider» va tolta');
  assert.ok(!v.some(x => /\d+\s*CV\b/i.test(x)), 'il motore («… 170 CV») non si suggerisce: alle fonti e\' un AND che azzera');
  // e l'ordine e' per frequenza: per la 500 le voci comuni (Lounge, Pop) stanno in cima
  const cinquecento = versioniDi('auto', 'Fiat', '500');
  assert.ok(cinquecento.slice(0, 6).includes('Lounge'), 'atteso «Lounge» in testa alla 500: ' + cinquecento.slice(0, 6).join(' | '));
});

test('il ponte degli ospiti vale anche qui: le versioni della Vespa 125 GTS arrivano da marca Vespa', () => {
  const v = versioniDi('moto', 'Vespa', '125 GTS');
  assert.ok(v.length >= 1, 'attese versioni via ospite');
  assert.ok(v.some(x => /super/i.test(x)), 'attesa una «Super …», avute: ' + v.slice(0, 4).join(' | '));
});

test('niente segnaposto, niente doppioni', () => {
  for (const [t, ma, mo] of [['auto', 'Volkswagen', 'Golf'], ['moto', 'Ducati', 'Monster']]) {
    const v = versioniDi(t, ma, mo);
    assert.ok(v.length > 0, `${ma} ${mo}: attese versioni`);
    assert.ok(!v.some(x => /altro allestimento/i.test(x)), 'il segnaposto non si suggerisce');
    const chiavi = v.map(norm);
    assert.strictEqual(new Set(chiavi).size, chiavi.length, `${ma} ${mo}: doppioni nei suggerimenti`);
  }
});

test('famiglia non risolta → lista vuota, non l\'elenco di un altro veicolo', () => {
  assert.deepStrictEqual(versioniDi('moto', 'Zündapp', 'C 50'), []);
  assert.deepStrictEqual(versioniDi('auto', 'MarcaInventata', 'Boh'), []);
});
