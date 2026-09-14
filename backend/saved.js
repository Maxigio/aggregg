/**
 * §11 — Ricerche salvate + motore avvisi FILTRATO (anti-rumore).
 *
 * Persistenza: <USER_DATA_PATH>/saved-searches.json (Electron) o data/ (dev),
 * stesso pattern di subito-session. Solo logica dati + calcolo avvisi: il fetch
 * (runSearch) lo orchestra server.js, che passa qui i risultati grezzi.
 *
 * Avvisi PURAMENTE price-based (§21: rating rimosso, niente più "affare"):
 *  - NUOVO (url mai visto) · CALO (>= soglia DROP_ABS/DROP_PCT)
 *  - floor anti-scam assoluto/relativo → scarta i prezzi-spazzatura
 *  - scarta annunci con anno/km mancanti (rumore)
 *  - coda persistente + set `alerted` per non ri-notificare lo stesso motivo
 */
const fs   = require('fs');
const path = require('path');
const dbmod = require('./utenti-db');

const FILE = 'saved-searches.json';   // l'archivio di prima: si importa una volta e resta dov'e'

// ─── Soglie tarabili ──────────────────────────────────────────────────────────
const FLOOR_ABS   = 300;    // € — sotto è scam/errore a prescindere dai comparabili
const FLOOR_PCT   = 0.40;   // … oppure < 40% del prezzo minimo della ricerca
const DROP_ABS    = 200;    // € — calo minimo per notificare
const DROP_PCT    = 0.03;   // … oppure 3%
const SEEN_CAP    = 800;    // max URL ricordati per ricerca (prune FIFO)
const ALERTED_CAP = 500;    // max chiavi anti-ripetizione
const MAX_RICERCHE = 50;    // max ricerche salvate per persona (il check ne fa 20 al massimo)

function filePath() {
  const userData = process.env.USER_DATA_PATH;
  if (userData && fs.existsSync(userData)) return path.join(userData, FILE);
  return path.join(__dirname, '..', 'data', FILE);
}

/**
 * OGNI RICERCA HA UN PADRONE, e senza padrone non si scrive niente.
 *
 * Fin qui l'elenco era UNO per installazione: due persone con la password piena si vedevano e
 * si cancellavano le ricerche a vicenda, e l'unica difesa era negare l'intera sezione a chi era
 * in sola lettura. Con le persone che si registrano quella difesa non regge piu' — un iscritto
 * le sue ricerche le deve avere — quindi il confine si sposta dove puo' stare davvero: nel
 * magazzino, dove ogni riga porta scritto di chi e'.
 *
 * Un utente vuoto non e' "l'utente predefinito": e' una chiamata che ha dimenticato di dire
 * CHI. Meglio un errore rumoroso che un mucchio comune chiamato "undefined".
 */
function chi(utente) {
  const u = String(utente == null ? '' : utente).trim();
  if (!u) throw new Error('saved: manca l\'utente — ogni ricerca salvata ha un padrone.');
  return u;
}

/**
 * UN MAGAZZINO CHE NON SI APRE NON E' UN MAGAZZINO VUOTO — la stessa regola che questo file
 * aveva gia' per il suo JSON. Rispondere `[]` a entrambi faceva scrivere «Nessuna ricerca
 * salvata» su un elenco che c'era, e il gesto istintivo (risalvare la ricerca) lo riscriveva
 * con quella sola voce, buttando via tutto lo storico degli avvisi.
 */
function apri() {
  const d = dbmod.apri();
  if (!d) {
    const e = new Error(`elenco delle ricerche salvate non disponibile (${dbmod.guasto() || dbmod.stato()})`);
    e.code = 'ELENCO_ILLEGGIBILE';
    throw e;
  }
  migraDalFile(d);
  return d;
}

