'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ms = require('../backend/scrapers/moto-specs');
const { matchMotoModels } = require('../backend/scheda-veicolo-route');

test('parseMotoSpecs: raggruppa per sezione del sito, pulisce imperiale, salta "-"', () => {
  const html = '<html><head><title>2020 Yamaha MT Technical Specifications</title></head><body>'
    + '<table class="content_text">'
    + '<tr><td class="spec_title">Yamaha MT General Information</td></tr>'
    + '<tr><td>Brand:</td><td>Yamaha</td></tr>'
    + '<tr><td>Category</td><td>Naked</td></tr></table>'
    + '<table class="content_text">'
    + '<tr><td class="spec_title">Yamaha MT Engine and Transmission Technical Data</td></tr>'
    + '<tr><td>Engine size - Displacement</td><td>689.00 ccm (42.04 cubic inches)</td></tr>'
    + '<tr><td>Gearbox</td><td>6-speed</td></tr>'
    + '<tr><td>Exhaust system</td><td>-</td></tr></table>'
    + '</body></html>';
  const { head, title, groups } = ms.parseMotoSpecs(html);
  assert.strictEqual(head.brand, 'Yamaha');
  assert.strictEqual(title, '2020 Yamaha MT');
  const motore = groups.find(g => g.title === 'Motore e trasmissione');
  assert.ok(motore, 'gruppo Motore e trasmissione presente');
  assert.deepStrictEqual(motore.rows[0], { k: 'Engine size - Displacement', v: '689.00 ccm' });   // strip " (42.04 cubic inches)"
  assert.ok(motore.rows.some(r => r.k === 'Gearbox' && r.v === '6-speed'));
  assert.ok(!motore.rows.some(r => r.k === 'Exhaust system'));   // "-" → saltato
  assert.ok(!groups.some(g => g.rows.some(r => r.k === 'Brand')));   // identità non nei gruppi
});

test('cleanVal: toglie parentesi imperiali, tiene metrico e parentesi metriche', () => {
  assert.strictEqual(ms.cleanVal('1,460 mm (57.5 inches)'), '1,460 mm');
  assert.strictEqual(ms.cleanVal('196.0 kg (432.1 pounds)'), '196.0 kg');
  assert.strictEqual(ms.cleanVal('73.76 HP (53.8 kW) @ 9000 RPM'), '73.76 HP (53.8 kW) @ 9000 RPM');
});

test('prettyMoto: sigle/cilindrate maiuscole, parole capitalizzate', () => {
  assert.strictEqual(ms.prettyMoto('mt-07-abs'), 'MT-07-ABS');
  assert.strictEqual(ms.prettyMoto('moto-cage'), 'Moto-Cage');
  assert.strictEqual(ms.prettyMoto('mt07tr'), 'MT07TR');
});

test('matchMotoModels: base + varianti, boundary non-numerico', () => {
  const models = {
    mt07: { label: 'MT-07', items: [[2023, 'x']] },
    mt07abs: { label: 'MT-07-ABS', items: [[2015, 'y']] },
    mt07tr: { label: 'MT07TR', items: [[2020, 'z']] },
    mt09: { label: 'MT-09', items: [[2023, 'w']] },
    r1: { label: 'R1', items: [[2023, 'a']] },
    r15: { label: 'R15', items: [[2023, 'b']] },
  };
  const keys = matchMotoModels(models, 'MT-07').map(m => m.k).sort();
  assert.deepStrictEqual(keys, ['mt07', 'mt07abs', 'mt07tr']);   // no mt09
  // "R1" NON deve pescare "R15" (dopo il prefisso c'è una cifra)
  assert.deepStrictEqual(matchMotoModels(models, 'R1').map(m => m.k), ['r1']);
});
