'use strict';
/**
 * I casi che ci sono costati, fissati. Ognuno e' un errore che abbiamo fatto davvero e
 * misurato sul campo: se una regola futura li rompe, si sa subito.
 *
 * Misura di riferimento su 120 annunci Moto.it a verita' nota (lo slug della versione sta
 * nell'URL, e al risolutore resta nascosto): 92 giuste, 3 sbagliate, 96,8% quando risponde.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { risolviVersione } = require('../backend/scrapers/risolvi-versione.js');

const mt07 = {
  versioniMotoit: [
    { id: 'R9Lybg', nome: 'MT-07 (2014 - 16)', variante: '', anni: { da: 2014, a: 2016 } },
    { id: 'DfEo2y', nome: 'MT-07 ABS (2014 - 16)', variante: 'ABS', anni: { da: 2014, a: 2016 } },
    { id: 'fpFXkb', nome: 'MT-07 Moto Cage (2015 - 17)', variante: 'Moto Cage', anni: { da: 2015, a: 2017 } },
    { id: '88SFrS', nome: 'MT-07 (2021 - 24)', variante: '', anni: { da: 2021, a: 2024 } },
    { id: 'DysHDY', nome: 'MT-07 Pure (2023 - 25)', variante: 'Pure', anni: { da: 2023, a: 2025 } },
  ],
};

test('l anno da solo basta quando il periodo e unico', () => {
  const r = risolviVersione(mt07, { anno: 2022, versione: 'Yamaha MT-07' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, '88SFrS');
});

test('a parita di anno, la variante nel testo sceglie', () => {
  const r = risolviVersione(mt07, { anno: 2015, versione: 'Yamaha MT-07 ABS' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, 'DfEo2y');
});

test('senza variante nel testo vince la versione base, non una variante a caso', () => {
  const r = risolviVersione(mt07, { anno: 2015, versione: 'Yamaha MT-07' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, 'R9Lybg');
});

test('la variante piu LUNGA vince: "Moto Cage" non perde contro nulla', () => {
  const r = risolviVersione(mt07, { anno: 2016, versione: 'Yamaha MT-07 Moto Cage' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, 'fpFXkb');
});

/**
 * REGRESSIONE. Una soglia a due caratteri sul nome della variante buttava via "R" e "S":
 * 7 errori su 8 nella prova su 120 annunci veri. Il confronto e' fra spazi, quindi una
 * lettera sola e' sicura.
 */
test('le varianti di UNA lettera si riconoscono (R, S)', () => {
  const panigale = {
    versioniMotoit: [
      { id: 'base', nome: 'Panigale V4 (2022 - 24)', variante: '', anni: { da: 2022, a: 2024 } },
      { id: 'erre', nome: 'Panigale V4 R (2023 - 24)', variante: 'R', anni: { da: 2023, a: 2024 } },
    ],
  };
  const r = risolviVersione(panigale, { anno: 2024, versione: 'Ducati Panigale V4 R' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, 'erre');
  // e senza la R deve restare la base, non scivolare sulla R
  const b = risolviVersione(panigale, { anno: 2024, versione: 'Ducati Panigale V4' });
  assert.strictEqual(b.versioni[0].id, 'base');
});

/** Una lettera NON deve agganciarsi dentro un'altra parola: e' l'errore inverso. */
test('la variante di una lettera non aggancia dentro una parola', () => {
  const finto = {
    versioniMotoit: [
      { id: 'base', nome: 'Street 900 (2020 - 22)', variante: '', anni: { da: 2020, a: 2022 } },
      { id: 'esse', nome: 'Street 900 S (2020 - 22)', variante: 'S', anni: { da: 2020, a: 2022 } },
    ],
  };
  // "Scrambler" contiene una s, ma non come parola isolata
  const r = risolviVersione(finto, { anno: 2021, versione: 'Triumph Street 900 Scrambler' });
  assert.strictEqual(r.versioni[0].id, 'base');
});

test('anno oltre l ultimo periodo: si ripiega sull ultima e lo si dichiara', () => {
  const r = risolviVersione(mt07, { anno: 2030, versione: 'Yamaha MT-07' });
  assert.strictEqual(r.esito, 'una');
  assert.match(r.perche, /oltre l'ultimo periodo/);
});

test('anno in nessun periodo: nessuna, non un ripiego silenzioso', () => {
  const r = risolviVersione(mt07, { anno: 2005, versione: 'Yamaha MT-07' });
  assert.strictEqual(r.esito, 'nessuna');
  assert.strictEqual(r.versioni.length, 0);
});

test('modello senza versioni: lo dice invece di inventare', () => {
  const r = risolviVersione({ versioniMotoit: [] }, { anno: 2020, versione: 'x' });
  assert.strictEqual(r.esito, 'senza-indice');
});

test('due candidate che niente separa: ambigua, mai una scelta a caso', () => {
  const pari = {
    versioniMotoit: [
      { id: 'a', nome: 'X 500 Alpha (2020 - 22)', variante: 'Alpha', anni: { da: 2020, a: 2022 } },
      { id: 'b', nome: 'X 500 Beta (2020 - 22)', variante: 'Beta', anni: { da: 2020, a: 2022 } },
    ],
  };
  const r = risolviVersione(pari, { anno: 2021, versione: 'X 500' });
  assert.strictEqual(r.esito, 'ambigua');
  assert.strictEqual(r.versioni.length, 2);
});
