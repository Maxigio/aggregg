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
