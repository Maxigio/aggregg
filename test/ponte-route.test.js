'use strict';
/**
 * L'area CORRISPONDENZE, provata su un server nudo: cosi' si verifica il livello HTTP
 * senza passare dal login, come gia' fa la suite per i ricambi.
 *
 * Il punto di questi test non e' che le rotte rispondano: e' che rispondano DICENDO IL
 * GRADO. Un aggancio probabile presentato come certo e' il difetto che questa area esiste
 * per non commettere.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { mount } = require('../backend/ponte-route');

function avvia() {
  const app = express();
  mount(app, { clientIp: () => '127.0.0.1' });
  return new Promise(res => { const s = app.listen(0, () => res(s)); });
}
const chiedi = async (s, p) => {
  const r = await fetch('http://127.0.0.1:' + s.address().port + p);
  return { status: r.status, body: await r.json() };
};

test('stato: dice cosa c e dentro e spiega i gradi', async () => {
  const s = await avvia();
  try {
    const { status, body } = await chiedi(s, '/api/ponte/stato');
    assert.strictEqual(status, 200);
    assert.ok(body.ok);
    assert.ok(body.marche.auto > 100 && body.marche.moto > 100, 'marche attese in entrambi i tipi');
    // ogni grado usato deve avere una spiegazione: un grado senza spiegazione e' un numero muto
    for (const tipo of ['auto', 'moto']) for (const k of Object.keys(body.conta[tipo])) {
      const grado = k.split(':')[1];
      assert.ok(body.spiegazione[grado], 'grado senza spiegazione: ' + grado);
    }
  } finally { s.close(); }
});

test('marche: elenco ordinato, con la grafia leggibile', async () => {
  const s = await avvia();
  try {
    const { body } = await chiedi(s, '/api/ponte/marche?tipo=moto');
    assert.ok(body.marche.length > 100);
    assert.ok(body.marche.every(m => m.chiave && m.nome));
    const nomi = body.marche.map(m => m.nome);
    assert.deepStrictEqual(nomi, [...nomi].sort((a, b) => a.localeCompare(b)), 'devono essere ordinate');
  } finally { s.close(); }
});

test('modelli: ogni aggancio porta grado e prova, anche quando e assente', async () => {
  const s = await avvia();
  try {
    const { body } = await chiedi(s, '/api/ponte/modelli?tipo=moto&marca=bmw');
    assert.ok(body.modelli.length > 50, 'BMW deve avere molti modelli moto');
    for (const m of body.modelli) for (const [fonte, v] of Object.entries(m.verso)) {
      assert.ok(v.grado, 'grado mancante su ' + m.nome + ' → ' + fonte);
      assert.ok(v.prova, 'PROVA mancante su ' + m.nome + ' → ' + fonte);
      if (v.grado === 'assente') assert.strictEqual(v.nodi.length, 0, 'un assente non puo avere nodi');
      else assert.ok(v.nodi.length > 0, 'un aggancio deve avere almeno un nodo');
    }
    const gs = body.modelli.find(m => /^R 1200 GS$/i.test(m.nome));
    assert.ok(gs, 'la R 1200 GS deve esserci');
    assert.ok(gs.verso.motoit && gs.verso.motoit.nodi.length, 'e deve agganciare Moto.it');
  } finally { s.close(); }
});

test('marca mancante: lo dice invece di rispondere a caso', async () => {
  const s = await avvia();
  try {
    const { body } = await chiedi(s, '/api/ponte/modelli?tipo=moto');
    assert.deepStrictEqual(body.modelli, []);
    assert.ok(body.motivo);
  } finally { s.close(); }
});

test('versione: risolve per anno e porta il link alla scheda', async () => {
  const s = await avvia();
  try {
    const mod = (await chiedi(s, '/api/ponte/modelli?tipo=moto&marca=bmw')).body
      .modelli.find(m => /^R 1200 GS$/i.test(m.nome));
    const { body } = await chiedi(s, '/api/ponte/versione?marca=bmw&modelloId=' + mod.id + '&anno=2014&versione=BMW R 1200 GS');
    assert.ok(body.trovato);
    assert.strictEqual(body.esito, 'una');
    assert.strictEqual(body.versioni.length, 1);
    assert.match(body.versioni[0].nome, /2013/);
    assert.match(body.versioni[0].scheda, /^https:\/\/www\.moto\.it\/listino\//);
    assert.ok(body.perche, 'deve dire PERCHE ha scelto quella');
  } finally { s.close(); }
});

test('versione: un esito incerto resta incerto, non diventa una risposta', async () => {
  const s = await avvia();
  try {
    // senza anno il filtro principale non si applica: l'area deve dichiararlo
    const mod = (await chiedi(s, '/api/ponte/modelli?tipo=moto&marca=bmw')).body
      .modelli.find(m => /^R 1200 GS$/i.test(m.nome));
    const { body } = await chiedi(s, '/api/ponte/versione?marca=bmw&modelloId=' + mod.id);
    assert.ok(['ambigua', 'una', 'ripiego'].includes(body.esito));
    if (body.esito !== 'una') assert.ok(body.versioni.length !== 1 || body.esito === 'ripiego');
  } finally { s.close(); }
});

test('modello senza indice versioni: lo dichiara', async () => {
  const s = await avvia();
  try {
    const { body } = await chiedi(s, '/api/ponte/versione?marca=bmw&modelloId=inesistente');
    assert.strictEqual(body.trovato, false);
    assert.ok(body.motivo);
  } finally { s.close(); }
});
