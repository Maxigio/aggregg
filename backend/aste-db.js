'use strict';
/**
 * IL MAGAZZINO DEI LOTTI D'ASTA — la copia locale di quello che il PVP pubblica.
 *
 * Perche' una copia e non un'interrogazione al volo: il portale del ministero e' l'unica fonte
 * possibile (art. 490 c.p.c.), risponde bene ma e' un servizio pubblico, e i suoi dati cambiano
 * lentamente — le aste si pubblicano con settimane di anticipo. Un giro al giorno basta, e in
 * cambio ogni filtro a schermo diventa istantaneo e non costa niente a nessuno.
 *
 * E' PICCOLO. Misurato il 2026-09-01: 619 veicoli con vendita futura in tutta Italia (499 auto,
 * 120 moto). Non c'e' niente da paginare e niente da tenere a dieta: ci sta tutto.
 *
 * ─── LE TRE REGOLE ─────────────────────────────────────────────────────────────────────────
 *
 * 1. FILE SEPARATO da `amr-utenti.db`. Quello e' il magazzino delle persone, che non deve mai
 *    perdersi ne' trapelare; questo si ricostruisce dal portale in un giro. Tenerli insieme
 *    farebbe anche litigare due scritture sullo stesso lucchetto. Stessa scelta di
 *    fonti-salute.js:24-26.
 *
 * 2. NIENTE DATI PERSONALI. Il dettaglio del PVP contiene nome, cellulare, email e codice
 *    fiscale del referente della procedura: pubblicati dal ministero, ma non roba da ricopiare
 *    in un nostro database. Qui dentro non entrano — `aste-lotto.leggi` li lascia gia' fuori, e
 *    c'e' una prova che fallisce se una colonna nuova prova a farli entrare.
 *
 * 3. SPARITO SI DICE, NON SI CANCELLA. Quando un lotto esce dal portale (venduto o ritirato) la
 *    riga resta con `sparito_il` scritto: esce dalla lista viva, ma resta la traccia che c'era.
 *    E' diverso da SCADUTO, che e' solo una data di vendita passata: quello si vede dalla data e
 *    non ha bisogno di una colonna. Confonderli farebbe sembrare venduto tutto cio' che invecchia.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const FILE = 'amr-aste.db';
const GIORNO = 24 * 60 * 60 * 1000;

/**
 * Quanto invecchia un giro prima che ne serva un altro. Non si guarda l'orologio ma l'ETA'
 * dell'ultimo giro riuscito: e' il modo di questo repo per non aver bisogno di un cron
 * (stesso stampo di SAVED_STALE_MS in server.js).
 */
const GIRO_STANTIO_MS = GIORNO;

/**
 * Le righe sparite si tengono un mese, poi via: servono a spiegare «c'era e non c'e' piu'»,
 * non a diventare un archivio storico (che il proprietario ha escluso).
 */
const TIENI_SPARITI_MS = 30 * GIORNO;

/**
 * LA CHIAVE E' (id, tipo), NON l'id da solo — e non e' un dettaglio.
 *
 * Una vendita del PVP puo' contenere PIU' veicoli di tipo diverso: `categoriaBene` e' un array, e
 * ce ne sono di reali come «autovettura SMART FORTWO e motociclo APRILIA PEGASO», che compaiono
 * sia fra le auto sia fra le moto. Con l'id da solo il giro delle moto rubava la riga a quello
 * delle auto (misurato: 2 righe perse e «2 nuovi» a ogni giro, per sempre). Col paio, la stessa
 * vendita sta in tutt'e due gli elenchi — che e' la verita': quel lotto contiene una moto E
 * un'auto, e chi cerca l'una o l'altra deve trovarlo.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS lotti (
  id                 INTEGER NOT NULL,
  tipo               TEXT    NOT NULL,
  descrizione        TEXT    NOT NULL,
  marca              TEXT,
  cumulativo         INTEGER NOT NULL DEFAULT 0,
  piattaforma        TEXT,
  prezzo_base        REAL,
  offerta_minima     REAL,
  rialzo_minimo      REAL,
  data_vendita       TEXT,
  orario_vendita     TEXT,
  data_pubblicazione TEXT,
  citta              TEXT,
  provincia          TEXT,
  tribunale          TEXT,
  numero_lotto       TEXT,
  procedura          TEXT,
  visto_il           INTEGER NOT NULL,
  sparito_il         INTEGER,
  PRIMARY KEY (id, tipo)
);
CREATE INDEX IF NOT EXISTS lotti_vendita ON lotti(data_vendita);
CREATE INDEX IF NOT EXISTS lotti_marca   ON lotti(marca);
CREATE INDEX IF NOT EXISTS lotti_spariti ON lotti(sparito_il);

CREATE TABLE IF NOT EXISTS giri (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  iniziato_il INTEGER NOT NULL,
  finito_il   INTEGER,
  esito       TEXT,
  motivo      TEXT,
  visti       INTEGER,
  nuovi       INTEGER,
  spariti     INTEGER
);
CREATE INDEX IF NOT EXISTS giri_iniziato ON giri(iniziato_il DESC);
`;

// ─── Apertura ────────────────────────────────────────────────────────────────────────────────

let aperto = null;
let apertoSu = null;
let ultimoGuasto = null;

/**
 * La cartella VOLUTA, senza ripiego su `data/`: con un volume smontato il ripiego creerebbe un
 * database nuovo e vuoto altrove, e nessuno se ne accorgerebbe. L'esistenza si controlla dentro
 * `apri()`, dove diventa 'assente'. Stessa scelta di utenti-db.js:29-35.
 */
