'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { risolviNodo, livelliAnnuncio, dichiarato } = require('../backend/scrapers/subito-nodo');

// Indice finto: la forma e' quella vera, i dati sono gli id veri dei sei del banco.
const IX = {
  auto: {
    'ALFA ROMEO': { id: '000083', famiglie: [
      { id: '001704', nome: 'Giulia', gen: [{ id: '004426', nome: 'Giulia (2016)' }] },
      { id: '000348', nome: '159', gen: [{ id: '000349', nome: '159' }] },
    ] },
    AUDI: { id: '000161', famiglie: [
      { id: '001508', nome: '80/90/4000/Cabrio', gen: [{ id: '000159', nome: '80/90/Cabrio' }] },
      { id: '001509', nome: 'A4', gen: [{ id: '000160', nome: 'A4' }] },
    ] },
    FORD: { id: '000039', famiglie: [
      { id: '000202', nome: 'Ka', gen: [{ id: '000203', nome: 'Ka' }] },
      { id: '001710', nome: 'Ka+', gen: [{ id: '001711', nome: 'Ka+' }] },
      { id: '002022', nome: 'Tourneo Custom', gen: [{ id: '002023', nome: 'Tourneo Custom' }] },
      { id: '001531', nome: 'Tourneo Custom', gen: [{ id: '001532', nome: 'Tourneo Custom 2' }] },
    ] },
    VOLKSWAGEN: { id: '000101', famiglie: [
      { id: '000467', nome: 'Passat', gen: [
        { id: '000396', nome: 'Passat 1ª/2ª/3ª/4ª' }, { id: '002881', nome: 'Passat 5ª serie' },
      ] },
    ] },
  },
  moto: {
    Suzuki: { id: '000013', famiglie: [{ id: '000213', nome: 'SV 650', gen: [{ id: '000213', nome: 'SV 650' }] }] },
    Triumph: { id: '000014', famiglie: [{ id: '000237', nome: 'Bonneville', gen: [{ id: '000237', nome: 'Bonneville' }] }] },
  },
};
const r = (t, ma, mo) => risolviNodo(t, ma, mo, { indice: IX });

test('auto: marca + famiglia → gli id per cb e cm', () => {
  const n = r('auto', 'Alfa Romeo', 'Giulia');
  assert.equal(n.marcaId, '000083');
  assert.equal(n.famigliaId, '001704');
  assert.equal(n.come, 'famiglia');
  assert.deepEqual(n.generazioni.map(g => g.id), ['004426']);
});

test('la marca combacia a prescindere da maiuscole e spazi', () => {
  for (const scritta of ['ALFA ROMEO', 'alfa romeo', 'Alfa-Romeo']) {
    assert.equal(r('auto', scritta, 'Giulia').marcaId, '000083', scritta);
  }
});

test('moto: il livello sotto la marca e\' il MODELLO, non una famiglia', () => {
  const n = r('moto', 'Suzuki', 'SV 650');
  assert.equal(n.marcaId, '000013');
  assert.equal(n.famigliaId, '000213');
  assert.equal(n.come, 'famiglia');
});

test('"SV650" senza spazio aggancia "SV 650" (la classe di errore che torna sempre)', () => {
  assert.equal(r('moto', 'Suzuki', 'SV650').famigliaId, '000213');
});

test('il testo che nomina una GENERAZIONE risolve la famiglia e restringe a quella', () => {
  const n = r('auto', 'Volkswagen', 'Passat 5ª serie');
  assert.equal(n.famigliaId, '000467');
  assert.equal(n.come, 'generazione');
  assert.deepEqual(n.generazioni.map(g => g.id), ['002881']);
});

test('la famiglia intera porta TUTTE le sue generazioni', () => {
  const n = r('auto', 'Volkswagen', 'Passat');
  assert.equal(n.generazioni.length, 2);
});

test('modello sconosciuto → resta la marca, mai un id a caso', () => {
  const n = r('auto', 'Alfa Romeo', 'Modello Che Non Esiste');
  assert.equal(n.marcaId, '000083');
  assert.equal(n.famigliaId, null);
  assert.equal(n.come, 'marca');
});

