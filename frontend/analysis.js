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
    affarePct:     0.20,    // prezzo <= mediana*(1-0.20) → 🟢 Affare
    sospettoPct:   0.40,    // prezzo <  mediana*0.40     → 🔴 Prezzo sospetto
    kmAnnuiBassi:  3000,    // km/anno < soglia con età>min → 🔴 sospetto scalata
    kmAnnuiAlti:   40000,   // km/anno > soglia            → 🔴 usura forte
    etaMinScalata: 3,
  };

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

  function analyzeResults(results) {
    // Raggruppa per cluster-modello → comparabili coerenti
    const clusters = {};
    results.forEach(r => {
      r._cluster = clusterModello(r.titolo);
      (clusters[r._cluster] = clusters[r._cluster] || []).push(r);
    });

    const W = SCORE_WEIGHTS;
    const wTot = W.prezzo + W.kmAnnui + W.eta + W.completezza;
    const T = FLAG_THRESHOLDS;

    results.forEach(r => {
      const peers      = clusters[r._cluster];
      const peerPrices = peers.map(p => p.prezzo).filter(p => p != null && p > 0);
      const med        = peerPrices.length >= 2 ? median(peerPrices) : null;
      const peerKmY    = peers.map(kmPerYear).filter(v => v != null);
      const peerAnni   = peers.map(p => p.anno).filter(v => v != null);

      // Classificazione prezzo (condivisa tra punteggio ed evidenziazioni)
      let priceClass = null;  // 'sospetto' | 'affare' | 'normale'
      if (med && r.prezzo != null && r.prezzo > 0) {
        if (r.prezzo < med * T.sospettoPct)           priceClass = 'sospetto';
        else if (r.prezzo <= med * (1 - T.affarePct)) priceClass = 'affare';
        else                                          priceClass = 'normale';
      }

      // Componenti 0-100 (neutre = 50 quando mancano i comparabili o il dato)
      let cPrezzo = 50, cKm = 50, cEta = 50;
      if (priceClass === 'sospetto') {
        // Prezzo troppo basso per essere vero: NON premia il punteggio (probabile
        // fregatura/errore), lo penalizza.
        cPrezzo = 25;
      } else if (priceClass) {
        cPrezzo = clamp(50 + ((med - r.prezzo) / med) * 100, 0, 100);
      }
      const ky = kmPerYear(r);
      if (peerKmY.length >= 2 && ky != null) {
        cKm = clamp((1 - pctRank(ky, peerKmY)) * 100, 0, 100); // meno km/anno = meglio
      }
      if (peerAnni.length >= 2 && r.anno != null) {
        cEta = clamp(pctRank(r.anno, peerAnni) * 100, 0, 100); // più recente = meglio
      }
      const campi    = ['prezzo', 'anno', 'km', 'carburante', 'provincia'];
      const presenti = campi.filter(k => r[k] != null && r[k] !== '').length;
      const cCompl   = (presenti / campi.length) * 100;

      r._score = Math.round(
        (cPrezzo * W.prezzo + cKm * W.kmAnnui + cEta * W.eta + cCompl * W.completezza) / wTot
      );

      // Medie comparabili (per i delta concreti)
      const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
      const peerKm   = peers.map(p => p.km).filter(v => v != null);
      const avgPrezzo = mean(peerPrices);
      const avgKm     = mean(peerKm);
      const avgAnno   = mean(peerAnni);

      // Ranking per convenienza (prezzo asc): 1 = più economico
      let priceRank = null, conveniencePct = null;
      const priceRankTot = peerPrices.length;
      if (r.prezzo != null && r.prezzo > 0 && priceRankTot >= 2) {
        priceRank = peerPrices.filter(p => p < r.prezzo).length + 1;
        conveniencePct = Math.round((priceRankTot - priceRank) / (priceRankTot - 1) * 100);
      }

      const lowData = peerPrices.length < 4;   // pochi simili → confronto poco affidabile

      r._scoreBreakdown = {
        prezzo: Math.round(cPrezzo), kmAnnui: Math.round(cKm),
        eta: Math.round(cEta), completezza: Math.round(cCompl),
        mediana: med,
        kmPerYear: ky != null ? Math.round(ky) : null,
        comparabili: peerPrices.length,
        lowData,
        avgPrezzo, avgKm, avgAnno,
        priceRank, priceRankTot, conveniencePct,
      };

      // Evidenziazioni (separate dal punteggio).
      // Flag prezzo (Affare/Sospetto) solo con campione sufficiente (>=4 simili).
      const flags = [];
      if (!lowData) {
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