/**
 * L'archivio di prima entra una volta sola, intestato al PROPRIETARIO: quelle ricerche le ha
 * fatte lui, e non ci sarebbe modo di indovinare un altro nome. Il file resta dov'e', intatto:
 * e' l'unica copia di prima e non si cancella per una migrazione riuscita a meta'.
 */
let migrazioneFatta = false;
function migraDalFile(d) {
  if (migrazioneFatta) return;
  migrazioneFatta = true;
  if (Number(d.prepare('SELECT COUNT(*) AS n FROM ricerche').get().n) > 0) return;   // gia' popolato
  const p = filePath();
  if (!fs.existsSync(p)) return;
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(arr)) throw new Error('il file non contiene un elenco');
  } catch (e) {
    // Non e' un dettaglio da ingoiare: vuol dire che le ricerche di prima NON sono entrate.
    console.error(`[saved] l'archivio ${p} non si legge (${e.message}): le ricerche di prima non sono state importate.`);
    return;
  }
  if (!arr.length) return;
  const ins = d.prepare('INSERT OR REPLACE INTO ricerche (utente, id, dati) VALUES (?,?,?)');
  d.exec('BEGIN');
  try {
    for (const s of arr) { migraChiavi(s); ins.run('owner', String(s.id), JSON.stringify(s)); }
    d.exec('COMMIT');
    console.log(`[saved] ${arr.length} ricerche importate dall'archivio a nome del proprietario (${p} resta dov'e').`);
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* la transazione era gia' caduta */ }
    console.error(`[saved] importazione dall'archivio fallita (${e.message}): nessuna ricerca importata.`);
  }
}

/**
 * LEGGERE NON LANCIA, SCRIVERE SI'.
 *
 * E' la regola che questo file aveva gia' e che va tenuta: su un magazzino guasto l'elenco
 * resta vuoto — non si inventa niente — ma il guasto ha un nome (`ultimoErroreElenco`) e lo
 * schermo lo dice; chi SCRIVE invece si ferma, perche' riscrivere sopra a cio' che non si e'
 * riusciti a leggere e' il modo in cui si perde tutto lo storico degli avvisi.
 */
function loadAll(utente) {
  const u = chi(utente);
  const d = dbmod.apri();
  if (!d) return [];
  migraDalFile(d);
  const righe = d.prepare('SELECT dati FROM ricerche WHERE utente=? ORDER BY rowid').all(u);
  const out = [];
  for (const r of righe) {
    try { out.push(JSON.parse(r.dati)); }
    catch (e) { console.error(`[saved] una ricerca di ${u} non si rilegge (${e.message}): saltata.`); }
  }
  // Conversione delle chiavi vecchie (URL → id stabile), una volta sola e solo se cambia
  // qualcosa davvero. Senza, un annuncio salvato prima della conversione tornava "nuovo" al
  // controllo successivo, perche' la chiave con cui lo si cerca non e' quella con cui e' stato
  // scritto. Vedi `migraChiavi`.
  let tocco = false;
  for (const s of out) if (migraChiavi(s)) tocco = true;
  if (tocco) { try { saveAll(u, out); } catch (_) { /* magazzino in sola lettura: si riprova dopo */ } }
  return out;
}

