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

// "come si rivende" da un tasso di ricambio annuo. Soglie ricavate dalla distribuzione
// reale del dato (mediana ~8%): non sono un giudizio, sono un posizionamento.
function giudizio(ricambio) {
  if (ricambio == null) return null;
  if (ricambio >= 12) return { classe: 'alta', testo: 'si rivende in fretta' };
  if (ricambio >= 7) return { classe: 'media', testo: 'mercato regolare' };
  if (ricambio >= 3) return { classe: 'bassa', testo: 'mercato lento' };
  return { classe: 'ferma', testo: 'quasi nessun passaggio: veicolo da collezione o fuori mercato' };
}

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
  return {
    ok: true, marca: hit.marca, modello: hit.modello, viaPadre,
    parco: hit.parco, trasferimenti: hit.trasferimenti, trasferimentiTotali: hit.trasferimentiTotali,
    ricambio: hit.ricambio, giudizio: giudizio(hit.ricambio),
    anno: L.anno, fonte: L.fonte, aggiornato: L.generatedAt,
    nota: 'Dato aggregato di modello sul parco italiano: non riguarda il singolo veicolo in vendita.',
  };
}

module.exports = { cerca, giudizio, dati: L };
