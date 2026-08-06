'use strict';
// F50 fase 1: restringimento AS24 per i modelli senza codice-modello.
// La parentela è dedotta dal CATALOGO per prefisso normalizzato — nessuna lista scritta a mano.
// Il log NON va nel registro operativo vero: questo file requira server.js (o un modulo
// che lo tira dentro), e server.js installa il tee su file. Senza questa riga ogni run
// appendeva a data/logs/amr.log, righe ERROR comprese, e con la rotazione a 5 MB poteva
// far ruotare il log vero. Deve stare PRIMA di ogni require di backend: LOG_DIR e' una
// const valutata al caricamento del modulo.
const os = require('node:os'), fsTmp = require('node:fs'), pathTmp = require('node:path');
process.env.AMR_LOG_DIR = fsTmp.mkdtempSync(pathTmp.join(os.tmpdir(), 'amr-log-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAs24Narrowing, as24Spellings } = require('../backend/scrapers/brand-match');

// Catalogo CFMOTO reale (estratto da data/models.json): "800MT" ha il codice, "800MT-X" no.
const CFMOTO = [
  { nome: '800MT', mmmvAutoscout: '51518|76611||' },
  { nome: '800MT-X' },                                   // orfano: nessun mmmv
  { nome: '800NK', mmmvAutoscout: '51518|76612||' },
  { nome: '300CL-X', mmmvAutoscout: '51518|77835||' },
];

test('orfano con padre a catalogo → usa il codice del padre + filtro nativo', () => {
  const r = resolveAs24Narrowing(CFMOTO, '800MT-X', 51518);
  assert.strictEqual(r.mmmv, '51518|76611||');   // il bucket giusto, non tutta la marca
  assert.strictEqual(r.padre, '800MT');
  assert.strictEqual(r.versionText, '800MT-X');
});

test('nessun padre → brand-only, ma con il filtro nativo (prima era pesca cieca)', () => {
  const r = resolveAs24Narrowing(CFMOTO, 'Papio', 51518);
  assert.strictEqual(r.mmmv, '51518|||');
  assert.strictEqual(r.padre, null);
  assert.strictEqual(r.versionText, 'Papio');
});

test('il padre deve avere il codice: un padre orfano non viene scelto', () => {
  const models = [{ nome: 'Alpha' }, { nome: 'Alpha Sport' }];   // nessuno ha mmmv
  const r = resolveAs24Narrowing(models, 'Alpha Sport RR', 999);
  assert.strictEqual(r.mmmv, '999|||');
  assert.strictEqual(r.padre, null);
});

test('a più padri possibili vince il più specifico', () => {
  const models = [
    { nome: 'Africa', mmmvAutoscout: '31|1||' },
    { nome: 'Africa Twin', mmmvAutoscout: '31|2||' },
  ];
  const r = resolveAs24Narrowing(models, 'Africa Twin CRF 1000L', 31);
  assert.strictEqual(r.mmmv, '31|2||');
  assert.strictEqual(r.padre, 'Africa Twin');
});

test('prefisso STRETTO: un nome identico non è padre di se stesso', () => {
  const r = resolveAs24Narrowing(CFMOTO, '800MT', 51518);
  assert.strictEqual(r.padre, null);          // "800MT" non fa da padre a "800MT"
  assert.strictEqual(r.mmmv, '51518|||');
});

test('la parentela ignora spaziatura e maiuscole (norm)', () => {
  const r = resolveAs24Narrowing(CFMOTO, '800 mt-x', 51518);
  assert.strictEqual(r.padre, '800MT');
  assert.strictEqual(r.versionText, '800 mt-x');   // il testo inviato ad AS24 resta quello cercato
});

test('prefissi troppo corti (<3) non fanno da padre: niente falsi agganci', () => {
  const models = [{ nome: 'X', mmmvAutoscout: '1|9||' }, { nome: 'XR 125', mmmvAutoscout: '1|10||' }];
  const r = resolveAs24Narrowing(models, 'XR 125 Sport', 1);
  assert.strictEqual(r.padre, 'XR 125');   // non "X"
});

test('modello vuoto o marca senza makeId → nessun crash, nessun filtro', () => {
  assert.deepStrictEqual(resolveAs24Narrowing(CFMOTO, '', 51518), { mmmv: '51518|||', versionText: '', padre: null });
  assert.deepStrictEqual(resolveAs24Narrowing(null, '800MT-X', null), { mmmv: '', versionText: '800MT-X', padre: null });
});

test('buildVariables: il filtro nativo entra nella classification AS24', () => {
  const buildVariables = require('../backend/scrapers/autoscout-graphql')._buildVariables;
  const { v } = buildVariables({ tipo: 'moto', autoscoutMmmv: '51518|76611||', autoscoutVersionText: '800MT-X' }, 1);
  assert.deepStrictEqual(v.classification, [{ make: 51518, model: 76611, modelVersionInput: '800MT-X' }]);
  const { v: senza } = buildVariables({ tipo: 'moto', autoscoutMmmv: '51518|76611||' }, 1);
  assert.deepStrictEqual(senza.classification, [{ make: 51518, model: 76611 }]);   // invariato senza fase 1
});

// ── Unione multi-grafia (fase 1b): AS24 confronta per parola intera e non ha OR ──
test('grafie: codice compatto → 4 varianti (quelle che i venditori scrivono davvero)', () => {
  assert.deepStrictEqual(as24Spellings('800MT-X'), ['800MT-X', '800 MT X', '800mtx', 'MTX']);
});

test('grafie: nome multi-parola → niente varianti-spazzatura (solo separazione cifre/lettere)', () => {
  assert.deepStrictEqual(as24Spellings('Africa Twin CRF 1000L'), ['Africa Twin CRF 1000L', 'Africa Twin CRF 1000 L']);
});

test('grafie: nessun duplicato quando le regole coincidono', () => {
  assert.deepStrictEqual(as24Spellings('GTS 300'), ['GTS 300']);   // già separato: una sola grafia
});

test('grafie: sigla di 2 lettere non diventa una grafia (troppo generica)', () => {
  // "125nk" è duplicato di "125NK" a meno di maiuscole → deduplicato; "NK" (2 char) escluso
  assert.deepStrictEqual(as24Spellings('125NK'), ['125NK', '125 NK']);
});

test('grafie: tetto di 4 richieste e input vuoto gestito', () => {
  assert.ok(as24Spellings('300CL-X').length <= 4);
  assert.deepStrictEqual(as24Spellings(''), []);
  assert.deepStrictEqual(as24Spellings(null), []);
});

/**
 * REGRESSIONE. Il livello di riallargamento leggeva `autoscoutMmmv`, che sul ramo fase-1
 * porta il codice del PADRE — sempre pieno. Risultato: l'esito 'padre' era irraggiungibile,
 * ogni riallargamento usciva 'versione', e il banner interpolava params.versione (null,
 * letteralmente a schermo) dicendo "mostro tutte le versioni di Dorsoduro 1200" mentre in
 * lista c'erano i fratelli 750 e 900.
 */
test('livello riallargamento: bucket del padre → "padre", non "versione"', () => {
  const { _as24LivelloAllargamento: livello } = require('../backend/server');
  // Ramo fase-1: mmmv del PADRE in autoscoutMmmv, nessun codice proprio, nessuna versione.
  const fase1 = { mmmvAutoscout: null, autoscoutMmmv: '50005|70123||', as24Padre: 'Dorsoduro' };
  assert.strictEqual(livello(fase1, {}, true), 'padre');
  // Codice PROPRIO del modello: il retry toglie solo la versione → 'versione'.
  const proprio = { mmmvAutoscout: '74|2084||', autoscoutMmmv: '74|2084||' };
  assert.strictEqual(livello(proprio, {}, true), 'versione');
  // Gradino intermedio (solo-modello riuscito): 'versione' anche senza codice proprio.
  assert.strictEqual(livello(fase1, { viaSoloModello: true }, true), 'versione');
  // Brand-only puro, nessun padre: 'marca'.
  assert.strictEqual(livello({ autoscoutMmmv: '74|||' }, {}, true), 'marca');
  // Nessun riallargamento: null.
  assert.strictEqual(livello(fase1, {}, false), null);
});

test('un prefisso che spezza un numero non e\' una parentela', () => {
  // "fz6" dentro "fz600" metteva la FZ 600 (1986) nel secchio della FZ6 (2004), e la
  // fascia di stato stampava una genealogia falsa. Due numeri diversi non sono padre e
  // figlio. Misurato sui 1.768 modelli moto senza codice: con questo confine cambiano
  // SOLO i due padri falsi (FZ6→"FZ 600", Rev 3→"Rev 300").
  const YAMAHA = [
    { nome: 'FZ6', mmmvAutoscout: '54|60321||' },
    { nome: 'FZ 600' },                                  // orfana: il prefisso la agganciava
  ];
  assert.strictEqual(resolveAs24Narrowing(YAMAHA, 'FZ 600', 54).padre, null,
    'FZ 600 non e\' figlia della FZ6: meglio la marca intera del secchio sbagliato');
  // Ma il taglio resta legittimo su un confine di token ("AF 1" ⊂ "AF1 125")...
  const APRILIA = [{ nome: 'AF 1', mmmvAutoscout: '9|1||' }, { nome: 'AF1 125' }];
  assert.strictEqual(resolveAs24Narrowing(APRILIA, 'AF1 125', 9).padre, 'AF 1');
  // ...e quando estende delle lettere ("CRF 250" ⊂ "CRF 250R").
  const HONDA = [{ nome: 'CRF 250', mmmvAutoscout: '29|5||' }, { nome: 'CRF 250R' }];
  assert.strictEqual(resolveAs24Narrowing(HONDA, 'CRF 250R', 29).padre, 'CRF 250');
});

test('il confine vive nella RADICE: makeModelResolver non salda le cifre', () => {
  // 82e4d15 aveva messo il confine solo in resolveAs24Narrowing: 'CRF 500R' digitato a
  // mano risolveva la minimoto 'CRF 50' — con mmmv E slug Moto.it sbagliati — perche'
  // il ramo prefisso della radice accettava il taglio 'crf50'|'0r'. Misurato sul catalogo:
  // 0 diff sulle 14.155 query da menu (l'esatto assorbe), cambiano solo i padri falsi.
  const { makeModelResolver } = require('../backend/scrapers/brand-match');
  const honda = [
    { nome: 'CRF 50' }, { nome: 'CRF 250' }, { nome: 'CB 100' },
  ].map(m => ({ name: m.nome, value: m.nome }));
  const r = makeModelResolver(honda);
  assert.strictEqual(r('CRF 500R'), null, 'CRF 500R non e\' figlia della CRF 50: meglio i ripieghi dichiarati');
  assert.strictEqual(r('CRF 500'), null);
  assert.strictEqual(r('CB 100 Special'), 'CB 100', 'il confine di token resta una parentela');
  assert.strictEqual(r('CRF 250R'), 'CRF 250', 'le lettere si estendono');
  assert.strictEqual(r('CRF 50'), 'CRF 50', 'l\'esatto resta esatto');
});
