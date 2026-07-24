'use strict';
// F50 fase 1: restringimento AS24 per i modelli senza codice-modello.
// La parentela è dedotta dal CATALOGO per prefisso normalizzato — nessuna lista scritta a mano.
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAs24Narrowing } = require('../backend/scrapers/brand-match');

// Catalogo CFMOTO reale (estratto da data/models.json): "800MT" ha il codice, "800MT-X" no.
const CFMOTO = [
  { nome: '800MT', mmmvAutoscout: '51518|76611||' },
  { nome: '800MT-X' },                                   // orfano: nessun mmmv
  { nome: '800NK', mmmvAutoscout: '51518|76612||' },
  { nome: '300CL-X', mmmvAutoscout: '51518|77835||' },
];

test('orfano con padre a catalogo → usa il codice del padre + filtro nativo', () => {
  const r = resolveAs24Narrowing(CFMOTO, '800MT-X', 51518);
  assert.strictEqual(r.mmmv, '51518|76611||');   // il bucket giusto, non tutta la marca
  assert.strictEqual(r.padre, '800MT');
  assert.strictEqual(r.versionText, '800MT-X');
});

test('nessun padre → brand-only, ma con il filtro nativo (prima era pesca cieca)', () => {
  const r = resolveAs24Narrowing(CFMOTO, 'Papio', 51518);
  assert.strictEqual(r.mmmv, '51518|||');
  assert.strictEqual(r.padre, null);
  assert.strictEqual(r.versionText, 'Papio');
});

test('il padre deve avere il codice: un padre orfano non viene scelto', () => {
  const models = [{ nome: 'Alpha' }, { nome: 'Alpha Sport' }];   // nessuno ha mmmv
  const r = resolveAs24Narrowing(models, 'Alpha Sport RR', 999);
  assert.strictEqual(r.mmmv, '999|||');
  assert.strictEqual(r.padre, null);
});

test('a più padri possibili vince il più specifico', () => {
  const models = [
    { nome: 'Africa', mmmvAutoscout: '31|1||' },
    { nome: 'Africa Twin', mmmvAutoscout: '31|2||' },
  ];
  const r = resolveAs24Narrowing(models, 'Africa Twin CRF 1000L', 31);
  assert.strictEqual(r.mmmv, '31|2||');
  assert.strictEqual(r.padre, 'Africa Twin');
});

test('prefisso STRETTO: un nome identico non è padre di se stesso', () => {
  const r = resolveAs24Narrowing(CFMOTO, '800MT', 51518);
  assert.strictEqual(r.padre, null);          // "800MT" non fa da padre a "800MT"
  assert.strictEqual(r.mmmv, '51518|||');
});

test('la parentela ignora spaziatura e maiuscole (norm)', () => {
  const r = resolveAs24Narrowing(CFMOTO, '800 mt-x', 51518);
  assert.strictEqual(r.padre, '800MT');
  assert.strictEqual(r.versionText, '800 mt-x');   // il testo inviato ad AS24 resta quello cercato
});

test('prefissi troppo corti (<3) non fanno da padre: niente falsi agganci', () => {
  const models = [{ nome: 'X', mmmvAutoscout: '1|9||' }, { nome: 'XR 125', mmmvAutoscout: '1|10||' }];
  const r = resolveAs24Narrowing(models, 'XR 125 Sport', 1);
  assert.strictEqual(r.padre, 'XR 125');   // non "X"
});

test('modello vuoto o marca senza makeId → nessun crash, nessun filtro', () => {
  assert.deepStrictEqual(resolveAs24Narrowing(CFMOTO, '', 51518), { mmmv: '51518|||', versionText: '', padre: null });
  assert.deepStrictEqual(resolveAs24Narrowing(null, '800MT-X', null), { mmmv: '', versionText: '800MT-X', padre: null });
});

test('buildVariables: il filtro nativo entra nella classification AS24', () => {
  const buildVariables = require('../backend/scrapers/autoscout-graphql')._buildVariables;
  const { v } = buildVariables({ tipo: 'moto', autoscoutMmmv: '51518|76611||', autoscoutVersionText: '800MT-X' }, 1);
  assert.deepStrictEqual(v.classification, [{ make: 51518, model: 76611, modelVersionInput: '800MT-X' }]);
  const { v: senza } = buildVariables({ tipo: 'moto', autoscoutMmmv: '51518|76611||' }, 1);
  assert.deepStrictEqual(senza.classification, [{ make: 51518, model: 76611 }]);   // invariato senza fase 1
});