/** Riscrive l'elenco di UNA persona. In transazione: o cambia tutto o non cambia niente. */
function saveAll(utente, list) {
  const d = apri();
  const u = chi(utente);
  const tieni = new Set(list.map(s => String(s.id)));
  // IMMEDIATE perche' qui si LEGGE (la SELECT qui sotto) prima di scrivere. Con una transazione
  // deferita lo snapshot si apre alla lettura e, se un'altra connessione committa prima del primo
  // INSERT, SQLite risponde SQLITE_BUSY_SNAPSHOT senza passare dal busy handler: `busy_timeout`
  // non aspetta niente e il salvataggio muore all'istante. Il secondo scrittore non e' teorico —
  // `scripts/richieste.js` scrive sullo stesso file da un ALTRO processo, dove `withSavedLock` di
  // server.js non arriva — e quello che si perde e' il giro di un check gia' addebitato.
  d.exec('BEGIN IMMEDIATE');
  try {
    for (const r of d.prepare('SELECT id FROM ricerche WHERE utente=?').all(u)) {
      if (!tieni.has(String(r.id))) d.prepare('DELETE FROM ricerche WHERE utente=? AND id=?').run(u, String(r.id));
    }
    const su = d.prepare('INSERT INTO ricerche (utente,id,dati) VALUES (?,?,?)'
      + ' ON CONFLICT(utente,id) DO UPDATE SET dati=excluded.dati');
    for (const s of list) su.run(u, String(s.id), JSON.stringify(s));
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* gia' caduta */ }
    throw e;
  }
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Etichetta leggibile dai params se non fornita.
function defaultLabel(params) {
  return [params.marca, params.modello].filter(Boolean).join(' ').trim()
      || `${params.tipo || 'ricerca'}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
function listSaved(utente) {
  // non esporre seen/alerted (pesanti) nella lista UI; include il digest e gli
  // avvisi non letti (piccoli) per la resa.
  return loadAll(utente).map(s => {
    const unread = (s.alerts || []).filter(a => !a.letto);
    const digest = unread.reduce((d, a) => { d[a.motivo] = (d[a.motivo] || 0) + 1; return d; }, {});
    return {
      id: s.id, label: s.label, params: s.params, createdAt: s.createdAt,
      lastChecked: s.lastChecked || null,
      // L'ultimo controllo in cui hanno risposto TUTTE le fonti, e quali sono state mute
      // nell'ultimo: senza, "nessuna novita'" e "una fonte non ha parlato" sono identiche.
      lastCheckedFull: s.lastCheckedFull || null,
      fontiMute: (s.fontiMute && s.fontiMute.length) ? s.fontiMute : null,
      novita: unread.length,
      digest,
      alerts: unread.slice(-30).reverse(),   // più recenti in cima
    };
  });
}

function addSaved(utente, { label, params }) {
  apri();                       // magazzino rotto → si dice, non si scrive
  const list = loadAll(utente);
  /**
   * TETTO PER PERSONA. `seen`/`alerted`/`alerts` hanno i loro cap DENTRO una ricerca, ma il
   * NUMERO di ricerche non ne aveva: ogni riga e' un blob che `loadAll` riparsa tutto e in
   * sincrono — a ogni GET, a ogni check, e in /api/saved/altri per TUTTE le persone insieme —
   * quindi senza tetto un ciclo di POST fa crescere il magazzino senza limite su disco e
   * blocca l'event loop dell'intero server a ogni lettura. Cinquanta e' largo per l'uso vero
   * (il check ne controlla al massimo venti per giro) e tiene le letture piccole.
   */
  if (list.length >= MAX_RICERCHE) {
    const e = new Error(`Hai gia' ${list.length} ricerche salvate (il massimo e' ${MAX_RICERCHE}): cancellane una prima di salvarne un'altra.`);
    e.code = 'TROPPE_RICERCHE';
    throw e;
  }
  const s = {
    id: newId(),
    label: (label && String(label).trim()) || defaultLabel(params),
    params,
    createdAt: Date.now(),
    lastChecked: null,
    seen: {},          // url → ultimo prezzo visto
    alerted: [],        // chiavi "url|motivo[|prezzo]" già notificate
    alerts: [],         // coda avvisi { url, titolo, prezzo, motivo, ts, letto }
    fingerprint: null,
  };
  list.push(s);
  saveAll(utente, list);
  return { id: s.id, label: s.label, params: s.params, createdAt: s.createdAt, lastChecked: null, novita: 0 };
}

