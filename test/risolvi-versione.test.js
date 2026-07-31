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
  // `marca` e `subito.nome` servono: senza, ogni parola del titolo risulta estranea e la
  // risposta scivola su 'ripiego'. E' il comportamento prudente giusto, ma va alimentato.
  marca: 'Yamaha', subito: { nome: 'MT-07' },
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

test('anno oltre l ultimo periodo: NON si indovina, si lascia scegliere', () => {
  // Prima usciva 'una', cioe' una corrispondenza: la scheda si apriva gia' scelta con le
  // specifiche di un'altra annata e nessun segno che fosse un ripiego. Se il catalogo non
  // arriva a quell'anno la risposta onesta e' "scegli tu": 'ripiego' non preseleziona.
  const r = risolviVersione(mt07, { anno: 2030, versione: 'Yamaha MT-07' });
  assert.strictEqual(r.esito, 'ripiego');
  assert.ok(r.versioni.length >= 1, 'le candidate si mostrano comunque, non si perdono');
  assert.match(r.perche, /oltre l'ultimo periodo/);
  assert.match(r.perche, /scegli tu/);
});

/**
 * REGRESSIONE. Il flag `ripiego` si consultava SOLO nel caso "una candidata sola": con due
 * o piu' candidate i rami variante e base emettevano 'una' — cioe' una certezza — con
 * dentro un `perche` che diceva "scegli tu". Il chiamante preselezionava la scheda.
 */
const dueAllUltimo = {
  marca: 'Yamaha', subito: { nome: 'MT-07' },
  versioniMotoit: [
    { id: 'base', nome: 'MT-07 (2014 - 16)', variante: '', anni: { da: 2014, a: 2016 } },
    { id: 'abs', nome: 'MT-07 ABS (2014 - 16)', variante: 'ABS', anni: { da: 2014, a: 2016 } },
  ],
};

test('anno oltre l ultimo periodo + variante riconosciuta: resta ripiego, non diventa certezza', () => {
  const r = risolviVersione(dueAllUltimo, { anno: 2022, versione: 'Yamaha MT-07 ABS' });
  assert.strictEqual(r.esito, 'ripiego');
  assert.strictEqual(r.versioni[0].id, 'abs', 'la variante restringe comunque le candidate');
  assert.match(r.perche, /scegli tu/);
});

test('anno oltre l ultimo periodo + testo base: la base non e una certezza', () => {
  const r = risolviVersione(dueAllUltimo, { anno: 2022, versione: 'Yamaha MT-07' });
  assert.strictEqual(r.esito, 'ripiego');
  assert.strictEqual(r.versioni[0].id, 'base');
});

test('anno nel BUCO fra due periodi: ripiego, e il perche non mente sull anno', () => {
  const conBuco = {
    marca: 'BMW', subito: { nome: 'R 1200 GS' },
    versioniMotoit: [
      { id: 'vecchia', nome: 'R 1200 GS (2004 - 07)', variante: '', anni: { da: 2004, a: 2007 } },
      { id: 'nuova', nome: 'R 1200 GS (2013 - 16)', variante: '', anni: { da: 2013, a: 2016 } },
      { id: 'senza', nome: 'R 1200 GS Adventure', variante: 'Adventure', anni: null },
    ],
  };
  const r = risolviVersione(conBuco, { anno: 2010, versione: 'BMW R 1200 GS' });
  assert.strictEqual(r.esito, 'ripiego');
  assert.match(r.perche, /2010/, 'il perche deve nominare l anno, non dire "nessun anno nell annuncio"');
  assert.match(r.perche, /scegli tu/);
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

/**
 * REGRESSIONI trovate da una caccia avversariale sui ponti, tutte riprodotte prima di
 * correggerle. Tre su quattro erano la stessa forma d'errore gia' vista sui modelli:
 * confronto per SOTTOSTRINGA invece che per insieme di parole, e certezza dichiarata
 * su un ripiego.
 */
const misto = {
  marca: 'BMW', subito: { nome: 'K 1100 LT' },
  versioniMotoit: [
    { id: 'base', nome: 'K 1100 LT (1992 - 96)', variante: '', anni: { da: 1992, a: 1996 } },
    { id: 'se', nome: 'K 1100 LT SE', variante: 'SE', anni: null },
  ],
};

test('le versioni SENZA periodo non vengono cancellate dal filtro anno', () => {
  const r = risolviVersione(misto, { anno: 1993, versione: 'BMW K 1100 LT SE' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, 'se');
});

test('anno PRIMA del primo periodo: restano le versioni senza periodo, e si dichiara ripiego', () => {
  const r = risolviVersione(misto, { anno: 1988, versione: 'BMW K 1100 LT SE' });
  assert.notStrictEqual(r.esito, 'nessuna');
  assert.strictEqual(r.versioni[0].id, 'se');
  // Ci si arriva per ESCLUSIONE: la scheda non va preselezionata come se combaciasse.
  assert.strictEqual(r.esito, 'ripiego');
  assert.match(r.perche, /scegli tu/);
});

test('le parole della variante contano come INSIEME, non in fila', () => {
  const cab = {
    marca: 'Fantic', subito: { nome: 'Caballero 500' },
    versioniMotoit: [
      { id: 'x', nome: 'Caballero 500 Scrambler (2021 - 23)', variante: 'Scrambler', anni: { da: 2021, a: 2023 } },
      { id: 'y', nome: 'Caballero 500 Scrambler Anniversary (2021 - 23)', variante: 'Scrambler Anniversary', anni: { da: 2021, a: 2023 } },
    ],
  };
  const r = risolviVersione(cab, { anno: 2022, versione: 'Scrambler 50th Anniversary' });
  assert.strictEqual(r.esito, 'una');
  assert.strictEqual(r.versioni[0].id, 'y');
});

test('allestimento sconosciuto: la base e un RIPIEGO, non una certezza', () => {
  const ind = {
    marca: 'Indian', subito: { nome: 'Scout' },
    versioniMotoit: [
      { id: 'a', nome: 'Scout (2015 - 24)', variante: '', anni: { da: 2015, a: 2024 } },
      { id: 'b', nome: 'Scout Bobber (2018 - 24)', variante: 'Bobber', anni: { da: 2018, a: 2024 } },
    ],
  };
  const r = risolviVersione(ind, { anno: 2020, versione: 'Indian Scout Rogue' });
  assert.strictEqual(r.esito, 'ripiego');
  // ma senza parole estranee la base resta una risposta piena
  const b = risolviVersione(ind, { anno: 2020, versione: 'Indian Scout' });
  assert.strictEqual(b.esito, 'una');
});

test('marca e modello nel titolo non fanno scattare il ripiego', () => {
  const y = {
    marca: 'Yamaha', subito: { nome: 'MT-07' },
    versioniMotoit: [{ id: 'a', nome: 'MT-07 (2021 - 24)', variante: '', anni: { da: 2021, a: 2024 } }],
  };
  assert.strictEqual(risolviVersione(y, { anno: 2022, versione: 'Yamaha MT-07' }).esito, 'una');
});
