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
 *  - dove il comportamento congelato mi sembra un DIFETTO, il test lo dice: chi lo correggera'
 *    vedra' un rosso con scritto "era noto, aggiorna la fixture di proposito".
 *
 * Quando un test qui diventa rosso NON significa per forza che hai rotto qualcosa: significa
 * che hai cambiato un comportamento. Guarda la differenza, decidi se e' voluta, e se lo e'
 * rigenera la fixture.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const CASI = require('./fixtures/risoluzione-nomi.json');
const srv = require('../backend/server');           // non si mette in ascolto se richiesto come modulo
const crawler = require('../backend/crawler');
const mbrands = require('../backend/scrapers/motoit-brands');
const mmodels = require('../backend/scrapers/motoit-models');

// Stessa riduzione usata dal generatore: dell'entry di catalogo tiene solo cio' che identifica.
const pulisci = v => {
  if (v == null) return null;
  if (typeof v !== 'object') return v;
  if (v.nome && v.entry) return { nome: v.nome, siti: v.entry.sites || null, hasAutoscout: !!v.entry.autoscout };
  return v;
};
const uguale = (a, b, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), b, msg);

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

test(`resolveAutoscout del crawler: ${CASI.resolveAutoscout.length} casi`, () => {
  // Il crawler rifa' la risoluzione della ricerca ma SENZA narrowing ne' grafie alternative:
  // e' una divergenza voluta oggi, e questi casi la fissano perche' unificando cambierebbe il
  // volume di richieste verso AS24.
  for (const c of CASI.resolveAutoscout) {
    const p = { tipo: c.in[0], marca: c.in[1], modello: c.in[2] };
    if (c.err) { assert.throws(() => crawler._resolveAutoscout(p)); continue; }
    uguale(crawler._resolveAutoscout(p), c.out, `resolveAutoscout(${JSON.stringify(c.in)})`);
  }
});

test(`resolveMotoit del crawler: ${CASI.resolveMotoit.length} casi`, () => {
  for (const c of CASI.resolveMotoit) {
    const p = { tipo: c.in[0], marca: c.in[1], modello: c.in[2] };
    if (c.err) { assert.throws(() => crawler._resolveMotoit(p)); continue; }
    uguale(crawler._resolveMotoit(p), c.out, `resolveMotoit(${JSON.stringify(c.in)})`);
  }
});

test('motoit: le funzioni pure senza test, congelate come stanno oggi', () => {
  const fn = { versionBase: mmodels._versionBase, parseYears: mmodels._parseYears, resolveMotoitSlug: mbrands.resolveMotoitSlug };
  for (const c of CASI.motoit) {
    uguale(fn[c.fn](c.in), c.out, `${c.fn}(${JSON.stringify(c.in)})`);
  }
});

// ─── Comportamenti congelati che SEMBRANO difetti ────────────────────────────
// Non li correggo qui: prima la rete, poi le correzioni, una alla volta e misurate. Ma li
// scrivo, perche' una rete che congela un baco senza dirlo lo trasforma in una regola.

test('DA VERIFICARE — versionBase mangia il suffisso dopo il trattino', () => {
  assert.strictEqual(mmodels._versionBase('MT-07 (2021-)'), 'MT',
    'oggi "MT-07" diventa "MT": la regex toglie "-<alfanumerico>" finale. Nel dominio Moto.it '
    + 'sembra voluto (toglie la sigla di coda), ma su un nome tipo MT-07 e\' distruttivo. '
    + 'Se lo correggi, questo test va aggiornato DI PROPOSITO.');
  assert.strictEqual(mmodels._versionBase('Caballero-Rally-500'), 'Caballero-Rally');
});

test('DA VERIFICARE — parseYears perde l\'anno di inizio sui periodi aperti', () => {
  assert.deepStrictEqual(mmodels._parseYears('(2015-)'), { annoMin: null, annoMax: null },
    'un periodo aperto "(2015-)" dovrebbe dare annoMin 2015; oggi da\' due null, quindi una '
    + 'moto ancora in produzione non porta l\'anno di inizio. Congelato, non approvato.');
  assert.deepStrictEqual(mmodels._parseYears('(1998-02)'), { annoMin: 1998, annoMax: 2002 },
    'la ricostruzione dell\'anno a due cifre invece funziona');
});

test('DA VERIFICARE — il pari merito dipende dall\'ordine dell\'elenco', () => {
  const { makeModelResolver } = require('../backend/scrapers/brand-match');
  const a = makeModelResolver([{ name: '320d', value: 'D' }, { name: '320i', value: 'I' }]);
  const b = makeModelResolver([{ name: '320i', value: 'I' }, { name: '320d', value: 'D' }]);
  assert.strictEqual(a('320'), 'D');
  assert.strictEqual(b('320'), 'I');
  assert.notStrictEqual(a('320'), b('320'),
    'stessa domanda, stesso insieme di candidati, risposta diversa secondo l\'ordine: '
    + 'basta un sort a monte per cambiare gli annunci mostrati, e nulla lo segnala.');
});
