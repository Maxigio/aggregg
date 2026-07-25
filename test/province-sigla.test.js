'use strict';
// Da come le fonti scrivono la localita' alla sigla che serve all'IPT. E' un passaggio che
// muove soldi: sbagliare provincia significa sbagliare l'importo del passaggio di proprieta',
// quindi qui si difende soprattutto il rifiuto — meglio nessun numero che uno di un'altra provincia.
const { test } = require('node:test');
const assert = require('node:assert');
const ps = require('../backend/province-sigla');

test('i tre formati veri delle nostre fonti si risolvono tutti', () => {
  assert.deepStrictEqual(ps.risolvi('BS'), { sigla: 'BS', via: 'sigla' });        // Moto.it
  assert.deepStrictEqual(ps.risolvi('Genova'), { sigla: 'GE', via: 'provincia' }); // Subito
  assert.deepStrictEqual(ps.risolvi('Gussago'), { sigla: 'BS', via: 'comune' });   // AutoScout
});

test('i comuni AutoScout osservati in un export reale risolvono tutti', () => {
  // Presi da 1.csv, cioe' da annunci veri passati per l'app.
  const attesi = { Gussago: 'BS', Viagrande: 'CT', Fiesole: 'FI', Mezzolombardo: 'TN',
    Sansepolcro: 'AR', 'Bonate Sopra': 'BG', Genova: 'GE', Milano: 'MI', Castellanza: 'VA' };
  for (const [comune, sigla] of Object.entries(attesi)) {
    const r = ps.risolvi(comune);
    assert.ok(r, `${comune} non risolto`);
    assert.strictEqual(r.sigla, sigla, comune);
  }
});

test('forme composte: la sigla esplicita vince sul resto', () => {
  assert.deepStrictEqual(ps.risolvi('Brescia (BS)'), { sigla: 'BS', via: 'parentesi' });
  assert.deepStrictEqual(ps.risolvi('Gussago - Brescia - BS'), { sigla: 'BS', via: 'coda' });
  // senza sigla in coda si scende al nome di provincia, non al comune
  assert.strictEqual(ps.risolvi('Gussago - Brescia').via, 'provincia');
});

test('il CAP e\' l\'ultima spiaggia, e quando conferma il comune lo dice', () => {
  assert.deepStrictEqual(ps.risolvi('', '25064'), { sigla: 'BS', via: 'cap' });
  // comune e CAP concordi: la risposta dichiara di poggiare su due indizi
  assert.deepStrictEqual(ps.risolvi('Gussago', '25064'), { sigla: 'BS', via: 'cap+comune' });
  assert.deepStrictEqual(ps.risolvi('Gussago'), { sigla: 'BS', via: 'comune' });
});

test('indizi in CONTRADDIZIONE: si tace, non si sceglie il piu\' comodo', () => {
  // "Milano" con un CAP bresciano: uno dei due dati e' sbagliato e non sappiamo quale.
  assert.strictEqual(ps.risolvi('Milano', '25064'), null);
  assert.strictEqual(ps.risolvi('Gussago', '20121'), null);
  assert.strictEqual(ps.risolvi('BS', '20121'), null, 'nemmeno una sigla esplicita passa se il CAP la smentisce');
  // CAP a cavallo di due province: scartati a monte come i comuni omonimi
  assert.ok(ps.tabella.capAmbigui.length > 0, 'in Italia esistono CAP condivisi: se la lista e\' vuota il generatore non li cerca');
  for (const z of ps.tabella.capAmbigui) assert.ok(!(z in ps.tabella.cap), `${z} e' ambiguo ma risponde lo stesso`);
});

test('localita\' sconosciuta: si torna null, non si indovina', () => {
  assert.strictEqual(ps.risolvi('Pizzaland'), null);
  assert.strictEqual(ps.risolvi(''), null);
  assert.strictEqual(ps.risolvi(null), null);
  assert.strictEqual(ps.risolvi('ZZ'), null, 'due lettere non e\' automaticamente una sigla');
});

test('i comuni omonimi su province diverse sono stati scartati a monte', () => {
  const amb = ps.tabella.ambigui;
  assert.ok(amb.length > 0, 'ci sono omonimi in Italia: se la lista e\' vuota il generatore non li cerca');
  for (const n of amb) assert.ok(!(n in ps.tabella.comuni), `${n} e' ambiguo ma risponde lo stesso`);
  assert.strictEqual(ps.risolvi(amb[0]), null);
});

test('tutte le sigle prodotte sono province che l\'IPT conosce', () => {
  const ipt = require('../backend/ipt');
  const t = ps.tabella;
  const tutte = new Set([...Object.values(t.nomi), ...Object.values(t.cap), ...Object.values(t.comuni)]);
  const ignote = [...tutte].filter(s => !(s in ipt.tabella.maggiorazioni));
  assert.deepStrictEqual(ignote, [], 'una sigla non calcolabile renderebbe inutile la traduzione');
});

test('CV → kW: e\' la costante fisica, ed e\' una stima dichiarata', () => {
  assert.ok(Math.abs(ps.kwDaCv(150) - 110.325) < 0.01, '150 CV ≈ 110,3 kW');
  assert.strictEqual(ps.kwDaCv(0), null);
  assert.strictEqual(ps.kwDaCv(null), null);
  // il numero deve reggere il confronto con un calcolatore commerciale (pratiche.it, BS 150 CV)
  const r = require('../backend/ipt').calcola({ provincia: 'BS', kW: ps.kwDaCv(150) });
  assert.ok(Math.abs(r.ipt - 503.68) <= 0.01, `IPT ${r.ipt} lontana dai 503,68 di riferimento`);
});
