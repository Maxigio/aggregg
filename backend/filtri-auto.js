'use strict';
/**
 * I FILTRI AVANZATI DELLE AUTO, tradotti nel dialetto di ogni fonte.
 *
 * Chi cerca sceglie "SUV / Fuoristrada". Subito vuole `ct=5`, Autoscout vuole
 * `bodyType:["SUV","OffRoad"]` — due voci, perche' li' il fuoristrada e' separato. La
 * tabella di traduzione sta in `data/filtri-auto.json` e porta i CODICI, non i nomi: i
 * nomi le fonti li cambiano, i codici no.
 *
 * SOLO AUTO. Per le moto le fonti sono tre e Moto.it questi filtri non li ha: mostrarli
 * anche li' vorrebbe dire un filtro che una fonte su tre ignora in silenzio. Le auto invece
 * le servono soltanto Subito e Autoscout, e li supportano entrambe — nessuna fonte cieca.
 *
 * TRE TRAPPOLE, misurate, che questo file esiste per non far ricadere a nessuno:
 *   potenza   Subito CV, Autoscout kW. `power 74-81` torna auto da 101-105 CV.
 *   posti     Subito `ss/se` sono la CHIAVE del menu, non i posti: ss=4 → cinque posti.
 *   Euro      su Autoscout `emissionClass` e' cumulativa e vuole un valore SINGOLO;
 *             su Subito i valori sono esatti e si elencano separati da virgola.
 */
const path = require('path');

const TAB = require(path.join(__dirname, '..', 'data', 'filtri-auto.json'));
const CV_PER_KW = (TAB.potenza && TAB.potenza.cvPerKw) || 1.35962;

/** I nomi dei filtri, per chi deve validare o disegnare un menu. */
const NOMI = Object.keys(TAB.filtri);

/** Le voci di un filtro, senza i codici: e' quello che serve a un menu. */
function voci(nome) {
  const f = TAB.filtri[nome];
  if (!f) return [];
  return f.voci.map(v => ({ id: v.id, etichetta: v.etichetta, allargaSu: v.allargaSu || null }));
}

/** La voce scelta, o null se non esiste. Non lancia: un valore sporco non deve fermare una ricerca. */
function voce(nome, id) {
  const f = TAB.filtri[nome];
  if (!f || !id) return null;
  return f.voci.find(v => v.id === String(id)) || null;
}

/**
 * Normalizza quello che arriva dal browser: tiene solo i filtri conosciuti e i valori
 * che esistono davvero. Un valore inventato viene SCARTATO, non passato alla fonte —
 * le fonti reagiscono in modo diverso alla spazzatura (Subito 400, Autoscout la ignora)
 * e un errore per fonte e' peggio di un filtro non applicato.
 */
function leggiDaQuery(query) {
  const out = {};
  for (const nome of NOMI) {
    const v = voce(nome, query[nome]);
    if (v) out[nome] = v.id;
  }
  const cv = n => { const x = parseInt(n, 10); return Number.isFinite(x) && x > 0 && x < 2000 ? x : null; };
  const cvMin = cv(query.cvMin), cvMax = cv(query.cvMax);
  if (cvMin != null) out.cvMin = cvMin;
  if (cvMax != null) out.cvMax = cvMax;
  return out;
}

/** true se c'e' almeno un filtro avanzato impostato. */
const attivi = f => Boolean(f) && Object.keys(f).length > 0;

// ─── Subito ─────────────────────────────────────────────────────────────────

/**
 * I parametri Subito, gia' pronti da mettere nella query string.
 * Piu' codici sullo stesso filtro si uniscono con la virgola: verificato in OR esatto
 * (ct=1 1.561 + ct=8 245 = ct=1,8 1.806).
 */
