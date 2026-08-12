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

function load() {
  if (baseSparita()) return ILLEGGIBILE;
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); }
  catch (e) { return (e && e.code === 'ENOENT') ? null : ILLEGGIBILE; }
}

// La configurazione c'e' ed e' utilizzabile. Il sentinella non lo e': ogni
// funzione che tocca salt/secret deve fermarsi qui invece di leggere undefined.
const leggibile = cfg => Boolean(cfg) && cfg !== ILLEGGIBILE;

// Scrittura atomica: senza, la finestra in cui il file e' troncato esiste
// davvero, e ogni lettura che ci cade dentro e' un 401 per tutti.
function scriviAtomico(p, dati) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dati, null, 2));
  fs.renameSync(tmp, p);
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
  const prev   = cfg || {};
  const salt   = crypto.randomBytes(16).toString('hex');
  const hash   = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const secret = crypto.randomBytes(32).toString('hex');
  const p = filePath();
  scriviAtomico(p, { ...prev, salt, hash, secret });
  return p;
}

// Imposta/aggiorna la password DEMO (ospite read-only). Read-modify-write:
// preserva salt/hash/secret principali → NON invalida la sessione di papà.
function setDemoPassword(pw) {
  if (!pw || String(pw).length < MIN_LEN) {
    throw new Error(`Password demo troppo corta (minimo ${MIN_LEN} caratteri).`);
  }
  const cfg = load();
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
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
 *     col doppione viene scambiato per l'altro — id, dati, quota, riga nel registro accessi.
 *     Lo script del .env questo controllo ce l'ha gia' (`utenti-da-env.js`); qui serve lo stesso,
 *     perche' la password se la sceglie una persona che non sa quali sono gia' in uso. Non si
 *     dice MAI con chi ha fatto collisione: sarebbe un oracolo sulle password degli altri.
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
  if (verifica(pw)) {
    const e = new Error('Questa password e\' gia\' in uso: scegline un\'altra.');
    e.code = 'PASSWORD_OCCUPATA';
    throw e;
  }
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

// Sole cifre: "+39 352 072 7252" → "393520727252". Il confronto fra numeri e' sempre su
// questa forma, mai sulla stringa com'e' arrivata.
const soloCifre = s => String(s || '').replace(/\D/g, '');

/**
 * LA PERSONA DIETRO UN NUMERO WHATSAPP.
 *
 * Il bot riceve solo il numero del mittente: qui lo si trasforma in un'identita' — le stesse
 * voci di `persone` del login web, tramite il campo opzionale `telefono` (scripts/set-telefono.js).
 * Confronto per SUFFISSO (ultime 10 cifre, la lunghezza dei mobili italiani) dopo aver tolto
 * tutto cio' che non e' cifra: cosi' "+39 352 072 7252", "393520727252" e "00393520727252"
 * sono lo stesso numero, qualunque prefisso abbiano.
 *
 * @returns {{id:string, nome:string, ruolo:'full'|'demo'}|null}
 */
function personaDaTelefono(numero) {
  // "00" iniziale = prefisso di uscita internazionale (0039... ≡ +39...): via,
  // cosi' il confronto per intero funziona a prescindere da come e' scritto il numero.
  const cifre = soloCifre(numero).replace(/^00/, '');
  if (cifre.length < 9) return null;   // troppo corto per essere un numero vero: niente match "per coda"
  const coda = cifre.slice(-10);
  const cfg = load();
  if (!leggibile(cfg)) return null;
  for (const p of cfg.persone || []) {
    const tel = soloCifre(p.telefono).replace(/^00/, '');
    if (tel.length < 9) continue;
    // Se ENTRAMBI i lati hanno il prefisso internazionale (>=12 cifre) il match
    // e' sull'intera stringa: un numero estero con la stessa coda di 10 cifre
    // non puo' impersonare l'account. Se uno dei due e' senza prefisso, si
    // torna al confronto per coda (tolleranza +39/0039).
    const match = (tel.length >= 12 && cifre.length >= 12) ? tel === cifre : tel.slice(-10) === coda;
    if (match) {
      return { id: String(p.id), nome: p.nome || String(p.id), ruolo: p.ruolo === 'full' ? 'full' : 'demo' };
    }
  }
  return null;
}

/**
 * Assegna (o toglie, passando vuoto) il telefono WhatsApp di una persona.
 * Un numero identifica UNA persona: assegnarlo a due voci renderebbe ambigua l'identita'
 * che il bot ricava dal mittente, quindi il doppione (per suffisso) e' un errore.
 */
function setTelefono(idONome, telefono) {
  const q = String(idONome || '').trim().toLowerCase();
  if (!q) throw new Error('Serve il nome (o l\'id) della persona.');
  const cfg = load();
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
  const p = (cfg.persone || []).find(x => String(x.id).toLowerCase() === q || String(x.nome || '').toLowerCase() === q);
  if (!p) throw new Error(`Nessuna persona di nome o id "${idONome}" (scripts/set-password.js --elenco).`);
  const cifre = soloCifre(telefono);
  if (!cifre) {
    delete p.telefono;
  } else {
    if (cifre.length < 9) throw new Error('Numero troppo corto: servono almeno 9 cifre.');
    const coda = cifre.slice(-10);
    const doppione = (cfg.persone || []).find(x => x !== p && soloCifre(x.telefono).length >= 9 && soloCifre(x.telefono).slice(-10) === coda);
    if (doppione) throw new Error(`Quel numero e' gia' di ${doppione.nome || doppione.id}: un numero identifica UNA persona.`);
    p.telefono = cifre;   // salvato normalizzato (sole cifre), col prefisso com'e' arrivato
  }
  scriviAtomico(filePath(), cfg);
  return { id: String(p.id), nome: p.nome || String(p.id), ruolo: p.ruolo === 'full' ? 'full' : 'demo', telefono: p.telefono || null };
}

/**
 * Token cookie: "<exp>.<ruolo>.<id>.<hmac(secret, exp.ruolo.id)>".
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
  const sig = crypto.createHmac('sha256', cfg.secret).update(`${exp}.${role}.${uid}`).digest('hex');
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
  const expect = crypto.createHmac('sha256', cfg.secret).update(signed).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  // LA REVOCA REVOCA. Il ruolo firmato nel cookie e' una copia congelata di un permesso:
  // qui — l'unico punto da cui passa ogni richiesta — la si riconfronta con l'elenco vivo.
  // Senza, togliere una persona lasciava il suo cookie buono fino a 30 giorni, e un
  // declassamento full→demo restava full fino a scadenza, mentre due punti del repo
  // promettevano il contrario per iscritto. Costo: zero letture in piu' (il cfg e' quello
  // gia' caricato qui sopra). 'owner' e 'demo' non stanno in cfg.persone e restano fuori.
  if (id !== 'owner' && id !== 'demo') {
    const p = (cfg.persone || []).find(x => String(x.id) === String(id));
    if (!p || (p.ruolo === 'full' ? 'full' : 'demo') !== role) return null;
  }
  return { ruolo: role, id: String(id || 'owner') };
}

// Il solo ruolo, come prima: la maggior parte dei chiamanti vuole solo quello.
function checkToken(v) { const s = checkSessione(v); return s ? s.ruolo : null; }

module.exports = {
  isEnabled, stato, setPassword, setDemoPassword, togliDemoCondiviso, setPersona, creaPersona, togliPersona,
  persone, verifica, verifyRole, makeToken, checkToken, checkSessione,
  personaDaTelefono, setTelefono,
  idDaNome, ID_RISERVATI, MIN_LEN, TTL_MS,
};
