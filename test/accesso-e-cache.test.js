'use strict';
/**
 * LE TRE DIFESE DELL'INGRESSO, provate senza aprire una porta.
 *
 * Niente supertest (non e' fra le dipendenze): si chiamano i gestori esportati da server.js
 * con richieste e risposte finte. E' lo stesso mestiere che fa gia' whatsapp.test.js.
 *
 *   1. il gate demo non si aggira cambiando le maiuscole del percorso
 *   2. i tentativi di login in parallelo si contano davvero (e decadono)
 *   3. la cache delle ricerche non congela una risposta con una fonte scaduta
 */
// Il log NON va nel registro operativo vero: questo file requira server.js (o un modulo
// che lo tira dentro), e server.js installa il tee su file. Senza questa riga ogni run
// appendeva a data/logs/amr.log, righe ERROR comprese, e con la rotazione a 5 MB poteva
// far ruotare il log vero. Deve stare PRIMA di ogni require di backend: LOG_DIR e' una
// const valutata al caricamento del modulo.
const os = require('node:os'), fsTmp = require('node:fs'), pathTmp = require('node:path');
process.env.AMR_LOG_DIR = fsTmp.mkdtempSync(pathTmp.join(os.tmpdir(), 'amr-log-'));

const { test } = require('node:test');
const assert = require('node:assert');

// Stub di `tailscale funnel status` per il test 4: server.js cattura execFile per
// destructuring al require, quindi il rimpiazzo deve stare PRIMA del require qui sotto.
// Solo le chiamate ['funnel', ...] sono intercettate (contate e risposte dopo 50ms,
// la finestra in cui le richieste concorrenti si devono accodare, non moltiplicare);
// tutto il resto passa all'execFile vero.
const cp = require('node:child_process');
const execFileVero = cp.execFile;
let spawnFunnel = 0;
cp.execFile = function (bin, args) {
  if (Array.isArray(args) && args[0] === 'funnel') {
    spawnFunnel++;
    const cb = arguments[arguments.length - 1];
    setTimeout(() => cb(null, 'https://finto.ts.net/\n', ''), 50);
    return;
  }
  return execFileVero.apply(this, arguments);
};

const auth = require('../backend/auth');
const srv = require('../backend/server');

