'use strict';
/**
 * LE ROTTE DELL'AREA ASTE. Le prove che contano:
 *  - il magazzino vuoto o rotto si DICHIARA, non diventa «nessuna asta trovata»;
 *  - le rotte fisse (`/filtri`, `/portale`) non vengono mangiate da `/:id`;
 *  - dal dettaglio non escono i dati personali del referente della procedura;
 *  - il portale che non risponde e' un 502, non un errore nostro, e intanto si serve
 *    quello che abbiamo gia' in magazzino.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const route = require('../backend/aste-route');
const db = require('../backend/aste-db');

/** Un finto `app` che tiene gli handler, nell'ordine in cui sono stati registrati. */
function monta(deps = {}) {
  const H = {};
  const ordine = [];
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; ordine.push('GET ' + p); },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; ordine.push('POST ' + p); },
  };
  route.mount(app, deps);
  return { H, ordine };
}
function resFinta() {
  const r = { code: 200, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
/**
 * Ogni prova col SUO indirizzo: il limitatore vive a livello di modulo, quindi lo stato passa da
 * un test all'altro. Con un indirizzo solo, la prova che ne consuma uno faceva fallire quella
 * che conta i tre giri — e il guasto sembrava del limitatore, non del test.
 */
let contatore = 0;
const req = (query = {}, params = {}, ip = null) => ({ query, params, ip: ip || `10.0.0.${++contatore}` });
const stessoIp = () => `10.9.9.${++contatore}`;

function conCartella(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-aste-rt-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  db._reset();
  const pulisci = () => {
    db._reset();
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
  };
  const esito = (() => { try { return fn(dir); } catch (e) { pulisci(); throw e; } })();
  if (esito && typeof esito.then === 'function') return esito.then(v => { pulisci(); return v; }, e => { pulisci(); throw e; });
  pulisci();
  return esito;
}

const GIORNO = 24 * 60 * 60 * 1000;
const fraGiorni = n => new Date(Date.now() + n * GIORNO).toISOString().slice(0, 10);
const lotto = (id, extra = {}) => ({
  id, descrizione: `Motociclo di prova ${id}`, marca: 'Voge', cumulativo: false, piattaforma: null,
  prezzoBase: 900, offertaMinima: 700, rialzoMinimo: 50, dataVendita: fraGiorni(20),
  orarioVendita: '10:00', dataPubblicazione: fraGiorni(-5), citta: 'Verona', provincia: 'Verona',
  tribunale: 'Tribunale di VERONA', numeroLotto: 'LOTTO UNICO', procedura: '3', ...extra,
});

test('le rotte fisse si registrano PRIMA di /:id', () => {
  // Express 5 non accetta piu' il vincolo `:id(\\d+)`: senza questo ordine, una richiesta a
  // /api/aste/filtri finirebbe nel gestore del dettaglio e uscirebbe «id non valido».
  const { ordine } = monta();
  const i = n => ordine.indexOf(n);
  assert.ok(i('GET /api/aste/filtri') < i('GET /api/aste/:id'), '/filtri deve venire prima di /:id');
  assert.ok(i('GET /api/aste/portale') < i('GET /api/aste/:id'), '/portale deve venire prima di /:id');
});

test('nessuna risposta e\' cachabile dal browser', async () => conCartella(async () => {
  // Senza `Cache-Control` il browser decide da solo per quanto tenere una risposta, e su
  // un'asta significa mostrare una scadenza o un prezzo base vecchi. Successo davvero.
  const { H } = monta({
    pvp: { dettaglio: async () => ({ idVendita: 1 }), pagina: async () => ({ lotti: [], totale: 0 }), urlAnnuncio: () => '', urlAllegato: l => l },
    aste: { giro: async () => ({ ok: true }), indiceMarche: () => new Map() },
  });
  const chiamate = [
    ['GET /api/aste', req()],
    ['GET /api/aste/filtri', req()],
    ['GET /api/aste/portale', req({ q: 'honda' })],
    ['GET /api/aste/:id', req({}, { id: '1' })],
    ['POST /api/aste/aggiorna', req()],
  ];
  for (const [nome, r] of chiamate) {
    const res = resFinta();
    await H[nome](r, res);
    assert.equal(res.headers['Cache-Control'], 'no-store', `${nome} deve dire no-store`);
  }
}));

test('magazzino mai riempito: elenco vuoto MA lo stato lo dice', () => conCartella(() => {
  const { H } = monta();
  const res = resFinta();
  H['GET /api/aste'](req(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.lotti, []);
  // La differenza fra «non ho ancora scaricato» e «non c'e' niente da vedere».
  assert.equal(res.body.magazzino, 'assente');
  assert.equal(res.body.daAggiornare, true);
  assert.equal(res.body.ultimoGiro, null);
}));

test('l\'elenco filtra, e il tipo sbagliato e\' un 400', () => conCartella(() => {
  db.sostituisci('moto', [
    lotto(1, { marca: 'Voge', prezzoBase: 800 }),
    lotto(2, { marca: 'Yamaha', prezzoBase: 4000, provincia: 'Milano' }),
    lotto(3, { marca: null, cumulativo: true, descrizione: 'N. 12 scooter incidentati' }),
  ], Date.now());
  const { H } = monta();

  let res = resFinta();
  H['GET /api/aste'](req({ marca: 'Voge' }), res);
  assert.deepEqual(res.body.lotti.map(l => l.id), [1]);

  res = resFinta();
  H['GET /api/aste'](req({ soloSingoli: '1' }), res);
  assert.deepEqual(res.body.lotti.map(l => l.id).sort(), [1, 2]);

  res = resFinta();
  H['GET /api/aste'](req({ q: 'incidentati' }), res);
  assert.deepEqual(res.body.lotti.map(l => l.id), [3]);

  res = resFinta();
  H['GET /api/aste'](req({ tipo: 'camion' }), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.ok, false);
}));

test('i filtri contano a parte i lotti senza marca, invece di nasconderli', () => conCartella(() => {
  db.sostituisci('moto', [lotto(1, { marca: 'Voge' }), lotto(2, { marca: null })], Date.now());
  const { H } = monta();
  const res = resFinta();
  H['GET /api/aste/filtri'](req(), res);
  assert.deepEqual(res.body.marche, [{ nome: 'Voge', quanti: 1 }]);
  assert.equal(res.body.senzaMarca, 1, 'il lotto senza marca si conta, non sparisce');
  assert.deepEqual(res.body.province, [{ provincia: 'Verona', quanti: 2 }]);
}));

test('dal dettaglio non escono i dati personali del referente', async () => conCartella(async () => {
  const pvpFinto = {
    dettaglio: async () => ({
      idVendita: 99, impoBaseAsta: 900, dataVendita: '2026-10-01', dataTermPresOff: '30/09/2026',
      descModVendita: 'Telematica', procedura: { numeRg: '3', numeAnnoRg: 2019, descUfficio: 'Tribunale di Siena' },
      // Il rito e' incollato senza spazio anche qui, non solo in `descLotto`.
      beni: [{ descrizione: 'Motociclo Voge 300RPer visionare la documentazione disponibile, si invitano le parti', descTipologiaBene: 'Motoveicolo' }],
      allegati: [{ nomeFile: 'perizia.pdf', codiceTipoAllegato: 'PERIZ', dimensioneAllegato: 201346, linkAllegato: '/allegati/99/perizia.pdf' }],
      // Il ministero li pubblica; noi non li ridistribuiamo.
      soggetti: [{ nome: 'Mario', cognome: 'Rossi', cellulare: '3331234567', email: 'm@r.it', cf: 'RSSMRA80A01L781X' }],
    }),
    urlAnnuncio: id => `https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=${id}`,
    urlAllegato: l => `https://resource-pvp.giustizia.it${l}`,
  };
  const { H } = monta({ pvp: pvpFinto });
  const res = resFinta();
  await H['GET /api/aste/:id'](req({}, { id: '99' }), res);
  assert.equal(res.code, 200);
  const testo = JSON.stringify(res.body);
  for (const vietato of ['Mario', 'Rossi', '3331234567', 'RSSMRA80A01L781X', 'soggetti']) {
    assert.ok(!testo.includes(vietato), `${vietato} non deve uscire dal dettaglio`);
  }
  // Ma quello che serve per decidere c'e' tutto, allegati compresi.
  assert.equal(res.body.dettaglio.termineOfferte, '2026-09-30');
  assert.equal(res.body.dettaglio.beni[0].descrizione, 'Motociclo Voge 300R', 'il rito va tolto anche dai beni');
  assert.equal(res.body.dettaglio.allegati[0].tipo, 'PERIZ');
  assert.ok(res.body.dettaglio.allegati[0].url.startsWith('https://resource-pvp.giustizia.it/'));
}));

test('il portale che non risponde e\' un 502, e intanto si serve il magazzino', async () => conCartella(async () => {
  db.sostituisci('moto', [lotto(42)], Date.now());
  const pvpFinto = {
    dettaglio: async () => { throw new Error('timeout'); },
    urlAnnuncio: id => `https://pvp.giustizia.it/x?id=${id}`,
    urlAllegato: l => l,
  };
  const { H } = monta({ pvp: pvpFinto });
  const res = resFinta();
  await H['GET /api/aste/:id'](req({}, { id: '42' }), res);
  assert.equal(res.code, 502);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.lotto, 'quello che abbiamo gia\' si serve lo stesso');
  assert.equal(res.body.lotto.id, 42);
  assert.ok(res.body.url, 'e il link al portale resta, per andarci a mano');
}));

test('un id non numerico non arriva alla fonte', async () => conCartella(async () => {
  let chiamato = false;
  const { H } = monta({ pvp: { dettaglio: async () => { chiamato = true; return null; }, urlAnnuncio: () => '', urlAllegato: l => l } });
  const res = resFinta();
  await H['GET /api/aste/:id'](req({}, { id: 'pippo' }), res);
  assert.equal(res.code, 400);
  assert.equal(chiamato, false, 'niente rete per un id che non e\' un numero');
}));

test('la ricerca libera divide i vivi dai passati invece di buttarli in silenzio', async () => conCartella(async () => {
  const pvpFinto = {
    pagina: async () => ({
      totale: 2, ultima: true,
      lotti: [
        { id: 1, descLotto: 'Motociclo Honda CB500', dataVendita: fraGiorni(10), indirizzo: {} },
        { id: 2, descLotto: 'Motociclo Honda Hornet', dataVendita: fraGiorni(-10), indirizzo: {} },
      ],
    }),
  };
  const { H } = monta({ pvp: pvpFinto, aste: { indiceMarche: () => new Map() } });
  const res = resFinta();
  await H['GET /api/aste/portale'](req({ q: 'honda' }), res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.lotti.map(l => l.id), [1]);
  assert.equal(res.body.passati, 1, 'i passati si contano e si dicono');
  assert.equal(res.body.totalePortale, 2);
}));

test('la ricerca libera chiede al portale l\'ordine decrescente', async () => conCartella(async () => {
  // Il punto cieco della prova qui sopra: il finto `pagina` ignora l'ordinamento, il portale no.
  // La fonte ordina per data di vendita e il 90% del suo archivio e' passato, quindi chiedendo il
  // crescente le prime 50 righe sono tutte vendite vecchie e la rotta risponde «117 lotti sul
  // portale, nessuno da mostrarti». Qui il finto si comporta come la fonte vera.
  let visto = null;
  const riga = (id, data) => ({ id, descLotto: 'Motociclo Honda CB500', dataVendita: data, indirizzo: {} });
  const pvpFinto = {
    pagina: async (tipo, opzioni) => {
      visto = opzioni;
      const meta = n => Array.from({ length: 50 }, (_, i) => riga(n + i, n === 100 ? '2024-01-10' : fraGiorni(10)));
      return { totale: 117, ultima: false, lotti: opzioni.ordine === 'desc' ? meta(200) : meta(100) };
    },
  };
  const { H } = monta({ pvp: pvpFinto, aste: { indiceMarche: () => new Map() } });
  const res = resFinta();
  await H['GET /api/aste/portale'](req({ q: 'honda' }), res);
  assert.equal(visto.ordine, 'desc', 'col crescente si pesca solo nell\'archivio passato');
  assert.equal(res.body.lotti.length, 50, 'e con il decrescente i lotti vivi arrivano davvero');
  assert.equal(res.body.passati, 0);
}));

test('la ricerca libera senza testo non esce verso il portale', async () => conCartella(async () => {
  let chiamato = false;
  const { H } = monta({ pvp: { pagina: async () => { chiamato = true; return { lotti: [], totale: 0 }; } } });
  const res = resFinta();
  await H['GET /api/aste/portale'](req({ q: '  ' }), res);
  assert.equal(res.code, 400);
  assert.equal(chiamato, false);
}));

test('l\'aggiornamento a mano si ferma dopo tre giri nell\'ora', async () => conCartella(async () => {
  let giri = 0;
  const { H } = monta({ aste: { giro: async () => { giri++; return { ok: true, visti: 1, nuovi: 0, spariti: 0 }; }, indiceMarche: () => new Map() } });
  const ip = stessoIp();
  for (let i = 0; i < 3; i++) {
    const res = resFinta();
    await H['POST /api/aste/aggiorna'](req({}, {}, ip), res);
    assert.equal(res.code, 200, `il giro ${i + 1} doveva passare`);
  }
  const res = resFinta();
  await H['POST /api/aste/aggiorna'](req({}, {}, ip), res);
  assert.equal(res.code, 429);
  assert.equal(giri, 3, 'il quarto non deve toccare il portale');
  assert.ok(res.body.riprovaFra > 0, 'e si dice quando riprovare');
}));

/**
 * LA DOTTRINA DEI TRE STATI VALE ANCHE DALL'ALTRA PARTE, A SCHERMO. Qui non si prova una rotta:
 * si ESEGUE la riga vera di frontend/app.js che raccoglie la fetch fallita. Sostituire `asDati`
 * in blocco cancellava l'ultima lista buona, e da li' la pagina accusava il magazzino di essere
 * vuoto quando invece era pieno, spingendo verso Aggiorna — cioe' un giro intero sul portale del
 * ministero (e una delle tre fiches orarie) per un wi-fi caduto due secondi.
 */
test('una fetch fallita non cancella l\'elenco che l\'utente ha gia\' a schermo', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const righe = APP.split('\n');

  const rigaCatch = righe.find(r => r.trim().startsWith('asDati = { ...(asDati'));
  assert.ok(rigaCatch, 'il catch di asCarica non tiene piu\' l\'ultima risposta buona');
  const dopoIlCatch = new Function('asDati', `${rigaCatch.trim()} return asDati;`);

  const dopo = dopoIlCatch({
    ok: true, lotti: [lotto(1), lotto(2)], magazzino: 'ok',
    ultimoGiro: { finitoIl: Date.now() }, daAggiornare: false,
  });
  assert.equal(dopo.lotti.length, 2, 'la lista buona deve sopravvivere alla rete che cade');
  assert.equal(dopo.magazzino, 'ok', 'un errore di rete non deve far risultare vuoto il magazzino');
  assert.ok(dopo.ultimoGiro, 'e la riga in alto non deve tornare «mai aggiornato»');
  assert.ok(dopo.errore, 'l\'errore va segnato, altrimenti l\'avviso non compare');

  // Senza un elenco precedente non se ne inventa uno.
  assert.deepEqual(dopoIlCatch(null).lotti, []);

  // Il 500 di qui sopra ha corpo JSON valido: `r.json()` riesce e il catch non scatterebbe da
  // solo. Senza questa guardia il guasto del server si traveste da magazzino vuoto, e in
  // silenzio, perche' la rotta scrive `error` mentre l'avviso legge `errore`.
  assert.ok(righe.find(r => r.trim().startsWith('if (!d || !d.ok')),
    'asCarica non controlla piu\' che la risposta sia ok prima di tenerla per buona');
});

/**
 * IL TETTO DELL'ELENCO SI CHIEDE, E ANCHE QUI SI ESEGUE LA RIGA VERA DI frontend/app.js.
 * Senza `limite` la rotta ne serve 500 e ordina per data di vendita CRESCENTE: i tagliati sono
 * quelli con vendita piu' lontana, cioe' gli unici su cui c'e' ancora tempo per preparare
 * un'offerta. E se ne accorgerebbe nessuno: `quanti` e' gia' post-LIMIT, mentre le tendine di
 * /filtri tetto non ne hanno e continuerebbero a contarli tutti. Il magazzino vero vive a un
 * soffio dal 500 (491 auto vive al 2026-09-14), quindi il margine e' di pochi lotti.
 */
test('l\'elenco a schermo chiede il tetto: 520 lotti vivi non diventano 500', () => conCartella(() => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const riga = APP.split('\n').find(r => r.trim().startsWith('const q = new URLSearchParams({ tipo: asStato.tipo'));
  assert.ok(riga, 'la riga che costruisce la query dell\'area Aste non esiste piu\'');
  const query = new Function('asStato', `${riga.trim()} return Object.fromEntries(q);`)({ tipo: 'auto' });

  db.sostituisci('auto', Array.from({ length: 520 }, (_, i) => lotto(i + 1, { dataVendita: fraGiorni(i + 1) })), Date.now());
  const { H } = monta();

  const res = resFinta();
  H['GET /api/aste'](req(query), res);
  assert.equal(res.body.lotti.length, 520,
    'la lista si tronca in silenzio: mancano i lotti con la vendita piu\' lontana');

  // E il conteggio della lista deve tornare con quello delle tendine, che tetto non hanno:
  // le due meta' della stessa schermata non possono dire numeri diversi.
  const rf = resFinta();
  H['GET /api/aste/filtri'](req({ tipo: 'auto' }), rf);
  assert.equal(res.body.quanti, rf.body.marche.reduce((s, m) => s + m.quanti, 0) + rf.body.senzaMarca);
}));

