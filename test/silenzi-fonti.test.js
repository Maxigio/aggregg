'use strict';
/**
 * IL SILENZIO DI UNA FONTE NON DEVE DIVENTARE UN FATTO.
 *
 * Questi test non difendono cinque correzioni sparse: difendono UNA regola. Una funzione che
 * non e' riuscita a guardare non puo' restituire la stessa cosa di una che ha guardato e non
 * ha trovato niente — perche' a valle quella lista vuota diventa una frase come "non a
 * catalogo", "nessun annuncio", "nessuna allerta", oppure un annuncio marcato venduto.
 *
 * Ogni caso qui sotto e' un punto in cui le due risposte erano indistinguibili.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

// Ogni ricerca salvata ha un padrone. Qui e' sempre lo stesso: l'isolamento fra persone si
// prova in dati-per-persona.test.js.
const U = 'owner';

// ─── Il cancello: file illeggibile ≠ password non impostata ──────────────────
test('auth: auth.json illeggibile chiude il cancello invece di aprirlo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-auth-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/auth')];
  const auth = require('../backend/auth');
  try {
    // Nessun file: l'app resta aperta come prima.
    assert.strictEqual(auth.stato(), 'assente');
    assert.strictEqual(auth.isEnabled(), false);

    // File presente ma illeggibile (JSON troncato: e' cio' che si vede a meta' writeFileSync).
    fs.writeFileSync(path.join(dir, 'auth.json'), '{"salt":"aa","ha');
    assert.strictEqual(auth.stato(), 'illeggibile');
    assert.strictEqual(auth.isEnabled(), true, 'il cancello resta acceso: non si apre a tutti');
    // E nessuna funzione che tocca salt/secret deve esplodere o lasciar passare.
    assert.strictEqual(auth.verifyRole('qualunque-password'), null);
    assert.strictEqual(auth.makeToken('full'), null);
    assert.strictEqual(auth.checkToken('1.full.deadbeef'), null);

    // JSON valido ma semanticamente rotto: non deve diventare «nessuna password».
    for (const contenuto of ['null', '[]', '{}', '{"salt":"aa","hash":"bb"}']) {
      fs.writeFileSync(path.join(dir, 'auth.json'), contenuto);
      assert.strictEqual(auth.stato(), 'illeggibile', contenuto);
      assert.strictEqual(auth.isEnabled(), true, contenuto);
      assert.strictEqual(auth.verifyRole('qualunque-password'), null, contenuto);
    }
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/auth')];
  }
});

test('auth: la password si scrive in modo atomico (niente finestra di file troncato)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-auth2-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/auth')];
  const auth = require('../backend/auth');
  try {
    auth.setPassword('unapasswordlunga');
    assert.strictEqual(auth.stato(), 'ok');
    assert.strictEqual(auth.verifyRole('unapasswordlunga'), 'full');
    // Il temporaneo non resta in giro.
    assert.ok(!fs.existsSync(path.join(dir, 'auth.json.tmp')));
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/auth')];
  }
});

test('auth: un file gia configurato che sparisce non riapre il cancello', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-auth-sparito-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/auth')];
  const auth = require('../backend/auth');
  try {
    assert.strictEqual(auth.stato(), 'assente');
    auth.setPassword('unapasswordlunga');
    assert.strictEqual(auth.stato(), 'ok');
    fs.unlinkSync(path.join(dir, 'auth.json'));
    assert.strictEqual(auth.stato(), 'illeggibile');
    assert.strictEqual(auth.isEnabled(), true);
    assert.strictEqual(auth.verifyRole('unapasswordlunga'), null);
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/auth')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Moto.it: un 5xx non e' un piazzale vuoto ────────────────────────────────
test('motoit: la prima pagina non-200 porta fuori lo stato, non una lista vuota', async () => {
  const motoit = require('../backend/scrapers/motoit');
  const vero = motoit._get;
  motoit._get = async () => ({ status: 503, body: '' });
  try {
    const r = await motoit._scrapeVia(['https://www.moto.it/x/1'], {});
    assert.strictEqual(r.statoKo, 503, 'lo stato HTTP arriva al chiamante');
    assert.deepStrictEqual(r.pages, []);
  } finally { motoit._get = vero; }
});

test('motoit: una pagina caduta a meta giro dichiara la vista TRONCATA', async () => {
  const motoit = require('../backend/scrapers/motoit');
  const vero = motoit._get;
  // Pagina 1 buona, pagina 2 in errore: le moto della 1 si tengono, ma la vista non e' completa.
  const card = '<div class="mcard--big"><h2>Yamaha MT-07 2019</h2><span class="price">€ 6.900</span><a href="/moto-usate/annuncio/1">vai</a></div>';
  let n = 0;
  motoit._get = async () => (++n === 1 ? { status: 200, body: card } : { status: 502, body: '' });
  try {
    const r = await motoit._scrapeVia(['u1', 'u2', 'u3'], {});
    assert.ok(!r.statoKo, 'la prima pagina era buona: non e\' un fallimento in blocco');
    assert.strictEqual(r.truncated, true,
      'senza questo il crawler farebbe markGone su una lista monca e marcherebbe venduti annunci mai chiesti');
  } finally { motoit._get = vero; }
});

// ─── La cache su disco scrive dove si puo' scrivere davvero ──────────────────
test('cache-disco: scrive accanto ai dati utente e legge il file impacchettato come semente', async () => {
  const cacheDisco = require('../backend/scrapers/cache-disco');
  const semenzaio = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-seed-'));
  const utente = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-ud-'));
  const seme = path.join(semenzaio, 'prova-cache.json');
  fs.writeFileSync(seme, JSON.stringify({ schema: 1, voci: { vecchia: { t: Date.now(), d: 'dal-pacchetto' } } }));

  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = utente;
  try {
    const conCache = cacheDisco.crea(seme, { tag: 'prova', schema: 1, ttl: 60000, max: 10 });
    // La semente si legge...
    assert.strictEqual(await conCache('vecchia', async () => 'mai-chiamata'), 'dal-pacchetto');
    // ...ma la scrittura va nella cartella utente, non dentro il pacchetto di sola lettura.
    assert.strictEqual(await conCache('nuova', async () => 'appena-presa'), 'appena-presa');
    const scritto = path.join(utente, 'cache', 'prova-cache.json');
    assert.ok(fs.existsSync(scritto), 'la cache deve finire in USER_DATA_PATH/cache');
    assert.ok(JSON.parse(fs.readFileSync(scritto, 'utf8')).voci.nuova, 'la voce nuova e\' sul disco scrivibile');
    // Il file impacchettato non viene toccato.
    assert.ok(!JSON.parse(fs.readFileSync(seme, 'utf8')).voci.nuova);
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});

// ─── La cache non si distrugge da sola se la scrittura si interrompe ─────────
test('cache-disco: il file vero non si tocca finche\' la copia nuova non e\' completa', async () => {
  const cacheDisco = require('../backend/scrapers/cache-disco');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-atomica-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;

  // Si guarda DOVE va ogni writeFileSync. Scrivere dritto sulla destinazione e' il difetto:
  // un processo ucciso a meta' lascia un JSON troncato, `leggi()` non lo interpreta e riparte
  // da zero — cioe' butta l'intera cache e fa ripartire la raffica di richieste che questa
  // cache esiste per evitare.
  const scritture = [];
  const writeVero = fs.writeFileSync, renameVero = fs.renameSync;
  fs.writeFileSync = (p, ...r) => { scritture.push(String(p)); return writeVero.call(fs, p, ...r); };
  let rinominati = 0;
  fs.renameSync = (a, b) => { rinominati++; return renameVero.call(fs, a, b); };

  try {
    const file = path.join(dir, 'prova-atomica.json');
    const destinazione = path.join(dir, 'cache', 'prova-atomica.json');
    const conCache = cacheDisco.crea(file, { tag: 'prova', schema: 1, ttl: 60000, max: 10 });
    assert.strictEqual(await conCache('k', async () => 'valore'), 'valore');

    assert.ok(!scritture.includes(destinazione),
      'la destinazione non deve MAI essere il bersaglio di writeFileSync: si scrive sul .tmp e si rinomina');
    assert.ok(scritture.some(p => p.startsWith(destinazione + '.') && p.endsWith('.tmp')),
      'la copia nuova va scritta su un .tmp accanto (col PID nel nome: due processi non si pestano)');
    assert.strictEqual(rinominati, 1, 'e resa buona con un rename, che e\' atomico');

    // A giro finito il mezzo file non resta in giro, e il file vero si legge.
    assert.ok(!fs.readdirSync(path.dirname(destinazione)).some(f => f.endsWith('.tmp')), 'nessun .tmp avanzato dopo una scrittura riuscita');
    assert.strictEqual(JSON.parse(fs.readFileSync(destinazione, 'utf8')).voci.k.d, 'valore');
  } finally {
    fs.writeFileSync = writeVero;
    fs.renameSync = renameVero;
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});

// ─── Ricambi: zero articoli "sospetti" non e' zero articoli ──────────────────
test('ricambi: una fonte che dichiara di non aver letto NON esce come "empty"', async () => {
  const { searchRicambi } = require('../backend/ricambi-core');
  const vuoto = async () => ({ articoli: [] });
  const base = { subito: vuoto, ebay: vuoto, cmsnl: vuoto, web: vuoto, ebaySpecs: async () => ({}) };

  // Autodoc ha risposto zero SENZA sospetti: e' un fatto sul catalogo.
  const onesto = await searchRicambi('1K0905851B', { ...base, autodoc: vuoto });
  assert.strictEqual(onesto.sources.autodoc.status, 'empty');

  // Autodoc ha risposto zero ma sa di non aver letto l'elenco: non e' un fatto.
  const sospetto = await searchRicambi('1K0905851B', {
    ...base,
    autodoc: async () => ({ articoli: [], sospetto: 'nessun elemento di listino nella pagina' }),
  });
  assert.strictEqual(sospetto.sources.autodoc.status, 'error',
    'con "empty" a schermo comparirebbe "Ricambio non presente nel catalogo Autodoc"');
  assert.match(sospetto.sources.autodoc.reason, /listino/);
});

// ─── Ricerche salvate: un controllo con una fonte muta non e' un controllo ───
test('saved: le fonti mute restano nel record e arrivano alla lista', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-mute-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const saved = require('../backend/saved');
  try {
    const s = saved.addSaved(U, { label: 'Golf GTD', params: { tipo: 'auto', marca: 'Volkswagen' } });
    const ann = [{ url: 'https://www.subito.it/a', prezzo: 15000, titolo: 'Golf' }];

    // Controllo completo: nessuna fonte muta, e resta la data del controllo completo.
    saved.recordCheck(U, s.id, ann, {});
    const dopoPieno = saved.listSaved(U).find(x => x.id === s.id);
    assert.strictEqual(dopoPieno.fontiMute, null);
    assert.ok(dopoPieno.lastCheckedFull, 'un controllo completo si annota come tale');

    // Controllo con Autoscout muto: l'ora c'e', ma si sa che non e' completo.
    saved.recordCheck(U, s.id, ann, { fontiMute: ['autoscout'] });
    const dopoMuto = saved.listSaved(U).find(x => x.id === s.id);
    assert.deepStrictEqual(dopoMuto.fontiMute, ['autoscout'],
      'senza questo la scheda direbbe "controllata adesso, nessuna novita\'"');
    assert.strictEqual(dopoMuto.lastCheckedFull, dopoPieno.lastCheckedFull,
      'l\'ultimo controllo COMPLETO resta quello di prima');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
  }
});

/**
 * Un freno finto per le prove del parco. Come per gli scraper: col freno VERO un 403
 * simulato qui dentro finirebbe nell'archivio di chi sviluppa e metterebbe in pausa una
 * fonte che non ha fatto niente.
 */
function frenoFinto(fermo = false) {
  const registrati = [];
  return {
    MOTIVO_PAUSA: 'in pausa dopo un blocco',
    fermo: () => ({ fermo, fino: null, motivo: fermo ? 'bloccato' : null }),
    registra: (fonte, esito) => { registrati.push({ fonte, ...esito }); },
    registrati,
  };
}

// ─── Competitor: una passata caduta non e' il tetto di sicurezza ─────────────
test('competitor: la passata fallita si dichiara per quello che e\', non come troncamento', async () => {
  const C = require('../backend/competitor');
  const voce = { fonte: 'autoscout', id: '12345', nome: 'Prova Auto' };
  const finto = async (params) => {
    if (params.tipo === 'auto') return { items: [{ url: 'a1', titolo: 'Auto 1', prezzo: 10000 }], truncated: false, total: 1 };
    throw new Error('HTTP 429');
  };
  const p = await C.parco(voce, { scrapeAs24: finto, salute: frenoFinto() });
  assert.strictEqual(p.veicoli.length, 1, 'la passata riuscita si tiene');
  assert.strictEqual(p.troncato, false, 'nessun tetto e\' stato toccato: dirlo sarebbe falso');
  assert.ok(p.passateKo && p.passateKo.length === 1, 'la passata caduta si dichiara a parte');
  assert.strictEqual(p.passateKo[0].tipo, 'moto');
});

// ─── Competitor: il parco passa dal freno anti-ban, come le ricerche ─────────
test('competitor: la fonte in pausa non si interroga, e l\'esito del parco arriva al freno', async () => {
  const C = require('../backend/competitor');
  const voce = { fonte: 'subito', id: '1398723', nome: 'Prova Auto' };

  // Fonte in pausa: lo scarico non deve partire affatto. Le fonti bannano la macchina, e
  // uno scarico di parco e' la richiesta piu' profonda che facciamo.
  const freno = frenoFinto(true);
  let chiamate = 0;
  await assert.rejects(
    () => C.parco(voce, { scrapeSubito: async () => { chiamate++; return { items: [], total: 0 }; }, salute: freno }),
    /in pausa dopo un blocco/);
  assert.strictEqual(chiamate, 0, 'in pausa non si bussa lo stesso');

  // Fonte libera: le pagine partono con la pausa fra una e l'altra (il default degli
  // scraper e' 0), e il 403 preso qui conta un colpo per il freno.
  const freno2 = frenoFinto(false);
  const opts = [];
  await assert.rejects(() => C.parco(voce, {
    scrapeSubito: async (p, o) => { opts.push(o); throw Object.assign(new Error('Subito hades HTTP 403'), { kind: 'blocked', status: 403 }); },
    salute: freno2,
  }), /HTTP 403/);
  assert.ok(opts[0].pageDelayMs > 0, 'senza pausa le 40 pagine partono a raffica verso la stessa fonte');
  assert.ok(freno2.registrati.length >= 1, 'un blocco preso dal parco deve contare per il freno');
  assert.strictEqual(freno2.registrati[0].fonte, 'subito');
  assert.strictEqual(freno2.registrati[0].errore.kind, 'blocked',
    'al freno serve il genere vero: il rilancio piu\' a valle lo perde nel messaggio');
});

// ─── Una pagina-annuncio che non dice niente non e' un annuncio senza dati ────
test('detail: il parser che non riconosce nulla si distingue dall\'annuncio scarno', () => {
  const d = require('../backend/scrapers/detail');
  // Tutti i campi nulli: la pagina non si e' lasciata leggere (transizione, markup cambiato).
  assert.strictEqual(d._senzaNiente({ cambio: null, potenzaCv: null, immagini: [] }), true);
  // Basta UN campo riconosciuto perche' la lettura sia buona, anche se il resto manca.
  assert.strictEqual(d._senzaNiente({ cambio: null, potenzaCv: 110, immagini: [] }), false);
  assert.strictEqual(d._senzaNiente({ cambio: null, immagini: ['a.jpg'] }), false);
  assert.strictEqual(d._senzaNiente(null), true);
  // E il vuoto vale poco: si riprova presto invece di restare dodici ore.
  assert.ok(d._VUOTO_TTL_MS < 60 * 60 * 1000,
    'era l\'unica cache del repo senza vita breve per il risultato sospetto');
});

// ─── Il menu versioni di Moto.it che non risponde ─────────────────────────────
test('motoit-models: con `rilancia` l\'errore di rete non si confonde col catalogo vuoto', async () => {
  const mm = require('../backend/scrapers/motoit-models');
  // Marca fuori catalogo e slug inventato: senza `rilancia` la risposta e' [] tanto se la
  // rete cade quanto se il modello non ha versioni, ed e' proprio quella confusione che
  // faceva passare un timeout per "questa versione non esiste".
  assert.deepStrictEqual(await mm.getModelBikes('', 'x'), []);
  assert.deepStrictEqual(await mm.getModelBikes('yamaha', ''), []);
  // La firma accetta le opzioni senza cambiare il comportamento di chi non le passa.
  const senza = await mm.getModelBikes('yamaha', 'mt-07');
  const con = await mm.getModelBikes('yamaha', 'mt-07', { rilancia: true });
  assert.deepStrictEqual(senza, con, 'sul catalogo locale le due strade danno lo stesso elenco');
  assert.ok(senza.length >= 9);
});