function removeSaved(utente, id) {
  // PRIMA il magazzino, POI la ricerca. Al contrario, su un magazzino che non si apre l'elenco
  // e' vuoto e questa funzione risponde "false" — cioe' "non c'era" — quando la verita' e'
  // "non lo so". E' la stessa risposta con cui si perde la fiducia in un comando.
  apri();
  const list = loadAll(utente);
  const next = list.filter(s => s.id !== id);
  // Non trovata = non e' tua, o non esiste. Sono la stessa risposta di proposito: chi prova a
  // cancellare la ricerca di un altro non deve poter scoprire, dal "no" diverso, che esiste.
  if (next.length === list.length) return false;
  saveAll(utente, next);
  return true;
}

function getSaved(utente, id) { return loadAll(utente).find(s => s.id === id) || null; }

/**
 * SEGNA LETTO QUELLO SU CUI HAI CLICCATO, non tutti.
 *
 * `markRead` prendeva la RICERCA e metteva `letto = true` su ogni avviso della coda, mentre
 * l'interfaccia la chiama al clic su UN avviso, prima di aprire l'annuncio. Siccome la lista
 * espone solo i non letti, gli altri sparivano dalla scheda al primo ridisegno — non letti,
 * marcati letti dal clic sul primo — e dopo trenta giorni la potatura li toglieva dal file.
 * Con piu' persone il danno si moltiplicava: un collega che apriva un annuncio azzerava la
 * coda del proprietario.
 *
 * @param {string} url  l'annuncio su cui si e' cliccato. Senza, si segna tutta la coda: e' il
 *                      bottone "segna tutti letti", un gesto esplicito e diverso dal clic.
 */
function markRead(utente, id, url) {
  apri();                       // "non trovato" e "non leggibile" non sono la stessa risposta
  const list = loadAll(utente);
  const s = list.find(x => x.id === id);
  if (!s) return false;
  const coda = s.alerts || [];
  if (url) {
    /**
     * TUTTI GLI AVVISI DI QUELL'ANNUNCIO, perche' il clic dice solo l'URL.
     *
     * Un annuncio ne puo' avere piu' d'uno vivo insieme — 'nuovo' al primo avvistamento, 'calo'
     * a un controllo dopo — e le chiavi di `alerted` sono distinte, quindi convivono. La coda
     * e' in ordine cronologico ma lo schermo mostra il piu' recente in cima: cercare il PRIMO
     * non letto segnava il piu' VECCHIO, cioe' un avviso che l'utente non ha aperto, e quello
     * su cui aveva cliccato tornava non letto al ricarico. Aprire l'annuncio li riguarda tutti,
     * ed e' gia' cio' che lo schermo fa (toglie ogni riga con quell'url).
     */
    const suoi = coda.filter(x => x.url === url && !x.letto);
    if (!suoi.length) return false;
    for (const a of suoi) a.letto = true;
  } else {
    coda.forEach(a => { a.letto = true; });
  }
  saveAll(utente, list);
  return true;
}

// ─── Motore avvisi ──────────────────────────────────────────────────────────
// Firma leggera: conteggio + price-vector (ordinato) + hash dei top URL. Include
// i prezzi così un calo profondo cambia comunque la firma (non lo maschera).
function fingerprint(results) {
  const prezzi = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const topUrls = results.slice(0, 20).map(r => r.url || '').join('|');
  let h = 0;
  for (let i = 0; i < topUrls.length; i++) h = (h * 31 + topUrls.charCodeAt(i)) | 0;
  return `${results.length}:${prezzi.join(',')}:${h}`;
}

