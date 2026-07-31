'use strict';
// Liquidità di modello (ACI Autoritratto). I dati stanno in data/liquidita-modelli.json,
// file versionato e deterministico, quindi si testa sul dato vero.
const { test } = require('node:test');
const assert = require('node:assert');
const liq = require('../backend/liquidita');

test('modello noto: parco, passaggi annui e tasso di ricambio', () => {
  const r = liq.cerca('Fiat', 'Panda', 'auto');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parco, 3363629);
  assert.strictEqual(r.trasferimenti, 260409);
  assert.strictEqual(r.ricambio, 7.7);
  assert.ok(r.trasferimentiTotali > r.trasferimenti, 'i totali includono i passaggi intermedi');
});

test('nomi di modello NUMERICI risolti (erano il baco del parser xlsx)', () => {
  for (const [ma, mo] of [['Fiat', '500'], ['Porsche', '911'], ['Peugeot', '208']]) {
    const r = liq.cerca(ma, mo, 'auto');
    assert.ok(r && r.ok && r.parco > 0, `${ma} ${mo} deve avere il parco`);
  }
});

test('variante non a catalogo ACI → ripiego sul modello base, dichiarato', () => {
  const g = liq.cerca('Volkswagen', 'Golf GTI', 'auto');
  assert.strictEqual(g.ok, true);
  assert.strictEqual(g.viaPadre, 'GOLF');                 // l'utente deve saperlo
  assert.strictEqual(g.parco, liq.cerca('Volkswagen', 'Golf', 'auto').parco);
});

test('moto: si dice "non disponibile", non si stima', () => {
  const r = liq.cerca('Yamaha', 'MT-07', 'moto');
  assert.strictEqual(r.ok, false);
  assert.match(r.motivo, /moto/i);
  assert.match(r.spiegazione, /cilindrata e provincia/i);
});

test('modello sconosciuto → null, nessun numero inventato', () => {
  assert.strictEqual(liq.cerca('Marca Inventata', 'Modello Fantasma', 'auto'), null);
  assert.strictEqual(liq.cerca('', '', 'auto'), null);
});

test('nessun giudizio sulla vendibilita: si servono i numeri, non i pareri', () => {
  // C'era una funzione che dal tasso di ricambio tirava fuori "si rivende in fretta" o
  // "veicolo da collezione o fuori mercato". Erano opinioni nostre servite accanto a un
  // dato ACI, con la sua stessa aria di autorita'. Questo test impedisce che tornino.
  assert.strictEqual(typeof liq.giudizio, 'undefined');
  const r = liq.cerca('Fiat', 'Panda', 'auto');
  assert.ok(r && r.ok, 'la Panda deve esserci');
  assert.strictEqual(r.giudizio, undefined, 'il dato non deve portare un giudizio');
  assert.ok(typeof r.ricambio === 'number', 'il numero invece resta: e un fatto');
});

test('la fonte e l\'anno viaggiano col dato (CC-BY: attribuzione obbligatoria)', () => {
  const r = liq.cerca('Fiat', 'Panda', 'auto');
  assert.match(r.fonte, /ACI Autoritratto/);
  assert.strictEqual(r.anno, 2025);
  assert.match(r.nota, /aggregato/i);
});

test('copertura: il dato copre la maggior parte del parco italiano in volume', () => {
  const tot = Object.values(liq.dati.modelli).reduce((a, m) => a + (m.parco || 0), 0);
  assert.ok(tot > 40e6, `parco nazionale coperto: ${tot}`);
  assert.ok(Object.keys(liq.dati.modelli).length > 1500);
});

/**
 * REGRESSIONE. I nomi delle marche non combaciano fra le due fonti: il catalogo dice
 * "Mercedes-Benz", l'Autoritratto dice "MERCEDES". La chiave non agganciava e il pannello
 * rispondeva "non disponibile" su 1.512.332 veicoli di parco — e la catena passa proprio i
 * nomi lunghi (/api/brands serve le chiavi di models.json).
 */
test('marche scritte diversamente dalle due fonti: si traducono, non si perdono', () => {
  const r = liq.cerca('Mercedes-Benz', 'Classe A', 'auto');
  assert.ok(r && r.ok, 'col nome lungo del catalogo il dato deve arrivare');
  assert.ok(r.parco > 0);
  // Col nome corto il risultato e' lo STESSO: e' la stessa marca.
  assert.deepStrictEqual(liq.cerca('Mercedes', 'Classe A', 'auto'), r);
  assert.ok(liq.cerca('DS Automobiles', 'DS3', 'auto').ok);
  assert.ok(liq.cerca('DR Automobiles', 'DR3', 'auto').ok);
});

test('la traduzione della marca e STRETTA: prefisso di parole intere, mai somiglianza', () => {
  // chi combaciava gia' non cambia
  assert.strictEqual(liq.risolviMarca('Fiat'), 'fiat');
  assert.strictEqual(liq.risolviMarca('Alfa Romeo'), 'alfa romeo');
  assert.strictEqual(liq.risolviMarca('Land Rover'), 'land rover');
  // Alpina nell'Autoritratto non c'e': si dice null, non si ripiega su una marca vicina.
  assert.strictEqual(liq.risolviMarca('Alpina'), null);
  assert.strictEqual(liq.risolviMarca('Marca Inventata'), null);
  assert.strictEqual(liq.risolviMarca(''), null);
});
