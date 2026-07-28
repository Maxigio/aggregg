'use strict';
/**
 * I BUCHI DEL PONTE, chiusi a mano — dal lato ricerca.
 *
 * Il ponte aggancia famiglia Subito ↔ modelli Autoscout. Restano fuori i modelli che su
 * Autoscout stanno DENTRO una famiglia Subito invece di esserle pari: "Golf GTI" e'
 * un modello su Autoscout e una versione dentro "Golf" su Subito. Chiedere a Subito la
 * famiglia e basta vuol dire chiedere tutte le 11.646 Golf: nei primi cento ordinati per
 * prezzo le GTI erano UNA.
 *
 * LA RICETTA, provata annuncio per annuncio contro i titoli scritti dai venditori:
 *
 *   id famiglia  +  testo alla fonte  +  filtro sulla versione dichiarata
 *
 * Il testo (`q=gti`) concentra l'insieme — 11.646 → 1.631 — e il filtro sulla versione
 * che l'annuncio dichiara di se' butta chi GTI non e'. Misurato: 1% → 88%.
 *
 * Il testo NON si mette dove la famiglia Subito E' gia' il veicolo ("Scarabeo",
 * "Leoncino", "Svartpilen"): li' la versione e' l'allestimento e non ripete il nome del
 * modello, quindi filtrarci ammazzerebbe tutto — misurato, Leoncino da 94 a 0. Per quei
 * tre bastano gli id, e portano piu' annunci a pari precisione (Scarabeo 105 → 200).
 *
 * Chi non dichiara la versione RESTA, marcato, come ovunque nell'app: `q` alla fonte ha
 * gia' guardato il suo titolo, ed e' spesso l'annuncio compilato male — cioe' l'affare.
 */
const fs = require('fs');
const path = require('path');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

let INDICE = null;
function indice() {
  if (INDICE) return INDICE;
  INDICE = new Map();
  try {
    const P = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'ponte-buchi.json'), 'utf8'));
    for (const v of P.voci || []) {
      INDICE.set(`${v.tipo}|${norm(v.marca)}|${norm(v.modelloAs24)}`, {
        marcaId: String(v.subito.marcaId),
        marcaNome: v.marca,
        famigliaIds: String(v.subito.famigliaId).split(','),
        famigliaNome: v.subito.famiglie ? v.subito.famiglie[0].nome : v.subito.famiglia,
        testo: v.subito.versioniCheDicono || null,
        come: 'buco-chiuso',
      });
    }
  } catch (e) {
    console.warn('[ponte-buchi] non caricato: ' + e.message);
  }
  return INDICE;
}

/** Il nodo Subito per un modello che il ponte non copriva, o null. */
function agganciaSubito(tipo, marca, modello) {
  if (!marca || !modello) return null;
  return indice().get(`${tipo}|${norm(marca)}|${norm(modello)}`) || null;
}

module.exports = { agganciaSubito };