const cartella = () => process.env.USER_DATA_PATH || path.join(__dirname, '..', 'data');
const percorso = () => path.join(cartella(), FILE);

/**
 * Apre il magazzino. NON LANCIA MAI: torna null e lascia il motivo in `guasto()`.
 * @param {boolean} [crea] se false non crea il file: una lettura non deve sporcare la cartella.
 */
function apri({ crea = false } = {}) {
  const p = percorso();
  if (aperto && apertoSu === p) return aperto;
  if (aperto) { try { aperto.close(); } catch (_) { /* gia' chiuso */ } aperto = null; apertoSu = null; }
  if (!fs.existsSync(cartella())) { ultimoGuasto = `cartella dati assente: ${cartella()}`; return null; }
  if (!crea && !fs.existsSync(p)) { ultimoGuasto = null; return null; }   // non c'e' ancora: non e' un guasto
  try {
    const d = new DatabaseSync(p);
    d.exec('PRAGMA journal_mode = WAL');    // sull'M2 un secondo processo non e' teorico
    d.exec('PRAGMA busy_timeout = 3000');   // l'attesa e' SINCRONA: non di piu'
    d.exec('PRAGMA synchronous = NORMAL');
    d.exec(SCHEMA);
    aperto = d; apertoSu = p; ultimoGuasto = null;
    return aperto;
  } catch (e) {
    ultimoGuasto = e.message;
    return null;
  }
}

/** Per chi SCRIVE: qui il fallimento e' un errore vero, tipizzato, che la rotta gira in 503. */
function richiedi() {
  const d = apri({ crea: true });
  if (d) return d;
  const e = new Error(`magazzino aste non disponibile: ${ultimoGuasto || 'motivo ignoto'}`);
  e.code = 'ASTE_DB_KO';
  throw e;
}

/** 'ok' | 'assente' (mai riempito) | 'illeggibile' (c'e' ma non si apre). */
function stato() {
  const p = percorso();
  if (apri()) return 'ok';
  if (ultimoGuasto) return 'illeggibile';
  return fs.existsSync(p) ? 'illeggibile' : 'assente';
}

const guasto = () => ultimoGuasto;
function chiudi() { if (aperto) { try { aperto.close(); } catch (_) {} } aperto = null; apertoSu = null; }
function _reset() { chiudi(); ultimoGuasto = null; }

// ─── Scrittura: il giro giornaliero ──────────────────────────────────────────────────────────

const COLONNE = [
  'id', 'tipo', 'descrizione', 'marca', 'cumulativo', 'piattaforma', 'prezzo_base',
  'offerta_minima', 'rialzo_minimo', 'data_vendita', 'orario_vendita', 'data_pubblicazione',
  'citta', 'provincia', 'tribunale', 'numero_lotto', 'procedura', 'visto_il',
];

/**
 * Sostituisce l'inventario di UN tipo con quello appena letto dal portale.
 *
 * Tutto dentro una transazione: un giro interrotto a meta' non deve lasciare un inventario
 * dimezzato che poi sembra la verita' del giorno. `visto_il` porta il timbro del giro, ed e'
 * quello che dice chi e' ancora sul portale: le righe di questo tipo che il giro NON ha
 * ritoccato sono sparite dalla fonte, e si marcano invece di essere cancellate.
 *
 * @param {object[]} lotti  gia' passati da aste-lotto.leggi (niente dati personali)
 * @returns {{visti:number, nuovi:number, spariti:number}}
 */
