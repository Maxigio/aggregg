/**
 * Auth opzionale per esposizione pubblica (Tailscale Funnel).
 *
 * Dependency-free (solo `crypto`). Si attiva SOLO se è stata impostata una
 * password (`auth.json` presente): senza, l'app resta aperta in locale come
 * prima. Quando attiva, protegge TUTTE le rotte (nessuna scorciatoia loopback:
 * Funnel proxa a 127.0.0.1, indistinguibile dal desktop → la chiave a tutti).
 *
 * Storage: <USER_DATA_PATH>/auth.json (Electron) o data/ (dev) — stesso pattern
 * di saved.js. Contenuto: { salt, hash, secret }.
 *   - hash   = scrypt(password, salt)         → verifica password
 *   - secret = 32B random                     → firma HMAC del cookie di sessione
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'auth.json';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // cookie valido 30 giorni
// Otto, non dieci: deciso dal proprietario il 2026-08-03. Regge perche' il login non e'
// esposto a tentativi illimitati — postLogin (server.js) conta i fallimenti per IP, dorme
// 1s a ogni errore e dopo LOCK_MAX=8 chiude per LOCK_MS=10 minuti: ~1150 prove al giorno
// per indirizzo, che su 8 caratteri non basta a esaurire niente. Se un giorno quel freno
// sparisse, questo numero va rialzato insieme.
const MIN_LEN = 8;
const ROLES = new Set(['full', 'demo']);   // 'full' = papà; 'demo' = ospite read-only

function filePath() {
  const userData = process.env.USER_DATA_PATH;
  if (userData && fs.existsSync(userData)) return path.join(userData, FILE);
  return path.join(__dirname, '..', 'data', FILE);
}

// "Il file non c'e'" e "il file c'e' ma non si legge" sono due cose diverse, e
// confonderle apre il cancello: senza distinzione un file troncato per un istante
// (writeFileSync di set-password), un EMFILE o un volume smontato valevano
// "nessuna password impostata", cioe' next() su ogni rotta. Chi non si legge si
// chiude: ILLEGGIBILE tiene acceso il cancello e non lascia entrare nessuno.
const ILLEGGIBILE = Symbol('auth-illeggibile');

/**
 * LA CARTELLA CHE DOVREBBE CONTENERE auth.json E' ANCORA LI'?
 *
 * "Il file non c'e'" e "il posto dove sta non c'e' piu'" erano la stessa cosa, e non lo sono:
 * il primo e' una configurazione (nessuna password impostata, app locale aperta), il secondo
 * e' un GUASTO. Il volume esterno che si smonta sotto un processo gia' in piedi — macOS toglie
 * il mountpoint da /Volumes e il percorso smette di risolvere — da' ENOENT, lo stesso codice
 * di un file mancante. Misurato: readFileSync('/Volumes/NONESISTE/data/auth.json') → ENOENT.
 * Confonderli APRIVA il cancello invece di chiuderlo: stato() rispondeva 'assente' e il
 * middleware faceva passare ogni rotta senza cookie, su una macchina pubblicata da Funnel.
 * La guardia d'avvio controlla solo al boot; a runtime qui non c'era niente.
 *
 * Il caso USER_DATA_PATH va guardato PRIMA di leggere, non nel catch: con la cartella sparita
 * filePath() ricade su data/, quel file esiste, e la lettura riesce — su un ALTRO auth.json,
 * cioe' altre credenziali, senza dirlo a nessuno.
 */
function baseSparita() {
  const ud = process.env.USER_DATA_PATH;
  if (ud && !fs.existsSync(ud)) return true;
  try { fs.accessSync(path.dirname(filePath())); return false; } catch { return true; }
}