test('marca sconosciuta → null, chi chiama resta a testo libero', () => {
  assert.equal(r('auto', 'Marca Inventata', 'Giulia'), null);
});

test('senza modello si cerca tutta la marca', () => {
  const n = r('moto', 'Triumph', '');
  assert.equal(n.marcaId, '000014');
  assert.equal(n.come, 'marca');
});

test('il PIU\' distingue: "Ka" non deve diventare "Ka+" (norm li appiattisce)', () => {
  assert.deepEqual(r('auto', 'Ford', 'Ka').famigliaIds, ['000202']);
  assert.deepEqual(r('auto', 'Ford', 'Ka+').famigliaIds, ['001710']);
});

test('nome doppio nel catalogo → si portano TUTTE le famiglie, non una a caso', () => {
  const n = r('auto', 'Ford', 'Tourneo Custom');
  assert.deepEqual(n.famigliaIds, ['002022', '001531']);
  assert.match(n.come, /nome doppio/);
  assert.equal(n.generazioni.length, 2, 'le generazioni di entrambe');
});

test('"80" e\' una parola dentro "80/90/4000/Cabrio" — il caso che oggi non trova nulla', () => {
  const n = r('auto', 'Audi', '80');
  assert.deepEqual(n.famigliaIds, ['001508']);
  assert.equal(n.come, 'famiglia');
});

test('un prefisso che aggancia piu famiglie le porta TUTTE, e lo dichiara', () => {
  const ix = { auto: { X: { id: '1', famiglie: [
    { id: 'a', nome: 'Serie 5 Berlina', gen: [{ id: 'a1', nome: 'a1' }] },
    { id: 'b', nome: 'Serie 5 Touring', gen: [{ id: 'b1', nome: 'b1' }] },
    { id: 'c', nome: 'Altro', gen: [] },
  ] } }, moto: {} };
  const n = risolviNodo('auto', 'X', 'Serie', { indice: ix });
  assert.deepEqual(n.famigliaIds, ['a', 'b']);
  assert.match(n.come, /prefisso \(2 famiglie\)/);
  assert.equal(n.generazioni.length, 2);
});

// ── i livelli dichiarati dall'annuncio ───────────────────────────────────────
const annuncio = valori => ({ features: { 0: { uri: '/bike', values: valori } } });

test('legge marca/modello/versione dichiarati dall\'annuncio', () => {
  const l = livelliAnnuncio(annuncio([
    { key: '000015', value: 'Yamaha', level: 0, label: 'Marca' },
    { key: '002473', value: 'MT-07', level: 1, label: 'Modello' },
    { key: '005267', value: 'ABS', level: 2, label: 'Versione' },
  ]));
  assert.equal(l.marca.id, '000015');
  assert.equal(l.modello.nome, 'MT-07');
  assert.equal(l.versione.nome, 'ABS');
});

test('il segnaposto versione ha level 0 ma NON deve diventare la marca', () => {
  // Questo e' il dato vero di Subito: level:0 con label:"Versione".
  const l = livelliAnnuncio(annuncio([
    { key: '000013', value: 'Suzuki', level: 0, label: 'Marca' },
    { key: '000213', value: 'SV 650', level: 1, label: 'Modello' },
    { key: '000000', value: 'Altro allestimento', level: 0, label: 'Versione' },
  ]));
  assert.equal(l.marca.nome, 'Suzuki', 'la marca non deve essere sovrascritta dal segnaposto');
  assert.equal(l.modello.id, '000213');
  assert.equal(l.versione.id, '000000');
  assert.equal(dichiarato(l.versione), false);
  assert.equal(dichiarato(l.modello), true);
});

test('annuncio senza pack non esplode', () => {
  assert.deepEqual(livelliAnnuncio({}), { marca: null, modello: null, versione: null });
  assert.deepEqual(livelliAnnuncio(null), { marca: null, modello: null, versione: null });
});

test('legge anche il pack /car (auto), non solo /bike', () => {
  const l = livelliAnnuncio({ features: { 0: { uri: '/car', values: [{ key: '000083', value: 'ALFA ROMEO', label: 'Marca' }] } } });
  assert.equal(l.marca.id, '000083');
});
