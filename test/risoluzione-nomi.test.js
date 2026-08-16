'use strict';
/**
 * RETE DI CARATTERIZZAZIONE sulla risoluzione marca/modello.
 *
 * A cosa serve, e a cosa NON serve. Questi test non dicono che il comportamento sia GIUSTO:
 * dicono che e' ANCORA QUELLO. Sono la rete da tendere prima di unificare i quattordici punti
 * del repo che accoppiano un nome cercato a una voce di catalogo, perche' meta' di quei
 * percorsi non aveva una sola asserzione e un refactor li avrebbe cambiati in silenzio.
 *
 * Come sono stati fatti, e perche' cosi':
 *  - i valori attesi li ha GENERATI IL CODICE (scripts di generazione in scratchpad, output
 *    congelato in test/fixtures/risoluzione-nomi.json il 2026-07-25). Se li avessi scritti a
 *    mano avrei congelato la mia convinzione su cosa fa il codice, non cosa fa davvero;
 *  - gli input vengono dai DATI VERI (data/models.json, data/model-groups.json, i nomi-bike di
 *    Moto.it), non da esempi inventati, che tendono a essere comodi;
 *  - dove il comportamento congelato sembrava un DIFETTO l'ho verificato sui dati reali invece
 *    di correggerlo a intuito: dei tre sospetti segnalati il 2026-07-25, due erano miei esempi
 *    sintetici (la forma non esiste nel dominio) e uno era vero ed e' stato corretto. In fondo
 *    al file c'e' la misura, non l'opinione.
 *
 * Quando un test qui diventa rosso NON significa per forza che hai rotto qualcosa: significa
 * che hai cambiato un comportamento. Guarda la differenza, decidi se e' voluta, e se lo e'
 * rigenera la fixture.
 */
// Il log NON va nel registro operativo vero: questo file requira server.js (o un modulo
// che lo tira dentro), e server.js installa il tee su file. Senza questa riga ogni run
// appendeva a data/logs/amr.log, righe ERROR comprese, e con la rotazione a 5 MB poteva
// far ruotare il log vero. Deve stare PRIMA di ogni require di backend: LOG_DIR e' una
// const valutata al caricamento del modulo.
const os = require('node:os'), fsTmp = require('node:fs'), pathTmp = require('node:path');
process.env.AMR_LOG_DIR = fsTmp.mkdtempSync(pathTmp.join(os.tmpdir(), 'amr-log-'));

const { test } = require('node:test');
const assert = require('node:assert');

const CASI = require('./fixtures/risoluzione-nomi.json');
const srv = require('../backend/server');           // non si mette in ascolto se richiesto come modulo
const mbrands = require('../backend/scrapers/motoit-brands');
const mmodels = require('../backend/scrapers/motoit-models');

// Stessa riduzione usata dal generatore: dell'entry di catalogo tiene solo cio' che identifica.
const pulisci = v => {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if (v.nome && v.entry) return { nome: v.nome, siti: v.entry.sites || null, hasAutoscout: !!v.entry.autoscout };
  return v;
};
// Il guard sulla Promise non e' teoria: i sei casi di resolveMotoit hanno passato per un giorno
// intero senza asserire niente, perche' JSON.stringify di una Promise e' "{}" e "{}" era proprio
// il valore congelato. Qui si rompe subito, invece che tacere.
const uguale = (a, b, msg) => {
  assert.ok(!(a && typeof a.then === 'function'), 'valore non atteso: e\' una Promise, manca un await — ' + msg);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, msg);
};

test('richiedere server.js non avvia niente', () => {
  assert.strictEqual(srv.server, null, 'require.main !== module → nessun listen');
  assert.strictEqual(typeof srv._lookupBrand, 'function');
  assert.strictEqual(typeof srv._lookupModelGroup, 'function');
});