// Un file gia' letto correttamente non puo' trasformarsi a runtime in "nessuna
// password impostata": potrebbe essere stato cancellato o il volume potrebbe
// aver perso soltanto quel file. L'identita' del percorso evita di contaminare
// le installazioni di prova che usano USER_DATA_PATH diversi nello stesso processo.
const configurati = new Set();
function load() {
  if (baseSparita()) return ILLEGGIBILE;
  const p = filePath();
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Un file presente ma senza credenziali valide non equivale a un file assente.
    if (!cfg || Array.isArray(cfg) || typeof cfg !== 'object'
        || !cfg.salt || typeof cfg.salt !== 'string'
        || !cfg.hash || typeof cfg.hash !== 'string'
        || !cfg.secret || typeof cfg.secret !== 'string') return ILLEGGIBILE;
    configurati.add(p);
    return cfg;
  }
  catch (e) { return (e && e.code === 'ENOENT' && !configurati.has(p)) ? null : ILLEGGIBILE; }
}

// La configurazione c'e' ed e' utilizzabile. Il sentinella non lo e': ogni
// funzione che tocca salt/secret deve fermarsi qui invece di leggere undefined.
const leggibile = cfg => Boolean(cfg) && cfg !== ILLEGGIBILE;

// Scrittura atomica: senza, la finestra in cui il file e' troncato esiste
// davvero, e ogni lettura che ci cade dentro e' un 401 per tutti.
// Il nome del tmp porta il pid: due processi con lo stesso tmp fisso si
// pestavano anche il rename (uno dei due prendeva ENOENT).
function scriviAtomico(p, dati) {
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(dati, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * UNA SCRITTURA ALLA VOLTA, FRA PROCESSI.
 *
 * scriviAtomico protegge dal file TRONCATO, non dall'aggiornamento PERSO: ogni modifica e'
 * un read-modify-write dell'INTERO file, e sull'M2 gli scrittori sono processi diversi —
 * il server vivo (creaPersona da un invito) e gli script via ssh (set-telefono, set-password,
 * utenti-da-env). Senza mutua esclusione, chi scrive per ultimo cancella in silenzio la
 * modifica dell'altro: misurato, il telefono appena assegnato dallo script spariva sotto la
 * creaPersona del server. Il lock e' un file creato in esclusiva (flag 'wx') accanto ad
 * auth.json: chi lo trova occupato aspetta, chi lo trova stantio (processo morto a meta',
 * le sezioni critiche durano ~200ms di scryptSync) lo toglie e riprova. Dentro lo stesso
 * processo le funzioni sono sincrone, quindi non serve rientranza: la creaPersona esportata
 * prende il lock una volta e al suo interno usa la setPersona nuda.
 */
const LOCK_ATTESA_MS  = 5000;    // oltre: errore chiaro, non un'attesa infinita
const LOCK_STANTIO_MS = 10000;   // un lock cosi' vecchio e' di un processo morto

// Sonno sincrono senza busy-loop: queste funzioni sono sincrone per contratto.
const dormi = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function conLock(fn) {
  // Base sparita: nessun lock da prendere — la funzione sotto si ferma gia' col suo errore,
  // e filePath() ricadrebbe su data/, cioe' il lock finirebbe accanto al file SBAGLIATO
  // (lo stesso inganno documentato in baseSparita).
  if (baseSparita()) return fn();
  const lock = filePath() + '.lock';
  const inizio = Date.now();
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STANTIO_MS) { fs.unlinkSync(lock); continue; }
      } catch {}   // sparito fra open e stat: liberato, si riprova
      if (Date.now() - inizio > LOCK_ATTESA_MS) {
        throw new Error(`${lock} occupato da troppo tempo: se nessun altro processo sta scrivendo, cancellalo e riprova.`);
      }
      dormi(25);
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lock); } catch {}
  }
}

function isEnabled() { return load() !== null; }

// Lo stato del cancello, per chi deve spiegarlo all'utente invece di rispondere
// "non autorizzato" a chi la password ce l'ha giusta:
//   'assente'     → nessuna password impostata, app locale aperta
//   'ok'          → configurazione leggibile
//   'illeggibile' → il file c'e' ma non si apre: si chiude tutto e si dice perche'
function stato() {
  const cfg = load();
  if (cfg === null) return 'assente';
  return cfg === ILLEGGIBILE ? 'illeggibile' : 'ok';
}