/**
 * IL MOTIVO DEL FALLIMENTO NON SI BUTTA ALL'ULTIMO METRO. Il giro che muore sulla FONTE esce
 * come 200 con `{ok:false, motivo}` — scelta dichiarata sopra la riga della rotta — mentre
 * `error` lo scrivono solo il 429 e il 500. L'avviso a schermo leggeva il solo `error`, quindi
 * nel caso NORMALE di fallimento restava la frase generica: uno legge «aggiornamento non
 * riuscito» di fronte a uno scraper rotto per sempre, ci vede un intoppo di passaggio e ripreme,
 * bruciando le altre due fiches orarie. Anche qui si esegue la riga vera di frontend/app.js.
 */
test('il giro fallito dice PERCHE\', non solo «aggiornamento non riuscito»', async () => conCartella(async () => {
  const motivo = 'PVP: fe-config senza msUrl utilizzabile';
  const { H } = monta({ aste: { giro: async () => ({ ok: false, motivo }), indiceMarche: () => new Map() } });
  const res = resFinta();
  await H['POST /api/aste/aggiorna'](req(), res);
  assert.equal(res.code, 200, 'la rotta ha funzionato: e\' il portale che non ha risposto');
  assert.equal(res.body.ok, false);
  assert.equal(res.body.motivo, motivo, 'il motivo deve uscire dalla rotta, in chiaro');

  const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const riga = APP.split('\n').find(r => r.trim().startsWith('if (!r.ok) alert('));
  assert.ok(riga, 'l\'avviso dell\'Aggiorna non e\' piu\' dove il test lo cerca');
  const avviso = corpo => {
    let detto = null;
    new Function('r', 'alert', riga.trim())(corpo, m => { detto = m; });
    return detto;
  };
  assert.equal(avviso(res.body), motivo, 'il motivo c\'era, viaggiava sul filo, e veniva scartato');
  // Il 429 e il 500 continuano a passare per `error`, che resta il piu' preciso dei due.
  assert.equal(avviso({ ok: false, error: 'hai gia\' aggiornato tre volte' }), 'hai gia\' aggiornato tre volte');
  assert.equal(avviso({ ok: false }), 'aggiornamento non riuscito');
}));

