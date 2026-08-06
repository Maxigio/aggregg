'use strict';
/**
 * LA VERSIONE, VERIFICATA UGUALE PER TUTTE LE FONTI.
 *
 * La regola difesa qui non e' "il filtro funziona": e' che l'esito dipenda da cio' che
 * l'ANNUNCIO dichiara di se', e non da quale fonte l'ha portato. Prima decideva ogni fonte
 * col suo meccanismo, e misurando 36 casi le tre non decidevano la stessa cosa: Autoscout
 * 100% di precisione (filtra sul campo), Subito mediana 82% e mai 100% (filtra sul titolo
 * scritto dal venditore), Moto.it 100% o 0% (traduce in un codice, o lascia perdere).
 */
const { test } = require('node:test');
const assert = require('node:assert');
const v = require('../backend/versione-verifica');

const ad = (variante, titolo) => ({ variante, titolo, fonte: 'subito' });

test('il campo dichiarato decide, e il titolo non lo contraddice', () => {
  assert.strictEqual(v.verifica(ad('Golf GTI Performance 2.0 TSI DSG', 'Golf'), 'GTI Performance').esito, 'confermata');

  // Il caso che rendeva sporca la colonna Subito: il titolo dice GTI, il veicolo no.
  // Cercando nel titolo — che e' quello che fa `q=` — questo annuncio passava.
  const bugiardo = v.verifica(ad('Golf 1.6 TDI Comfortline', 'Volkswagen Golf GTI look'), 'GTI');
  assert.strictEqual(bugiardo.esito, 'smentita');
  assert.strictEqual(bugiardo.dove, 'campo', 'con un campo dichiarato non si deve nemmeno guardare il titolo');
});

test('il titolo si guarda SOLO dove il campo dice "altro"', () => {
  // Misurato: l'11% degli annunci Golf ha il campo "Altro allestimento" e la versione scritta
  // nel titolo ("Golf 2.0 TSI GTI Edition 50 DSG"). Quel ripiego copre esattamente quel buco.
  const r = v.verifica(ad('Altro allestimento', 'Volkswagen Golf 2.0 TSI GTI Edition 50 DSG'), 'GTI');
  assert.strictEqual(r.esito, 'confermata');
  assert.strictEqual(r.dove, 'titolo');

  assert.strictEqual(v.verifica(ad('Altro allestimento', 'Volkswagen Golf 1.6 TDI'), 'GTI').esito, 'smentita');
  // E i segnaposto sono piu' d'uno.
  for (const s of ['Altro', 'Altro modello', 'Altro allestimento', 'non dichiarato', 'n.d.']) {
    assert.ok(v.SEGNAPOSTO.test(s), `"${s}" e' un segnaposto e va trattato come campo assente`);
  }
});

test('senza campo e senza titolo non si inventa: e\' ignota', () => {
  // "Non lo so" non e' "non e' quella": un annuncio muto non va tolto da una lista.
  assert.strictEqual(v.verifica({ variante: null, titolo: null }, 'GTI').esito, 'ignota');
  assert.strictEqual(v.verifica({ variante: 'Altro allestimento', titolo: '' }, 'GTI').esito, 'ignota');
});

test('i numeri con la virgola restano interi', () => {
  // "2.0" spezzato in "2" e "0" combacerebbe con qualunque cosa contenga un 2 e uno 0 —
  // e i nomi-versione italiani sono per due terzi fatti cosi'.
  assert.deepStrictEqual(v.parole('2.0 TDI'), ['2.0', 'tdi']);
  assert.strictEqual(v.verifica(ad('Golf 2.0 TDI', ''), '2.0').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('Golf 1.0 TSI', ''), '2.0').esito, 'smentita');
});

test('accenti e maiuscole non fanno due versioni diverse', () => {
  assert.strictEqual(v.verifica(ad('Golf GTI PERFORMANCE', ''), 'gti performance').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('500 Sport Pòp', ''), 'pop').esito, 'confermata');
});

test('niente versione chiesta, niente da smentire', () => {
  assert.strictEqual(v.verifica(ad('Golf 1.6 TDI', ''), '').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('Golf 1.6 TDI', ''), null).esito, 'confermata');
});

test('marca() conta per fonte e non toglie niente', () => {
  // Togliere qui vorrebbe dire che il browser non puo' piu' rimetterli, e la riga
  // "mostrali" non avrebbe cosa mostrare. Il totale deve restare onesto.
  const lista = [
    { fonte: 'subito', variante: 'Golf GTI Performance', titolo: '' },
    { fonte: 'subito', variante: 'Golf 1.6 TDI', titolo: '' },
    { fonte: 'autoscout', variante: 'Golf GTI', titolo: '' },
    { fonte: 'moto', variante: null, titolo: null },
  ];
  const { conto, perFonte } = v.marca(lista, 'GTI');
  assert.strictEqual(lista.length, 4, 'marca() non deve togliere elementi');
  assert.deepStrictEqual(conto, { confermata: 2, smentita: 1, ignota: 1 });
  assert.deepStrictEqual(perFonte.subito, { confermata: 1, smentita: 1, ignota: 0 });
  assert.strictEqual(perFonte.moto.ignota, 1);
  for (const x of lista) assert.ok(x.versioneEsito, 'ogni annuncio deve uscire marcato');
});

test('il browser toglie solo gli smentiti, e lo dice', () => {
  // A COMMENTI TOLTI, come le guardie di silenzi-fonti (lezione 34941e8): `mostrali` sta
  // anche in un commento di resetContesto, e questa guardia era gia' oggi soddisfatta
  // dalla prosa — la regola poteva morire nel codice con l'asserzione verde.
  const grezzo = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const app = grezzo.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
  assert.ok(/versioneEsito === 'smentita'/.test(app), 'il filtro lato browser non guarda l\'esito');
  assert.ok(/versioneEsito !== 'smentita'/.test(app), 'gli ignoti devono restare: "non lo so" non e\' "non e\' quella"');
  assert.ok(/Nascosti \$\{tolti\}/.test(app) || /Nascosti \$/.test(app),
    'quanti ne sono stati tolti deve essere scritto: nascondere in silenzio e\' l\'unica cosa che qui non si fa');
  assert.ok(/'mostrali'/.test(app), 'devono potersi rivedere: la stringa del bottone, non una parola qualunque');
});