test('motoit-models: la risposta troncata a meta\' body rigetta, e non incastra l\'inflight', async () => {
  // FIN pulito DOPO gli header, body incompleto: l'errore esce su `res`, non su `req`, e il
  // timeout di req e' di sola INATTIVITA' — a presa chiusa non scatta mai. Senza i gestori su
  // `res` la Promise restava appesa per sempre e l'inflight di `cached`, mai ripulito, veniva
  // riusato da OGNI chiamata successiva per quella marca fino al riavvio del processo.
  const http = require('http');
  const https = require('https');
  const mm = require('../backend/scrapers/motoit-models');
  let servite = 0;
  const srv = http.createServer((req, res) => {
    servite++;
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"result":"OK","data":[{"value":"zz|');
    setTimeout(() => res.socket.end(), 50);   // FIN a meta' body
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  // Il modulo chiama `https.get` al volo sull'oggetto modulo: patchare la proprieta' basta.
  const veroGet = https.get;
  https.get = (url, opts, cb) => http.get(`http://127.0.0.1:${porta}/x`, opts, cb);
  let timer;
  try {
    const appesa = Symbol('appesa');
    const esito = await Promise.race([
      mm.getBrandModels('zz-marca-troncata', { rilancia: true }).then(() => 'risolta', e => String(e.message)),
      new Promise(r => { timer = setTimeout(() => r(appesa), 5000); }),
    ]);
    assert.notStrictEqual(esito, appesa,
      'la Promise non deve restare appesa: il menu moto si bloccherebbe per sempre');
    assert.match(String(esito), /interrotta|aborted/i, 'e non deve nemmeno risolversi con un elenco a meta\'');
    // E l'inflight si e' ripulito: la chiamata dopo RIPROVA invece di riusare quella incastrata.
    await mm.getBrandModels('zz-marca-troncata', { rilancia: true }).catch(() => {});
    assert.strictEqual(servite, 2, 'la seconda chiamata deve fare una richiesta nuova al server');
  } finally { clearTimeout(timer); https.get = veroGet; srv.close(); }
});

test('autoscout: la risposta troncata a meta\' body rigetta, e non incastra la chiamata', async () => {
  // Stesso difetto del test sopra, nel gemello httpPost di autoscout-graphql: senza i gestori
  // su `res` la Promise restava appesa — in ricerca la colonna AS24 pagava i 45s del timeout
  // esterno, e nel pannello Competitor (nessun timeout di rotta) il GET del parco non
  // rispondeva mai piu'.
  const http = require('http');
  const https = require('https');
  const scrape = require('../backend/scrapers/autoscout-graphql');
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
    res.write('{"data":{"search":');
    setTimeout(() => res.socket.end(), 50);   // FIN a meta' body
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const porta = srv.address().port;
  // httpPost chiama `https.request` al volo sull'oggetto modulo: patchare la proprieta' basta.
  const veroRequest = https.request;
  https.request = (opts, cb) => http.request({ ...opts, host: '127.0.0.1', port: porta }, cb);
  let timer;
  try {
    const appesa = Symbol('appesa');
    // fetchTotalCount e' best-effort (mai throw): se il reject interno arriva, risolve null
    // subito; se la Promise resta appesa, non risolve mai e vince la sentinella.
    const esito = await Promise.race([
      scrape.fetchTotalCount({ mmmv: '9|1626', tipo: 'auto' }),
      new Promise(r => { timer = setTimeout(() => r(appesa), 5000); }),
    ]);
    assert.notStrictEqual(esito, appesa,
      'la Promise non deve restare appesa: il parco Competitor resterebbe bloccato per sempre');
    assert.strictEqual(esito, null, 'il troncamento e\' un errore, non un conteggio');
  } finally { clearTimeout(timer); https.request = veroRequest; srv.close(); }
});

// ─── La marcatura decide anche cosa NON fare ─────────────────────────────────
test('saved: un annuncio di un altro modello non genera avviso, ma resta fra i visti', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-mark-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const saved = require('../backend/saved');
  try {
    const s = saved.addSaved(U, { label: 'Beta R-12', params: { tipo: 'moto', marca: 'Beta', modello: 'R-12' } });
    // Primo giro: baseline silenziosa, nessun avviso per nessuno.
    saved.recordCheck(U, s.id, [{ url: 'https://x/1', prezzo: 6000, titolo: 'Beta R-12', dichiarazione: 'esatto' }], {});
    // Secondo giro: due annunci nuovi, uno giusto e uno di un altro modello.
    const alerts = saved.recordCheck(U, s.id, [
      { url: 'https://x/1', prezzo: 6000, titolo: 'Beta R-12', dichiarazione: 'esatto' },
      { url: 'https://x/2', prezzo: 5500, titolo: 'Beta RR 125', dichiarazione: 'altro-modello' },
      { url: 'https://x/3', prezzo: 6200, titolo: 'Beta R-12 2023', dichiarazione: 'senza-versione' },
    ], {});
    const urls = alerts.map(a => a.url);
    assert.ok(urls.includes('https://x/3'), 'il modello giusto senza versione dichiarata avvisa');
    assert.ok(!urls.includes('https://x/2'), 'l\'altro modello non suona: la ricerca salvata segue QUEL modello');
    // Ma e' stato visto: al giro dopo non deve arrivare come "nuovo".
    const dopo = saved.getSaved(U, s.id);
    assert.ok(Object.prototype.hasOwnProperty.call(dopo.seen, 'https://x/2'),
      'non avvisare non vuol dire dimenticare');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
  }
});

// ─── Un ripiego che risponde sempre qualcosa e' un fallback travestito ────────
test('motoit: l\'ultima spiaggia non salda le cifre ("CRF 1100" non e\' la CRF 110)', async () => {
  const mm = require('../backend/scrapers/motoit-models');
  // Il ramo `figlie` la guardia sul confine di cifra ce l'ha da sempre; l'ultima spiaggia
  // fuzzy no, e normalizzando via i separatori "crf1100" iniziava per "crf110".
  assert.strictEqual(await mm.famiglieMotoit('honda', 'CRF 1100'), null,
    'meglio cercare a livello marca — che il chiamante dichiara — che rispondere minimoto da 110 cc');
  // E non deve aver rotto i casi buoni.
  assert.strictEqual(await mm.famiglieMotoit('honda', 'CRF 110'), 'crf-110');
  assert.strictEqual(await mm.famiglieMotoit('yamaha', 'MT-07'), 'mt-07');
  assert.strictEqual(await mm.famiglieMotoit('aprilia', 'Scarabeo 500'), 'scarabeo-500');
  // Il taglio sul CONFINE DI TOKEN e' una parentela legittima: la guardia piu' severa
  // della regola buttava 57 famiglie vere e 'MP3 500' finiva a livello marca — la
  // finestra dei piu' economici di tutta Piaggio, con gli MP3 fuori.
  assert.strictEqual(await mm.famiglieMotoit('piaggio', 'MP3 500'), 'mp3',
    '"MP3 500" → famiglia MP3: mp3|500 e\' un confine di token, non un numero spezzato');
  assert.strictEqual(await mm.famiglieMotoit('aprilia', 'Tuono V4 1100'), 'tuono-v4');
  const scarabeo = await mm.famiglieMotoit('aprilia', 'Scarabeo');
  assert.ok(scarabeo.split(',').length >= 8, 'il nome largo continua a prendere tutte le famiglie');
  const r1200 = await mm.famiglieMotoit('bmw', 'R 1200');
  assert.ok(r1200 && !r1200.includes('r-12000'), 'la guardia storica del ramo figlie resta');
});

// ─── Il ponte Autoscout→Subito non sceglie una famiglia a caso ───────────────
test('ponte: un codice che aggancia piu\' famiglie le porta TUTTE', () => {
  const { famiglieSubito, famigliaSubito, _inverso } = require('../backend/scrapers/as24-modelli');
  const inv = _inverso();
  // Misurato sull'indice di oggi: 207 codici su 3.692 agganciano piu' di una famiglia.
  const multi = [];
  for (const t of ['auto', 'moto']) for (const [k, v] of inv[t]) if (v.length > 1) multi.push({ t, k, v });
  assert.ok(multi.length > 100, 'se questo numero crolla a zero, il ponte e\' cambiato: rileggere il caso');
  // Su uno di quelli: la vecchia funzione ne dava una sola, la nuova le dichiara tutte.
  const x = multi.find(m => m.t === 'auto') || multi[0];
  const tutte = famiglieSubito(x.t, x.k);
  assert.ok(tutte.length > 1, 'piu\' di una famiglia per quel codice');
  assert.strictEqual(famigliaSubito(x.t, x.k), tutte[0], 'la vecchia firma resta compatibile');
  // Un codice di sola marca non dice quale famiglia: non si inventa.
  assert.deepStrictEqual(famiglieSubito('auto', '13|||'), []);
});

// ─── Una voce ambigua resta una sola richiesta testuale ──────────────────────
test('subito: Auto e Moto non interrogano più famiglie per una voce ambigua', async () => {
  const sub = require('../backend/scrapers/subito-api');
  for (const tipo of ['auto', 'moto']) {
    const chieste = [];
    sub._setHttpGetJson(async path => {
      chieste.push(new URL('https://local.invalid' + path).searchParams);
      return { status: 200, body: JSON.stringify({ count_all: 0, ads: [] }) };
    });
    try {
      const r = await sub({ tipo, marca: 'Aprilia', modello: 'Dorsoduro',
        subitoNodo: { marcaId: '000123', famigliaIds: ['111', '222', '333'] },
      }, { withMeta: true });
      assert.strictEqual(r.total, 0);
      assert.strictEqual(chieste.length, 1);
      assert.strictEqual(chieste[0].get('q'), 'Aprilia Dorsoduro');
      assert.strictEqual(chieste[0].get(tipo === 'moto' ? 'bm' : 'cm'), null);
    } finally { sub._setHttpGetJson(null); }
  }
});

// ─── Fuori bersaglio: due canali, un verdetto, browser e avvisi d'accordo ────
test('fuori bersaglio: browser e avvisi danno lo stesso verdetto sugli stessi ingressi', () => {
  // La regola del proprietario: «regole scritte due volte (browser + server): si accetta la
  // copia, ma un test blinda che diano lo stesso risultato sugli stessi ingressi». Qui i
  // canali sono DUE (dichiarazione degli scraper, versioneEsito della verifica) e prima
  // ogni consumatore ne conosceva uno: la stella finiva su un annuncio marcato «smentita»
  // e l'avviso suonava per un annuncio che lo schermo nasconde.
  const { fuoriBersaglio } = esegui([
    ritaglia(APP, 'const fuoriBersaglio', '\nfunction bestUrlSet'),
  ], {}, ['fuoriBersaglio']);
  const saved = require('../backend/saved');

  // Il cancello degli avvisi, ESEGUITO: un solo annuncio, sopra il floor, gia' visto a un
  // prezzo piu' alto → senza marcature suona, con una qualunque delle due tace.
  const suona = extra => {
    const r = { url: 'https://x/1', titolo: 'Golf', prezzo: 9000, fonte: 'subito', ...extra };
    // `seen` mappa chiave → PREZZO (un numero): un calo da 12.000 a 9.000 suona sempre.
    const search = { seen: { [r.url]: 12000 }, alerted: [] };
    return saved.computeAlerts(search, [r]).alerts.length > 0;
  };

  const casi = [
    [{}, false],
    [{ dichiarazione: 'esatto' }, false],
    [{ dichiarazione: 'senza-versione' }, false],
    [{ dichiarazione: 'altro-modello' }, true],
    [{ dichiarazione: 'esatto', versioneEsito: 'smentita' }, true],   // il caso che divergeva
    [{ versioneEsito: 'smentita' }, true],
    [{ versioneEsito: 'confermata' }, false],
    [{ versioneEsito: 'ignota' }, false],                             // «non lo so» non e' «non e' quella»
  ];
  for (const [extra, fuori] of casi) {
    assert.strictEqual(fuoriBersaglio({ prezzo: 9000, ...extra }), fuori,
      `browser, ${JSON.stringify(extra)}: atteso fuoriBersaglio=${fuori}`);
    assert.strictEqual(suona(extra), !fuori,
      `avvisi, ${JSON.stringify(extra)}: un fuori bersaglio non suona, un annuncio buono si'`);
  }
  assert.strictEqual(fuoriBersaglio(null), false, 'null non esplode: la lista puo' + "'" + ' portare buchi');
});

// ─── Una regola, un posto: il nome senza la generazione ──────────────────────
test('archivi: il modello CON la generazione risponde quanto quello senza — rotte eseguite', async () => {
  // La regola: il nome che arriva da una fonte passa da senzaGenerazione PRIMA di ogni
  // confronto con un archivio. Due chiamanti non lo facevano, e «Golf 5ª serie» — che e'
  // il nome che l'annuncio Subito dichiara — rispondeva ZERO su un dato di sicurezza
  // (misurato: 0 contro 7 Safety Gate e 32 RDW). Qui si eseguono le ROTTE vere, coi dati
  // su disco e zero rete: se un chiamante futuro salta la pulizia, questo diventa rosso.
  const rr = require('../backend/richiami-route');
  const handlers = new Map();
  rr.mount({ get: (p, h) => handlers.set(p, h) }, { chiaveLimite: () => 'u:test-generazione' });
  const chiama = (p, query) => new Promise(done => {
    const res = { status: () => res, json: x => done(x), set: () => res };
    handlers.get(p)({ query }, res);
  });
  for (const rotta of ['/api/richiami/cerca', '/api/richiami/rdw/cerca']) {
    const conGen = await chiama(rotta, { marca: 'Volkswagen', modello: 'Golf 5ª serie' });
    const senza = await chiama(rotta, { marca: 'Volkswagen', modello: 'Golf' });
    assert.ok(senza.totale > 0, `${rotta}: l'archivio deve avere allerte Golf, o il test non prova niente`);
    assert.strictEqual(conGen.totale, senza.totale,
      `${rotta}: la generazione nel nome non puo' azzerare un archivio di sicurezza`);
  }
});

test('nomi-modello: la regola unificata toglie le generazioni senza decapitare i modelli veri', () => {
  const { senzaGenerazione } = require('../backend/nomi-modello');
  // Le due cose che la copia in produzione non sapeva fare, e che gli script sapevano:
  assert.strictEqual(senzaGenerazione('Fiesta 1ª/2ª serie'), 'Fiesta', 'la lista di generazioni va presa intera');
  assert.strictEqual(senzaGenerazione('Jazz 1ª serie 01-08'), 'Jazz', 'i suffissi si accumulano: si ripete finche\' smette di cambiare');
  // Quello che gli script sbagliavano e la copia in produzione no:
  assert.strictEqual(senzaGenerazione('Serie 200-280(W123)'), 'Serie 200-280',
    'tre cifre non sono un anno: "200-280" e\' un intervallo di MOTORI');
  // E la trappola gia' morsa in passato: nomi veri che finiscono con cifre + S.
  assert.strictEqual(senzaGenerazione('K 1200 S'), 'K 1200 S');
  assert.strictEqual(senzaGenerazione('Monster 620 S'), 'Monster 620 S');
  // La stessa funzione la usa la rotta scheda (e da li' fonti-route): un solo comportamento.
  const { senzaGenerazione: dallaRotta } = require('../backend/scheda-veicolo-route');
  for (const n of ['Golf 5ª serie', 'Macan 1ªs.', 'Serie 200-280(W123)', 'K 1200 S']) {
    assert.strictEqual(dallaRotta(n), senzaGenerazione(n), n);
  }
});

// ─── RDW: la marca combacia anche quando un nome e' piu' corto ───────────────
test('rdw: "DS Automobiles" trova le campagne che l\'archivio scrive sotto "DS"', () => {
  const rdw = require('../backend/scrapers/rdw-richiami');
  const ds = rdw.cerca({ marca: 'DS Automobiles' });
  if (!ds.ok) return;                       // archivio non costruito su questa macchina
  assert.ok(ds.totale > 50, `con l'uguaglianza stretta erano 0, ora ${ds.totale}`);
  assert.strictEqual(rdw.cerca({ marca: 'DS' }).totale, ds.totale, 'le due forme sono la stessa marca');
  // E non si allarga a caso: due marche diverse restano diverse.
  const volvo = rdw.cerca({ marca: 'Volvo' }), vw = rdw.cerca({ marca: 'Volkswagen' });
  assert.notStrictEqual(volvo.totale, vw.totale);
});

// ─── L'indirizzo su cui poggiano i limiti non lo scrive il client ────────────
test('server: X-Forwarded-For vale solo se la richiesta arriva dal Funnel', () => {
  const srv = require('../backend/server');
  const conHeader = (remoteAddress) => srv._clientIp({
    headers: { 'x-forwarded-for': '9.9.9.9' }, socket: { remoteAddress },
  });
  // Dal Funnel (proxa a 127.0.0.1) l'header e' l'unico modo di sapere chi c'e' davvero.
  assert.strictEqual(conHeader('127.0.0.1'), '9.9.9.9');
  assert.strictEqual(conHeader('::ffff:127.0.0.1'), '9.9.9.9');
  // Da chiunque altro (rete dell'ufficio, tailnet) l'header e' scritto dal client: si ignora.
  // Senza questa regola bastava cambiarlo a ogni tentativo per non far scattare mai il
  // blocco dopo otto password sbagliate.
  assert.strictEqual(conHeader('192.168.1.40'), '192.168.1.40');
  assert.strictEqual(conHeader('100.64.0.3'), '100.64.0.3');
});

test('server: i limiti seguono la PERSONA quando c\'e\', l\'indirizzo quando no', () => {
  const srv = require('../backend/server');
  // Entrato: la sua quota e' sua, e il collega accanto non gliela consuma.
  assert.strictEqual(srv._chiaveLimite({ authId: 'giulia-rossi', socket: { remoteAddress: '10.0.0.1' } }), 'u:giulia-rossi');
  assert.strictEqual(srv._chiaveLimite({ authId: 'marco', socket: { remoteAddress: '10.0.0.1' } }), 'u:marco');
  // Non entrato: si conta per indirizzo, come prima.
  assert.strictEqual(srv._chiaveLimite({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }), 'ip:10.0.0.1');
});

// ─── Ogni persona ha la sua chiave, e il cookie non si puo' riscrivere ───────
test('auth: una password per persona, con l\'identita\' dentro la firma', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-persone-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/auth')];
  const auth = require('../backend/auth');
  try {
    auth.setPassword('passwordlungaproprietario');
    auth.setPersona('Giulia Rossi', 'passwordlungadigiulia');
    auth.setPersona('Marco', 'passwordlungadimarco', 'full');

    // Chi entra si distingue: prima erano due password per tutti, e i limiti, la coda degli
    // avvisi e il registro accessi non sapevano dire chi fosse chi.
    assert.deepStrictEqual(auth.verifica('passwordlungadigiulia'),
      { id: 'giulia-rossi', nome: 'Giulia Rossi', ruolo: 'demo' });
    assert.strictEqual(auth.verifica('passwordlungadimarco').ruolo, 'full');
    assert.strictEqual(auth.verifica('passwordlungaproprietario').id, 'owner');
    assert.strictEqual(auth.verifica('non-e-la-password'), null);

    // L'identita' sta DENTRO la firma: un ospite non puo' riscrivere il cookie per
    // diventare un collega, ne' per farsi 'full'.
    const t = auth.makeToken('demo', 'giulia-rossi');
    assert.deepStrictEqual(auth.checkSessione(t), { ruolo: 'demo', id: 'giulia-rossi' });
    const falso = t.replace('.demo.giulia-rossi.', '.full.marco.');
    assert.strictEqual(auth.checkSessione(falso), null, 'firma non valida: si rifiuta');

    // I cookie gia' emessi devono continuare a valere: le due forme vecchie restano lette.
    const vecchioTok = auth.makeToken('full', 'owner').split('.');
    assert.strictEqual(vecchioTok.length, 4);

    assert.ok(auth.togliPersona('Giulia Rossi'));
    assert.strictEqual(auth.verifica('passwordlungadigiulia'), null, 'tolta la persona, la sua password non vale piu\'');
    // LA REVOCA REVOCA. Prima questo controllo mancava e il difetto era invisibile: la
    // password moriva, ma il COOKIE gia' emesso valeva altri 30 giorni — mentre due punti
    // del repo promettevano «smette di valere subito». Il token va ripassato a
    // checkSessione, non basta provare verifica().
    assert.strictEqual(auth.checkSessione(t), null, 'tolta la persona, il suo cookie muore al primo controllo');

    // E il resto della famiglia «revoca che non revoca»:
    const tMarco = auth.makeToken('full', 'marco');
    assert.deepStrictEqual(auth.checkSessione(tMarco), { ruolo: 'full', id: 'marco' });
    // (1) cambiare la password rigenera il secret: la vecchia sessione muore per firma;
    auth.setPersona('Marco', 'passwordnuovadimarco', 'demo');
    assert.strictEqual(auth.checkSessione(tMarco), null, 'cambiata la password, la vecchia sessione non vale piu\'');
    // (2) il declassamento declassa: anche un cookie 'full' firmato col secret NUOVO non
    // passa, perche' il ruolo che conta e' quello nell'elenco, non quello congelato nel token.
    assert.strictEqual(auth.checkSessione(auth.makeToken('full', 'marco')), null, 'declassato: il ruolo firmato non basta piu\'');
    assert.deepStrictEqual(auth.checkSessione(auth.makeToken('demo', 'marco')), { ruolo: 'demo', id: 'marco' });

    // (3) e l'OSPITE CONDIVISO non e' l'eccezione che era: in cfg.persone non c'e', quindi il
    // ricontrollo sull'elenco non lo vede e il suo cookie restava buono trenta giorni — anche
    // dopo aver cambiato la password data al visitatore, anche dopo averla ritirata, che e' la
    // revoca promessa per iscritto da utenti-da-env.js.
    const tPapa = auth.makeToken('full', 'owner');
    auth.setDemoPassword('passwordlungaospite');
    const tOspite = auth.makeToken('demo', 'demo');
    assert.deepStrictEqual(auth.checkSessione(tOspite), { ruolo: 'demo', id: 'demo' });
    auth.setDemoPassword('passwordlungaospitedue');
    assert.strictEqual(auth.checkSessione(tOspite), null, 'cambiata la password demo, il vecchio ospite non entra piu\'');
    const tOspiteDue = auth.makeToken('demo', 'demo');
    assert.ok(auth.togliDemoCondiviso());
    assert.strictEqual(auth.checkSessione(tOspiteDue), null, 'ritirata la demo condivisa, il cookie gia\' emesso muore');
    // E nessuno dei due gesti butta fuori chi con l'ospite non c'entra: il secret non si tocca.
    assert.deepStrictEqual(auth.checkSessione(tPapa), { ruolo: 'full', id: 'owner' });
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/auth')];
  }
});

test('saved: il clic segna letto SOLO quell\'avviso', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-letti-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const saved = require('../backend/saved');
  try {
    const s = saved.addSaved(U, { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
    const ann = n => Array.from({ length: n }, (_, i) => ({ url: 'https://x/' + i, prezzo: 10000 + i, titolo: 'Golf ' + i }));
    saved.recordCheck(U, s.id, ann(1), {});          // baseline
    saved.recordCheck(U, s.id, ann(4), {});          // tre nuovi
    assert.strictEqual(saved.listSaved(U).find(x => x.id === s.id).novita, 3);

    saved.markRead(U, s.id, 'https://x/1');
    assert.strictEqual(saved.listSaved(U).find(x => x.id === s.id).novita, 2,
      'prima il clic su UNO faceva sparire tutta la coda');
    // Il bottone "segna tutti letti" resta, ma e' un gesto diverso e esplicito.
    saved.markRead(U, s.id);
    assert.strictEqual(saved.listSaved(U).find(x => x.id === s.id).novita, 0);
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
  }
});

// Il test qui sopra ha URL tutti DIVERSI, ed e' il caso facile. Lo stesso annuncio con due
// avvisi vivi — 'nuovo' mai aperto e 'calo' di un controllo dopo — e' la vita normale di una
// ricerca salvata, e li' il clic mandava letto l'avviso sbagliato.
test('saved: due avvisi sullo stesso annuncio si segnano letti insieme', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-letti2-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const saved = require('../backend/saved');
  try {
    const s = saved.addSaved(U, { label: 'Audi A3', params: { tipo: 'auto', marca: 'Audi', modello: 'A3' } });
    const altro = [{ url: 'https://www.autoscout24.it/annunci/altro-1', prezzo: 15000, titolo: 'Altro' }];
    const A3 = 'https://www.autoscout24.it/annunci/audi-a3-9f3';
    const con = p => [...altro, { url: A3, prezzo: p, titolo: 'Audi A3' }];
    saved.recordCheck(U, s.id, altro, {});        // baseline
    saved.recordCheck(U, s.id, con(20000), {});   // 'nuovo'
    saved.recordCheck(U, s.id, con(18000), {});   // 'calo', stesso url

    const vista = () => saved.listSaved(U).find(x => x.id === s.id);
    assert.deepStrictEqual(vista().alerts.map(a => a.motivo), ['calo', 'nuovo'], 'lo schermo mette il piu\' recente in cima');
    assert.strictEqual(vista().novita, 2);

    // Il clic e' sulla riga in cima ('calo') e manda solo l'url: prima segnava letto il 'nuovo'
    // — un avviso mai aperto — e al ricarico il 'calo' tornava non letto.
    assert.strictEqual(saved.markRead(U, s.id, A3), true);
    assert.strictEqual(vista().novita, 0, 'aperto l\'annuncio, nessuno dei suoi avvisi resta indietro');
    assert.strictEqual(saved.markRead(U, s.id, A3), false, 'niente da segnare due volte');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
  }
});

// ═══ IL CONTESTO CAMBIA IN UN PUNTO SOLO ══════════════════════════════════════
// Non difendono otto correzioni: difendono la regola. Quando cambia CIO' CHE SI STA
// GUARDANDO — una ricerca nuova, il parco di un concessionario, un gruppo di vetrine, il
// passaggio Auto/Moto — lo stato che descriveva la schermata di prima deve sparire tutto
// insieme, in un posto solo. Finche' erano tre punti a farlo, ognuno ne dimenticava un
// pezzo diverso, e il pezzo dimenticato descriveva un'altra ricerca.
const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
/**
 * Sorgente a COMMENTI TOLTI. Un match POSITIVO soddisfatto dalla prosa non prova niente —
 * e' successo: `renameSync` stava anche nel JSDoc, e la guardia era verde leggendo il
 * commento. E un match NEGATIVO su un commento fa rosso un comportamento giusto. Le
 * letture che fanno da CONFINE a `ritaglia`/`corpoDi` usano i commenti come delimitatori:
 * li' questo helper NON si applica.
 */
const codice = src => src.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');

/** il corpo di `function nome(` fino alla parentesi graffa di chiusura in colonna 0 */
function corpoDi(src, firma) {
  const i = src.indexOf(firma);
  assert.ok(i > 0, `non trovo piu' \`${firma}\` in frontend/app.js`);
  const fine = src.indexOf('\n}\n', i);
  return src.slice(i, fine === -1 ? undefined : fine);
}

test('contesto: ogni punto che riempie la griglia passa dall\'azzeramento', () => {
  // I tre che scrivono `currentResults` con dei veicoli dentro. Nessuno puo' cavarsela da
  // solo: `doSearch` ci arriva via hideResults, gli altri due chiamano direttamente.
  assert.ok(/function resetContesto\(\)/.test(APP), 'resetContesto() non esiste piu\'');
  assert.ok(/function hideResults\(\)\s*\{\s*resetContesto\(\);/.test(APP),
    'hideResults deve cominciare azzerando il contesto');
  for (const f of ['function cpMostraParco(', 'function cpMostraGruppo(']) {
    assert.ok(/resetContesto\(\)/.test(corpoDi(APP, f)),
      `${f}...) riempie la griglia senza azzerare il contesto: i criteri, i filtri e le colonne della ricerca di prima restano addosso al parco`);
  }
  assert.ok(/showLoading\(\); hideResults\(\);/.test(corpoDi(APP, 'async function doSearch(')),
    'doSearch non passa piu\' da hideResults: il contesto precedente non verrebbe azzerato');
});

test('contesto: ogni porta d\'ingresso sincronizza i filtri auto con la funzione unica', () => {
  // Le porte sono quattro — init, il change del tipo (registrato dentro init),
  // applyUrlParams e setSearchMode — e la visibilita' delle otto tendine la decide UNA
  // funzione. Con una copia inline del toggle le due regole sarebbero tornate a divergere;
  // con una porta che non chiama, le tendine di un altro contesto restano a schermo e la
  // scelta si perde in silenzio (filtriAutoScelti si legge solo nel ramo tipo==='auto').
  for (const f of ['async function applyUrlParams(', 'function setSearchMode(']) {
    assert.ok(/sincronizzaFiltriAuto\(/.test(corpoDi(APP, f)),
      `${f}...) non chiama sincronizzaFiltriAuto: quella porta lascia i filtri del contesto di prima`);
  }
  assert.ok(!/classList\.toggle\('d-none', [^)]*!== 'auto'\)/.test(APP.replace(corpoDi(APP, 'function sincronizzaFiltriAuto('), '')),
    'il toggle dei filtri auto e\' stato copiato fuori dalla funzione unica');
  const chiamate = (APP.match(/sincronizzaFiltriAuto\(/g) || []).length - 1;   // meno la definizione
  assert.ok(chiamate >= 4, `le porte del contesto sono quattro, le chiamate trovate ${chiamate}`);
});

test('contesto: lo stato della ricerca si azzera SOLO dentro resetContesto', () => {
  const reset = corpoDi(APP, 'function resetContesto()');
  // Ognuno di questi descrive la ricerca, non il modo di guardare. Se ricompare un secondo
  // azzeramento altrove, le due copie divergono — ed e' esattamente com'era nato il difetto.
  // `(?<!let )` toglie di mezzo la DICHIARAZIONE della variabile, che ha lo stesso testo.
  const soloLi = {
    'lastSearchParams = null': /(?<!let )lastSearchParams = null/g,
    'soloIva = false': /(?<!let )soloIva = false/g,
    "groupDim = ''": /(?<!let )groupDim = ''/g,
    'liqMarca = null': /(?<!let )liqMarca = null/g,
    'liqAnn = null': /(?<!let )liqAnn = null/g,
    // Il toggle «mostrali» delle smentite: fuori dal reset condizionava la ricerca dopo.
    'mostraVersioniSmentite = false': /(?<!let )mostraVersioniSmentite = false/g,
    // La lista stessa: era azzerata in DUE punti fuori dal reset, il gemello strutturale
    // del difetto che questo test blinda per le altre variabili.
    'currentResults = []': /(?<!let )currentResults = \[\]/g,
  };
  for (const [nome, re] of Object.entries(soloLi)) {
    assert.ok(reset.match(re), `resetContesto non azzera piu' ${nome}`);
    const quante = (APP.match(re) || []).length;
    assert.strictEqual(quante, 1,
      `${nome} compare ${quante} volte: l'azzeramento del contesto deve stare in un punto solo (resetContesto)`);
  }
  // E queste NON si azzerano: sono come guardi, non cosa guardi (decisione del proprietario).
  assert.ok(!/sortState = \{ key: 'prezzo', dir: 'asc' \}/.test(reset),
    'l\'ordinamento e\' una preferenza di lettura: non si azzera al cambio contesto');
  assert.ok(!/confronto = \[\]/.test(reset),
    'gli annunci spuntati attraversano i contesti di proposito: non si svuotano');
  // L'unico che puo' svuotarlo e' il bottone "Svuota": lo svuota chi lo chiede, non un
  // cambio di schermata. Prima lo faceva anche `doSearch`, e la selezione spariva da sola.
  const svuotamenti = (APP.match(/confronto = \[\]/g) || []).length;
  assert.strictEqual(svuotamenti, 1,
    `il confronto viene svuotato in ${svuotamenti} punti: deve restare solo il bottone "Svuota"`);
  assert.ok(/compareClear\?\.addEventListener\('click', \(\) => \{ confronto = \[\];/.test(APP),
    'l\'unico svuotamento del confronto deve essere il bottone "Svuota"');
});

test('scheda: quel che si mostra di un annuncio non si chiede all\'ultima ricerca', () => {
  // La regola di campagna 2-bis, portata dove non era arrivata. Questi tre decidono COSA
  // mostrare sotto un annuncio: nel parco di un concessionario `lastSearchParams` e' di
  // un'altra ricerca (o non c'e'), e leggerlo qui significava attribuire a questo veicolo i
  // dati di un altro. Passano tutti da `coppiaAnnuncio`/`richiamiMarca`.
  for (const f of ['function liqCorpoHTML(', 'function gommeChiave(', 'function vehRichiamiHTML(']) {
    assert.ok(!/lastSearchParams/.test(corpoDi(APP, f)),
      `${f}...) legge di nuovo lastSearchParams: sotto un annuncio del parco mostrerebbe i dati del modello CERCATO`);
  }
  // E chi carica e chi disegna devono chiedere alla stessa funzione, senno' il blocco
  // sparisce proprio nei casi in cui la ricerca sarebbe riuscita.
  assert.ok(/function richiamiMarca\(\)/.test(APP), 'richiamiMarca() non esiste piu\'');
  for (const f of ['async function vehRichiamiCarica(', 'function vehRichiamiHTML(']) {
    assert.ok(/richiamiMarca\(\)/.test(corpoDi(APP, f)), `${f}...) non usa piu' richiamiMarca()`);
  }
});

test('scheda: chi scarta una risposta vecchia non lascia il blocco in attesa per sempre', () => {
  assert.ok(/const scartata = my => my !== vehGen;/.test(APP), 'scartata() non esiste piu\'');
  // Questi cinque scrivono un\'attesa PERSISTENTE e ripartono solo se quello stato e' vuoto:
  // uscire senza azzerarlo li lascia su "Cerco..." finche' non si cambia annuncio.
  const attese = {
    'async function vehRichiamiCarica(': 'vehRichiami = null',
    'async function vehMisureCarica(': 'vehMisure = null',
    'async function vehProvaCarica(': 'vehProva = null',
    'async function vehOmoCarica(': 'delete vehOmoStato[numero]',
    'async function fetchVehSpecs(': 'delete vehSpecs[url]',
  };
  for (const [f, azzera] of Object.entries(attese)) {
    const c = corpoDi(APP, f);
    assert.ok(c.includes('scartata('), `${f}...) non usa scartata(): il token va letto da un punto solo`);
    assert.ok(c.includes(azzera),
      `${f}...) scarta la risposta vecchia senza azzerare l'attesa (${azzera}): il blocco resta su "Cerco…" per sempre`);
  }
});

test('versione: scelta esplicita, ricerca generale senza filtro e versione specifica solo col modello scelto', () => {
  const norm = APP.slice(APP.indexOf('const acn ='), APP.indexOf('\n', APP.indexOf('const acn =')));
  const scelta = APP.slice(APP.indexOf('const VERSIONE_NESSUNA ='), APP.indexOf('function resetVersioneOnly()'));
  const ctx = {};
  vm.runInNewContext(norm + '\n' + scelta + '\nthis.sceltaVersione = sceltaVersione;', ctx);
  assert.match(ctx.sceltaVersione('', false).errore, /Scegli una versione/);
  assert.strictEqual(ctx.sceltaVersione('Nessuna Versione', false).versione, null);
  assert.strictEqual(ctx.sceltaVersione(' nessuna versione ', true).versione, null);
  assert.match(ctx.sceltaVersione('R', false).errore, /scegli prima il modello/);
  assert.strictEqual(ctx.sceltaVersione('R', true).versione, 'R');
  const ds = corpoDi(APP, 'async function doSearch(');
  assert.ok(ds.includes('sceltaVersione(versioneInput?.value, modelloScelto)')
    && ds.includes('if (scelta.errore)') && ds.includes('if (scelta.versione) params.versione = scelta.versione'),
  'la validazione deve precedere ogni chiamata di ricerca, e Nessuna Versione non deve diventare un filtro');
  assert.ok(INDEX.includes('id="versione"') && INDEX.includes('aria-required="true"')
    && !/id="versione"[^>]*\bdisabled\b/.test(INDEX),
  'la scelta Nessuna Versione deve essere possibile anche per la sola marca');
});

test('foto: niente richieste allo scorrimento, e la miniatura si aggiorna nelle due viste', () => {
  assert.ok(!/new IntersectionObserver/.test(codice(APP)),
    'e\' tornato l\'arricchimento allo scorrimento: i dettagli si chiedono al clic sull\'annuncio');
  const u = corpoDi(APP, 'function updateRowThumb(');
  assert.ok(u.includes('.result-row[data-url=') && u.includes('.ann-card[data-url='),
    'updateRowThumb deve trovare la riga in TUTTE E DUE le viste: quella predefinita e\' a schede (.ann-card)');
});

test('province: una preferenza per una domanda sola', () => {
  // Prezzi del carburante e costo del passaggio sono due domande diverse e vivevano sulla
  // stessa preferenza: cambiare la tendina dentro "Costo carburante" per confrontare il
  // prezzo al litro spostava l'IPT. Misurato sui dati veri (107 province, aliquote
  // 0/20/25/30%): su un'auto da 90 kW il passaggio va da 343,07 € ad Aosta a 437,89 € a
  // Viterbo. Chi calcola il passaggio non deve piu' leggere la provincia del carburante.
  for (const f of ['function passProvincia(', 'function passCorpoHTML(']) {
    assert.ok(!/carbProvincia\(\)/.test(corpoDi(APP, f)),
      `${f}...) legge di nuovo carbProvincia(): la tendina della benzina tornerebbe a spostare l'IPT`);
  }
  // La chiave dev'essere SUA, e va sia letta sia scritta. Da quando le preferenze che cambiano
  // i numeri seguono la persona e non il dispositivo, chi scrive e' `salvaPref` (browser +
  // account); quello che si difende qui e' la chiave separata, non il verbo.
  assert.ok(/localStorage\.getItem\('amrPassProvincia'\)/.test(APP) &&
            /salvaPref\('amrPassProvincia'/.test(APP),
    'la provincia del passaggio non ha piu\' una preferenza sua');
  // E cambiandola, i conti gia' fatti con l'altra provincia si buttano invece di restare
  // a schermo con la sigla nuova sopra un importo vecchio.
  assert.ok(/if \(x\._pass && !x\._passProvAnnuncio\) delete x\._pass/.test(APP),
    'cambiando la tua provincia, i passaggi gia' + "'" + ' calcolati devono essere rifatti');
});

// ═══ IL VALORE VIAGGIA CON LA SUA UNITA' ══════════════════════════════════════
// Qui non si cerca del testo: si ESEGUE il codice vero di frontend/app.js. Le funzioni
// interessate sono pure (spec dentro, numero fuori), quindi si ritagliano dal sorgente e si
// eseguono con i pochi globali che usano. Se qualcuno le riscrive in un altro file o cambia
// nome, il ritaglio non trova piu' niente e il test lo dice.
/** Ritaglia dal sorgente il blocco che va da `da` fino alla riga che comincia con `finoA`. */
function ritaglia(src, da, finoA) {
  const i = src.indexOf(da);
  assert.ok(i > 0, `non trovo piu' \`${da}\` in frontend/app.js`);
  const j = src.indexOf(finoA, i);
  assert.ok(j > i, `non trovo piu' la fine del blocco (\`${finoA}\`) dopo \`${da}\``);
  return src.slice(i, j);
}
/** Esegue i pezzi ritagliati in un contesto con i globali dati, e ne restituisce le funzioni. */
function esegui(pezzi, globali, nomi) {
  const chiavi = Object.keys(globali);
  const corpo = pezzi.join('\n') + '\nreturn {' + nomi.join(',') + '};';
  return new Function(...chiavi, corpo)(...chiavi.map(k => globali[k]));
}

test('carburante: il costo si calcola sul ciclo MISTO, non sulla prima riga', () => {
  const { vehConsumo } = esegui([
    ritaglia(APP, 'function vehConsumo(spec)', '\n// Aritmetica del costo'),
  ], {}, ['vehConsumo', 'carbConsumoDa', 'carbFamigliaDa']);

  // La scheda vera della Golf VII R 2.0 TSI: i tre cicli, nell'ordine in cui arrivano.
  const spec = { groups: [{ rows: [
    { k: 'Tipo carburante', v: 'Benzina' },
    { k: 'Consumo nel ciclo urbano (NEDC, WLTP equivalente)', v: '8.6-8.9 l/100 km' },
    { k: 'Consumo nel ciclo extraurbano (NEDC, WLTP equivalente)', v: '5.9-6.2 l/100 km' },
    { k: 'Consumo nel ciclo misto (NEDC, WLTP equivalente)', v: '6.9-7.2 l/100 km' },
  ] }] };
  assert.strictEqual(vehConsumo(spec).consumo, 7.05,
    'il conto deve partire dal ciclo misto (7,05), non dall\'urbano (8,75): a 15.000 km l\'anno sono ~446 € di differenza');
  assert.strictEqual(vehConsumo(spec).famiglia, 'benzina');

  // Fra due misti vince quello europeo: l'EPA e' lo standard americano e da' numeri diversi.
  const conEpa = { groups: [{ rows: [
    { k: 'Tipo carburante', v: 'Benzina' },
    { k: 'Consumo nel ciclo misto (EPA)', v: '9 l/100 km' },
    { k: 'Consumo nel ciclo misto (NEDC, WLTP equivalente)', v: '7 l/100 km' },
  ] }] };
  assert.strictEqual(vehConsumo(conEpa).consumo, 7, 'fra due cicli misti si prende quello europeo');

  // Senza il misto si prende quello che c'e': meglio un ciclo dichiarato che nessun costo.
  const senzaMisto = { groups: [{ rows: [
    { k: 'Tipo carburante', v: 'Diesel' },
    { k: 'Consumo nel ciclo urbano (NEDC)', v: '6 l/100 km' },
  ] }] };
  assert.strictEqual(vehConsumo(senzaMisto).consumo, 6);
  assert.strictEqual(vehConsumo(senzaMisto).famiglia, 'gasolio');

  // Nessuna riga di consumo: niente banda, mai una stima inventata.
  assert.strictEqual(vehConsumo({ groups: [{ rows: [{ k: 'Tipo carburante', v: 'Benzina' }] }] }).consumo, null);
});

test('carburante: l\'etichetta dice da dove viene quel prezzo al litro', () => {
  const { carbEtichettaPrezzi } = esegui([
    ritaglia(APP, 'const carbEtichettaPrezzi = voce =>', '\nfunction vehCostoHTML'),
  ], {}, ['carbEtichettaPrezzi']);
  // Misurato sull'indice vero: benzina e gasolio sono self in tutte e 107 le province; GPL
  // (107/107) e metano (99/99) no — 206 voci su 420 dove il prezzo e' self + servito.
  assert.match(carbEtichettaPrezzi({ p: 1.75, n: 40, self: true }), /^Prezzi self$/);
  assert.match(carbEtichettaPrezzi({ p: 0.72, n: 34, self: false }), /self e servito insieme/,
    'dove il campione self e\' troppo magro il prezzo e\' una mediana mista: l\'etichetta lo deve dire');
});

test('unita\': il consumo di un rilevamento porta l\'unita\' che la FONTE dichiara', () => {
  const { unitaCons, misNum } = esegui([
    ritaglia(APP, 'const misNum = (v, u)', '\nfunction vehMisureHTML'),
  ], {}, ['unitaCons', 'misNum']);
  assert.strictEqual(unitaCons({ unitaConsumo: 'l/100km' }), 'l/100 km');
  assert.strictEqual(unitaCons({ unitaConsumo: 'kWh/100km' }), 'kWh/100 km',
    'su un\'elettrica il numero e\' in kWh: scrivergli accanto "l/100 km" lo trasforma in un altro dato');
  assert.strictEqual(unitaCons(null), 'l/100 km');
  assert.strictEqual(misNum(7.05, 'l/100 km'), '7,05 l/100 km');
  assert.strictEqual(misNum(null, 'l/100 km'), null, 'un valore che non c\'e\' non diventa un\'unita\' sola');
});

test('IVA: si scorpora solo dove la fonte la dichiara, e altrove si dice perche\'', () => {
  const { pricing, PRICE_DEFAULT } = require('../frontend/pricing.js');
  const cfg = { ...PRICE_DEFAULT, iva: true };
  const { vPricing, notaIva } = esegui([
    ritaglia(APP, 'const ivaDichiarata = r =>', '\nconst rPricing = base'),
  ], { pricing, priceCfgV: cfg }, ['vPricing', 'notaIva', 'ivaDichiarata', 'cfgPerRiga']);

  // Misurato su una ricerca Golf 9-20k, 204 annunci: 5 dichiarano l'IVA esposta, 117
  // dichiarano il regime del margine, 82 la fonte tace. Prima si scorporava a tutti e 204.
  const dichiara = { prezzo: 12000, ivaEsposta: true };
  const margine  = { prezzo: 12000, ivaEsposta: false };
  const muto     = { prezzo: 12000 };

  assert.ok(vPricing(dichiara.prezzo, null, dichiara).imponibile > 0, 'chi dichiara l\'IVA la scorpora');
  assert.strictEqual(vPricing(margine.prezzo, null, margine).imponibile, null,
    'in regime del margine non c\'e\' IVA da scorporare: la colonna resta vuota, non a zero');
  assert.strictEqual(vPricing(muto.prezzo, null, muto).imponibile, null,
    'dove la fonte tace non si inventa un imponibile');
  // Il prezzo finale non dipende dall'IVA: deve restare identico per tutti e tre.
  const f = r => vPricing(r.prezzo, null, r).finale;
  assert.strictEqual(f(dichiara), f(margine));
  assert.strictEqual(f(margine), f(muto));

  assert.strictEqual(notaIva(dichiara), '', 'chi la dichiara non ha niente da spiegare');
  assert.match(notaIva(margine), /margine/, 'la riga deve dire perche\' l\'IVA non c\'e\'');
  assert.match(notaIva(muto), /non dichiarata/, '"non c\'e\'" e "non lo so" non sono la stessa cosa');
});

// ═══ IL LIMITATORE NON PUNISCE CHI INSISTE ════════════════════════════════════
test('limite: una richiesta rifiutata NON si addebita', () => {
  const lim = require('../backend/limite-richieste').crea({ max: 3, finestra: 60000, cosa: 'richieste' });
  for (let i = 0; i < 3; i++) assert.strictEqual(lim.consuma('tizio').ok, true, `la richiesta ${i + 1} sta nel tetto`);
  // Da qui in poi si insiste: erano proprio questi tentativi a gonfiare la finestra, e con
  // un client che ritenta ogni secondo la sezione non si riapriva mai.
  for (let i = 0; i < 50; i++) assert.strictEqual(lim.consuma('tizio').ok, false);
  const s = lim.stato('tizio');
  assert.strictEqual(s.restanti, 0);
  assert.ok(s.attesa > 0 && s.attesa <= 60,
    `l'attesa deve restare dentro la finestra anche dopo 50 tentativi, invece e' ${s.attesa}s`);
});

test('limite: il blocco di uno non tocca gli altri, e si dice quando riprovare', () => {
  const lim = require('../backend/limite-richieste').crea({ max: 2, finestra: 60000, cosa: 'richieste' });
  lim.consuma('anna'); lim.consuma('anna');
  assert.strictEqual(lim.consuma('anna').ok, false, 'anna ha finito il suo budget');
  // I limiti seguono la PERSONA (campagna 6): il tetto di anna non e' il tetto di bruno.
  assert.strictEqual(lim.consuma('bruno').ok, true, 'bruno non c\'entra niente col blocco di anna');
  assert.strictEqual(lim.stato('bruno').restanti, 1);
  // E il 429 dice quando si puo' riprovare: prima lo faceva solo il competitor.
  const msg = lim.messaggio(lim.stato('anna'));
  assert.match(msg, /Riprova fra/, 'il messaggio deve dire quando riprovare');
  assert.match(msg, /sono 2 ogni 60 secondi/, 'e quale sia il tetto');
});

test('limite: guardare non consuma, e la finestra che scade libera il posto', async () => {
  const lim = require('../backend/limite-richieste').crea({ max: 1, finestra: 60000 });
  // `stato` e' una domanda, non un prelievo: serve a MOSTRARE il budget senza spenderlo.
  for (let i = 0; i < 10; i++) assert.strictEqual(lim.stato('tizio').restanti, 1);
  assert.strictEqual(lim.consuma('tizio').ok, true);
  assert.strictEqual(lim.stato('tizio').restanti, 0);
  // Finestra brevissima: passata, il posto torna libero da solo. Serve un'attesa vera —
  // dentro lo stesso millisecondo il timestamp e' ancora DENTRO la finestra, ed e' giusto.
  const breve = require('../backend/limite-richieste').crea({ max: 1, finestra: 5 });
  assert.strictEqual(breve.consuma('tizio').ok, true);
  assert.strictEqual(breve.stato('tizio').restanti, 0, 'appena consumato il posto e\' occupato');
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(breve.stato('tizio').restanti, 1, 'passata la finestra il budget torna pieno');
  assert.strictEqual(breve.consuma('tizio').ok, true);
});

test('cache: TUTTE le cache su disco passano dal modulo comune', () => {
  // Il modulo fa tre cose che ogni copia scritta a mano si dimenticava: numero di schema,
  // tetto alle voci, e scrittura accanto ai dati utente (nel pacchetto Electron la cartella
  // dell'app e' di sola lettura, e il `catch` vuoto ingoiava l'errore).
  // TUTTO backend/, non solo backend/scrapers/: la nona cache stava in backend/carburanti.js
  // e questo test non la vedeva. Non l'ha trovata il test, l'ha trovata un numero che non
  // cambiava — cambiare come si conta e non vederlo a schermo, perche' l'indice vecchio
  // usciva da una cache senza numero di schema.
  const base = path.join(__dirname, '..', 'backend');
  const files = [];
  for (const d of [base, path.join(base, 'scrapers')]) {
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.js')) continue;
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) continue;
      if (/const CACHE_FILE\s*=/.test(fs.readFileSync(p, 'utf8'))) files.push(p);
    }
  }
  assert.ok(files.length >= 9, `attese almeno 9 cache su disco, trovate ${files.length}`);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.match(src, /cacheDisco\.crea\(/, `${path.basename(f)} ha una cache su disco che non passa dal modulo comune`);
    assert.match(src, /schema:/, `${path.basename(f)} non dichiara il numero di schema: un cambio di parser (o di conteggio) servirebbe il formato vecchio per tutto il TTL`);
    assert.match(src, /max:/, `${path.basename(f)} non ha un tetto: il file cresce senza fine e ogni miss lo riscrive intero`);
    assert.ok(!/fs\.writeFileSync\(\s*CACHE_FILE/.test(codice(src)),
      `${path.basename(f)} scrive ancora la cache da se', dentro la cartella dell'app`);
  }
});

test('cache: una copia SCADUTA non si serve al posto di una fonte caduta', async () => {
  const cacheDisco = require('../backend/scrapers/cache-disco');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-scaduta-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  try {
    const file = path.join(dir, 'prova-scaduta.json');
    // Una voce buona ma VECCHIA: scritta oltre il TTL.
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'prova-scaduta.json'),
      JSON.stringify({ schema: 1, voci: { k: { t: Date.now() - 10 * 60 * 1000, d: 'dato di ieri' } } }));
    const conCache = cacheDisco.crea(file, { tag: 'prova', schema: 1, ttl: 60 * 1000, max: 10 });

    // La fonte cade. Prima usciva "dato di ieri" e nessuno poteva accorgersene: a schermo era
    // indistinguibile da un dato appena preso. Ora l'errore arriva a chi chiama, che ha gia'
    // il suo modo di dichiararlo ("archivio non raggiungibile").
    await assert.rejects(
      () => conCache('k', async () => { throw new Error('fonte KO'); }),
      /fonte KO/,
      'la copia scaduta non deve prendere il posto di una fonte che non ha risposto');

    // E una copia ANCORA VALIDA si serve eccome, senza nemmeno chiamare la fonte.
    fs.writeFileSync(path.join(dir, 'cache', 'prova-scaduta.json'),
      JSON.stringify({ schema: 1, voci: { fresca: { t: Date.now(), d: 'dato di adesso' } } }));
    const conCache2 = cacheDisco.crea(file, { tag: 'prova', schema: 1, ttl: 60 * 1000, max: 10 });
    assert.strictEqual(await conCache2('fresca', async () => { throw new Error('non deve partire'); }), 'dato di adesso');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});

test('cache: `forza` interroga la fonte anche con una copia fresca, e la sostituisce', async () => {
  const cacheDisco = require('../backend/scrapers/cache-disco');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-forza-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  try {
    const file = path.join(dir, 'prova-forza.json');
    // Una voce FRESCA, come quella che build-insella-index trovava a un rilancio entro il TTL:
    // lo script diceva "scorro le categorie" ma riserviva il crawl precedente, zero richieste,
    // e riscriveva su disco lo stesso indice — anche monco, anche dopo un fix al parser.
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'prova-forza.json'),
      JSON.stringify({ schema: 1, voci: { indice: { t: Date.now(), d: 'crawl vecchio' } } }));
    const conCache = cacheDisco.crea(file, { tag: 'prova', schema: 1, ttl: 60 * 1000, max: 10 });

    let chiamate = 0;
    assert.strictEqual(await conCache('indice', async () => { chiamate++; return 'crawl nuovo'; }, null, { forza: true }),
      'crawl nuovo', 'con forza la fonte si interroga davvero');
    assert.strictEqual(chiamate, 1);
    // Il risultato nuovo prende il posto della voce: il crawl vecchio non risorge.
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'cache', 'prova-forza.json'), 'utf8')).voci.indice.d, 'crawl nuovo');
    assert.strictEqual(await conCache('indice', async () => { throw new Error('senza forza la copia fresca basta'); }), 'crawl nuovo');

    // Se il giro forzato fallisce, la copia fresca NON lo maschera: lo script deve fermarsi.
    await assert.rejects(
      () => conCache('indice', async () => { throw new Error('fonte KO'); }, null, { forza: true }),
      /fonte KO/,
      'un rilancio forzato che non riesce a leggere la fonte deve dirlo, non riservire la cache');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});

