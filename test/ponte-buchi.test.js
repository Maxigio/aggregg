'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { agganciaSubito } = require('../backend/scrapers/ponte-buchi');
const { _buildPath, _riconosci } = require('../backend/scrapers/subito-api');

/** Un annuncio finto con la sua gerarchia dichiarata, come la scrive Subito. */
const ann = (marca, modello, versione) => ({
  subject: 'annuncio finto',
  features: { x: { uri: '/car', values: [
    { label: 'Marca', key: marca[0], value: marca[1] },
    { label: 'Modello', key: modello[0], value: modello[1] },
    { label: 'Versione', key: versione[0], value: versione[1] },
  ] } },
});

test('il modello dentro la famiglia porta famiglia + testo', () => {
  const b = agganciaSubito('auto', 'Volkswagen', 'Golf GTI');
  assert.equal(b.marcaId, '000101');
  assert.equal(b.testo, 'gti');
  assert.ok(b.famigliaIds.length);
});

test('la famiglia che E\' gia\' il veicolo non prende testo', () => {
  // "Scarabeo" su Subito e' la famiglia intera: la versione li' e' la cilindrata,
  // non ripete il nome — filtrarci ammazzerebbe tutto (misurato: Leoncino 94 → 0).
  assert.equal(agganciaSubito('moto', 'Aprilia', 'Scarabeo').testo, null);
});

test('nomi scritti come capita, e chi non c\'e\' resta fuori', () => {
  assert.ok(agganciaSubito('auto', 'volkswagen', 'golf  gti'));
  assert.equal(agganciaSubito('auto', 'Volkswagen', 'Golf'), null);      // la famiglia non e' un buco
  assert.equal(agganciaSubito('moto', 'Volkswagen', 'Golf GTI'), null);  // tipo sbagliato
});

test('il testo va alla fonte insieme agli id', () => {
  const p = _buildPath({ tipo: 'auto', subitoNodo: agganciaSubito('auto', 'Volkswagen', 'Golf GTI') }, 0);
  assert.match(p, /cb=000101/);
  assert.match(p, /cm=/);
  assert.match(p, /[?&]q=gti/);
});

test('col testo si tiene solo chi lo dichiara davvero', () => {
  const nodo = agganciaSubito('auto', 'Volkswagen', 'Golf GTI');
  const M = ['000101', 'Volkswagen'], F = [nodo.famigliaIds[0], 'Golf'];
  assert.equal(_riconosci(ann(M, F, ['00123', 'Golf 2.0 TSI GTI']), nodo, {}), 'esatto');
  assert.equal(_riconosci(ann(M, F, ['00124', 'Golf 1.6 TDI Comfortline']), nodo, {}), null);
  // Non dichiarata: RESTA marcata — `q` alla fonte le ha gia' letto il titolo, ed e'
  // spesso l'annuncio compilato male, cioe' dove sta l'affare.
  assert.equal(_riconosci(ann(M, F, ['000000', 'Altro allestimento']), nodo, {}), 'senza-versione');
});

test('parola intera e nell\'ordine scritto', () => {
  const nodo = agganciaSubito('auto', 'Mini', 'Cooper S');
  const M = [nodo.marcaId, 'Mini'], F = [nodo.famigliaIds[0], 'Mini'];
  assert.equal(_riconosci(ann(M, F, ['1', 'Mini 2.0 Cooper S']), nodo, {}), 'esatto');
  assert.equal(_riconosci(ann(M, F, ['2', 'Mini Cooper D Business']), nodo, {}), null);   // non "Cooper S"
  assert.equal(_riconosci(ann(M, F, ['3', 'Mini Cooper SE Yours']), nodo, {}), null);     // "SE" non e' "S"
});
