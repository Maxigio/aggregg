'use strict';
/**
 * Le sei route del CATALOGO — le decisioni di instradamento, non i dati.
 *
 * Perche' esiste: il commento di backend/catalogo-route.js righe 79-80 e' il verbale di un bug
 * gia' capitato durante lo sviluppo ("/api/catalogo/rilevamenti, che non manda `fonte`,
 * ricadeva sul listino e rispondeva spento"), risolto con il parametro `fonteFissa`. Quel
 * parametro e' un terzo argomento posizionale senza nome e senza default: toglierlo per sbaglio
 * fa sparire la quarta fonte dalla UI e la suite resta verde. Qui non piu'.
 *
 * Tutto OFFLINE: le route si montano su un finto `app` e si chiamano con un finto `res`.
 * Nessun server, nessuna porta, nessuna richiesta di rete — le due fonti su disco bastano, e i
 * rami che userebbero Motornet si fermano prima, sull'interruttore spento.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const cat = require('../backend/catalogo-route');
const AUTODATA = require('../data/autodata-index.json');
const ULTIMATE = require('../data/ultimatespecs-moto-index.json');

// AMR_MOTORNET non e' impostato in fase di test: la fonte di rete e' spenta, ed e' proprio la
// configurazione predefinita che vogliamo difendere.
assert.ok(!process.env.AMR_MOTORNET, 'questi test valgono con Motornet SPENTO (default)');

// Finto Express: raccoglie gli handler invece di aprire una porta.
const rotte = {};
cat.mount({ get: (p, h) => { rotte[p] = h; } }, { clientIp: req => req.ip || 'test' });

/** Chiama una route e ritorna { stato, headers, corpo }. */
async function chiama(percorso, query = {}, ip = 'test') {
  const h = rotte[percorso];
  assert.ok(h, 'route non montata: ' + percorso);
  let out = null;
  const res = {
    _stato: 200, _hdr: {},
    status(s) { this._stato = s; return this; },
    set(k, v) { this._hdr[k] = v; return this; },
    json(b) { out = b; return this; },
  };
  await h({ query, ip }, res);
  return { stato: res._stato, headers: res._hdr, corpo: out };
}

test('sono montate tutte e otto le route del catalogo', () => {
  for (const p of ['/api/catalogo/fonti', '/api/catalogo/marche', '/api/catalogo/rilevamenti',
    '/api/catalogo/modelli', '/api/catalogo/versioni', '/api/catalogo/allestimento',
    '/api/catalogo/prove', '/api/catalogo/prova']) {
    assert.ok(rotte[p], 'manca ' + p);
  }
});

test('fonti: cinque cataloghi, e con Motornet spento solo il listino e\' indisponibile', async () => {
  const { corpo } = await chiama('/api/catalogo/fonti');
  assert.strictEqual(corpo.ok, true);
  const per = Object.fromEntries(corpo.fonti.map(f => [f.id, f]));
  assert.deepStrictEqual(Object.keys(per), ['nuovo', 'auto', 'moto', 'rilevamenti', 'prove']);
  assert.strictEqual(per.nuovo.disponibile, false, 'il listino dipende da AMR_MOTORNET');
  assert.strictEqual(per.auto.disponibile, true);
  assert.strictEqual(per.moto.disponibile, true);
  // Rilevamenti e prove NON passano dall'interruttore: auto.it e insella.it non vietano quelle
  // pagine, quindi non hanno bisogno di un consenso esplicito come il webservice Motornet.
  assert.strictEqual(per.rilevamenti.disponibile, true);
  assert.strictEqual(per.prove.disponibile, true);
  assert.strictEqual(per.prove.tipo, 'moto', 'le prove inSella stanno nel mondo moto');
  assert.strictEqual(per.auto.marche, Object.keys(AUTODATA.brands).length);
  assert.strictEqual(per.moto.marche, Object.keys(ULTIMATE.brands).length);
});

test('spegnibile: solo il listino porta il flag, e regge le fonti sconosciute', async () => {
  // Prima questa regola era ripetuta a mano come "!== 'rilevamenti'" in due punti diversi, e
  // ogni fonte nuova ne aggiungeva un caso speciale a entrambi. Ora sta in FONTI.
  const { corpo } = await chiama('/api/catalogo/fonti');
  const spegnibili = corpo.fonti.filter(f => f.spegnibile).map(f => f.id);
  assert.deepStrictEqual(spegnibili, ['nuovo']);
  // Una fonte inventata deve comportarsi come il listino: spenta, non aperta.
  const ignota = await chiama('/api/catalogo/marche', { fonte: 'inventata' });
  assert.strictEqual(ignota.corpo.spento, true);
});