function sostituisci(tipo, lotti, adesso = Date.now()) {
  const d = richiedi();
  const ins = d.prepare(`
    INSERT INTO lotti (${COLONNE.join(', ')}) VALUES (${COLONNE.map(() => '?').join(', ')})
    ON CONFLICT(id, tipo) DO UPDATE SET
      ${COLONNE.filter(c => c !== 'id' && c !== 'tipo').map(c => `${c} = excluded.${c}`).join(', ')},
      sparito_il = NULL`);
  d.exec('BEGIN');
  try {
    const primaConosciuti = new Set(
      d.prepare('SELECT id FROM lotti WHERE tipo = ?').all(tipo).map(r => Number(r.id)));
    let nuovi = 0;
    for (const l of lotti) {
      if (!primaConosciuti.has(Number(l.id))) nuovi++;
      ins.run(
        l.id, tipo, l.descrizione || '', l.marca, l.cumulativo ? 1 : 0, l.piattaforma,
        l.prezzoBase, l.offertaMinima, l.rialzoMinimo, l.dataVendita, l.orarioVendita,
        l.dataPubblicazione, l.citta, l.provincia, l.tribunale, l.numeroLotto, l.procedura,
        adesso);
    }
    // Chi non ha il timbro di questo giro non e' piu' sul portale. Marcato, non cancellato:
    // e chi era gia' marcato tiene la SUA data, se no «sparito da quando» diventerebbe oggi.
    const spariti = d.prepare(
      'UPDATE lotti SET sparito_il = ? WHERE tipo = ? AND visto_il < ? AND sparito_il IS NULL')
      .run(adesso, tipo, adesso).changes;
    d.exec('COMMIT');
    return { visti: lotti.length, nuovi, spariti: Number(spariti) };
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch (_) { /* la transazione era gia' caduta */ }
    throw e;
  }
}

/** Le righe sparite da un pezzo se ne vanno: spiegavano un'assenza, non sono un archivio. */
function potaSpariti(adesso = Date.now()) {
  const d = apri();
  if (!d) return 0;
  return Number(d.prepare('DELETE FROM lotti WHERE sparito_il IS NOT NULL AND sparito_il < ?')
    .run(adesso - TIENI_SPARITI_MS).changes);
}

// ─── Il registro dei giri ────────────────────────────────────────────────────────────────────

function iniziaGiro(adesso = Date.now()) {
  const d = richiedi();
  return Number(d.prepare('INSERT INTO giri (iniziato_il) VALUES (?)').run(adesso).lastInsertRowid);
}

function chiudiGiro(id, { esito, motivo = null, visti = null, nuovi = null, spariti = null }, adesso = Date.now()) {
  const d = richiedi();
  d.prepare('UPDATE giri SET finito_il = ?, esito = ?, motivo = ?, visti = ?, nuovi = ?, spariti = ? WHERE id = ?')
    .run(adesso, esito, motivo, visti, nuovi, spariti, id);
}

/** L'ultimo giro RIUSCITO, o null. Da qui si decide se serve rifarlo: si guarda l'eta', non l'ora. */
function ultimoGiro() {
  const d = apri();
  if (!d) return null;
  const r = d.prepare("SELECT * FROM giri WHERE esito = 'ok' ORDER BY finito_il DESC LIMIT 1").get();
  if (!r) return null;
  return {
    id: Number(r.id), iniziatoIl: Number(r.iniziato_il), finitoIl: Number(r.finito_il),
    visti: r.visti == null ? null : Number(r.visti),
    nuovi: r.nuovi == null ? null : Number(r.nuovi),
    spariti: r.spariti == null ? null : Number(r.spariti),
  };
}

const stantio = (adesso = Date.now()) => {
  const g = ultimoGiro();
  return !g || (adesso - g.finitoIl) > GIRO_STANTIO_MS;
};

// ─── Lettura ─────────────────────────────────────────────────────────────────────────────────

const inMemoria = r => ({
  id: Number(r.id), tipo: r.tipo, descrizione: r.descrizione, marca: r.marca,
  cumulativo: !!r.cumulativo, piattaforma: r.piattaforma,
  prezzoBase: r.prezzo_base, offertaMinima: r.offerta_minima, rialzoMinimo: r.rialzo_minimo,
  dataVendita: r.data_vendita, orarioVendita: r.orario_vendita, dataPubblicazione: r.data_pubblicazione,
  citta: r.citta, provincia: r.provincia, tribunale: r.tribunale,
  numeroLotto: r.numero_lotto, procedura: r.procedura,
});

