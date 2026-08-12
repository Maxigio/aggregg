/**
 * CHI CHIEDE DI ENTRARE — richiesta, approvazione, invito.
 *
 * Il giro, per intero:
 *   1. una persona compila nome ed email sulla pagina di accesso. NON sceglie nessuna password:
 *      finche' non e' stata approvata non esiste niente di suo da nessuna parte;
 *   2. la richiesta compare nel pannello del proprietario, e nessun altro la vede;
 *   3. approvando nasce un LINK usa-e-getta, valido 48 ore. Il proprietario lo gira come vuole
 *      (a voce, in chat): non si manda posta, e l'email resta quello che e' — un recapito
 *      scritto, non una prova di identita';
 *   4. chi apre il link sceglie li' la sua password, e in quel momento nasce l'account, con
 *      ruolo `demo`, tramite `auth.creaPersona` (che rifiuta i nomi gia' presi e le password
 *      gia' in uso da qualcun altro).
 *
 * PERCHE' LA PASSWORD SOLO ALLA FINE: fra la richiesta e l'approvazione possono passare giorni.
 * Una password scelta al punto 1 sarebbe conservata da qualche parte per tutto quel tempo, e
 * soprattutto la verifica "questo nome e' libero" fatta al punto 1 non varrebbe piu' al punto 4.
 * Si controlla dove si scrive, non dove si chiede.
 *
 * DEL TOKEN SI CONSERVA SOLO L'IMPRONTA (sha256): chi legge il database non puo' usarlo per
 * entrare, e un backup vecchio non resuscita un invito.
 */
const crypto = require('crypto');
const auth = require('./auth');
const dbmod = require('./utenti-db');

const GIORNO = 24 * 60 * 60 * 1000;
const RICHIESTA_TTL = 7 * GIORNO;   // una richiesta che nessuno guarda non resta in eterno
const INVITO_TTL    = 48 * 60 * 60 * 1000;
// Il tetto della coda serve a non far crescere il file senza fine. Vale sulle richieste VIVE, e
// le vive scadono da sole: senza la scadenza, riempire la coda sarebbe il modo piu' economico di
// impedire a chiunque altro di registrarsi.
const MAX_VIVE = 200;

const NOME_MAX = 60;
const EMAIL_MAX = 120;

const ora = () => Date.now();
const impronta = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function errore(msg, code) { const e = new Error(msg); e.code = code; return e; }

/**
 * Un'email PLAUSIBILE, non un'email verificata: qui non si manda niente, quindi l'unica cosa
 * che si puo' promettere e' che sia scritta come un indirizzo. Dirlo cosi' anche a schermo.
 */
function emailPlausibile(s) {
  const v = String(s || '').trim();
  if (!v || v.length > EMAIL_MAX) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v)) return null;
  return v;
}

/**
 * Fa pulizia: le richieste che nessuno ha guardato scadono, e un invito scaduto senza essere
 * usato riporta la sua richiesta "in attesa" — cosi' il proprietario puo' riapprovarla e
 * rifare il link, invece di trovarsi un nome bloccato per sempre da un invito morto.
 */
function purga(t = ora()) {
  const db = dbmod.richiedi();
  const morti = db.prepare('SELECT richiesta FROM inviti WHERE usato_il IS NULL AND scade_il <= ?').all(t);
  if (morti.length) {
    db.prepare('DELETE FROM inviti WHERE usato_il IS NULL AND scade_il <= ?').run(t);
    const rimetti = db.prepare("UPDATE richieste SET stato='attesa', deciso_il=NULL WHERE id=? AND stato='approvata'");
    for (const m of morti) rimetti.run(m.richiesta);
  }
  const scadute = db.prepare("UPDATE richieste SET stato='scaduta' WHERE stato='attesa' AND scade_il <= ?").run(t);
  return { invitiMorti: morti.length, richiesteScadute: Number(scadute.changes || 0) };
}

/** Quante richieste vive ci sono (attesa + approvata). */
function viveContate() {
  const db = dbmod.richiedi();
  const r = db.prepare("SELECT COUNT(*) AS n FROM richieste WHERE stato IN ('attesa','approvata')").get();
  return Number(r.n || 0);
}

/**
 * Registra una richiesta. Torna { id, persona, nome, email }.
 * Ogni rifiuto ha il suo codice, perche' chi chiama deve poter dire una cosa diversa a chi ha
 * sbagliato l'email e a chi ha scelto un nome gia' preso.
 */
