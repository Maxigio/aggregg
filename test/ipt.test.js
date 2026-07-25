'use strict';
// IPT: quanto costa passare un veicolo, per provincia. Tabella generata da fonte ACI
// (scripts/build-ipt-province.js). Qui si difende il CALCOLO e, soprattutto, i casi in cui
// il programma deve dire "non lo so" invece di inventare un importo su una spesa vera.
const { test } = require('node:test');
const assert = require('node:assert');
const ipt = require('../backend/ipt');

test('tariffa base: soglia dei 53 kW (sotto è forfettaria, sopra è a kW)', () => {
  const piccola = ipt.calcola({ provincia: 'BZ', kW: 40 });     // BZ = 0% → si vede la base nuda
  const grande = ipt.calcola({ provincia: 'BZ', kW: 110 });
  assert.strictEqual(piccola.ipt, 150.81);                       // forfait D.M. 435/1998
  assert.strictEqual(grande.ipt, 386.31);                        // 110 × 3,5119
  const soglia = ipt.calcola({ provincia: 'BZ', kW: 53 });
  assert.strictEqual(soglia.ipt, 150.81, '53 kW è ancora forfait');
});

test('maggiorazione provinciale applicata (numeri verificati a mano)', () => {
  assert.strictEqual(ipt.calcola({ provincia: 'MI', kW: 110 }).ipt, 502.20);   // 110×3,5119×1,30
  assert.strictEqual(ipt.calcola({ provincia: 'MI', kW: 40 }).ipt, 196.05);    // 150,81×1,30
  assert.strictEqual(ipt.calcola({ provincia: 'FE', kW: 110 }).maggiorazione, 25);
  assert.strictEqual(ipt.calcola({ provincia: 'GO', kW: 110 }).maggiorazione, 20);   // tutta la FVG
  assert.strictEqual(ipt.calcola({ provincia: 'BZ', kW: 110 }).maggiorazione, 0);
});

test('Torino: 20% con atto soggetto a IVA, 30% senza (regola da operatore)', () => {
  const senza = ipt.calcola({ provincia: 'TO', kW: 110, ivaEsposta: false });
  const con = ipt.calcola({ provincia: 'TO', kW: 110, ivaEsposta: true });
  assert.strictEqual(senza.maggiorazione, 30);
  assert.strictEqual(con.maggiorazione, 20);
  assert.ok(con.ipt < senza.ipt);
  assert.ok(con.avvisi.some(a => /IVA/.test(a)), 'la regola va spiegata, non applicata in silenzio');
});

test('veicolo speciale: IPT a un quarto', () => {
  const n = ipt.calcola({ provincia: 'MI', kW: 110 });
  const s = ipt.calcola({ provincia: 'MI', kW: 110, speciale: true });
  assert.strictEqual(s.ipt, 125.55);
  assert.ok(Math.abs(s.ipt - n.ipt / 4) < 0.02);
  assert.ok(s.avvisi.some(a => /quarto/i.test(a)));
});

test('passaggio consecutivo non finale: IPT zero, con l\'avvertenza dei 60 giorni', () => {
  const r = ipt.calcola({ provincia: 'MI', kW: 110, consecutiva: true });
  assert.strictEqual(r.ipt, 0);
  assert.strictEqual(r.totaleNoto, 27);            // restano gli emolumenti
  assert.ok(r.avvisi.some(a => /60/.test(a)), 'va detto che l\'esenzione decade dopo il 60° giorno');
});

test('autobus/trattori: soglia 110 kW e tariffa propria', () => {
  assert.strictEqual(ipt.calcola({ provincia: 'BZ', kW: 100, tipo: 'autobus' }).ipt, 150.81);
  assert.strictEqual(ipt.calcola({ provincia: 'BZ', kW: 200, tipo: 'autobus' }).ipt, 351.18);   // 200×1,7559
});

test('l\'imposta di bollo NON è nel totale (ACI la dichiara variabile)', () => {
  const r = ipt.calcola({ provincia: 'MI', kW: 110 });
  assert.strictEqual(r.totaleNoto, r.ipt + r.emolumenti);
  assert.ok(r.nonIncluso.some(x => /bollo/i.test(x)), 'va dichiarato cosa manca');
});

