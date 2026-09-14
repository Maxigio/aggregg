'use strict';
/**
 * IL CANCELLO GUARDA CHI SEI, NON CHE RUOLO HAI.
 *
 * La regola di prima — "ruolo demo = sola lettura" — era l'unica possibile finche' il demo era
 * una password condivisa senza un nome. Da quando le persone si registrano, quella regola e' il
 * contrario di quel che serve: un iscritto DEVE poter salvare le sue ricerche.
 *
 * Qui si prova la regola nuova, e soprattutto i suoi confini:
 *   · il proprietario e' un'identita' PIU' un ruolo, mai l'id da solo;
 *   · una persona con un nome scrive, ma non tocca le cose che esistono in una copia sola;
 *   · l'ospite anonimo resta in sola lettura;
 *   · i prefissi coprono anche il percorso SENZA slash finale, senza pero' chiudere il ramo che
 *     sta sotto (`/api/saved/altri` e' del proprietario, `/api/saved` e' di ognuno);
 *   · la gestione degli account non e' piu' raggiungibile dal web, e non ci deve tornare;
 *   · la grafia non apre e non chiude niente: si decide su un percorso normalizzato.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-cancello-'));
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cancello-'));

const auth = require('../backend/auth');
const dbmod = require('../backend/utenti-db');
const srv = require('../backend/server');

auth.setPassword('gateprova1');
auth.setPersona('Anna Ospite', 'annaospi1', 'demo');
auth.setPersona('Bruno Collega', 'brunocol1', 'full');

const cookieDi = (ruolo, id) => `amr_auth=${auth.makeToken(ruolo, id)}`;
const PROPRIETARIO = cookieDi('full', 'owner');
const REGISTRATA = cookieDi('demo', 'anna-ospite');
const COLLEGA = cookieDi('full', 'bruno-collega');
const ANONIMO = cookieDi('demo', 'demo');

function chiama(cookie, metodo, percorso, accept) {
  const res = {
    statusCode: 200, redirectTo: null, corpo: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.corpo = b; return this; },
    send(b) { this.corpo = b; return this; },
    redirect(c, u) { this.statusCode = c; this.redirectTo = u; return this; },
    setHeader() {}, set() { return this; },
  };
  let passato = false;
  const req = { method: metodo, path: percorso, headers: { cookie }, ip: '203.0.113.9' };
  if (accept) req.headers.accept = accept;
  srv._gateAuth(req, res, () => { passato = true; });
  return { passato, status: res.statusCode, dove: res.redirectTo, corpo: res.corpo, req };
}

// Tutto quello che esiste in UNA copia sola per macchina, e che quindi non puo' essere di
// nessun altro — piu' l'unica lettura riservata al proprietario. Ogni voce va provata anche
// SENZA slash finale.
//
// La GESTIONE delle persone non e' piu' in questo elenco perche' non e' piu' sul web: approvare
// creava una credenziale permanente, cioe' faceva di una sessione presa in prestito per un
// minuto un accesso che sopravvive alla scadenza del cookie. Vive in `scripts/richieste.js`.
const DELLA_MACCHINA = [
  '/api/logs',
  '/api/saved/altri',
  '/api/subito/bootstrap', '/api/subito/keep-alive',
];

test('cancello: il proprietario passa dappertutto', () => {
  for (const p of DELLA_MACCHINA) {
    assert.strictEqual(chiama(PROPRIETARIO, 'GET', p).passato, true, `il proprietario e' stato fermato su ${p}`);
  }
  assert.strictEqual(chiama(PROPRIETARIO, 'POST', '/api/saved').passato, true);
});

test('cancello: chi ha un nome puo\' SCRIVERE le sue cose', () => {
  // E' il rovesciamento: prima "ruolo demo" voleva dire nessuna scrittura, e un iscritto non
  // avrebbe potuto salvare niente. L'isolamento fra persone non lo fa il cancello — da qui non
  // si vede di chi e' una riga — lo fa lo strato dati.
  for (const [m, p] of [['POST', '/api/saved'], ['DELETE', '/api/saved/abc'], ['POST', '/api/saved/abc/read'],
                        ['POST', '/api/competitor'], ['DELETE', '/api/competitor/7'], ['GET', '/api/saved']]) {
    const r = chiama(REGISTRATA, m, p);
    assert.strictEqual(r.passato, true, `la persona registrata e' stata fermata su ${m} ${p}`);
  }
  // E il cancello le mette in mano la sua identita', che e' quella che filtrera' le righe.
  assert.deepStrictEqual(
    [chiama(REGISTRATA, 'GET', '/api/saved').req.authId, chiama(REGISTRATA, 'GET', '/api/saved').req.authRole],
    ['anna-ospite', 'demo']);
});

test('cancello: chi ha un nome NON tocca le cose della macchina, in nessuna grafia', () => {
  for (const p of DELLA_MACCHINA) {
    for (const grafia of [p, p + '/', p.toUpperCase(), p.replace(/^\/api/, '/API')]) {
      const r = chiama(REGISTRATA, 'GET', grafia);
      assert.strictEqual(r.passato, false, `la persona registrata e' passata su ${grafia}`);
      assert.strictEqual(r.status, 403, `${grafia} doveva dare 403, ha dato ${r.status}`);
    }
  }
  // Il prefisso senza slash e' il caso che si dimentica: `startsWith('/api/saved/altri/')` da
  // solo lascerebbe fuori proprio l'elenco.
  assert.strictEqual(chiama(REGISTRATA, 'GET', '/api/saved/altri').status, 403);
  // Ma le SUE ricerche restano sue: il prefisso non deve chiudere tutto /api/saved.
  assert.strictEqual(chiama(REGISTRATA, 'GET', '/api/saved').passato, true);
  assert.strictEqual(chiama(REGISTRATA, 'POST', '/api/saved').passato, true);
});

test('cancello: la gestione delle persone non e\' piu\' raggiungibile dal web', () => {
  // Non basta che il cancello la neghi: le rotte non devono proprio esistere. Un cookie scade,
  // un account no — e approvare dal web faceva di un minuto di sessione presa in prestito un
  // accesso permanente. Il gesto e' tornato dove non passa da un browser
  // (`scripts/richieste.js`), e quello che qui si difende e' che non torni indietro da solo.
  const SRV = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'backend', 'registrazioni-route.js'), 'utf8');
  const codice = t => t.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');

  for (const rotta of ['/richieste', '/api/richieste', '/api/persone']) {
    assert.ok(!new RegExp(`app\\.(get|post|put|delete)\\('${rotta}`).test(codice(ROUTE) + codice(SRV)),
      `la rotta ${rotta} e' tornata sul web: la gestione degli account non ci deve stare`);
  }
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'pagine', 'richieste.html')),
    'la pagina del pannello e\' tornata: era servita da un handler, e su questo filesystem si sarebbe scaricata anche scritta in un altro modo');
  // E lo script c'e', con dentro tutti e quattro i gesti.
  const CLI = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'richieste.js'), 'utf8');
  for (const g of ['--elenco', '--approva', '--rifiuta', '--revoca', '--registro']) {
    assert.ok(CLI.includes(g), `scripts/richieste.js non sa piu' fare ${g}`);
  }
});

test('cancello: un collega "full" non e\' il proprietario', () => {
  // Il ruolo pieno vuol dire "puo' scrivere", non "e' la sua macchina": il registro degli
  // accessi contiene le ricerche e gli indirizzi di tutti, e la sessione del portale e' una sola.
  assert.strictEqual(chiama(COLLEGA, 'GET', '/api/logs').passato, false);
  assert.strictEqual(chiama(COLLEGA, 'GET', '/api/saved/altri').passato, false);
  assert.strictEqual(chiama(COLLEGA, 'POST', '/api/subito/bootstrap').passato, false);
  // Ma tutto il resto e' suo come prima.
  assert.strictEqual(chiama(COLLEGA, 'POST', '/api/saved').passato, true);
  assert.strictEqual(chiama(COLLEGA, 'GET', '/api/search').passato, true);
});

test('cancello: l\'ospite ANONIMO resta in sola lettura', () => {
  // Senza un nome non si sa di chi sarebbe la riga che salva: e' l'unico motivo per cui la
  // sola lettura esisteva, e per lui vale ancora.
  for (const [m, p] of [['POST', '/api/saved'], ['GET', '/api/saved'], ['POST', '/api/competitor'],
                        ['DELETE', '/api/competitor/7'], ['GET', '/API/SAVED'], ['GET', '/api/saved/']]) {
    const r = chiama(ANONIMO, m, p);
    assert.strictEqual(r.passato, false, `l'ospite anonimo e' passato su ${m} ${p}`);
    assert.strictEqual(r.status, 403);
  }
  assert.strictEqual(chiama(ANONIMO, 'GET', '/api/search').passato, true, 'guardare deve poterlo fare');
  assert.strictEqual(chiama(ANONIMO, 'POST', '/api/report').passato, true, 'segnalare un problema anche');
  assert.strictEqual(chiama(ANONIMO, 'POST', '/api/report-pdf').passato, true, 'e stampare cio\' che ha gia\' a schermo');

  // Il cookie che nessun login produce ma che si puo' costruire a mano: ruolo 'demo' con id
  // 'owner' (il valore predefinito di makeToken). Nel dubbio, la porta piu' stretta.
  const chimera = cookieDi('demo', 'owner');
  assert.strictEqual(chiama(chimera, 'POST', '/api/saved').passato, false, 'ruolo demo con id owner non e\' il proprietario');
  assert.strictEqual(chiama(chimera, 'GET', '/api/logs').passato, false);
});

test('cancello: la grafia non apre e non chiude le porte pubbliche', () => {
  assert.strictEqual(srv._percorsoGate('/API/Saved/'), '/api/saved');
  assert.strictEqual(srv._percorsoGate('/invito/'), '/invito');
  assert.strictEqual(srv._percorsoGate('/'), '/');
  assert.strictEqual(srv._percorsoGate('///'), '/');

  // `/invito/` — lo slash che il telefono aggiunge incollando — deve arrivare alla pagina, non
  // al login: chi apre un invito una password non ce l'ha ancora.
  for (const p of ['/invito', '/invito/', '/INVITO', '/login/', '/api/registrazione/']) {
    assert.strictEqual(chiama('amr_auth=niente', 'GET', p).passato, true, `${p} doveva restare pubblica`);
  }
  // E cio' che pubblico non e', non lo diventa cambiando le maiuscole.
  assert.strictEqual(chiama('amr_auth=niente', 'GET', '/api/search').status, 401);
  assert.strictEqual(chiama('amr_auth=niente', 'GET', '/API/SAVED/ALTRI').status, 401);
});

// ── Il tetto giornaliero ─────────────────────────────────────────────────────

function tetto(authId, authRole) {
  const res = {
    statusCode: 200, corpo: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.corpo = b; return this; }, setHeader() {},
  };
  let passato = false;
  srv._tettoGiornaliero({ authId, authRole, method: 'GET', path: '/api/search', headers: {} }, res, () => { passato = true; });
  return { passato, status: res.statusCode, corpo: res.corpo };
}

test('tetto: scatta alla ricerca dopo l\'ultima concessa, e riparte il giorno dopo', () => {
  dbmod.chiudi();
  const p = dbmod.percorso();
  for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* non c'era */ } }
  const MAX = srv._TETTO_GIORNALIERO;

  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(tetto('anna-ospite', 'demo').passato, true, `la ricerca numero ${i} doveva passare`);
  }
  const oltre = tetto('anna-ospite', 'demo');
  assert.strictEqual(oltre.passato, false, `la ricerca numero ${MAX + 1} doveva essere fermata`);
  assert.strictEqual(oltre.status, 429);
  assert.match(oltre.corpo.error, /riparte domani/i, 'il messaggio deve dire QUANDO si riprova');
  assert.strictEqual(dbmod.ricercheOggi('anna-ospite'), MAX, 'una ricerca rifiutata non deve addebitarsi');

  // Il conto e' per persona e per giorno: un altro nome parte da zero, e domani anche lei.
  assert.strictEqual(tetto('carlo-altro', 'demo').passato, true);
  const domani = Date.now() + 24 * 60 * 60 * 1000;
  assert.strictEqual(dbmod.consumaRicerca('anna-ospite', MAX, domani).ok, true, 'domani il conto riparte');
});

