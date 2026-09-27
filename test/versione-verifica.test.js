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

test('una lettera e\' una versione: Ducati 1098 R non e\' Ducati 1098 S', () => {
  assert.strictEqual(v.verifica(ad('S', 'Ducati 1098 S'), 'R').esito, 'smentita');
  assert.strictEqual(v.verifica(ad('R', 'Ducati 1098 R'), 'R').esito, 'confermata');
  // La corrispondenza per sottoinsieme resta: R include R Troy Bayliss.
  assert.strictEqual(v.verifica(ad('R Troy Bayliss', ''), 'R').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('Factory', ''), 'R Factory').esito, 'smentita');
});

test('una lettera nel solo titolo non prova la versione', () => {
  assert.strictEqual(v.verifica(ad(null, 'BMW R 1200 GS'), 'R').esito, 'ignota');
  assert.strictEqual(v.verifica(ad(null, 'Aprilia RSV 1000 R Factory'), 'R Factory').esito, 'ignota');
  assert.strictEqual(v.verifica(ad(null, 'Aprilia RSV 1000 R'), 'R Factory').esito, 'smentita');
  assert.strictEqual(v.verifica(ad(null, 'Golf GTI'), 'GTI').esito, 'confermata');
});

test('i numeri con la virgola restano interi', () => {
  // "2.0" spezzato in "2" e "0" combacerebbe con qualunque cosa contenga un 2 e uno 0 —
  // e i nomi-versione italiani sono per due terzi fatti cosi'.
  assert.deepStrictEqual(v.parole('2.0 TDI'), ['2.0', 'tdi']);
  assert.strictEqual(v.verifica(ad('Golf 2.0 TDI', ''), '2.0').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('Golf 1.0 TSI', ''), '2.0').esito, 'smentita');
});

test('virgola e punto decimali sono equivalenti solo nel confronto locale', () => {
  assert.deepStrictEqual(v.parole('2,0 TDI'), ['2.0', 'tdi']);
  assert.deepStrictEqual(v.parole('23,8 kWh'), ['23.8', 'kwh']);
  assert.strictEqual(v.verifica(ad('2.0 TDI', ''), '2,0 TDI').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('2,0 TDI', ''), '2.0 TDI').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('23.8 kWh Action', ''), '23,8 kWh Action').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('Altro allestimento', 'Golf 2.0 TDI'), '2,0 TDI').esito, 'confermata');
  assert.strictEqual(v.verifica(ad('1.0 TDI', ''), '2,0 TDI').esito, 'smentita');
  assert.strictEqual(v.verifica(ad('2.0 TDI S', ''), '2,0 TDI R').esito, 'smentita');
  assert.deepStrictEqual(v.parole('2, 0 TDI'), ['2', '0', 'tdi'], 'una virgola non decimale resta separatore');
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

test('sigla nel modello: il campo nativo Subito distingue R, S e versione assente', () => {
  const { risolviNodo } = require('../backend/scrapers/subito-nodo');
  const lista = [
    ad('R', 'Ducati 748 R'),
    ad('S', 'Ducati 748 S'),
    ad(null, 'Ducati 748 S'),
    ad(null, 'Ducati 748 R'),
    ad(null, 'Ducati 748 R/S'),
    ad(null, 'Ducati 748 Superbike'),
    { fonte: 'autoscout', variante: 'S', titolo: 'Ducati 748 S' },
  ];
  const { conto } = v.marcaRicerca(lista, '', risolviNodo('moto', 'Ducati', '748 R'));
  assert.deepStrictEqual(conto, { confermata: 2, smentita: 2, ignota: 2 });
  assert.deepStrictEqual(lista.slice(0, 6).map(r => r.versioneEsito),
    ['confermata', 'smentita', 'smentita', 'confermata', 'ignota', 'ignota']);
  assert.equal(lista[6].versioneEsito, undefined, 'il modello su AS24 non e\' la versione Subito');
  assert.equal(lista.length, 7, 'nessun annuncio grezzo viene eliminato');
  const normale = [{ fonte: 'subito', variante: 'S', titolo: 'Ducati 748 S' }];
  assert.equal(v.marcaRicerca(normale, '', risolviNodo('moto', 'Ducati', '748')), null);
  assert.equal(normale[0].versioneEsito, undefined, 'la famiglia senza sigla non va filtrata');
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

test('una versione ignota non diventa «corrisponde» negli export', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const start = app.indexOf('const DICHIARAZIONE =');
  const end = app.indexOf('function avvisiAnnuncio(', start);
  assert.ok(start >= 0 && end > start);
  const ctx = {};
  vm.runInNewContext(app.slice(start, end) + '\nthis.corrispondenzaDi = corrispondenzaDi;', ctx);
  assert.strictEqual(ctx.corrispondenzaDi({ versioneEsito: 'ignota', dichiarazione: 'esatto' }).et, 'versione non verificata');
  assert.strictEqual(ctx.corrispondenzaDi({ versioneEsito: 'smentita', dichiarazione: 'esatto' }).et, 'non e\' quella versione');
  assert.strictEqual(ctx.corrispondenzaDi({ versioneEsito: 'ignota', dichiarazione: 'altro-modello' }).et, 'altro modello');
});

test('gli avvisi di modello e versione condividono un pulsante fuori dal titolo', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const start = app.indexOf('const DICHIARAZIONE =');
  const end = app.indexOf('function rowHTML(', start);
  assert.ok(start >= 0 && end > start);
  const ctx = {};
  vm.runInNewContext('const escapeHtml = s => s; const icon = () => "<svg></svg>";\n' + app.slice(start, end)
    + '\nthis.avvisiAnnuncio = avvisiAnnuncio; this.avvisiPulsanteHTML = avvisiPulsanteHTML;', ctx);
  const ignota = { versioneEsito: 'ignota', dichiarazione: 'esatto' };
  assert.strictEqual(ctx.avvisiAnnuncio(ignota)[0].titolo, 'Versione non verificata');
  assert.match(ctx.avvisiPulsanteHTML(ignota), /class="row-act btn-avvisi"/);
  assert.doesNotMatch(ctx.avvisiPulsanteHTML(ignota), /title=/);
  const doppio = { versioneEsito: 'ignota', dichiarazione: 'senza-modello' };
  assert.deepStrictEqual(Array.from(ctx.avvisiAnnuncio(doppio), a => a.titolo),
    ['Modello non dichiarato', 'Versione non verificata']);
  assert.match(ctx.avvisiPulsanteHTML(doppio), /Avvisi sull'annuncio: 2/);
  assert.match(ctx.avvisiPulsanteHTML({ versioneEsito: 'smentita', dichiarazione: 'altro-modello' }), /btn-avvisi critico/);
  assert.strictEqual(ctx.avvisiPulsanteHTML({ versioneEsito: 'confermata', dichiarazione: 'esatto' }), '');
  const row = app.slice(app.indexOf('function rowHTML('), app.indexOf('function vistaChipsRender('));
  const card = app.slice(app.indexOf('function cardHTML('), app.indexOf('function ridisegnaTenendoAperti('));
  for (const html of [row, card]) {
    assert.match(html, /<div class="row-actions\$\{avvisiBtn/);
    assert.doesNotMatch(html, /\$\{dichBadgeHTML/);
  }
});
