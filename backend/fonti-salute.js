'use strict';
/**
 * LA SALUTE DELLE FONTI — quale fonte ci sta rispondendo male, e per quanto smettiamo di
 * chiederle. Sostituisce `backend/db/health-repo.js`, cancellato con Postgres il 2026-08-17.
 *
 * A cosa serve: le fonti bannano la MACCHINA, non l'utente. Se Subito comincia a rispondere 403
 * e noi continuiamo a chiedere, il blocco si allunga. Qui si registra l'esito di ogni richiesta,
 * si riconosce un blocco, e per un po' quella fonte non si interroga.
 *
 * ─── COSA E' CAMBIATO RISPETTO ALLA VERSIONE POSTGRES, E PERCHE' ───────────────────────────
 *
 * 1. UN 429 FERMA SUBITO LA FONTE. Per gli altri blocchi servono due risposte:
 *    un singolo 403 non spegne la fonte per tutti. Il 429 e' invece un limite esplicito.
 *
 * 2. LA FINESTRA PARTE CORTA E CRESCE. Prima era sempre 6 ore. Adesso 15 minuti, poi un'ora,
 *    poi sei: se era un incidente si riparte quasi subito, se e' un ban vero ci si allontana.
 *    E LA SCALA SI SCORDA: se dopo la pausa la fonte torna a lavorare bene piu' a lungo della
 *    pausa piu' lunga, il blocco successivo riparte da 15 minuti. Senza, `stop_fatti` cresceva
 *    e basta e dalla terza pausa in poi si tornava per sempre al "sempre 6 ore" di prima.
 *
 * 3. LO STATO VIVE IN MEMORIA, IL DISCO SERVE SOLO A SOPRAVVIVERE A UN RIAVVIO. `node:sqlite`
 *    e' SINCRONO: scrivere a ogni esito vorrebbe dire bloccare il processo tre volte per
 *    ricerca. Si scrive solo quando lo stato CAMBIA (entra in blocco, ne esce).
 *
 * 4. FILE SEPARATO da quello delle persone. `amr-utenti.db` e' il file che non deve mai perdersi
 *    ne' trapelare; questo e' roba della macchina e si puo' cancellare senza danno. Tenerli
 *    insieme, per giunta, farebbe litigare le due scritture sullo stesso lucchetto.
 *
 * 5. NIENTE DATI DELL'UTENTE QUI DENTRO. Salvare la richiesta fallita "per capire cosa e'
 *    successo" metterebbe il testo cercato da una persona in una tabella che nessuno considera
 *    personale. Dentro ci sono il nome della fonte e il suo stato, e basta: c'e' una prova che
 *    fallisce se qualcuno aggiunge una colonna fuori dall'elenco.
 *
 * 6. `auth` NON ATTIVA IL FRENO ANTI-BLOCCO. Una credenziale rifiutata richiede
 *    una correzione, non una pausa. Il 429 viene sempre trattato come limite della fonte.
 *
 * 7. IL BLOCCO MORBIDO NON DA' ERRORE, DA' ZERO RISULTATI. Contato come `vuoto` (neutro, com'era)
 *    non si nota mai. I vuoti consecutivi rendono la fonte SOSPETTA e visibile — ma non la
 *    fermano da soli, perche' vuoto molto spesso e' vuoto davvero.
 *
 * 8. SE IL FILE NON SI APRE si continua dalla memoria e il guasto si DICHIARA (`guasto()`).
 *    Fermare tutte le ricerche perche' non si legge un file di appoggio sarebbe peggio del male;
 *    ignorarlo in silenzio sarebbe un controllo spento. Si perde solo la memoria di un blocco
 *    attraverso un riavvio.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { AsyncLocalStorage } = require('node:async_hooks');
const richieste = new AsyncLocalStorage();

const FILE = 'amr-fonti.db';
const MINUTO = 60 * 1000;

/** Blocchi consecutivi prima di fermarsi davvero. Vedi punto 1 dell'intestazione. */
const COLPI_PER_FERMARSI = 2;
/** Le finestre, in ordine: al primo stop 15', se ricapita un'ora, poi sei. */
const FINESTRE = [15 * MINUTO, 60 * MINUTO, 6 * 60 * MINUTO];
/** Tetto in LETTURA: un orologio che salta o un file ripristinato da un backup vecchio possono
 *  contenere una scadenza lontanissima. Non si crede al valore scritto: la pausa non puo'
 *  comunque durare piu' di questo a partire da adesso. */
