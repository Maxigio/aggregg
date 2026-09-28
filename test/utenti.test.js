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
  const app = require('../scripts/build-frontend').frontendSourceSync().js;
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

test('sola lettura: Auto e Moto restano disponibili', () => {
  const html = sorgente('frontend', 'index.html');
  for (const m of ['auto', 'moto']) assert.ok(html.includes(`data-mode="${m}"`));
  for (const m of ['ricambi', 'competitor']) assert.ok(!html.includes(`data-mode="${m}"`));
});

// ── 2. L'elenco delle persone si controlla prima di scriverlo ────────────────

const PW = { admin: 'proprie8', anna: 'annaseg1', bruno: 'brunose1', demo: 'provademo2026', chiara: 'chiaraweb1' };

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

test('utenti-da-env: una password gia\' VIVA ferma tutto prima di scrivere, e dice quale riga', () => {
  // `pianifica` confronta le password solo FRA le voci del .env: contro auth.json non guardava
  // nessuno, e la collisione la lanciava `setPersona` a giro iniziato — col secret gia'
  // rigenerato (tutti fuori per niente), meta' elenco riscritto, la demo condivisa che si
  // voleva ritirare ancora valida e le altre macchine ferme alle credenziali vecchie.
  for (const p of auth.persone()) auth.togliPersona(p.id);
  auth.setPassword('vecchia9');
  auth.setDemoPassword(PW.demo);
  auth.setPersona('Anna Bianchi', PW.anna, 'demo');
  const tokenPrima = auth.makeToken('full', 'owner');

  // Carla prende la password che finora era della demo condivisa: la demo sarebbe ritirata,
  // ma solo a fine giro.
  assert.throws(() => applica(pianifica({
    AMR_ADMIN_PASSWORD: PW.admin,
    AMR_UTENTE_01: `Anna Bianchi:${PW.anna}`,
    AMR_UTENTE_02: `Carla Rossi:${PW.demo}`,
    AMR_UTENTE_03: `Bruno Verdi:${PW.bruno}`,
  }), {}), /AMR_UTENTE_02/, "l'errore deve dire QUALE riga del .env: chi legge ce l'ha davanti");

  assert.ok(auth.verifica('vecchia9'), 'la password del proprietario e\' stata riscritta a meta\' giro');
  assert.strictEqual(auth.checkToken(tokenPrima), 'full', 'il secret e\' stato rigenerato: tutti buttati fuori per niente');
  assert.deepStrictEqual(auth.persone().map(p => p.id), ['anna-bianchi'], 'qualcuno e\' stato scritto lo stesso');
  assert.ok(auth.verifica(PW.demo), 'la demo condivisa doveva restare com\'era: il giro non e\' partito');

  // Stesso guaio correggendo un refuso nel NOME e lasciando la password: l'id nuovo non e'
  // escluso dal confronto, quindi la persona collide con se stessa — e senza controllo prima
  // fallirebbe a ogni giro, buttando fuori tutti ogni volta.
  assert.throws(() => applica(pianifica({
    AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchii:${PW.anna}`,
  }), {}), /AMR_UTENTE_01/);
  assert.ok(auth.verifica('vecchia9'), 'niente scritto e nessuno buttato fuori, nemmeno al secondo tentativo');
  assert.strictEqual(auth.checkToken(tokenPrima), 'full');

  // E lo specchio normale deve continuare a girare: la stessa persona con la SUA password non
  // e' una collisione, altrimenti il controllo nuovo bloccherebbe ogni giro.
  applica(pianifica({ AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}` }), {});
  assert.ok(auth.verifica(PW.admin), 'il giro senza collisioni deve arrivare in fondo');
  assert.strictEqual(auth.verifica(PW.demo), null, 'e ritirare la demo condivisa, come sempre');
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

  assert.deepStrictEqual(esito.copie, [{ dove: altra, esito: 'copiato', web: [] }]);
  const qui = fs.readFileSync(esito.file, 'utf8');
  const la = fs.readFileSync(path.join(altra, 'auth.json'), 'utf8');
  assert.strictEqual(la, qui, 'la copia non e\' identica all\'originale: due macchine, due verita\'');

  // E una copia che fallisce va DETTA, non ingoiata: una macchina rimasta indietro accetta
  // ancora le password che credi di aver ritirato.
  fs.rmSync(altra, { recursive: true, force: true });
  const dopo = copiaAltrove(esito.file, [{ dove: altra, remota: false }], {});
  assert.ok(dopo[0].esito.startsWith('FALLITA'), 'una copia impossibile deve risultare fallita, non riuscita');
});

test('utenti-da-env: la copia NON cancella chi si e\' registrato sull\'altra macchina', () => {
  // L'M2 e' il server: `richieste.js --approva` gira li', quindi chi nasce da un invito esiste
  // solo nel SUO auth.json. Questo script gira sull'iMac, dove quelle voci non ci sono mai
  // state: la copia secca le toglieva tutte, e i loro dati restavano nel magazzino di la' —
  // `utenti-db.revocato` da allora considera l'id bruciato, quindi nemmeno ri-registrabile.
  const altra = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-m2-'));
  const qui = process.env.USER_DATA_PATH;
  const dentroAltra = fn => {
    process.env.USER_DATA_PATH = altra;
    try { return fn(); } finally { process.env.USER_DATA_PATH = qui; }
  };
  dentroAltra(() => {
    auth.setPassword(PW.admin);
    auth.creaPersona('Chiara Web', PW.chiara, 'demo', 'web');
    assert.ok(auth.verifica(PW.chiara), 'preparazione: di la\' Chiara deve entrare');
  });

  const env = { AMR_AUTH_ANCHE: altra };
  const esito = applica(pianifica({ AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}` }), env);
  assert.deepStrictEqual(esito.copie, [{ dove: altra, esito: 'copiato', web: ['chiara-web'] }],
    'il resoconto deve dire chi e\' stato salvato di la\': letto qui, l\'elenco dei web e\' sempre vuoto');

  const la = JSON.parse(fs.readFileSync(path.join(altra, 'auth.json'), 'utf8'));
  assert.deepStrictEqual(la.persone.map(p => p.id).sort(), ['anna-bianchi', 'chiara-web'],
    'la copia ha cancellato dall\'altra macchina chi si era registrato dal web');
  // Non basta che l'id ci sia: la voce va portata intera, salt e hash compresi.
  dentroAltra(() => assert.ok(auth.verifica(PW.chiara), 'Chiara non entra piu\': la sua voce e\' arrivata di la\' rotta'));

  // E un auth.json di la' che non si legge NON si sovrascrive: potrebbe avere accessi che qui
  // non si vedono, e darlo per vuoto e' esattamente il guaio di sopra.
  fs.writeFileSync(path.join(altra, 'auth.json'), '{ rotto');
  const rifiuto = copiaAltrove(esito.file, [{ dove: altra, remota: false }], {});
  assert.ok(rifiuto[0].esito.startsWith('FALLITA'), 'un file illeggibile e\' un sospetto, non un file vuoto');
  assert.strictEqual(fs.readFileSync(path.join(altra, 'auth.json'), 'utf8'), '{ rotto');

  fs.rmSync(altra, { recursive: true, force: true });
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

test('auth: se la cartella delle credenziali sparisce, il cancello si CHIUDE', () => {
  // Il guasto vero: AMR gira da un volume esterno (o con USER_DATA_PATH su una cartella che
  // non c'e' piu'). Il processo e' gia' in piedi e continua a servire, ma auth.json non si
  // raggiunge. ENOENT e' lo STESSO codice di "nessuna password impostata": confonderli faceva
  // rispondere 'assente', e 'assente' vuol dire "app locale aperta", cioe' ogni rotta senza
  // cookie su una macchina pubblicata su internet.
  const vecchio = process.env.USER_DATA_PATH;
  try {
    process.env.USER_DATA_PATH = path.join(os.tmpdir(), `amr-volume-smontato-${process.pid}`);
    assert.ok(!fs.existsSync(process.env.USER_DATA_PATH), 'la cartella non deve esistere: e\' il punto della prova');

    assert.strictEqual(auth.stato(), 'illeggibile',
      'cartella sparita = guasto, non "nessuna password": con \'assente\' il middleware apre tutto');
    assert.strictEqual(auth.isEnabled(), true,
      'isEnabled() deve restare vero: il cancello c\'e\', e\' solo irraggiungibile');
    assert.strictEqual(auth.verifica('qualunque8'), null, 'nessuna password puo\' valere se il file non si legge');
    assert.deepStrictEqual(auth.persone(), [], 'nessuna persona, ma per guasto — non perche\' non ce ne sono');
    assert.strictEqual(auth.makeToken('full', 'owner'), null, 'non si firma niente senza il secret');

    // E chi SCRIVE si ferma invece di ricreare il file altrove con dentro solo la voce nuova.
    assert.throws(() => auth.setPassword('nuovapw1'), /non si legge/);
    assert.throws(() => auth.setPersona('Anna Bianchi', 'annaseg1'), /non si legge/);
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }

  // Il caso legittimo resta legittimo: cartella che c'e', file che non c'e' = nessuna password.
  const vuota = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-senza-auth-'));
  try {
    process.env.USER_DATA_PATH = vuota;
    assert.strictEqual(auth.stato(), 'assente', 'una cartella vuota e\' una configurazione, non un guasto');
    assert.strictEqual(auth.isEnabled(), false);
  } finally {
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    fs.rmSync(vuota, { recursive: true, force: true });
  }
});

test('auth: "owner" e "demo" restano riservati, e i nomi diversi danno id diversi', () => {
  assert.throws(() => auth.setPersona('owner', 'qualcosa1'), /riservat/);
  assert.throws(() => auth.setPersona('Demo', 'qualcosa1'), /riservat/);
  assert.strictEqual(auth.idDaNome('Anna Bianchi'), 'anna-bianchi');
  assert.strictEqual(auth.idDaNome('  ANNA   BIANCHI  '), 'anna-bianchi', 'spazi e maiuscole non fanno due persone');
  assert.strictEqual(auth.idDaNome('Nicolò Perù'), 'nicolo-peru', 'gli accenti non devono sparire in un id vuoto');
});

// ── 4. La porta di chi arriva da fuori ───────────────────────────────────────

test('creaPersona: un nome gia\' in uso non si sovrascrive — nemmeno scritto in un\'altra grafia', () => {
  auth.setPassword(PW.admin);
  auth.setPersona('Mario Rossi', 'mariorossi1', 'demo');
  assert.ok(auth.verifica('mariorossi1'), 'partenza: Mario esiste ed entra');

  // setPersona SOVRASCRIVE ed e' giusto cosi' per lo script del .env (cambiare una password e'
  // il suo mestiere). Dalla porta pubblica sarebbe una presa di controllo.
  for (const grafia of ['Mario Rossi', 'mario  rossi', 'MARIO.ROSSI', 'Marió Rossì', 'Mario_Rossi']) {
    assert.throws(() => auth.creaPersona(grafia, 'altrapw1'), e => e.code === 'NOME_OCCUPATO',
      `"${grafia}" da' lo stesso id di Mario Rossi e deve essere respinta`);
  }
  assert.ok(auth.verifica('mariorossi1'), 'la password di Mario doveva restare quella di prima');
  assert.strictEqual(auth.verifica('altrapw1'), null, 'la password dell\'impostore non deve valere niente');
});

test('creaPersona: una password gia\' in uso e\' un\'altra identita\', e si rifiuta', () => {
  auth.setPassword(PW.admin);
  auth.setPersona('Anna Bianchi', PW.anna, 'demo');

  // `verifica` torna il PRIMO match: chi entrasse col doppione verrebbe scambiato per l'altro.
  assert.throws(() => auth.creaPersona('Carla Neri', PW.anna), e => e.code === 'PASSWORD_OCCUPATA');
  assert.throws(() => auth.creaPersona('Carla Neri', PW.admin), e => e.code === 'PASSWORD_OCCUPATA',
    'vale anche contro la password del proprietario');
  // E il messaggio non dice CON CHI ha fatto collisione: sarebbe un oracolo sulle altrui password.
  try { auth.creaPersona('Carla Neri', PW.anna); } catch (e) {
    assert.ok(!/anna/i.test(e.message), `il messaggio nomina l'altra persona: ${e.message}`);
  }
  assert.strictEqual(auth.verifica(PW.anna).id, 'anna-bianchi', 'Anna resta lei');
});

test('setPersona: la password di un altro non si assegna, nemmeno dal .env', () => {
  // Il buco misurato: `creaPersona` (la porta del web) rifiutava il doppione, `setPersona` no —
  // e lo specchio del .env confronta le password solo FRA le voci del .env, mentre chi si e'
  // iscritto dal web sopravvive allo specchio e resta DAVANTI in cfg.persone (setPersona
  // rimuove-e-ri-accoda). Aggiungere al .env la password di un iscritto non dava nessun errore,
  // e chi entrava col doppione diventava LUI: stessi salvataggi, stessa quota, stesso registro.
  for (const p of auth.persone()) auth.togliPersona(p.id);
  auth.setPassword(PW.admin);
  auth.creaPersona('Luca Bianchi', 'segreto12345');   // iscritto dal sito, origine 'web'

  assert.throws(() => auth.setPersona('Giovanni Verdi', 'segreto12345', 'full'),
    e => e.code === 'PASSWORD_OCCUPATA', 'la voce del .env si prendeva l\'identita\' di Luca');
  assert.strictEqual(auth.persone().find(p => p.id === 'giovanni-verdi'), undefined,
    'rifiutata ma scritta lo stesso');
  assert.strictEqual(auth.verifica('segreto12345').id, 'luca-bianchi', 'Luca resta Luca');
  assert.strictEqual(auth.verifica('segreto12345').ruolo, 'demo', 'e non eredita il ruolo del .env');

  // Vale anche per il proprietario e per l'ospite condiviso: `verifica` prova salt/hash del
  // proprietario PER PRIMI, quindi un AMR_ADMIN_PASSWORD uguale a quello di un iscritto faceva
  // di quell'iscritto il proprietario — /api/logs compreso — senza che facesse niente.
  assert.throws(() => auth.setPassword('segreto12345'), e => e.code === 'PASSWORD_OCCUPATA');
  assert.throws(() => auth.setDemoPassword('segreto12345'), e => e.code === 'PASSWORD_OCCUPATA');
  assert.strictEqual(auth.verifica('segreto12345').id, 'luca-bianchi');

  // Ma lo specchio del .env deve continuare a girare: riscrivere la STESSA persona con la SUA
  // password di sempre non e' una collisione, altrimenti utenti-da-env fallirebbe a ogni giro.
  assert.doesNotThrow(() => auth.setPersona('Luca Bianchi', 'segreto12345', 'demo'));
  assert.strictEqual(auth.verifica('segreto12345').id, 'luca-bianchi');

  auth.togliPersona('luca-bianchi');
});

test('creaPersona: nasce demo, marcata "web", e la marcatura sopravvive al cambio password', () => {
  auth.setPassword(PW.admin);
  const nata = auth.creaPersona('Chiara Web', 'chiaraw1');
  assert.deepStrictEqual([nata.id, nata.ruolo], ['chiara-web', 'demo'], 'chi si registra guarda e basta');

  const c = auth.persone().find(p => p.id === 'chiara-web');
  assert.strictEqual(c.origine, 'web');
  // Cambiare la password non deve scollegarla dalla sua provenienza: senza, il primo reset la
  // farebbe sembrare una voce del .env e il giro dopo la cancellerebbe.
  auth.setPersona('Chiara Web', 'chiaraw2', 'demo');
  assert.strictEqual(auth.persone().find(p => p.id === 'chiara-web').origine, 'web');
  assert.strictEqual(auth.persone().find(p => p.id === 'chiara-web').ruolo, 'demo');

  assert.throws(() => auth.creaPersona('Owner', 'qualcosa1'), /riservat/);
  assert.throws(() => auth.creaPersona('Demo', 'qualcosa1'), /riservat/);
});

// ── 5. Due processi sullo stesso auth.json ───────────────────────────────────

test('auth: chi scrive aspetta il lock di un altro processo, e un lock stantio non blocca', () => {
  // Il server vivo e gli script via ssh fanno entrambi load() → modifica → riscrittura
  // dell'INTERO auth.json. La serializzazione e' un lock file esclusivo accanto ad
  // auth.json: qui si prova che chi scrive lo RISPETTA davvero — cioe' aspetta finche' un
  // altro processo non lo molla — e che il lock di un processo morto a meta' non chiude
  // fuori tutti per sempre.
  const { spawn } = require('node:child_process');
  auth.setPassword(PW.admin);
  auth.setPersona('Piero Lock', 'pierolock1', 'demo');
  const lock = path.join(process.env.USER_DATA_PATH, 'auth.json.lock');

  // Lock stantio (processo morto): si toglie da soli e si scrive, senza aspettare 5 secondi.
  fs.writeFileSync(lock, '');
  const morto = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lock, morto, morto);
  assert.strictEqual(auth.setPersona('Piero Lock', 'pierolock2', 'demo').id, 'piero-lock');
  assert.ok(!fs.existsSync(lock), 'il lock stantio doveva sparire dopo la scrittura');

  // Lock FRESCO di un altro processo: la scrittura deve ASPETTARE che venga mollato.
  // Il rilascio arriva da un processo figlio, perche' l'attesa qui e' sincrona: un timer
  // nello stesso processo non scatterebbe mai.
  fs.writeFileSync(lock, '');
  const figlio = spawn(process.execPath, ['-e',
    `setTimeout(() => { try { require('node:fs').unlinkSync(${JSON.stringify(lock)}) } catch {} }, 250)`,
  ], { stdio: 'ignore' });
  figlio.unref();
  const prima = Date.now();
  assert.strictEqual(auth.setPersona('Piero Lock', 'pierolock3', 'demo').id, 'piero-lock');
  assert.ok(Date.now() - prima >= 150,
    'la scrittura non ha aspettato il lock: due processi possono di nuovo cancellarsi le modifiche a vicenda');
  assert.ok(!fs.existsSync(lock), 'il lock proprio doveva essere rilasciato a fine scrittura');
});

test('utenti-da-env: lo specchio del .env non cancella chi si e\' registrato dal web', () => {
  auth.setPassword(PW.admin);
  for (const p of auth.persone()) auth.togliPersona(p.id);   // la prova parte da un elenco suo
  auth.creaPersona('Chiara Web', 'chiaraw1');
  auth.setPersona('Dario Env', 'darioenv1', 'demo');   // c'era per via del .env, ma nel .env non c'e' piu'

  const esito = applica(pianifica({ AMR_ADMIN_PASSWORD: PW.admin, AMR_UTENTE_01: `Anna Bianchi:${PW.anna}` }), {});

  assert.deepStrictEqual(esito.tolti, ['dario-env'], 'chi viene dal .env e non ci sta piu\' esce, come sempre');
  assert.deepStrictEqual(esito.daWeb, ['chiara-web'], 'chi si e\' registrato dal web va detto, non tolto in silenzio');
  assert.ok(auth.verifica('chiaraw1'), 'Chiara e\' entrata da un\'altra porta: il .env non e\' il suo elenco');
  assert.strictEqual(auth.verifica('darioenv1'), null);
  assert.ok(auth.verifica(PW.anna));
});
