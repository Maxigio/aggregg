'use strict';
// Ricerca Subito per ID del catalogo invece che a testo libero. Puro: niente rete.
const { test } = require('node:test');
const assert = require('node:assert');
const api = require('../backend/scrapers/subito-api');
const { risolviNodo } = require('../backend/scrapers/subito-nodo');
const buildPath = api._buildPath;
const riconosci = api._riconosci;
const faTitolo = api._faTitolo;

const qp = path => Object.fromEntries(new URLSearchParams(path.split('?')[1] || ''));

const NODO_AUTO = { tipo: 'auto', marcaId: '000083', famigliaIds: ['001704'], generazioni: [{ id: '004426', nome: 'Giulia (2016)' }] };
const NODO_MOTO = { tipo: 'moto', marcaId: '000014', famigliaIds: ['000237'], generazioni: [{ id: '000237', nome: 'Bonneville' }] };

// ── il path ──────────────────────────────────────────────────────────────────
test('auto: nodo risolto → cb/cm, e il testo libero sparisce', () => {
  const p = qp(buildPath({ tipo: 'auto', marca: 'Alfa Romeo', modello: 'Giulia', subitoNodo: NODO_AUTO }, 0));
  assert.strictEqual(p.cb, '000083');
  assert.strictEqual(p.cm, '001704');
  assert.ok(!('q' in p), 'q e cb/cm insieme escluderebbero chi scrive il titolo diverso');
});

test('moto: i parametri sono bb/bm, NON cb/cm (sbagliarli da\' zero risultati)', () => {
  const p = qp(buildPath({ tipo: 'moto', marca: 'Triumph', modello: 'Bonneville', subitoNodo: NODO_MOTO }, 0));
  assert.strictEqual(p.bb, '000014');
  assert.strictEqual(p.bm, '000237');
  assert.ok(!('cb' in p) && !('cm' in p));
});

test('Auto e Moto: piu famiglie → testo libero, nessun id scelto a caso', () => {
  const due = ['002022', '001531'];
  for (const tipo of ['auto', 'moto']) {
    const p = qp(buildPath({ tipo, marca: 'Ford', modello: 'Tourneo Custom',
      subitoNodo: { marcaId: '000039', famigliaIds: due } }, 0));
    assert.strictEqual(p.q, 'Ford Tourneo Custom');
    assert.ok(!('cb' in p) && !('cm' in p) && !('bb' in p) && !('bm' in p));
  }
});

test('Dorsoduro specifica usa il suo ID; Dorsoduro generica e Auto ambigua usano testo', () => {
  const specifica = qp(buildPath({ tipo: 'moto', marca: 'Aprilia', modello: 'Dorsoduro 750',
    subitoNodo: risolviNodo('moto', 'Aprilia', 'Dorsoduro 750') }, 0));
  assert.strictEqual(specifica.bm, '001471');
  assert.ok(!('q' in specifica));

  const generica = qp(buildPath({ tipo: 'moto', marca: 'Aprilia', modello: 'Dorsoduro',
    subitoNodo: risolviNodo('moto', 'Aprilia', 'Dorsoduro') }, 0));
  assert.strictEqual(generica.q, 'Aprilia Dorsoduro');
  assert.ok(!('bm' in generica));

  const auto = qp(buildPath({ tipo: 'auto', marca: 'Ford', modello: 'Tourneo Custom',
    subitoNodo: risolviNodo('auto', 'Ford', 'Tourneo Custom'),
    subitoVersioneTesto: 'Titanium' }, 0));
  assert.strictEqual(auto.q, 'Ford Tourneo Custom Titanium');
  assert.ok(!('cm' in auto));
});

test('la passata di recupero chiede il segnaposto "Altro modello"', () => {
  const p = qp(buildPath({ tipo: 'auto', subitoNodo: NODO_AUTO, subitoSoloNonDichiarati: true }, 0));
  assert.strictEqual(p.cm, '000000');
  assert.strictEqual(p.cb, '000083');
});

test('senza nodo si torna al testo libero, come prima', () => {
  const p = qp(buildPath({ tipo: 'auto', marca: 'Alfa Romeo', modello: 'Giulia' }, 0));
  assert.strictEqual(p.q, 'Alfa Romeo Giulia');
  assert.ok(!('cb' in p));
});

test('i filtri nativi restano anche cercando per id', () => {
  const p = qp(buildPath({ tipo: 'auto', subitoNodo: NODO_AUTO, regione: 'lombardia', prezzoMax: 20000, annoMin: 2018 }, 0));
  assert.strictEqual(p.r, '4');
  assert.strictEqual(p.pe, '20000');
  assert.strictEqual(p.ys, '2018');
  assert.strictEqual(p.cm, '001704');
});

// ── il riconoscimento dell'annuncio ──────────────────────────────────────────
const ann = (marca, modello, versione, titolo = 'un annuncio') => ({
  subject: titolo,
  features: { 0: { uri: '/car', values: [
    { key: marca, value: 'M', label: 'Marca' },
    ...(modello ? [{ key: modello, value: 'Mo', label: 'Modello' }] : []),
    ...(versione ? [{ key: versione, value: 'V', label: 'Versione' }] : []),
  ] } },
});
const OPT = { generazioni: new Set(['004426']), titoloCombacia: faTitolo('Giulia') };

test('annuncio della generazione giusta con versione → esatto', () => {
  assert.strictEqual(riconosci(ann('000083', '004426', '126014'), NODO_AUTO, OPT), 'esatto');
});

test('stessa generazione ma versione non dichiarata → si tiene, marcato', () => {
  assert.strictEqual(riconosci(ann('000083', '004426', '000000'), NODO_AUTO, OPT), 'senza-versione');
});

test('altra generazione della stessa marca → scartato', () => {
  assert.strictEqual(riconosci(ann('000083', '000349', '111'), NODO_AUTO, OPT), null);
});

test('altra marca → scartato sempre', () => {
  assert.strictEqual(riconosci(ann('000008', '004426', '126014'), NODO_AUTO, OPT), null);
});

test('modello non dichiarato: si tiene SOLO se il titolo lo nomina, e resta marcato', () => {
  assert.strictEqual(riconosci(ann('000083', '000000', null, 'Alfa Romeo Giulia 2.2 del 2019'), NODO_AUTO, OPT), 'senza-modello');
  assert.strictEqual(riconosci(ann('000083', '000000', null, 'Alfa Romeo 159 sw'), NODO_AUTO, OPT), null);
});

test('senza nodo non si filtra niente: il testo libero decide da solo', () => {
  assert.strictEqual(riconosci(ann('000008', '999', null), null, OPT), 'testo-libero');
});

// ── il titolo ────────────────────────────────────────────────────────────────
test('il titolo combacia per PAROLE INTERE, non per pezzi di parola', () => {
  const f = faTitolo('SV 650');
  assert.ok(f({ subject: 'Suzuki SV 650 del 2019' }));
  assert.ok(f({ subject: 'suzuki sv-650' }), 'il trattino separa come lo spazio');
  assert.ok(!f({ subject: 'Suzuki SV 6500' }), '650 non deve agganciare 6500');
  assert.ok(!f({ subject: 'Suzuki Gladius 650' }), 'manca "sv"');
});

test('titolo con accenti e maiuscole', () => {
  assert.ok(faTitolo('Mulhacén 659')({ subject: 'DERBI MULHACEN 659 CAFE' }));
});

test('modello vuoto → nessun criterio, e il recupero non parte', () => {
  assert.strictEqual(faTitolo(''), null);
  assert.strictEqual(faTitolo(null), null);
});