// ═══ LA CODA: casi singoli, stessa disciplina ═════════════════════════════════
test('richiami: le allerte escono dalla piu\' recente, non dalla piu\' vecchia', () => {
  const { cerca } = require('../backend/richiami-route.js');
  const r = cerca({ marca: 'Mercedes-Benz' });
  if (!r.ok) { assert.ok(/non costruito/.test(r.motivo), r.motivo); return; }   // archivio assente: niente da provare
  const data = x => { const m = String(x.dataReport || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : 0; };
  const d = r.allerte.map(data);
  for (let i = 1; i < d.length; i++) {
    assert.ok(d[i - 1] >= d[i],
      `allerta ${i} e' piu' recente di quella prima: l'archivio arriva ordinato per numero di caso come stringa, e l'anno sta in fondo`);
  }
  // Il pannello ne mostra otto: devono essere le otto piu' recenti che esistono per quella marca.
  const piuRecente = Math.max(...r.allerte.map(data));
  assert.strictEqual(data(r.allerte[0]), piuRecente,
    'la prima a schermo deve essere la piu' + "'" + ' recente in assoluto per quella marca');
});

test('annuncio: l\'identita\' non e\' l\'indirizzo, e il passato si converte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-id-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const saved = require('../backend/saved');
  try {
    // L'URL di Subito porta dentro il titolo scritto dal venditore.
    const urlPrima = 'https://www.subito.it/auto/ford-kuga-2-0-tdci-150-cv-titan-cagliari-651863039.htm';
    const urlDopo  = 'https://www.subito.it/auto/ford-kuga-2-0-tdci-150cv-PREZZO-TRATTABILE-cagliari-651863039.htm';
    const s = saved.addSaved(U, { label: 'Kuga', params: { tipo: 'auto', marca: 'Ford' } });
    // Baseline scritta con le chiavi VECCHIE, com'e' il file di chi aggiorna oggi.
    saved.recordCheck(U, s.id, [{ fonte: 'subito', url: urlPrima, titolo: 'Kuga', prezzo: 12000 }]);

    // Il venditore ritocca il titolo: URL nuovo, stesso annuncio. Prima era un falso "nuovo".
    const dopo = saved.recordCheck(U, s.id, [{ fonte: 'subito', id: 'subito:651863039', url: urlDopo, titolo: 'Kuga', prezzo: 12000 }]);
    assert.deepStrictEqual(dopo, [], 'un titolo ritoccato non e\' un annuncio nuovo');

    // E lo storico del prezzo e' sopravvissuto: un calo vero deve ancora suonare.
    const calo = saved.recordCheck(U, s.id, [{ fonte: 'subito', id: 'subito:651863039', url: urlDopo, titolo: 'Kuga', prezzo: 10500 }]);
    assert.strictEqual(calo.length, 1, 'il calo deve suonare: senza la conversione la base di confronto era persa');
    assert.strictEqual(calo[0].motivo, 'calo');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
  }
});