test(`lookupBrand: ${CASI.lookupBrand.length} casi dal catalogo vero`, () => {
  for (const c of CASI.lookupBrand) {
    uguale(pulisci(srv._lookupBrand(c.in[0], c.in[1])), c.out, `lookupBrand(${JSON.stringify(c.in)})`);
  }
  // Cio' che questi casi difendono, detto a parole: gli alias risolvono, le marche inesistenti
  // tornano null, e il nome esteso Mercedes-Benz aggancia il catalogo.
  assert.ok(CASI.lookupBrand.some(c => c.out === null), 'serve almeno un caso che NON risolve');
});

test(`lookupModelGroup: ${CASI.lookupModelGroup.length} casi (serie commerciali)`, () => {
  for (const c of CASI.lookupModelGroup) {
    uguale(srv._lookupModelGroup(c.in[0], c.in[1], c.in[2]), c.out, `lookupModelGroup(${JSON.stringify(c.in)})`);
  }
  const rispondono = CASI.lookupModelGroup.filter(c => c.out);
  assert.ok(rispondono.length >= 5, 'se scende sotto 5 il gruppo-serie ha smesso di funzionare');
  // "Serie 3" e "Classe A" sono NOMI COMMERCIALI che si espandono nei membri: e' il meccanismo
  // con cui la ricerca copre "cerco la Serie 3" senza che "Serie 3" sia un modello a catalogo.
  const s3 = rispondono.find(c => c.in[2] === 'Serie 3');
  assert.ok(s3 && s3.out.includes('320'), 'Serie 3 deve contenere 320');
  const ca = rispondono.find(c => c.in[2] === 'Classe A');
  assert.ok(ca && ca.out.includes('A 180'), 'Classe A deve contenere A 180');
});

// I due casi `resolveAutoscout` / `resolveMotoit` che stavano qui provavano backend/crawler.js,
// cancellato insieme a Postgres e al worker. La fixture li contiene ancora: se un giorno una
// risoluzione del genere tornasse, i valori congelati sono ancora in
// test/fixtures/risoluzione-nomi.json e non vanno rigenerati.

test('motoit: le funzioni pure senza test, congelate come stanno oggi', () => {
  const fn = { versionBase: mmodels._versionBase, parseYears: mmodels._parseYears, resolveMotoitSlug: mbrands.resolveMotoitSlug };
  for (const c of CASI.motoit) {
    uguale(fn[c.fn](c.in), c.out, `${c.fn}(${JSON.stringify(c.in)})`);
  }
});

// ─── I tre comportamenti marcati DA VERIFICARE, verificati ───────────────────
// Misurati il 2026-07-25 su 272 nomi-bike VERI presi dall'API Moto.it (6 marche). Esito: due
// dei tre "difetti" non esistono nel dominio reale — erano miei esempi sintetici — e il terzo
// era vero ed e' stato corretto. La misura resta scritta qui, perche' e' cio' che rende una
// scelta difendibile fra sei mesi.

test('versionBase: il taglio finale toglie SOLO codici di fabbrica (misurato)', () => {
  // Su 272 nomi-bike reali il taglio "-<alfanumerico>" scatta 118 volte, TUTTE su
  // Harley-Davidson, e cio' che toglie e' sempre un codice maiuscolo di fabbrica
  // (66 distinti: FLHXSE, FXSBSE, FLHTCUSE...). Zero eccezioni.
  assert.strictEqual(mmodels._versionBase('110 Street Glide (2016) - FLHXSE'), '110 Street Glide');
  assert.strictEqual(mmodels._versionBase('1800 Breakout (2012 - 14) - FXSBSE'), '1800 Breakout');
  // I nomi senza codice restano interi: il taglio non e' goloso.
  assert.strictEqual(mmodels._versionBase('ADV 350 Special Edition (2025 - 26)'), 'ADV 350 Special Edition');
  assert.strictEqual(mmodels._versionBase("Bw's 50 N.G. (1996 - 99)"), "Bw's 50 N.G.");
  assert.strictEqual(mmodels._versionBase('V-Strom 1050SE'), 'V-Strom 1050SE', 'niente trattino finale, niente taglio');

  // Il caso che TEMEVO ("MT-07" ridotto a "MT") non e' raggiungibile: versionBase riceve solo
  // nomi-BIKE, e fra i 272 misurati NESSUNO finisce con lettera-cifre. "MT-07" e' un nome di
  // FAMIGLIA, e le famiglie non passano di qui. Il comportamento resta quello, dichiarato:
  assert.strictEqual(mmodels._versionBase('MT-07 (2021-)'), 'MT',
    'su una stringa cosi\' il taglio sarebbe distruttivo, ma questa forma non arriva mai qui: '
    + 'se un giorno arrivasse, questo test e\' il posto dove accorgersene.');
});