/**
 * IL DETTAGLIO APERTO NON SI RICHIUDE DA SOLO SOTTO LE DITA. `.as-det` sta DENTRO la card che
 * porta `data-aslotto`, e il gestore delegato riapriva/richiudeva su qualunque clic risalisse
 * fin li' tranne che sugli `<a>`: dentro il dettaglio pero' quasi niente e' un link — il termine
 * delle offerte, i beni, i tag, la riga «procedura … · ufficio» e tutto il bianco del box. Chi
 * trascinava per copiarsi la procedura nel gestionale si ritrovava, al rilascio del mouse, il
 * dettaglio chiuso e la selezione sparita. E riaprirlo non e' gratis: `/api/aste/:id` non ha
 * cache di server e `det.dataset.caricato` si scrive solo in caso di successo, quindi ogni
 * chiusura accidentale prima o durante il caricamento e' un'altra chiamata al portale del
 * ministero e un altro gettone di rate-limit. Anche qui si eseguono le righe vere di app.js.
 */
test('un clic dentro il dettaglio aperto non lo richiude', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  const righe = APP.split('\n');
  const iBox = righe.findIndex(r => r.trim().startsWith('const box = e.target.closest(\'[data-aslotto]\')'));
  assert.ok(iBox >= 0, 'il gestore delegato dell\'area Aste non e\' piu\' dove il test lo cerca');
  const iFine = righe.findIndex((r, i) => i >= iBox && r.includes('asDettaglio(box'));
  assert.ok(iFine > 0, 'la riga che apre il dettaglio non esiste piu\'');
  const gestore = new Function('e', 'asDettaglio',
    righe.slice(iBox, iFine + 1).filter(r => !r.trim().startsWith('//')).join('\n'));

  // Un finto bersaglio: `closest` sale la catena e torna il primo che combacia, come nel DOM.
  const nodo = (sel, su = null) => ({
    su, dataset: { aslotto: '7', astipo2: 'auto' },
    closest(s) { return sel.includes(s) ? this : (this.su ? this.su.closest(s) : null); },
  });
  const tocca = target => { let toccato = false; gestore({ target }, () => { toccato = true; }); return toccato; };

  const card = nodo(['[data-aslotto]']);
  const det = nodo(['.as-det'], card);
  const detbox = nodo([], det);

  assert.equal(tocca(nodo([], card)), true, 'le righe della card devono ancora aprire e chiudere');
  assert.equal(tocca(detbox), false, 'il testo del dettaglio richiudeva il dettaglio, selezione compresa');
  assert.equal(tocca(det), false, 'anche il bianco del box richiudeva il dettaglio');
  assert.equal(tocca(nodo(['a'], detbox)), false, 'i link del dettaglio restano link');
  // Fuori dalle card non si tocca niente: il pannello porta anche filtri e bottoni.
  assert.equal(tocca(nodo([])), false);
});