test('prove moto: senza marca risponde col motivo e NON si spegne con Motornet', async () => {
  // Stessa difesa dei rilevamenti: senza il terzo argomento 'prove' la route ricadrebbe sul
  // listino e risponderebbe spenta, facendo sparire la quinta fonte dalla UI.
  const { corpo } = await chiama('/api/catalogo/prove', {});
  assert.strictEqual(corpo.spento, undefined);
  assert.strictEqual(corpo.ok, true);
  assert.deepStrictEqual(corpo.prove, []);
  assert.strictEqual(corpo.motivo, 'marca mancante');
});

test('scheda prova: senza slug risponde col motivo, senza toccare la rete', async () => {
  const { corpo } = await chiama('/api/catalogo/prova', {});
  assert.strictEqual(corpo.spento, undefined);
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.motivo, 'prova mancante');
});

// ─── Il buco documentato, finalmente fissato ─────────────────────────────────
test('rilevamenti: la route non ricade sul listino e NON risponde spento', async () => {
  // Senza il terzo argomento 'rilevamenti' di catalogo-route.js:123 questa risposta tornerebbe
  // { ok:false, spento:true } e la quarta fonte sparirebbe dalla UI. Non serve nessuno stub:
  // il lavoro esce prima di toccare la rete perche' manca la marca, mentre la guardia
  // dell'interruttore gira comunque PRIMA.
  const { corpo } = await chiama('/api/catalogo/rilevamenti', {});
  assert.strictEqual(corpo.spento, undefined, 'la fonte rilevamenti non si spegne con Motornet');
  assert.strictEqual(corpo.ok, true);
  assert.deepStrictEqual(corpo.rilevamenti, []);
  assert.strictEqual(corpo.motivo, 'marca mancante');
});

test('versioni: il verso OPPOSTO della guardia — il listino DEVE spegnersi', async () => {
  const { corpo } = await chiama('/api/catalogo/versioni', { modello: 'X' });
  assert.strictEqual(corpo.ok, false);
  assert.strictEqual(corpo.spento, true);
});

// ─── I due cataloghi su disco ────────────────────────────────────────────────
test('marche fonte=auto: elenco ordinato, con i loghi veri', async () => {
  const { corpo, headers } = await chiama('/api/catalogo/marche', { fonte: 'auto' });
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.fonte, 'auto');
  assert.strictEqual(corpo.marche.length, Object.keys(AUTODATA.brands).length);
  assert.match(headers['Cache-Control'] || '', /max-age=3600/);
  const nomi = corpo.marche.map(m => m.nome);
  assert.deepStrictEqual(nomi, [...nomi].sort((a, b) => a.localeCompare(b, 'it')), 'ordine alfabetico italiano');
  assert.ok(corpo.marche.some(m => m.logo), 'le auto hanno i loghi (le moto no: segnaposto a iniziali)');
});

test('modelli fonte=auto: gli anni in coda spariscono dai nomi', async () => {
  // auto-data.net scrive "500 2008 -": in un elenco quegli anni sono rumore.
  const { corpo } = await chiama('/api/catalogo/modelli', { fonte: 'auto', marca: 'abarth' });
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.acronimo, 'abarth');
  assert.ok(corpo.modelli.length > 0);
  for (const m of corpo.modelli) {
    assert.doesNotMatch(m.nome, /(19|20)\d{2}\s*-?\s*$/, `anni non tolti da "${m.nome}"`);
  }
  assert.ok(corpo.modelli.some(m => m.nome === '500'), '"500 2008 -" deve diventare "500"');
});

test('modelli: una marca fuori catalogo risponde col motivo, non con un elenco vuoto muto', async () => {
  const { corpo } = await chiama('/api/catalogo/modelli', { fonte: 'auto', marca: 'NONESISTE' });
  assert.deepStrictEqual(corpo.modelli, []);
  assert.strictEqual(corpo.motivo, 'marca non in questo catalogo');
});

test('modelli senza marca: motivo esplicito', async () => {
  const { corpo } = await chiama('/api/catalogo/modelli', { fonte: 'auto' });
  assert.strictEqual(corpo.motivo, 'marca mancante');
});

// ─── Il listino del nuovo, con Motornet finto (nessuna rete) ─────────────────
// Le proprieta' esportate da scrapers/motornet.js sono scrivibili e catalogo-route.js le legge
// a ogni chiamata: si accende l'interruttore per il tempo del test e si rimette com'era.
async function conMotornetFinto(marche, modelliPerAcronimo, corpoDelTest) {
  const mn = require('../backend/scrapers/motornet');
  const orig = { ATTIVO: mn.ATTIVO, marche: mn.marche, modelli: mn.modelli };
  mn.ATTIVO = true;
  mn.marche = async () => marche;
  mn.modelli = async a => modelliPerAcronimo[a] || [];
  try { await corpoDelTest(); }
  finally { Object.assign(mn, orig); }
}

