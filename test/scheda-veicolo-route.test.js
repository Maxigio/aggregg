'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { matchModel } = require('../backend/scheda-veicolo-route');

test('matchModel: esatto sul nome pulito dagli anni', () => {
  const models = [{ name: 'Golf 1974 -', slug: 'g' }];
  assert.strictEqual(matchModel(models, 'Golf').slug, 'g');
});

test('matchModel: nome corto (A3) via esatto', () => {
  const models = [{ name: 'A3 2003 -', slug: 'a3' }];
  assert.strictEqual(matchModel(models, 'A3').slug, 'a3');
});

test('matchModel: prefisso mono-direzionale — "Classe A" NON matcha "CLA"', () => {
  const models = [{ name: 'CLA', slug: 'cla' }];
  assert.strictEqual(matchModel(models, 'Classe A'), null);   // query non è prefisso del candidato
});

test('matchModel: query prefisso del candidato', () => {
  const models = [{ name: 'Golf 1974 -', slug: 'g' }];
  assert.strictEqual(matchModel(models, 'Gol').slug, 'g');
});

test('matchModel: a parità di prefisso vince il nome più corto', () => {
  const models = [{ name: 'Golf Plus', slug: 'plus' }, { name: 'Golf', slug: 'base' }];
  assert.strictEqual(matchModel(models, 'Golf').slug, 'base');   // esatto batte il prefisso più lungo
});

// ── Scheda moto: match modello su ultimatespecs ───────────────────────────────
// ultimatespecs nomina le voci come base+VARIANTE(+cilindrata) e spesso non ha la voce
// base: "Caballero-Rally-500" esiste, "Caballero 500" no. Il solo prefisso non bastava.
const { matchMotoModels, resolveMoto } = require('../backend/scheda-veicolo-route');
const M = (...labels) => Object.fromEntries(labels.map(l => [l.toLowerCase().replace(/[^a-z0-9]/g, ''), { label: l, items: [[2022, 'x']] }]));

test('matchMotoModels: esatto e prefisso (comportamento storico invariato)', () => {
  const mm = M('MT-07', 'MT-07-ABS', 'MT-09');
  assert.deepStrictEqual(matchMotoModels(mm, 'MT-07').map(x => x.label), ['MT-07', 'MT-07-ABS']);
  assert.deepStrictEqual(matchMotoModels(mm, 'MT-09').map(x => x.label), ['MT-09']);
});

test('matchMotoModels: il prefisso non sfonda su una cifra ("R1" non pesca "R15")', () => {
  assert.deepStrictEqual(matchMotoModels(M('R15', 'R1-M'), 'R1').map(x => x.label), ['R1-M']);
});

test('matchMotoModels: variante INTERCALATA → recuperata dal ripiego a token', () => {
  const mm = M('Caballero-Rally-500', 'Caballero-Deluxe-500', 'Caballero-Deluxe-125');
  const r = matchMotoModels(mm, 'Caballero 500').map(x => x.label).sort();
  assert.deepStrictEqual(r, ['Caballero-Deluxe-500', 'Caballero-Rally-500']);   // la 125 resta fuori
});

test('matchMotoModels: token a confine-parola → "Pegaso 50" NON prende "Pegaso-650"', () => {
  assert.deepStrictEqual(matchMotoModels(M('Pegaso-650'), 'Pegaso 50'), []);
});

test('matchMotoModels: sigla-serie dichiarata → non attraversa un altra serie', () => {
  assert.deepStrictEqual(matchMotoModels(M('K-1300-R'), 'R 1300 R'), []);        // K non è R
  assert.deepStrictEqual(matchMotoModels(M('R-1300-R'), 'R 1300 R').map(x => x.label), ['R-1300-R']);
  assert.deepStrictEqual(matchMotoModels(M('R-100-CS'), '100 CS').map(x => x.label), ['R-100-CS']);   // query senza sigla → ok
});