/**
 * Calcola gli avvisi FILTRATI per una ricerca dato il set di risultati (già
 * analizzato). NON muta la ricerca: ritorna { alerts, fingerprint }.
 * `seen` è lo stato precedente (search.seen).
 */
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeAlerts(search, results) {
  const seen = search.seen || {};
  // PRIMO check (nessun baseline): NON inondare con "tutto è nuovo". Si stabilisce
  // solo la baseline (seen) in silenzio; gli avvisi partono dalle modifiche dopo.
  const isBaseline = Object.keys(seen).length === 0;
  if (isBaseline) return { alerts: [], fingerprint: fingerprint(results), alertedKeys: search.alerted || [] };

  const prezzi = results.map(r => r.prezzo).filter(p => p != null && p > 0);
  // Floor relativo alla MEDIANA (non al minimo: il minimo è spesso lo scam stesso
  // e si auto-sabota). Sotto floor → mai un avviso, anche senza comparabili.
  const floor  = Math.max(FLOOR_ABS, median(prezzi) * FLOOR_PCT);
  const alerted = new Set(search.alerted || []);
  const out = [];

  for (const r of results) {
    if (!r.url || r.prezzo == null || r.prezzo <= 0) continue;
    /**
     * UN ANNUNCIO DI UN ALTRO MODELLO NON SUONA.
     *
     * Una ricerca salvata su un modello che Autoscout non ha a catalogo si allarga alla
     * marca: gli avvisi che arrivavano potevano essere di altri modelli, e nel pannello
     * erano identici agli altri — «Nuovo · <titolo> · <prezzo>». Una ricerca salvata segue
     * QUEL modello, non la marca.
     *
     * Non e' un post-filtro che nasconde: l'annuncio resta visibile quando la ricerca la
     * fai, semplicemente non ti sveglia. E `recordCheck` lo registra comunque in `seen`,
     * cosi' se domani la risoluzione del modello migliora non arriva come "nuovo" un mezzo
     * che sta in lista da settimane.
     */
    // RIGA GEMELLA di `fuoriBersaglio()` in frontend/app.js: browser e avvisi devono dare
    // lo stesso verdetto sugli stessi ingressi (il test lo blinda). Il secondo canale —
    // `versioneEsito`, la verifica versioni del server — qui mancava, e l'avviso suonava
    // per un annuncio che lo schermo della stessa ricerca nasconde come «non e' quella
    // versione»: la coppia peggiore, suona ED e' invisibile.
    if ((r.dichiarazione && r.dichiarazione !== 'esatto' && r.dichiarazione !== 'senza-versione')
      || r.versioneEsito === 'smentita') continue;
    // review: NON gateare su anno/km null. recordCheck (sotto) registra COMUNQUE l'annuncio in
    // `seen` → col vecchio gate un annuncio nuovo con km=null (comune su Moto.it/Subito) non
    // avvisava MAI e restava soppresso per sempre (prev != null al giro dopo). Il rumore è già
    // contenuto da prezzo>0 + floor anti-scam + soglie di calo; un annuncio nuovo È nuovo.
    if (r.prezzo < floor) continue;                 // floor anti-scam (price-based)

    const k = chiaveAnnuncio(r);
    const prev = seen[k];
    let motivo = null, key = null;
    if (prev == null) {
      // Annuncio NUOVO (mai visto). §21: niente più 'affare' (rating rimosso).
      motivo = 'nuovo'; key = `${k}|nuovo`;
    } else if (r.prezzo <= prev - Math.max(DROP_ABS, prev * DROP_PCT)) {
      motivo = 'calo';  key = `${k}|calo|${r.prezzo}`;   // include prezzo → ulteriori cali ri-notificano
    }

    if (!motivo || alerted.has(key)) continue;
    alerted.add(key);
    out.push({ url: r.url, titolo: r.titolo, prezzo: r.prezzo, motivo, ts: Date.now(), letto: false });
  }
  return { alerts: out, fingerprint: fingerprint(results), alertedKeys: [...alerted] };
}

// Cap FIFO su oggetto (preserva ordine d'inserimento delle chiavi stringa).
function capObject(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const drop = keys.slice(0, keys.length - max);
  for (const k of drop) delete obj[k];
  return obj;
}

