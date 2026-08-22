/**
 * IL MAGAZZINO DELLE PERSONE — l'unico posto che apre `amr-utenti.db`.
 *
 * Fin qui AMR non aveva un dato "di qualcuno": le ricerche salvate stavano in un file solo per
 * installazione, gli annunci salvati nel localStorage del browser. Con le persone che si
 * registrano da sole quel modello non regge: serve un posto dove ogni riga ha un padrone.
 *
 * PERCHE' SQLite E NON POSTGRES. Il Postgres del progetto vive su un volume attaccato all'iMac e
 * si avvia a mano; la macchina che serve le persone e' il Mac di papa', dove Postgres non c'e' e
 * `DATABASE_URL` non e' impostata. `node:sqlite` invece e' dentro Node: provato il 2026-08-12 su
 * entrambe le macchine (iMac v26.4.0, M2 v25.8.1), senza flag e senza dipendenze nuove.
 *
 * DOVE STA IL FILE: <USER_DATA_PATH>/amr-utenti.db se quella cartella c'e', altrimenti
 * data/amr-utenti.db — lo stesso criterio di auth.js e saved.js, cosi' i dati delle persone
 * stanno accanto alle loro credenziali e non in un secondo posto da ricordarsi.
 *
 * TRE STATI, NON DUE. Come `auth.stato()`: 'ok', 'assente' (il POSTO non c'e' — volume smontato,
 * USER_DATA_PATH sparita: non si crea un database altrove, si dice che manca) e 'illeggibile'
 * (il file c'e' ma non si apre, o non e' nostro). Un catch che risponde "nessun conflitto" o
 * "zero ricerche oggi" non e' un errore ingoiato: e' un controllo spento.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const FILE = 'amr-utenti.db';

/**
 * La cartella in cui deve stare il database — quella VOLUTA, non quella che si riesce a usare.
 *
 * Il ripiego "se USER_DATA_PATH non esiste, uso data/" sembra gentile e invece nasconde il
 * guasto: con la cartella sparita (volume smontato, cartella Electron cancellata) il magazzino
 * sarebbe un ALTRO file, nuovo e vuoto — zero richieste, zero inviti, tetti azzerati — e nessuno
 * se ne accorgerebbe. Qui si torna la cartella voluta e basta: se non c'e', `stato()` dice
 * 'assente' e chi scrive si ferma. Stessa regola di `auth.js:baseSparita`.
 */
function cartella() {
  const userData = process.env.USER_DATA_PATH;
  if (userData) return userData;
  return path.join(__dirname, '..', 'data');
}
function percorso() { return path.join(cartella(), FILE); }

/**
 * LE MIGRAZIONI, in ordine e mai riscritte.
 *
 * Non file .sql: `db/` e il suo runner sono la zona in pausa di Postgres, e mettere qui dentro
 * dei numeri che si mescolano ai suoi vorrebbe dire due serie di migrazioni con la stessa
 * numerazione in due posti.
 */
