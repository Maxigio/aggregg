'use strict';
// Modello "prezzo di listino" condiviso da UI ed export (veicoli + ricambi).
// Puro (nessun DOM/localStorage) → testabile in node e usabile come globale nel browser.
// Leve: Commissione (+, € o %), Spese (−, €), Margine rivendita (%), Scorporo IVA 22%.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // node (test)
  else Object.assign(root, api);                                               // browser (globali)
})(typeof self !== 'undefined' ? self : this, function () {
  const IVA_RATE = 0.22;
  const PRICE_DEFAULT = { comm: 0, commUnit: 'eur', spese: 0, margine: 0, iva: false };

  // base (numero €) + cfg → { finale, rivendita, imponibile, ivaQuota } | null se base non numerica.
  function pricing(base, cfg) {
    cfg = cfg || PRICE_DEFAULT;
    if (typeof base !== 'number' || !isFinite(base)) return null;
    const add = cfg.commUnit === 'pct' ? base * (cfg.comm || 0) / 100 : (cfg.comm || 0);
    const finale = Math.max(0, base + add - (cfg.spese || 0));
    const imponibile = cfg.iva ? finale / (1 + IVA_RATE) : null;
    return {
      finale,
      rivendita: cfg.margine > 0 ? finale * (1 + cfg.margine / 100) : null,
      imponibile,
      ivaQuota: cfg.iva ? finale - imponibile : null,
    };
  }

  const priceAdjActive = cfg => !!(cfg && (cfg.comm || cfg.spese || cfg.margine || cfg.iva));

  return { pricing, priceAdjActive, PRICE_DEFAULT, IVA_RATE };
});
