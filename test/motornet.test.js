'use strict';
// Motornet (listino del nuovo, Eurotax): qui si difende la DECISIONE, non la rete.
// Le due funzioni pure sono quelle che possono sbagliare: quale modello del listino vale per
// la ricerca, e quali kW attribuire a una potenza in CV. I kW finiscono nel calcolo del
// passaggio di proprieta', quindi un errore qui e' un importo in euro sbagliato.
//
// I dati usati sono quelli VERI, letti dal webservice il 2026-07-25 (vedi
// backend/scrapers/motornet.js per lo stato legale di quella fonte).
const { test } = require('node:test');
const assert = require('node:assert');
const mn = require('../backend/scrapers/motornet');

// il modulo nasce SPENTO: un modulo che non deve andare in produzione non deve poter partire
test('spento se non lo si accende a mano', () => {
  assert.strictEqual(mn.ATTIVO, process.env.AMR_MOTORNET === '1');
  if (!mn.ATTIVO) {
    return mn.cerca('Alfa Romeo', 'Giulia').then(r => {
      assert.strictEqual(r.ok, false);
      assert.match(r.motivo, /non attiva/);
    });
  }
});

// elenco reale dei modelli BMW nel listino 2026 (estratto)
const BMW = [
  { nome: 'Serie 1', codiceModello: 1 }, { nome: 'Serie 1 M', codiceModello: 2 },
  { nome: 'Serie 3 Berlina', codiceModello: 3 }, { nome: 'Serie 3 M Berlina', codiceModello: 4 },
  { nome: 'Serie 3 Touring', codiceModello: 5 }, { nome: 'M3 Berlina', codiceModello: 6 },
  { nome: 'Serie 2 Active Tourer', codiceModello: 7 },
];

test('un modello che nel listino e\' spezzato per carrozzeria: si prendono tutte le varianti', () => {
  const r = mn.scegliModelli(BMW, 'Serie 3');
  assert.strictEqual(r.come, 'varianti');
  assert.deepStrictEqual(r.modelli.map(x => x.nome).sort(),
    ['Serie 3 Berlina', 'Serie 3 M Berlina', 'Serie 3 Touring']);
  // NON deve tirare dentro la Serie 1 ne' la M3
  assert.ok(!r.modelli.some(x => /Serie 1|M3/.test(x.nome)));
});

test('nome esatto: vince sul prefisso', () => {
  const r = mn.scegliModelli(BMW, 'Serie 1');
  assert.strictEqual(r.come, 'esatto');
  assert.deepStrictEqual(r.modelli.map(x => x.nome), ['Serie 1']);
});

test('ricerca piu\' specifica del listino: si scende al modello contenuto', () => {
  const r = mn.scegliModelli([{ nome: 'Panda', codiceModello: 9 }, { nome: 'Pandina', codiceModello: 10 }], 'Panda 4x4');
  assert.strictEqual(r.come, 'contenuto');
  assert.deepStrictEqual(r.modelli.map(x => x.nome), ['Panda']);
});

test('modello assente dal listino del nuovo: null, non il piu\' somigliante', () => {
  // La Fiesta e' fuori produzione: nel listino del nuovo non c'e', e non la si sostituisce
  // con la Puma solo perche' e' della stessa marca.
  assert.strictEqual(mn.scegliModelli(
    [{ nome: 'Puma', codiceModello: 1 }, { nome: 'Kuga', codiceModello: 2 }], 'Fiesta'), null);
  assert.strictEqual(mn.scegliModelli(BMW, ''), null);
  assert.strictEqual(mn.scegliModelli([], 'Serie 3'), null);
});

// allestimenti reali della Giulia 2023 (kW/CV/listino letti dal webservice)
const GIULIA = [
  { nome: 'Giulia 2.2 t Sprint 160cv auto', kw: 118, cavalli: 160, prezzoListino: 52750 },
  { nome: 'Giulia 2.2 t Sprint Q4 210cv auto', kw: 155, cavalli: 210, prezzoListino: 57750 },
  { nome: 'Giulia 2.2 t Veloce 160cv auto', kw: 118, cavalli: 160, prezzoListino: 58250 },
  { nome: 'Giulia 2.2 t Veloce Q4 210cv auto', kw: 155, cavalli: 210, prezzoListino: 63250 },
  { nome: 'Giulia 2.9 V6 Quadrifoglio 520cv auto', kw: 382, cavalli: 520, prezzoListino: 102800 },
];

test('kW dai CV: presi dal listino, non calcolati', () => {
  const a = mn.kwPerCavalli(GIULIA, 160);
  assert.strictEqual(a.kw, 118);
  assert.strictEqual(a.versioni.length, 2, 'due allestimenti con 160 cv');
  assert.strictEqual(a.listinoMin, 52750, 'il listino piu\' basso tra i pari potenza');
  assert.strictEqual(mn.kwPerCavalli(GIULIA, 520).kw, 382);
});

test('CV che non esistono nel listino: null', () => {
  assert.strictEqual(mn.kwPerCavalli(GIULIA, 999), null);
  assert.strictEqual(mn.kwPerCavalli(GIULIA, 0), null);
  assert.strictEqual(mn.kwPerCavalli(GIULIA, null), null);
  assert.strictEqual(mn.kwPerCavalli([], 160), null);
});

test('stessi CV ma kW discordanti: si tace invece di scegliere', () => {
  const misti = [
    { nome: 'X 1.0 100cv', kw: 74, cavalli: 100, prezzoListino: 20000 },
    { nome: 'X 1.2 100cv', kw: 73, cavalli: 100, prezzoListino: 21000 },
  ];
  assert.strictEqual(mn.kwPerCavalli(misti, 100), null,
    'due motori diversi con la stessa potenza commerciale: indovinare sposterebbe l\'IPT');
});

test('i kW del listino cambiano l\'IPT dove conta: la soglia dei 53 kW', () => {
  const ipt = require('../backend/ipt');
  const ps = require('../backend/province-sigla');
  // 73 CV stimati danno 53,7 kW → oltre soglia, tariffa a kW.
  const stimati = Math.round(ps.kwDaCv(73) * 10) / 10;
  assert.ok(stimati > 53, 'la stima supera la soglia');
  const conStima = ipt.calcola({ provincia: 'MI', kW: stimati });
  // se il listino dice 53 kW si resta nel forfait: ~49 € in meno, su ogni utilitaria di quella fascia
  const conListino = ipt.calcola({ provincia: 'MI', kW: 53 });
  assert.strictEqual(conListino.ipt, 196.05);
  assert.ok(conStima.totaleNoto - conListino.totaleNoto > 45,
    `atteso uno scarto oltre 45 €, trovato ${(conStima.totaleNoto - conListino.totaleNoto).toFixed(2)}`);
});