function perSubito(filtri) {
  const out = {};
  if (!attivi(filtri)) return out;
  for (const nome of NOMI) {
    const v = voce(nome, filtri[nome]);
    if (!v) continue;
    const f = TAB.filtri[nome];
    if (nome === 'posti') {
      // ss/se sono la chiave del menu, non il numero di posti. La voce porta gia' la chiave.
      out.ss = String(v.subito[0]);
      out.se = String(v.subito[v.subito.length - 1]);
      continue;
    }
    out[f.subitoParam] = v.subito.join(',');
  }
  if (filtri.cvMin != null) out.hps = String(filtri.cvMin);   // Subito ragiona in CV: nessuna conversione
  if (filtri.cvMax != null) out.hpe = String(filtri.cvMax);
  return out;
}

// ─── Autoscout ──────────────────────────────────────────────────────────────

/** I campi da mettere dentro `Vehicle_`. */
function perAutoscout(filtri) {
  const out = {};
  if (!attivi(filtri)) return out;
  for (const nome of NOMI) {
    const v = voce(nome, filtri[nome]);
    if (!v) continue;
    const f = TAB.filtri[nome];
    if (v.as24Phev) out.phev = v.as24Phev;
    if (f.as24Forma === 'singolo') { if (v.as24) out[f.as24Campo] = v.as24; continue; }
    if (f.as24Forma === 'intervallo') { if (v.as24) out[f.as24Campo] = { from: v.as24.from, to: v.as24.to }; continue; }
    // lista: piu' voci nostre non si sommano (una scelta sola), ma una voce nostra puo'
    // valerne due loro — SUV da noi = SUV + OffRoad li'.
    if (Array.isArray(v.as24) && v.as24.length) out[f.as24Campo] = v.as24.slice();
  }
  /**
   * I CV DIVENTANO kW, e non e' un dettaglio: `power` li' e' in kW, e passargli i CV
   * darebbe auto molto piu' potenti di quelle chieste senza dirlo. Misurato: 74-81 kW
   * torna auto da 101-105 CV.
   * Si arrotonda verso l'esterno (min in giu', max in su') perche' un intervallo di CV
   * non cade mai esatto sui kW, e stringere taglierebbe fuori proprio i confini.
   */
  if (filtri.cvMin != null || filtri.cvMax != null) {
    const kwMin = filtri.cvMin != null ? Math.floor(filtri.cvMin / CV_PER_KW) : 0;
    const kwMax = filtri.cvMax != null ? Math.ceil(filtri.cvMax / CV_PER_KW) : 100000;
    out.power = { from: kwMin, to: kwMax };
  }
  return out;
}

/**
 * Quello che va detto a chi guarda: le voci che su una fonte allargano invece di
 * restringere. Il chilometro zero su Autoscout non esiste — li' e' "usato" — quindi quella
 * colonna torna piu' larga di quanto hai chiesto, e chi legge deve saperlo.
 */
function avvisi(filtri) {
  const out = [];
  if (!attivi(filtri)) return out;
  for (const nome of NOMI) {
    const v = voce(nome, filtri[nome]);
    if (v && v.allargaSu) {
      for (const fonte of v.allargaSu) {
        out.push({ fonte, filtro: nome, voce: v.id, testo: `"${v.etichetta}" su ${fonte} non esiste: quella colonna mostra anche il resto` });
      }
    }
  }
  return out;
}

/**
 * L'IMPRONTA DEI FILTRI, per le chiavi di cache.
 *
 * Sta qui e non nei due posti che la usano perche' ce ne sono DUE — la cache delle ricerche
 * in server.js e quella del recupero in subito-api.js — e dimenticarne una non si vede: la
 * ricerca torna istantanea con i risultati di prima, filtri diversi compresi. E' successo
 * a tutte e due appena aggiunti questi filtri, e i commenti accanto a quelle chiavi lo
 * avevano gia' scritto per il parametro-versione, che ci era caduto prima.
 */
function chiaveCache(filtri) {
  return Object.entries(filtri || {})
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}:${v}`).join(',');
}

module.exports = { TAB, NOMI, voci, voce, leggiDaQuery, perSubito, perAutoscout, avvisi, attivi, chiaveCache, CV_PER_KW };