test('tetto: il proprietario e i colleghi non hanno tetto', () => {
  // E' la loro macchina: il tetto serve a proteggerla dagli ospiti, non a limitarli.
  for (let i = 0; i < srv._TETTO_GIORNALIERO + 5; i++) {
    assert.strictEqual(tetto('owner', 'full').passato, true);
    assert.strictEqual(tetto('bruno-collega', 'full').passato, true);
  }
  assert.strictEqual(dbmod.ricercheOggi('owner'), 0, 'del proprietario non si tiene nemmeno il conto');
});

test('tetto: anche l\'ospite condiviso ha un tetto, e lo divide con tutti', () => {
  // Il tetto difende il traffico che esce dall'IP di casa, non un elenco da scrivere: la
  // password che gira di mano in mano e' l'identita' meno fidata di tutte, e prima era l'unica
  // esente. Non avendo un nome paga su un secchio solo, condiviso fra tutti quelli che ce l'hanno.
  const MAX = srv._TETTO_GIORNALIERO;
  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(tetto('demo', 'demo').passato, true, `la ricerca numero ${i} doveva passare`);
  }
  const oltre = tetto('demo', 'demo');
  assert.strictEqual(oltre.passato, false, 'l\'ospite condiviso non e\' piu\' esente dal tetto');
  assert.strictEqual(oltre.status, 429);
  assert.strictEqual(dbmod.ricercheOggi('demo'), MAX, 'il conto e\' uno solo per tutta la password condivisa');
});

