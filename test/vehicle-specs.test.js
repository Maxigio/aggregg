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

test('slugOf: toglie il prefisso lingua (/en/ e /it/), non intacca slug senza lingua', () => {
  assert.strictEqual(vs.slugOf('/it/volkswagen-golf-viii-variant-facelift-2024-generation-9900'), 'volkswagen-golf-viii-variant-facelift-2024-generation-9900');   // regressione: prima restava "it/…" → URL /it/it/… → 404
  assert.strictEqual(vs.slugOf('/en/bmw-3-series-model-953'), 'bmw-3-series-model-953');
  assert.strictEqual(vs.slugOf('https://www.auto-data.net/it/bmw-3-series-coupe-e30-318i-105hp-46133'), 'bmw-3-series-coupe-e30-318i-105hp-46133');
  assert.strictEqual(vs.slugOf('/volkswagen-golf-model-896'), 'volkswagen-golf-model-896');   // niente prefisso lingua → invariato
  assert.strictEqual(vs.slugOf('/it/audi-a4-model-501/'), 'audi-a4-model-501');   // slash finale via
});

test('parseTrimSpecs: pagina /it/ — identità italiana esclusa, gruppi bilingue, cleanVal range imperiale', () => {
  const html = '<table class="cardetailsout">'
    + '<tr><th>Marca</th><td>BMW</td></tr>'
    + '<tr><th>Modello</th><td>Serie 3</td></tr>'
    + '<tr><th>Cilindrata</th><td>1998 cm3 121.93 cu. in.</td></tr>'
    + '<tr><th>Consumo di carburante combinato (WLTP)</th><td>6.4-7.2 l/100 km 36.8 - 32.7 US mpg 44.1 - 39.2 UK mpg</td></tr>'
    + '<tr><th>Lunghezza</th><td>4713 mm 185.55 in.</td></tr>'
    + '<tr><th>Freni anteriori</th><td>Dischi ventilati</td></tr></table>';
  const { head, groups } = vs.parseTrimSpecs(html);
  assert.strictEqual(head.brand, 'BMW');
  assert.strictEqual(head.model, 'Serie 3');
  assert.ok(!groups.some(g => g.rows.some(r => r.k === 'Marca' || r.k === 'Modello')), 'identità NON nei gruppi');
  const motore = groups.find(g => g.title === 'Motore');
  assert.deepStrictEqual(motore.rows.find(r => r.k === 'Cilindrata'), { k: 'Cilindrata', v: '1998 cm3' });   // via "121.93 cu. in."
  const consumi = groups.find(g => g.title === 'Consumi ed emissioni');
  assert.deepStrictEqual(consumi.rows[0], { k: 'Consumo di carburante combinato (WLTP)', v: '6.4-7.2 l/100 km' });   // via "36.8 - 32.7 US mpg…"
  assert.ok(groups.find(g => g.title === 'Dimensioni').rows.some(r => r.k === 'Lunghezza' && r.v === '4713 mm'));
  assert.ok(groups.find(g => g.title === 'Trasmissione, freni, sospensioni').rows.some(r => r.k === 'Freni anteriori'));
});

test('parseSearchWords: trim/model, anno+hp fuori label, slug con punti, fuel ibrida (no baco d-)', () => {
  const body = 'results?search=x###0|bmw-3-series-coupe-e30-318i-105hp-46133###'
    + '<img src="/images/f69/x_thumb.jpg" />BMW 3 Series Coupe (E30) 318i (105 Hp) (1982 - 1986) |volkswagen-golf-vii-5-door-e-golf-24.2-kwh-115hp-44054###'
    + '<img src="//cdn/y.jpg" />Volkswagen Golf VII (5-door) e-Golf 24.2 kWh (115 Hp) (2014 - 2016) |lexus-ct-i-200h-136hp-hybrid-e-cvt-17492###'
    + '<img src="/l.jpg" />Lexus CT I 200h (136 Hp) Hybrid e-CVT (2011 - 2014) |audi-a4-model-501###'
    + '<img src="/z.jpg" />Audi A4';
  const r = vs.parseSearchWords(body);
  assert.strictEqual(r.length, 4);
  assert.strictEqual(r[0].kind, 'trim');
  assert.strictEqual(r[0].label, 'BMW 3 Series Coupe (E30) 318i');   // hp/anno tolti dalla label
  assert.strictEqual(r[0].year, 1982);
  assert.strictEqual(r[0].yearRange, '1982–1986');
  assert.strictEqual(r[0].hp, 105);
  assert.strictEqual(r[1].slug, 'volkswagen-golf-vii-5-door-e-golf-24.2-kwh-115hp-44054');   // punto preservato
  assert.strictEqual(r[1].fuel, 'Elettrica');
  assert.strictEqual(r[2].fuel, 'Ibrida');   // "hybrid-e-cvt" NON è più Diesel (fix del pattern d-)
  assert.strictEqual(r[3].kind, 'model');
  assert.strictEqual(r[3].label, 'Audi A4');
});
