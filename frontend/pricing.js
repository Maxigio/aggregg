'use strict';
// Modello "prezzo di listino" condiviso da UI ed export (veicoli + ricambi).
// Puro (nessun DOM/localStorage) → testabile in node e usabile come globale nel browser.
// Leve: Commissione (+, € o %), Spese (−, €), Margine rivendita (%), Scorporo IVA 22%,
// Passaggio di proprietà (−, €: costo reale della pratica, dal calcolo IPT per provincia).
// Il passaggio NON entra nel prezzo di rivendita: è un costo che l'operatore sostiene, quindi
// si sottrae al MARGINE. Senza questo, il margine mostrato era piu' alto del reale.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node (test)
  else Object.assign(root, api);                                               // browser (globali)
})(typeof self !== 'undefined' ? self : this, function () {
  const IVA_RATE = 0.22;
  const PRICE_DEFAULT = { comm: 0, commUnit: 'eur', spese: 0, margine: 0, iva: false, passaggio: 0 };

  // base (numero €) + cfg → { finale, rivendita, imponibile, ivaQuota, passaggio,
  // margineEuro, margineNetto } | null se base non numerica.
  function pricing(base, cfg) {
    cfg = cfg || PRICE_DEFAULT;
    if (typeof base !== 'number' || !isFinite(base)) return null;
    const add = cfg.commUnit === 'pct' ? base * (cfg.comm || 0) / 100 : (cfg.comm || 0);
    const finale = Math.max(0, base + add - (cfg.spese || 0));
    const imponibile = cfg.iva ? finale / (1 + IVA_RATE) : null;
    const rivendita = cfg.margine > 0 ? finale * (1 + cfg.margine / 100) : null;
    const passaggio = Math.max(0, Number(cfg.passaggio) || 0);
    // Margine in EURO, che il modello prima non dava: il % da solo non dice quanto si guadagna.
    const margineEuro = rivendita != null ? rivendita - finale : null;
    return {
      finale, rivendita, imponibile,
      ivaQuota: cfg.iva ? finale - imponibile : null,
      passaggio: passaggio || null,
      margineEuro,
      // Margine al netto del costo della pratica: e' il guadagno che resta davvero.
      margineNetto: margineEuro != null ? margineEuro - passaggio : null,
    };
  }

  const priceAdjActive = cfg => !!(cfg && (cfg.comm || cfg.spese || cfg.margine || cfg.iva || cfg.passaggio));

  return { pricing, priceAdjActive, PRICE_DEFAULT, IVA_RATE };
});