test('tetto: vale anche per la ricerca in-process del canale WhatsApp', async () => {
  // _amrSearchFn e' la closure che il bot WhatsApp usa al posto di /api/search: arrivava a
  // runSearch senza addebito, e un demo fermo alle 50 sul web continuava dal telefono.
  const MAX = srv._TETTO_GIORNALIERO;
  assert.strictEqual(dbmod.consumaRicerche('pina-whatsapp', MAX, MAX).ok, true, 'oggi e\' gia\' tutto speso');
  const r = await srv._amrSearchFn({ marca: 'Audi' }, { id: 'pina-whatsapp', nome: 'Pina', ruolo: 'demo' });
  assert.deepStrictEqual(r.tettoEsaurito, { usate: MAX, max: MAX }, 'a credito finito NON si cerca: si risponde solo che il conto e\' finito');
  assert.strictEqual(dbmod.ricercheOggi('pina-whatsapp'), MAX, 'la ricerca rifiutata non si addebita');
  // L'addebito sta DOPO la validazione: un parametro sbagliato non costa una delle 50.
  const r2 = await srv._amrSearchFn({}, { id: 'rino-whatsapp', ruolo: 'demo' });
  assert.match(r2.error, /marca obbligatoria/);
  assert.strictEqual(dbmod.ricercheOggi('rino-whatsapp'), 0);
});

test('tetto: se il magazzino non si apre, l\'ospite si ferma — non passa "perche\' non si sa"', () => {
  const vecchio = process.env.USER_DATA_PATH;
  try {
    dbmod.chiudi();
    process.env.USER_DATA_PATH = path.join(os.tmpdir(), `amr-magazzino-sparito-${process.pid}`);
    const r = tetto('anna-ospite', 'demo');
    assert.strictEqual(r.passato, false, 'un contatore che non si legge non e\' un contatore a zero');
    assert.strictEqual(r.status, 503);
    // Il proprietario invece non passa nemmeno di qui: l'app non si blocca per lui.
    assert.strictEqual(tetto('owner', 'full').passato, true);
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});