function chiedi({ nome, email, ip } = {}) {
  const db = dbmod.richiedi();
  purga();

  const n = String(nome || '').trim().replace(/\s+/g, ' ');
  if (!n) throw errore('Serve il tuo nome.', 'NOME_MANCANTE');
  if (n.length > NOME_MAX) throw errore(`Il nome e' troppo lungo (massimo ${NOME_MAX} caratteri).`, 'NOME_LUNGO');
  const persona = auth.idDaNome(n);
  if (!persona) throw errore('Quel nome non produce un identificativo utilizzabile: usa lettere e numeri.', 'NOME_VUOTO');
  if (auth.ID_RISERVATI.has(persona)) throw errore(`"${persona}" e' riservato: usa un altro nome.`, 'NOME_RISERVATO');

  const mail = emailPlausibile(email);
  if (!mail) throw errore('Serve un indirizzo email scritto per intero.', 'EMAIL_NON_VALIDA');

  // Il nome e' gia' di qualcuno che e' DENTRO: lo si dice subito, invece di far aspettare
  // l'approvazione per poi fallire al momento di creare l'account.
  if (auth.persone().some(p => p.id === persona)) {
    throw errore(`Il nome "${n}" e' gia' in uso: scegline un altro.`, 'NOME_OCCUPATO');
  }
  const viva = db.prepare("SELECT id, stato FROM richieste WHERE persona=? AND stato IN ('attesa','approvata')").get(persona);
  if (viva) {
    throw errore(viva.stato === 'approvata'
      ? 'Questa richiesta e\' gia\' stata approvata: chiedi il link di invito.'
      : 'Una richiesta con questo nome e\' gia\' in attesa.', 'RICHIESTA_GIA_VIVA');
  }
  if (viveContate() >= MAX_VIVE) {
    throw errore('Ci sono troppe richieste in attesa: riprova fra qualche giorno.', 'CODA_PIENA');
  }

  const t = ora();
  const r = db.prepare(
    'INSERT INTO richieste (persona, nome, email, ip, creata_il, scade_il, stato) VALUES (?,?,?,?,?,?,\'attesa\')'
  ).run(persona, n, mail, ip ? String(ip).slice(0, 60) : null, t, t + RICHIESTA_TTL);
  return { id: Number(r.lastInsertRowid), persona, nome: n, email: mail };
}

/**
 * L'elenco per il pannello: le richieste vive, e accanto a ognuna se il suo id calcolato
 * COLLIDE con una persona che esiste gia'. Il pannello mostra il nome, e "Marió Rossì" in mezzo
 * a venti richieste non si legge come un doppione di "Mario Rossi": il conto lo fa la macchina.
 */
function elenco() {
  const db = dbmod.richiedi();
  purga();
  const gia = new Set(auth.persone().map(p => p.id));
  const righe = db.prepare(
    "SELECT id, persona, nome, email, ip, creata_il, scade_il, stato, deciso_il FROM richieste"
    + " WHERE stato IN ('attesa','approvata') ORDER BY creata_il"
  ).all();
  return righe.map(r => ({
    ...r,
    collide: gia.has(r.persona),
    // Se e' approvata ma il link non e' stato ancora usato, si dice quando scade.
    invitoScadeIl: r.stato === 'approvata'
      ? (db.prepare('SELECT scade_il FROM inviti WHERE richiesta=? AND usato_il IS NULL').get(r.id) || {}).scade_il || null
      : null,
  }));
}

/**
 * Approva e genera il link. Il token in chiaro esce di qui UNA volta sola: nel database resta
 * la sola impronta, quindi non lo si puo' rileggere piu' — se il proprietario lo perde, rifa'
 * l'approvazione.
 *
 * L'UPDATE e' condizionato allo stato: due clic sul bottone non devono fare due inviti vivi per
 * la stessa persona (il secondo, consumato mesi dopo, si prenderebbe l'account del primo).
 */