/**
 * IL FRENO DELL'AGGIORNA E' DELLA MACCHINA, NON DELLA PERSONA. `limiteAggiorna` conta per chiave
 * e la chiave e' l'utente (server.js:518): i tre giri nell'ora erano tre A TESTA, quindi otto
 * ospiti registrati che premono la pastiglia «da aggiornare» facevano fino a ventiquattro
 * passate intere sul portale del ministero — una trentina di chiamate l'una — per un inventario
 * che cambia una volta al giorno. La dedup `inVolo` di aste.js non copre questo caso: fonde i
 * giri partiti INSIEME, non quelli sparpagliati nell'ora.
 *
 * Qui ogni pressione arriva da una persona diversa, che il suo tetto personale non lo sfiora
 * nemmeno, e deve fermarsi lo stesso. VA IN FONDO AL FILE apposta: consuma il budget orario
 * della macchina, che vive a livello di modulo come gli altri limitatori.
 */
test('l\'aggiorna si ferma anche quando a premere sono persone diverse', async () => conCartella(async () => {
  let giri = 0;
  const { H } = monta({ aste: { giro: async () => { giri++; return { ok: true, visti: 1, nuovi: 0, spariti: 0 }; }, indiceMarche: () => new Map() } });
  let fermato = null;
  for (let i = 0; i < 20 && !fermato; i++) {
    const res = resFinta();
    await H['POST /api/aste/aggiorna'](req(), res);   // `req()` senza ip: ogni volta una persona nuova
    if (res.code === 429) fermato = res;
  }
  assert.ok(fermato, 'venti persone diverse hanno fatto venti giri interi sul portale del ministero');
  assert.match(fermato.body.error, /macchina/i, 'e a chi non ha speso niente va detto che il tetto non e\' suo');
  assert.ok(fermato.body.riprovaFra > 0, 'con il quando si puo\' riprovare');
  assert.ok(fermato.body.restanti > 0, 'i suoi giri restano suoi: non si azzera il conto di chi non ha premuto');

  // E il no vale anche per la persona dopo: nessun altro giro parte.
  const primaDelNo = giri;
  const res = resFinta();
  await H['POST /api/aste/aggiorna'](req(), res);
  assert.equal(res.code, 429);
  assert.equal(giri, primaDelNo, 'dopo lo stop non deve partire nessun giro');
}));
