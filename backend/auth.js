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
const MIN_LEN = 10;
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

function load() {
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
function setPersona(nome, pw, ruolo = 'demo') {
  const n = String(nome || '').trim();
  if (!n) throw new Error('Serve un nome.');
  if (!pw || String(pw).length < MIN_LEN) throw new Error(`Password troppo corta (minimo ${MIN_LEN} caratteri).`);
  const cfg = load();
  if (cfg === ILLEGGIBILE) throw new Error(`${filePath()} esiste ma non si legge: correggilo prima di riscriverlo.`);
  if (!cfg) throw new Error('Imposta prima la password principale (scripts/set-password.js).');
  const id = n.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!id) throw new Error('Il nome non produce un identificativo utilizzabile.');
  if (id === 'owner' || id === 'demo') throw new Error(`"${id}" e' riservato: usa un altro nome.`);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  cfg.persone = (cfg.persone || []).filter(p => String(p.id) !== id);
  cfg.persone.push({ id, nome: n, salt, hash, ruolo: ruolo === 'full' ? 'full' : 'demo' });
  scriviAtomico(filePath(), cfg);
  return { id, nome: n, ruolo: ruolo === 'full' ? 'full' : 'demo' };
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
  return (cfg.persone || []).map(p => ({ id: String(p.id), nome: p.nome || String(p.id), ruolo: p.ruolo === 'full' ? 'full' : 'demo' }));
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
  return { ruolo: role, id: String(id || 'owner') };
}

// Il solo ruolo, come prima: la maggior parte dei chiamanti vuole solo quello.
function checkToken(v) { const s = checkSessione(v); return s ? s.ruolo : null; }

module.exports = {
  isEnabled, stato, setPassword, setDemoPassword, setPersona, togliPersona, persone,
  verifica, verifyRole, makeToken, checkToken, checkSessione, MIN_LEN, TTL_MS,
};
