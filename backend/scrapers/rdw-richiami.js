'use strict';
/**
 * RICHIAMI RDW — la seconda fonte dei richiami, quella che aggancia MARCA e MODELLO.
 *
 * Safety Gate dice che un'autorita' europea ha accertato un pericolo, ma individua i
 * veicoli col numero di omologazione o un intervallo di telaio: due cose che un annuncio
 * non porta, e per questo li' il semaforo resta sulla famiglia. L'RDW lega ogni campagna
 * a marca e tipo in chiaro — 4.571 campagne agganciabili, 232 marche — quindi qui il
 * confronto col modello cercato si puo' fare davvero.
 *
 * Le due fonti NON si fondono: sono due archivi diversi con due criteri diversi, e
 * mescolarli darebbe un totale che non significa niente. Si mostrano affiancate.
 *
 * QUELLO CHE NON PUO' DIRE, e va scritto nell'interfaccia:
 *  - la campagna riguarda i telai che decide il costruttore, non tutti gli esemplari del
 *    modello. Resta un semaforo di modello, come Safety Gate;
 *  - non c'e' finestra di produzione, quindi filtrare per anno NON si puo'. Chi passa un
 *    anno riceve lo stesso tutte le campagne, e l'avviso che l'anno non e' stato usato;
 *  - il testo lungo e' in olandese. La CATEGORIA del difetto e il rischio sono tradotti
 *    (sono insiemi chiusi, 19 e 6 voci); le descrizioni no, perche' tradurle a macchina
 *    vorrebbe dire firmare parole che non sono ne' nostre ne' della fonte.
 *
 * Dati da data/rdw-richiami.json (scripts/build-rdw-richiami.js). Public Domain.
 */
const path = require('path');

let D = null;
try { D = require(path.join(__dirname, '..', '..', 'data', 'rdw-richiami.json')); } catch (_) { D = null; }

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Il modello combacia? A PAROLA INTERA, mai per sottostringa — e' lo stesso errore che
 * `subito-nodo.js` documenta: "r12" si trova dentro "gsr125", e "Golf" dentro "Golfino".
 * Basta che il nome cercato compaia come parola nel tipo dichiarato, perche' le due fonti
 * hanno granularita' diversa: l'RDW scrive "MULTISTRADA V4 PIKES PEAK" dove noi cerchiamo
 * "Multistrada".
 */
function combaciaModello(tipi, cercato) {
  const q = norm(cercato);
  if (!q) return false;
  const re = new RegExp('(^| )' + q + '( |$)');
  // L'ORDINE DELLE PAROLE CAMBIA FRA LE DUE FONTI: noi scriviamo "Serie 3", l'RDW scrive
  // "3 SERIE". Confrontando la frase intera davano zero campagne su una delle auto piu'
  // vendute d'Italia. Si confrontano quindi gli INSIEMI di parole: tutte quelle cercate
  // devono esserci nel tipo dichiarato. E' la stessa scelta gia' presa in
  // autoscout-graphql.js, dove "390 Duke" e "Duke 390" sono la stessa moto.
  //
  // Solo in QUESTA direzione (cercate ⊆ dichiarate), mai il contrario: cosi' "Serie 3"
  // prende anche "3 SERIE GRAN TURISMO", che e' giusto, mentre "500" non prende "500X",
  // che resta una parola sola e un'altra auto.
  const paroleQ = q.split(' ').filter(Boolean);
  for (const t of tipi || []) {
    const n = norm(t);
    if (!n) continue;
    if (n === q || re.test(n)) return true;
    // "Z900" attaccato contro "Z 900" staccato: stessa moto. Uguaglianza, non contenimento
    // — il contenimento farebbe passare "r12" dentro "gsr125".
    if (n.replace(/ /g, '') === q.replace(/ /g, '')) return true;
    if (paroleQ.length > 1) {
      const paroleT = new Set(n.split(' ').filter(Boolean));
      if (paroleQ.every(p => paroleT.has(p))) return true;
    }
  }
  return false;
}

/** La marca combacia? Confronto normalizzato, nessun contenimento. */
/**
 * LA MARCA COMBACIA ANCHE QUANDO UNO DEI DUE NOMI E' PIU' CORTO.
 *
 * L'RDW scrive la marca come gliela dichiara il costruttore, e non sempre nella forma
 * commerciale: noi cerchiamo "DS Automobiles", loro scrivono "DS", e con l'uguaglianza
 * stretta la scheda di una DS 4 diceva «Campagne RDW 0 — Nessuna campagna per questo
 * modello» mentre l'archivio ne conteneva 78.
 *
 * Si accetta quindi che uno sia il prefisso A PAROLE dell'altro — mai una sottostringa, che
 * farebbe passare "r12" dentro "gsr125". Misurato sulle 232 marche dell'archivio e sulle 739
 * del nostro catalogo: UNA sola ambiguita', "ford" che aggancia anche "ford cng technik", che
 * e' Ford. Nessun'altra marca diventa confondibile.
 */
function combaciaMarca(marche, cercata) {
  const q = norm(cercata);
  if (!q) return false;
  const paroleQ = q.split(' ').filter(Boolean);
  return (marche || []).some(m => {
    const n = norm(m);
    if (!n) return false;
    if (n === q || n.replace(/ /g, '') === q.replace(/ /g, '')) return true;
    const paroleN = n.split(' ').filter(Boolean);
    const corto = paroleQ.length <= paroleN.length ? paroleQ : paroleN;
    const lungo = paroleQ.length <= paroleN.length ? paroleN : paroleQ;
    return corto.every((p, i) => p === lungo[i]);
  });
}

/**
 * Cerca le campagne. `anno` si accetta e si IGNORA di proposito: la fonte non porta la
 * finestra di produzione, e restringere su un dato che non c'e' vorrebbe dire nascondere
 * campagne vere. Chi chiama riceve `annoIgnorato: true` e lo deve dire a schermo.
 */
function cerca({ marca, modello, anno } = {}) {
  if (!D) return { ok: false, motivo: 'archivio richiami RDW non costruito: lancia scripts/build-rdw-richiami.js' };
  let c = D.campagne;
  if (marca) c = c.filter(x => combaciaMarca(x.marche, marca));
  if (modello) c = c.filter(x => combaciaModello(x.modelli, modello));
  return {
    ok: true,
    campagne: c,
    totale: c.length,
    annoIgnorato: anno != null && anno !== '',
    fonte: D.fonte,
    licenza: D.licenza,
    generato: D.generato,
  };
}

/** L'elenco delle marche con quante campagne hanno, per una tendina. */
let _marche = null;
function marche() {
  if (!D) return [];
  if (_marche) return _marche;
  const m = new Map();
  for (const c of D.campagne) for (const x of c.marche) m.set(x, (m.get(x) || 0) + 1);
  _marche = [...m.entries()].map(([nome, n]) => ({ nome, campagne: n })).sort((a, b) => b.campagne - a.campagne);
  return _marche;
}

function stato() {
  return D
    ? { pronto: true, campagne: D.campagne.length, marche: marche().length, generato: D.generato, fonte: D.fonte, licenza: D.licenza }
    : { pronto: false, motivo: 'data/rdw-richiami.json assente' };
}

module.exports = { cerca, marche, stato, _combaciaModello: combaciaModello, _combaciaMarca: combaciaMarca };