const MIGRAZIONI = [
  // 1 — il primo impianto: chi chiede di entrare, chi e' stato invitato, e cos'e' di chi.
  `
  CREATE TABLE meta (
    chiave TEXT PRIMARY KEY,
    valore TEXT NOT NULL
  );

  -- Chi ha chiesto un account. 'persona' e' l'id che NASCEREBBE da quel nome (auth.idDaNome):
  -- si salva calcolato perche' e' quello il nome vero del conflitto, non la stringa scritta.
  CREATE TABLE richieste (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    persona    TEXT    NOT NULL,
    nome       TEXT    NOT NULL,
    email      TEXT    NOT NULL,
    ip         TEXT,
    creata_il  INTEGER NOT NULL,
    scade_il   INTEGER NOT NULL,
    stato      TEXT    NOT NULL,
    deciso_il  INTEGER,
    motivo     TEXT
  );
  -- Una sola richiesta VIVA per persona. Senza questo indice, una richiesta gia' approvata non
  -- conta piu' come "in attesa" e lo stesso nome si puo' richiedere una seconda volta: due
  -- inviti vivi, e il secondo consumato mesi dopo si prende l'account del primo.
  CREATE UNIQUE INDEX richieste_viva ON richieste(persona) WHERE stato IN ('attesa','approvata');
  CREATE INDEX richieste_stato ON richieste(stato, creata_il);

  -- L'invito. Del token si conserva SOLO lo sha256: chi legge il database non puo' usarlo.
  CREATE TABLE inviti (
    token     TEXT PRIMARY KEY,
    richiesta INTEGER NOT NULL,
    persona   TEXT    NOT NULL,
    nome      TEXT    NOT NULL,
    creato_il INTEGER NOT NULL,
    scade_il  INTEGER NOT NULL,
    usato_il  INTEGER
  );

  -- Le ricerche salvate: la voce di saved.js intera come blob, perche' la logica degli avvisi
  -- (seen, alerted, soglie, coda) non deve accorgersi di aver cambiato magazzino.
  CREATE TABLE ricerche (
    utente TEXT NOT NULL,
    id     TEXT NOT NULL,
    dati   TEXT NOT NULL,
    PRIMARY KEY (utente, id)
  );

  -- Annunci salvati, ricambi salvati, codici OEM preferiti: tre generi, una tabella.
  CREATE TABLE salvataggi (
    utente    TEXT NOT NULL,
    genere    TEXT NOT NULL,
    chiave    TEXT NOT NULL,
    dati      TEXT NOT NULL,
    creato_il INTEGER NOT NULL,
    PRIMARY KEY (utente, genere, chiave)
  );

  -- Quello che oggi sta nel localStorage: impostazioni di prezzo, tema, vista, province.
  CREATE TABLE preferenze (
    utente TEXT NOT NULL,
    chiave TEXT NOT NULL,
    valore TEXT NOT NULL,
    PRIMARY KEY (utente, chiave)
  );

  -- Il parco concessionari, uno per persona (oggi competitor.json e' uno per macchina).
  CREATE TABLE parco (
    utente        TEXT PRIMARY KEY,
    dati          TEXT NOT NULL,
    aggiornato_il INTEGER NOT NULL
  );

  -- Il contatore del tetto giornaliero. Il giorno e' una stringa 'AAAA-MM-GG' di orologio
  -- locale: e' quello che la persona chiama "oggi", non un fuso.
  CREATE TABLE uso (
    utente   TEXT    NOT NULL,
    giorno   TEXT    NOT NULL,
    ricerche INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (utente, giorno)
  );
  `,

  // 2 — il registro degli accessi concessi. Non previene niente: serve ad accorgersene.
  //
  // Una richiesta approvata e un account nato sono gli unici due gesti di questa app che
  // lasciano una credenziale permanente, e finora non li scriveva nessuno: il registro esistente
  // (`db/011_access_log.sql`) vive su Postgres, che sulla macchina che serve le persone NON C'E'
  // — li' `accessLog.record` esce alla prima riga senza scrivere e senza lamentarsi. Quindi
  // sarebbe stato un registro che non registra.
  //
  // Nessuna rotta web lo espone, per decisione del proprietario: si legge solo da
  // `scripts/richieste.js`, cioe' da chi ha accesso alla macchina.
  `
  CREATE TABLE registro (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    quando  INTEGER NOT NULL,
    evento  TEXT    NOT NULL,
    persona TEXT,
    nome    TEXT,
    dettagli TEXT
  );
  CREATE INDEX registro_quando ON registro(quando DESC);
  `,
];

let aperto = null;         // DatabaseSync vivo
let apertoSu = null;       // il percorso con cui e' stato aperto: se cambia, si riapre
let ultimoGuasto = null;   // il motivo dell'ultimo fallimento, per dirlo invece di tacerlo