test('parseYears: copre i formati che Moto.it usa davvero (misurato)', () => {
  // Formati contati sui 272 nomi: "(NNNN - NN)" ×228, "(NNNN)" ×39, "(NNNN - NNNN)" ×1.
  assert.deepStrictEqual(mmodels._parseYears('Aerox 50 (1999 - 07)'), { annoMin: 1999, annoMax: 2007 });
  assert.deepStrictEqual(mmodels._parseYears('ADV 350 (2022 - 24)'), { annoMin: 2022, annoMax: 2024 });
  assert.deepStrictEqual(mmodels._parseYears('Monster (2019)'), { annoMin: 2019, annoMax: 2019 });
  assert.deepStrictEqual(mmodels._parseYears('X (2010 - 2014)'), { annoMin: 2010, annoMax: 2014 });
  // La ricostruzione del secolo, che e' la parte non ovvia: "98-02" attraversa il 2000.
  assert.deepStrictEqual(mmodels._parseYears('(1998-02)'), { annoMin: 1998, annoMax: 2002 });

  // Il periodo APERTO "(2015-)" che avevo segnalato NON compare nei dati reali (zero su 272):
  // Moto.it scrive sempre un anno di fine, anche per i modelli in produzione. Il ritorno a due
  // null resta quindi la risposta giusta per una stringa che non e' un periodo riconosciuto.
  assert.deepStrictEqual(mmodels._parseYears('(2015-)'), { annoMin: null, annoMax: null });
  assert.deepStrictEqual(mmodels._parseYears('(FLHRSEI)'), { annoMin: null, annoMax: null },
    'nei dati veri esiste anche un codice dentro le parentesi: non deve diventare un anno');
});

test('CORRETTO — il pari merito ora e\' stabile, non dipende dall\'ordine', () => {
  const { makeModelResolver } = require('../backend/scrapers/brand-match');
  const a = makeModelResolver([{ name: '320d', value: 'D' }, { name: '320i', value: 'I' }]);
  const b = makeModelResolver([{ name: '320i', value: 'I' }, { name: '320d', value: 'D' }]);
  assert.strictEqual(a('320'), b('320'),
    'stessa domanda, stessi candidati: la risposta non puo\' dipendere da come e\' ordinato l\'elenco');
  assert.strictEqual(a('320'), 'D', 'a parita\' di distanza vince il nome alfabeticamente minore');

  // Tre candidati equidistanti: stabile in qualunque ordine arrivino.
  const perm = [
    [{ name: 'RS Q3', value: 3 }, { name: 'RS Q8', value: 8 }],
    [{ name: 'RS Q8', value: 8 }, { name: 'RS Q3', value: 3 }],
  ].map(l => makeModelResolver(l)('rsq'));
  assert.strictEqual(perm[0], perm[1], 'RS Q3 / RS Q8: stessa risposta in entrambi gli ordini');

  // Il caso esatto continua a vincere sul prefisso: la correzione non ha allentato nulla.
  assert.strictEqual(makeModelResolver([{ name: '320', value: 'X' }, { name: '320d', value: 'D' }])('320'), 'X');
});
