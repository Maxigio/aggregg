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

test('giudizio: posizionamento coerente con la distribuzione reale', () => {
  assert.strictEqual(liq.giudizio(18).classe, 'alta');
  assert.strictEqual(liq.giudizio(8).classe, 'media');
  assert.strictEqual(liq.giudizio(4).classe, 'bassa');
  assert.strictEqual(liq.giudizio(0.1).classe, 'ferma');
  assert.strictEqual(liq.giudizio(null), null);
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