/** Il giorno di calendario locale, 'AAAA-MM-GG'. */
function giorno(t = Date.now()) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function applicaMigrazioni(db) {
  db.exec('CREATE TABLE IF NOT EXISTS _migrazioni (n INTEGER PRIMARY KEY, applicata_il INTEGER NOT NULL)');
  const fatte = new Set(db.prepare('SELECT n FROM _migrazioni').all().map(r => Number(r.n)));
  for (let i = 0; i < MIGRAZIONI.length; i++) {
    const n = i + 1;
    if (fatte.has(n)) continue;
    // Una migrazione o passa intera o non passa: a meta' strada il database non e' ne' vecchio
    // ne' nuovo, ed e' lo stato da cui non si torna indietro senza un backup.
    db.exec('BEGIN');
    try {
      db.exec(MIGRAZIONI[i]);
      db.prepare('INSERT INTO _migrazioni (n, applicata_il) VALUES (?, ?)').run(n, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* la transazione era gia' caduta da sola */ }
      throw e;
    }
  }
  // Il timbro d'identita'. Un file che esiste ma non ce l'ha non e' "vuoto": e' un altro file.
  const m = db.prepare("SELECT valore FROM meta WHERE chiave = 'creato_il'").get();
  if (!m) db.prepare("INSERT INTO meta (chiave, valore) VALUES ('creato_il', ?)").run(String(Date.now()));
}

/**
 * Apre (una volta sola) e migra. Torna il database, oppure null col motivo in `ultimoGuasto`.
 * Non lancia: chi ha bisogno di un database pronto usa `richiedi()`.
 */
function apri() {
  const p = percorso();
  if (aperto && apertoSu === p) return aperto;
  if (aperto) { try { aperto.close(); } catch { /* gia' chiuso */ } aperto = null; apertoSu = null; }

  // Il POSTO prima del file: senza questo controllo, un volume smontato non darebbe un errore
  // ma un database NUOVO e VUOTO creato altrove — nessuna richiesta, nessun invito, nessun
  // tetto. Tutto a zero e nessun messaggio. (Stessa lezione di auth.js:baseSparita.)
  if (!fs.existsSync(cartella())) {
    ultimoGuasto = `la cartella dei dati non esiste: ${cartella()}`;
    return null;
  }
  try {
    const db = new DatabaseSync(p);
    // WAL: lettori e scrittore convivono. Serve perche' in questo repo un secondo processo non
    // e' teorico — l'Electron che forka il server mentre il LaunchAgent gira gia' ha lasciato
    // orfani documentati. busy_timeout: aspetta invece di fallire subito. node:sqlite e'
    // SINCRONO e blocca l'event loop, quindi l'attesa resta corta di proposito.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 3000');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    applicaMigrazioni(db);
    aperto = db; apertoSu = p; ultimoGuasto = null;
    return db;
  } catch (e) {
    ultimoGuasto = e && e.message ? e.message : String(e);
    return null;
  }
}

/**
 * 'ok' · 'assente' (il posto non c'e': non si crea niente altrove) · 'illeggibile' (c'e' ma non
 * si apre, o non e' nostro). Chi SCRIVE credenziali si ferma su tutto cio' che non e' 'ok'.
 */
function stato() {
  if (!fs.existsSync(cartella())) return 'assente';
  return apri() ? 'ok' : 'illeggibile';
}

/** Il database, o un errore che dice cosa e' rotto. Per chi non puo' proseguire senza. */
function richiedi() {
  const db = apri();
  if (db) return db;
  const e = new Error(`il magazzino delle persone non e' utilizzabile (${ultimoGuasto || 'motivo sconosciuto'})`);
  e.code = 'DB_NON_PRONTO';
  throw e;
}

/** Chiude e dimentica. Serve ai test, e a chi cambia USER_DATA_PATH sotto i piedi. */
function chiudi() {
  if (aperto) { try { aperto.close(); } catch { /* gia' chiuso */ } }
  aperto = null; apertoSu = null; ultimoGuasto = null;
}

function guasto() { return ultimoGuasto; }

// Quanto tempo si tiene il contatore di una giornata passata. Serve solo a poter dire "ieri ne
// hai fatte 50": due mesi bastano, e la tabella resta di qualche riga per persona.
const USO_STORICO = 60 * 24 * 60 * 60 * 1000;

/**
 * IL TETTO GIORNALIERO, contato su disco e non in memoria.
 *
 * Un contatore in memoria si azzera a ogni riavvio, e il riavvio in questa casa e' un gesto
 * ordinario (il servizio riparte da solo, l'app Electron rilancia il server). Un tetto che si
 * azzera quando gli pare non e' un tetto.
 *
 * Non c'e' nessun ramo che "in caso di dubbio lascia passare": se il magazzino non si apre,
 * `richiedi()` lancia e chi chiama risponde che il registro non e' raggiungibile. Un `catch`
 * che restituisce "zero ricerche oggi" non e' un errore ingoiato, e' il tetto spento.
 *
 * @returns {{ok:boolean, usate:number, max:number, giorno:string}}
 */
function consumaRicerca(utente, max, t = Date.now()) {
  const db = richiedi();
  const g = giorno(t);
  const chi = String(utente || '');
  const riga = db.prepare('SELECT ricerche FROM uso WHERE utente=? AND giorno=?').get(chi, g);
  const usate = riga ? Number(riga.ricerche) : 0;
  if (usate >= max) return { ok: false, usate, max, giorno: g };
  if (!riga) {
    // Prima ricerca di oggi per questa persona: ne approfitto per buttare le sue giornate
    // vecchie. Cosi' la potatura costa una volta al giorno a testa, non a ogni ricerca.
    db.prepare('DELETE FROM uso WHERE utente=? AND giorno < ?').run(chi, giorno(t - USO_STORICO));
    db.prepare('INSERT INTO uso (utente, giorno, ricerche) VALUES (?,?,1)').run(chi, g);
  } else {
    db.prepare('UPDATE uso SET ricerche = ricerche + 1 WHERE utente=? AND giorno=?').run(chi, g);
  }
  return { ok: true, usate: usate + 1, max, giorno: g };
}

/**
 * SCRIVE NEL REGISTRO. Chiamata dopo che il gesto e' riuscito, mai prima.
 *
 * Non lancia: un registro che non si scrive non deve impedire un'approvazione che era giusta.
 * Ma non tace nemmeno — l'errore finisce a schermo, perche' "il registro e' vuoto" e "il registro
 * non ha potuto scrivere" sono due frasi diverse e chi legge deve poterle distinguere.
 */
function annota(evento, { persona = null, nome = null, dettagli = null } = {}) {
  try {
    const db = apri();
    if (!db) { console.error(`[registro] "${evento}" non annotato: ${guasto() || stato()}`); return false; }
    db.prepare('INSERT INTO registro (quando, evento, persona, nome, dettagli) VALUES (?,?,?,?,?)')
      .run(Date.now(), String(evento), persona ? String(persona) : null,
           nome ? String(nome) : null, dettagli ? String(dettagli).slice(0, 500) : null);
    return true;
  } catch (e) {
    console.error(`[registro] "${evento}" non annotato: ${e.message}`);
    return false;
  }
}

/** Le ultime N righe del registro, dalla piu' recente. Solo per lo script di gestione. */
function registro(n = 100) {
  const db = apri();
  if (!db) return [];
  return db.prepare('SELECT quando, evento, persona, nome, dettagli FROM registro ORDER BY quando DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(1000, Number(n) || 100)));
}

/**
 * Questo id e' mai stato REVOCATO? Si legge dal registro, che gia' annota ogni revoca.
 *
 * Serve a non far rinascere un account con lo stesso id: togliere una persona cancella solo la
 * credenziale in auth.json, ma ricerche, salvataggi, preferenze e parco restano indicizzati su
 * quell'id. Se qualcuno si registra dopo con lo stesso nome, l'id torna uguale e lui EREDITA i
 * dati privati del revocato. Un id revocato resta bruciato: chi vuole rientrare usa un altro
 * nome, oppure il proprietario lo riammette a mano.
 * A magazzino guasto si risponde `true` (prudenza): meglio un nome rifiutato di un'eredita'.
 */
function revocato(persona, { personeVive = null } = {}) {
  const db = apri();
  if (!db) return true;
  const id = String(persona || '');
  // CHI E' VIVO NON E' BRUCIATO. Un id portato da una persona che esiste e' "occupato" (e lo
  // dice il ramo NOME_OCCUPATO di chi chiama), non "revocato": se fosse stato revocato e poi
  // riammesso a mano, il registro porta ancora la riga vecchia, e senza questo controllo il
  // riammesso risulterebbe bruciato per sempre.
  if (Array.isArray(personeVive) && personeVive.includes(id)) return false;
  if (db.prepare("SELECT 1 FROM registro WHERE evento = 'revocata' AND persona = ? LIMIT 1").get(id)) return true;
  // E' BRUCIATO ANCHE SENZA ANNOTAZIONE. Chi toglie una persona passando da `auth.togliPersona`
  // direttamente (set-password.js --togli, utenti-da-env.js) non scrive nel registro: se l'id ha
  // ancora righe nel magazzino e nessuna persona viva lo porta, quelle righe sono di un revocato,
  // e chi rinascesse con lo stesso nome le erediterebbe. `personeVive` lo passa chi sa gia'
  // chi c'e' (evita una lettura di auth.json); senza, si risponde solo col registro.
  if (!Array.isArray(personeVive)) return false;
  const haDati = db.prepare(
    'SELECT 1 FROM salvataggi WHERE utente=? UNION SELECT 1 FROM ricerche WHERE utente=? ' +
    'UNION SELECT 1 FROM preferenze WHERE utente=? UNION SELECT 1 FROM parco WHERE utente=? LIMIT 1'
  ).get(id, id, id, id);
  return !!haDati;
}

/**
 * Addebita N ricerche in UN colpo: o ci stanno tutte nel credito di oggi, o non se ne spende
 * nessuna. Serve a /api/saved/check, che fa fino a venti ricerche per chiamata: consumarle una
 * per una e fermarsi a meta' bruciava il credito senza fare il lavoro, e chiudeva fuori l'utente
 * anche dalla ricerca normale fino a domani.
 */
function consumaRicerche(utente, n, max, t = Date.now()) {
  const db = richiedi();
  const g = giorno(t);
  const chi = String(utente || '');
  const quante = Math.max(0, Number(n) || 0);
  const riga = db.prepare('SELECT ricerche FROM uso WHERE utente=? AND giorno=?').get(chi, g);
  const usate = riga ? Number(riga.ricerche) : 0;
  if (quante === 0) return { ok: true, usate, max, giorno: g };
  if (usate + quante > max) return { ok: false, usate, max, giorno: g, servono: quante };
  if (!riga) {
    db.prepare('DELETE FROM uso WHERE utente=? AND giorno < ?').run(chi, giorno(t - USO_STORICO));
    db.prepare('INSERT INTO uso (utente, giorno, ricerche) VALUES (?,?,?)').run(chi, g, quante);
  } else {
    // La condizione nell'UPDATE rende l'addebito atomico anche con due processi: se un altro ha
    // consumato nel frattempo e il credito non basta piu', non cambia nessuna riga.
    const r = db.prepare('UPDATE uso SET ricerche = ricerche + ? WHERE utente=? AND giorno=? AND ricerche + ? <= ?').run(quante, chi, g, quante, max);
    if (!r.changes) return { ok: false, usate, max, giorno: g, servono: quante };
  }
  return { ok: true, usate: usate + quante, max, giorno: g };
}

/** Quante ne ha gia' fatte oggi, senza consumarne una. */
function ricercheOggi(utente, t = Date.now()) {
  const db = apri();
  if (!db) return null;
  const r = db.prepare('SELECT ricerche FROM uso WHERE utente=? AND giorno=?').get(String(utente || ''), giorno(t));
  return r ? Number(r.ricerche) : 0;
}

module.exports = {
  apri, richiedi, stato, chiudi, percorso, cartella, giorno, guasto,
  consumaRicerca, consumaRicerche, ricercheOggi, annota, registro, revocato, MIGRAZIONI,
};