/**
 * Applica l'esito di un check a una ricerca salvata su disco: accoda i nuovi
 * avvisi, aggiorna seen/alerted/fingerprint/lastChecked. `extraSeen` = prezzi
 * dei tracciati "profondi" ri-fetchati (two-tier). Ritorna i nuovi avvisi.
 */
/** La fonte di un URL salvato, per capire quali `seen` non sono verificabili adesso. */
/**
 * L'IDENTITA' DI UN ANNUNCIO, che non e' il suo indirizzo.
 *
 * `seen` e `alerted` erano indicizzati per URL. Ma l'URL di Subito contiene il TITOLO
 * scritto dal venditore: se lui lo ritocca — abbassa il prezzo e lo scrive, aggiunge
 * "VENDUTA", corregge un dettaglio — l'URL cambia, e da qui in poi quello e' un altro
 * annuncio: arriva un avviso "nuovo" per un mezzo in lista da settimane, e lo storico del
 * suo prezzo (cioe' la base per accorgersi di un calo) riparte da zero.
 *
 * Le fonti che un'identita' stabile la dichiarano la mettono in `id` (vedi subito-api.js).
 * Le altre restano sull'URL, che li' non porta il titolo dentro.
 */
const chiaveAnnuncio = r => (r && r.id) || (r && r.url) || null;

const fonteDaUrl = u => /^subito:/i.test(u) ? 'subito'
  : /(^|\.)subito\.it\//i.test(u) ? 'subito'
  : /(^|\.)autoscout24\.[a-z]+\//i.test(u) ? 'autoscout'
  : /(^|\.)moto\.it\//i.test(u) ? 'moto' : null;

/**
 * IL PASSATO SI CONVERTE, NON SI BUTTA.
 *
 * Il giorno del passaggio, i visti e le chiavi anti-ripetizione gia' su disco sono
 * indicizzati per URL: senza conversione il primo controllo vedrebbe OGNI annuncio come
 * nuovo — una raffica di avvisi falsi su tutte le ricerche salvate insieme — e lo storico
 * dei prezzi ripartirebbe da zero. Il progressivo di Subito sta anche in coda al vecchio
 * URL (".../…-cagliari-651863039.htm"), quindi la conversione e' esatta e si fa una volta.
 */
