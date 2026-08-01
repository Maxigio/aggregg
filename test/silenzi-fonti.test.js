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
    const s = saved.addSaved({ label: 'Golf GTD', params: { tipo: 'auto', marca: 'Volkswagen' } });
    const ann = [{ url: 'https://www.subito.it/a', prezzo: 15000, titolo: 'Golf' }];

    // Controllo completo: nessuna fonte muta, e resta la data del controllo completo.
    saved.recordCheck(s.id, ann, {});
    const dopoPieno = saved.listSaved().find(x => x.id === s.id);
    assert.strictEqual(dopoPieno.fontiMute, null);
    assert.ok(dopoPieno.lastCheckedFull, 'un controllo completo si annota come tale');

    // Controllo con Autoscout muto: l'ora c'e', ma si sa che non e' completo.
    saved.recordCheck(s.id, ann, { fontiMute: ['autoscout'] });
    const dopoMuto = saved.listSaved().find(x => x.id === s.id);
    assert.deepStrictEqual(dopoMuto.fontiMute, ['autoscout'],
      'senza questo la scheda direbbe "controllata adesso, nessuna novita\'"');
    assert.strictEqual(dopoMuto.lastCheckedFull, dopoPieno.lastCheckedFull,
      'l\'ultimo controllo COMPLETO resta quello di prima');
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
  }
});

