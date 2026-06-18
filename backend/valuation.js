/**
 * Motore di valutazione (F32 — Console Concessionario). FUNZIONI PURE: nessuno
 * scraping, nessun I/O → l'orchestrazione live sta nel server (`/api/valuta`),
 * qui solo la statistica. È il punto dove vivrebbero le allucinazioni, quindi
 * è isolato e testato a fondo.
 *
 * Contratto anti-allucinazione (vedi piano F32):
 *  - SOLO like-for-like: stesso modello (già garantito dal fetch), anno/km vicini,
 *    danni esclusi, km-0/nuovo separati dall'usato.
 *  - Mai un numero senza il campione: ogni output porta `n`, `tightness`, e
 *    `ok=false` ("dati insufficienti") sotto la soglia minima.
 *  - Robusto agli outlier: percentili + trim IQR; via i prezzi-spazzatura.
 */
'use strict';

const MIN_SAMPLE = 5;   // sotto questo: "dati insufficienti", NON un numero inventato
const PREFER_N   = 8;   // soglia per accettare un livello di match stretto

// Livelli di allargamento adattivo: parti stretto, allarga solo se pochi campioni.
// `anno`/`km` = semi-finestra attorno al veicolo target; null = vincolo rimosso.
const LEVELS = [
  { label: 'stretto', anno: 2, km: 20000 },
  { label: 'medio',   anno: 3, km: 40000 },
  { label: 'ampio',   anno: null, km: null },
];

