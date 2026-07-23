'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const vs = require('../backend/scrapers/vehicle-specs');

test('parseBrandList: estrae nome + slug dai link -brand-', () => {
  const html = '<a href="/en/volkswagen-brand-80">Volkswagen</a><a href="/en/altro">x</a>';
  assert.deepStrictEqual(vs.parseBrandList(html), [{ name: 'Volkswagen', slug: 'volkswagen-brand-80' }]);
});

test('parseModelList: link -model- (nome grezzo con anni)', () => {
  const html = '<a href="/en/volkswagen-golf-model-896">Golf 1974 -</a>';
  assert.deepStrictEqual(vs.parseModelList(html), [{ name: 'Golf 1974 -', slug: 'volkswagen-golf-model-896' }]);
});

test('parseGenerationList: nome vero + anni dal contesto della riga', () => {
  const html = '<table><tr><td><a href="/en/volkswagen-golf-vii-5-door-generation-3936">Volkswagen Golf VII (5-door)</a> 2012 - 2020 Hatchback Power: from 85</td></tr></table>';
  const gens = vs.parseGenerationList(html);
  assert.strictEqual(gens.length, 1);
  assert.strictEqual(gens[0].name, 'Volkswagen Golf VII (5-door)');
  assert.deepStrictEqual(gens[0].years, [2012, 2020]);
});

test('parseTrimList: label/hp/fuel dallo slug, prefisso generazione', () => {
  const gen = 'volkswagen-golf-vii-5-door-generation-3936';
  const html = '<a href="/en/volkswagen-golf-vii-5-door-2.0-tdi-150hp-dsg-17896">rumore</a>'
    + '<a href="/en/altra-golf-1.0-tsi-110hp-99999">fuori</a>';
  const trims = vs.parseTrimList(html, gen);
  assert.strictEqual(trims.length, 1);   // scarta il trim di un'altra generazione
  assert.strictEqual(trims[0].label, '2.0 TDI 150 Hp DSG');
  assert.strictEqual(trims[0].hp, 150);
  assert.strictEqual(trims[0].fuel, 'Diesel');
});

test('parseTrimSpecs: classifica per contenuto + pulisce le conversioni imperiali', () => {
  const html = '<table class="cardetailsout"><tr><th>Brand</th><td>Volkswagen</td></tr>'
    + '<tr><th>Engine displacement</th><td>1968 cm3 120.09 cu. in.</td></tr>'
    + '<tr><th>Length</th><td>4255 mm 167.52 in.</td></tr></table>';
  const { head, groups } = vs.parseTrimSpecs(html);
  assert.strictEqual(head.brand, 'Volkswagen');
  const motore = groups.find(g => g.title === 'Motore');
  assert.ok(motore, 'gruppo Motore presente');
  assert.deepStrictEqual(motore.rows[0], { k: 'Engine displacement', v: '1968 cm3' });   // via " 120.09 cu. in."
  const dim = groups.find(g => g.title === 'Dimensioni');
  assert.deepStrictEqual(dim.rows[0], { k: 'Length', v: '4255 mm' });
  assert.ok(!groups.some(g => g.rows.some(r => r.k === 'Brand')));   // identità NON nei gruppi
});

test('prettyLabel: normalizza sigle e potenza', () => {
  assert.strictEqual(vs.prettyLabel('r-2.0-tsi-300hp-4motion-dsg'), 'R 2.0 TSI 300 Hp 4MOTION DSG');
});