function approva(idRichiesta, t = ora()) {
  const db = dbmod.richiedi();
  purga(t);
  const r = db.prepare('SELECT * FROM richieste WHERE id=?').get(Number(idRichiesta));
  if (!r) throw errore('Richiesta inesistente.', 'RICHIESTA_ASSENTE');
  if (r.stato !== 'attesa') throw errore(`La richiesta e' gia' "${r.stato}".`, 'RICHIESTA_NON_IN_ATTESA');
  if (auth.persone().some(p => p.id === r.persona)) {
    throw errore(`"${r.persona}" nel frattempo e' diventato l'id di una persona che esiste gia'.`, 'NOME_OCCUPATO');
  }
  const cambiate = db.prepare("UPDATE richieste SET stato='approvata', deciso_il=? WHERE id=? AND stato='attesa'").run(t, r.id);
  if (Number(cambiate.changes) !== 1) throw errore('La richiesta e\' cambiata sotto le mani: ricarica.', 'RICHIESTA_CAMBIATA');

  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO inviti (token, richiesta, persona, nome, creato_il, scade_il) VALUES (?,?,?,?,?,?)')
    .run(impronta(token), r.id, r.persona, r.nome, t, t + INVITO_TTL);
  return { token, persona: r.persona, nome: r.nome, scadeIl: t + INVITO_TTL };
}

function rifiuta(idRichiesta, motivo = null, t = ora()) {
  const db = dbmod.richiedi();
  const cambiate = db.prepare("UPDATE richieste SET stato='rifiutata', deciso_il=?, motivo=? WHERE id=? AND stato IN ('attesa','approvata')")
    .run(t, motivo ? String(motivo).slice(0, 200) : null, Number(idRichiesta));
  if (Number(cambiate.changes) !== 1) throw errore('Richiesta inesistente o gia\' decisa.', 'RICHIESTA_ASSENTE');
  // Un invito gia' emesso non deve sopravvivere al rifiuto.
  db.prepare('DELETE FROM inviti WHERE richiesta=? AND usato_il IS NULL').run(Number(idRichiesta));
  return true;
}

/** Cosa c'e' dietro un token, senza consumarlo: serve alla pagina per dire chi sta entrando. */
function guarda(token, t = ora()) {
  const db = dbmod.richiedi();
  const i = db.prepare('SELECT * FROM inviti WHERE token=?').get(impronta(token || ''));
  if (!i) return { valido: false, motivo: 'sconosciuto' };
  if (i.usato_il) return { valido: false, motivo: 'gia-usato' };
  if (i.scade_il <= t) return { valido: false, motivo: 'scaduto' };
  return { valido: true, nome: i.nome, persona: i.persona, scadeIl: i.scade_il };
}

/**
 * Consuma l'invito e crea l'account.
 *
 * L'ordine conta: prima si PRENDE l'invito (UPDATE condizionato a `usato_il IS NULL`, e si va
 * avanti solo se ha cambiato una riga), poi si crea la persona. Cosi' due aperture in parallelo
 * dello stesso link non possono chiamare `creaPersona` due volte — e la seconda chiamata, con
 * la persona ormai esistente, rigenererebbe il secret buttando fuori tutti quanti.
 *
 * Se la creazione fallisce (nome occupato nel frattempo, password gia' di qualcun altro)
 * l'invito torna disponibile: l'errore e' della persona, non del link.
 */
function consuma(token, password, t = ora()) {
  const db = dbmod.richiedi();
  const h = impronta(token || '');
  const i = db.prepare('SELECT * FROM inviti WHERE token=?').get(h);
  if (!i) throw errore('Questo link non vale.', 'INVITO_SCONOSCIUTO');
  if (i.usato_il) throw errore('Questo link e\' gia\' stato usato.', 'INVITO_USATO');
  if (i.scade_il <= t) throw errore('Questo link e\' scaduto: chiedi che venga rifatto.', 'INVITO_SCADUTO');

  const preso = db.prepare('UPDATE inviti SET usato_il=? WHERE token=? AND usato_il IS NULL').run(t, h);
  if (Number(preso.changes) !== 1) throw errore('Questo link e\' gia\' stato usato.', 'INVITO_USATO');

  let nata;
  try {
    nata = auth.creaPersona(i.nome, password, 'demo', 'web');
  } catch (e) {
    db.prepare('UPDATE inviti SET usato_il=NULL WHERE token=?').run(h);   // il link resta buono
    throw e;
  }
  db.prepare("UPDATE richieste SET stato='usata' WHERE id=?").run(i.richiesta);
  return nata;
}

module.exports = {
  chiedi, elenco, approva, rifiuta, guarda, consuma, purga, viveContate,
  emailPlausibile, impronta,
  RICHIESTA_TTL, INVITO_TTL, MAX_VIVE, NOME_MAX, EMAIL_MAX,
};
