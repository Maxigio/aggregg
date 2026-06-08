/**
 * Modulo analisi ISOMORFO (§11): scoring + flag + cluster-modello.
 * Calcolo PURO (zero DOM) → usato sia dalla UI (frontend/app.js via window.AMRAnalysis)
 * sia dal motore-avvisi server (backend/server.js via require). Single source of truth:
 * lo stesso annuncio ha lo stesso _score/_flags ovunque.
 *
 * UMD: module.exports su Node, window.AMRAnalysis nel browser.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.AMRAnalysis = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CURRENT_YEAR = new Date().getFullYear();

  // Pesi del punteggio composito (somma libera, normalizzata). Tarabili.
  const SCORE_WEIGHTS = { prezzo: 50, kmAnnui: 20, eta: 15, completezza: 15 };

  // Soglie delle evidenziazioni. Tarabili sui risultati reali.
  const FLAG_THRESHOLDS = {
    affarePct:     0.15,    // prezzo <= atteso*(1-0.15)  → 🟢 Affare
    sospettoFact:  0.50,    // prezzo <  atteso*0.50      → 🔴 Prezzo sospetto (troppo bello)
    kmAnnuiBassi:  3000,    // km/anno < soglia con età>min → 🔴 sospetto scalata
    kmAnnuiAlti:   40000,   // km/anno > soglia            → 🔴 usura forte
    etaMinScalata: 3,
  };
  const MIN_COMPARABILI = 6;   // sotto: niente k-NN affidabile → fallback mediana, no flag forti
  const KNN_K           = 8;   // n. vicini per il prezzo atteso
  const SCORE_SPAN      = 0.30; // residuo ±30% → punteggio 0/100

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function kmPerYear(r) {
    if (r.km == null || r.anno == null) return null;
    return r.km / Math.max(1, CURRENT_YEAR - r.anno + 1);
  }

  // Percentile (0..100) su array già ORDINATO crescente.
  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[i];
  }

  // Percentile-rank di v dentro arr (0..1). Più alto = v maggiore nel set.
  function pctRank(v, arr) {
    if (arr.length < 2 || v == null) return 0.5;
    const below = arr.filter(x => x < v).length;
    const eq    = arr.filter(x => x === v).length;
    return (below + eq / 2) / arr.length;
  }

  // Cluster modello da titolo libero (best-effort). Es. "BMW 318d Touring" →
  // "bmw 318d"; "Honda Africa Twin" → "honda africa". Serve sia per il
  // raggruppamento "Modello/variante" sia per i comparabili del punteggio.
  function clusterModello(titolo) {
    if (!titolo) return '?';
    const norm = String(titolo).toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const tokens = norm.match(/[a-z0-9]+/g) || [];
    if (!tokens.length) return '?';
    const marca   = tokens.find(t => /[a-z]/.test(t)) || tokens[0];
    const modello = tokens.find(t => /\d/.test(t))    // sigla con cifra (318d, 1250)
                 || tokens.filter(t => t !== marca)[0]
                 || '';
    return (marca + (modello ? ' ' + modello : '')).trim();
  }

  // Prezzo ATTESO per un annuncio dai k vicini per età+km nel cluster (esclude sé
  // stesso e i duplicati). Ritorna { expected, bandLo, bandHi, vicini, method } o null.
  // Risolve un sistema lineare 3×3 (A·x=b) via eliminazione di Gauss con pivot.
  function solve3(A, b) {
    const M = [[...A[0], b[0]], [...A[1], b[1]], [...A[2], b[2]]];
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r2 = c + 1; r2 < 3; r2++) if (Math.abs(M[r2][c]) > Math.abs(M[piv][c])) piv = r2;
      if (Math.abs(M[piv][c]) < 1e-12) return null;   // singolare
      [M[c], M[piv]] = [M[piv], M[c]];
      for (let r2 = 0; r2 < 3; r2++) {
        if (r2 === c) continue;
        const f = M[r2][c] / M[c][c];
        for (let k = c; k < 4; k++) M[r2][k] -= f * M[c][k];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  // Prezzo ATTESO via modello di deprezzamento: regressione ridge OLS
  //   prezzo ≈ b0 + b1·età + b2·km   (predittori scalati [0,1] sul cluster).
  // Cattura il trend (prezzo↓ con età/km) → predice l'atteso anche agli estremi,
  // senza farsi dominare dagli outlier come la mediana/k-NN. residuo = sotto/sopra.
  function expectedPrice(r, comparables) {
    const priced = comparables.filter(p => p !== r && p.url !== r.url && p.prezzo > 0);
    const cand = priced.filter(p => p.anno != null && p.km != null);
    if (priced.length >= MIN_COMPARABILI && cand.length >= MIN_COMPARABILI && r.anno != null && r.km != null) {
      const ages = cand.map(p => CURRENT_YEAR - p.anno);
      const kms  = cand.map(p => p.km);
      const aMin = Math.min(...ages), aMax = Math.max(...ages), aSpan = (aMax - aMin) || 1;
      const kMin = Math.min(...kms),  kMax = Math.max(...kms),  kSpan = (kMax - kMin) || 1;
      const sa = a => (a - aMin) / aSpan, sk = k => (k - kMin) / kSpan;
      // Normal equations XᵀX, Xᵀy con design [1, age, km].
      const XtX = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Xty = [0, 0, 0];
      cand.forEach((p, i) => {
        const x = [1, sa(ages[i]), sk(kms[i])], y = p.prezzo;
        for (let a = 0; a < 3; a++) { Xty[a] += x[a] * y; for (let b = 0; b < 3; b++) XtX[a][b] += x[a] * x[b]; }
      });
      const lambda = 0.05;                       // ridge: stabilità se età~km collineari
      XtX[1][1] += lambda; XtX[2][2] += lambda;
      const beta = solve3(XtX, Xty);
      if (beta) {
        const minP = Math.min(...cand.map(p => p.prezzo));
        let expected = beta[0] + beta[1] * sa(CURRENT_YEAR - r.anno) + beta[2] * sk(r.km);
        expected = Math.max(expected, minP * 0.3);   // niente attesi assurdi/negativi (estrapolazione)
        // Banda dalla dispersione dei residui del fit.
        const resid = cand.map(p => p.prezzo - (beta[0] + beta[1] * sa(CURRENT_YEAR - p.anno) + beta[2] * sk(p.km)))
          .sort((a, b) => a - b);
        return {
          expected: Math.round(expected),
          bandLo: Math.round(Math.max(minP * 0.3, expected + (percentile(resid, 25) || 0))),
          bandHi: Math.round(expected + (percentile(resid, 75) || 0)),
          vicini: cand, method: 'model',
        };
      }
    }
    // Fallback: mediana semplice (poco affidabile → no flag forti).
    if (priced.length >= 2) {
      const mp = priced.map(p => p.prezzo).sort((a, b) => a - b);
      return { expected: median(mp), bandLo: percentile(mp, 25), bandHi: percentile(mp, 75), vicini: priced, method: 'median' };
    }
    return null;
  }

  function analyzeResults(results) {
    // Raggruppa per cluster-modello → comparabili coerenti
    const clusters = {};
    results.forEach(r => {
      r._cluster = clusterModello(r.titolo);
      (clusters[r._cluster] = clusters[r._cluster] || []).push(r);
    });

    const T = FLAG_THRESHOLDS;
    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    results.forEach(r => {
      const peers   = clusters[r._cluster];
      const est      = (r.prezzo != null && r.prezzo > 0) ? expectedPrice(r, peers) : null;
      const expected = est ? est.expected : null;
      const strong   = est && est.method === 'model';   // modello affidabile → flag forti
      const lowData  = !strong;                          // mediana-fallback o niente → campione debole

      // residuo% = quanto SOTTO l'atteso (>0 = affare). Punteggio = SOLO qualità-prezzo.
      let residualPct = null, priceClass = null, cPrezzo = 50;
      if (expected != null && expected > 0) {
        residualPct = (expected - r.prezzo) / expected;
        if (r.prezzo < expected * T.sospettoFact)        priceClass = 'sospetto';
        else if (r.prezzo <= expected * (1 - T.affarePct)) priceClass = 'affare';
        else                                              priceClass = 'normale';
        cPrezzo = priceClass === 'sospetto'
          ? 30                                            // troppo bello per essere vero → non premia
          : clamp(50 + (residualPct / SCORE_SPAN) * 50, 0, 100);
      }
      r._score = Math.round(cPrezzo);

      // Ranking convenienza nel cluster (prezzo asc): 1 = più economico
      const pricedAll = peers.filter(p => p.prezzo != null && p.prezzo > 0).map(p => p.prezzo);
      let priceRank = null;
      const priceRankTot = pricedAll.length;
      if (r.prezzo != null && r.prezzo > 0 && priceRankTot >= 2) {
        priceRank = pricedAll.filter(p => p < r.prezzo).length + 1;
      }

      const ky = kmPerYear(r);
      r._scoreBreakdown = {
        expected,
        bandLo: est ? est.bandLo : null,
        bandHi: est ? est.bandHi : null,
        residualPct,
        method: est ? est.method : null,
        vicini: est ? est.vicini.length : 0,
        comparabili: peers.filter(p => p !== r && p.url !== r.url && p.prezzo > 0).length,
        lowData,
        priceRank, priceRankTot,
        kmPerYear: ky != null ? Math.round(ky) : null,
        // contesto attributi (mediana dei vicini, NON entra nel punteggio)
        neighKm:   est ? median(est.vicini.map(p => p.km).filter(v => v != null)) : null,
        neighAnno: est ? median(est.vicini.map(p => p.anno).filter(v => v != null)) : null,
        itemKm: r.km, itemAnno: r.anno,
      };

      // Evidenziazioni (separate dal punteggio). Flag prezzo forti SOLO con k-NN.
      const flags = [];
      if (strong) {
        if (priceClass === 'sospetto') flags.push('sospetto');
        else if (priceClass === 'affare') flags.push('affare');
      }
      if (ky != null) {
        const eta = CURRENT_YEAR - (r.anno ?? CURRENT_YEAR);
        if (ky < T.kmAnnuiBassi && eta > T.etaMinScalata) flags.push('km_bassi');
        else if (ky > T.kmAnnuiAlti)                       flags.push('km_alti');
      }
      if (r.prezzo == null || r.anno == null || r.km == null) flags.push('dato_mancante');
      r._flags = flags;
    });

    return results;
  }

  return { analyzeResults, clusterModello, SCORE_WEIGHTS, FLAG_THRESHOLDS, CURRENT_YEAR };
});
