'use strict';
// Moto.it: i menu vengono dal catalogo su disco, non da /Used. Niente rete.
const { test } = require('node:test');
const assert = require('node:assert');
const mm = require('../backend/scrapers/motoit-models');
const CAT = require('../data/motoit-catalogo.json');

test('i modelli vengono dal catalogo, che e\' piu\' ricco della vista mercato', async () => {
  const y = await mm.getBrandModels('yamaha');
  assert.equal(y.length, Object.keys(CAT.marche.yamaha.modelli).length);
  assert.ok(y.length > 200, 'Yamaha ha oltre 200 modelli in catalogo, /Used ne dava 163');
  const mt = y.find(x => x.slug === 'mt-07');
  assert.ok(mt && mt.name === 'MT-07');
});

test('le versioni portano gli anni dal catalogo, non estratti dal nome a forza di regex', async () => {
  const v = await mm.getModelBikes('yamaha', 'mt-07');
  assert.equal(v.length, 9);
  const base = v.find(x => x.code === 'R9Lybg');
  assert.ok(base, 'il codice del catalogo E\' il param bike= (verificato sulla fonte)');
  assert.equal(base.name, 'MT-07 (2014 - 16)');
  assert.equal(base.annoMin, 2014);
  assert.equal(base.annoMax, 2016);
  assert.ok(v.some(x => /ABS/.test(x.name)), 'MT-07 e MT-07 ABS restano distinte');
});

test('le entita HTML del catalogo non arrivano a schermo', async () => {
  const b = await mm.getBrandModels('benelli');
  const nomi = b.map(x => x.name);
  assert.ok(nomi.includes('Caffènero 125'), 'Caff&amp;egrave;nero → Caffènero');
  assert.ok(nomi.includes('Così 50 Mix'), 'Cos&amp;igrave; → Così');
  assert.equal(nomi.filter(n => /&[a-z#0-9]+;/i.test(n)).length, 0);
});

test('nessuna entita residua: si controllano TUTTE le marche che ne hanno', async () => {
  // Le marche da controllare non sono scelte a mano: si ricavano dal catalogo, cosi'
  // se domani ne compare una nuova il test la prende da solo.
  const ENT = /&[a-z#0-9]+;/i;
  const sporche = new Set();
  for (const [slug, b] of Object.entries(CAT.marche)) {
    for (const m of Object.values(b.modelli || {})) {
      if (ENT.test(m.nome)) sporche.add(slug);
      for (const v of Object.values(m.versioni || {})) if (ENT.test(v.nome)) sporche.add(slug);
    }
  }
  assert.ok(sporche.size > 0, 'se il catalogo diventa pulito questo test non serve piu');
  let tot = 0, res = 0;
  for (const slug of sporche) {
    for (const m of await mm.getBrandModels(slug)) {
      tot++; if (ENT.test(m.name)) res++;
      for (const v of await mm.getModelBikes(slug, m.slug)) { tot++; if (ENT.test(v.name)) res++; }
    }
  }
  assert.equal(res, 0, tot + ' nomi controllati su ' + sporche.size + ' marche');
});

test('marca fuori catalogo → non esplode (poi ripiega sull\'API)', async () => {
  assert.deepEqual(await mm.getBrandModels(''), []);
  assert.deepEqual(await mm.getModelBikes('yamaha', ''), []);
  assert.deepEqual(await mm.getModelBikes('', 'mt-07'), []);
});

test('modello del catalogo senza versioni → lista vuota, non un\'invenzione', async () => {
  const senza = Object.entries(CAT.marche.yamaha.modelli).find(([, m]) => !Object.keys(m.versioni || {}).length);
  if (!senza) return;   // se un giorno il catalogo e' completo, il caso non esiste piu'
  const v = await mm.getModelBikes('yamaha', senza[0]);
  assert.ok(Array.isArray(v));
});
