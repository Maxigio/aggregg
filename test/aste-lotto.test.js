'use strict';
/**
 * IL LETTORE DEI LOTTI D'ASTA. Il PVP non ha campi per marca e modello: c'e' `descLotto`, testo
 * libero scritto a mano. Qui si presidia quello che il lettore DEVE riconoscere e — piu'
 * importante — quello che NON deve inventare.
 *
 * I casi non sono immaginati: vengono tutti dai 619 lotti vivi misurati il 2026-09-01.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { leggi, marcaDa, creaIndice, descrizionePulita, aIso } = require('../backend/aste-lotto');

// Un indice piccolo e dichiarato: le prove non devono dipendere da com'e' fatto il catalogo oggi.
const IDX = creaIndice(
  ['Mercedes-Benz', 'Citroën', 'Volkswagen', 'Fiat', 'DR Automobiles'],
  ['CFMOTO', 'Moto Morini', 'MV Agusta', 'Piaggio', 'Voge', 'Benelli'],
);

test('la marca si legge anche quando la fonte la scrive in un altro modo', () => {
  // Accento: il catalogo dice «Citroën», l'avviso di vendita batte «CITROEN».
  assert.equal(marcaDa('AUTOVETTURA CITROEN C3 IMMATRICOLATA IL 10/04/2008', IDX).nome, 'Citroën');
  // Spazio: il catalogo dice «CFMOTO», l'avviso «CF Moto».
  assert.equal(marcaDa('CF Moto 800MT - vendita telematica', IDX).nome, 'CFMOTO');
  // Grafia alternativa curata in data/brand-aliases.json.
  assert.equal(marcaDa('AUTOVETTURA MARCA MERCEDES, MODELLO CLASSE B 170', IDX).nome, 'Mercedes-Benz');
});

test('il gruppo di parole piu\' lungo vince: «Moto Morini» non diventa «Moto»', () => {
  const r = marcaDa('Motociclo Moto Morini X-Cape targato FAxxxxx', IDX);
  assert.equal(r.nome, 'Moto Morini');
});

test('il rito incollato senza spazio non mangia la marca', () => {
  // Il portale concatena la frase di rito SENZA spazio: «MV AgustaPer visionare…».
  const r = marcaDa('Motociclo MV AgustaPer visionare la documentazione disponibile, si invitano le parti', IDX);
  assert.equal(r.nome, 'MV Agusta');
  assert.equal(descrizionePulita('Motociclo MV AgustaPer visionare la documentazione disponibile'), 'Motociclo MV Agusta');
});

test('quando la marca non c\'e\', tace: non la inventa', () => {
  // Casi veri: nessuno di questi nomina una marca del catalogo.
  for (const t of [
    'LOTTO AUTOCARRO TARGATO FN896DJ',
    'Vendita di beni appartenenti alla Liquidazione Giudiziale n. 491/2024 Tribunale di Roma',
    'Moto targata BDxxxxx, alimentazione a benzina',
    'Lotto unico composto da arredi e attrezzature varie',
  ]) {
    assert.equal(marcaDa(t, IDX), null, `non doveva riconoscere nulla in: ${t}`);
  }
});

test('le sigle di due lettere non si leggono: nella targa ce n\'e\' sempre una', () => {
  // «VENDITA QUAD TARGATO DR 45722» — quel DR e' la targa, non DR Automobiles. E' il motivo
  // per cui l'indice scarta le chiavi sotto le tre lettere.
  assert.equal(marcaDa('VENDITA QUAD TARGATO DR 45722', IDX), null);
  // Ma la stessa marca scritta per esteso si riconosce.
  assert.equal(marcaDa('Autoveicolo MARCA DR Automobiles targato GPxxxEN', IDX).nome, 'DR Automobiles');
});

test('i refusi del professionista restano non riconosciuti, e va bene cosi\'', () => {
  // Indovinarli vorrebbe dire un confronto sfocato, cioe' la porta dei falsi positivi che
  // brand-match documenta (Mars→Marshal). Meglio dichiarare «non riconosciuta».
  assert.equal(marcaDa('Automobile Wolkswagen Polo', IDX), null);
  assert.equal(marcaDa('Motociclo marca Royal Enfild modello Meteor 350', IDX), null);
});

test('il lotto cumulativo si marca, non si nasconde', () => {
  const cumulo = leggi({ id: 1, descLotto: 'N. 1433 Scooter e N. 11 E-bike - vendita telematica sulla piattaforma www.gobid.it n.33124' }, IDX, 'moto');
  assert.equal(cumulo.cumulativo, true);
  assert.equal(cumulo.piattaforma, 'gobid.it');
  const singolo = leggi({ id: 2, descLotto: 'Motociclo Piaggio Medley' }, IDX, 'moto');
  assert.equal(singolo.cumulativo, false);
  assert.equal(singolo.marca, 'Piaggio');
});

test('le due date della fonte finiscono nello stesso formato', () => {
  // Il PVP mescola ISO e giorno/mese/anno dentro lo stesso oggetto.
  assert.equal(aIso('2026-09-03'), '2026-09-03');
  assert.equal(aIso('08/01/2024'), '2024-01-08');
  assert.equal(aIso(''), null);
  assert.equal(aIso(null), null);
});

test('leggi() non porta con se\' i dati personali del referente', () => {
  const r = leggi({
    id: 7, descLotto: 'Motociclo Voge 300R', prezzoBaseAsta: 1200, dataVendita: '2026-10-01',
    indirizzo: { citta: 'Verona', provincia: 'Verona' }, tribunale: 'Tribunale di VERONA',
    soggetti: [{ nome: 'Mario', cognome: 'Rossi', cellulare: '3331234567', cf: 'RSSMRA80A01L781X' }],
  }, IDX, 'moto');
  const serializzato = JSON.stringify(r);
  for (const vietato of ['Mario', 'Rossi', '3331234567', 'RSSMRA80A01L781X', 'soggetti']) {
    assert.ok(!serializzato.includes(vietato), `il campo ${vietato} non deve uscire da leggi()`);
  }
  assert.equal(r.marca, 'Voge');
  assert.equal(r.provincia, 'Verona');
});
