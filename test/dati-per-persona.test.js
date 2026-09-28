'use strict';
/**
 * QUELLO CHE E' MIO NON E' TUO.
 *
 * Il cancello non puo' fare questo lavoro: da li' non si vede di chi e' una riga. Lo fa il
 * magazzino, e queste prove guardano proprio il confine — non "il salvataggio funziona", ma
 * "quello dell'altro non lo tocco, non lo leggo, e non scopro nemmeno che esiste".
 *
 * L'ultima parte e' meno ovvia delle prime due: se cancellare la ricerca di un altro rispondesse
 * "non e' tua" invece di "non c'e'", quel "no" diverso direbbe che esiste.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-persone-'));
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-persone-'));

const dbmod = require('../backend/utenti-db');
const saved = require('../backend/saved');
const miei = require('../backend/dati-utente');

const R = (url, prezzo) => ({ url, prezzo, anno: 2018, km: 80000, titolo: 'BMW 320d' });

function daCapo() {
  dbmod.chiudi();
  const p = dbmod.percorso();
  for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* non c'era */ } }
}

test('ricerche salvate: due persone, due elenchi', () => {
  daCapo();
  const a = saved.addSaved('anna', { label: 'Golf di Anna', params: { tipo: 'auto', marca: 'Volkswagen' } });
  const b = saved.addSaved('bruno', { label: 'Panda di Bruno', params: { tipo: 'auto', marca: 'Fiat' } });

  assert.deepStrictEqual(saved.listSaved('anna').map(s => s.label), ['Golf di Anna']);
  assert.deepStrictEqual(saved.listSaved('bruno').map(s => s.label), ['Panda di Bruno']);
  assert.deepStrictEqual(saved.listSaved('carlo'), [], 'chi non ha salvato niente non vede niente');

  // Leggere la ricerca di un altro conoscendone l'id: non si puo'.
  assert.strictEqual(saved.getSaved('anna', b.id), null, 'Anna non deve poter leggere la ricerca di Bruno');
  assert.ok(saved.getSaved('bruno', b.id), 'ma Bruno la sua si\'');
});

