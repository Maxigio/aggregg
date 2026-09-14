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

test('le parole comuni dell\'avviso non diventano la marca', () => {
  // Acura, Quadro, Nero e Stock sono marche VERE del catalogo e insieme parole ordinarie
  // dell'avviso: sono i casi veri misurati in magazzino, dove la marca veniva inventata dal
  // corpo del testo (la marca giusta, «Kymco», qui e' scritta «KIMCO» e resta irriconoscibile).
  const idx = creaIndice(['Acura', 'Fiat'], ['Quadro', 'Nero', 'Stock', 'Kymco']);
  // «A CURA» incollato fa «acura»: una parola di UNA lettera non e' un pezzo di marca.
  assert.equal(marcaDa('AUTOVETTURA MG TF CABRIOLET TARGATA CY, VENDITA A CURA DEL CUSTODE', idx), null);
  assert.equal(marcaDa('MOTOVEICOLO KIMCO AGILITY, KM. 28.900 COME DA QUADRO DI ACCENSIONE', idx), null);
  assert.equal(marcaDa('Ciclomotore APE 50 a tre ruote, carrozzeria di colore nero', idx), null);
  assert.equal(marcaDa('Lotto 8: Stock composto da scooter e ciclomotore', idx), null);
  // La marca vera, nello stesso testo, si legge lo stesso.
  assert.equal(marcaDa('Autovettura FIAT Panda, km rilevati da quadro di accensione', idx).nome, 'Fiat');
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

test('un veicolo solo non diventa un cumulo per via di una parola', () => {
  // Casi veri dal magazzino: la categoria DA SOLA non conta i beni. «Scooter» e' invariante, e
  // «veicoli»/«autovetture» stanno anche nella chiusa di rito e nel link del gestore. Chi spunta
  // «solo veicoli singoli» perdeva proprio questi.
  const cumulativo = (d) => leggi({ id: 1, descLotto: d }, IDX, 'moto').cumulativo;
  assert.equal(cumulativo('Scooter X-MAX Yamaha 400 targato EF38287 marciante e revisionato'), false);
  assert.equal(cumulativo('AUTOMEZZI Toyota Yaris FM681NV anno 2017 valore 8.500,00'), false);
  assert.equal(cumulativo('01 AUTOVETTURA AUDI A3 TARGATA DH923XK. IN ALLEGATO CONDIZIONI DI VENDITA VEICOLI'), false);
  // Nell'URL ci sono le categorie del portale, non i beni del lotto.
  assert.equal(cumulativo('AUTOVETTURA LANCIA Y. VENDITA AL LINK: https://www.spazioaste.it/Aste/Detail/S1049805-Autovetture-e-Autocarri-Lancia-Y'), false);
  // Ma la seconda categoria, dopo la congiunzione o l'elenco, resta un cumulo vero.
  assert.equal(cumulativo('Lotto 8: Stock composto da scooter e ciclomotore provenienti da istituto di bellezza'), true);
  assert.equal(cumulativo('Autovetture AUDI, FORD, CITROEN; autocarri FIAT, FORD; motociclo SYM Joymax Z+ 300'), true);
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
