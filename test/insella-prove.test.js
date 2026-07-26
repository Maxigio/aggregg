'use strict';
/**
 * Prove di inSella — la quinta fonte del catalogo, e la prima con MISURE sulle moto.
 *
 * Qui si difende il PARSING, che e' la parte fragile: una pagina prova porta sei blocchi diversi
 * (ld+json Vehicle, ld+json Article, tre tabelle e un elenco di voti) e nessuno di questi ha una
 * classe CSS dedicata su cui appoggiarsi. Le fixture sono pagine VERE del 2026-07-26, tagliate ai
 * soli frammenti che il parser usa: i test girano offline e non toccano la rete.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const r = require('../backend/scrapers/insella-prove');

const leggi = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const PROVA = leggi('insella-prova.html');
const CATEGORIA = leggi('insella-categoria.html');
const MARCHE = leggi('insella-marche.html');
const VECCHIA = leggi('insella-prova-vecchia.html');
const v = r._mappaProva(PROVA, 'aprilia-tuono-457-2025');
const vecchia = r._mappaProva(VECCHIA, 'adiva-ar-200-roadster-2010');

test('num(): i due formati numerici che convivono nella stessa pagina', () => {
  // Le tabelle scrivono all'italiana, il ld+json all'inglese. Trattare il punto sempre da
  // separatore di migliaia faceva diventare 46 il voto 4.6; sempre da decimale avrebbe reso
  // 9,2 i 9.200 giri. Questo test e' la ragione per cui num() guarda la forma.
  assert.strictEqual(r._num('176,6'), 176.6, 'virgola = decimale');
  assert.strictEqual(r._num('9.200'), 9200, 'punto che raggruppa a tre = migliaia');
  assert.strictEqual(r._num('4.6'), 4.6, 'punto con una cifra = decimale (ld+json)');
  assert.strictEqual(r._num('1.234,5'), 1234.5, 'i due insieme');
  assert.strictEqual(r._num('45,93'), 45.93);
  assert.strictEqual(r._num('-'), null, 'il trattino della fonte non e uno zero');
  assert.strictEqual(r._num(''), null);
  assert.strictEqual(r._num('a disco di 320 mm'), null, 'un testo non e un numero');
});

test('anagrafica: i campi che stanno SOLO nel ld+json e non nelle tabelle', () => {
  assert.strictEqual(v.marca, 'Aprilia');
  assert.strictEqual(v.modello, 'Tuono 457');
  assert.strictEqual(v.anno, '2025');
  assert.strictEqual(v.prezzoListino, 6599, 'il prezzo di listino non e in nessuna tabella');
  assert.deepStrictEqual(v.valutazione, { voto: 4.6, voti: 66 });
  assert.strictEqual(v.classeEmissioni, 'Euro 5+');
  assert.strictEqual(v.cambio, 'meccanico');
  assert.strictEqual(v.marce, 6);
  assert.strictEqual(v.cilindrata, 457);
  assert.strictEqual(v.potenzaDichiarataCv, 47.58, 'il ld porta i CV moltiplicati per cento');
  // La coppia ha un codice unita che non interpretiamo a naso: si espone grezza col suo codice.
  assert.deepStrictEqual(v.coppia, { valore: 435, unita: 'F17' });
});

test('misure: il motivo per cui questa fonte esiste', () => {
  assert.strictEqual(v.misure.velocitaMax, 176.6);
  assert.deepStrictEqual(v.misure.potenzaRuota, { cv: 45.93, kw: 34.25, giri: 9200 });
  assert.strictEqual(v.misure.acc['0-100 km/h'], 4.6);
  assert.strictEqual(v.misure.acc['0-400 metri'], 13.3);
  assert.strictEqual(v.misure.ripresa['400 metri'], 14);
  assert.strictEqual(v.misure.frenata['Da 100 km/h'], 38.3);
  assert.strictEqual(Object.keys(v.misure.consumi).length, 5, 'cinque condizioni di consumo');
  assert.strictEqual(v.misure.autonomia['Al massimo'], 143);
});

test('le sezioni della tabella non si confondono fra loro', () => {
  // "A 120 km/h" compare DUE volte: una sotto Consumi (21,3 km/l) e una sotto Autonomia (256 km).
  // Senza tenere il titolo di sezione corrente, il secondo sovrascriveva il primo.
  assert.strictEqual(v.misure.consumi['A 120 km/h'], 21.3);
  assert.strictEqual(v.misure.autonomia['A 120 km/h'], 256);
});

test('i consumi diventano l/100 km, l\'unita del resto dell\'app', () => {
  assert.strictEqual(v.misure.consumiL100['Autostrada'], 4.29);
  assert.strictEqual(v.misure.consumiL100['Al massimo'], 8.4);
  assert.strictEqual(r._per100(0), null);
  assert.strictEqual(r._per100(null), null);
});

test('dichiarato contro misurato: la differenza si puo calcolare', () => {
  assert.strictEqual(v.dichiarati['Potenza CV(kW)/giri'], '47,6(35)/9.400');
  assert.ok(v.misure.potenzaRuota.cv < v.potenzaDichiarataCv,
    'alla ruota si misura meno che all\'albero: se si invertisse, il parsing ha scambiato le tabelle');
  const perdita = 100 - 100 * v.misure.potenzaRuota.cv / v.potenzaDichiarataCv;
  assert.ok(perdita > 0 && perdita < 30, `perdita di trasmissione fuori scala: ${perdita.toFixed(1)}%`);
});

test('le tre tabelle si riconoscono dal contenuto, non dalla posizione', () => {
  assert.strictEqual(Object.keys(v.dichiarati).length, 14);
  assert.strictEqual(v.dichiarati['Motore'], '4 tempi bicilindrico');
  assert.strictEqual(v.dichiarati['Freno anteriore'], 'a disco di 320 mm');
  assert.deepStrictEqual(v.dimensioniRilevate, { Passo: 135, Lunghezza: 195, 'Altezza sella': 80 });
});

test('le discrepanze fra le fonti restano visibili, non appianate', () => {
  // Stessa moto: 159 kg dichiarati (a secco) e 175 dal ld+json (massa totale); serbatoio 12 e 13.
  // Sono grandezze diverse: sceglierne una e spacciarla per l'unica sarebbe una bugia comoda.
  assert.strictEqual(v.dichiarati['Peso (kg)'], '159');
  assert.strictEqual(v.pesoTotaleLd, 175);
  assert.strictEqual(v.dichiarati['Capacità serbatoio (litri)'], '12');
  assert.strictEqual(v.serbatoioLd, 13);
});

test('i voti: undici dimensioni, e il blocco duplicato non le raddoppia', () => {
  // Il markup ripete l'elenco per desktop e mobile: senza deduplica uscivano 22 voci.
  assert.strictEqual(Object.keys(v.voti).length, 11);
  assert.strictEqual(v.voti['Voto medio'], 4);
  assert.strictEqual(v.voti['Tenuta di strada'], 5);
  assert.strictEqual(v.voti['Vano sottosella'], 2, 'i voti bassi servono quanto quelli alti');
});

test('metodologia, testi e foto: il contorno che rende il numero credibile', () => {
  assert.match(v.metodoDiMisura, /Acquisizione dati/, 'senza il metodo, e un numero e basta');
  assert.match(v.metodoDiMisura, /Dynojet/, 'il banco prova va nominato');
  assert.strictEqual(v.autore, 'Guido Sassi');
  assert.match(v.dataProva, /^2026-05-02/);
  assert.ok(v.sommario && v.sommario.length > 40);
  assert.ok(v.inSintesi && v.inSintesi.length > 500);
  assert.ok(v.comeVa && v.comeVa.length > 500);
  assert.ok(v.foto.length >= 10, 'la galleria e parte del dato');
  for (const u of v.foto) {
    assert.match(u, /^https:\/\/immagini\.insella\.it\//);
    assert.match(u, /\/styles\/(1240w|2480w)/, 'solo le risoluzioni grandi');
    assert.doesNotMatch(u, /\/field\//, 'niente foto degli autori nella galleria');
  }
});

test('indice categoria: si leggono le prove, non le categorie', () => {
  const p = r._proveDaIndice(CATEGORIA, 'naked');
  assert.ok(p.length >= 20, `attese almeno 20 prove, trovate ${p.length}`);
  for (const x of p) {
    assert.match(x.slug, /\d{4}$|\d{4}-\d$/, 'lo slug di una prova finisce con l\'anno');
    assert.strictEqual(x.categoria, 'naked');
  }
  // "/prova/naked" e "/prova/stradali" sono categorie, non prove: non devono entrare.
  assert.ok(!p.some(x => r._CATEGORIE.includes(x.slug)), 'nessuna categoria scambiata per prova');
});

test('indice marche: 246 voci con nome pulito', () => {
  const m = r._marcheDaIndice(MARCHE);
  assert.strictEqual(m.length, 246);
  assert.ok(m.some(x => x.acronimo === 'aprilia' && x.nome === 'Aprilia'));
  assert.ok(m.some(x => x.acronimo === 'moto-guzzi'));
  const nomi = m.map(x => x.nome);
  assert.deepStrictEqual(nomi, [...nomi].sort((a, b) => a.localeCompare(b, 'it')), 'ordine alfabetico italiano');
});

test('marca di una prova: vince il prefisso PIU LUNGO', () => {
  // Senza questa regola "moto-guzzi-v7-2024" finirebbe sotto la marca "moto" e
  // "royal-enfield-guerrilla-2025" sotto "royal".
  const slugs = ['aprilia', 'moto', 'moto-guzzi', 'royal', 'royal-enfield', 'ktm'];
  assert.strictEqual(r._marcaDiSlug('moto-guzzi-v7-2024', slugs), 'moto-guzzi');
  assert.strictEqual(r._marcaDiSlug('royal-enfield-guerrilla-2025', slugs), 'royal-enfield');
  assert.strictEqual(r._marcaDiSlug('aprilia-tuono-457-2025', slugs), 'aprilia');
  assert.strictEqual(r._marcaDiSlug('marca-che-non-esiste-2025', slugs), null);
});

// ─── Il formato delle prove VECCHIE, che e' diverso ─────────────────────────
test('prova del 2010: una cella vuota in mezzo non fa perdere il dato dopo', () => {
  // Nella tabella consumi della Adiva la riga "A 120 km/h" NON ha valore. Finche' il parser
  // trattava ogni cella vuota come inizio di sezione, da li' in poi "Al massimo" finiva in una
  // sezione inesistente e spariva: il consumo peggiore, quello che serve di piu', era l'unico
  // a mancare. Ora il titolo di sezione si riconosce dall'etichetta.
  assert.strictEqual(vecchia.misure.consumi['Al massimo'], 11.4, 'il consumo dopo la cella vuota');
  assert.strictEqual(Object.keys(vecchia.misure.consumi).length, 4);
  assert.strictEqual(vecchia.misure.consumi['A 120 km/h'], undefined, 'quella cella e davvero vuota');
  // L'autonomia ha la sua intestazione, quindi non era mai stata toccata: resta com'era.
  assert.deepStrictEqual(vecchia.misure.autonomia, { 'A 120 km/h': 278, 'Al massimo': 173 });
});

test('prova del 2010: i CV alla ruota senza i kW non diventano NaN', () => {
  // Le prove nuove scrivono "45,93/34,25", le vecchie solo "12,4". Il kW mancante e' della fonte.
  assert.deepStrictEqual(vecchia.misure.potenzaRuota, { cv: 12.4, kw: null, giri: 2206 });
  assert.strictEqual(v.misure.potenzaRuota.kw, 34.25, 'sul formato nuovo i kW ci sono');
});

test('prova del 2010: il resto della scheda si legge lo stesso', () => {
  assert.strictEqual(vecchia.marca, 'Adiva');
  assert.strictEqual(vecchia.misure.velocitaMax, 108);
  assert.deepStrictEqual(vecchia.misure.ripresa, { '400 metri': 17.5, '1000 metri': 38.4 });
  assert.ok(Object.keys(vecchia.dichiarati).length >= 10);
  assert.match(vecchia.metodoDiMisura, /Acquisizione dati/);
});

test('mappaProva regge una pagina che non e una prova', () => {
  const vuoto = r._mappaProva('<html><body>niente</body></html>', 'x');
  assert.strictEqual(vuoto.misure.velocitaMax, null);
  assert.deepStrictEqual(vuoto.dichiarati, {});
  assert.deepStrictEqual(vuoto.voti, {});
  assert.strictEqual(vuoto.prezzoListino, null);
  assert.strictEqual(vuoto.slug, 'x', 'lo slug resta, cosi il chiamante sa di cosa parla');
});
