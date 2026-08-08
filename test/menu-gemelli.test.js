'use strict';
/**
 * DUE STRADE NEL MENU, LA STESSA LISTA — il presidio del caso «Vespa 125 GTS».
 *
 * Il proprietario (2026-08-08): sotto Piaggio si poteva scegliere «Vespa 125 GTS», sotto
 * Vespa no (c'era la GTR, non la GTS). Misurato: 13 coppie di marche del menu si
 * spartivano gli stessi veicoli con liste diverse. Questi test ESEGUONO l'unione
 * (backend/menu-gemelli.js) sul catalogo vero: la regola difesa e' che per ogni coppia
 * dichiarata le due strade offrono le stesse voci, senza doppioni.
 */
const test = require('node:test');
const assert = require('node:assert');
const { unisciGemelli, _chiave } = require('../backend/menu-gemelli');
const models = require('../data/models.json');
const gemelli = require('../data/menu-gemelli.json');

const base = (t, marca) => ((models[t] || {})[marca] || { models: [] }).models
  .map(m => ({ nome: m.nome, sites: m.sites || [], mmmvAutoscout: m.mmmvAutoscout || '', kindAS: m.kindAS || '', slugMotoIt: m.slugMotoIt || '' }));

test('il caso del proprietario: il menu Vespa offre la 125 GTS (che stava solo sotto Piaggio)', () => {
  const agg = unisciGemelli('moto', 'Vespa', base('moto', 'Vespa'), models);
  const nomi = agg.map(m => m.nome);
  assert.ok(nomi.includes('125 GTS'), 'manca 125 GTS: ' + nomi.slice(0, 10).join(', '));
  assert.ok(nomi.includes('125 GTS hpe'));
  // e l'inversa: sotto Piaggio compaiono i soli-Vespa
  const aggP = unisciGemelli('moto', 'Piaggio', base('moto', 'Piaggio'), models);
  assert.ok(aggP.some(m => m.nome === 'Vespa 125 GTR'), 'manca Vespa 125 GTR sotto Piaggio');
});

test('niente doppioni, in NESSUNA delle due grafie: «Scarabeo 125» non genera anche «125»', () => {
  const b = base('moto', 'Scarabeo');
  const agg = unisciGemelli('moto', 'Scarabeo', b, models);
  assert.ok(!agg.some(m => _chiave(m.nome) === _chiave('125')), 'il menu ha gia\' «Scarabeo 125»: «125» e\' la stessa moto');
  // e in generale, per ogni coppia: unione IDEMPOTENTE (rifatta sul risultato non aggiunge
  // niente) e nessun doppione NUOVO — il catalogo base ne ha gia' di suoi («Vespa 50 R» e
  // «Vespa 50 R (V5A1)» convivono in Piaggio da prima di questo modulo: reperto a parte,
  // non colpa dell'unione, e l'unione non deve peggiorarlo).
  for (const t of ['auto', 'moto']) {
    for (const v of gemelli.voci[t]) {
      for (const marca of [v.marca, ...(v.inversa ? [v.da] : [])]) {
        const b1 = base(t, marca);
        const agg1 = unisciGemelli(t, marca, b1, models);
        const ancora = unisciGemelli(t, marca, [...b1, ...agg1], models);
        assert.deepStrictEqual(ancora, [], `${t} ${marca}: la seconda unione ha aggiunto ${ancora.length} voci`);
        const chiaviBase = new Set(b1.map(m => _chiave(m.nome)));
        const chiaviAgg = agg1.map(m => _chiave(m.nome));
        assert.strictEqual(new Set(chiaviAgg).size, chiaviAgg.length, `${t} ${marca}: doppioni FRA le aggiunte`);
        for (const k of chiaviAgg) assert.ok(!chiaviBase.has(k), `${t} ${marca}: l'aggiunta «${k}» doppia una voce di base`);
      }
    }
  }
});

test('le voci aggiunte portano i campi della fonte: Autoscout continua a partire per id dove c\'e\'', () => {
  const agg = unisciGemelli('auto', 'Alpine', base('auto', 'Alpine'), models);
  const a310 = agg.find(m => m.nome === 'A310');
  assert.ok(a310, 'A310 deve arrivare da Renault');
  // il campo viaggia (vuoto o pieno che sia nella fonte): la FORMA della voce e' quella del menu
  for (const m of agg) for (const k of ['sites', 'mmmvAutoscout', 'kindAS', 'slugMotoIt']) assert.ok(k in m, k + ' mancante');
});

test('gli omonimi refutati NON stanno fra i gemelli («Indiana» e\' una Ducati, «Megane» non e\' una Mega)', () => {
  const coppie = new Set();
  for (const t of ['auto', 'moto']) for (const v of gemelli.voci[t]) coppie.add(`${v.marca}|${v.da}`).add(`${v.da}|${v.marca}`);
  for (const vietata of ['Indian|Ducati', 'Mega|Renault', 'Mega|Westfield', 'Karma|Oldtimer', 'Zero|Beta', 'Solo|Ural', 'Cobra|Kymco', 'Cobra|Aeon', 'Bull|Royal Enfield', 'Highland|Jinlun']) {
    assert.ok(!coppie.has(vietata), vietata + ' e\' un omonimo refutato: fuori dai gemelli');
  }
});
