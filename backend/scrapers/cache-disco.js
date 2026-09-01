'use strict';
/**
 * La cache su disco degli scraper. Era la stessa identica funzione copiata in cinque file — osm,
 * eprel, bilstein, wheelsize, insella — diversa solo per l'etichetta nel log. Adesso e' una sola,
 * e le tre cose che nella copia si dimenticavano stanno qui dentro una volta per tutte:
 *
 *  - SCHEMA. La cache conserva gli oggetti GIA' INTERPRETATI, non la risposta grezza. Cambiare un
 *    parser senza alzare il numero significa continuare a servire il formato vecchio per tutto il
 *    TTL senza accorgersene: e' successo davvero coi telai del Safety Gate, che risultavano zero
 *    su 1.041 mentre erano nei dati. insella era rimasta l'unica senza.
 *  - TETTO. La chiave arriva da una query string, quindi il numero di chiavi possibili e' quello
 *    che un client vuole. Senza tetto il file cresceva senza fine, e ogni miss lo riscrive INTERO:
 *    costo O(n) per scrittura su un n che cresce. Oltre il tetto si buttano le voci piu' vecchie.
 *  - VECCHIA MA VIVA. Se la fonte cade e abbiamo una copia scaduta, si serve quella: un dato di
 *    ieri vale piu' di un errore. Il risultato SOSPETTO (vuoto, parziale) si archivia con vita
 *    breve, cosi' un cambio di markup non congela la fonte per una settimana.
 *
 * Chi chiama passa la chiave GIA' NORMALIZZATA: la chiave deve descrivere la richiesta che parte
 * davvero, altrimenti due scritture diverse si sovrappongono o la stessa si ripete due volte.
 */
const fs = require('fs');
const path = require('path');

const ORA = 60 * 60 * 1000;

/**
 * DOVE SI SCRIVE. I chiamanti passano `<radice>/data/*.json`, calcolato da __dirname. Nel
 * pacchetto Electron quella radice finisce dentro app.asar, che e' di SOLA LETTURA: ogni
 * writeFileSync falliva e il `catch` la ingoiava, quindi nessuna cache sopravviveva a un
 * riavvio e a ogni avvio si ricrawlava tutto da zero — proprio la raffica che si becca il
 * 403. Il file impacchettato resta la SEMENTE (si legge se non c'e' ancora niente di
 * scritto), e si scrive accanto ai dati utente, come fanno gia' auth.js e saved.js.
 */