test('ricambi: la scheda del pezzo non prende foto ne\' dati dagli annunci', () => {
  const core = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ricambi-core.js'), 'utf8');
  for (const forma of ['scheda.fotoReale', 'scheda.datiTecniciEbay', 'scheda.galleria']) {
    assert.ok(!core.includes(forma + ' ='),
      `${forma} viene di nuovo riempito da un annuncio: la scheda e' l'identita' di catalogo del pezzo`);
  }
  assert.ok(!/res\.subito\?\.items.*immagine/.test(core),
    'la foto della scheda non puo\' venire dal primo annuncio usato di Subito');
});

test('ricambi: i codici OE si leggono dai link, non dal testo', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'oem-lookup.js'), 'utf8');
  assert.match(src, /a\[href\*="\/pezzi-di-ricambio\/oem\/"\]/,
    'i codici OE devono venire dai link a un\'altra pagina OEM: e\' la pagina stessa a dichiarare che quello e\' un codice');
  // La vecchia pesca nel testo accettava anche le minuscole, e frasi intere passavano il
  // filtro a valle. Verificato sulle frasi vere della pagina.
  assert.ok(!/textContent\.match\(\/\[A-Z0-9\]/.test(codice(src)),
    'e\' tornata la pesca nel testo: "Garanzia 2 anni" diventerebbe di nuovo un codice OE');
  const { dedupeOe } = require('../backend/oem-lookup.js');
  // I dieci codici veri letti dalla pagina (sonda 2026-08-01) passano tutti.
  const veri = ['1K0 905 841', '1K0905865A', '1K0905865', '1K0 905 851', '1K0905849B',
                '6RA905865A', '6RA905865', '1K0905865B', '1K0 905 851D', '1K0905849A'];
  assert.strictEqual(dedupeOe(veri, '1K0905851B').length, 10);
  // E le frasi che prima passavano restano fuori solo perche' non sono link: il filtro a
  // valle da solo non basta, ed e' esattamente perche' la lettura ora e' strutturale.
  assert.ok(dedupeOe(['Garanzia 2 anni'], '1K0905851B').length === 1,
    'il filtro a valle NON riconosce le frasi: se tornasse la pesca nel testo tornerebbero anche i falsi');
});