const FINESTRA_MAX = FINESTRE[FINESTRE.length - 1];
/**
 * Il motivo che viaggia fino a schermo quando una fonte viene saltata perche' e' in pausa.
 * E' una STRINGA FISSA di proposito: il frontend la usa come chiave per la sua etichetta, e
 * `_checkSavedOne` la usa per capire che quella fonte tornera' — quindi i suoi annunci NON vanno
 * sfrattati da `seen`. Se ci si mette dentro un orario, tutte e due le cose si rompono.
 */
const MOTIVO_PAUSA = 'in pausa dopo un blocco';
/** Vuoti consecutivi oltre i quali la fonte si dichiara sospetta (non si ferma: si dice). */
const VUOTI_SOSPETTI = 5;
/** Fallimenti non-blocco consecutivi oltre i quali la fonte si dichiara degradata. */
const DEGRADO_A = 3;

// ─── classifica: PURA, e' il cuore testabile ─────────────────────────────────────────────────
const GENERI = new Set(['bloccato', 'auth', 'transitorio', 'errore']);

/**
 * Che cosa e' successo, da un errore (o dalla sua assenza).
 * Gli scraper taggano gia' i loro errori con `kind`/`status` (vedi scrapers/utils.js: `fail` e
 * `kindForStatus`), quindi quelli si credono. La lettura del messaggio e' l'ultima spiaggia:
 * regge a un cambio di testo della fonte, ma non e' su di lei che si fonda il giudizio.
 *
 * @returns {'ok'|'vuoto'|'bloccato'|'auth'|'transitorio'|'errore'}
 */
function classifica(errore, conteggio = 0) {
  if (!errore) return conteggio > 0 ? 'ok' : 'vuoto';
  if (errore.status === 429) return 'bloccato';

  // I generi inglesi arrivano da scrapers/utils.js e non si riscrivono li': si traducono qui.
  const k = errore.kind;
  if (k === 'blocked') return 'bloccato';
  if (k === 'auth') return 'auth';
  if (k === 'transient') return 'transitorio';
  if (k === 'error') return 'errore';
  if (GENERI.has(k)) return k;

  const s = errore.status;
  if (s === 403 || s === 429) return 'bloccato';
  if (s === 401) return 'auth';
  if (typeof s === 'number' && s >= 500) return 'transitorio';

  const m = String(errore.message || '');
  if (/non-?json|blocco|\b403\b|\b429\b/i.test(m)) return 'bloccato';
  if (/\b401\b|credenziale/i.test(m)) return 'auth';
  if (/timeout|ECONN|socket|network|HTTP 5\d\d/i.test(m)) return 'transitorio';
  return 'errore';
}

// ─── il magazzino: memoria davanti, SQLite dietro ────────────────────────────────────────────
function cartella() {
  const userData = process.env.USER_DATA_PATH;
  if (userData) return userData;
  return path.join(__dirname, '..', 'data');
}
function percorso() { return path.join(cartella(), FILE); }

/** Le colonne ammesse. La prova `fonti-salute.test.js` fallisce se la tabella ne acquista altre:
 *  e' il presidio contro la tentazione di salvare qui dentro la richiesta che ha fallito. */
