'use strict';
/**
 * Costo di possesso per provincia (IVASS + MEF).
 *
 * Difende due cose diverse: che il DATO generato sia integro (copertura, coerenza dei percentili,
 * valori plausibili) e che il LETTORE non inventi numeri dove la fonte non ne ha.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const c = require('../backend/costi-possesso');
const PROVINCE = require('../data/province.json');

test('il dato copre tutte le 107 province, con le assenze dichiarate', () => {
  const p = c.dati.province;
  assert.strictEqual(Object.keys(p).length, 107);
  assert.deepStrictEqual(Object.keys(p).sort(), Object.keys(PROVINCE).sort(), 'stesse sigle di province.json');

  // Le assenze sono della FONTE e sono elencate: chi non e' nell'elenco deve avere il dato.
  const senzaRc = Object.entries(p).filter(([, v]) => !v.auto || v.auto.mediana == null).map(([s]) => s);
  assert.deepStrictEqual(senzaRc.sort(), [...c.dati.assenti.rc.sigle].sort());
  const senzaAliq = Object.entries(p).filter(([, v]) => v.aliquotaRc == null).map(([s]) => s);
  assert.deepStrictEqual(senzaAliq.sort(), [...c.dati.assenti.aliquota.sigle].sort());
  assert.ok(c.dati.assenti.rc.perche.length > 20, 'l\'assenza va spiegata, non solo elencata');
});

test('auto e moto: entrambe coperte, e il rapporto fra le due resta plausibile', () => {
  const p = Object.values(c.dati.province).filter(v => v.auto && v.moto);
  assert.ok(p.length >= 105, `attese almeno 105 province con auto+moto, trovate ${p.length}`);
  // Serve a beccare due colonne scambiate nel parsing. NON si asserisce "moto < auto": misurato
  // sui dati veri del 1 trimestre 2026, in 9 province del Sud la moto costa quanto l'auto o piu
  // (Cosenza 1,18x, Salerno 1,10x, Barletta 1,13x). Il rapporto mediano nazionale e' 0,70 e
  // l'intervallo osservato va da 0,53 a 1,18: la banda qui sotto lo contiene con margine.
  const rapporti = p.map(v => v.moto.mediana / v.auto.mediana);
  for (const r of rapporti) assert.ok(r > 0.35 && r < 1.6, `rapporto moto/auto fuori scala: ${r.toFixed(2)}`);
  const mediano = rapporti.slice().sort((a, b) => a - b)[Math.floor(rapporti.length / 2)];
  assert.ok(mediano > 0.55 && mediano < 0.9, `rapporto mediano moto/auto inatteso: ${mediano.toFixed(2)}`);
});

test('i percentili sono ordinati, e la mediana sta dentro la forchetta', () => {
  for (const [sg, v] of Object.entries(c.dati.province)) {
    for (const t of ['auto', 'moto', 'ciclomotore']) {
      const r = v[t];
      if (!r || r.mediana == null) continue;
      assert.ok(r.p10 <= r.p25 && r.p25 <= r.mediana && r.mediana <= r.p75 && r.p75 <= r.p90,
        `${sg}/${t}: percentili non ordinati ${JSON.stringify(r)}`);
      assert.ok(r.mediana > 50 && r.mediana < 3000, `${sg}/${t}: mediana fuori scala (${r.mediana})`);
    }
  }
});

test('aliquota: sta nella forbice di legge, 9%-16%', () => {
  const a = Object.values(c.dati.province).map(v => v.aliquotaRc).filter(x => x != null);
  assert.ok(a.length >= 100, `attese almeno 100 aliquote, trovate ${a.length}`);
  for (const x of a) assert.ok(x >= 9 && x <= 16, `aliquota fuori forbice: ${x}`);
});

test('cerca: Milano porta premio, classi bonus-malus e aliquota', () => {
  const mi = c.cerca('MI');
  assert.strictEqual(mi.provincia, 'MI');
  assert.strictEqual(mi.tipo, 'auto');
  assert.ok(mi.rc.mediana > 0);
  // La media supera la mediana: sono le poche polizze carissime a tirarla su. E' il motivo per cui
  // in interfaccia si mostra la mediana.
  assert.ok(mi.rc.medio > mi.rc.mediana, 'la media deve stare sopra la mediana');
  assert.ok(mi.rc.perClasse && Object.keys(mi.rc.perClasse).length >= 4, 'servono le classi bonus-malus');
  assert.ok(mi.aliquotaRc >= 9 && mi.aliquotaRc <= 16);
  assert.ok(mi.periodo && /trimestre|\d{4}/.test(mi.periodo), 'il periodo va dichiarato');
  assert.ok(mi.fonti.rc.file.startsWith('https://'), 'la fonte va citata con il link al file');
});

test('cerca: il tipo moto cambia davvero il numero servito', () => {
  const auto = c.cerca('MI', 'auto'), moto = c.cerca('MI', 'moto');
  assert.notStrictEqual(auto.rc.mediana, moto.rc.mediana);
  assert.strictEqual(moto.tipo, 'moto');
  // Tipo sconosciuto o assente ricade su auto, non esplode.
  assert.strictEqual(c.cerca('MI', 'trattore').tipo, 'auto');
  assert.strictEqual(c.cerca('MI').tipo, 'auto');
});

test('dove la fonte non ha il dato si dice PERCHE, non si stima', () => {
  // Bolzano: provincia autonoma, l'imposta non la delibera la Provincia.
  const bz = c.cerca('BZ');
  assert.strictEqual(bz.aliquotaRc, null);
  assert.match(bz.aliquotaMotivo, /autonom|statuto speciale/i);
  assert.ok(bz.rc && bz.rc.mediana > 0, 'il premio r.c. invece c\'e');
  // Sud Sardegna: IVASS non la pubblica separatamente.
  const su = c.cerca('SU');
  assert.strictEqual(su.rc, null);
  assert.match(su.rcMotivo, /Sud Sardegna|2016|separat/i);
});

test('provincia inesistente: null, non un oggetto vuoto che sembra un dato', () => {
  assert.strictEqual(c.cerca('ZZ'), null);
  assert.strictEqual(c.cerca(''), null);
  assert.strictEqual(c.cerca(null), null);
  assert.strictEqual(c.posizione('ZZ'), null);
});

test('posizione: 1 e la piu economica, e la sigla si accetta minuscola', () => {
  const p = c.cerca('mi');
  assert.strictEqual(p.provincia, 'MI');
  const pos = c.posizione('MI');
  assert.ok(pos.posto >= 1 && pos.posto <= pos.su);
  const scala = Object.entries(c.dati.province)
    .filter(([, v]) => v.auto && v.auto.mediana != null)
    .sort((a, b) => a[1].auto.mediana - b[1].auto.mediana);
  assert.strictEqual(c.posizione(scala[0][0]).posto, 1, 'la provincia col premio piu basso deve essere prima');
  assert.strictEqual(c.posizione(scala[scala.length - 1][0]).posto, pos.su, 'la piu cara deve essere ultima');
});
