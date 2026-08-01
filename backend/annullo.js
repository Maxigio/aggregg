'use strict';
/**
 * QUANDO UNA RICERCA E' ABBANDONATA, SMETTE DI PESARE SULLE FONTI.
 *
 * `runSource` mette una corsa fra il lavoro e un timeout: se scade per primo, la ricerca va
 * avanti senza quella fonte e la risposta in ritardo si ignora. Ma "si ignora" non e' "si
 * ferma": la richiesta continuava a stare aperta verso il sito, a scaricare la pagina, a
 * consumare il budget e — soprattutto — a farsi contare dall'altra parte. Su una fonte che
 * blocca chi bussa troppo, il lavoro che nessuno guarda piu' e' il piu' caro che c'e'.
 *
 * Il segnale viaggia con AsyncLocalStorage, come fa gia' `budget-richieste`: gli scraper non
 * cambiano firma e non sanno di essere annullabili — chiedono il segnale al momento della
 * richiesta e lo passano a Node, che chiude la presa. Fuori da una ricerca `segnale()` torna
 * `undefined` e non cambia niente: il crawler, i test e le rotte che riusano gli stessi
 * scraper restano com'erano.
 *
 * COPRE le richieste HTTP dirette (Subito API, Autoscout GraphQL, Moto.it), che sono la via
 * normale. NON copre i ripieghi a browser: li' la pagina si chiude da se' col contesto, e
 * fermarli a meta' vorrebbe dire smontare la sessione che serve a quello dopo.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Esegue `fn` in un contesto in cui `segnale()` torna questo AbortSignal. */
function dentro(signal, fn) {
  return als.run({ signal }, fn);
}

/** Il segnale della ricerca in corso, o `undefined` fuori da una ricerca. */
function segnale() {
  const s = als.getStore();
  return s && s.signal ? s.signal : undefined;
}

/** true se la ricerca in corso e' gia' stata abbandonata: per uscire prima di ributtarsi in rete. */
function annullata() {
  const s = segnale();
  return !!(s && s.aborted);
}

module.exports = { dentro, segnale, annullata };