const COLONNE = ['fonte', 'esito', 'ferma_fino_a', 'stop_fatti', 'aggiornata_il', 'retry_dopo', 'prove_fatte', 'intervento'];
const MAX_PROVE = 5;
let sondeAutomatiche = false;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS salute (
  fonte         TEXT PRIMARY KEY,
  esito         TEXT NOT NULL,
  ferma_fino_a  INTEGER,
  stop_fatti    INTEGER NOT NULL DEFAULT 0,
  aggiornata_il INTEGER NOT NULL
);`;

let db = null;             // DatabaseSync vivo, oppure null se non si e' potuto aprire
let ultimoGuasto = null;   // stringa: perche' non si e' potuto aprire
let caricato = false;      // la memoria e' gia' stata riempita dal disco?

/** In memoria, una riga per fonte. Questa e' la verita' di lavoro; il disco e' la copia. */
const memoria = new Map();
let osservati = new WeakSet();

function vuotaRiga(fonte) {
  return {
    fonte,
    esito: null,
    colpi: 0,          // blocchi consecutivi (non si salva: si ricostruisce)
    fallimenti: 0,     // transitori/errori consecutivi
    vuoti: 0,          // vuoti consecutivi
    fermaFinoA: null,  // epoch ms
    stopFatti: 0,      // quante volte si e' gia' fermata → sceglie la finestra
    scalaFinoA: 0,     // fin quando `stopFatti` vale ancora (non si salva: si ricostruisce)
    aggiornataIl: 0,
    retryDopo: null,   // solo la scadenza tecnica Retry-After, mai header o URL
    prova: null,
    proveFatte: 0,
    intervento: null,
  };
}
function riga(fonte) {
  let r = memoria.get(fonte);
  if (!r) { r = vuotaRiga(fonte); memoria.set(fonte, r); }
  return r;
}

/**
 * Apre il file e riempie la memoria. Una volta sola; se non riesce, si prosegue senza — e il
 * motivo resta in `guasto()`. Non si crea il database in una cartella che non c'e': se il posto
 * manca (volume smontato, USER_DATA_PATH sparita) si lavora in memoria e lo si dice.
 */
function apri({ crea = false } = {}) {
  if (caricato && (db || !crea)) return db;
  caricato = true;
  try {
    const dir = cartella();
    if (!fs.existsSync(dir)) { ultimoGuasto = 'la cartella ' + dir + ' non esiste'; return null; }
    // IL FILE NASCE SOLO QUANDO C'E' QUALCOSA DA RICORDARE. Aprendolo anche in lettura, la prima
    // ricerca di un processo sano lo creerebbe vuoto — e ogni giro di prove scriverebbe nella
    // cartella dati vera. Un impianto che non ha mai avuto un problema non lascia tracce.
    if (!crea && !fs.existsSync(percorso())) return null;
    const d = new DatabaseSync(percorso());
    d.exec('PRAGMA journal_mode = WAL');
    d.exec('PRAGMA busy_timeout = 3000');
    d.exec('PRAGMA synchronous = NORMAL');
    d.exec(SCHEMA);
    if (!d.prepare('PRAGMA table_info(salute)').all().some(c => c.name === 'retry_dopo')) {
      d.exec('ALTER TABLE salute ADD COLUMN retry_dopo INTEGER');
    }
    for (const [nome, tipo] of [['prove_fatte', 'INTEGER NOT NULL DEFAULT 0'], ['intervento', 'TEXT']]) {
      if (!d.prepare('PRAGMA table_info(salute)').all().some(c => c.name === nome)) {
        d.exec(`ALTER TABLE salute ADD COLUMN ${nome} ${tipo}`);
      }
    }
    // LA MEMORIA VINCE SUL DISCO. Questo ciclo gira anche quando `salva()` apre il file per
    // la prima volta in un processo che ha GIA' registrato qualcosa: se riscrivesse le righe
    // gia' in memoria, sovrascriverebbe la pausa appena decisa coi valori vecchi del disco —
    // e la INSERT subito dopo persisterebbe quelli. Misurato: il log diceva "ferma per 15
    // min" e sul disco finiva `ferma_fino_a: null`. Dal disco si prendono SOLO le fonti che
    // la memoria non conosce ancora.
    const adesso = Date.now();
    const daCorreggere = [];
    for (const r of d.prepare('SELECT * FROM salute').all()) {
      if (memoria.has(r.fonte)) continue;
      const m = riga(r.fonte);
      m.esito = r.esito;
      // Il taglio si applica GIA' qui, cosi' un valore assurdo (orologio saltato, backup
      // vecchio) non sopravvive nemmeno in memoria: diventa al massimo adesso+FINESTRA_MAX.
      const ferma = r.ferma_fino_a != null ? Number(r.ferma_fino_a) : null;
      m.retryDopo = Number.isSafeInteger(r.retry_dopo) && r.retry_dopo > 0 ? r.retry_dopo : null;
      m.fermaFinoA = ferma ? Math.max(Math.min(ferma, adesso + FINESTRA_MAX), m.retryDopo || 0) : null;
      m.stopFatti = Number(r.stop_fatti) || 0;
      m.aggiornataIl = Number(r.aggiornata_il) || 0;
      m.proveFatte = Math.min(MAX_PROVE, Math.max(0, Number(r.prove_fatte) || 0));
      m.intervento = r.intervento || (m.proveFatte >= MAX_PROVE ? 'tentativi_esauriti' : null);
      // Anche la scala ereditata dal disco invecchia: si misura dall'ultimo cambio di stato
      // scritto, senno' uno `stop_fatti` di mesi fa darebbe sei ore al primo inciampo di oggi.
      m.scalaFinoA = (m.fermaFinoA || m.aggiornataIl) + FINESTRA_MAX;
      // Se il disco dice che era ferma, allora i colpi c'erano stati: si ricostruisce il minimo
      // coerente, senno' al riavvio servirebbero due NUOVI blocchi per rimettersi in pausa.
      if (m.fermaFinoA) m.colpi = COLPI_PER_FERMARSI;
      // Se il disco portava un valore assurdo, quello tagliato va RISCRITTO: altrimenti al
      // prossimo riavvio si ricomincia da dieci anni, e la pausa non finisce mai davvero.
      if (ferma && m.fermaFinoA !== ferma) daCorreggere.push(m);
    }
    db = d;
    for (const m of daCorreggere) salva(m);
    ultimoGuasto = null;
  } catch (e) {
    db = null;
    ultimoGuasto = e && e.message ? e.message : String(e);
  }
  return db;
}

/**
 * Salva UNA riga. Una sola istruzione, mai leggi-modifica-scrivi in JavaScript: due processi
 * sullo stesso file (l'orfano documentato in electron/main.js) si perderebbero gli aggiornamenti
 * a vicenda. Si chiama solo quando lo stato CAMBIA, non a ogni esito.
 */
function salva(m) {
  const d = apri({ crea: true });
  if (!d) return false;
  try {
    d.prepare(
      `INSERT INTO salute (fonte, esito, ferma_fino_a, stop_fatti, aggiornata_il, retry_dopo, prove_fatte, intervento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fonte) DO UPDATE SET
         esito = excluded.esito,
         ferma_fino_a = excluded.ferma_fino_a,
         stop_fatti = excluded.stop_fatti,
         aggiornata_il = excluded.aggiornata_il,
         retry_dopo = excluded.retry_dopo,
         prove_fatte = excluded.prove_fatte,
         intervento = excluded.intervento`
    ).run(m.fonte, m.esito, m.fermaFinoA, m.stopFatti, m.aggiornataIl, m.retryDopo, m.proveFatte, m.intervento);
    ultimoGuasto = null;
    return true;
  } catch (e) {
    ultimoGuasto = e && e.message ? e.message : String(e);
    return false;   // la memoria resta buona: si perde solo la sopravvivenza al riavvio
  }
}

// ─── l'uso ───────────────────────────────────────────────────────────────────────────────────

/**
 * Registra com'e' andata una richiesta a una fonte.
 * @param {string} fonte
 * @param {{errore?: Error|null, conteggio?: number}} esitoDi
 * @returns {string} l'esito classificato
 */
function registra(fonte, { errore = null, conteggio = 0 } = {}) {
  apri();
  const esito = classifica(errore, conteggio);
  if (errore && typeof errore === 'object') {
    if (osservati.has(errore)) return esito;
    osservati.add(errore);
  }
  const m = riga(fonte);
  const eraFerma = !!m.fermaFinoA;
  // Un rifiuto locale non e' un'altra risposta della piattaforma. E una risposta
  // vecchia riuscita non puo' togliere una pausa decisa mentre era in volo.
  if (errore?.code === 'FONTE_IN_PAUSA') return m.esito;
  if (eraFerma && !errore) return esito;
  m.esito = esito;
  m.aggiornataIl = Date.now();
  if (sondeAutomatiche && (esito === 'auth' || errore?.code === 'FONTE_FORMATO')) {
    m.intervento = esito === 'auth' ? 'credenziali' : 'formato';
    salva(m);
  }

  if (esito === 'ok') {
    // Le risposte buone azzerano i contatori solo fuori dalla pausa. Lo sblocco
    // e' riservato a `richiesta`, dopo un tentativo ammesso alla scadenza.
    m.colpi = 0; m.fallimenti = 0; m.vuoti = 0;
    return esito;
  }

  if (esito === 'vuoto') {
    m.vuoti++;                       // neutro per il freno: si conta e si dichiara, non ferma
    return esito;
  }

  if (esito === 'auth') {
    // Non e' un ban: e' una credenziale o una sessione da rinnovare. Chi gestisce la sessione
    // deve accorgersene, il freno no.
    m.vuoti = 0;
    return esito;
  }

  if (esito === 'bloccato') {
    m.vuoti = 0;
    m.colpi++;
    const retry = retryDopo(errore?.retryAfter);
    if (retry) m.retryDopo = Math.max(m.retryDopo || 0, retry);
    if ((errore?.status === 429 || m.colpi >= COLPI_PER_FERMARSI) && (!eraFerma || m.fermaFinoA <= Date.now())) {
      const adesso = Date.now();
      // LA SCALA DECADE, come i colpi. `stopFatti` saliva e non scendeva mai: dalla terza pausa
      // in poi un doppio 403 passeggero valeva sei ore per sempre, cioe' il comportamento che il
      // punto 2 dell'intestazione esiste per sostituire. Se da quando la pausa precedente e'
      // finita e' passato piu' della pausa piu' lunga, quell'episodio e' chiuso: si riparte dal
      // gradino corto.
      if (adesso > m.scalaFinoA) m.stopFatti = 0;
      const finestra = FINESTRE[Math.min(m.stopFatti, FINESTRE.length - 1)];
      m.fermaFinoA = Math.max(adesso + finestra, m.retryDopo || 0);
      m.prova = null;
      m.scalaFinoA = m.fermaFinoA + FINESTRA_MAX;
      m.stopFatti++;
      salva(m);
      console.error(`[fonti] ${fonte} sembra bloccarci (${m.colpi} di fila) → ferma per ${Math.round((m.fermaFinoA - adesso) / MINUTO)} min`);
    } else if (eraFerma && retry && retry > m.fermaFinoA) {
      m.fermaFinoA = retry;
      salva(m);
    }
    return esito;
  }

  // transitorio | errore
  m.vuoti = 0;
  m.fallimenti++;
  return esito;
}

/**
 * Questa fonte va saltata adesso?
 *
 * La scadenza si TAGLIA in lettura: un valore lontanissimo (orologio che salta, file ripristinato
 * da un backup vecchio) diventerebbe una pausa infinita, cioe' la fonte non tornerebbe mai —
 * ed e' esattamente il vicolo cieco che la finestra a scadenza esiste per evitare.
 *
 * @returns {{fermo: boolean, fino: number|null, motivo: string|null}}
 */
function fermo(fonte) {
  apri();
  const m = memoria.get(fonte);
  if (m?.intervento) return { fermo: true, fino: m.fermaFinoA, motivo: m.esito,
    verifica: false, intervento: m.intervento, proveFatte: m.proveFatte, inVerifica: !!m.prova };
  if (!m || !m.fermaFinoA) return { fermo: false, fino: null, motivo: null };
  const adesso = Date.now();
  // IL TAGLIO SI SCRIVE, NON SI RICALCOLA. Prima `fino` era `min(fermaFinoA, adesso+MAX)`
  // calcolato a ogni lettura e mai riscritto: con una scadenza assurda sul disco ogni lettura
  // rispondeva "fra sei ore", per sempre — cioe' il vicolo cieco che il tetto doveva impedire.
  // Ora il valore tagliato sostituisce quello assurdo, una volta, e da li' scade davvero.
  const tetto = Math.max(adesso + FINESTRA_MAX, m.retryDopo || 0);
  if (m.fermaFinoA > tetto) { m.fermaFinoA = tetto; salva(m); }
  const fino = m.fermaFinoA;
  if (fino <= adesso) {
    return { fermo: sondeAutomatiche || !!m.prova, fino, verifica: true, motivo: m.esito,
      ...(sondeAutomatiche ? { proveFatte: m.proveFatte, inVerifica: !!m.prova } : {}) };
  }
  return { fermo: true, fino, verifica: false, motivo: m.esito,
    ...(sondeAutomatiche ? { proveFatte: m.proveFatte, inVerifica: !!m.prova } : {}) };
}

function retryDopo(valore, adesso = Date.now()) {
  if (typeof valore !== 'string' || !valore.trim()) return null;
  const s = valore.trim();
  const fine = /^\d+$/.test(s) ? adesso + Number(s) * 1000 : /GMT$/i.test(s) ? Date.parse(s) : NaN;
  return Number.isSafeInteger(fine) && fine > adesso && fine <= 8640000000000000 ? fine : null;
}

function erroreHttp(fonte, status, headers = {}) {
  const nome = { subito: 'Subito', autoscout: 'AutoScout24', moto: 'Moto.it' }[fonte] || fonte;
  const e = Object.assign(new Error(status === 429
    ? `${nome} ha limitato temporaneamente le richieste (429). La ricerca potrebbe essere incompleta; riprova più tardi.`
    : `${nome} HTTP ${status}`), {
    fonte, status, kind: status === 429 || status === 403 ? 'blocked' : status === 401 ? 'auth' : status >= 500 ? 'transient' : 'error',
    retryAfter: headers['retry-after'],
  });
  if (status === 429) registra(fonte, { errore: e });
  return e;
}

function avvisoPausa(fonte) {
  const f = fermo(fonte);
  const nome = { subito: 'Subito', autoscout: 'AutoScout24', moto: 'Moto.it' }[fonte] || fonte;
  if (f.intervento) return `${nome}: richieste sospese; necessario un intervento (${f.intervento}).`;
  if (sondeAutomatiche && f.verifica) return `${nome}: pausa terminata; ${f.inVerifica ? 'verifica in corso' : 'in attesa della sonda autorizzata dal centro'}.`;
  if (f.verifica) return `${nome}: pausa terminata. ${f.fermo ? 'Verifica della disponibilità in corso.' : 'La prossima richiesta verificherà la disponibilità della fonte.'}`;
  return `${nome}: richieste sospese dopo un blocco. Potrai riprovare dal ${new Date(f.fino).toLocaleString('it-IT')}; la disponibilità sarà verificata alla prossima richiesta.`;
}

// I risultati in cache restano consultabili; la pausa descrive la macchina ORA,
// non il momento in cui quegli annunci sono stati ricevuti. Nessuna rete qui.
function conStatoFonti(data) {
  if (!data?.sources) return data;
  const sources = { ...data.sources };
  for (const f of ['subito', 'autoscout', 'moto']) {
    if (sources[f]) sources[f] = { ...sources[f], pausa: fermo(f) };
  }
  return { ...data, sources };
}

// Si usa alla porta HTTP/JSON, non attorno alla ricerca completa: durante la
// verifica passa una sola chiamata. Il worker abilita le sonde; il monolite
// conserva la verifica su richiesta finché non viene integrato nel pool.
async function richiesta(fonte, lavoro, { sonda = false } = {}) {
  const f = fermo(fonte);
  const m = riga(fonte);
  const corrente = richieste.getStore();
  const interna = corrente?.fonte === fonte;
  const miaProva = interna && corrente.prova && corrente.prova === m.prova && f.verifica;
  const sondaAmmessa = sondeAutomatiche && sonda && f.verifica && !m.prova && !m.intervento && m.proveFatte < MAX_PROVE;
  if (f.fermo && !miaProva && !sondaAmmessa) throw Object.assign(new Error(avvisoPausa(fonte)),
    { fonte, code: 'FONTE_IN_PAUSA', kind: 'blocked', fino: f.fino });
  // I redirect appartengono allo stesso tentativo, ma ricontrollano il blocco:
  // una risposta 429 concorrente impedisce anche il salto successivo.
  if (interna) return lavoro();
  if (sonda && !sondaAmmessa) throw Object.assign(new Error('sonda non ammessa'), { code: 'SONDA_NON_AMMESSA' });
  const prova = f.verifica ? Symbol('verifica') : null;
  if (prova) m.prova = prova;
  if (sonda) {
    m.proveFatte++;
    // Prima della rete: un crash consuma il tentativo e conserva una pausa.
    // In RAM la verifica resta aperta al solo contesto AsyncLocalStorage.
    if (!salva({ ...m, fermaFinoA: Math.max(Date.now() + FINESTRE[0], m.retryDopo || 0) })) {
      m.prova = null; m.intervento = 'persistenza';
      throw Object.assign(new Error('stato della sonda non persistito'), { code: 'SONDA_PERSISTENZA' });
    }
  }
  try {
    const r = await richieste.run({ fonte, prova }, lavoro);
    // Un parser terminato dopo l'annullamento non prova la disponibilità.
    if (sonda) require('./annullo').segnale()?.throwIfAborted();
    if (prova && m.prova === prova) {
      m.prova = null; m.fermaFinoA = null; m.retryDopo = null;
      m.colpi = 0; m.fallimenti = 0; m.aggiornataIl = Date.now(); m.esito = 'ok';
      m.proveFatte = 0;
      if (!salva(m) && sonda) m.intervento = 'persistenza';
    }
    // Un nuovo 429 può invalidare la quinta prova mentre arriva la risposta.
    // Senza riapertura anche questo esito consuma l'ultimo tentativo.
    if (sonda && m.proveFatte >= MAX_PROVE) {
      m.intervento ||= 'tentativi_esauriti'; salva(m);
    }
    return r;
  } catch (e) {
    if (e?.code === 'AMR_DETAIL_LIMIT') {
      if (prova && m.prova === prova) m.prova = null;
      throw e;
    }
    if (sonda) {
      const retry = retryDopo(e?.retryAfter);
      if (retry) m.retryDopo = Math.max(m.retryDopo || 0, retry);
    }
    // Il blocco della verifica deve aggiornare la scala PRIMA della pausa generica:
    // altrimenti il successivo registra() esterno vede gia' 15 minuti di pausa e
    // non sale mai di gradino. Il WeakSet rende innocuo quel riepilogo esterno.
    if (sonda || e?.status === 429 || (prova && m.prova === prova && classifica(e) === 'bloccato')) {
      registra(fonte, { errore: e });
    }
    if (prova && m.prova === prova) {
      // Anche timeout e formato invalido NON provano che il blocco sia finito.
      m.prova = null; m.fermaFinoA = Math.max(Date.now() + FINESTRE[0], m.retryDopo || 0);
      m.esito = classifica(e); m.aggiornataIl = Date.now(); salva(m);
    }
    if (sonda && m.proveFatte >= MAX_PROVE) {
      m.intervento ||= 'tentativi_esauriti'; salva(m);
    }
    throw e;
  }
}

/**
 * Toglie il freno a mano a una fonte (o a tutte). Serve a chi gestisce la macchina.
 *
 * `apri()` PRIMA di guardare la memoria: in un processo appena avviato la memoria e' vuota, e
 * senza caricare il disco questa funzione non trovava niente da azzerare — e rispondeva lo
 * stesso "fatto". Ritorna QUANTE ne ha davvero toccate, cosi' chi chiama puo' dire la verita'
 * invece di dare per scontato che sia andata.
 *
 * @returns {number} fonti effettivamente azzerate
 */
function azzera(fonte = null) {
  apri();
  const chiavi = fonte ? [fonte] : [...memoria.keys()];
  let toccate = 0;
  for (const k of chiavi) {
    const m = memoria.get(k);
    if (!m) continue;
    m.colpi = 0; m.fallimenti = 0; m.vuoti = 0; m.fermaFinoA = null;
    m.prova = null; m.retryDopo = null;
    m.proveFatte = 0; m.intervento = null;
    // Anche la scala: togliere il freno a mano e lasciare `stopFatti` su vorrebbe dire che la
    // fonte torna subito ma il blocco dopo la ferma per il gradino piu' lungo.
    m.stopFatti = 0; m.scalaFinoA = 0;
    salva(m);
    toccate++;
  }
  return toccate;
}

/**
 * Il quadro d'insieme. `guasto` non e' un dettaglio: se il file non si apre, quello che si legge
 * qui e' la memoria di QUESTO processo e non sopravvive a un riavvio — e va detto, non intuito.
 */
function stato() {
  apri();
  const adesso = Date.now();
  const fonti = [...memoria.values()].map(m => ({
    fonte: m.fonte,
    esito: m.esito,
    ferma: !!(m.intervento || m.prova || m.fermaFinoA > adesso || sondeAutomatiche && m.fermaFinoA),
    fermaFinoA: m.fermaFinoA,
    verifica: !m.intervento && !!m.fermaFinoA && m.fermaFinoA <= adesso,
    sospetta: m.vuoti >= VUOTI_SOSPETTI,
    degradata: m.fallimenti >= DEGRADO_A,
    vuotiDiFila: m.vuoti,
    aggiornataIl: m.aggiornataIl || null,
    proveFatte: m.proveFatte,
    intervento: m.intervento,
  }));
  return {
    ok: fonti.every(f => !f.ferma && !f.degradata),
    ferme: fonti.filter(f => f.ferma).map(f => f.fonte),
    sospette: fonti.filter(f => f.sospetta).map(f => f.fonte),
    degradate: fonti.filter(f => f.degradata).map(f => f.fonte),
    fonti,
    archivio: percorso(),
    guasto: ultimoGuasto,
  };
}

/** Solo per le prove: dimentica tutto e richiudi il file. */
function _reset() {
  try { if (db) db.close(); } catch { /* gia' chiuso */ }
  db = null; caricato = false; ultimoGuasto = null; memoria.clear();
  osservati = new WeakSet();
  sondeAutomatiche = false;
}

module.exports = {
  classifica, registra, fermo, azzera, stato, percorso, richiesta, erroreHttp, retryDopo, avvisoPausa, conStatoFonti, guasto: () => ultimoGuasto,
  MOTIVO_PAUSA,
  abilitaSonde: () => { sondeAutomatiche = true; },
  sonda: (fonte, lavoro) => richiesta(fonte, lavoro, { sonda: true }), MAX_PROVE,
  COLPI_PER_FERMARSI, FINESTRE, FINESTRA_MAX, VUOTI_SOSPETTI, DEGRADO_A, COLONNE, _reset,
};