/** Risposta finta: raccoglie status, corpo e redirect senza toccare la rete. */
function resFinta() {
  const r = { statusCode: 200, corpo: null, redirectTo: null, headers: {} };
  r.status = c => { r.statusCode = c; return r; };
  r.json = b => { r.corpo = b; return r; };
  r.send = b => { r.corpo = b; return r; };
  r.redirect = (c, u) => { r.statusCode = c; r.redirectTo = u; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
const reqFinta = (metodo, percorso, extra = {}) => ({
  method: metodo, path: percorso, headers: {}, ip: '203.0.113.9', ...extra,
});

// ── 1. Gate demo ─────────────────────────────────────────────────────────────
test('gate demo: le rotte private sono negate in QUALSIASI grafia del percorso', t => {
  if (!auth.isEnabled()) return t.skip('auth non configurata su questa macchina');
  // Un cookie demo vero, fatto con l'auth del repo: se la password demo non c'e', si salta.
  const token = auth.makeToken('demo');
  const cookie = `amr_auth=${token}`;
  if (auth.checkToken(token) !== 'demo') return t.skip('ruolo demo non disponibile');

  const chiama = (metodo, percorso) => {
    const res = resFinta();
    let passato = false;
    srv._gateAuth(reqFinta(metodo, percorso, { headers: { cookie } }), res, () => { passato = true; });
    return { passato, status: res.statusCode };
  };

  // Le grafie che il router di Express consegna comunque all'handler minuscolo.
  // `/api/logs` al posto delle vecchie `/api/crawl/*` (cancellate col crawler): serve una rotta
  // solo-owner scritta in maiuscolo, perche' e' la grafia che il gate deve normalizzare.
  for (const p of ['/api/saved', '/API/saved', '/API/SAVED', '/Api/Saved', '/API/saved/',
                   '/api/logs', '/API/LOGS']) {
    const r = chiama('GET', p);
    assert.strictEqual(r.passato, false, `il demo e' passato su ${p}`);
    assert.strictEqual(r.status, 403, `${p} doveva rispondere 403, ha risposto ${r.status}`);
  }
  // E cio' che il demo DEVE poter fare continua a passare.
  assert.strictEqual(chiama('GET', '/api/search').passato, true, 'il demo deve poter cercare');
  assert.strictEqual(chiama('POST', '/api/report').passato, true, 'il demo deve poter segnalare');
});

// ── 2. Lockout del login ─────────────────────────────────────────────────────
test('login: i tentativi sbagliati in parallelo si contano uno per uno', async t => {
  if (!auth.isEnabled()) return t.skip('auth non configurata su questa macchina');
  const ip = '198.51.100.77';
  srv._loginAttempts.delete(ip);

  // LOCK_MAX = 8: nove tentativi insieme, l'ultimo deve trovare il lockout gia' scattato.
  const uno = () => {
    const res = resFinta();
    return srv._postLogin(
      // `socket` da loopback: e' cosi' che arriva una richiesta proxata dal Funnel, ed e'
      // l'unico caso in cui X-Forwarded-For viene creduto (senza, l'header lo scrive il client).
      { method: 'POST', path: '/login', headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' }, ip, body: { password: 'sbagliata-di-sicuro' } },
      res,
    ).then(() => res.redirectTo);
  };
  const esiti = await Promise.all(Array.from({ length: 9 }, uno));

  const provati = esiti.filter(u => u === '/login?err=1').length;
  const bloccati = esiti.filter(u => u === '/login?err=locked').length;
  // Prima del fix il contatore veniva letto PRIMA dell'attesa di un secondo: tutte e nove
  // leggevano 0, scrivevano 1, e il lockout non scattava mai (misurato: 9 su 9 err=1).
  assert.strictEqual(provati, 8, `password davvero provate: ${provati} (attese 8)`);
  assert.strictEqual(bloccati, 1, `richieste respinte dal lockout: ${bloccati} (attesa 1)`);
  assert.strictEqual(srv._loginAttempts.get(ip).fails, 8, 'il contatore deve valere 8, non 1');

  srv._loginAttempts.delete(ip);
});

test('login: i fallimenti decadono dopo mezz\'ora di quiete', async t => {
  if (!auth.isEnabled()) return t.skip('auth non configurata su questa macchina');
  const ip = '198.51.100.78';
  // Sette fallimenti vecchi di un'ora: non devono sommarsi a quello nuovo, altrimenti il
  // contatore lo azzera solo un login riuscito e chi condivide l'IP resta fuori a oltranza.
  srv._loginAttempts.set(ip, { fails: 7, until: 0, last: Date.now() - 60 * 60 * 1000 });
  const res = resFinta();
  await srv._postLogin(
    { method: 'POST', path: '/login', headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: '127.0.0.1' }, ip, body: { password: 'ancora-sbagliata' } },
    res,
  );
  assert.strictEqual(srv._loginAttempts.get(ip).fails, 1, 'i fallimenti vecchi di un\'ora devono essere decaduti');
  assert.strictEqual(res.redirectTo, '/login?err=1');
  srv._loginAttempts.delete(ip);
});

// ── 3. Cache delle ricerche ──────────────────────────────────────────────────
test('cache ricerche: NON congela una risposta con una fonte in timeout', () => {
  const con = st => ({ totale: 60, sources: { subito: { status: 'ok' }, autoscout: { status: st }, moto: { status: 'ok' } } });
  assert.strictEqual(srv._cacheable(con('ok')), true, 'tre fonti a posto: si cacha');
  // Il timeout mancava dall'elenco degli stati-rotti: la risposta senza Autoscout restava
  // ferma tre minuti e ripremere Cerca non faceva ripartire nessuna richiesta.
  assert.strictEqual(srv._cacheable(con('timeout')), false, 'una fonte scaduta non si cacha');
  assert.strictEqual(srv._cacheable(con('error')), false, 'una fonte in errore non si cacha');
  // Moto.it e' l'altra fonte che puo' dire 'timeout' (Subito ha il suo wrapper).
  assert.strictEqual(srv._cacheable({ totale: 60, sources: { subito: { status: 'ok' }, autoscout: { status: 'ok' }, moto: { status: 'timeout' } } }), false);
  // 'skipped' NON e' uno stato-rotto: la marca non c'e' su quella fonte e non ci sara' fra tre minuti.
  assert.strictEqual(srv._cacheable(con('skipped')), true, 'una fonte saltata non deve impedire la cache');
  // PARZIALE: grafie AS24 cadute con superstiti. Lo status resta 'ok' (gli item ci sono),
  // ma la risposta e' monca quanto un timeout: congelarla renderebbe inutile ripremere Cerca.
  assert.strictEqual(srv._cacheable({ totale: 60, sources: { subito: { status: 'ok' }, autoscout: { status: 'ok', parziale: '1/3 grafie AS24 fallite: http 429' }, moto: { status: 'ok' } } }), false,
    'un risultato dichiarato parziale non si cacha');
  // SUBITO mette nello STESSO campo due nature diverse, quindi li' non basta la stringa.
  // Famiglie CADUTE: transitorio come le grafie AS24, ritentare puo' cambiare esito.
  assert.strictEqual(srv._cacheable({ totale: 60, sources: {
    subito: { status: 'ok', parziale: '2 famiglie su 8 non hanno risposto', parzialeRete: true },
    autoscout: { status: 'ok' }, moto: { status: 'ok' } } }), false,
    'famiglie Subito cadute: monco transitorio, non si cacha');
  // Famiglie MAI CHIESTE (oltre il tetto di 8, o agganciate dal ponte): deterministico.
  // Ritentare rifa' otto richieste in fila a hades per lo stesso identico esito, e queste
  // sono le ricerche piu' care che abbiamo: e' proprio la risposta che va tenuta.
  assert.strictEqual(srv._cacheable({ totale: 60, sources: {
    subito: { status: 'ok', parziale: '1 famiglie Subito oltre il tetto di 8 non sono state chieste', parzialeRete: null },
    autoscout: { status: 'ok' }, moto: { status: 'ok' } } }), true,
    'famiglie Subito oltre il tetto: monco deterministico, resta cachabile');
  // MENU VERSIONI MOTO.IT caduto per RETE: la ricerca parte senza filtro versione (o con un
  // elenco monco), lo status resta 'ok', ma congelarla tre minuti renderebbe inutile
  // ripremere Cerca — il ritentativo funzionerebbe (motoit-models non cacha i suoi KO).
  assert.strictEqual(srv._cacheable({ totale: 60, sources: { subito: { status: 'ok' }, autoscout: { status: 'ok' },
    moto: { status: 'ok', versioneElencoMonco: 'il menu versioni di Moto.it non ha risposto: il filtro versione non e\' stato applicato a questa fonte', versioneKoRete: true } } }), false,
    'un KO di rete del menu versioni non si cacha');
  // L'elenco monco DETERMINISTICO (oltre 12 famiglie, modello senza codice) invece si cacha:
  // ritentare fra tre minuti darebbe lo stesso identico esito.
  assert.strictEqual(srv._cacheable({ totale: 60, sources: { subito: { status: 'ok' }, autoscout: { status: 'ok' },
    moto: { status: 'ok', versioneElencoMonco: 'il modello non ha un codice su Moto.it: la ricerca su questa fonte e\' larga', versioneKoRete: null } } }), true,
    'un elenco monco deterministico resta cachabile');
});

// ── 4. /api/public-url: un solo subprocess per cache-miss ────────────────────
// La rotta e' auth-exempt e la cache da 60s copre solo chi arriva DOPO il
// completamento: senza dedup, N richieste concorrenti a cache scaduta
// spawnavano N processi `tailscale` (fino a 3s l'uno), ripetibile a ogni TTL.
test('public-url: le richieste concorrenti a cache scaduta condividono UN solo tailscale', async () => {
  spawnFunnel = 0;
  // Ondata a cache scaduta (all'avvio ts=0): 50 richieste insieme.
  const urls = await Promise.all(Array.from({ length: 50 }, () =>
    new Promise(risolvi => srv._tailscalePublicUrl(risolvi))));
  assert.strictEqual(spawnFunnel, 1, `un solo subprocess atteso, visti ${spawnFunnel}`);
  assert.ok(urls.every(u => u === 'https://finto.ts.net'), 'ogni richiesta in coda riceve l\'URL');
  // Ondata a cache calda: zero subprocess.
  const url2 = await new Promise(risolvi => srv._tailscalePublicUrl(risolvi));
  assert.strictEqual(spawnFunnel, 1, 'a cache calda non parte nessun subprocess');
  assert.strictEqual(url2, 'https://finto.ts.net');
});