test('casi non calcolabili: si dice, non si stima', () => {
  const moto = ipt.calcola({ provincia: 'MI', kW: 35, tipo: 'moto' });
  assert.strictEqual(moto.ok, false);
  assert.match(moto.motivo, /non ha una riga per i motocicli/);
  assert.strictEqual(ipt.calcola({ provincia: 'MI' }).ok, false);          // senza kW
  assert.strictEqual(ipt.calcola({ provincia: 'XX', kW: 110 }).ok, false); // provincia ignota
});

// Le tre lacune dichiarate a suo tempo, chiuse sulla fonte ACI. I test le difendono
// perche' sono soldi veri: un importo sbagliato qui e' un margine sbagliato in lista.
test('veicoli storici: importo fisso verificato (art. 63 c.4 L. 342/2000)', () => {
  const auto = ipt.calcola({ provincia: 'MI', kW: 90, storico: true });
  assert.strictEqual(auto.ipt, 51.65);
  assert.strictEqual(auto.totaleNoto, 78.65);
  assert.strictEqual(auto.storico, true);
  // fisso davvero: la provincia e la potenza non lo muovono
  assert.strictEqual(ipt.calcola({ provincia: 'BZ', kW: 200, storico: true }).ipt, 51.65);
  const moto = ipt.calcola({ provincia: 'MI', kW: 35, tipo: 'moto', storico: true });
  assert.strictEqual(moto.ipt, 25.82, 'i motoveicoli storici hanno il loro importo');
  assert.ok(moto.ok, 'lo storico e\' l\'unico caso moto calcolabile');
});

test('storici: la condizione d\'uso NON professionale va detta a un operatore', () => {
  const r = ipt.calcola({ provincia: 'MI', kW: 90, storico: true });
  assert.ok(r.avvisi.some(a => /impresa|professional/i.test(a)),
    'per chi compra per rivendere la riduzione puo\' non spettare: va scritto');
  assert.ok(r.avvisi.some(a => /2015/.test(a)), 'gli ultraventennali l\'hanno persa dal 2015');
  assert.match(r.dettaglio[0], /342\/2000/);
});

test('moto: l\'esenzione dell\'art. 17 c.39 riguarda l\'imposta ERARIALE, non l\'IPT', () => {
  const m = ipt.calcola({ provincia: 'MI', kW: 35, tipo: 'moto' });
  assert.strictEqual(ipt.tabella.motocicli.esenti, false);
  assert.ok(m.avvisi.some(a => /ERARIALE/.test(a)), 'la tesi sbagliata va smontata, non ripetuta');
  assert.ok(m.avvisi.some(a => /storic/i.test(a)), 'va indicata la via che invece funziona');
});

test('la documentazione delle regole non contraddice il codice', () => {
  // La regola "storici" diceva "importo non verificato, da confermare prima di mostrarlo"
  // mentre il calcolo lo mostrava: una nota stantia e' una bugia che sopravvive nei dati.
  assert.doesNotMatch(ipt.tabella.regole.storici, /NON verificato|da confermare/i);
  assert.match(ipt.tabella.regole.storici, /342\/2000/);
});

test('imposta di bollo: dichiarata variabile CON il motivo', () => {
  assert.strictEqual(ipt.tabella.bollo.variabile, true);
  assert.match(ipt.tabella.bollo.perche, /per documento/);
  assert.strictEqual(ipt.tabella.daVerificare.length, 1, 'resta solo la tariffa base moto');
  assert.match(ipt.tabella.daVerificare[0], /motocicli non storici/);
});

test('la fonte viaggia col risultato (nessuna licenza aperta: va citata)', () => {
  const r = ipt.calcola({ provincia: 'MI', kW: 110 });
  assert.match(r.fonte.maggiorazioni, /aci\.gov\.it/);
  assert.match(r.fonte.tariffe, /aci\.gov\.it/);
  assert.ok(r.fonte.aggiornato);
});

test('confronta: ordina dalla provincia più economica, copre tutte le 107', () => {
  const tutte = ipt.confronta(110);
  assert.strictEqual(tutte.length, 107);
  assert.ok(tutte[0].totaleNoto <= tutte[tutte.length - 1].totaleNoto);
  assert.strictEqual(tutte[0].maggiorazione, 0);      // le province a zero stanno in testa
});

test('la tabella copre tutte le province del nostro elenco', () => {
  const province = require('../data/province.json');
  const mancanti = Object.keys(province).filter(s => !(s in ipt.tabella.maggiorazioni));
  assert.deepStrictEqual(mancanti, [], 'nessuna provincia senza percentuale');
});