// ─── Competitor: una passata caduta non e' il tetto di sicurezza ─────────────
test('competitor: la passata fallita si dichiara per quello che e\', non come troncamento', async () => {
  const C = require('../backend/competitor');
  const voce = { fonte: 'autoscout', id: '12345', nome: 'Prova Auto' };
  const finto = async (params) => {
    if (params.tipo === 'auto') return { items: [{ url: 'a1', titolo: 'Auto 1', prezzo: 10000 }], truncated: false, total: 1 };
    throw new Error('HTTP 429');
  };
  const p = await C.parco(voce, { scrapeAs24: finto });
  assert.strictEqual(p.veicoli.length, 1, 'la passata riuscita si tiene');
  assert.strictEqual(p.troncato, false, 'nessun tetto e\' stato toccato: dirlo sarebbe falso');
  assert.ok(p.passateKo && p.passateKo.length === 1, 'la passata caduta si dichiara a parte');
  assert.strictEqual(p.passateKo[0].tipo, 'moto');
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

// ─── La marcatura decide anche cosa NON fare ─────────────────────────────────
test('saved: un annuncio di un altro modello non genera avviso, ma resta fra i visti', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-mark-'));
  const vecchio = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  delete require.cache[require.resolve('../backend/saved')];
  const saved = require('../backend/saved');
  try {
    const s = saved.addSaved({ label: 'Beta R-12', params: { tipo: 'moto', marca: 'Beta', modello: 'R-12' } });
    // Primo giro: baseline silenziosa, nessun avviso per nessuno.
    saved.recordCheck(s.id, [{ url: 'https://x/1', prezzo: 6000, titolo: 'Beta R-12', dichiarazione: 'esatto' }], {});
    // Secondo giro: due annunci nuovi, uno giusto e uno di un altro modello.
    const alerts = saved.recordCheck(s.id, [
      { url: 'https://x/1', prezzo: 6000, titolo: 'Beta R-12', dichiarazione: 'esatto' },
      { url: 'https://x/2', prezzo: 5500, titolo: 'Beta RR 125', dichiarazione: 'altro-modello' },
      { url: 'https://x/3', prezzo: 6200, titolo: 'Beta R-12 2023', dichiarazione: 'senza-versione' },
    ], {});
    const urls = alerts.map(a => a.url);
    assert.ok(urls.includes('https://x/3'), 'il modello giusto senza versione dichiarata avvisa');
    assert.ok(!urls.includes('https://x/2'), 'l\'altro modello non suona: la ricerca salvata segue QUEL modello');
    // Ma e' stato visto: al giro dopo non deve arrivare come "nuovo".
    const dopo = saved.getSaved(s.id);
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

// ─── Le moto: una famiglia per richiesta, e il tetto si dichiara ──────────────
test('subito: sulle moto le famiglie si chiedono tutte, non solo la prima', async () => {
  const sub = require('../backend/scrapers/subito-api');
  const chieste = [];
  // Si stuba la porta HTTP: ogni famiglia risponde un annuncio suo, piu' uno in comune
  // (che deve essere unito, non ripetuto).
  const annuncio = (id, prezzo) => ({
    urn: id, urls: { default: `https://www.subito.it/x/${id}` }, subject: 'Moto ' + id,
    features: [{ label: 'Prezzo', uri: '/price', values: [{ key: String(prezzo), value: `${prezzo} €` }] }],
  });
  sub._setHttpGetJson(async path => {
    const bm = (path.match(/[?&]bm=([^&]+)/) || [])[1];
    chieste.push(bm);
    return { status: 200, body: JSON.stringify({ count_all: 10, ads: [annuncio(bm, 5000), annuncio('comune', 6000)] }) };
  });
  try {
    const r = await sub({
      tipo: 'moto', marca: 'Ducati', modello: 'Monster',
      subitoNodo: { marcaId: '000123', famigliaIds: ['111', '222', '333'] },
    }, { withMeta: true, pageDelayMs: 0 });
    assert.deepStrictEqual(chieste, ['111', '222', '333'],
      'una richiesta per famiglia: prima ne partiva UNA sola e le altre venivano costruite e buttate');
    assert.strictEqual(r.total, 30, 'i totali delle famiglie si sommano: sono insiemi disgiunti del catalogo');
    const urls = r.items.map(x => x.url);
    assert.strictEqual(urls.filter(u => /comune/.test(u)).length, 1, 'il doppione si unisce, non si ripete');
    assert.strictEqual(r.items.length, 4, '3 propri + 1 comune');
  } finally { sub._setHttpGetJson(null); }
});

// ─── Una regola, un posto: il nome senza la generazione ──────────────────────
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
    const s = saved.addSaved({ label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
    const ann = n => Array.from({ length: n }, (_, i) => ({ url: 'https://x/' + i, prezzo: 10000 + i, titolo: 'Golf ' + i }));
    saved.recordCheck(s.id, ann(1), {});          // baseline
    saved.recordCheck(s.id, ann(4), {});          // tre nuovi
    assert.strictEqual(saved.listSaved().find(x => x.id === s.id).novita, 3);

    saved.markRead(s.id, 'https://x/1');
    assert.strictEqual(saved.listSaved().find(x => x.id === s.id).novita, 2,
      'prima il clic su UNO faceva sparire tutta la coda');
    // Il bottone "segna tutti letti" resta, ma e' un gesto diverso e esplicito.
    saved.markRead(s.id);
    assert.strictEqual(saved.listSaved().find(x => x.id === s.id).novita, 0);
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

test('versione: il campo e\' spento esattamente quando la ricerca non la userebbe', () => {
  // `doSearch` spedisce `params.versione` SOLO dentro il ramo del modello scelto. Finche' e'
  // cosi', scriverla senza aver scelto un modello significa buttarla in silenzio.
  const ds = corpoDi(APP, 'async function doSearch(');
  const ramo = ds.indexOf('if (selectedModel && selectedModel._marca === marca');
  const invio = ds.indexOf('params.versione = vt');
  assert.ok(ramo > 0 && invio > ramo, 'params.versione non e\' piu\' dentro il ramo del modello scelto');
  assert.ok(/versioneInput\.disabled = !ok/.test(APP) && /const ok = !!selectedModel/.test(APP),
    'syncVersione non lega piu\' l\'accensione del campo alla scelta del modello');
  assert.ok(/id="versione"[^>]*\bdisabled\b/.test(INDEX),
    'il campo versione deve nascere spento: al primo disegno nessun modello e\' stato scelto');
});

test('foto: niente richieste allo scorrimento, e la miniatura si aggiorna nelle due viste', () => {
  assert.ok(!/new IntersectionObserver/.test(APP),
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
  assert.ok(/localStorage\.getItem\('amrPassProvincia'\)/.test(APP) &&
            /localStorage\.setItem\('amrPassProvincia'/.test(APP),
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
    assert.ok(!/fs\.writeFileSync\(\s*CACHE_FILE/.test(src),
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
    const s = saved.addSaved({ label: 'Kuga', params: { tipo: 'auto', marca: 'Ford' } });
    // Baseline scritta con le chiavi VECCHIE, com'e' il file di chi aggiorna oggi.
    saved.recordCheck(s.id, [{ fonte: 'subito', url: urlPrima, titolo: 'Kuga', prezzo: 12000 }]);

    // Il venditore ritocca il titolo: URL nuovo, stesso annuncio. Prima era un falso "nuovo".
    const dopo = saved.recordCheck(s.id, [{ fonte: 'subito', id: 'subito:651863039', url: urlDopo, titolo: 'Kuga', prezzo: 12000 }]);
    assert.deepStrictEqual(dopo, [], 'un titolo ritoccato non e\' un annuncio nuovo');

    // E lo storico del prezzo e' sopravvissuto: un calo vero deve ancora suonare.
    const calo = saved.recordCheck(s.id, [{ fonte: 'subito', id: 'subito:651863039', url: urlDopo, titolo: 'Kuga', prezzo: 10500 }]);
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
  assert.ok(!/textContent\.match\(\/\[A-Z0-9\]/.test(src),
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
  assert.match(richiami, /out\.ok !== false\) res\.set\('Cache-Control'/,
    'le rotte richiami rimettono un\'ora di cache su un "archivio non costruito"');
  const ebay = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ebay-scrape.js'), 'utf8');
  assert.ok(!/item details[\s\S]{0,80}return \{\}/.test(ebay),
    'un 403 di eBay torna a diventare una scheda vuota, che il chiamante cacha per un\'ora');
  assert.ok(!/catch \{ modelCache\[key\] = \[\]; \}/.test(APP),
    'una risposta mancata di /api/models torna a spegnere la tendina per tutta la sessione');
});

test('minori: il conto delle richieste comprende i ripieghi a browser', () => {
  // Il contatore esiste proprio per i rami che partono solo in certi casi, e i due ripieghi
  // a browser — quelli piu' cari — non entravano nel conto.
  for (const f of ['subito-playwright.js', 'autoscout-playwright.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', f), 'utf8');
    assert.match(src, /budget\.conta\([^)]*ripiego browser/, `${f} non conta le sue aperture di pagina`);
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

test('minori: una sessione sola, e il file si scrive intero o niente', () => {
  const ebay = fs.readFileSync(path.join(__dirname, '..', 'backend', 'ebay-scrape.js'), 'utf8');
  assert.match(ebay, /_ctxInVolo/,
    'due richieste eBay partite insieme tornano ad aprire due sessioni di Chromium');
  const sess = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'subito-session.js'), 'utf8');
  assert.match(sess, /renameSync/,
    'la sessione Subito torna a scriversi sul posto: un lettore puo\' trovarla a meta\'');
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

test('subito: se nessun annuncio porta un prezzo, e\' il parser — non il mercato', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'subito-api.js'), 'utf8');
  // L'annuncio senza prezzo non sparisce piu': entra marcato (il campo lo usa gia' Autoscout).
  assert.match(src, /m\.prezzoSuRichiesta = true/);
  assert.ok(!/if \(m && m\.prezzo != null\) out\.push/.test(src),
    'l\'annuncio senza prezzo torna a sparire, e il crawler lo archivia come venduto');
  // E se sono TUTTI senza prezzo, la fonte lo dichiara: 'error', non 'empty'.
  assert.match(src, /senzaPrezzo === out\.length/);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.match(srv, /if \(sospetto\) return \{ items, total, parziale, status: 'error'/,
    'un sospetto dichiarato dalla fonte non puo\' uscire come "nessun annuncio"');
});

test('il totale della pill dice a quale ricerca appartiene', () => {
  const moto = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'motoit.js'), 'utf8');
  assert.match(moto, /const totaleLargo = !params\.motoitModelSlug/,
    'senza slug del modello la ricerca e\' sulla marca, e il totale va dichiarato per quello che e\'');
  assert.match(APP, /s\.totaleLargo \? ' sulla marca' : ''/);
});

test('il DMG e\' staccato: niente aggiornamento automatico agganciato', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  assert.ok(!/scheduleUpdateCheck/.test(main.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')),
    'l\'auto-update e\' tornato agganciato: interroga GitHub e offre un installatore che non si usa');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'electron', 'auto-update.js')),
    'electron/auto-update.js e\' tornato: era li\' solo per il DMG');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!pkg.build.dmg, 'il blocco dmg e\' tornato in package.json');
  assert.ok(!(pkg.build.mac && pkg.build.mac.target), 'il target dmg e\' tornato fra i mac target');
});