/**
 * I lotti vivi, filtrati. LEGGERE NON LANCIA: magazzino assente o rotto torna elenco vuoto, e
 * chi chiama dichiara lo stato accanto al dato invece di far sparire l'area senza spiegazioni.
 *
 * «Vivo» vuol dire due cose insieme: ancora sul portale (`sparito_il IS NULL`) e con la vendita
 * non ancora passata. La seconda si calcola sulla data, non su una colonna: una vendita che
 * scade non e' un lotto che sparisce, ed erano gia' due cose diverse quando le ho misurate.
 */
function cerca({ tipo = null, marca = null, provincia = null, testo = null,
                 prezzoMax = null, soloSingoli = false, dal = null, limite = 500 } = {}) {
  const d = apri();
  if (!d) return [];
  const oggi = dal || new Date().toISOString().slice(0, 10);
  const dove = ['sparito_il IS NULL', 'data_vendita IS NOT NULL', 'data_vendita >= ?'];
  const val = [oggi];
  if (tipo) { dove.push('tipo = ?'); val.push(tipo); }
  if (marca) { dove.push('marca = ?'); val.push(marca); }
  if (provincia) { dove.push('provincia = ?'); val.push(provincia); }
  if (prezzoMax != null) { dove.push('prezzo_base IS NOT NULL AND prezzo_base <= ?'); val.push(prezzoMax); }
  if (soloSingoli) dove.push('cumulativo = 0');
  // Il testo cerca dove il PVP mette tutto: nella descrizione. La marca ha gia' il suo filtro.
  if (testo) { dove.push('descrizione LIKE ?'); val.push('%' + String(testo).replace(/[%_]/g, '') + '%'); }
  val.push(Math.min(Number(limite) || 500, 2000));
  return d.prepare(`SELECT * FROM lotti WHERE ${dove.join(' AND ')} ORDER BY data_vendita ASC LIMIT ?`)
    .all(...val).map(inMemoria);
}

/** Quanti lotti vivi per marca: serve al riepilogo in testa alla lista. */
function perMarca(tipo = null, dal = null) {
  const d = apri();
  if (!d) return [];
  const oggi = dal || new Date().toISOString().slice(0, 10);
  const val = [oggi];
  let filtro = '';
  if (tipo) { filtro = ' AND tipo = ?'; val.push(tipo); }
  return d.prepare(`SELECT marca, COUNT(*) AS quanti FROM lotti
    WHERE sparito_il IS NULL AND data_vendita >= ?${filtro}
    GROUP BY marca ORDER BY quanti DESC`).all(...val)
    .map(r => ({ marca: r.marca, quanti: Number(r.quanti) }));
}

/** Le province che hanno almeno un lotto vivo: la tendina si riempie da qui, non da un elenco fisso. */
function province(tipo = null, dal = null) {
  const d = apri();
  if (!d) return [];
  const oggi = dal || new Date().toISOString().slice(0, 10);
  const val = [oggi];
  let filtro = '';
  if (tipo) { filtro = ' AND tipo = ?'; val.push(tipo); }
  return d.prepare(`SELECT provincia, COUNT(*) AS quanti FROM lotti
    WHERE sparito_il IS NULL AND data_vendita >= ? AND provincia IS NOT NULL${filtro}
    GROUP BY provincia ORDER BY provincia`).all(...val)
    .map(r => ({ provincia: r.provincia, quanti: Number(r.quanti) }));
}

/**
 * Un lotto per id. `tipo` e' facoltativo: senza, torna la prima riga trovata — la stessa vendita
 * puo' esistere come auto E come moto (vedi il commento sulla chiave), e in quel caso i campi che
 * contano (prezzo, date, tribunale) sono identici perche' vengono dalla stessa vendita.
 */
function unLotto(id, tipo = null) {
  const d = apri();
  if (!d) return null;
  const r = tipo
    ? d.prepare('SELECT * FROM lotti WHERE id = ? AND tipo = ?').get(Number(id), tipo)
    : d.prepare('SELECT * FROM lotti WHERE id = ? LIMIT 1').get(Number(id));
  return r ? { ...inMemoria(r), sparito: r.sparito_il != null } : null;
}

module.exports = {
  apri, richiedi, stato, guasto, chiudi, _reset, percorso,
  sostituisci, potaSpariti, iniziaGiro, chiudiGiro, ultimoGiro, stantio,
  cerca, perMarca, province, unLotto,
  _const: { FILE, GIRO_STANTIO_MS, TIENI_SPARITI_MS, COLONNE },
};
