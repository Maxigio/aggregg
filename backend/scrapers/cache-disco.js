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
 * @returns {function} conCache(chiave, produci, sospettoSe?) → Promise
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
    const chiavi = Object.keys(c.voci);
    if (chiavi.length > max) {
      // Si tengono le piu' recenti. Non e' una LRU vera (conta la scrittura, non la lettura) ma
      // basta a impedire la crescita, e costa un sort su una lista che per definizione e' corta.
      const vive = chiavi.sort((a, b) => c.voci[b].t - c.voci[a].t).slice(0, max);
      const nuove = {};
      for (const k of vive) nuove[k] = c.voci[k];
      c.voci = nuove;
    }
    // Una cache che non riesce a scrivere continua a funzionare — in memoria — ma il costo
    // si paga al riavvio, e in silenzio non se ne accorge nessuno.
    try { fs.writeFileSync(fileScrittura, JSON.stringify(c)); scritturaKo = false; }
    catch (e) {
      if (!scritturaKo) { scritturaKo = true; console.warn('[' + tag + '] cache non scrivibile in ' + fileScrittura + ' (' + e.message + '): resta in memoria e si perde al riavvio'); }
    }
  };

  const inVolo = new Map();
  return async function conCache(chiave, produci, sospettoSe) {
    const c = leggi();
    const v = c.voci[chiave];
    if (v && Date.now() - v.t < ttl) return v.d;
    if (inVolo.has(chiave)) return inVolo.get(chiave);
    const p = (async () => {
      try {
        const d = await produci();
        const sospetto = sospettoSe ? !!sospettoSe(d) : false;
        c.voci[chiave] = { t: sospetto ? Date.now() - ttl + ttlCorto : Date.now(), d };
        scrivi();
        return d;
      } catch (e) {
        if (v) { console.warn('[' + tag + '] ' + chiave + ' KO (' + e.message + '): servo la cache vecchia'); return v.d; }
        throw e;
      } finally { inVolo.delete(chiave); }
    })();
    inVolo.set(chiave, p);
    return p;
  };
}

module.exports = { crea };