test('matchMotoModels: il ripiego scatta SOLO se il prefisso non trova nulla', () => {
  const mm = M('Scarabeo-100', 'Scarabeo-100-4T', 'Sportcity-100');
  // Trovato l'esatto → il ripiego NON gira, quindi "Sportcity-100" (che pure contiene il
  // token "100") resta fuori: è la garanzia che nessun match già funzionante si allarghi.
  // Nota: "Scarabeo-100-4T" resta escluso dal guard storico sulle cifre (quello che
  // impedisce "R1"→"R15"), non dal ripiego. Limite noto, invariato.
  assert.deepStrictEqual(matchMotoModels(mm, 'Scarabeo-100').map(x => x.label), ['Scarabeo-100']);
});

test('matchMotoModels: query vuota → nessun match', () => {
  assert.deepStrictEqual(matchMotoModels(M('MT-07'), ''), []);
  assert.deepStrictEqual(matchMotoModels(M('MT-07'), null), []);
});

// Sul catalogo REALE (data/ultimatespecs-moto-index.json, file versionato): difende i due
// difetti segnalati dall'utente. Se l'indice viene rigenerato, questi numeri possono variare.
test('resolveMoto: il titolo NON inventa una variante (era "800MT-Sport")', () => {
  const r = resolveMoto({ marca: 'CFMOTO', modello: '800MT' });
  assert.strictEqual(r.modello, '800MT');                       // prima: "800MT-Sport"
  assert.ok(!/sport/i.test(r.title), 'il titolo non deve dire Sport');
  assert.strictEqual(r.motorizzazioni.length, 2);               // la fonte ha solo Sport e Touring
});

test('resolveMoto: "Caballero 500" ora ha una scheda (prima notFound)', () => {
  const r = resolveMoto({ marca: 'Fantic', modello: 'Caballero 500' });
  assert.ok(!r.notFound, 'deve trovare il modello');
  assert.strictEqual(r.modello, 'Caballero 500');
  assert.ok(r.motorizzazioni.length >= 4);
  assert.ok(r.motorizzazioni.every(m => /500/.test(m.label)), 'solo varianti 500');
});

/**
 * REGRESSIONE. Con piu' candidati per prefisso si prendeva il piu' CORTO, cioe' si
 * sorteggiava: "Silverado" (1500, 2500 HD, 3500 HD, EV) finiva sulla EV e "Hover"
 * (CUV, H5, H6) sulla H5 — veicoli diversi, scheda tecnica data per giusta.
 * Un candidato solo resta la migliore risposta disponibile: nel catalogo tecnico la
 * "575M" si chiama "575M Maranello" e non esiste altrimenti.
 */
test('matchModel: piu candidati per prefisso → nessuna scheda, mai un sorteggio', () => {
  const models = [
    { name: 'Silverado 1500 2018 -', slug: 'a' },
    { name: 'Silverado 2500 HD 2019 -', slug: 'b' },
    { name: 'Silverado EV 2023 -', slug: 'c' },
  ];
  assert.strictEqual(matchModel(models, 'Silverado'), null);
});

test('matchModel: un solo candidato per prefisso resta valido', () => {
  const models = [{ name: '575M Maranello 2002 - 2006', slug: 'x' }];
  const m = matchModel(models, '575M');
  assert.ok(m && m.slug === 'x');
});

test('matchModel: la corrispondenza esatta non e toccata dalla stretta', () => {
  const models = [
    { name: 'Transit 2014 -', slug: 'big' },
    { name: 'Transit Connect 2006 -', slug: 'small' },
  ];
  const m = matchModel(models, 'Transit');
  assert.ok(m && m.slug === 'big', 'con l esatto presente vince l esatto');
});

// ── La generazione dichiarata nel nome Subito ─────────────────────────────────
const { generazioneDichiarata } = require('../backend/scheda-veicolo-route');