test('ricerche salvate: cancellare quella di un altro risponde "non c\'e\'", non "non e\' tua"', () => {
  daCapo();
  saved.addSaved('anna', { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
  const b = saved.addSaved('bruno', { label: 'Panda', params: { tipo: 'auto', marca: 'Fiat' } });

  assert.strictEqual(saved.removeSaved('anna', b.id), false, 'la ricerca di Bruno non e\' cancellabile da Anna');
  assert.strictEqual(saved.removeSaved('anna', 'id-inventato'), false);
  // Le due risposte sono identiche di proposito: un "no" diverso direbbe che quella ricerca
  // esiste, e chi la sta cercando lo scoprirebbe provando.
  assert.strictEqual(saved.listSaved('bruno').length, 1, 'e infatti e\' ancora li\'');

  assert.strictEqual(saved.markRead('anna', b.id), false, 'nemmeno segnarla letta');
  assert.strictEqual(saved.recordCheck('anna', b.id, [R('x', 10000)]).length, 0,
    'e nemmeno scriverci dentro lo storico');
  assert.ok(saved.getSaved('bruno', b.id).seen === undefined || !Object.keys(saved.getSaved('bruno', b.id).seen).length,
    'lo storico di Bruno non deve essersi mosso');
});

test('ricerche salvate: gli avvisi di uno non entrano nella coda dell\'altro', () => {
  daCapo();
  const a = saved.addSaved('anna', { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
  const b = saved.addSaved('bruno', { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });

  const base = [R('a', 10000), R('b', 9000), R('c', 9500)];
  saved.recordCheck('anna', a.id, base);              // baseline silenziosa
  saved.recordCheck('bruno', b.id, base);
  const nuoviAnna = saved.recordCheck('anna', a.id, [...base, R('d', 8800)]);

  assert.deepStrictEqual(nuoviAnna.map(x => x.motivo), ['nuovo']);
  assert.strictEqual(saved.listSaved('anna')[0].novita, 1);
  assert.strictEqual(saved.listSaved('bruno')[0].novita, 0,
    'Bruno non ha controllato niente: la sua coda deve essere ferma');

  // E segnare letto e' un gesto suo: non tocca la coda dell'altro.
  saved.recordCheck('bruno', b.id, [...base, R('d', 8800)]);
  assert.strictEqual(saved.listSaved('bruno')[0].novita, 1);
  saved.markRead('anna', a.id);
  assert.strictEqual(saved.listSaved('anna')[0].novita, 0);
  assert.strictEqual(saved.listSaved('bruno')[0].novita, 1, 'la coda di Bruno e\' rimasta come stava');
});

test('ricerche salvate: senza un padrone non si scrive niente', () => {
  daCapo();
  // Una chiamata che dimentica CHI non deve finire in un mucchio comune chiamato "undefined":
  // sarebbe il mucchio unico di prima, con un altro nome e senza che nessuno se ne accorga.
  for (const vuoto of [undefined, null, '', '   ']) {
    assert.throws(() => saved.listSaved(vuoto), /manca l'utente/);
    assert.throws(() => saved.addSaved(vuoto, { params: { tipo: 'auto', marca: 'BMW' } }), /manca l'utente/);
  }
});

test('archivio di prima: viene eliminato e non rientra nel database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-archivio-'));
  const vecchio = process.env.USER_DATA_PATH;
  try {
    process.env.USER_DATA_PATH = dir;
    dbmod.chiudi();
    const file = path.join(dir, 'saved-searches.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'vecchia1', label: 'Golf di prima', params: { tipo: 'auto', marca: 'Volkswagen' }, alerts: [], seen: {} },
      { id: 'vecchia2', label: 'Panda di prima', params: { tipo: 'auto', marca: 'Fiat' }, alerts: [], seen: {} },
    ], null, 2));
    const db = dbmod.apri();
    assert.ok(db, dbmod.guasto());
    assert.strictEqual(fs.existsSync(file), false, 'il vecchio archivio JSON e\' ancora sul disco');
    assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM ricerche').get().n), 0,
      'le vecchie ricerche sono rientrate nel database');
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Impostazioni di prezzo ──────────────────────────────────────────────────

test('le mie cose: l’API espone solo preferenze, senza elenchi salvati', () => {
  daCapo();
  const t = miei.tutto('anna');
  assert.deepStrictEqual(t.preferenze, {});
  assert.strictEqual(Object.prototype.hasOwnProperty.call(t, 'salvataggi'), false);
  assert.strictEqual(typeof miei.scriviElenco, 'undefined');
  assert.strictEqual(typeof miei.leggiElenco, 'undefined');
});

test('le mie cose: preferenze per persona, e solo quelle dichiarate', () => {
  daCapo();
  miei.scriviPreferenza('anna', 'amr_price_v', '{"comm":500}');
  miei.scriviPreferenza('bruno', 'amr_price_v', '{"comm":900}');

  assert.deepStrictEqual(miei.leggiPreferenze('anna'), { amr_price_v: '{"comm":500}' });
  assert.deepStrictEqual(miei.leggiPreferenze('bruno'), { amr_price_v: '{"comm":900}' },
    'due persone, due preventivi: sono le cifre che finiscono sul PDF del cliente');

  // Una chiave qualunque non entra: il magazzino non e' un deposito per quello che passa.
  assert.throws(() => miei.scriviPreferenza('anna', 'qualunque', 'x'), e => e.code === 'PREFERENZA_SCONOSCIUTA');
  assert.throws(() => miei.scriviPreferenza('anna', 'amr_price_v', 'x'.repeat(5000)), e => e.code === 'TROPPO_GRANDE');
  for (const vuoto of [undefined, null, '']) {
    assert.throws(() => miei.leggiPreferenze(vuoto), /manca l'utente/);
  }
});

test('le mie cose: magazzino guasto dichiarato e nessuna scrittura', () => {
  const vecchio = process.env.USER_DATA_PATH;
  try {
    dbmod.chiudi();
    process.env.USER_DATA_PATH = path.join(os.tmpdir(), `amr-miei-sparito-${process.pid}`);
    const t = miei.tutto('anna');
    assert.deepStrictEqual(t.preferenze, {});
    assert.ok(t.guasto, 'il guasto del magazzino va dichiarato');
    assert.throws(() => miei.scriviPreferenza('anna', 'amr_price_v', '{}'), e => e.code === 'DATI_NON_DISPONIBILI');
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});

test('le mie cose: un ciclo di PUT si ferma, prima del corpo, e solo per chi insiste', () => {
  daCapo();
  let parsati = 0;
  const json = (req, res, next) => { parsati++; next(); };
  const rotte = [];
  const app = {
    get: (p, ...mw) => rotte.push({ m: 'GET', p, mw }),
    put: (p, ...mw) => rotte.push({ m: 'PUT', p, mw }),
  };
  miei.mount(app, { json, utenteDi: req => req.chi, chiaveLimite: req => 'u:' + req.chi });

  const chiama = (m, p, req) => {
    const r = rotte.find(x => x.m === m && x.p === p);
    assert.ok(r, `rotta ${m} ${p} non montata`);
    let stato = 200;
    let corpo = null;
    const res = {
      status(n) { stato = n; return this; },
      set() { return this; },
      json(b) { corpo = b; return this; },
    };
    let i = 0;
    const next = () => { const f = r.mw[i++]; if (f) f(req, res, next); };
    next();
    return { stato, corpo };
  };
  const put = chi => chiama('PUT', '/api/miei/preferenze/:chiave',
    { chi, params: { chiave: 'amr_price_v' }, body: { valore: '{}' } });

  let passate = 0;
  let fermata = null;
  for (let i = 0; i < 500 && !fermata; i++) {
    const r = put('anna');
    if (r.stato === 429) fermata = r;
    else { assert.strictEqual(r.stato, 200); passate++; }
  }
  assert.ok(fermata, 'il ciclo non si ferma mai: e\' proprio il blocco dell\'event loop che si voleva evitare');
  assert.ok(passate >= 100, `il freno stringe troppo per una persona vera: solo ${passate} colpi`);
  assert.ok(fermata.corpo.riprovaFra > 0, 'chi viene fermato deve sapere fra quanto riprovare');

  const finQui = parsati;
  put('anna');
  assert.strictEqual(parsati, finQui, 'una PUT gia\' rifiutata non deve nemmeno far parsare il corpo');
  assert.strictEqual(put('bruno').stato, 200, 'il tetto e\' di chi insiste, non di tutti');
});

test('il browser elimina tutte le vecchie cache e non offre salvataggi ricambi', () => {
  daCapo();
  const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const HTML = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  for (const key of ['amr_salvati', 'amr_salvati_ricambi', 'amr_oem_preferiti']) {
    assert.ok(APP.includes(`'${key}'`), `la cache legacy ${key} non viene eliminata`);
  }
  assert.doesNotMatch(APP, /mieiManda|rcToggleSave|rcToggleFav|rc-btn-save|rcSaveCode/);
  assert.doesNotMatch(HTML, /btnSaved|offcanvasSaved|Ricambi salvati/);
});

/**
 * REGRESSIONE, e di quelle che cancellano i soldi del proprietario. Il menu "Prezzo €" dei
 * veicoli lo disegna `init()` UNA volta sola, col cfg di QUESTO browser, e l'unico altro
 * ridisegno (la rete di sicurezza di `renderResults`) non scatta mai perche' il <summary> c'e'
 * gia'. Quando poi arrivavano le preferenze dell'account, `priceCfgV` cambiava e il menu no: su
 * un computer nuovo le righe erano gia' rettificate di +500 mentre i campi mostravano zero. E
 * siccome `readPriceMenu` rilegge TUTTI i campi dal DOM, non solo quello toccato, bastava
 * scrivere in UN campo perche' gli altri quattro tornassero su stantii — commissione cancellata
 * dall'account, quindi anche dall'altro computer, senza un avviso. Qui gira il codice VERO di
 * frontend/app.js (mieiCarica + il menu prezzi) su un DOM finto ricostruito dal suo stesso HTML.
 */
test('le mie cose: le impostazioni prezzo dell\'account entrano anche NEL menu, non solo nei conti', async () => {
  daCapo();
  const CFG = { comm: 500, commUnit: 'eur', spese: 0, margine: 10, iva: false, passaggio: 0 };
  miei.scriviPreferenza('anna', 'amr_price_v', JSON.stringify(CFG));
  const payload = miei.tutto('anna');
  assert.deepStrictEqual(Object.keys(payload.preferenze), ['amr_price_v'], 'il presupposto: di la\' c\'e\' solo il prezzo');

  const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const pezzo = (da, finoA) => {
    const i = APP.indexOf(da);
    assert.ok(i > 0, `non trovo piu' \`${da}\` in frontend/app.js`);
    const j = APP.indexOf(finoA, i);
    assert.ok(j > i, `non trovo piu' la fine di \`${da}\``);
    return APP.slice(i, j);
  };

  // DOM minimo: gli <input> non sono scritti a mano, si ricostruiscono dall'HTML che genera
  // `priceMenuHTML` — cosi' la prova misura il menu vero e non una sua imitazione.
  const campi = new Map();
  const dettagli = { open: false, classList: { toggle() {} } };
  const host = {
    _h: '',
    get innerHTML() { return this._h; },
    set innerHTML(h) {
      this._h = h;
      campi.clear();
      for (const m of h.matchAll(/<input\b[^>]*\bid="([^"]+)"([^>]*)>/g)) {
        const v = /\bvalue="([^"]*)"/.exec(m[2]);
        campi.set(m[1], { value: v ? v[1] : '', checked: /\bchecked\b/.test(m[2]), addEventListener() {} });
      }
    },
    querySelector: () => dettagli,
  };
  const store = new Map();                    // browser nuovo: qui dentro non c'e' niente
  const saliti = [];
  const globali = {
    fetch: async () => ({ ok: true, json: async () => payload }),
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    document: { getElementById: id => (id === 'priceMenuV' ? host : campi.get(id) || null) },
    console: { warn() {} },
    PRICE_DEFAULT: require('../frontend/pricing.js').PRICE_DEFAULT,
    priceAdjActive: require('../frontend/pricing.js').priceAdjActive,
    priceCfgV: null, mieiPronti: false, currentResults: [], renderResults() {},
    mieiPreferenza: (k, v) => saliti.push([k, v]),
  };
  const corpo = [
    pezzo('async function mieiCarica()', '\nlet searchActive'),
    pezzo('function loadPriceCfg(key)', '\nlet priceCfgV'),
    pezzo('function priceMenuHTML(cfg, ns)', '\n// Colonne/celle extra'),
    pezzo('function renderPriceMenuV()', '\n// Il dropdown "Prezzo €"'),
    `return (async () => {
       priceCfgV = loadPriceCfg('amr_price_v');    // init(), su un browser dove non c'e' niente
       renderPriceMenuV();
       const prima = document.getElementById('pmComm_v').value;
       await mieiCarica();                          // arrivano le preferenze dell'account
       const dopo = document.getElementById('pmComm_v').value;
       document.getElementById('pmMarg_v').value = '5';   // e lui tocca SOLO il margine
       priceCfgV = readPriceMenu('v', priceCfgV);
       savePriceCfg('amr_price_v', priceCfgV);
       return { prima, dopo, priceCfgV };
     })();`,
  ].join('\n');
  const chiavi = Object.keys(globali);
  const esito = await new Function(...chiavi, corpo)(...chiavi.map(k => globali[k]));

  assert.strictEqual(esito.prima, '', 'il presupposto: all\'avvio il menu e\' a zero');
  assert.strictEqual(esito.dopo, '500', 'il menu e\' rimasto indietro rispetto ai prezzi gia\' rettificati');
  assert.strictEqual(esito.priceCfgV.comm, 500, 'toccare il margine ha cancellato la commissione');
  assert.strictEqual(esito.priceCfgV.margine, 5);
  const ultimo = saliti.filter(([k]) => k === 'amr_price_v').pop();
  assert.ok(ultimo, 'il gesto deve comunque salire sull\'account');
  assert.strictEqual(JSON.parse(ultimo[1]).comm, 500, 'e sull\'account non deve salire uno zero al posto dei 500 €');
});

test('annunci, ricambi e ricerche salvate non hanno piu\' una superficie HTTP', () => {
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  const MIEI = fs.readFileSync(path.join(__dirname, '..', 'backend', 'dati-utente.js'), 'utf8');
  assert.doesNotMatch(SRV, /require\(['"]\.\/saved['"]\)/);
  assert.doesNotMatch(SRV, /app\.(?:get|post|put|delete)\(['"]\/api\/saved/);
  assert.doesNotMatch(MIEI, /\/api\/miei\/elenco|salvataggi/);
});