// Percentile con interpolazione lineare su array ORDINATO crescente.
function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// Rimuove gli outlier oltre le barriere IQR (1.5×) → toglie i prezzi-spazzatura
// (es. €1, "tratt. riservata" mappata male, refusi a 5 cifre) senza decidere a mano.
function trimOutliers(pricesAsc) {
  if (pricesAsc.length < 4) return pricesAsc;   // troppo pochi per stimare l'IQR
  const q1 = percentile(pricesAsc, 25);
  const q3 = percentile(pricesAsc, 75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr;
  return pricesAsc.filter(v => v >= lo && v <= hi);
}

// Solo comparabili usabili: prezzo valido, NON incidentati, NON km-0/nuovo
// (un km-0 nuovo non è comparabile a un usato). `danni`/`nuovo` possono essere
// null (fonte non li espone) → in quel caso NON si esclude (non si inventa).
function isUsableComparable(c) {
  if (c == null || typeof c.prezzo !== 'number' || c.prezzo <= 0) return false;
  if (c.danni === true) return false;
  if (c.nuovo === true) return false;
  if (c.km === 0) return false;
  return true;
}

function within(value, target, half) {
  if (half == null) return true;       // livello "ampio": vincolo rimosso → include tutto
  if (target == null) return true;     // non sappiamo il target → non si può vincolare
  if (value == null) return false;     // comparabile SENZA il dato ma target presente → non verificabile like-for-like → escludi
  return Math.abs(value - target) <= half;
}

// Statistiche robuste su un set di comparabili (già like-for-like).
function statsOf(comparabili) {
  const pricesAsc = comparabili.map(c => c.prezzo).sort((a, b) => a - b);
  const trimmed = trimOutliers(pricesAsc);
  const base = trimmed.length ? trimmed : pricesAsc;
  return {
    min:     base[0],
    p25:     Math.round(percentile(base, 25)),
    mediana: Math.round(percentile(base, 50)),
    p75:     Math.round(percentile(base, 75)),
    max:     base[base.length - 1],
    scartati: pricesAsc.length - base.length,   // outlier tolti (trasparenza)
  };
}

// Composizione per tipo venditore (concessionario vs privato): mediana + N per
// gruppo. La fascia resta unica (scelta utente), ma la composizione è SEMPRE
// mostrata → non fuorviante (un concessionario non sembra "caro" vs i privati).
function sellerSplit(comparabili) {
  const grp = { conc: [], priv: [] };
  for (const c of comparabili) {
    const v = String(c.venditore || '').toLowerCase();
    if (/conc/.test(v)) grp.conc.push(c.prezzo);
    else if (/priv/.test(v)) grp.priv.push(c.prezzo);
  }
  const med = arr => arr.length ? Math.round(percentile(arr.slice().sort((a, b) => a - b), 50)) : null;
  return {
    conc: { n: grp.conc.length, mediana: med(grp.conc) },
    priv: { n: grp.priv.length, mediana: med(grp.priv) },
  };
}

/**
 * Valuta un veicolo a partire dai comparabili (già del modello giusto, dal fetch).
 * @param {object[]} comparabili  - annunci dello stesso modello {prezzo,anno,km,venditore,danni,nuovo,url,fonte}
 * @param {object}   target       - { anno, km } del veicolo da valutare (possono mancare)
 * @param {object}   [opts]       - { minSample, preferN }
 * @returns {object} { ok, motivo?, fascia, n, tightness, comparabili, split, percentileOf? }
 */
function computeValuation(comparabili, target = {}, opts = {}) {
  const minSample = opts.minSample || MIN_SAMPLE;
  const preferN   = opts.preferN   || PREFER_N;
  const usable = (comparabili || []).filter(isUsableComparable);
  const hasTarget = target.anno != null || target.km != null;

  // Selezione del set comparabili:
  //  - senza anno/km del target → NIENTE finestra possibile: tutto il modello,
  //    etichetta onesta 'modello' (non spacciare un match "stretto" inesistente).
  //  - con target → livello PIÙ STRETTO che raggiunge `minSample` (NON si allarga
  //    oltre un match valido: la precisione like-for-like batte il numero di campioni).
  //    `preferN` non allarga: serve solo a marcare la confidenza bassa.
  let chosen, label;
  if (!hasTarget) {
    chosen = usable; label = 'modello';
  } else {
    chosen = null; label = LEVELS[LEVELS.length - 1].label;
    for (const lvl of LEVELS) {
      const set = usable.filter(c => within(c.anno, target.anno, lvl.anno) && within(c.km, target.km, lvl.km));
      if (set.length >= minSample) { chosen = set; label = lvl.label; break; }
    }
    if (!chosen) {   // nessun livello arriva a minSample → il più ampio (resterà ok:false)
      chosen = usable.filter(c => within(c.anno, target.anno, LEVELS[2].anno) && within(c.km, target.km, LEVELS[2].km));
      label = LEVELS[2].label;
    }
  }

  // Posizione di papà calcolata sullo STESSO set della fascia (non sull'intero mercato)
  // → percentile e mediana parlano della stessa popolazione (coerenza).
  const posizione = (opts.myPrice != null) ? pricePosition(opts.myPrice, chosen) : null;

  if (chosen.length < minSample) {
    return { ok: false, motivo: 'dati insufficienti', n: chosen.length, tightness: label,
             fascia: null, split: sellerSplit(chosen), posizione, comparabili: chosen, lowConfidence: true };
  }
  return {
    ok: true,
    n: chosen.length,
    tightness: label,                        // 'stretto' ±2a/±20k · 'medio' ±3a/±40k · 'ampio'/'modello' = tutto il modello
    lowConfidence: chosen.length < preferN,  // pochi campioni → confidenza bassa (flag, NON allargamento)
    fascia: statsOf(chosen),
    split: sellerSplit(chosen),
    posizione,
    comparabili: chosen.slice().sort((a, b) => a.prezzo - b.prezzo),
  };
}

// Percentile del prezzo di papà nella distribuzione like-for-like (#4 "competitivo ora").
// Ritorna {percentile, posizione, su} o null se set vuoto. Fatto, non profezia.
function pricePosition(myPrice, comparabili) {
  const usable = (comparabili || []).filter(isUsableComparable);
  if (typeof myPrice !== 'number' || !usable.length) return null;
  const piuEconomici = usable.filter(c => c.prezzo < myPrice).length;
  return {
    percentile: Math.round(100 * piuEconomici / usable.length),   // % del mercato più economico di te (alto = sei caro)
    posizione:  piuEconomici + 1,                                  // rango dal più economico: 1 = sei il più economico
    su:         usable.length + 1,                                 // totale simili, te incluso
  };
}

// "Troncato" = una fonte ha reso ~il suo cap on-search → forse non tutto il mercato
// (coda economica); `count < cap` = vista completa del modello. Puro → testabile.
function inferTruncated(sources, caps) {
  return Object.entries(sources || {}).some(([k, s]) => (s.count || 0) >= (caps[k] != null ? caps[k] : Infinity));
}

module.exports = {
  computeValuation, pricePosition, inferTruncated,
  _percentile: percentile, _trimOutliers: trimOutliers, _statsOf: statsOf,
  _isUsableComparable: isUsableComparable, _sellerSplit: sellerSplit,
  MIN_SAMPLE, PREFER_N,
};