// Imposta/aggiorna la password principale (usato da scripts/set-password.js).
// Preserva le credenziali demo se già presenti (non cancellare demoSalt/demoHash);
// il secret viene rigenerato (cambio password → vecchie sessioni invalidate).
function setPassword(pw) {
  if (!pw || String(pw).length < MIN_LEN) {
    throw new Error(`Password troppo corta (minimo ${MIN_LEN} caratteri).`);
  }
  const cfg = load();
  // Sovrascrivere un file che non si e' riusciti a leggere cancellerebbe la
  // password demo e il resto senza accorgersene: meglio fermarsi.
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  // Il proprietario non e' esente: salt/hash suoi si provano PRIMA delle persone, quindi una
  // password gia' di un iscritto lo farebbe entrare come proprietario senza fare niente.
  if (chiUsaPassword(cfg, pw, 'owner')) throw erroreOccupata();
  const prev   = cfg || {};
  const salt   = crypto.randomBytes(16).toString('hex');
  const hash   = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const p = filePath();
  scriviAtomico(p, { ...prev, salt, hash, secret });
  return p;
}

// Imposta/aggiorna la password DEMO (ospite read-only). Read-modify-write: preserva
// salt/hash/secret principali → NON invalida la sessione di papà, ne' quelle delle persone
// con un nome. Gli ospiti gia' entrati invece SI', ed e' il motivo per cui la si cambia: il
// loro cookie e' firmato anche con demoHash (chiaveFirma), che qui diventa un altro.
function setDemoPassword(pw) {
  if (!pw || String(pw).length < MIN_LEN) {
    throw new Error(`Password demo troppo corta (minimo ${MIN_LEN} caratteri).`);
  }
  const cfg = load();
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
  if (chiUsaPassword(cfg, pw, 'demo')) throw erroreOccupata();
  cfg.demoSalt = crypto.randomBytes(16).toString('hex');
  cfg.demoHash = crypto.scryptSync(String(pw), cfg.demoSalt, 64).toString('hex');
  const p = filePath();
  scriviAtomico(p, cfg);
  return p;
}

/**
 * RITIRA la password demo condivisa. Si poteva impostare e non togliere: una password data
 * in giro una volta restava valida per sempre, e l'unico modo di chiuderla era riscrivere
 * auth.json a mano. Serve quando le persone hanno una password a testa (`persone`) e
 * l'ospite anonimo non deve piu' esistere.
 * @returns {boolean} true se c'era qualcosa da togliere.
 */
function togliDemoCondiviso() {
  const cfg = load();
  if (!leggibile(cfg)) return false;
  if (!cfg.demoSalt && !cfg.demoHash) return false;
  delete cfg.demoSalt;
  delete cfg.demoHash;
  scriviAtomico(filePath(), cfg);
  return true;
}

