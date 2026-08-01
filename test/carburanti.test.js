'use strict';
// Prezzi carburante MIMIT: fixture nella forma REALE dei file (verificata sui file veri).
// Riga 1 "Estrazione del…", riga 2 intestazione, separatore PIPE, codifica latin1.
const { test } = require('node:test');
const assert = require('node:assert');
const c = require('../backend/carburanti');

const IMPIANTI = [
  'Estrazione del 2026-07-24',
  'idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine',
  '1|Tizio|Agip Eni|Stradale|Uno|Via A|MILANO|MI|45.4|9.1',
  '2|Caio|Q8|Stradale|Due|Via B|MILANO|MI|45.5|9.2',
  '3|Sempronio|IP|Stradale|Tre|Via C|PALERMO|PA|38.1|13.3',
  '4|Rotto|X|Stradale|Quattro|Via D|LECCO|LECCO|45.8|9.4',   // Provincia sporca (nome comune)
].join('\n');

const PREZZI = [
  'Estrazione del 2026-07-24',
  'idImpianto|descCarburante|prezzo|isSelf|dtComu',
  // Milano: 6 self benzina (sopra la soglia di 5 → si usa il self)
  ...[1.90, 1.92, 1.94, 1.96, 1.98, 2.00].map((p, i) => `${i % 2 ? 2 : 1}|Benzina|${p}|1|23/07/2026 19:30:00`),
  '1|Benzina|2.50|0|23/07/2026 19:30:00',            // servito: NON deve entrare nella mediana self
  '1|Blue Diesel|2.40|1|23/07/2026 19:30:00',         // premium: fuori dalle famiglie standard
  '1|HVOlution|2.30|1|23/07/2026 19:30:00',           // premium: fuori
  '1|GPL|0.75|0|23/07/2026 19:30:00',                 // GPL: pochi self → si usano tutti
  '2|GPL|0.79|0|23/07/2026 19:30:00',
  '3|Benzina|2.10|1|23/07/2026 19:30:00',             // Palermo
  '3|Gasolio|2.20|1|23/07/2026 19:30:00',
  '4|Benzina|1.50|1|23/07/2026 19:30:00',             // impianto con provincia sporca → scartato
  '1|Benzina|0|1|23/07/2026 19:30:00',                // prezzo impossibile → scartato
  '1|Benzina|99|1|23/07/2026 19:30:00',               // idem
].join('\n');

test('parseImpianti: sigla provincia valida, righe sporche scartate', () => {
  const m = c.parseImpianti(IMPIANTI);
  assert.strictEqual(m.get('1'), 'MI');
  assert.strictEqual(m.get('3'), 'PA');
  assert.ok(!m.has('4'), 'la riga con Provincia="LECCO" va scartata');
  assert.strictEqual(m.size, 3);
});

test('costruisciIndice: mediana per provincia, data di estrazione, fonte citata', () => {
  const i = c.costruisciIndice(PREZZI, IMPIANTI);
  assert.strictEqual(i.aggiornato, '2026-07-24');
  assert.match(i.fonte, /MIMIT/);
  assert.deepStrictEqual(Object.keys(i.province).sort(), ['MI', 'PA']);
  assert.strictEqual(i.province.MI.benzina.p, 1.96);        // mediana dei 6 self
  assert.strictEqual(i.province.MI.benzina.self, true);
  assert.strictEqual(i.province.PA.gasolio.p, 2.2);
});

test('costruisciIndice: i carburanti premium NON gonfiano la famiglia base', () => {
  const i = c.costruisciIndice(PREZZI, IMPIANTI);
  assert.ok(i.province.MI.benzina.p < 2.0, 'Blue Diesel/HVOlution non devono entrare');
  assert.ok(!('blue diesel' in i.province.MI), 'niente famiglie inventate');
  assert.deepStrictEqual(Object.keys(i.province.MI).sort(), ['benzina', 'gpl']);
});