function percorsoScrittura(file) {
  const ud = process.env.USER_DATA_PATH;
  if (!ud || !fs.existsSync(ud)) return file;
  const dir = path.join(ud, 'cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return file; }
  return path.join(dir, path.basename(file));
}

/**
 * @param {string} file      percorso del JSON su disco
 * @param {object} opt       { tag, schema, ttl, ttlCorto, max }
 * @returns {function} conCache(chiave, produci, sospettoSe?, opzioni?) → Promise
 *   opzioni.forza: interroga la fonte anche con una copia fresca in cache, e il risultato nuovo
 *   prende il posto della voce. Serve agli script di build: un rilancio dentro il TTL riserviva
 *   il crawl PRECEDENTE senza toccare la rete, e riscriveva su disco gli stessi dati vecchi.
 */
function crea(file, opt = {}) {
  const tag = opt.tag || 'cache';
  const schema = opt.schema == null ? 1 : opt.schema;
  const ttl = opt.ttl || 7 * 24 * ORA;
  const ttlCorto = opt.ttlCorto || 15 * 60 * 1000;
  const max = opt.max || 500;

  const fileScrittura = percorsoScrittura(file);
  let scritturaKo = false;   // si dice UNA volta, non a ogni miss

  let memo = null;
  const leggi = () => {
    if (!memo) {
      // I `.tmp` di un processo ucciso a meta' scrittura restano sul disco (col PID nel nome non
      // vengono mai riscritti). Alla prima lettura si buttano quelli piu' vecchi di un'ora: uno
      // recente puo' essere di un processo vivo che sta scrivendo adesso.
      try {
        const dir = path.dirname(fileScrittura), base = path.basename(fileScrittura) + '.';
        for (const f of fs.readdirSync(dir)) {
          if (!f.startsWith(base) || !f.endsWith('.tmp')) continue;
          const p = path.join(dir, f);
          try { if (Date.now() - fs.statSync(p).mtimeMs > ORA) fs.unlinkSync(p); } catch (_) { /* sparito intanto */ }
        }
      } catch (_) { /* cartella non leggibile: non e' compito di questa riga */ }
      // Prima quello che abbiamo scritto noi, poi la semente impacchettata.
      for (const p of (fileScrittura === file ? [file] : [fileScrittura, file])) {
        try { memo = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { memo = null; }
        if (memo) break;
      }
      if (!memo || memo.schema !== schema) memo = { schema, voci: {} };   // formato vecchio: si riparte
      if (!memo.voci) memo.voci = {};
    }
    return memo;
  };
  const scrivi = () => {
    const c = leggi();
    const adesso = Date.now();
    const scadenza = v => (v.scade != null ? v.scade : v.t + ttl);
    // PRIMA le scadute, sempre: una voce oltre la sua vita non serve a nessuno e non deve
    // occupare un posto. Poi, se ancora troppe, si tengono quelle che scadono piu' TARDI —
    // cioe' per scadenza effettiva, non per `t`: cosi' un sospetto fresco (vita 15') non
    // sfratta una voce buona di ieri (vita 7 giorni).
    for (const k of Object.keys(c.voci)) if (scadenza(c.voci[k]) <= adesso) delete c.voci[k];
    const chiavi = Object.keys(c.voci);
    if (chiavi.length > max) {
      const vive = chiavi.sort((a, b) => scadenza(c.voci[b]) - scadenza(c.voci[a])).slice(0, max);
      const nuove = {};
      for (const k of vive) nuove[k] = c.voci[k];
      c.voci = nuove;
    }
    // SI SCRIVE ACCANTO, POI SI RINOMINA. Scrivendo dritto sul file di destinazione, un
    // processo ucciso o un disco pieno a meta' scrittura lasciavano un JSON troncato: `leggi()`
    // non riesce a interpretarlo e riparte da `{voci:{}}`, cioe' la cache sparisce TUTTA. Non e'
    // un caso di scuola: e' esattamente la raffica di ricrawl che questa cache esiste per
    // evitare (vedi il commento in cima, "proprio la raffica che si becca il 403"). Il rename
    // e' atomico dentro lo stesso filesystem, e il `.tmp` sta nella stessa cartella apposta.
    // Stesso schema gia' usato da backend/auth.js:76.
    //
    // Una cache che non riesce a scrivere continua a funzionare — in memoria — ma il costo
    // si paga al riavvio, e in silenzio non se ne accorge nessuno.
    // Il nome del file d'appoggio porta il PID: con un nome fisso due processi sulla stessa cache
    // (l'orfano documentato in electron/main.js) scrivevano sullo stesso `.tmp`, e il rename di uno
    // pubblicava il file che l'altro stava ancora riempiendo — cioe' di nuovo un JSON troncato.
    const tmp = fileScrittura + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(c)); fs.renameSync(tmp, fileScrittura); scritturaKo = false; }
    catch (e) {
      // Il mezzo file non resta in giro: se il rename non e' avvenuto, quel `.tmp` non e' la
      // cache di nessuno e al prossimo giro darebbe solo fastidio.
      try { fs.unlinkSync(tmp); } catch (_) { /* non c'era: meglio cosi' */ }
      if (!scritturaKo) { scritturaKo = true; console.warn('[' + tag + '] cache non scrivibile in ' + fileScrittura + ' (' + e.message + '): resta in memoria e si perde al riavvio'); }
    }
  };

  const inVolo = new Map();
  return async function conCache(chiave, produci, sospettoSe, opzioni) {
    const c = leggi();
    const v = c.voci[chiave];
    const fresca = !!v && Date.now() < (v.scade != null ? v.scade : v.t + ttl);
    if (fresca && !(opzioni && opzioni.forza)) return v.d;
    if (inVolo.has(chiave)) return inVolo.get(chiave);
    const p = (async () => {
      try {
        const d = await produci();
        const sospetto = sospettoSe ? !!sospettoSe(d) : false;
        // Il SOSPETTO vive poco, ma non lo si data nel passato: la sfoltitura tiene le voci col `t`
        // piu' alto, e una voce retrodatata di sette giorni era la prima a saltare a cache piena —
        // vita breve che diventava vita zero. Porta invece la sua scadenza esplicita.
        c.voci[chiave] = sospetto ? { t: Date.now(), scade: Date.now() + ttlCorto, d } : { t: Date.now(), d };
        scrivi();
        return d;
      } catch (e) {
        // SCADUTA E' SCADUTA. Qui la copia vecchia si serviva lo stesso quando la fonte
        // cadeva, e in silenzio: un `console.warn` nei log, e a schermo un dato di sette
        // giorni prima (di un giorno per i richiami) indistinguibile da uno appena preso.
        // Era il difetto di questa bonifica nella sua forma piu' pura — il silenzio di una
        // fonte che diventa un fatto — e ce l'avevano tutte e otto le cache.
        // Decisione del proprietario: se la fonte non risponde si dice e basta. L'errore
        // arriva al chiamante, che ha gia' il suo modo di dichiararlo ("archivio non
        // raggiungibile", "fonte in pausa dopo un blocco", la pill della fonte).
        // Con `forza` la copia puo' essere ancora fresca: il messaggio "scaduta" vale solo se lo e'.
        if (v && !fresca) console.warn('[' + tag + '] ' + chiave + ' KO (' + e.message + '): la copia in cache e\' scaduta, non la servo');
        throw e;
      } finally { inVolo.delete(chiave); }
    })();
    inVolo.set(chiave, p);
    return p;
  };
}

module.exports = { crea };