// Confronto scrypt timing-safe contro una coppia salt/hash (null-safe: se la
// credenziale non è impostata → false, niente scrypt su undefined).
function matchHash(pw, salt, hash) {
  if (!salt || !hash) return false;
  const got    = crypto.scryptSync(String(pw == null ? '' : pw), salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return got.length === stored.length && crypto.timingSafeEqual(got, stored);
}

/**
 * CHI USA GIA' QUESTA PASSWORD, o null. `esclusoId` e' chi la sta (ri)prendendo per se'.
 *
 * Due password uguali non sono due accessi: `verifica` torna il PRIMO match, quindi chi entra
 * col doppione viene scambiato per l'altro — id, dati salvati, quota giornaliera, riga nel
 * registro accessi. Vale in tutte le direzioni: il proprietario si prova PRIMA delle persone,
 * quindi una sua password gia' di un iscritto regalerebbe a quell'iscritto i poteri pieni.
 *
 * L'ESCLUSIONE NON E' UN DETTAGLIO: `scripts/utenti-da-env.js` rispecchia lo STESSO .env a ogni
 * giro, quindi senza di essa una persona riscritta con la sua password di sempre combacerebbe
 * con SE STESSA e lo specchio non girerebbe piu'.
 */
function chiUsaPassword(cfg, pw, esclusoId = null) {
  if (!leggibile(cfg)) return null;
  const escluso = esclusoId == null ? null : String(esclusoId);
  if (escluso !== 'owner' && matchHash(pw, cfg.salt, cfg.hash)) return 'owner';
  for (const p of cfg.persone || []) {
    if (String(p.id) === escluso) continue;
    if (matchHash(pw, p.salt, p.hash)) return String(p.id);
  }
  if (escluso !== 'demo' && matchHash(pw, cfg.demoSalt, cfg.demoHash)) return 'demo';
  return null;
}

/**
 * QUESTA PASSWORD E' GIA' DI QUALCUNO? Si'/no, mai di CHI: il nome sarebbe un oracolo sulle
 * password degli altri (vedi erroreOccupata), e chi chiede ha in mano il .env, non le password
 * di chi si e' iscritto dal sito.
 *
 * Esiste perche' `scripts/utenti-da-env.js` deve poterlo chiedere PRIMA di scrivere: prima
 * l'unico modo di scoprire la collisione era prendersela da `setPersona`, cioe' a giro gia'
 * iniziato. `esclusoId` e' chi la sta riprendendo per se' ('owner', 'demo' o un id di persona).
 */
function passwordOccupata(pw, esclusoId = null) {
  return Boolean(chiUsaPassword(load(), pw, esclusoId));
}

// Non si dice MAI con chi ha fatto collisione: sarebbe un oracolo sulle password degli altri.
function erroreOccupata() {
  const e = new Error('Questa password e\' gia\' in uso: scegline un\'altra.');
  e.code = 'PASSWORD_OCCUPATA';
  return e;
}

/**
 * CHI E' ENTRATO, non solo con che ruolo.
 *
 * Con una password sola per ruolo l'app non poteva distinguere due colleghi: la coda degli
 * avvisi, i limiti di richieste e il registro degli accessi parlavano tutti di "demo".
 * Adesso ogni persona ha la sua voce in `persone`, e quello che torna di qui e' un'identita'.
 *
 * Le vecchie credenziali restano valide come sono: chi ha gia' un auth.json non deve rifarlo.
 *
 * @returns {{id:string, nome:string, ruolo:'full'|'demo'}|null}
 */
function verifica(pw) {
  const cfg = load();
  if (!leggibile(cfg)) return null;
  if (matchHash(pw, cfg.salt, cfg.hash)) return { id: 'owner', nome: 'proprietario', ruolo: 'full' };
  for (const p of cfg.persone || []) {
    if (matchHash(pw, p.salt, p.hash)) {
      return { id: String(p.id), nome: p.nome || String(p.id), ruolo: p.ruolo === 'full' ? 'full' : 'demo' };
    }
  }
  // L'ospite condiviso di prima: resta, ma non ha un nome perche' non e' una persona.
  if (matchHash(pw, cfg.demoSalt, cfg.demoHash)) return { id: 'demo', nome: 'ospite', ruolo: 'demo' };
  return null;
}

// Compatibilita': il solo ruolo, come prima.
function verifyRole(pw) { const u = verifica(pw); return u ? u.ruolo : null; }

/**
 * Aggiunge o aggiorna una persona. L'id si ricava dal nome (minuscolo, senza accenti) ed e'
 * quello che finisce nel cookie e nel registro accessi. Il ruolo di default e' 'demo': un
 * collega guarda, e chi deve scrivere lo si dice esplicitamente.
 */
/**
 * L'identificativo che si ricava da un nome: e' quello che finisce nel cookie e nel registro
 * accessi. Esportato perche' chi prepara un elenco di persone (scripts/utenti-da-env.js) deve
 * poter scoprire PRIMA di scrivere che due nomi diversi danno lo stesso id, o che un nome
 * cade su una parola riservata — altrimenti se ne accorge a meta' scrittura, con qualcuno
 * gia' dentro auth.json e qualcun altro no.
 */
function idDaNome(nome) {
  return String(nome || '').trim().toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
const ID_RISERVATI = new Set(['owner', 'demo']);

function setPersona(nome, pw, ruolo = 'demo', origine = null) {
  const n = String(nome || '').trim();
  if (!n) throw new Error('Serve un nome.');
  if (!pw || String(pw).length < MIN_LEN) throw new Error(`Password troppo corta (minimo ${MIN_LEN} caratteri).`);
  const cfg = load();
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
  const id = idDaNome(n);
  if (!id) throw new Error('Il nome non produce un identificativo utilizzabile.');
  if (ID_RISERVATI.has(id)) throw new Error(`"${id}" e' riservato: usa un altro nome.`);
  // Il doppione si rifiuta PRIMA di scrivere, e vale per tutte le porte: qui passano lo script
  // del .env e `set-password.js`, che una guardia loro non ce l'hanno. Escluso questo id, se no
  // lo specchio del .env troverebbe ogni persona in collisione con se stessa (chiUsaPassword).
  if (chiUsaPassword(cfg, pw, id)) throw erroreOccupata();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const prima = (cfg.persone || []).find(p => String(p.id) === id);
  cfg.persone = (cfg.persone || []).filter(p => String(p.id) !== id);
  const voce = { id, nome: n, salt, hash, ruolo: ruolo === 'full' ? 'full' : 'demo' };
  // Il telefono (bot WhatsApp) sopravvive al cambio password: e' un attributo della persona,
  // non della credenziale — perderlo qui vorrebbe dire che ogni reset scollega il bot.
  if (prima && prima.telefono) voce.telefono = prima.telefono;
  // DA DOVE VIENE QUESTA PERSONA. 'web' = si e' registrata da sola ed e' stata approvata, quindi
  // NON sta nel .env. Serve a `scripts/utenti-da-env.js`, che rispecchia il .env e toglie chi non
  // ci sta scritto: senza questo campo, il primo giro di gestione utenti cancellerebbe tutti gli
  // iscritti dal web, lasciando i loro dati orfani nel magazzino. Come `telefono`, sopravvive al
  // cambio password: e' un attributo della persona, non della credenziale.
  const org = origine || (prima && prima.origine) || null;
  if (org) voce.origine = String(org);
  cfg.persone.push(voce);
  // Cambiare la password di una persona che C'ERA GIA' invalida anche la sua vecchia
  // sessione: il cookie e' firmato col secret, e il ricontrollo su id+ruolo non basta
  // (id e ruolo restano uguali). Prezzo: tutti rifanno il login, lo stesso che il giro
  // completo di utenti-da-env dichiara gia' normale. Una persona nuova non ha sessioni
  // da uccidere, e aggiungerla non butta fuori nessuno.
  if (prima) cfg.secret = crypto.randomBytes(32).toString('hex');
  scriviAtomico(filePath(), cfg);
  return { id, nome: n, ruolo: ruolo === 'full' ? 'full' : 'demo' };
}

/**
 * CREA una persona che non c'era. Non e' `setPersona` con un controllo in piu': e' la porta per
 * chi arriva da fuori, e le due cose che qui sono errori li' sono comportamenti normali.
 *
 *  1. `setPersona` SOVRASCRIVE la voce con lo stesso id. Va benissimo per lo script che
 *     rispecchia il .env (cambiare una password e' proprio il suo mestiere), ed e' una presa di
 *     controllo se il nome arriva da una registrazione pubblica: chi si fa chiamare come una
 *     persona che gia' c'e' le riscrive la password. E siccome sovrascrivere rigenera il
 *     `secret`, sarebbe anche un logout di tutti quanti.
 *  2. Due password uguali sono UNA identita': `verifica` torna il PRIMO match, quindi chi entra
 *     col doppione viene scambiato per l'altro — id, dati, quota, riga nel registro accessi. La
 *     guardia sta in `setPersona` (vale per tutte le porte, .env compreso) e torna
 *     PASSWORD_OCCUPATA: qui non se ne rifa' una seconda, che raddoppierebbe soltanto gli
 *     scrypt dentro il lock.
 *
 * Fra il controllo e la scrittura non c'e' nessun `await`: su un thread solo, il controllo e la
 * riga che nasce sono un gesto unico. Chi tocchera' questa funzione lo tenga.
 */
function creaPersona(nome, pw, ruolo = 'demo', origine = 'web') {
  const n = String(nome || '').trim();
  const id = idDaNome(n);
  if (!id) throw new Error('Il nome non produce un identificativo utilizzabile.');
  if (ID_RISERVATI.has(id)) throw new Error(`"${id}" e' riservato: usa un altro nome.`);
  const cfg = load();
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
  if ((cfg.persone || []).some(p => String(p.id) === id)) {
    const e = new Error(`Il nome "${n}" e' gia' in uso: scegline un altro.`);
    e.code = 'NOME_OCCUPATO';
    throw e;
  }
  if (!pw || String(pw).length < MIN_LEN) throw new Error(`Password troppo corta (minimo ${MIN_LEN} caratteri).`);
  return setPersona(n, pw, ruolo, origine);
}

/** Toglie una persona. Il suo cookie smette di valere al primo controllo. */
function togliPersona(idONome) {
  const q = String(idONome || '').trim().toLowerCase();
  const cfg = load();
  if (!leggibile(cfg)) return false;
  const prima = (cfg.persone || []).length;
  cfg.persone = (cfg.persone || []).filter(p => String(p.id).toLowerCase() !== q && String(p.nome || '').toLowerCase() !== q);
  if (cfg.persone.length === prima) return false;
  scriviAtomico(filePath(), cfg);
  return true;
}

/** Le persone registrate (senza nulla di segreto): per lo script di gestione e i log. */
function persone() {
  const cfg = load();
  if (!leggibile(cfg)) return [];
  return (cfg.persone || []).map(p => ({
    id: String(p.id), nome: p.nome || String(p.id),
    ruolo: p.ruolo === 'full' ? 'full' : 'demo',
    telefono: p.telefono || null,
    // Chi non ha origine viene dal .env: e' il caso di tutte le voci scritte prima che la
    // registrazione dal web esistesse, e non vanno trattate come iscritte da sole.
    origine: p.origine || null,
  }));
}

/**
 * LA CHIAVE CON CUI SI FIRMA — e per l'ospite condiviso non e' il solo `secret`.
 *
 * `checkSessione` riconfronta ogni cookie con l'elenco vivo, ma l'ospite anonimo in
 * `cfg.persone` non c'e': la sua unica voce viva e' la credenziale demo. Legando la sua firma
 * a `demoHash`, cambiare la password demo (`set-demo-password.js`) o ritirarla
 * (`togliDemoCondiviso`, quello che fa lo specchio del .env) uccide SUBITO i cookie gia'
 * emessi. Prima no: restavano buoni fino a TTL_MS, trenta giorni, e non esisteva nessun gesto
 * che chiudesse fuori un ospite gia' entrato. Rigenerare il `secret` avrebbe chiuso lo stesso
 * buco buttando pero' fuori anche papa' e i colleghi, che con l'ospite non c'entrano niente.
 *
 * Prezzo, una volta sola: i cookie demo firmati prima di questa riga non valgono piu'.
 */
function chiaveFirma(cfg, id) {
  return id === 'demo' ? `${cfg.secret}.${cfg.demoHash || ''}` : cfg.secret;
}

/**
 * Token cookie: "<exp>.<ruolo>.<id>.<hmac(chiaveFirma, exp.ruolo.id)>".
 *
 * Ruolo E identita' stanno DENTRO la firma: un ospite non puo' riscrivere il cookie per
 * diventare 'full', ne' per farsi passare per un collega — e l'id serve a dare a ognuno la
 * sua quota di richieste e il suo nome nel registro accessi.
 */
function makeToken(role = 'full', id = 'owner') {
  const cfg = load();
  if (!leggibile(cfg)) return null;
  if (!ROLES.has(role)) role = 'full';
  const uid = String(id || 'owner').replace(/[^A-Za-z0-9_-]/g, '') || 'owner';
  const exp = Date.now() + TTL_MS;
  const sig = crypto.createHmac('sha256', chiaveFirma(cfg, uid)).update(`${exp}.${role}.${uid}`).digest('hex');
  return `${exp}.${role}.${uid}.${sig}`;
}

/**
 * La SESSIONE dietro al cookie, o null: { ruolo, id }.
 *
 * Back-compat su tutte e tre le forme, perche' i cookie gia' emessi devono continuare a
 * valere: "<exp>.<sig>" (vecchissimo, full), "<exp>.<ruolo>.<sig>" (con il ruolo) e la forma
 * di oggi con l'identita' dentro la firma.
 */
function checkSessione(v) {
  const cfg = load();
  if (!leggibile(cfg) || !v) return null;
  const parts = String(v).split('.');
  let exp, role, id, sig, signed;
  if (parts.length === 2) {            // vecchio formato <exp>.<sig> = full
    [exp, sig] = parts; role = 'full'; id = 'owner'; signed = exp;
  } else if (parts.length === 3) {     // <exp>.<role>.<sig>
    [exp, role, sig] = parts; id = role === 'full' ? 'owner' : 'demo'; signed = `${exp}.${role}`;
    if (!ROLES.has(role)) return null;
  } else if (parts.length === 4) {     // <exp>.<role>.<id>.<sig>
    [exp, role, id, sig] = parts; signed = `${exp}.${role}.${id}`;
    if (!ROLES.has(role)) return null;
  } else {
    return null;
  }
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  const expect = crypto.createHmac('sha256', chiaveFirma(cfg, id)).update(signed).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // LA REVOCA REVOCA. Il ruolo firmato nel cookie e' una copia congelata di un permesso:
  // qui — l'unico punto da cui passa ogni richiesta — la si riconfronta con l'elenco vivo.
  // Senza, togliere una persona lasciava il suo cookie buono fino a 30 giorni, e un
  // declassamento full→demo restava full fino a scadenza, mentre due punti del repo
  // promettevano il contrario per iscritto. Costo: zero letture in piu' (il cfg e' quello
  // gia' caricato qui sopra). 'owner' e 'demo' non stanno in cfg.persone e restano fuori di
  // qui: 'owner' perche' cambiargli la password rigenera il secret, 'demo' perche' la sua
  // revoca passa dalla chiave di firma (chiaveFirma) — senza quella l'esenzione sarebbe un
  // buco, non una scorciatoia.
  if (id !== 'owner' && id !== 'demo') {
    const p = (cfg.persone || []).find(x => String(x.id) === String(id));
    if (!p || (p.ruolo === 'full' ? 'full' : 'demo') !== role) return null;
  }
  return { ruolo: role, id: String(id || 'owner') };
}

// Il solo ruolo, come prima: la maggior parte dei chiamanti vuole solo quello.
function checkToken(v) { const s = checkSessione(v); return s ? s.ruolo : null; }

// Chi RISCRIVE auth.json passa da conLock: il server e gli script sono processi diversi
// sullo stesso file (vedi il commento sul lock). Chi legge no — scriviAtomico garantisce
// che una lettura veda sempre un file intero.
module.exports = {
  isEnabled, stato,
  setPassword:        (...a) => conLock(() => setPassword(...a)),
  setDemoPassword:    (...a) => conLock(() => setDemoPassword(...a)),
  togliDemoCondiviso: (...a) => conLock(() => togliDemoCondiviso(...a)),
  setPersona:         (...a) => conLock(() => setPersona(...a)),
  creaPersona:        (...a) => conLock(() => creaPersona(...a)),
  togliPersona:       (...a) => conLock(() => togliPersona(...a)),
  persone, verifica, verifyRole, passwordOccupata, passwordOccupataIn: (cfg, pw) => Boolean(chiUsaPassword(cfg, pw)), makeToken, checkToken, checkSessione,
  idDaNome, ID_RISERVATI, MIN_LEN, TTL_MS,
};