// ═══ I MINORI: stessa disciplina, casi piccoli ════════════════════════════════
test('minori: un errore non si mette in cache', () => {
  // Tre punti diversi, una regola sola: una risposta mancata non e' una risposta.
  const richiami = fs.readFileSync(path.join(__dirname, '..', 'backend', 'richiami-route.js'), 'utf8');
  // La guardia copre `ok:false` E gli altri modi in cui le rotte dicono "non lo so"
  // (`pronto:false`, `archivio:false`): la revisione del 2026-08-22 ha trovato che /stato,
  // /marche e /ultime non passavano da `ok:false` e prendevano un'ora di cache lo stesso.
  assert.match(richiami, /const nonPronto = out && \(out\.ok === false \|\| out\.pronto === false/,
    'le rotte richiami rimettono un\'ora di cache su un "archivio non costruito"');
  assert.match(richiami, /if \(out && !nonPronto\) res\.set\('Cache-Control', 'public, max-age=3600'\)/,
    'l\'ora di cache va SOLO su una risposta pronta');
  const ebay = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ebay-scrape.js'), 'utf8');
  assert.ok(!/item details[\s\S]{0,80}return \{\}/.test(codice(ebay)),
    'un 403 di eBay torna a diventare una scheda vuota, che il chiamante cacha per un\'ora');
  assert.ok(!/catch \{ modelCache\[key\] = \[\]; \}/.test(codice(APP)),
    'una risposta mancata di /api/models torna a spegnere la tendina per tutta la sessione');
});

test('ricerca Auto/Moto: nessun modulo browser resta nel percorso', () => {
  const base = path.join(__dirname, '..', 'backend', 'scrapers');
  for (const f of ['subito-playwright.js', 'subito-bootstrap.js', 'subito-session.js', 'autoscout-playwright.js']) {
    assert.ok(!fs.existsSync(path.join(base, f)), `${f} e' ancora nel percorso di ricerca`);
  }
});

test('minori: i numeri a schermo contano quello che dicono di contare', () => {
  // «solo N impianti» contava le quotazioni: un distributore che vende self E servito
  // mandava due righe, e il campione sembrava il doppio di quello che e'.
  const carb = fs.readFileSync(path.join(__dirname, '..', 'backend', 'carburanti.js'), 'utf8');
  assert.match(carb, /n: \(usaSelf \? v\.impSelf : v\.impTutti\)\.size/,
    'il numero dietro il prezzo deve contare gli impianti del campione usato');
  // «N pneumatici registrati» era il numero della pagina chiesta, non dell'archivio EPREL.
  assert.match(APP, /st\.totale != null && st\.totale > p\.length/,
    'il pannello pneumatici deve dire quanti ne esistono, non quanti ne ha scaricati');
  // «Compatibilita' · N modelli» contava quelli passati dal server (venti al massimo).
  assert.match(APP, /Number\.isFinite\(totale\) && totale > list\.length/,
    'la compatibilita\' deve dire il totale vero');
});

test('minori: la verifica targa non dipende da una ricerca, e ha un freno', () => {
  // La targa non filtra niente: e' del veicolo che hai davanti, e la verifica va al
  // Portale dell'Automobilista. Legarla ai risultati obbligava a una ricerca inutile.
  const sync = ritaglia(APP, 'targaBtnSync = () => {', '\n  };');
  assert.ok(!/risultatiAVista/.test(sync),
    'il bottone della targa torna a dipendere dagli annunci a schermo');
  // Ed e' la rotta che va al portale ministeriale dall'indirizzo di casa: senza freno, un
  // ciclo impazzito fa bloccare l'unico posto dove una targa si verifica.
  const targa = fs.readFileSync(path.join(__dirname, '..', 'backend', 'targa.js'), 'utf8');
  assert.match(targa, /limite-richieste/, 'la sfida targa deve passare dal limitatore comune');
});

// ═══ QUELLO CHE SI ABBANDONA, SI FERMA ════════════════════════════════════════
test('annullo: una richiesta abbandonata si chiude davvero', async () => {
  const http = require('http');
  const annullo = require('../backend/annullo');
  let interrotte = 0, complete = 0;
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"a":');
    const t = setInterval(() => { try { res.write('0'); } catch (_) {} }, 20);
    const fine = setTimeout(() => { clearInterval(t); res.end('1}'); complete++; }, 3000);
    req.on('aborted', () => { interrotte++; clearInterval(t); clearTimeout(fine); });
    res.on('close', () => { clearInterval(t); clearTimeout(fine); });
  });
  await new Promise(r => srv.listen(0, r));
  const porta = srv.address().port;
  // Come lo fanno gli scraper: chiedono il segnale al momento della richiesta.
  const chiedi = () => new Promise((ok, ko) => {
    const r = http.get({ host: '127.0.0.1', port: porta, path: '/', signal: annullo.segnale() },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => ok(d.length)); });
    r.on('error', ko);
  });
  try {
    const ctrl = new AbortController();
    const p = annullo.dentro(ctrl.signal, () => chiedi());
    await new Promise(r => setTimeout(r, 120));
    ctrl.abort();                                    // e' quello che fa runSource allo scadere
    await assert.rejects(() => p, e => e.name === 'AbortError' || e.code === 'ABORT_ERR',
      'la richiesta abbandonata deve chiudersi, non restare aperta a scaricare');
    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(interrotte, 1, 'il server deve vedere la presa chiudersi');
    assert.strictEqual(complete, 0, 'e la risposta non deve arrivare a fondo');
    // Fuori da una ricerca il segnale non c'e', e non cambia niente: crawler, test e rotte
    // che riusano gli stessi scraper restano com'erano.
    assert.strictEqual(annullo.segnale(), undefined);
    assert.strictEqual(annullo.annullata(), false);
  } finally { srv.close(); }
});

test('annullo: le tre fonti chiedono il segnale al momento della richiesta', () => {
  for (const f of ['subito-api.js', 'motoit.js', 'autoscout-graphql.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', f), 'utf8');
    assert.match(src, /signal: annullo\.segnale\(\)/,
      `${f} non passa il segnale: una ricerca abbandonata continuerebbe a scaricare da quella fonte`);
  }
  // E `runSource` deve ricevere una FUNZIONE, senno' il lavoro nasce fuori dal contesto e
  // il segnale non lo raggiunge: e' l'errore facile da fare rileggendo questo codice.
  const srv = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(srv, /runSource\(\(\) =>/, 'le fonti vanno passate a runSource come funzione');
  assert.match(srv, /ctrl\.abort\(\)/, 'runSource deve annullare quando il tempo scade');
});

test('minori: le richieste eBay condividono la sessione browser dei Ricambi', () => {
  const ebay = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ebay-scrape.js'), 'utf8');
  assert.match(ebay, /_ctxInVolo/);
});

test('minori: uno schermo vuoto per un filtro non e\' un mercato vuoto', () => {
  const r = ritaglia(APP, 'if (sorted.length === 0) {', '\n  noResults.classList.add(');
  assert.match(r, /Nessuno di questi \$\{nascosti\} annunci passa/,
    'il pannello torna a dare la colpa alla ricerca quando a nascondere gli annunci e\' un filtro nostro');
  assert.match(r, /Solo IVA esposta/);
  assert.match(r, /cursore dei prezzi/);
});

// ═══ L'ETICHETTA DESCRIVE L'ANNUNCIO, NON IL NOSTRO FILTRO ════════════════════
test('moto.it: la versione si legge dall\'URL dell\'annuncio', () => {
  const { varianteDaSlug, slugDaUrl } = require('../backend/scrapers/motoit-versione');
  // Forme vere, prese da annunci veri (Honda CB 500, misurate il 2026-08-01).
  assert.strictEqual(slugDaUrl('https://www.moto.it/moto-usate/honda/cb-500/cb-500-s-1997-04/10010484'), 'cb-500-s-1997-04');
  assert.strictEqual(varianteDaSlug('cb-500-s-1997-04', 'cb-500'), 'S · 1997–2004');
  assert.strictEqual(varianteDaSlug('cb-500-x-abs-travel-edition-2015-16', 'cb-500'), 'X ABS TRAVEL EDITION · 2015–2016');
  assert.strictEqual(varianteDaSlug('cb-500-x-2021', 'cb-500'), 'X · 2021');
  // Il periodo scavalca il secolo: "1993-04" e' 1993–2004, non 1993–1904.
  assert.strictEqual(varianteDaSlug('cb-500-1993-04', 'cb-500'), '1993–2004');
  assert.strictEqual(varianteDaSlug('', 'cb-500'), null);
  /**
   * IL MODELLO PUO' ARRIVARE COME LISTA e va tolto lo stesso: `famiglieMotoit` torna piu'
   * famiglie separate da virgola quando il nome chiesto e' largo ("Scarabeo" → 9 famiglie
   * su Aprilia). Confrontata intera non combaciava mai, e la colonna versione stampava
   * modello+versione — «SCARABEO 500 · 2003–2006» dove Subito e Autoscout, nella stessa
   * tabella, scrivono la sola versione.
   */
  assert.strictEqual(varianteDaSlug('scarabeo-500-2003-06', 'scarabeo-50,scarabeo-125,scarabeo-500'), '2003–2006');
  assert.strictEqual(varianteDaSlug('scarabeo-125-s-2004-06', 'scarabeo-50,scarabeo-125,scarabeo-500'), 'S · 2004–2006');
  // Vince la famiglia PIU' LUNGA che combacia, non la prima: senno' "scarabeo" lascia "500 S".
  assert.strictEqual(varianteDaSlug('scarabeo-500-s-2003-06', 'scarabeo,scarabeo-500'), 'S · 2003–2006');
  /**
   * E QUANDO NESSUNA FAMIGLIA COMBACIA e' la stessa trappola, non un caso a parte: misurate
   * 998 versioni su 12.192 che non ripetono lo slug della loro famiglia. Benelli `trk-502`
   * contiene "TRK 502X", e nella stessa lista usciva "TRK 502X · 2018–2020" accanto a
   * "ABS · 2017–2020" — un nome di moto nella colonna dell'allestimento. Peggio su BMW: la
   * famiglia `r-1200-gs-adventure` contiene "R 1200 GS", cioe' il nome di un modello DIVERSO.
   * Senza famiglia che combaci resta il solo periodo; il modello si legge nel titolo.
   */
  assert.strictEqual(varianteDaSlug('trk-502-abs-2017-20', 'trk-502'), 'ABS · 2017–2020');
  assert.strictEqual(varianteDaSlug('trk-502x-2018-20', 'trk-502'), '2018–2020');
  assert.strictEqual(varianteDaSlug('r-1200-gs-2017-18', 'r-1200-gs-adventure'), '2017–2018');
  // Ricerca allargata alla marca: nessuno slug-modello, quindi niente da togliere — e niente
  // da scrivere. Prima usciva "TRK 502 ABS · 2017–2020", modello compreso.
  assert.strictEqual(varianteDaSlug('trk-502-abs-2017-20', null), '2017–2020');
  // Il periodo e' un ANNO: senza il vincolo, la cilindrata in coda passava per periodo.
  assert.strictEqual(varianteDaSlug('yb11-1000', 'yb11-1000'), null);          // era "YB11 · 1000"
  assert.strictEqual(varianteDaSlug('monster-s2r-1000', 'monster-s2r-1000'), null);
  // E lo scraper lo attacca all'annuncio, senno' l'etichetta non ha cosa leggere.
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'motoit.js'), 'utf8');
  assert.match(src, /variante:\s+varianteDaSlug\(slugDaUrl\(fullUrl\), opts\.modelSlug\)/);
});