test('costruisciIndice: il servito non entra dove il self è consistente', () => {
  const i = c.costruisciIndice(PREZZI, IMPIANTI);
  assert.strictEqual(i.province.MI.benzina.self, true, 'sei quotazioni self: sopra la soglia, si usa il self');
  // `n` conta gli IMPIANTI dietro il prezzo, non le quotazioni. Qui le sei righe self
  // vengono da DUE distributori soli (la fixture alterna gli impianti 1 e 2): scrivere "6"
  // faceva sembrare largo un campione che è largo un terzo, e l'avviso "solo N impianti"
  // — che esiste apposta per dire quando il prezzo è poco rappresentativo — non scattava.
  assert.strictEqual(i.province.MI.benzina.n, 2);
});

test('costruisciIndice: n conta gli impianti del campione usato, non le quotazioni', () => {
  // Un distributore che vende self E servito manda due righe per la stessa famiglia.
  const impianti = [
    'Estrazione del 2026-07-24',
    'idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine',
    '10|Tizio|Agip Eni|Stradale|Dieci|Via A|ROMA|RM|41.9|12.5',
    '11|Caio|Q8|Stradale|Undici|Via B|ROMA|RM|41.8|12.4',
  ].join('\n');
  const prezzi = [
    'Estrazione del 2026-07-24',
    'idImpianto|descCarburante|prezzo|isSelf|dtComu',
    // GPL: due impianti, quattro righe (ognuno self + servito). Il GPL usa TUTTI i prezzi.
    '10|GPL|0.75|1|23/07/2026 19:30:00',
    '10|GPL|0.80|0|23/07/2026 19:30:00',
    '11|GPL|0.77|1|23/07/2026 19:30:00',
    '11|GPL|0.82|0|23/07/2026 19:30:00',
  ].join('\n');
  const i = c.costruisciIndice(prezzi, impianti);
  assert.strictEqual(i.province.RM.gpl.self, false, 'sul GPL i self sono pochi: si usano tutti i prezzi');
  assert.strictEqual(i.province.RM.gpl.n, 2, 'due distributori, non quattro quotazioni');
});

test('costruisciIndice: GPL/metano usano tutti i prezzi (i self sono troppo pochi)', () => {
  const i = c.costruisciIndice(PREZZI, IMPIANTI);
  assert.strictEqual(i.province.MI.gpl.self, false);
  assert.strictEqual(i.province.MI.gpl.n, 2);
});

test('costruisciIndice: prezzi impossibili scartati', () => {
  const i = c.costruisciIndice(PREZZI, IMPIANTI);
  assert.ok(i.province.MI.benzina.p > 1 && i.province.MI.benzina.p < 3);
});

test('famigliaDa: alimentazione della scheda → famiglia quotabile', () => {
  assert.strictEqual(c.famigliaDa('Benzina'), 'benzina');
  assert.strictEqual(c.famigliaDa('Gasolio'), 'gasolio');
  assert.strictEqual(c.famigliaDa('Diesel'), 'gasolio');
  assert.strictEqual(c.famigliaDa('GPL'), 'gpl');
  assert.strictEqual(c.famigliaDa('Metano'), 'metano');
  assert.strictEqual(c.famigliaDa('Ibrida benzina'), 'benzina');   // l'ibrida brucia benzina
  assert.strictEqual(c.famigliaDa('Energia elettrica'), null);      // il prezzo energia è altra fonte
  assert.strictEqual(c.famigliaDa(''), null);
  assert.strictEqual(c.famigliaDa(null), null);
});

test('consumoDa: legge i litri, ignora le elettriche', () => {
  assert.strictEqual(c.consumoDa('6.4-7.2 l/100 km'), 6.8);   // media del range
  assert.strictEqual(c.consumoDa('5,1 l/100 km'), 5.1);        // virgola decimale italiana
  assert.strictEqual(c.consumoDa('7 l/100 km'), 7);
  assert.strictEqual(c.consumoDa('15.9-17.2 kWh/100 km'), null);
  assert.strictEqual(c.consumoDa('218 kg'), null);
  assert.strictEqual(c.consumoDa(''), null);
});

test('scarica: anti-SSRF, host diverso da mimit.gov.it rifiutato', async () => {
  await assert.rejects(() => c._scarica('https://example.com/x.csv'), /host non consentito/);
});
