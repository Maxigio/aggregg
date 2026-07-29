'use strict';
/**
 * Lo stesso mezzo esposto su piu' vetrine dello stesso concessionario.
 *
 * I casi qui sotto sono VERI: vengono dai tre parchi di Lucasmotorrad / Raineri Massimo
 * (Autoscout, Subito, Moto.it), dove lo stesso veicolo e' descritto in modo diverso da
 * fonte a fonte — chilometri arrotondati, chilometri non dichiarati, prezzi che non
 * coincidono. Un accostamento troppo severo non ne trova nessuno; uno troppo largo fonde
 * due moto diverse dello stesso modello. Servono tutti e due i tipi di prova.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { accoppia, _distanza } = require('../backend/competitor');

const a = (fonte, o) => ({ fonte, url: `${fonte}://${o.titolo}-${o.km}`, ...o });

test('la stessa moto su tre vetrine diventa un mezzo solo', () => {
  // Vero: Kawasaki Ninja 650 2025, stesso prezzo, 8.000 km su Moto.it e 5.000 su Subito.
  const r = accoppia([
    a('autoscout', { marca: 'Kawasaki', titolo: 'Kawasaki Ninja 650 35 kw', anno: 2025, km: 8000, prezzo: 6200 }),
    a('moto', { marca: 'Kawasaki', titolo: 'Ninja 650 (2025 - 26)', anno: 2025, km: 8000, prezzo: 6200 }),
    a('subito', { marca: 'Kawasaki', titolo: 'Kawasaki Ninja 650 s pat a2', anno: 2025, km: 5000, prezzo: 6200 }),
  ]);
  assert.equal(r.gruppi.length, 1);
  assert.equal(r.gruppi[0].urls.length, 3);
  assert.equal(r.mezzi, 1);          // tre annunci, un veicolo
});

test('i chilometri non dichiarati non impediscono l\'accostamento', () => {
  // Vero: Triumph Rocket 3 GT 2022, 5.800 km su Moto.it e 0 (non dichiarati) su Subito.
  const r = accoppia([
    a('moto', { marca: 'Triumph', titolo: 'Rocket 3 GT (2021 - 24)', anno: 2022, km: 5800, prezzo: 15900 }),
    a('subito', { marca: 'Triumph', titolo: 'Triumph Rocket III GT', anno: 2022, km: 0, prezzo: 15900 }),
  ]);
  assert.equal(r.gruppi.length, 1);  // il prezzo regge da solo
  assert.equal(r.mezzi, 1);
});

test('due moto uguali dello stesso anno restano due mezzi', () => {
  // Vero: due Suzuki GSX-S1000GT del 2022 nello stesso parco, 37.000 e 42.000 km.
  const r = accoppia([
    a('autoscout', { marca: 'Suzuki', titolo: 'Suzuki GSX S 1000GT', anno: 2022, km: 37000, prezzo: 8900 }),
    a('moto', { marca: 'Suzuki', titolo: 'GSX-S1000GT (2022 - 24)', anno: 2022, km: 37000, prezzo: 8900 }),
    a('autoscout', { marca: 'Suzuki', titolo: 'Suzuki GSX S 1000GT', anno: 2022, km: 42000, prezzo: 8900 }),
    a('moto', { marca: 'Suzuki', titolo: 'GSX-S1000GT (2022 - 24)', anno: 2022, km: 42000, prezzo: 8900 }),
  ]);
  assert.equal(r.gruppi.length, 2);
  assert.equal(r.mezzi, 2);
  for (const g of r.gruppi) assert.deepEqual([...new Set(g.fonti)].length, g.fonti.length, 'una vetrina, un annuncio per mezzo');
});

test('due annunci della stessa vetrina non si accoppiano mai', () => {
  assert.equal(_distanza(
    a('subito', { marca: 'Honda', titolo: 'Hornet 600', anno: 2006, km: 35000, prezzo: 3000 }),
    a('subito', { marca: 'Honda', titolo: 'Hornet 600', anno: 2006, km: 35000, prezzo: 3000 }),
  ), null);
});

test('stessa marca e stesso anno non bastano: il modello deve combaciare', () => {
  assert.equal(_distanza(
    a('autoscout', { marca: 'Suzuki', titolo: 'Suzuki SV 650', anno: 2008, km: 39000, prezzo: 2500 }),
    a('subito', { marca: 'Suzuki', titolo: 'Suzuki GSR 600', anno: 2008, km: 39000, prezzo: 2500 }),
  ), null);
});

test('se km e prezzo discordano tutti e due, non e\' lo stesso mezzo', () => {
  assert.equal(_distanza(
    a('autoscout', { marca: 'Honda', titolo: 'Honda Hornet 600', anno: 2006, km: 12000, prezzo: 5200 }),
    a('subito', { marca: 'Honda', titolo: 'Honda Hornet 600', anno: 2006, km: 60000, prezzo: 2600 }),
  ), null);
});

test('un prezzo diverso sulla stessa moto non la fa sparire: si accoppia e si vede', () => {
  // Vero: Suzuki SV 650 del 2002, 1.900 euro su Autoscout e 2.300 su Moto.it.
  const r = accoppia([
    a('autoscout', { marca: 'Suzuki', titolo: 'Suzuki SV 650', anno: 2002, km: 48000, prezzo: 1900 }),
    a('moto', { marca: 'Suzuki', titolo: 'SV 650 S (1999 - 02)', anno: 2002, km: 48000, prezzo: 2300 }),
  ]);
  assert.equal(r.gruppi.length, 1);
  assert.deepEqual(r.gruppi[0].prezzi.sort((x, y) => x - y), [1900, 2300]);   // la differenza resta leggibile
});

test('un parco solo non produce doppioni', () => {
  const soli = [
    a('autoscout', { marca: 'Ford', titolo: 'Transit Connect', anno: 2011, km: 280000, prezzo: 1500 }),
    a('autoscout', { marca: 'Volkswagen', titolo: 'Passat 1.6 GL', anno: 1987, km: 180000, prezzo: 7500 }),
  ];
  const r = accoppia(soli);
  assert.deepEqual(r.gruppi, []);
  assert.equal(r.mezzi, 2);
  assert.equal(accoppia([]).mezzi, 0);
});
