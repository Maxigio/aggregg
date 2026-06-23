'use strict';
// F50 Fase 2 — generazione target dal catalogo (pura, no DB). Le asserzioni
// testano INVARIANTI di ordinamento (non rank/percentuali fragili che un refresh
// benigno di models.json romperebbe): liquidità per tipo, interleave auto/moto del
// ramp, monotonia della priority dentro ogni tipo (incl. la coda a priority 0).
const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../data/models.json');
const { candidates } = require('../backend/candidate-targets');
const { marcaLiquidity } = require('../scripts/hydrate-watchlist');

// calcolati UNA volta (input immutabili) — riusati da tutti i test.
const liq = marcaLiquidity(catalog);
const { items, total } = candidates(catalog, [], { limit: 1e9 });
const pri = it => liq.get(it.tipo + '|' + it.marca) || 0;

// id-proxy = indice nell'output di candidates (= ordine d'inserimento → id seriale).
// Replica l'ORDER BY del ramp: row_number() OVER (PARTITION BY tipo ORDER BY
// priority DESC, id), poi tipo (auto prima a parità di rank).
function rampOrder(list) {
  const withIdx = list.map((it, i) => ({ it, p: pri(it), i }));
  const perTipo = { auto: [], moto: [] };
  for (const x of withIdx) perTipo[x.it.tipo].push(x);
  for (const t of Object.keys(perTipo)) {
    perTipo[t].sort((a, b) => b.p - a.p || a.i - b.i);
    perTipo[t].forEach((x, rank) => { x.rank = rank; });
  }
  return withIdx.slice().sort((a, b) => a.rank - b.rank || (a.it.tipo < b.it.tipo ? -1 : 1));
}

test('candidates(): coda nuova sostanziosa (>13k) dal catalogo 14.170', () => {
  assert.ok(total > 13000, `attesi >13000, ottenuti ${total}`);
  for (const it of items.slice(0, 50)) {
    assert.ok(it.tipo && it.marca && it.modello, 'tipo/marca/modello presenti');
  }
});

test('liquidità: entrambi i tipi hanno sia >0 sia =0 (interleave + coda esercitati)', () => {
  for (const tp of ['auto', 'moto']) {
    const seg = items.filter(it => it.tipo === tp);
    assert.ok(seg.some(it => pri(it) > 0), `${tp}: nessuna priority>0`);
    assert.ok(seg.some(it => pri(it) === 0), `${tp}: nessuna priority=0 (coda)`);
  }
  // Fiat è il bestseller auto del catalogo → priority auto massima.
  const topAuto = items.filter(it => it.tipo === 'auto').sort((a, b) => pri(b) - pri(a))[0];
  assert.equal(topAuto.marca, 'Fiat', `top auto atteso Fiat, ottenuto ${topAuto.marca}`);
});

test('ramp interleave: i primi N target contengono SIA auto SIA moto', () => {
  const order = rampOrder(items);
  const head = order.slice(0, 10).map(x => x.it.tipo);
  assert.ok(head.includes('auto') && head.includes('moto'),
    `interleave fallito: primi 10 = ${head.join(',')}`);
  // il primissimo di ogni tipo è il più liquido di quel tipo
  const firstAuto = order.find(x => x.it.tipo === 'auto');
  const firstMoto = order.find(x => x.it.tipo === 'moto');
  const maxAuto = Math.max(...items.filter(it => it.tipo === 'auto').map(pri));
  const maxMoto = Math.max(...items.filter(it => it.tipo === 'moto').map(pri));
  assert.equal(firstAuto.p, maxAuto);
  assert.equal(firstMoto.p, maxMoto);
});

test('monotonia: dentro ogni tipo la priority non cresce lungo l\'ordine del ramp (coda 0 in fondo)', () => {
  const order = rampOrder(items);
  for (const tp of ['auto', 'moto']) {
    const seq = order.filter(x => x.it.tipo === tp).map(x => x.p);
    for (let i = 1; i < seq.length; i++) {
      assert.ok(seq[i] <= seq[i - 1], `${tp}: priority risale a idx ${i} (${seq[i - 1]} → ${seq[i]})`);
    }
    assert.equal(seq[seq.length - 1], 0, `${tp}: la coda non finisce a priority 0`);
  }
});
