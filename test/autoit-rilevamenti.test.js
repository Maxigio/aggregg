'use strict';
/**
 * Rilevamenti di Auto (auto.it): la quarta fonte del catalogo, quella che porta le MISURE
 * invece delle dichiarazioni. Qui si difende il PARSING, che e' la parte fragile: i dati non
 * stanno nell'HTML ma dentro il payload RSC di Next.js, spezzato in decine di frammenti da
 * ricucire, de-escapare e da cui ritagliare gli oggetti a mano contando le graffe.
 *
 * Le fixture sono pagine VERE scaricate il 2026-07-25 e ridotte ai soli frammenti utili:
 * i test girano offline e non toccano la rete.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const r = require('../backend/scrapers/autoit-rilevamenti');

const leggi = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const JAGUAR = leggi('autoit-jaguar.html');
const INDICE = leggi('autoit-indice.html');

test('indice: 45 marche, tutte con nome e logo veri', () => {
  const m = r._marcheDaIndice(INDICE);
  assert.strictEqual(m.length, 45);
  assert.strictEqual(m.filter(x => x.logo).length, 45, 'il payload porta anche i loghi');
  // I nomi si leggono dal payload, NON si deducono dallo slug: dedotti, "bmw-bmw" darebbe
  // "Bmw" e "ds-dsa" darebbe "Ds".
  const bmw = m.find(x => x.acronimo === 'bmw-bmw');
  assert.strictEqual(bmw.nome, 'BMW');
  assert.strictEqual(m.find(x => x.acronimo === 'ds-dsa').nome, 'DS');
  assert.strictEqual(m.find(x => x.acronimo === 'alfa-romeo-alf').nome, 'Alfa Romeo');
  assert.match(bmw.logo, /^https:\/\//);
});

test('ripiego nomeDaSlug: le sigle brevi restano maiuscole', () => {
  assert.strictEqual(r._nomeDaSlug('bmw-bmw'), 'BMW');
  assert.strictEqual(r._nomeDaSlug('ds-dsa'), 'DS');
  assert.strictEqual(r._nomeDaSlug('land-rover-lnd'), 'Land Rover');
  assert.strictEqual(r._nomeDaSlug('alfa-romeo-alf'), 'Alfa Romeo');
});

test('una pagina di prove: 10 record, zero falliti', () => {
  const rec = r._estraiRecord(JAGUAR);
  assert.strictEqual(rec.length, 10, 'una pagina ne porta 10');
  assert.ok(rec.every(x => x.nome), 'ogni record ha un nome');
});

test('il record porta i valori MISURATI, e l\'anno esce dal nome', () => {
  const x = r._estraiRecord(JAGUAR).find(v => v.nome === 'XF 3.0 D');
  assert.ok(x, 'la XF 3.0 D deve esserci');
  assert.strictEqual(x.anno, 2015, '"XF 3.0 D - 2015" → nome e anno separati');
  assert.strictEqual(x.velocitaMax, 250.6);
  assert.strictEqual(x.acc0_100, "6''61");
  assert.strictEqual(x.ripresa80_120, "4''27");
  assert.strictEqual(x.frenata100_0, 34.8);
  assert.strictEqual(x.consumoMedio, 15.902, 'la fonte da\' km/l');
  assert.match(x.link, /^https:\/\/www\.auto\.it\//, 'il rimando all\'articolo');
  assert.strictEqual(x.prova, 'numero 1 2016');
});

test('i consumi diventano l/100 km, che e\' l\'unita\' del resto dell\'app', () => {
  // Senza questa conversione il dato non parla con il calcolo del costo carburante.
  assert.strictEqual(r._per100(15.902), 6.29);
  assert.strictEqual(r._per100(11.109), 9);
  assert.strictEqual(r._per100(0), null);
  assert.strictEqual(r._per100(null), null);
  const x = r._estraiRecord(JAGUAR).find(v => v.nome === 'XF 3.0 D');
  assert.strictEqual(x.l100Medio, 6.29);
});

test('i valori che la fonte non ha restano null, non zero', () => {
  const rec = r._estraiRecord(JAGUAR);
  const ip = rec.find(v => /I-Pace/.test(v.nome));
  assert.ok(ip, 'la I-Pace deve esserci');
  assert.strictEqual(ip.l100Medio, null, 'e\' elettrica: un consumo in l/100 km non esiste');
  assert.strictEqual(ip.elettrica, true);
  // "-" e "n.r." della fonte non devono diventare testo mostrato
  assert.ok(rec.every(v => v.pista !== 'n.r.' && v.autonomiaBatteria !== '-'));
});

test('mappaRecord: un record senza modello viene scartato', () => {
  assert.strictEqual(r._mappaRecord({ VelocitaMassima: '200' }), null);
  assert.strictEqual(r._mappaRecord({ Modello: '   ' }), null);
  const solo = r._mappaRecord({ Modello: 'Panda' });
  assert.strictEqual(solo.nome, 'Panda');
  assert.strictEqual(solo.anno, null, 'senza " - AAAA" l\'anno non si inventa');
  assert.strictEqual(solo.velocitaMax, null);
});

test('oggettoAttorno: ritaglia l\'oggetto giusto anche annidato', () => {
  const s = '[{"a":1},{"b":{"c":2},"VelocitaMassima":"9"},{"d":3}]';
  const t = r._oggettoAttorno(s, s.indexOf('VelocitaMassima'));
  assert.deepStrictEqual(JSON.parse(t), { b: { c: 2 }, VelocitaMassima: '9' });
  assert.strictEqual(r._oggettoAttorno('niente graffe', 3), null);
});
