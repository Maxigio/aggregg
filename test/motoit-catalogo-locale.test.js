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
  // La spia inchioda la fonte al disco: l'API viva, per MT-07, risponde gli STESSI 9 codici
  // e gli stessi nomi (verificato sulla fonte), quindi se qualcuno togliesse il ramo che
  // legge le versioni dal catalogo i controlli qui sotto passerebbero uguali e la regressione
  // — piu' il ritorno in rete, che la prima riga del file esclude — non la vedrebbe nessuno.
  const https = require('https');
  const veroGet = https.get;
  let uscite = 0;
  https.get = () => { uscite++; throw new Error('rete vietata in questo test'); };
  let v;
  try { v = await mm.getModelBikes('yamaha', 'mt-07'); } finally { https.get = veroGet; }
  assert.equal(uscite, 0, 'le versioni vengono dal catalogo su disco, non da www.moto.it');
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
  // I modelli SENZA versioni a catalogo si saltano: per quelli getModelBikes ripiega
  // sull'API, e l'intestazione di questo file promette che qui la rete non si tocca.
  // Erano 332 richieste vere a www.moto.it a ogni `npm test`, tutte inghiottite da un
  // .catch(() => []), quindi il test passava lo stesso e nessuno le vedeva. Non tolgono
  // niente al controllo: senza versioni a catalogo non c'e' nessun nome da ripulire.
  let tot = 0, res = 0, saltati = 0;
  for (const slug of sporche) {
    const modelli = CAT.marche[slug].modelli || {};
    for (const m of await mm.getBrandModels(slug)) {
      tot++; if (ENT.test(m.name)) res++;
      if (!Object.keys((modelli[m.slug] || {}).versioni || {}).length) { saltati++; continue; }
      for (const v of await mm.getModelBikes(slug, m.slug)) { tot++; if (ENT.test(v.name)) res++; }
    }
  }
  assert.equal(res, 0, tot + ' nomi controllati su ' + sporche.size + ' marche (' + saltati + ' modelli senza versioni a catalogo, saltati)');
});

test('marca fuori catalogo → non esplode (poi ripiega sull\'API)', async () => {
  assert.deepEqual(await mm.getBrandModels(''), []);
  assert.deepEqual(await mm.getModelBikes('yamaha', ''), []);
  assert.deepEqual(await mm.getModelBikes('', 'mt-07'), []);
});

test('modello del catalogo senza versioni → lista vuota, non un\'invenzione', async () => {
  const senza = Object.entries(CAT.marche.yamaha.modelli).find(([, m]) => !Object.keys(m.versioni || {}).length);
  if (!senza) return;   // se un giorno il catalogo e' completo, il caso non esiste piu'
  // Qui il catalogo non ha versioni e getModelBikes ripiega sull'API: e' l'unica chiamata del
  // file che uscirebbe in rete, e usciva davvero — Yamaha ha 10 modelli senza versioni, quindi
  // a ogni `npm test` partiva una richiesta vera a www.moto.it, in un file che in cima promette
  // il contrario. Si devia su un server locale, come negli altri test del repo.
  // E l'esito si controlla su DUE strade, perche' senza `rilancia` il `.catch(() => [])` di
  // motoit-models rende array QUALUNQUE cosa succeda: con la sola `Array.isArray` l'asserzione
  // era vera per costruzione — dati veri, 403, timeout e macchina offline passavano uguali.
  const http = require('http'), https = require('https');
  const chieste = [];
  let stato = 500;
  const srv = http.createServer((req, res) => {
    chieste.push(req.url);
    if (stato !== 200) { res.writeHead(stato); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: 'OK', data: [] }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  const veroGet = https.get;
  https.get = (url, opts, cb) => http.get(String(url).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${porta}`), opts, cb);
  try {
    // Il KO per primo: l'errore non finisce in cache, quindi la chiamata dopo ripete davvero
    // la richiesta invece di riusare un risultato di dodici ore prima.
    await assert.rejects(mm.getModelBikes('yamaha', senza[0], { rilancia: true }), /HTTP 500/,
      'un KO di rete non e\' «questo modello non ha versioni»');
    stato = 200;
    assert.deepStrictEqual(await mm.getModelBikes('yamaha', senza[0]), [],
      'nessuna versione inventata dal nome del modello');
    assert.equal(chieste.length, 2, 'il ripiego sull\'API e\' partito: senza, il vuoto sarebbe solo il .catch');
    assert.ok(chieste.every(u => u.includes(encodeURIComponent('yamaha|' + senza[0]))),
      'e ha chiesto proprio quel modello');
  } finally { https.get = veroGet; srv.close(); }
});

test('un menu 200 non riconoscibile non resta in cache dodici ore', async () => {
  const http = require('http'), https = require('https');
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(++chiamate === 1 ? '{"result":"KO","data":null}' : '{"result":"OK","data":[]}');
  });
  let chiamate = 0;
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const orig = https.get, porta = srv.address().port;
  https.get = (url, opts, cb) => http.get(String(url).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${porta}`), opts, cb);
  try {
    await assert.rejects(mm.getBrandModels('amr-menu-prova', { rilancia: true }), /non riconoscibile/);
    assert.deepEqual(await mm.getBrandModels('amr-menu-prova', { rilancia: true }), []);
    assert.equal(chiamate, 2);
  } finally { https.get = orig; srv.close(); }
});
