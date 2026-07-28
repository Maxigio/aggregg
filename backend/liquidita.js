'use strict';
/**
 * Liquidità di un modello: quanti esemplari circolano in Italia e quanti passano di mano
 * in un anno. Per un operatore è la risposta a "quanto ci metto a rivenderla".
 *
 * Dati: data/liquidita-modelli.json, generato da scripts/build-liquidita.js dall'ACI
 * Autoritratto (CC-BY 4.0 → attribuzione obbligatoria in UI).
 *
 * Due avvertenze che vanno dette all'utente, non nascoste:
 *  - sono AGGREGATI di modello: non dicono niente sul singolo veicolo in vendita;
 *  - le MOTO non esistono in questo dato (l'Autoritratto le ha solo per cilindrata e
 *    provincia, mai per modello). Per le moto si risponde "non disponibile", non si stima.
 */
const L = require('../data/liquidita-modelli.json');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Il rapporto trasferimenti/parco ha senso solo su un parco abbastanza grande. Sotto, incrocia
 * due tavole ACI tagliate diversamente — i passaggi di una riga possono finire su un'altra — e
 * produce rumore fino all'impossibile: misurato su data/liquidita-modelli.json, HILUX (parco
 * 856) da' 0,4% mentre HILUX 4WD (parco 134) da' 119,4%, cioe' i passaggi dell'una contati
 * sull'altra. Con la soglia a 300 restano fuori 233 modelli su 1.328 e il massimo residuo
 * scende a 33,6% (BYD Dolphin), che e' plausibile.
 * Un rapporto sopra il 100% non e' "alto": e' aritmeticamente impossibile, quindi si tace.
 */
const PARCO_MIN = 300;
const ricambioUtile = m =>
  (m && m.ricambio != null && m.parco >= PARCO_MIN && m.ricambio <= 100) ? m.ricambio : null;

// NESSUN GIUDIZIO. Qui c'era una funzione che dal tasso di ricambio tirava fuori frasi
// come "si rivende in fretta" o "veicolo da collezione o fuori mercato": erano opinioni
// sulla vendibilita' di un'auto, scritte da noi e presentate accanto a un dato ACI come
// se avessero la stessa autorita'. Chi legge decide da se': il numero dei passaggi e il
// parco circolante sono fatti, "si rivende in fretta" no.

/**
 * @param {string} marca
 * @param {string} modello
 * @param {string} [tipo] 'auto' | 'moto'
 * @returns {object|null} dati + `viaPadre` se l'aggancio è al modello base
 */
function cerca(marca, modello, tipo) {
  if (tipo === 'moto') {
    return { ok: false, motivo: 'non disponibile per le moto', spiegazione: L.soloAuto, fonte: L.fonte, anno: L.anno };
  }
  const m = norm(marca), t = norm(modello);
  if (!m || !t) return null;
  const trova = k => L.modelli[k] || null;

  let hit = trova(`${m}|${t}`), viaPadre = null;
  // Ripiego: il nostro catalogo scende alla variante ("Golf GTI", "Serie 3 Gran Turismo"),
  // l'Autoritratto si ferma al modello ("GOLF"). Si accorciano i token da destra.
  if (!hit) {
    const tok = t.split(' ');
    for (let n = tok.length - 1; n >= 1 && !hit; n--) {
      const k = `${m}|${tok.slice(0, n).join(' ')}`;
      const c = trova(k);
      if (c) { hit = c; viaPadre = c.modello; }
    }
  }
  if (!hit) return null;
  // I due numeri assoluti restano: presi da soli sono corretti, e' il loro rapporto a non
  // esserlo. Sparisce solo la percentuale.
  const r = ricambioUtile(hit);
  return {
    ok: true, marca: hit.marca, modello: hit.modello, viaPadre,
    parco: hit.parco, trasferimenti: hit.trasferimenti, trasferimentiTotali: hit.trasferimentiTotali,
    ricambio: r,
    anno: L.anno, fonte: L.fonte, aggiornato: L.generatedAt,
    nota: 'Dato aggregato di modello sul parco italiano: non riguarda il singolo veicolo in vendita.',
  };
}

module.exports = { cerca, ricambioUtile, dati: L };