const idDaUrlSubito = u => {
  if (typeof u !== 'string' || /^subito:/.test(u)) return null;
  if (!/(^|\.)subito\.it\//i.test(u)) return null;
  const m = u.match(/-(\d+)\.htm(?:$|[?#])/);
  return m ? 'subito:' + m[1] : null;
};
/** Ritorna true se ha cambiato qualcosa (allora la ricerca va riscritta su disco). */
function migraChiavi(s) {
  let tocco = false;
  if (s.seen) {
    const nuovo = {};
    for (const [k, v] of Object.entries(s.seen)) {
      const id = idDaUrlSubito(k);
      if (id) tocco = true;
      nuovo[id || k] = v;                      // l'ordine di inserimento resta quello, e conta (vedi capObject)
    }
    if (tocco) s.seen = nuovo;
  }
  if (Array.isArray(s.alerted)) {
    const conv = s.alerted.map(k => {
      const i = String(k).indexOf('|');
      if (i < 0) return k;
      const id = idDaUrlSubito(String(k).slice(0, i));
      if (!id) return k;
      tocco = true;
      return id + String(k).slice(i);
    });
    if (tocco) s.alerted = conv;
  }
  return tocco;
}

/**
 * @param {string[]} [opts.fontiMute] fonti che in questo giro non hanno risposto: i loro
 *   annunci NON vanno sfrattati da `seen`. Un annuncio di una fonte giu' non e' "non
 *   visto", e' "non verificabile" — e trattarlo da vecchio lo fa tornare "nuovo" al
 *   ritorno della fonte, cioe' un falso avviso su un mezzo in lista da settimane.
 */
function recordCheck(utente, id, results, { extraSeen = {}, removedUrls = [], fontiMute = [] } = {}) {
  apri();
  const list = loadAll(utente);
  const s = list.find(x => x.id === id);
  if (!s) return [];

  const { alerts, fingerprint: fp, alertedKeys } = computeAlerts(s, results);

  // seen ← prezzi correnti (shallow) + ri-fetch profondi; rimuovi i 404 (venduti).
  const seen = s.seen || {};
  for (const r of results) { const k = chiaveAnnuncio(r); if (k && r.prezzo != null && r.prezzo > 0) seen[k] = r.prezzo; }
  for (const [u, p] of Object.entries(extraSeen)) if (p != null && p > 0) seen[u] = p;
  for (const u of removedUrls) delete seen[u];

  // Coda avvisi: prune dei LETTI più vecchi di 30g (i non-letti restano), poi cap.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const queue = [...(s.alerts || []), ...alerts].filter(a => !a.letto || (a.ts || 0) >= cutoff);

  /**
   * IL TAGLIO DEVE PRENDERE I PIU' VECCHI DA VEDERE, NON I PRIMI ENTRATI.
   *
   * L'ordine delle chiavi di `seen` e' quello di INSERIMENTO, cioe' il PRIMO avvistamento, e
   * `capObject` taglia da li'. Un annuncio ancora VIVO ma entrato mesi fa veniva sfrattato, e al
   * check successivo `prev` era di nuovo null: arrivava come "nuovo" un mezzo in lista da
   * settimane. Riassegnare la chiave non basta — in JS non sposta la posizione — quindi quello
   * che si e' visto ADESSO si toglie e si rimette, e finisce in coda.
   */
  const inCoda = u => {
    if (u && Object.prototype.hasOwnProperty.call(seen, u)) { const p = seen[u]; delete seen[u]; seen[u] = p; }
  };
  for (const r of results) inCoda(chiaveAnnuncio(r));
  // I "non verificabili" vanno IN FONDO, dopo i visti davvero: sono gli unici che un
  // controllo successivo non puo' recuperare da solo, quindi sono i piu' cari da tenere.
  // Messi prima, una fonte molto prolifica li avrebbe spinti fuori lo stesso.
  if (fontiMute.length) {
    const mute = new Set(fontiMute);
    for (const u of Object.keys(seen)) if (mute.has(fonteDaUrl(u))) inCoda(u);
  }
  s.seen        = capObject(seen, SEEN_CAP);
  s.alerted     = alertedKeys.slice(-ALERTED_CAP);
  s.alerts      = queue.slice(-200);
  s.fingerprint = fp;
  s.lastChecked = Date.now();
  // Un controllo fatto con una fonte muta NON e' un controllo completo. Prima l'informazione
  // serviva solo a non sfrattare da `seen` gli annunci della fonte caduta e poi veniva buttata:
  // il record timbrava l'ora e basta, e la scheda diceva "controllata adesso, nessuna novita'"
  // anche quando Autoscout — dove stava il grosso degli annunci — era andato in timeout.
  s.fontiMute = fontiMute.length ? fontiMute.slice() : null;
  if (!fontiMute.length) s.lastCheckedFull = s.lastChecked;
  saveAll(utente, list);
  return alerts;
}

/** Il perche' l'elenco non si e' letto (null se sta bene): la rotta lo porta a schermo. */
function ultimoErroreElenco() {
  const s = dbmod.stato();
  if (s === 'ok') return null;
  return s === 'assente'
    ? `il magazzino delle ricerche non e' raggiungibile (${dbmod.percorso()})`
    : `il magazzino delle ricerche non si apre (${dbmod.guasto() || 'motivo sconosciuto'})`;
}

module.exports = {
  listSaved, addSaved, removeSaved, getSaved, markRead, ultimoErroreElenco,
  computeAlerts, recordCheck, fingerprint,
  _const: { FLOOR_ABS, FLOOR_PCT, DROP_ABS, DROP_PCT, MAX_RICERCHE },
};