test('moto.it: l\'etichetta segue la stessa regola delle altre due fonti', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  // Prima: senza `bike=` OGNI riga usciva 'senza-versione' — «il venditore non l'ha
  // indicata» — anche quando l'URL la dichiarava. Misurato: 7 righe su 7 su Honda CB 500.
  assert.match(srv, /else r\.dichiarazione = r\.variante \? 'esatto' : 'senza-versione';/,
    'Moto.it deve usare la versione dichiarata dall\'annuncio, come Subito e Autoscout');
  // E l'asimmetria: versione chiesta e non applicata → la stessa frase delle altre fonti,
  // non quella che da' la colpa al venditore.
  assert.match(srv, /else if \(versioneChiesta\) r\.dichiarazione = 'versione-non-verificata';/);
});

test('subito: l\'annuncio senza prezzo resta visibile senza inventare «su richiesta»', async () => {
  // Prima erano quattro asserzioni di GRAFIA: bastava un `if (m.prezzo == null) continue;`
  // due righe sopra il punto guardato per far tornare a sparire gli annunci con tutte le
  // asserzioni verdi. Qui il percorso si ESEGUE con lo stub HTTP: uno con prezzo e uno
  // senza, tutti e due in lista; l'assenza del campo non dice «su richiesta».
  const sub = require('../backend/scrapers/subito-api');
  const conPrezzo = { urn: 'a', urls: { default: 'https://www.subito.it/x/a.htm' }, subject: 'Golf A',
    features: [{ label: 'Prezzo', uri: '/price', values: [{ key: '9000', value: '9.000 €' }] }] };
  const senza = { urn: 'b', urls: { default: 'https://www.subito.it/x/b.htm' }, subject: 'Golf B', features: [] };
  sub._setHttpGetJson(async () => ({ status: 200, body: JSON.stringify({ count_all: 2, ads: [conPrezzo, senza] }) }));
  try {
    const r = await sub({ tipo: 'auto', marca: 'Volkswagen' }, { withMeta: true, pageDelayMs: 0 });
    assert.strictEqual(r.items.length, 2, 'l\'annuncio senza prezzo NON sparisce dalla lista');
    const muto = r.items.find(x => /b\.htm$/.test(x.url));
    assert.strictEqual(muto.prezzo, null);
    assert.ok(!muto.prezzoSuRichiesta,
      'nessuna dichiarazione della fonte autorizza «su richiesta»');
    assert.strictEqual(r.sospetto, null, 'UNO senza prezzo non e\' un parser rotto');
  } finally { sub._setHttpGetJson(null); }
  // Il caso «campo prezzo presente ma illeggibile» e' provato nel test sotto.
});

test('subito: prezzo assente e prezzo illeggibile restano distinti nella stessa ricerca', async () => {
  const sub = require('../backend/scrapers/subito-api');
  const srv = require('../backend/server');
  const ad = (id, prezzo) => ({
    urls: { default: `https://www.subito.it/moto/prova-${id}.htm` },
    subject: `Prova Modello ${id}`,
    features: prezzo == null ? [] : [{ uri: '/price', label: 'Prezzo', values: [{ value: `${prezzo} €` }] }],
  });
  let annunci = [ad(1, null), ad(2, 5000)];
  sub._setHttpGetJson(async () => ({ status: 200,
    body: JSON.stringify({ ads: annunci, count_all: annunci.length }) }));
  try {
    const params = { tipo: 'moto', marca: 'Prova', modello: 'Modello',
      subitoNodo: { marcaId: '987654', famigliaIds: ['111'] } };
    const mista = await srv._runSubito(params, 30000);
    assert.strictEqual(mista.status, 'ok');
    assert.strictEqual(mista.sospetto, null);
    assert.deepStrictEqual(mista.items.map(x => x.prezzo), [null, 5000]);
    annunci = [ad(3, null)];
    const assente = await srv._runSubito(params, 30000);
    assert.strictEqual(assente.status, 'ok');
    assert.strictEqual(assente.sospetto, null);
    annunci = [{ ...ad(4, null), features: [
      { uri: '/price', label: 'Prezzo', values: [{ value: 'dato illeggibile' }] },
    ] }, ad(5, 6000)];
    const anomala = await srv._runSubito(params, 30000);
    assert.strictEqual(anomala.status, 'ok');
    assert.match(anomala.parziale, /prezzo non leggibile/);
    assert.strictEqual(srv._cacheable({ sources: { subito: anomala,
      autoscout: { status: 'ok' }, moto: { status: 'ok' } }, totale: anomala.items.length }), true);
  } finally { sub._setHttpGetJson(null); }
});

test('subito: URI prezzo valido sopravvive alla nuova etichetta; campo illeggibile resta dichiarato', async () => {
  const sub = require('../backend/scrapers/subito-api');
  const srv = require('../backend/server');
  const ad = (id, feature) => ({
    urls: { default: `https://www.subito.it/auto/prova-${id}.htm` },
    subject: `Prova Modello ${id}`, features: feature ? [feature] : [],
  });
  sub._setHttpGetJson(async () => ({ status: 200, body: JSON.stringify({ ads: [
    ad(1, { uri: '/price', label: 'Prezzo cambiato', values: [{ value: '5000 €' }] }),
  ], count_all: 1 }) }));
  try {
    const valido = await srv._runSubito({ tipo: 'auto', marca: 'Prova' }, 30000);
    assert.strictEqual(valido.status, 'ok');
    assert.strictEqual(valido.items[0].prezzo, 5000);
    sub._setHttpGetJson(async () => ({ status: 200, body: JSON.stringify({ ads: [
      ad(3, null),
    ], count_all: 1 }) }));
    const nonDichiarato = await srv._runSubito({ tipo: 'auto', marca: 'Prova' }, 30000);
    assert.strictEqual(nonDichiarato.status, 'ok');
    assert.strictEqual(nonDichiarato.items[0].prezzo, null);
    assert.ok(!nonDichiarato.items[0].prezzoSuRichiesta);
    sub._setHttpGetJson(async () => ({ status: 200, body: JSON.stringify({ ads: [
      ad(4, { uri: '/price', label: 'Prezzo', values: [{ value: 'Prezzo su richiesta' }] }),
    ], count_all: 1 }) }));
    const dichiarato = await srv._runSubito({ tipo: 'auto', marca: 'Prova' }, 30000);
    assert.strictEqual(dichiarato.status, 'ok');
    assert.strictEqual(dichiarato.items[0].prezzo, null);
    assert.strictEqual(dichiarato.items[0].prezzoSuRichiesta, true);
    sub._setHttpGetJson(async () => ({ status: 200, body: JSON.stringify({ ads: [
      ad(2, { uri: '/price', label: 'Prezzo', values: [{ value: 'dato illeggibile' }] }),
    ], count_all: 1 }) }));
    const rotto = await srv._runSubito({ tipo: 'auto', marca: 'Prova' }, 30000);
    assert.strictEqual(rotto.status, 'error');
    assert.match(rotto.reason, /prezzo/i);
    assert.strictEqual(rotto.items[0].prezzo, null, 'l\'annuncio resta visibile');
    assert.ok(!rotto.items[0].prezzoSuRichiesta);
  } finally { sub._setHttpGetJson(null); }
});

test('il totale della pill dice a quale ricerca appartiene', () => {
  const moto = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'motoit.js'), 'utf8');
  assert.match(moto, /const totaleLargo = !params\.motoitModelSlug/,
    'senza slug del modello la ricerca e\' sulla marca, e il totale va dichiarato per quello che e\'');
  assert.match(APP, /s\.totaleLargo \? ' sulla marca' : ''/);
});

test('il DMG e\' staccato: niente aggiornamento automatico agganciato', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(!/scheduleUpdateCheck/.test(codice(main)),
    'l\'auto-update e\' tornato agganciato: interroga GitHub e offre un installatore che non si usa');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'electron', 'auto-update.js')),
    'electron/auto-update.js e\' tornato: era li\' solo per il DMG');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!pkg.build.dmg, 'il blocco dmg e\' tornato in package.json');
  // La prima forma di questa guardia pretendeva NESSUN mac.target, convinta che bastasse a
  // non fare DMG. E' il contrario: senza target electron-builder usa il default ["zip","dmg"]
  // e il DMG "staccato" rinasceva per omissione. La regola vera: un target ESPLICITO, senza dmg.
  const macTarget = pkg.build.mac && pkg.build.mac.target;
  assert.ok(Array.isArray(macTarget) && macTarget.length,
    'build.mac.target deve essere esplicito: senza, il default di electron-builder rifa\' il DMG');
  assert.ok(!JSON.stringify(macTarget).includes('dmg'), 'il target dmg e\' tornato fra i mac target');
});

