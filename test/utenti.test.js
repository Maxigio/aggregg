'use strict';
/**
 * CHI ENTRA, E COSA VEDE UNA VOLTA DENTRO.
 *
 * Due regole, non due correzioni:
 *
 *   1. SOLA LETTURA NON VUOL DIRE UNA STANZA SOLA. L'ospite in sola lettura vedeva un solo
 *      modo su quattro: `applyDemoMode()` nascondeva `#modeToggle` e rimetteva la ricerca su
 *      Auto a ogni ricaricamento. Ma il gate del server gli nega soltanto le SCRITTURE — le
 *      letture di Moto, Ricambi e Competitor le ha sempre permesse. La UI era piu' stretta
 *      del permesso vero, e chi entrava vedeva un'app rotta invece di un'app limitata.
 *      Qui si prova che il selettore resta E che a sparire sono solo i comandi che
 *      prenderebbero 403.
 *
 *   2. IL .env E' L'ELENCO COMPLETO, non un'aggiunta. Chi non ci sta scritto non entra piu',
 *      compresa la password demo condivisa. E si controlla TUTTO prima di scrivere QUALSIASI
 *      COSA: una riga sbagliata in fondo non deve lasciare meta' persone dentro e meta' fuori.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Prima di ogni require di backend: auth.js decide dove sta auth.json al momento della
// chiamata, ma server.js valuta la cartella dei log al caricamento del modulo.
process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-utenti-'));
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-utenti-'));

/**
 * IL .env VERO NON DEVE ENTRARE QUI DENTRO.
 *
 * `scripts/utenti-da-env` chiama `dotenv.config()` quando lo si carica: al `require` piu'
 * sotto, il .env di questa macchina finisce dentro `process.env`. Da quando `applica()` copia
 * auth.json anche nelle destinazioni di `AMR_AUTH_ANCHE`, una chiamata senza ambiente esplicito
 * prendeva quelle VERE — e far girare la suite riscriveva le credenziali della cartella Electron
 * dell'iMac e, via scp, quelle sul Mac di papa'. Successo davvero il 2026-08-03: dopo un
 * `node --test` non entrava piu' nessuno, su nessuna delle due macchine, con dentro l'utente
 * di prova "anna-bianchi".
 *
 * Due difese, e servono tutte e due: le chiavi si cancellano DOPO il require (vedi sotto: farlo
 * prima non serve a niente, dotenv le rimette), e ogni test passa comunque un ambiente suo.
 * La prima protegge anche i test che verranno.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const auth = require('../backend/auth');
const {
  pianifica, applica, leggiVoce, destinazioni, verificaDestinazioni, copiaAltrove, CHIAVE_ADMIN,
} = require('../scripts/utenti-da-env');

// QUI, dopo il require: e' quel require a chiamare dotenv.config(), quindi cancellarle prima
// non serviva a niente — venivano rimesse un attimo dopo, e il primo `node --test` scriveva
// di nuovo sulle macchine vere.
delete process.env.AMR_AUTH_ANCHE;
delete process.env.AMR_AUTH_SSH_KEY;

const RADICE = path.join(__dirname, '..');
const sorgente = (...p) => fs.readFileSync(path.join(RADICE, ...p), 'utf8');

// ── 1. Il selettore dei modi resta a chi e' in sola lettura ──────────────────

test('sola lettura: applyDemoMode NON nasconde il selettore dei modi', () => {
  const app = sorgente('frontend', 'app.js');
  const inizio = app.indexOf('function applyDemoMode()');
  assert.ok(inizio > 0, "applyDemoMode() non c'e' piu': se e' stata rinominata, aggiorna questo test");
  // Fino alla funzione successiva: il corpo, non il commento che lo precede (il commento cita
  // `modeToggle` apposta per spiegare perche' non c'e' piu', e aggancerebbe la ricerca).
  const corpo = app.slice(inizio, app.indexOf('\n}', inizio));

  assert.ok(!corpo.includes('modeToggle'),
    'applyDemoMode() torna a nascondere #modeToggle: chi entra in sola lettura non vede piu\' Moto, Ricambi e Competitor');
  assert.ok(!/setSearchMode\s*\(/.test(corpo),
    "applyDemoMode() torna a forzare il modo: gira DOPO ripristinaModo() e riporta l'ospite su Auto a ogni ricaricamento");
});

test('sola lettura: i quattro modi esistono nella pagina e i comandi che scrivono sono nascosti', () => {
  const html = sorgente('frontend', 'index.html');
  for (const m of ['auto', 'moto', 'ricambi', 'competitor']) {
    assert.ok(html.includes(`data-mode="${m}"`), `il modo "${m}" non e' piu' nel selettore`);
  }
  // Mostrare il modo Competitor senza togliere i suoi comandi di scrittura vorrebbe dire
  // mandare l'ospite dritto contro un 403. La regola sta in CSS e non in JS perche'
  // cpRender() ridisegna il pannello a ogni azione.
  const css = sorgente('frontend', 'style.css');
  for (const sel of ['#competitorFields', '.cp-togli', '.cp-unisci', '.cp-separa']) {
    assert.ok(new RegExp(`body\\.demo-mode\\s+\\${sel.startsWith('.') ? '' : ''}${sel.replace('.', '\\.')}`).test(css)
      || css.includes(`body.demo-mode ${sel}`),
      `body.demo-mode non nasconde piu' ${sel}: l'ospite vedrebbe un comando che prende 403`);
  }
});

test('sola lettura: il server permette la LETTURA dei quattro modi e nega le scritture', () => {
  // Requisito del gate vero, non della UI: se un giorno il server chiudesse anche le letture,
  // il selettore andrebbe rinascosto — e questo test diventerebbe rosso per dirlo.
  const srv = require('../backend/server');
  // La credenziale se la fa il test nella sua cartella temporanea: appoggiarsi a quella della
  // macchina voleva dire saltare in silenzio su ogni macchina senza auth.json — cioe' non
  // provare niente proprio dove serviva.
  auth.setPassword('gateprova1');
  const token = auth.makeToken('demo');
  assert.strictEqual(auth.checkToken(token), 'demo');
  const cookie = `amr_auth=${token}`;

  const chiama = (metodo, percorso) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
      json() { return this; }, send() { return this; },
      redirect(c, u) { this.statusCode = c; this.redirectTo = u; return this; }, setHeader() {} };
    let passato = false;
    srv._gateAuth({ method: metodo, path: percorso, headers: { cookie }, ip: '203.0.113.9' },
      res, () => { passato = true; });
    return passato;
  };

  for (const p of ['/api/search', '/api/ricambi', '/api/competitor']) {
    assert.strictEqual(chiama('GET', p), true, `il demo deve poter leggere ${p}: e' uno dei quattro modi`);
  }
  for (const [m, p] of [['POST', '/api/competitor'], ['DELETE', '/api/competitor/7']]) {
    assert.strictEqual(chiama(m, p), false, `il demo non deve poter scrivere: ${m} ${p}`);
  }
});

// ── 2. L'elenco delle persone si controlla prima di scriverlo ────────────────

const PW = { admin: 'proprie8', anna: 'annaseg1', bruno: 'brunose1', demo: 'provademo2026' };

test('utenti-da-env: una riga sbagliata ferma TUTTO prima di scrivere', () => {
  // La regola non e' "l'errore viene segnalato": e' che nessuno entra finche' non torna tutto.
  const prima = auth.persone().map(p => p.id).sort();
  const rotti = [
    { AMR_ADMIN_PASSWORD: '' },                                                  // manca il proprietario
    { AMR_ADMIN_PASSWORD: 'corta' },                                             // troppo corta
    { AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: 'Anna Bianchi' },             // senza due-punti
    { AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: 'Anna Bianchi:x' },           // password corta
    { AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: 'demo:' + PW.anna },          // id riservato
    { AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}`,
      AMR_UTENTE_02: `anna  bianchi:${PW.bruno}` },                              // stesso id
    { AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}`,
      AMR_UTENTE_02: `Bruno Verdi:${PW.anna}` },                                 // stessa password
    { AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.admin}` }, // uguale a quella del proprietario
  ];
  for (const env of rotti) {
    assert.throws(() => pianifica(env), Error, `doveva rifiutare: ${JSON.stringify(env)}`);
  }
  assert.deepStrictEqual(auth.persone().map(p => p.id).sort(), prima,
    'una pianificazione fallita ha comunque toccato auth.json');
});

test('utenti-da-env: la password puo\' contenere i due-punti, e :piena da\' la scrittura', () => {
  const v = leggiVoce('AMR_UTENTE_01', 'Anna Bianchi:pa:ss:word');
  assert.strictEqual(v.nome, 'Anna Bianchi');
  assert.strictEqual(v.pw, 'pa:ss:word', 'la password si taglia sul PRIMO due-punti, non su tutti');
  assert.strictEqual(v.ruolo, 'demo', 'senza :piena si guarda e basta');
  assert.strictEqual(leggiVoce('AMR_UTENTE_02', 'Bruno Verdi:brunose1:piena').ruolo, 'full');
  assert.strictEqual(leggiVoce('AMR_UTENTE_03', 'Bruno Verdi:brunose1:PIENA').ruolo, 'full',
    'il suffisso non deve dipendere dalle maiuscole');
});

test('utenti-da-env: righe vuote ignorate, il resto entra col ruolo giusto', () => {
  const { voci } = pianifica({
    AMR_ADMIN_PASSWORD: PW.admin,
    AMR_UTENTE_01: `Anna Bianchi:${PW.anna}`,
    AMR_UTENTE_02: '   ',
    AMR_UTENTE_03: `Bruno Verdi:${PW.bruno}:piena`,
  });
  assert.deepStrictEqual(voci.map(v => [v.id, v.ruolo]), [['anna-bianchi', 'demo'], ['bruno-verdi', 'full']]);
});

test('utenti-da-env: il .env e\' l\'elenco COMPLETO — chi sparisce non entra piu\'', () => {
  // Stato di partenza: proprietario + demo condivisa + una persona che nel .env non c'e'.
  auth.setPassword('vecchia8');
  auth.setDemoPassword(PW.demo);
  auth.setPersona('Carlo Neri', 'carlone1', 'demo');
  assert.ok(auth.verifica(PW.demo), 'la demo condivisa doveva valere prima');
  assert.ok(auth.verifica('carlone1'), 'Carlo doveva entrare prima');

  // Ambiente esplicito e VUOTO di destinazioni: nessuna copia esce da questa cartella temporanea.
  applica(pianifica({
    AMR_ADMIN_PASSWORD: PW.admin,
    AMR_UTENTE_01: `Anna Bianchi:${PW.anna}`,
    AMR_UTENTE_02: `Bruno Verdi:${PW.bruno}:piena`,
  }), {});

  assert.deepStrictEqual(auth.verifica(PW.admin), { id: 'owner', nome: 'proprietario', ruolo: 'full' });
  assert.strictEqual(auth.verifica(PW.anna).ruolo, 'demo');
  assert.strictEqual(auth.verifica(PW.bruno).ruolo, 'full');
  assert.strictEqual(auth.verifica(PW.anna).id, 'anna-bianchi', "nel registro accessi finisce CHI e' entrato");

  assert.strictEqual(auth.verifica('vecchia8'), null, 'la vecchia password del proprietario doveva morire');
  assert.strictEqual(auth.verifica('carlone1'), null, "Carlo non e' nel .env: non deve piu' entrare");
  assert.strictEqual(auth.verifica(PW.demo), null, 'la password demo condivisa doveva essere ritirata');

  // E una seconda passata che toglie Bruno lo toglie davvero (lo specchio vale ogni volta).
  applica(pianifica({ AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}` }), {});
  assert.strictEqual(auth.verifica(PW.bruno), null, 'Bruno e\' sparito dal .env: non deve piu\' entrare');
  assert.ok(auth.verifica(PW.anna), 'Anna c\'e\' ancora e deve continuare a entrare');
});

// ── 3. Le copie di auth.json restano allineate ──────────────────────────────

test('la suite non puo\' scrivere sulle macchine vere', () => {
  // La regola: nessun test deve poter toccare le credenziali di una macchina in uso. E' gia'
  // successo — un `node --test` ha riscritto la cartella Electron dell'iMac e, via scp, il Mac
  // di papa', chiudendo fuori tutti da entrambe.
  //
  // Ripulire process.env NON e' la difesa: dotenv lo rimette al primo `require` che lo chiama
  // (server.js lo fa in cima, e un test qui sopra lo carica). L'unica garanzia che regge e'
  // che applica() PRETENDA un ambiente esplicito invece di ricadere su quello globale.
  assert.throws(() => applica({ admin: PW.admin, voci: [] }), /serve l'ambiente/,
    'applica() senza ambiente deve fermarsi, non ricadere su process.env');
  assert.throws(() => applica({ admin: PW.admin, voci: [] }, null), /serve l'ambiente/);
  assert.deepStrictEqual(destinazioni({}), [], 'un ambiente vuoto non deve produrre destinazioni');

  // E importare il modulo non deve riversare il .env addosso a chi lo importa.
  const src = fs.readFileSync(path.join(RADICE, 'scripts', 'utenti-da-env.js'), 'utf8');
  const primaDiExports = src.slice(0, src.indexOf('function principale'));
  assert.ok(!/^require\('dotenv'\)\.config|^\s*require\('dotenv'\)\.config/m.test(primaDiExports),
    'dotenv viene chiamato al caricamento del modulo: chi lo importa si ritrova il .env vero in process.env');
});

test('utenti-da-env: l\'elenco delle altre copie si legge da una riga sola', () => {
  const d = destinazioni({
    AMR_AUTH_ANCHE: '/tmp/uno,  /tmp/due  \n massimo@10.0.0.1:/percorso/tre , ,  ',
  });
  assert.deepStrictEqual(d.map(x => x.dove), ['/tmp/uno', '/tmp/due', 'massimo@10.0.0.1:/percorso/tre']);
  assert.deepStrictEqual(d.map(x => x.remota), [false, false, true],
    'utente@host:/percorso deve essere riconosciuto come remoto, un percorso semplice no');
  assert.deepStrictEqual(destinazioni({}), [], 'senza la chiave non ci sono altre copie');
});

test('utenti-da-env: una destinazione irraggiungibile ferma tutto PRIMA di scrivere', () => {
  // La regola vale anche qui: meglio non cambiare niente che allineare due macchine su tre
  // e lasciare la terza con le password vecchie — e' il guaio che questa funzione previene.
  const env = { AMR_AUTH_ANCHE: '/questa/cartella/non/esiste/di/sicuro' };
  assert.throws(() => verificaDestinazioni(destinazioni(env), env), /non esiste/);

  auth.setPassword('primadi8');
  const prima = fs.readFileSync(path.join(process.env.USER_DATA_PATH, 'auth.json'), 'utf8');
  assert.throws(() => applica(pianifica({ AMR_ADMIN_PASSWORD: PW.admin }), env), /non esiste/);
  assert.strictEqual(fs.readFileSync(path.join(process.env.USER_DATA_PATH, 'auth.json'), 'utf8'), prima,
    'auth.json e\' stato riscritto nonostante una destinazione irraggiungibile');
  assert.ok(auth.verifica('primadi8'), 'la password di prima doveva restare valida');

  // Un file al posto di una cartella e' lo stesso errore, e va detto lo stesso.
  const finto = path.join(os.tmpdir(), `amr-non-cartella-${process.pid}`);
  fs.writeFileSync(finto, 'x');
  assert.throws(() => verificaDestinazioni(destinazioni({ AMR_AUTH_ANCHE: finto }), {}), /non e' una cartella/);
  fs.unlinkSync(finto);
});

test('utenti-da-env: applicare allinea davvero le altre copie', () => {
  const altra = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-copia-'));
  const env = { AMR_AUTH_ANCHE: altra };
  const esito = applica(pianifica({ AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}` }), env);

  assert.deepStrictEqual(esito.copie, [{ dove: altra, esito: 'copiato' }]);
  const qui = fs.readFileSync(esito.file, 'utf8');
  const la = fs.readFileSync(path.join(altra, 'auth.json'), 'utf8');
  assert.strictEqual(la, qui, 'la copia non e\' identica all\'originale: due macchine, due verita\'');

  // E una copia che fallisce va DETTA, non ingoiata: una macchina rimasta indietro accetta
  // ancora le password che credi di aver ritirato.
  fs.rmSync(altra, { recursive: true, force: true });
  const dopo = copiaAltrove(esito.file, [{ dove: altra, remota: false }], {});
  assert.ok(dopo[0].esito.startsWith('FALLITA'), 'una copia impossibile deve risultare fallita, non riuscita');
});

test('auth: il minimo di lunghezza vale per tutte e tre le porte', () => {
  const corta = 'a'.repeat(auth.MIN_LEN - 1);
  const giusta = 'b'.repeat(auth.MIN_LEN);
  assert.throws(() => auth.setPassword(corta), /minimo/, 'proprietario');
  assert.throws(() => auth.setDemoPassword(corta), /minimo/, 'demo condivisa');
  assert.throws(() => auth.setPersona('Dario Rossi', corta), /minimo/, 'persona');
  // Il confine e' incluso: MIN_LEN caratteri devono bastare, altrimenti il messaggio mente.
  assert.doesNotThrow(() => auth.setPassword(giusta));
});

test('auth: "owner" e "demo" restano riservati, e i nomi diversi danno id diversi', () => {
  assert.throws(() => auth.setPersona('owner', 'qualcosa1'), /riservat/);
  assert.throws(() => auth.setPersona('Demo', 'qualcosa1'), /riservat/);
  assert.strictEqual(auth.idDaNome('Anna Bianchi'), 'anna-bianchi');
  assert.strictEqual(auth.idDaNome('  ANNA   BIANCHI  '), 'anna-bianchi', 'spazi e maiuscole non fanno due persone');
  assert.strictEqual(auth.idDaNome('Nicolò Perù'), 'nicolo-peru', 'gli accenti non devono sparire in un id vuoto');
});
