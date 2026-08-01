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
