'use strict';
/**
 * I CODICI-MODELLO DI AUTOSCOUT PER UN NODO SUBITO — la traduzione di livello.
 *
 * Le tre fonti tagliano il veicolo su piani diversi. "Serie 3" e' UNA voce su Subito e
 * UNDICI modelli su Autoscout (315, 316, 318, 320, 323, 324, 325, 328, 330, 335, 340),
 * perche' li' il motore E' il modello. "Adventure" e' una versione di R 1200 GS su
 * Subito e un modello a se' su Autoscout. Un ponte che collegasse solo modello↔modello
 * non potrebbe dirlo.
 *
 * Il ponte lo sa gia': `data/as24-modelli.json` (100 KB, derivato da ponte-modelli).
 * Qui si legge e basta.
 *
 * NON SOSTITUISCE quello che l'app trova da sola. Chi chiama UNISCE i due insiemi: un
 * codice in piu' allarga la pesca dentro la stessa marca, un codice al posto di un
 * altro la sposterebbe su un veicolo diverso. Misurati 7 casi auto e 8 moto in cui
 * l'app e il ponte indicano modelli diversi (Ford "Focus/Focus C-Max": l'app dice
 * Focus, il ponte dice C-Max — la voce Subito li tiene insieme e valgono entrambi).
 *
 * Autoscout accetta piu' modelli nella STESSA query — verificato: 316+318+320 torna un
 * misto dei tre. Quindi la traduzione non costa una richiesta in piu'.
 */
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'data', 'as24-modelli.json');
const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

let CACHE = null;
function indice(iniettato) {
  if (iniettato) return iniettato;
  if (CACHE) return CACHE;
  try { CACHE = require(FILE); }
  catch (e) {
    console.warn('[as24-modelli] indice assente (' + e.message + ') → resta il comportamento di prima');
    CACHE = { auto: {}, moto: {} };
  }
  return CACHE;
}

/**
 * I codici mmmv di Autoscout per (tipo, marca, famiglia) secondo il ponte. Mai null:
 * un array vuoto significa "il ponte non ha niente qui", che e' un'informazione.
 *
 * @param {string} tipo      'auto' | 'moto'
 * @param {string} marca     nome marca (qualsiasi grafia: si normalizza)
 * @param {string} famiglia  il nome della famiglia/modello COME LO CHIAMA SUBITO
 */
function codiciAs24(tipo, marca, famiglia, opts = {}) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const ix = indice(opts.indice)[t] || {};
  const m = ix[norm(marca)];
  if (!m) return [];
  return m[norm(famiglia)] || [];
}

/**
 * L'insieme da mandare ad Autoscout: quello che l'app ha risolto piu' quelli del ponte.
 * Dedup, ordine stabile (prima il codice dell'app: e' quello su cui l'app e' tarata).
 */
function unisciCodici(mmmvApp, dalPonte) {
  const out = [];
  const visto = new Set();
  for (const m of [mmmvApp, ...(dalPonte || [])]) {
    if (!m) continue;
    const s = String(m);
    if (!s.split('|')[1]) continue;          // brand-only: non e' un codice-modello
    if (visto.has(s)) continue;
    visto.add(s); out.push(s);
  }
  return out;
}

/**
 * IL PONTE LETTO AL CONTRARIO: dal codice Autoscout alla famiglia Subito.
 *
 * Serve al menu VERSIONE. Le versioni stanno sotto la famiglia Subito, ma il modello che
 * l'utente sceglie porta il nome di Autoscout — dove il motore E' il modello. "320" e
 * "Cooper S" non sono famiglie Subito, quindi il menu restava vuoto e diceva che per quel
 * modello versioni non ce n'erano: falso, stanno sotto "Serie 3" e sotto "Mini".
 *
 * Si costruisce una volta sola dall'indice che gia' c'e', al primo uso.
 *
 * Il codice si taglia a `make|model`: le due parti dopo (variante/allestimento) non
 * cambiano la famiglia e terrebbero fuori i codici scritti in forma piu' lunga.
 */
let INVERSO = null;
function inverso(iniettato) {
  if (INVERSO && !iniettato) return INVERSO;
  const ix = indice(iniettato);
  const out = { auto: new Map(), moto: new Map() };
  for (const t of ['auto', 'moto']) {
    for (const famiglie of Object.values(ix[t] || {})) {
      for (const [famiglia, codici] of Object.entries(famiglie || {})) {
        for (const c of (codici || [])) {
          const k = String(c).split('|').slice(0, 2).join('|');
          // TUTTE le famiglie, non la prima. Con "il primo vince" un codice Autoscout che
          // ne aggancia piu' d'una — 207 codici su questo indice — mandava la ricerca Subito
          // su UNA sola, scelta dall'ordine di costruzione dell'indice: cioe' su un altro
          // veicolo. Misurato sull'API di Subito: `cm=000455,000471` risponde 17.338, che e'
          // esattamente 11.582 (Golf) + 5.756 (Polo), quindi chiederle tutte non costa una
          // richiesta in piu'. (Sulle moto `bm` con la virgola risponde 400: vedi il
          // chiamante, che li' non puo' fare lo stesso.)
          const gia = out[t].get(k);
          if (!gia) out[t].set(k, [famiglia]);
          else if (!gia.includes(famiglia)) gia.push(famiglia);
        }
      }
    }
  }
  if (!iniettato) INVERSO = out;
  return out;
}

/**
 * La famiglia Subito per un codice Autoscout `make|model|...`, o null.
 * Il nome torna nella forma normalizzata del ponte ("serie3"): il risolutore Subito la
 * accetta, ed e' l'unica forma che il ponte conserva.
 */
function famigliaSubito(tipo, mmmv, opts = {}) {
  const f = famiglieSubito(tipo, mmmv, opts);
  return f.length ? f[0] : null;
}

/** TUTTE le famiglie Subito che quel codice Autoscout aggancia (puo' essere piu' d'una). */
function famiglieSubito(tipo, mmmv, opts = {}) {
  const t = tipo === 'moto' ? 'moto' : 'auto';
  const k = String(mmmv || '').split('|').slice(0, 2).join('|');
  if (!k.split('|')[1]) return [];                // brand-only: non dice quale famiglia
  return inverso(opts.indice)[t].get(k) || [];
}

module.exports = { codiciAs24, unisciCodici, famigliaSubito, famiglieSubito, _indice: indice, _inverso: inverso, norm };
