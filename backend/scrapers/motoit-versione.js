'use strict';
/**
 * DAL TESTO SCRITTO AL CODICE-VERSIONE DI MOTO.IT.
 *
 * E' l'unica traduzione che il campo versione fa. Subito e Autoscout una ricerca testuale
 * ce l'hanno e ricevono quello che hai scritto; Moto.it vuole un codice opaco (`bike=`),
 * quindi li' il testo va risolto — contro il catalogo di Moto.it, non contro un altro.
 *
 * DUE COSE MISURATE, ed e' il motivo per cui questo file esiste invece di un `indexOf`.
 *
 * 1. I NOMI DI MOTO.IT SI PORTANO DENTRO IL MODELLO E GLI ANNI: "MT-07 ABS (2014 - 16)",
 *    non "ABS". Confrontando il testo cosi' com'e', le parole del modello combaciano da
 *    sole e sembra che abbia riconosciuto una versione quando ha solo ri-riconosciuto il
 *    modello — che avevamo gia' filtrato. Misurato: lasciandocele, lo "zero" scende allo
 *    0,6%, che sembra un successo; togliendole viene 61%, ed e' il numero vero (sei
 *    titoli su dieci un allestimento non lo nominano affatto).
 *
 * 2. L'AND ASSOLUTO SVUOTA. Una parola che quel catalogo non scrive azzera tutto, e a
 *    schermo "nessun risultato" e' indistinguibile da "non esistono moto cosi'". Quindi
 *    la parola che azzererebbe si SCARTA, e si dice quale.
 *
 * PIU' CODICI NON SI POSSONO CHIEDERE — verificato: `bike=a,b` prende il primo e ignora
 * il secondo senza dare errore, `bike=a|b` risponde vuoto. Ma non serve chiederli: Moto.it
 * SPEZZA LA STESSA MOTO PER PERIODO ("MT-07 (2014-16)", "(2017-18)", "(2018-20)",
 * "(2021-24)" sono quattro voci della stessa moto), e ogni annuncio dichiara la propria
 * versione nello slug dell'URL. Quindi:
 *
 *   una sola versione risolta  → si filtra alla fonte con `bike=`
 *   piu' d'una                 → niente `bike=`, e si tengono gli annunci il cui slug sta
 *                                fra quelle risolte. Esatto, e zero richieste in piu'.
 *
 * Non si sceglie mai una versione fra piu' candidate: mostrerebbe una moto diversa da
 * quella chiesta senza che si veda.
 */

const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Parole intere; lettere e cifre restano attaccate dove lo sono ("35kw" → "35kw"). */
const parole = s => norm(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

/**
 * Lo slug che Moto.it mette nell'URL dell'annuncio, ricavato dal nome della versione.
 *   "MT-07 (2014 - 16)"      → "mt-07-2014-16"
 *   "SH 125 i ABS (2013-17)" → "sh-125-i-abs-2013-17"
 * Verificato sugli URL veri: e' il quarto segmento del percorso.
 */
function slugVersione(nome) {
  return norm(nome).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Lo slug-versione di un URL annuncio Moto.it, o null. */
function slugDaUrl(url) {
  const p = String(url || '').split('?')[0].split('/');
  // …/moto-usate/<marca>/<modello>/<versione>/<id>
  return p.length >= 7 ? p[6] || null : null;
}

/**
 * @param {Array}  bikes   [{name, code}] da motoit-models.getModelBikes
 * @param {string} testo   quello che l'utente ha scritto
 * @param {object} ctx     {marca, modello} — le loro parole escono dal confronto
 * @returns {{versioni:Array, tenute:Array, scartate:Array}}
 *          `versioni` vuoto = il testo non dice niente che questo catalogo conosca.
 */
function risolvi(bikes, testo, ctx = {}) {
  const out = { versioni: [], tenute: [], scartate: [] };
  const lista = (bikes || []).filter(b => b && b.name && b.code);
  if (!lista.length || !String(testo || '').trim()) return out;

  const via = new Set([...parole(ctx.marca), ...parole(ctx.modello)]);
  const chieste = parole(testo).filter(w => !via.has(w));
  if (!chieste.length) return out;

  const dentro = lista.map(b => ({ b, p: ' ' + parole(b.name).join(' ') + ' ' }));
  let vivi = dentro;
  for (const w of chieste) {
    const prossimi = vivi.filter(x => x.p.includes(' ' + w + ' '));
    if (prossimi.length) { vivi = prossimi; out.tenute.push(w); }
    else out.scartate.push(w);
  }
  if (!out.tenute.length) return out;      // niente riconosciuto: nessun filtro, e si dice

  out.versioni = vivi.map(x => ({ nome: x.b.name, code: x.b.code, slug: slugVersione(x.b.name) }));
  return out;
}

module.exports = { risolvi, slugVersione, slugDaUrl, _parole: parole };
