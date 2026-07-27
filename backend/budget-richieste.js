'use strict';
/**
 * QUANTE RICHIESTE COSTA UNA RICERCA — contate, non stimate.
 *
 * AMR interroga tre fonti per ogni ricerca. Il conto a mano si sbaglia: basta un ramo
 * che parte solo in certi casi (l'unione multi-grafia di AS24 sulle moto, il ripiego a
 * zero risultati, un redirect) e il costo raddoppia senza che nessuno lo veda. Qui il
 * numero si misura e si scrive nel log, cosi' una richiesta in piu' e' un fatto e non
 * una discussione.
 *
 * NON limita niente. Se il tetto viene superato lo DICHIARA e la ricerca prosegue:
 * troncare una ricerca a meta' per far tornare un numero sarebbe peggio del problema.
 *
 * Il contesto viaggia con AsyncLocalStorage: gli scraper chiamano `conta('subito')` e
 * non sanno di chi stanno contando. Fuori da una ricerca `conta` non fa NULLA — il
 * crawler, i test e le rotte che riusano gli stessi scraper non vengono toccati.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Oltre questo, una ricerca e' anomala e lo si scrive. Non e' un limite: e' una soglia. */
const TETTO = Number(process.env.AMR_BUDGET_TETTO || 20);

/**
 * Registra UNA richiesta di rete a una fonte. No-op fuori da una ricerca.
 * @param {string} fonte  'subito' | 'as24' | 'motoit' | …
 * @param {string} [nota] dettaglio facoltativo (es. 'cache-miss recupero')
 */
function conta(fonte, nota) {
  const s = als.getStore();
  if (!s) return;                       // fuori ricerca: nessun contesto, nessun costo
  s.per[fonte] = (s.per[fonte] || 0) + 1;
  s.tot++;
  if (nota) (s.note[fonte] = s.note[fonte] || []).push(nota);
}

/** Il conto corrente della ricerca in corso, o null. Per i test e la diagnostica. */
function corrente() {
  const s = als.getStore();
  return s ? { tot: s.tot, per: { ...s.per }, note: { ...s.note } } : null;
}

/** Riga leggibile: `subito 2 · as24 3 · motoit 3 = 8`. */
function riga(conto) {
  const parti = Object.entries(conto.per)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => f + ' ' + n + ((conto.note[f] || []).length ? ' (' + conto.note[f].join(', ') + ')' : ''));
  return (parti.join(' · ') || 'nessuna richiesta') + ' = ' + conto.tot;
}

/**
 * Avvolge una ricerca: apre il contesto, esegue, scrive il conto.
 * Rilancia l'errore DOPO aver scritto il conto — una ricerca fallita e' proprio quella
 * di cui si vuole sapere quante richieste ha bruciato prima di cadere.
 *
 * @param {string} etichetta  es. 'moto Triumph Bonneville'
 * @param {Function} fn       la ricerca vera
 * @param {Function} [log]    iniettabile nei test
 */
async function perRicerca(etichetta, fn, log = console.log) {
  const store = { tot: 0, per: {}, note: {} };
  return als.run(store, async () => {
    let errore = null;
    try { return await fn(); }
    catch (e) { errore = e; throw e; }
    finally {
      const sopra = store.tot > TETTO ? '  ⚠ SOPRA IL TETTO (' + TETTO + ')' : '';
      const ko = errore ? '  [caduta: ' + errore.message + ']' : '';
      log('[budget] ' + etichetta + ' → ' + riga(store) + sopra + ko);
    }
  });
}

module.exports = { conta, corrente, perRicerca, riga, TETTO };