const MARCHE_FINTE = [
  { acronimo: 'DSA', nome: 'DS' },
  { acronimo: 'MGG', nome: 'MG' },
  { acronimo: 'ALF', nome: 'Alfa Romeo' },
];

test('modelli fonte=nuovo: le marche col nome di due lettere (DS, MG) non finiscono a vuoto', async () => {
  // L'euristica precedente era `marca.length > 3`: "DS" non la superava, quindi partiva verso
  // Motornet come codice_marca "DS" invece di "DSA" e tornava ok:true con elenco vuoto.
  await conMotornetFinto(MARCHE_FINTE, { DSA: [{ codiceModello: '1', nome: 'DS 3' }], ALF: [{ codiceModello: '9', nome: 'Giulia' }] }, async () => {
    const ds = await chiama('/api/catalogo/modelli', { fonte: 'nuovo', marca: 'DS' });
    assert.strictEqual(ds.corpo.acronimo, 'DSA', 'il nome "DS" deve risolvere all\'acronimo DSA');
    assert.strictEqual(ds.corpo.modelli.length, 1);

    // La sigla continua a passare dritta, senza essere scambiata per un nome.
    const alf = await chiama('/api/catalogo/modelli', { fonte: 'nuovo', marca: 'ALF' });
    assert.strictEqual(alf.corpo.acronimo, 'ALF');
    assert.strictEqual(alf.corpo.modelli[0].nome, 'Giulia');

    // E il nome esteso pure (chi arriva da un link della ricerca usato ha il nome).
    const est = await chiama('/api/catalogo/modelli', { fonte: 'nuovo', marca: 'Alfa Romeo' });
    assert.strictEqual(est.corpo.acronimo, 'ALF');

    const ko = await chiama('/api/catalogo/modelli', { fonte: 'nuovo', marca: 'Marca Inventata' });
    assert.strictEqual(ko.corpo.motivo, 'marca non nel listino del nuovo');
  });
});

// ─── Pausa dopo un blocco della fonte ────────────────────────────────────────
test('fonti: niente cache, e la pausa non c\'e\' quando la fonte e\' libera', async () => {
  const { corpo, headers } = await chiama('/api/catalogo/fonti');
  // Se questa risposta fosse cachata un'ora, il conto alla rovescia resterebbe congelato.
  assert.strictEqual(headers['Cache-Control'], 'no-store');
  assert.ok(typeof corpo.adesso === 'number', 'serve l\'ora del server per allineare gli orologi');
  for (const f of corpo.fonti) assert.strictEqual(f.bloccataFino, undefined, f.id + ' non e\' in pausa');
});

test('fonti: quando lo scraper e\' in pausa, l\'elenco dice fino a quando', async () => {
  const a = require('../backend/scrapers/autoit-rilevamenti');
  const orig = a.pausaFinoA;
  const fine = 1900000000000;                 // istante fisso: nessun Date.now() nel test
  a.pausaFinoA = () => fine;
  try {
    const { corpo } = await chiama('/api/catalogo/fonti');
    const per = Object.fromEntries(corpo.fonti.map(f => [f.id, f]));
    assert.strictEqual(per.rilevamenti.bloccataFino, fine);
    assert.strictEqual(per.rilevamenti.disponibile, true, 'in pausa != spenta: torna da sola');
    // La pausa e' della singola fonte, non del catalogo: le altre non devono risentirne.
    assert.strictEqual(per.auto.bloccataFino, undefined);
    assert.strictEqual(per.moto.bloccataFino, undefined);
  } finally { a.pausaFinoA = orig; }
});

test('rilevamenti: su un blocco la risposta porta la fine della pausa', async () => {
  const a = require('../backend/scrapers/autoit-rilevamenti');
  const orig = { pausaFinoA: a.pausaFinoA, rilevamenti: a.rilevamenti };
  const fine = 1900000000000;
  a.pausaFinoA = () => fine;
  a.rilevamenti = async () => { const e = new Error('in pausa dopo un blocco'); e.kind = 'blocked'; throw e; };
  try {
    const { corpo } = await chiama('/api/catalogo/rilevamenti', { marca: 'jaguar-jag' });
    assert.strictEqual(corpo.ok, false);
    assert.strictEqual(corpo.kind, 'blocked');
    assert.strictEqual(corpo.bloccataFino, fine, 'senza questo la UI non sa che basta aspettare');
  } finally { Object.assign(a, orig); }
});

test('limite: 40 richieste al minuto per IP, la 41esima no', async () => {
  const ip = 'ip-solo-per-questo-test';
  for (let i = 1; i <= 40; i++) assert.strictEqual(cat._rateOk(ip), true, 'richiesta ' + i);
  assert.strictEqual(cat._rateOk(ip), false, 'la 41esima deve essere respinta');
});