// ─── Un guasto tiene il suo nome anche nelle zone che nessuno aveva guardato ──
test('saved: un elenco illeggibile non e\' un elenco vuoto, e non si riscrive da solo', () => {
  // La forma gia' scritta in competitor.js:50, che qui mancava: rispondendo [] a entrambi,
  // il pannello diceva «Nessuna ricerca salvata» su un file che c'era, e il gesto istintivo
  // — risalvare — chiamava saveAll con quella sola voce. Le altre ricerche, con tutto il
  // loro storico (seen, alerted, avvisi), sparivano per sempre.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-saved-ko-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const dbmod = require('../backend/utenti-db');
  dbmod.chiudi();
  const saved = require('../backend/saved');
  const file = dbmod.percorso();
  try {
    saved.addSaved(U, { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
    saved.addSaved(U, { label: 'Panda', params: { tipo: 'auto', marca: 'Fiat' } });
    assert.strictEqual(saved.listSaved(U).length, 2);
    assert.strictEqual(saved.ultimoErroreElenco(), null);

    // Il magazzino si guasta. Si chiude prima, perche' il guasto che conta e' quello che si
    // trova all'APERTURA: server riavviato, volume rimontato male, file finito sotto un backup.
    dbmod.chiudi();
    fs.writeFileSync(file, 'questo non e\' un database');
    const prima = fs.readFileSync(file);

    assert.deepStrictEqual(saved.listSaved(U), [], 'non si inventa niente: l\'elenco resta vuoto');
    assert.ok(saved.ultimoErroreElenco(), 'ma il guasto ha un nome, e la rotta lo porta a schermo');
    for (const scrivi of [
      () => saved.addSaved(U, { label: 'X', params: { tipo: 'auto', marca: 'Audi' } }),
      () => saved.removeSaved(U, 'qualunque'),
      () => saved.markRead(U, 'qualunque'),
    ]) {
      assert.throws(scrivi, e => e.code === 'ELENCO_ILLEGGIBILE', 'chi scrive deve rifiutarsi');
    }
    assert.strictEqual(Buffer.compare(prima, fs.readFileSync(file)), 0,
      'il file non nostro e\' stato riscritto: quel che c\'era dentro e\' perso');

    // Risanato: l'archivio legacy non deve rientrare, per nessuno.
    dbmod.chiudi();
    fs.rmSync(file, { force: true });
    fs.writeFileSync(path.join(dir, 'saved-searches.json'),
      JSON.stringify([{ id: 'a', label: 'Golf', params: {}, alerts: [] }], null, 2));
    delete require.cache[require.resolve('../backend/saved')];
    const saved2 = require('../backend/saved');
    assert.strictEqual(saved2.ultimoErroreElenco(), null);
    assert.strictEqual(saved2.listSaved('owner').length, 0, 'le ricerche legacy sono rientrate nel prodotto');
    assert.strictEqual(fs.existsSync(path.join(dir, 'saved-searches.json')), false,
      'il file legacy resta sul disco');
    saved2.addSaved('owner', { label: 'Y', params: { tipo: 'auto', marca: 'BMW' } });
    assert.strictEqual(saved2.listSaved('owner').length, 1);
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('l\'arricchimento che non porta niente non marca l\'annuncio come arricchito', () => {
  // `{ok:true, detail:{...tutto null}}` e' cio' che il parser da' su una pagina che non ha
  // detto niente: marcandola «arricchita», l'annuncio non veniva PIU' richiesto nemmeno
  // quando la fonte tornava a rispondere, e il TTL breve del dettaglio diventava inutile.
  const corpo = corpoDi(APP, 'async function enrichMotoRow(');
  assert.ok(/let portati = 0/.test(corpo), 'il merge non conta piu\' i campi portati');
  assert.ok(/if \(portati\) r\._enriched = true/.test(corpo),
    '_enriched si mette solo se qualcosa e\' arrivato davvero');
});

test('contesto: anche i Ricambi invalidano la generazione alla porta, e l\'errore non ridipinge la lista vecchia', () => {
  // `rcGen` e' dichiarato «mirror searchGen», ma il fix delle porte (508ea84) era arrivato
  // solo alla copia veicoli: uscendo dai Ricambi una risposta in volo aveva ancora
  // myGen === rcGen, atterrava e resuscitava rcData appena azzerato. E una ricerca
  // FALLITA lasciava i dati della precedente, che la porta del pannello ridipingeva.
  const sm = corpoDi(APP, 'function setSearchMode(');
  assert.ok(/rcGen\+\+/.test(sm),
    'la porta d\'uscita dai Ricambi non invalida la generazione: la risposta in ritardo torna a atterrare');
  const dr = corpoDi(APP, 'async function doRicambi(');
  const bump = dr.indexOf('++rcGen');
  const azzera = dr.indexOf('rcData = null');
  assert.ok(bump > 0 && azzera > bump,
    'doRicambi deve azzerare rcData dopo aver preso la sua generazione: senza, l\'errore mostra la lista di prima');
});

// Il banco di `setSearchMode`: qui si ESEGUE il vero corpo della funzione con un DOM finto,
// perche' jsdom non e' fra le dipendenze. Le classi dei singoli elementi si registrano davvero
// (non solo quelle del body), senno' non si puo' controllare chi nasconde — o non nasconde —
// il pannello dei ricambi.
const bancoModi = () => {
  const classi = new Set();
  const finto = () => {
    const cls = new Set();
    return { cls, required: false, classList: {
      add: c => cls.add(c), remove: c => cls.delete(c),
      toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)),
    } };
  };
  const memo = {};
  const document = {
    body: { classList: { add: c => classi.add(c), remove: c => classi.delete(c) }, dataset: {} },
    getElementById: id => (memo[id] ||= finto()),
    querySelector: s => (memo[s] ||= finto()),
  };
  const apri = () => document.body.classList.add('has-results');   // asApri/cpApri, in una riga
  const AREE = {
    competitor: { pannello: 'competitorPanel', apri, chiudi: () => {} },
    aste: { pannello: 'astePanel', apri, chiudi: () => {} },
  };
  const g = {
    document, AREE, area: k => AREE[k],
    localStorage: { setItem() {} },
    hideResults: () => document.body.classList.remove('has-results'),
    currentTipo: () => 'auto', sincronizzaFiltriAuto: () => {},
    btnCerca: { textContent: '' }, versioniRow: finto(),
  };
  const chiavi = Object.keys(g);
  // `corpoDi` taglia PRIMA della graffa di chiusura, che qui serve per ricomporre la funzione.
  const src = 'let searchMode = \'cerca\', rcGen = 0, rcData = null;\n'
    + corpoDi(APP, 'function setSearchMode(') + '\n}\n'
    + 'return { vai: m => setSearchMode(m), carica: d => { rcData = d; }, stato: () => ({ rcGen, rcData }) };';
  return Object.assign({ classi, el: id => memo[id] }, new Function(...chiavi, src)(...chiavi.map(k => g[k])));
};

test('contesto: uscendo da un\'area la pagina torna allo stato-vuoto, non resta nel layout post-ricerca', () => {
  // `has-results` la mettono le apri() delle aree e la toglie SOLO hideResults(). Sulla via
  // Aste → Auto non ci passava nessuno: il radio del tipo e' gia' checked (il suo change, che
  // chiama hideResults, non parte), il ramo dei Ricambi non scatta e quello dell'INGRESSO in
  // un'area nemmeno. Restava la barra compatta in cima (body.has-results .search), lo sfondo
  // dello stato-vuoto spento e la pagina vuota sotto, fino alla ricerca successiva.
  const aste = bancoModi();
  aste.vai('aste');
  assert.ok(aste.classi.has('has-results'), 'entrando nelle Aste il body non passa piu\' a has-results: il test non proverebbe niente');
  aste.vai('cerca');
  assert.ok(!aste.classi.has('has-results'),
    'tornando su Auto dalle Aste `has-results` resta addosso al body: barra schiacciata in cima, sfondo spento, pagina vuota sotto');

  // Il gemello: anche il Competitor, quando nessun parco e' stato aperto (con un parco
  // aperto a pulire e' cpChiudi, e quel ramo copriva il difetto).
  const cp = bancoModi();
  cp.vai('competitor'); cp.vai('cerca');
  assert.ok(!cp.classi.has('has-results'), 'stessa cosa uscendo dal Competitor senza nessun parco aperto');

  // E chi NON viene da un'area non deve perdere i risultati che ha a schermo: un clic su
  // «Auto» gia' attivo ripassa di qui con prev === 'cerca'.
  const dopo = bancoModi();
  dopo.vai('cerca'); dopo.classi.add('has-results');
  dopo.vai('cerca');
  assert.ok(dopo.classi.has('has-results'), 'un clic sul modo gia\' attivo spazza via i risultati della ricerca');
});

// ─── Quel che il dato sa di se' arriva a schermo ─────────────────────────────
test('passaggio: i kW STIMATI dai CV si dichiarano, non si spacciano per misurati', () => {
  // `potenzaStimata` viaggiava nella risposta e a schermo non la leggeva nessuno (rg su
  // frontend/: zero): l'importo IPT usciva identico a quello calcolato su kW veri, mentre
  // nasce da una conversione. `avvisi` e' il canale gia' montato (passAvvisiHTML, ramo di
  // successo compreso), quindi la stima passa di li' senza inventare una riga nuova.
  const srv = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8'));
  const blocco = srv.slice(srv.indexOf('const kwStimati'), srv.indexOf('if (r.ok) res.set'));
  assert.ok(/r\.potenzaStimata = /.test(blocco), 'la stima non viaggia piu\' nella risposta');
  assert.ok(/r\.avvisi = \[/.test(blocco) && /STIMATI/.test(blocco),
    'la stima non entra negli avvisi: a schermo l\'importo torna indistinguibile da uno su kW veri');
  assert.ok(/passAvvisiHTML\(d\)/.test(APP), 'il canale degli avvisi non e\' piu\' reso a schermo');
});

test('liquidita: una voce parziale non e\' una voce assente', () => {
  // Misurato su data/liquidita-modelli.json: 669 modelli su 1.997 hanno `ricambio` null ma
  // dati veri (380 coi passaggi, 289 col parco). Pretendendo il ricambio, uscivano tutti
  // come «l'archivio ACI non ha una voce» — un'affermazione falsa su cio' che ACI pubblica.
  const dati = require('../data/liquidita-modelli.json').modelli;
  const parziali = Object.values(dati).filter(m => m.ricambio == null && (m.parco != null || m.trasferimenti != null));
  assert.ok(parziali.length > 100, `attese molte voci parziali, trovate ${parziali.length}`);
  const corpo = corpoDi(APP, 'function liqCorpoHTML(');
  assert.ok(/if \(!m\) return/.test(corpo),
    'la frase «non ha una voce» va detta solo quando la voce manca DAVVERO');
  assert.ok(/m\.ricambio != null \? tile/.test(corpo), 'il riquadro del ricambio si omette da solo');
  assert.ok(/m\.trasferimenti != null \? tile/.test(corpo), 'e quello dei passaggi pure');
  // E le parole di ACI: i netti escludono le MINIVOLTURE, non le vendite dei concessionari.
  assert.ok(!/fra privati/.test(codice(APP)), '«fra privati» descrive male i trasferimenti netti ACI');
});

test('inSella: i dichiarati della casa non passano dal formattatore dei numeri', () => {
  // `misNum` scambia il punto per separatore decimale all'inglese: sui dichiarati — che
  // sono stringhe italiane come «73,4 (54)/8.750» — trasformava le MIGLIAIA in decimali,
  // e 8.750 giri diventavano «8,750». Misurato sulla cache vera: 1 valore su 28 alterato.
  const corpo = corpoDi(APP, 'function vehProvaHTML(');
  assert.ok(/const coppieTesto = o =>/.test(corpo), 'i dichiarati non hanno piu\' il loro renderer');
  assert.ok(/Dichiarato dalla casa[\s\S]{0,120}coppieTesto\(d\.dichiarati\)/.test(corpo),
    'i dichiarati sono tornati a passare da misNum');
});

// ─── Il ripiego dichiara le sue regole, o non parte ──────────────────────────
test('subito: Auto e Moto usano solo Hades, senza sessione browser', () => {
  const srv = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8'));
  const smart = srv.slice(srv.indexOf('async function scrapeSubitoSmart'), srv.indexOf('// ─── Auth'));
  assert.match(smart, /return scrapeSubitoApi\(params, \{ sort: 'priceasc', withMeta: true, fetta: params\.fetta \|\| 0 \}\)/);
  assert.doesNotMatch(srv, /require\(['"]\.\/scrapers\/subito-playwright['"]\)/);
  assert.doesNotMatch(srv, /USE_SUBITO_API|keepAliveSubito|runBootstrap|subitoSession|\/api\/subito\/(?:bootstrap|keep-alive|status)/);
});

test('autoscout: la ricerca Auto/Moto resta GraphQL anche quando fallisce', () => {
  const srv = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8'));
  const smart = srv.slice(srv.indexOf('async function scrapeAutoscoutSmart'), srv.indexOf('// F50 fase 1b'));
  const union = srv.slice(srv.indexOf('async function scrapeAutoscoutUnion'), srv.indexOf('// Auto e Moto usano sempre hades'));
  assert.match(smart, /return scrapeAutoscoutGraphql\(params, opts\)/);
  assert.match(union, /if \(errori\.length && byUrl\.size === 0\) throw errori\[0\]/);
  assert.doesNotMatch(srv, /require\(['"]\.\/scrapers\/autoscout-playwright['"]\)|USE_AS24_GRAPHQL/);
  assert.match(srv, /runSource\(\(\) => scrapeAutoscoutUnion/);
});

test('ebay: una serp senza risultati esatti non e\' un elenco di offerte', () => {
  // In modo OEM il filtro di pertinenza e' escluso di proposito (l'OEN quasi mai sta nel
  // titolo): senza guardia, i SUGGERITI di eBay entravano come offerte del codice cercato.
  const src = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'ebay-scrape.js'), 'utf8'));
  assert.ok(/srp-save-null-search/.test(src), 'la guardia sulla serp nulla e\' sparita');
  assert.ok(/if \(nulla\) return \[\]/.test(src), 'con zero risultati esatti la lista deve essere vuota');
  // La regola dell'intestazione, ESEGUITA: senza confine, «1.230 risultati» conterrebbe
  // «0 risultati» e una serp piena verrebbe azzerata.
  const re = /nessun risultato esatto|non ha prodotto risultati|(^|[^\d])0\s+risultati/i;
  assert.ok(src.includes(String(re.source)), 'la regex del test non e\' piu\' quella del codice');
  for (const piena of ['1.230 risultati', '10 risultati', '4.507 risultati per ricambio']) {
    assert.ok(!re.test(piena), `"${piena}" e' una serp PIENA e non va azzerata`);
  }
  for (const vuota of ['0 risultati', 'Nessun risultato esatto trovato']) {
    assert.ok(re.test(vuota), `"${vuota}" e' una serp nulla`);
  }
});

// ─── Una regola scritta una volta, e la leggono tutti ────────────────────────
test('tendina: la normalizzazione dei nomi e\' quella condivisa, e le marche possedute ci sono', () => {
  // `normName` era una copia divergente di `brand-match.norm` (conservava gli spazi): il
  // merge Moto.it aggiungeva 94 doppioni della stessa moto — CL500/CL 500, NX500/NX 500,
  // CRF 300L/CRF 300 L — in una force-select il cui contratto e' «scegli un modello reale».
  const srv = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8'));
  assert.ok(!/normName\(/.test(srv), 'la copia divergente normName e\' tornata');

  const { norm } = require('../backend/scrapers/brand-match');
  const { resolveMotoitSlug } = require('../backend/scrapers/motoit-brands');
  const models = require('../data/models.json').moto;
  const marche = require('../data/motoit-catalogo.json').marche || require('../data/motoit-catalogo.json');
  let doppioni = 0;
  for (const [marca, v] of Object.entries(models)) {
    const slug = (v.motoit && v.motoit.brandSlug) || resolveMotoitSlug(marca);
    const m = slug && marche[slug];
    if (!m) continue;
    const visti = new Set((v.models || []).map(x => norm(x.nome)).filter(Boolean));
    for (const a of Object.values(m.modelli || {})) {
      if (!a.nome) continue;
      if (visti.has(norm(a.nome))) continue;   // aggancia la voce esistente: nessun doppione
      visti.add(norm(a.nome));
    }
  }
  assert.strictEqual(doppioni, 0);

  // E ogni marca che il catalogo possiede dev'essere raggiungibile dalla tendina: la
  // force-select disabilita Cerca su una marca fuori elenco, quindi «non in tendina» vuol
  // dire «i suoi annunci non esistono per l'app».
  const raggiunte = new Set(Object.keys(models).map(n => resolveMotoitSlug(n)).filter(Boolean));
  const conModelli = Object.entries(marche).filter(([, m]) => Object.keys((m && m.modelli) || {}).length);
  const orfane = conModelli.filter(([s]) => !raggiunte.has(s)).map(([s]) => s);
  assert.ok(/tipo === 'moto'/.test(srv) && /raggiunte\.has\(slug\)/.test(srv),
    `/api/brands non fa piu' l'unione col catalogo: ${orfane.length} marche possedute resterebbero irraggiungibili`);
});

// ─── Chi ha osservato prima non decide dopo ──────────────────────────────────
test('subito: Hades non prende cookie dalla sessione Playwright', () => {
  const api = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'subito-api.js'), 'utf8'));
  const get = api.slice(api.indexOf('function httpGetJson('), api.indexOf('// La porta HTTP'));
  assert.match(get, /host: HOST, path/);
  assert.doesNotMatch(get, /subitoSession|storageState|cookie/i);
});

test('subito: una risposta Hades 403 resta un errore, anche con la vecchia opzione bootstrap', async () => {
  const srv = require('../backend/server');
  const sub = require('../backend/scrapers/subito-api');
  const prima = process.env.HIDE_SUBITO_BOOTSTRAP;
  process.env.HIDE_SUBITO_BOOTSTRAP = '1';
  sub._setHttpGetJson(async () => ({ status: 403, body: '' }));
  try {
    const r = await srv._runSubito({ tipo: 'auto', marca: 'Honda', modello: 'Civic', fetta: 0 }, 3000);
    assert.strictEqual(r.status, 'error');
    assert.notStrictEqual(r.status, 'needs_bootstrap');
    assert.ok(!srv._cacheable({ totale: 1, sources: { subito: r } }));
  } finally {
    sub._setHttpGetJson(null);
    if (prima == null) delete process.env.HIDE_SUBITO_BOOTSTRAP;
    else process.env.HIDE_SUBITO_BOOTSTRAP = prima;
  }
});

test('ricerca: la stessa domanda gia\' in volo non si rifa\' da capo', () => {
  // La cache copre le risposte GIA' ARRIVATE; fra la partenza e l'arrivo non c'era niente,
  // e due schede aperte (o un doppio clic) facevano DUE giri completi verso Subito,
  // Autoscout e Moto.it per la stessa domanda — doppio costo verso le fonti proprio nel
  // momento in cui e' piu' facile farsi bloccare.
  const srv = codice(fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8'));
  const corpo = srv.slice(srv.indexOf('async function runSearch(params)'), srv.indexOf('async function runSearch(params)') + 1400);
  assert.ok(/searchInFlight\.has\(key\)/.test(corpo), 'la mappa delle ricerche in volo e\' sparita');
  assert.ok(/finally \{ searchInFlight\.delete\(key\);? \}/.test(corpo),
    'la chiave va liberata anche su errore: senno\' un guasto transitorio incolla tutte le richieste dopo');
  // La regola, ESEGUITA sulla stessa forma: due concorrenti = un lavoro, e l'errore libera.
  const vive = new Map(); let lavori = 0;
  const run = (k, ko) => {
    if (vive.has(k)) return vive.get(k);
    const p = (async () => { lavori++; await new Promise(r => setTimeout(r, 10)); if (ko) throw new Error('KO'); return 'ok'; })();
    vive.set(k, p);
    return p.finally(() => vive.delete(k));
  };
  return Promise.all([run('a'), run('a'), run('b')])
    .then(() => { assert.strictEqual(lavori, 2, 'due schede sulla stessa ricerca devono costare UN giro'); })
    .then(() => Promise.allSettled([run('x', true), run('x', true)]))
    .then(() => run('x', false))
    .then(v => assert.strictEqual(v, 'ok', 'dopo un errore la chiave deve tornare libera'));
});

/**
 * MOTO.IT: LA VERSIONE CHE NON FILTRA VA DETTA A SCHERMO (campagna E4, 2026-08-08).
 * Due silenzi misurati: (1) 2.074 voci moto (19,3% del menu) hanno la marca su Moto.it ma
 * nessuno slug-modello — il filtro versione non si tentava e nessun banner lo diceva;
 * (2) il tetto famiglie>12 prometteva «e lo si dice» ma finiva solo nel log del server.
 * Entrambi ora passano dal canale gia' vivo `motoitVersioneElencoMonco` → banner.
 */
test('moto.it: versione senza slug-modello e tetto famiglie arrivano al banner, non solo al log', () => {
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  // il ramo senza slug: dichiara sul canale del banner e nomina la versione scritta
  const senzaSlug = SRV.match(/else if \(params\.versione && params\.tipo === 'moto' && params\.motoitBrandSlug && !params\.motoitModelSlug[\s\S]{0,900}?\n  \}/);
  assert.ok(senzaSlug, 'manca il ramo dichiarato per versione+marca senza slug-modello');
  assert.ok(/motoitVersioneElencoMonco = /.test(senzaSlug[0]), 'il ramo senza-slug deve riempire il canale del banner');
  assert.ok(/\$\{params\.versione\}/.test(senzaSlug[0]), 'il banner deve NOMINARE la versione scritta');
  // il tetto famiglie: il campo si riempie PRIMA del throw
  const tetto = SRV.match(/fam\.length > TETTO_FAM\) \{[\s\S]{0,700}?throw new Error/);
  assert.ok(tetto, 'blocco del tetto famiglie non trovato');
  assert.ok(/motoitVersioneElencoMonco = /.test(tetto[0]), 'oltre il tetto il banner va riempito prima del throw');
  // e il canale arriva davvero a schermo
  assert.ok(/versioneElencoMonco: params\.motoitVersioneElencoMonco/.test(SRV), 'il campo deve viaggiare nella risposta');
  assert.ok(/mo && mo\.versioneElencoMonco/.test(APP), 'il banner frontend deve leggerlo');
});

test('scheda tecnica: il numero di prova di auto.it non entra grezzo nella pagina', () => {
  /**
   * L'UNICO CAMPO DI TERZI CHE ENTRAVA GREZZO IN innerHTML, in tutta l'app.
   *
   * Su 73 punti in cui si scrive HTML nella pagina e 46 che interpolano una variabile, ogni
   * campo raccolto dalle fonti passava da `escapeHtml` — tranne `v.prova`, dove la riga sopra e
   * quella sotto escapavano gia'. Una dimenticanza, non una scelta.
   *
   * Non e' un dettaglio perche' la difesa qui e' a UNO strato: non esiste nessuna
   * Content-Security-Policy in tutto il repo (verificato sotto), quindi fra un campo di terzi e
   * l'esecuzione di codice nella sessione del proprietario c'e' quella funzione e basta.
   */
  const corpo = codice(corpoDi(APP, 'function vehMisureHTML('));
  const riga = corpo.split('\n').find(r => r.includes('veh-mis-m'));
  assert.ok(riga, 'la riga della misura non c\'e\' piu\': se l\'hai spostata, sposta anche questa prova');
  assert.ok(/escapeHtml/.test(riga),
    `il numero di prova torna grezzo nella pagina — e' testo scritto da auto.it, non un numero:\n  ${riga.trim()}`);

  // E che sia davvero testo di terzi senza sanificazione, non un numero: lo si legge alla fonte.
  const SCRAPER = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'autoit-rilevamenti.js'), 'utf8');
  assert.match(SCRAPER, /prova:\s*testo\(r\.NumeroProva\)/,
    'il campo `prova` non arriva piu\' da NumeroProva: ricontrolla da dove viene prima di fidarti');
  assert.match(SCRAPER, /const testo = v => \{ const t = String\(v == null \? '' : v\)\.trim\(\);/,
    '`testo()` e\' cambiato: se adesso sanifica, questa prova va riscritta; se non lo fa, resta com\'e\'');
});

// ─── Il portale delle aste: una forma che non si legge non e' un inventario ──────────────────
test('pvp: una paginazione illeggibile non diventa «inventario completo»', async () => {
  const { EventEmitter } = require('events');
  const https = require('https');
  const pvp = require('../backend/scrapers/pvp');
  const TOT = 1000, PAG = 200;

  // La fonte finta: 1000 lotti veri e paginati, e `totalElements` nella forma che decide il caso.
  let forma = 'numero';
  const veroRequest = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200; res.setEncoding = () => {};
      let payload;
      if (opts.path.includes('fe-config')) {
        payload = { msUrl: { ricerca: 'ric-x/ric-ms', vendite: 'ven-x/ven-ms' } };
      } else {
        const page = Number((opts.path.match(/[?&]page=(\d+)/) || [])[1] || 0);
        const da = page * PAG;
        // 'vuotaAMeta': 200 con zero risultati a meta' paginazione, e `last` che NON lo dice —
        // un nodo di bordo che riparte durante i ~15 s del giro.
        const vuota = forma === 'vuotaAMeta' && page === 1;
        const content = vuota ? [] : Array.from({ length: Math.max(0, Math.min(da + PAG, TOT) - da) },
          (_, i) => ({ idLotto: da + i, descLotto: 'lotto di prova' }));
        const ultima = !vuota && da + PAG >= TOT;
        const b = { content, last: ultima };
        if (forma === 'numero' || forma === 'vuotaAMeta') b.totalElements = TOT;
        if (forma === 'stringa') b.totalElements = String(TOT);
        // 'involucro': la stessa risposta senza il guscio `{body:{...}}` che ci aspettiamo.
        payload = forma === 'involucro' ? { content, last: ultima, totalElements: TOT } : { body: b };
      }
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(payload)); res.emit('end'); });
    };
    return req;
  };

  try {
    forma = 'numero'; pvp._test.resetCache();
    assert.strictEqual((await pvp.tutti('auto', { pausaMs: 0 })).lotti.length, TOT,
      'con il totale nella forma attesa si scarica tutto: se questo fallisce e\' rotta la finta fonte');

    // "1000" invece di 1000: `totale` diventava 0, e `out.length >= 0` chiudeva il giro dopo la
    // PRIMA pagina. 200 lotti su 1000 con `troncato:false` e nessun avviso — e siccome la ricerca
    // chiede le vendite in ordine di data crescente, quei 200 sono i PIU' VECCHI: il filtro sulle
    // vendite future in aste.js li scarta tutti, il magazzino si svuota e il giro si dichiara «ok».
    forma = 'stringa'; pvp._test.resetCache();
    const s = await pvp.tutti('auto', { pausaMs: 0 });
    assert.strictEqual(s.lotti.length, TOT,
      'un totale in forma diversa non e\' un inventario da 200: si pagina fino in fondo');

    // L'involucro cambiato non vuol dire «zero lotti»: vuol dire che la fonte non sappiamo piu'
    // leggerla. Tornare una pagina vuota e' indistinguibile da «oggi non ci sono aste», e a valle
    // marca sparito tutto il magazzino scrivendo esito 'ok'.
    forma = 'involucro'; pvp._test.resetCache();
    await assert.rejects(() => pvp.tutti('auto', { pausaMs: 0 }), /involucro cambiato/,
      'una risposta senza `content` deve dichiararsi, non passare per inventario vuoto e completo');

    // LA PORTA GEMELLA, dall'altro ramo di `ultima`. Una pagina vuota a meta' e' l'uscita normale
    // della paginazione, quindi `tutti()` usciva con 200 lotti su 1000 e `troncato:false`, cioe'
    // «ho preso tutto»: il numero che smaschera la bugia (`totalElements`) ce l'aveva gia' in mano
    // e non lo guardava. A valle e' lo stesso danno del caso qui sopra — inventario sostituito con
    // quel poco, il resto marcato sparito, giro 'ok' e «aggiornato oggi» per 24 ore.
    forma = 'vuotaAMeta'; pvp._test.resetCache();
    await assert.rejects(() => pvp.tutti('auto', { pausaMs: 0 }), /paginazione interrotta/,
      'meta\' inventario non si consegna come completo: l\'uscita anticipata si dichiara');
  } finally { https.request = veroRequest; pvp._test.resetCache(); }
});

// ─── Il portale delle aste: un percorso morto si riscopre, non si ribatte per sei ore ────────
test('pvp: un endpoint che non risponde piu\' fa ripartire la scoperta, non sei ore di KO', async () => {
  const { EventEmitter } = require('events');
  const https = require('https');
  const pvp = require('../backend/scrapers/pvp');

  // Il ministero rilascia e gli hash nei percorsi cambiano (punto 2 dell'intestazione di pvp.js):
  // i percorsi della versione precedente diventano morti, quelli nuovi rispondono i lotti.
  let versione = 1, forma = 404, feConfig = 0;
  const ep = () => ({ ricerca: `ric-v${versione}/ric-ms`, vendite: `ve-v${versione}/ve-ms` });
  const veroRequest = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200; res.setEncoding = () => {};
      let payload;
      if (opts.path.includes('fe-config')) { feConfig++; payload = JSON.stringify({ msUrl: ep() }); }
      else if (!opts.path.startsWith(`/${ep().ricerca}`) && !opts.path.startsWith(`/${ep().vendite}`)) {
        // Le due forme in cui il portale dice «endpoint spostato»: il non-200 e l'HTML al posto del JSON.
        if (forma === 404) { res.statusCode = 404; payload = '{"error":"not found"}'; }
        else payload = '<!doctype html><html><body>PVP</body></html>';
      } else payload = JSON.stringify({ body: { content: [{ idLotto: 7 }], last: true, totalElements: 1 } });
      setImmediate(() => { cb(res); res.emit('data', payload); res.emit('end'); });
    };
    return req;
  };

  try {
    for (const caso of [404, 'html']) {
      versione = 1; forma = caso; feConfig = 0; pvp._test.resetCache();
      assert.strictEqual((await pvp.pagina('auto')).lotti.length, 1,
        'con gli endpoint vivi si legge la pagina: se questo fallisce e\' rotta la finta fonte');
      assert.strictEqual(feConfig, 1, 'finche\' i percorsi funzionano si scoprono una volta sola');

      versione = 2;                          // il rilascio: i percorsi in cache adesso sono morti
      await assert.rejects(() => pvp.pagina('auto'), caso === 404 ? /HTTP 404/ : /non-JSON/,
        'un percorso che non risponde piu\' deve dichiararsi, non fingere una pagina');
      // E deve portarsi via la cache: la chiamata dopo riscopre gli endpoint e RIESCE. Senza,
      // si ribatte lo stesso percorso morto fino alla scadenza del TTL — sei ore in cui ogni giro
      // va KO, le due rotte delle aste rispondono 502 e il controllo orario ricasca sempre li'.
      assert.strictEqual((await pvp.pagina('auto')).lotti.length, 1,
        `dopo un rilascio (${caso}) la riscoperta non riparte: sono sei ore di KO`);
      assert.strictEqual(feConfig, 2, 'la riscoperta costa UNA chiamata a fe-config, non una per richiesta');
    }
  } finally { https.request = veroRequest; pvp._test.resetCache(); }
});

