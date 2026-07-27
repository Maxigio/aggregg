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

module.exports = { codiciAs24, unisciCodici, _indice: indice, norm };