test('generazioneDichiarata: la parentesi vale intera, non a meta', () => {
  // "Classe C (W/S205)" sono DUE codici: W205 (berlina) e S205 (station wagon). Scartando i
  // pezzi corti restava il solo S205, e la scheda di ogni berlina Mercedes mostrava peso,
  // bagagliaio e consumi della familiare — senza che niente a schermo lo dicesse.
  assert.deepStrictEqual(generazioneDichiarata('Classe C (W/S205)').codici.sort(), ['S205', 'W205']);
  assert.deepStrictEqual(generazioneDichiarata('CLA (C/X117)').codici.sort(), ['C117', 'X117']);
  // Il gemello BMW: "91" da solo non aggancia mai "E91" (\b91\b non entra dentro E91).
  assert.deepStrictEqual(generazioneDichiarata('Serie 3 (E90/91)').codici.sort(), ['E90', 'E91']);
  assert.deepStrictEqual(generazioneDichiarata('Serie 5 (F10/11)').codici.sort(), ['F10', 'F11']);
  // Le cifre nude, quando NON c'e' un vicino con le lettere, sono il codice vero: non si tocca.
  assert.deepStrictEqual(generazioneDichiarata('Panda (169)').codici, ['169']);
  assert.deepStrictEqual(generazioneDichiarata('Classe A (W176)').codici, ['W176']);
  // Nessuna parentesi, nessun codice — e la serie in numero romano resta quello che era.
  assert.deepStrictEqual(generazioneDichiarata('Golf 5ª serie').codici, []);
  assert.strictEqual(generazioneDichiarata('Golf 5ª serie').romano, 'V');
});

// ── La famiglia moto: un solo candidato o niente ──────────────────────────────
const { famigliaMotoit } = require('../backend/scheda-veicolo-route');

test('famigliaMotoit: fra piu famiglie non si sceglie, si torna null', () => {
  // Prima vinceva il nome piu' CORTO, e a parita' di lunghezza l'ordine del catalogo: un
  // annuncio "Ducati Scrambler 800" apriva la scheda di "Scrambler 350", una moto degli anni
  // '60, con le sue specifiche presentate come quelle dell'annuncio. Misurato sui dati veri:
  // 205 nomi Subito finivano su una famiglia sorteggiata fra 2 e 12.
  const scrambler = ['Scrambler 350', 'Scrambler 400', 'Scrambler 800', 'Scrambler 1100']
    .map(name => ({ name, slug: name.toLowerCase().replace(/\s+/g, '-') }));
  assert.strictEqual(famigliaMotoit(scrambler, 'Scrambler'), null, 'quattro candidate: nessuna scelta');
  // Il nome preciso continua a vincere, ed e' il caso normale.
  assert.strictEqual(famigliaMotoit(scrambler, 'Scrambler 800').slug, 'scrambler-800');
  // Un solo candidato per prefisso resta valido: non si e' stretto piu' del necessario.
  assert.strictEqual(famigliaMotoit([{ name: 'Monster 796', slug: 'm796' }], 'Monster').slug, 'm796');
  // Nessun candidato: null come prima.
  assert.strictEqual(famigliaMotoit(scrambler, 'Panigale'), null);
});

// ── L'anno dell'annuncio contro il periodo della motorizzazione ───────────────
const { copreAnno } = require('../backend/scheda-veicolo-route');

test('copreAnno: il periodo della voce, com e scritto dal catalogo', () => {
  // Il catalogo scrive "2016–2018" col trattino lungo, "2022–" quando e' ancora in listino.
  assert.strictEqual(copreAnno({ yearRange: '2016–2018' }, 2016), true);
  assert.strictEqual(copreAnno({ yearRange: '2016–2018' }, 2018), true);
  assert.strictEqual(copreAnno({ yearRange: '2016–2018' }, 2015), false);
  assert.strictEqual(copreAnno({ yearRange: '2016–2018' }, 2019), false);
  // Fine aperta: nessun tetto.
  assert.strictEqual(copreAnno({ yearRange: '2022–' }, 2024), true);
  assert.strictEqual(copreAnno({ yearRange: '2022–' }, 2021), false);
  // Anno singolo, e il ripiego sul campo `year`.
  assert.strictEqual(copreAnno({ yearRange: '2016' }, 2017), false);
  assert.strictEqual(copreAnno({ year: 2010 }, 2010), true);
  // PERIODO IGNOTO = NON SI SCARTA. E' la regola che tiene: un formato che non sappiamo
  // leggere non deve far sparire una motorizzazione buona.
  assert.strictEqual(copreAnno({}, 2016), true);
  assert.strictEqual(copreAnno({ yearRange: 'boh' }, 2016), true);
  assert.strictEqual(copreAnno({ yearRange: '2007 - 16' }, 2010), true);
});