// ─── Il portale delle aste: un guasto non e' «il ministero ha cambiato la pagina» ────────────
test('pvp: un portale che sta male si dichiara, non passa per «endpoint spostato»', async () => {
  const { EventEmitter } = require('events');
  const https = require('https');
  const pvp = require('../backend/scrapers/pvp');
  const BO_NUOVO = 'bo-aaaaaaaa-bbbbbbbb';

  // I DUE percorsi della scoperta: `fe-config` sotto il prefisso di backoffice, e la pagina
  // pubblica da cui il prefisso si ripesca. Quando il portale degrada cadono insieme, ed e'
  // li' che il messaggio mentiva: il fallimento della riscoperta copriva il guasto vero.
  let feConfig, paginaPub;
  const veroRequest = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.setEncoding = () => {};
      const r = opts.path.includes('fe-config')
        ? (opts.path.startsWith(`/${BO_NUOVO}/`)
            ? { status: 200, body: JSON.stringify({ msUrl: { ricerca: 'ric-x/ric-ms', vendite: 'ven-x/ven-ms' } }) }
            : feConfig)
        : opts.path.includes('lista_annunci.page') ? paginaPub
        : { status: 200, body: JSON.stringify({ body: { content: [{ idLotto: 7 }], last: true, totalElements: 1 } }) };
      res.statusCode = r.status;
      setImmediate(() => { cb(res); res.emit('data', r.body); res.emit('end'); });
    };
    return req;
  };

  const CORTESIA = '<!doctype html><html><body>Servizio temporaneamente non disponibile</body></html>';
  try {
    // Manutenzione su tutt'e due i percorsi. Il 503 deve arrivare fino a `giri.motivo` e al 502
    // delle rotte: se al suo posto si legge «prefisso non trovato», si va a riscrivere lo
    // scraper per un guasto di dieci minuti.
    feConfig = { status: 503, body: CORTESIA }; paginaPub = { status: 503, body: CORTESIA };
    pvp._test.resetCache();
    await assert.rejects(() => pvp.pagina('auto'), e => {
      assert.match(e.message, /HTTP 503/, `il 503 del portale e' sparito dal motivo: ${e.message}`);
      assert.doesNotMatch(e.message, /^PVP: prefisso backoffice/,
        `una manutenzione viene riportata come rilascio del ministero: ${e.message}`);
      return true;
    });

    // Stessa cosa con una pagina di blocco: il genere resta quello dello stato vero.
    feConfig = { status: 403, body: CORTESIA }; paginaPub = { status: 403, body: CORTESIA };
    pvp._test.resetCache();
    await assert.rejects(() => pvp.pagina('auto'), e => {
      assert.match(e.message, /HTTP 403/, `il 403 e' sparito dal motivo: ${e.message}`);
      assert.strictEqual(e.kind, 'blocked', 'un blocco non si degrada in «endpoint cambiato»');
      return true;
    });

    // E se solo `fe-config` cade mentre la pagina risponde 200 ma senza il pattern, la causa
    // vera resta in testa e il fallimento della riscoperta la segue: nessuna delle due si perde.
    feConfig = { status: 502, body: '' }; paginaPub = { status: 200, body: '<html></html>' };
    pvp._test.resetCache();
    await assert.rejects(() => pvp.pagina('auto'), e => {
      assert.match(e.message, /^PVP \/bo-[^:]+: HTTP 502/, `la causa vera non e' in testa: ${e.message}`);
      assert.match(e.message, /prefisso backoffice non trovato/, `la riscoperta fallita non e' detta: ${e.message}`);
      return true;
    });

    // Controprova: il meccanismo che il codice VUOLE fare resta intero. Seme scaduto (404) ma
    // pagina pubblica viva: si ripesca il prefisso nuovo e si riprende, senza errori.
    feConfig = { status: 404, body: '{"error":"not found"}' };
    paginaPub = { status: 200, body: `<html><script src="/${BO_NUOVO}/bo-ms/main.js"></script></html>` };
    pvp._test.resetCache();
    assert.strictEqual((await pvp.pagina('auto')).lotti.length, 1,
      'con la pagina pubblica viva il prefisso si ripesca e il giro riprende');
  } finally { https.request = veroRequest; pvp._test.resetCache(); }
});

// ─── L'area Aste: una fonte muta non e' un inventario vuoto ──────────────────────────────────

/** La fonte finta del portale: `vuoto` decide se risponde con i lotti o con zero risultati. */
function pvpFinto(lotti, quandoVuoto) {
  const { EventEmitter } = require('events');
  const https = require('https');
  const vero = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200; res.setEncoding = () => {};
      // L'involucro e' SEMPRE quello giusto: e' il caso che nessun controllo di forma intercetta.
      const content = quandoVuoto() ? [] : lotti;
      const payload = String(opts.path).includes('fe-config')
        ? { msUrl: { ricerca: 'ric-x/ric-ms', vendite: 'ven-x/ven-ms' } }
        : { body: { content, last: true, totalElements: content.length } };
      setImmediate(() => { cb(res); res.emit('data', JSON.stringify(payload)); res.emit('end'); });
    };
    return req;
  };
  return () => { https.request = vero; };
}

/** Moduli dell'area Aste freschi, su una cartella dati tutta loro. */
function conAste(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-aste-muta-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  for (const m of ['../backend/aste-db', '../backend/scrapers/pvp', '../backend/aste']) {
    delete require.cache[require.resolve(m)];
  }
  const mod = {
    db: require('../backend/aste-db'),
    pvp: require('../backend/scrapers/pvp'),
    aste: require('../backend/aste'),
  };
  const chiudi = () => {
    mod.aste._reset(); mod.db._reset(); mod.pvp._test.resetCache();
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
  };
  return Promise.resolve(fn(mod)).finally(chiudi);
}

const fraGiorniAste = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
// Gli stessi due lotti valgono per auto e per moto: la chiave e' (id, tipo), quindi fanno 4 righe.
const LOTTI_PVP = [
  { id: 2001, descLotto: 'Autovettura Fiat Panda', dataVendita: fraGiorniAste(30),
    indirizzo: { citta: 'Verona', provincia: 'Verona' } },
  { id: 2002, descLotto: 'Motociclo Yamaha XMAX', dataVendita: fraGiorniAste(40),
    indirizzo: { citta: 'Trento', provincia: 'Trento' } },
];

test('aste: un 200 con zero lotti non marca sparito tutto il magazzino', () => conAste(async ({ db, aste }) => {
  let vuoto = false;
  const ripristina = pvpFinto(LOTTI_PVP, () => vuoto);
  try {
    assert.strictEqual((await aste.giro({ pausaMs: 0 })).ok, true,
      'il giro sano deve riuscire: se fallisce e\' rotta la fonte finta, non il codice');
    assert.strictEqual(db.cerca().length, 4, 'due lotti per tipo, chiave (id, tipo)');

    /**
     * Il ministero rinomina un enum del corpo della ricerca: 200, involucro giusto, zero
     * risultati. Nessun controllo di FORMA lo intercetta — la forma e' perfetta. Prima di questa
     * guardia il giro marcava sparito tutto l'inventario e si scriveva 'ok', e l'area restava
     * vuota e muta, timbrata «aggiornato oggi», fino al giorno dopo.
     */
    vuoto = true;
    const g = await aste.giro({ pausaMs: 0 });
    assert.strictEqual(g.ok, false,
      'una fonte che non da\' piu\' niente e\' un giro FALLITO, non un inventario vuoto');
    assert.strictEqual(db.cerca().length, 4, 'il magazzino non si svuota su una risposta muta');
    assert.strictEqual(db.unLotto(2001, 'auto').sparito, false,
      'nessun lotto va marcato sparito per colpa di una risposta che non abbiamo capito');
    // E il giro muto non deve nemmeno rubare il posto all'ultimo giro RIUSCITO: e' da quello che
    // `stantio()` decide se riprovare, e un 'ok' falso spegnerebbe i tentativi per un giorno.
    assert.strictEqual(db.ultimoGiro().visti, 4,
      'l\'ultimo giro riuscito resta quello buono');
  } finally { ripristina(); }
}));

test('aste: un tipo guasto non porta via il tipo che viene dopo', () => conAste(async ({ db, pvp, aste }) => {
  /**
   * `Object.keys(pvp.TIPOLOGIE)` conserva l'ordine d'inserimento, quindi il giro e' SEMPRE
   * ['auto','moto'] ed e' sempre 'moto' a pagare un guasto delle auto — che sono ~25 pagine
   * contro 6, cioe' quattro volte le occasioni di cadere. Senza la guardia per tipo le moto non
   * venivano nemmeno CHIESTE, e siccome le auto restano stantie il giro dopo ricadeva li': a
   * ogni giro, per sempre. `stantioTipo` copre solo la direzione opposta.
   */
  const vero = pvp.tutti;
  const chiesti = [];
  pvp.tutti = async (tipo) => {
    chiesti.push(tipo);
    if (tipo === 'auto') { const e = new Error('PVP /ricerca/vendite: HTTP 500'); e.kind = 'transient'; throw e; }
    return { lotti: LOTTI_PVP, totale: LOTTI_PVP.length, troncato: false };
  };
  try {
    const g = await aste.giro({ pausaMs: 0 });
    assert.deepStrictEqual(chiesti, ['auto', 'moto'],
      'il tipo DOPO quello guasto deve essere chiesto lo stesso');
    assert.strictEqual(db.cerca({ tipo: 'moto' }).length, 2,
      'le moto si aggiornano anche col giro delle auto caduto');
    assert.deepStrictEqual(db.cerca({ tipo: 'auto' }), [],
      'il magazzino del tipo guasto non si tocca');
    // Un giro a meta' resta KO: e' `stantio()` a far riprovare, e un 'ok' falso timbrerebbe
    // «aggiornato oggi» un inventario in cui manca un tipo intero.
    assert.strictEqual(g.ok, false, 'un tipo caduto e\' un giro fallito, non un giro riuscito');
    assert.match(g.motivo, /HTTP 500/, 'il motivo del tipo caduto non si perde per strada');
    assert.strictEqual(db.ultimoGiro(), null, 'nessun giro RIUSCITO da un giro a meta\'');
  } finally { pvp.tutti = vero; }
}));

test('aste: il primo giro in assoluto non e\' bloccato dalla guardia', () => conAste(async ({ db, aste }) => {
  // Magazzino vuoto e portale senza lotti: non c'e' niente da difendere, e un giro che non trova
  // nulla al primo colpo deve poter dire 'ok' — se no l'area non partirebbe mai.
  const ripristina = pvpFinto(LOTTI_PVP, () => true);
  try {
    assert.strictEqual((await aste.giro({ pausaMs: 0 })).ok, true);
    assert.deepStrictEqual(db.cerca(), []);
  } finally { ripristina(); }
}));

test('le ricerche salvate non avviano piu\' controlli periodici', () => {
  const srv = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.doesNotMatch(srv, /checkAll|checkSaved|\/api\/saved|require\(['"]\.\/saved['"]\)/,
    'il server contiene ancora il motore o le rotte delle ricerche salvate');
});
