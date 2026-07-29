'use strict';
/**
 * La versione dedotta dal testo dell'annuncio.
 *
 * IL RISCHIO QUI NON E' PERDERE UNA VERSIONE: e' DIRNE UNA SBAGLIATA. Un operatore che
 * confronta i prezzi su un allestimento sbagliato confronta due auto diverse, e non ha
 * modo di accorgersene. Per questo i casi che contano sono quelli in cui la funzione deve
 * TACERE, e stanno quasi tutti qui sotto.
 *
 * I casi vengono dal banco di prova su 7.431 annunci Subito veri (vedi versione-dedotta.js).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { preparaVersioni, deduci, datiAnnuncio, _parsaNome } = require('../backend/scrapers/versione-dedotta');

const GOLF = preparaVersioni([
  'Golf 1.6 TDI 110 CV 5p. Comfortline BlueMotion Technology',
  'Golf 1.6 TDI 110 CV 5p. Highline BlueMotion Technology',
  'Golf 2.0 TDI 150 CV DSG SCR Style',
  'Golf 1.4 TSI 122CV 5p. Comfortline',
  'Golf 2.0 TSI GTI',
  'Golf 1.6 3p. Trendline',
], 'Golf 7ª serie');

const ann = o => datiAnnuncio({ porte: '4/5', carburante: 'Diesel', cambio: 'Manuale', ...o });

test('parsa: il nome si scioglie in attributi e allestimento', () => {
  const v = _parsaNome('Golf 1.5 eTSI 150 CV EVO ACT DSG 1st Edition Style', new Set(['golf']));
  assert.equal(v.cc, 1.5);
  assert.equal(v.cv, 150);
  assert.equal(v.auto, true);          // DSG
  assert.equal(v.carb, 'benzina');     // eTSI
  // "1st edition style" resta attaccato: spezzarlo farebbe combaciare "style" da solo
  assert.ok(v.trims.some(t => t.includes('style')));
});

test('parsa: il nome del modello non e\' un allestimento', () => {
  const v = _parsaNome('Golf 1.6 3p. Trendline', new Set(['golf']));
  assert.deepEqual(v.trims, ['trendline']);
  assert.equal(v.porte, 3);
});

test('esatta: il nome scritto per intero nel titolo', () => {
  const r = deduci(GOLF, ann({ titolo: 'Volkswagen Golf 2.0 TDI 150 CV DSG SCR Style', cambio: 'Automatico' }));
  assert.equal(r.esito, 'esatta');
  assert.equal(r.versione, 'Golf 2.0 TDI 150 CV DSG SCR Style');
});

test('esatta: vince il nome piu\' lungo, non il primo', () => {
  // "Golf 2.0 TSI GTI" non deve battere una voce piu' specifica che pure c'e' nel testo
  const cat = preparaVersioni(['Golf 2.0 TSI GTI', 'Golf 2.0 TSI GTI Performance'], 'Golf');
  const r = deduci(cat, ann({ titolo: 'Volkswagen Golf 2.0 TSI GTI Performance', carburante: 'Benzina' }));
  assert.equal(r.versione, 'Golf 2.0 TSI GTI Performance');
});

test('esatta: il catalogo ripete il modello davanti, il venditore no', () => {
  const r = deduci(GOLF, ann({ titolo: 'VW 1.4 TSI 122CV 5p. Comfortline del 2015', carburante: 'Benzina' }));
  assert.equal(r.esito, 'esatta');
  assert.equal(r.versione, 'Golf 1.4 TSI 122CV 5p. Comfortline');
});

test('allestimento: piu\' versioni compatibili, una sola parola trovata', () => {
  // 1.6 TDI: restano Comfortline e Highline; il testo dice solo "highline"
  const r = deduci(GOLF, ann({ titolo: 'Golf 1.6 TDI Highline km certificati' }));
  assert.equal(r.esito, 'allestimento');
  assert.equal(r.allestimento, 'Highline');
});

test('l\'allestimento si cerca nel TITOLO, non nel corpo', () => {
  // Il corpo e' 1.000 caratteri di prosa: "sport" ci finisce dentro come "assetto sport"
  // e non dice niente sull'allestimento. Misurato: cercandolo anche li', gli sbagli di
  // questo livello passano dal 7,4% al 10,1%.
  const r = deduci(GOLF, ann({ titolo: 'Golf 1.6 TDI', descrizione: 'cerchi in lega, assetto Highline sportivo' }));
  assert.equal(r, null);
});

test('il nome INTERO trovato nel corpo invece vale', () => {
  // Una coincidenza su una parola capita; su un nome-versione completo no.
  const r = deduci(GOLF, ann({ titolo: 'Golf del 2016 tenuta benissimo',
    descrizione: 'Vendo Golf 1.6 TDI 110 CV 5p. Highline BlueMotion Technology, unico proprietario' }));
  assert.equal(r.esito, 'esatta');
  assert.equal(r.versione, 'Golf 1.6 TDI 110 CV 5p. Highline BlueMotion Technology');
});

test('la classe di emissione non e\' un allestimento', () => {
  // "Euro 5" era 1.864 occorrenze nel catalogo e usciva come allestimento
  const v = _parsaNome('Panda 1.2 Dynamic Euro 5', new Set(['panda']));
  assert.deepEqual(v.trims, ['dynamic']);
});

test('turbodiesel: "turbo" non fa diventare benzina un diesel', () => {
  const v = _parsaNome('Panda 1.3 Turbo MJT 4x4', new Set(['panda']));
  assert.equal(v.carb, 'diesel');
});

test('"Natural Power" e\' metano, e "power" non resta a fare l\'allestimento', () => {
  const v = _parsaNome('Panda 0.9 TwinAir Turbo Natural Power Lounge', new Set(['panda']));
  assert.equal(v.carb, 'metano');
  assert.deepEqual(v.trims, ['lounge']);
});

test('TACE quando il testo nomina due allestimenti diversi', () => {
  // Due parole vogliono dire che si sta leggendo la prosa del venditore, non la versione
  const r = deduci(GOLF, ann({ titolo: 'Golf 1.6 TDI', descrizione: 'Comfortline, valuto permuta con Highline' }));
  assert.equal(r, null);
});

test('TACE quando l\'annuncio non dice niente di riconoscibile', () => {
  assert.equal(deduci(GOLF, ann({ titolo: 'Volkswagen Golf YF23399' })), null);
  assert.equal(deduci(GOLF, ann({ titolo: 'Golf' })), null);
});

test('i vincoli nativi escludono: il diesel non diventa una benzina', () => {
  // Il testo dice "GTI" ma l'annuncio dichiara Diesel: la GTI e' benzina, esce di scena
  const r = deduci(GOLF, ann({ titolo: 'Golf GTI look, motore 1.6 TDI' }));
  assert.notEqual(r && r.versione, 'Golf 2.0 TSI GTI');
});

test('i vincoli nativi escludono: 5 porte non e\' una 3 porte', () => {
  const r = deduci(GOLF, ann({ titolo: 'Golf 1.6 Trendible Trendline', carburante: 'Benzina', porte: '4/5' }));
  assert.equal(r, null);          // l'unica Trendline a catalogo e' 3 porte
});

test('carburante: il mild hybrid benzina sta su una versione benzina', () => {
  const cat = preparaVersioni(['Golf 1.5 eTSI 130 CV EVO ACT DSG Life'], 'Golf');
  const r = deduci(cat, ann({ titolo: 'Golf 1.5 eTSI 130 CV EVO ACT DSG Life',
    carburante: 'Mild Hybrid Benzina', cambio: 'Automatico' }));
  assert.equal(r.esito, 'esatta');
});

test('carburante: un elettrico non e\' un diesel', () => {
  const cat = preparaVersioni(['Golf 1.6 TDI 110 CV 5p. Comfortline'], 'Golf');
  assert.equal(deduci(cat, ann({ titolo: 'Golf Comfortline', carburante: 'Elettrica' })), null);
});

test('cambio: il catalogo dice automatico, l\'annuncio dice manuale → fuori', () => {
  const cat = preparaVersioni(['Golf 2.0 TDI DSG Style', 'Golf 2.0 TDI Style'], 'Golf');
  const r = deduci(cat, ann({ titolo: 'Golf 2.0 TDI Style', cambio: 'Manuale' }));
  assert.equal(r.versione, 'Golf 2.0 TDI Style');
});

test('non esplode su catalogo vuoto o annuncio senza testo', () => {
  assert.equal(deduci([], ann({ titolo: 'Golf 1.6 TDI Highline' })), null);
  assert.equal(deduci(GOLF, ann({ titolo: '' })), null);
  assert.equal(deduci(null, null), null);
});

test('datiAnnuncio: le porte di Subito sono una coppia ("4/5")', () => {
  const d = datiAnnuncio({ porte: '4/5', titolo: 'x' });
  assert.deepEqual(d.porte, [4, 5]);
  assert.deepEqual(datiAnnuncio({ porte: '2/3', titolo: 'x' }).porte, [2, 3]);
  assert.equal(datiAnnuncio({ titolo: 'x' }).porte, null);
});

test('l\'allestimento esce com\'e\' scritto nel catalogo, non minuscolo', () => {
  // Il confronto gira sulla forma normalizzata, la risposta no: "S line", non "s line".
  // "S line" resta "S line": se la S finisse fra le sigle tecniche resterebbe "line",
  // che da sola aggancerebbe anche una R-Line.
  const cat = preparaVersioni(['A3 1.6 TDI S line', 'A3 2.0 TDI S line'], 'A3');
  const r = deduci(cat, ann({ titolo: 'Audi A3 S line, motore 1.6 TDI' }));
  assert.equal(r.esito, 'allestimento');
  assert.equal(r.allestimento, 'S line');
});

test('le parole d\'allestimento attaccate restano attaccate', () => {
  // "GTI Performance" e' un tratto solo: cercando "performance" da sola si aggancerebbe
  // qualunque annuncio che nomina le prestazioni.
  const v = _parsaNome('Golf 2.0 TSI GTI Performance', new Set(['golf']));
  assert.deepEqual(v.trims, ['gti performance']);
});

test('nel corpo vale solo un nome che porta un allestimento', () => {
  // "A3 2.0 TDI" si trova nel corpo di ogni annuncio di un 2.0 TDI: non e' una prova.
  // Visto dal vivo su tre A3 di fila, dichiarate 'esatta' senza che il titolo lo dicesse.
  const cat = preparaVersioni(['A3 2.0 TDI', 'A3 2.0 TDI Ambition'], 'A3');
  const r = deduci(cat, ann({ titolo: 'AUDI A3 Sportback', descrizione: 'ottimo stato, motore 2.0 TDI' }));
  assert.notEqual(r && r.esito, 'esatta');
});

test('la sigla del motore non copre l\'allestimento: "530xd Touring Futura" e\' una Futura', () => {
  // Caso vero, dagli annunci: la risposta giusta c'era e veniva buttata perche' nel titolo
  // comparivano DUE parole conosciute — la sigla del motore e l'allestimento. La sigla si
  // riconosce da dove sta: Subito apre con lei il nome della versione.
  const versioni = preparaVersioni([
    '530xd cat Touring Futura', '530xd cat Touring Eletta', '530xd cat Touring',
    '520d cat Touring Futura', '525d cat Touring Attiva',
  ], 'Serie 5');
  const r = deduci(versioni, ann({ titolo: 'Bmw 530xd Touring Futura' }));
  assert.ok(r, 'una risposta ci deve essere');
  assert.equal(r.esito, 'allestimento');
  assert.match(r.allestimento, /futura/i);
});

test('se la sigla e\' l\'unica parola conosciuta, resta lei', () => {
  // Senza questo, sparirebbero anche le sigle che SONO il nome della versione (Audi RS3).
  const versioni = preparaVersioni(['RS3 SPB 2.5 TFSI quattro S tronic', 'A3 SPB 1.6 TDI Business'], 'A3');
  // cambio automatico: la voce di catalogo e' una "S tronic", e un annuncio dichiarato
  // manuale la escluderebbe prima di arrivare all'allestimento.
  const r = deduci(versioni, ann({ titolo: 'Audi RS3 Sportback', carburante: 'Benzina', cambio: 'Automatico' }));
  assert.ok(r);
  assert.match(r.allestimento, /rs3/i);
});

test('la sigla si dichiara come motorizzazione, non come allestimento', () => {
  // 118 risposte su 147 (misurate su 797 annunci veri) erano "320d", "118d", "330d" stampate
  // sotto la parola "Allestimento". Il dato e' giusto, l'etichetta no.
  const versioni = preparaVersioni([
    '320d cat Touring MSport', '320d cat Touring', '318d cat Touring Futura',
  ], 'Serie 3');
  const sigla = deduci(versioni, ann({ titolo: 'Bmw 320d e91' }));
  assert.ok(sigla);
  assert.equal(sigla.cosa, 'motorizzazione');
  const trim = deduci(versioni, ann({ titolo: 'Bmw 318d Touring Futura' }));
  assert.ok(trim);
  assert.equal(trim.cosa, 'allestimento');
  assert.match(trim.allestimento, /futura/i);
});
