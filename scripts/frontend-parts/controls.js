
// ─── Prezzo di listino: Commissione (+ € o %), Spese (− €), Margine (rivendita %), IVA 22% ──
// `pricing`/`priceAdjActive`/`PRICE_DEFAULT` arrivano da pricing.js (globale). Stato per contesto,
// persistito in localStorage. Applicato coerentemente a righe/stats/slider/export.
function loadPriceCfg(key) { try { return Object.assign({}, PRICE_DEFAULT, JSON.parse(localStorage.getItem(key) || '{}')); } catch (_) { return Object.assign({}, PRICE_DEFAULT); } }
function savePriceCfg(key, cfg) {
  try { localStorage.setItem(key, JSON.stringify(cfg)); } catch (_) {}
  // Sono le cifre che finiscono stampate sul PDF del cliente: trovarne di diverse su un altro
  // computer vorrebbe dire due preventivi diversi per lo stesso mezzo.
  mieiPreferenza(key, JSON.stringify(cfg));
}
let priceCfgV = loadPriceCfg('amr_price_v');   // veicoli (auto/moto)
// Il costo del passaggio e' un dato del SINGOLO annuncio: dipende da potenza e provincia di
// quel veicolo. Se per quell'annuncio e' stato calcolato, il suo margine netto usa QUELLO;
// altrimenti resta il valore scritto a mano nel menu prezzi, che vale come default per tutti.
// (Con un solo importo globale, righe con potenza e provincia diverse mostravano un utile
// che non esisteva: fino a centinaia di euro di differenza tra Bolzano e Napoli.)
const passDi = r => (r && r._pass && r._pass.d && r._pass.d.ok ? r._pass.d.totaleNoto : null);
/**
 * LO SCORPORO IVA SOLO DOVE L'IVA C'E' DAVVERO.
 *
 * "Scorporo IVA 22%" e' un interruttore globale e si applicava a OGNI riga. Ma un'auto in
 * regime del margine l'IVA esposta non ce l'ha: scorporarla vuol dire scrivere un imponibile
 * e una quota IVA che non esistono. Misurato su una ricerca Golf 9-20k, 204 annunci: 5
 * dichiarano l'IVA esposta, 117 dichiarano il MARGINE, 82 la fonte non dice niente (Subito,
 * che il campo non lo manda). Sui 117 erano circa 1.651 € di IVA inventata per annuncio.
 *
 * Regola del proprietario: si scorpora solo dove la fonte DICHIARA l'IVA esposta. Dove tace,
 * le colonne restano vuote — vuote, non zero: "non lo so" e "non c'e'" non sono la stessa cosa.
 */
const ivaDichiarata = r => !!(r && r.ivaEsposta === true);
const cfgPerRiga = r => (priceCfgV.iva && !ivaDichiarata(r) ? Object.assign({}, priceCfgV, { iva: false }) : priceCfgV);
// `r` assente (etichette del cursore prezzi, minimo di un gruppo): li' si legge solo `finale`,
// che dall'IVA non dipende — ma lo scorporo si spegne lo stesso, per non dare mai un
// imponibile a chi non ha passato un annuncio.
const vPricing = (base, pass, r) => {
  const cfg = cfgPerRiga(r);
  return pricing(base, pass == null ? cfg : Object.assign({}, cfg, { passaggio: pass }));
};
/** Perche' le colonne IVA di questa riga sono vuote, quando l'interruttore e' acceso. */
function notaIva(r) {
  if (!priceCfgV.iva || ivaDichiarata(r)) return '';
  return r && r.ivaEsposta === false ? 'regime del margine: niente IVA da scorporare' : 'IVA non dichiarata dalla fonte';
}
const eurRound = n => '€ ' + Math.round(n).toLocaleString('it-IT');
/**
 * L'ETICHETTA del prezzo per chi ne mostra UNO solo (confronto e avvisi): il
 * finale rettificato della riga, con lo stesso motore delle colonne (vPricing). Questi
 * punti stampavano `r.prezzo` grezzo, e lo stesso annuncio aveva DUE prezzi a schermo —
 * il rettificato in griglia e il grezzo nel confronto — contro la regola «mai due prezzi».
 */
const prezzoEtichetta = r => {
  if (!r || r.prezzo == null) return r && r.prezzoSuRichiesta ? 'su richiesta' : '—';
  const pr = vPricing(r.prezzo, passDi(r), r);
  return pr ? eurRound(pr.finale) : '—';
};

// Dropdown "Prezzo €" (riusa lo stile .tb-cols di "Colonne"). ns = 'v' | 'r'.
function priceMenuHTML(cfg, ns) {
  const pct = cfg.commUnit === 'pct';
  const num = v => (v ? String(v) : '');
  return `<details class="tb-cols price-menu${priceAdjActive(cfg) ? ' has-adj' : ''}">
    <summary class="tb-btn">Prezzo €</summary>
    <div class="tb-cols-menu price-menu-body">
      <label class="pm-row"><span>Commissione</span><span class="pm-inp"><input type="number" inputmode="numeric" min="0" step="10" id="pmComm_${ns}" value="${num(cfg.comm)}" placeholder="0"><button type="button" class="pm-unit" id="pmUnit_${ns}" title="Cambia unità">${pct ? '%' : '€'}</button></span></label>
      <label class="pm-row"><span>Spese</span><span class="pm-inp"><input type="number" inputmode="numeric" min="0" step="10" id="pmSpese_${ns}" value="${num(cfg.spese)}" placeholder="0"><span class="pm-unit-static">€</span></span></label>
      <label class="pm-row"><span>Margine rivendita</span><span class="pm-inp"><input type="number" inputmode="numeric" min="0" step="1" id="pmMarg_${ns}" value="${num(cfg.margine)}" placeholder="0"><span class="pm-unit-static">%</span></span></label>
      ${ns === 'v' ? `<label class="pm-row" title="Costo della pratica: si sottrae al margine, non al prezzo"><span>Passaggio</span><span class="pm-inp"><input type="number" inputmode="numeric" min="0" step="10" id="pmPass_${ns}" value="${num(cfg.passaggio)}" placeholder="0"><span class="pm-unit-static">€</span></span></label>` : ''}
      ${ns === 'v' ? `<label class="pm-check"><input type="checkbox" id="pmIva_${ns}"${cfg.iva ? ' checked' : ''}> Scorporo IVA 22%</label>` : ''}
      <button type="button" class="pm-reset" id="pmReset_${ns}">Azzera</button>
    </div>
  </details>`;
}
// Rilegge i campi del menu (namespace ns) → nuovo cfg (commUnit dal precedente, flippato altrove).
function readPriceMenu(ns, prev) {
  const g = id => document.getElementById(id + '_' + ns);
  const n = el => Math.max(0, Number(el && el.value) || 0);
  const pass = g('pmPass');
  return { comm: n(g('pmComm')), commUnit: prev.commUnit, spese: n(g('pmSpese')), margine: n(g('pmMarg')),
    iva: g('pmIva') ? !!g('pmIva').checked : !!prev.iva,
    passaggio: pass ? n(pass) : (prev.passaggio || 0) };   // il campo esiste solo per i veicoli
}
// Colonne/celle extra prezzo per export (rivendita/imponibile/IVA) in base a cfg.
// `conPass` = c'e' un costo di pratica da qualche parte: quello globale del menu OPPURE uno
// calcolato su singoli annunci. Guardare solo il globale faceva sparire dall'export la
// colonna del margine netto proprio quando i costi per-annuncio c'erano.
function priceExtraHeaders(cfg, conPass) {
  const h = [];
  if (cfg.margine > 0) h.push('Rivendita (€)');
  if (cfg.margine > 0 && (cfg.passaggio || conPass)) h.push('Margine netto (€)');
  if (cfg.iva) h.push('Imponibile (€)', 'IVA 22% (€)');
  return h;
}
function priceExtraValues(pr, cfg, conPass) {   // pr = pricing() | null ; ritorna numeri arrotondati o ''
  const v = [], r = x => (x == null ? '' : Math.round(x));
  if (cfg.margine > 0) v.push(r(pr && pr.rivendita));
  // La colonna resta per tutte le righe, ma la CELLA si riempie solo dove un costo di pratica
  // esiste davvero per quella riga: senza questo, calcolare il passaggio su un annuncio solo
  // stampava il margine LORDO sugli altri 19, che nel foglio sembrano cosi' i piu' redditizi.
  // Stessa regola della UI di riga (priceRowExtraHTML).
  if (cfg.margine > 0 && (cfg.passaggio || conPass)) v.push(r(pr && pr.passaggio ? pr.margineNetto : null));
  if (cfg.iva) { v.push(r(pr && pr.imponibile)); v.push(r(pr && pr.ivaQuota)); }
  return v;
}
// Sotto-note riga: "→ riv. €X" e "imp. €Y + IVA €Z" (vuoto se non attivi). fmt = formatter €.
// `nota` = perche' l'IVA non c'e' su questa riga, quando l'interruttore e' acceso: senza,
// l'operatore vedeva la sotto-nota su una riga e non sull'altra senza sapere il motivo.
function priceRowExtraHTML(pr, fmt, nota) {
  if (!pr) return '';
  fmt = fmt || eurRound;
  let s = '';
  if (pr.rivendita != null) s += `<span class="row-riv">→ riv. ${fmt(pr.rivendita)}</span>`;
  // Con il costo del passaggio impostato si mostra il margine NETTO: il lordo illude.
  if (pr.margineNetto != null && pr.passaggio) s += `<span class="row-marg">margine netto ${fmt(pr.margineNetto)}</span>`;
  if (pr.imponibile != null) s += `<span class="row-iva">imp. ${fmt(pr.imponibile)} + IVA ${fmt(pr.ivaQuota)}</span>`;
  else if (nota) s += `<span class="row-iva row-iva-no">${escapeHtml(nota)}</span>`;
  return s;
}
// Menu prezzo veicoli (toolbar statica): render e gestione dei campi.
function renderPriceMenuV() {
  const host = document.getElementById('priceMenuV');
  if (!host) return;
  const wasOpen = host.querySelector('details')?.open;
  host.innerHTML = priceMenuHTML(priceCfgV, 'v');
  if (wasOpen) { const d = host.querySelector('details'); if (d) d.open = true; }
  wirePriceMenuV();
}
function wirePriceMenuV() {
  const host = document.getElementById('priceMenuV');
  if (!host) return;
  const apply = (rerenderMenu) => {
    savePriceCfg('amr_price_v', priceCfgV);
    if (rerenderMenu) renderPriceMenuV();
    else host.querySelector('.price-menu')?.classList.toggle('has-adj', priceAdjActive(priceCfgV));
    renderResults(currentResults);
  };
  ['pmComm_v', 'pmSpese_v', 'pmMarg_v', 'pmPass_v'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { priceCfgV = readPriceMenu('v', priceCfgV); apply(false); }));
  document.getElementById('pmIva_v')?.addEventListener('change', () => { priceCfgV = readPriceMenu('v', priceCfgV); apply(false); });
  document.getElementById('pmUnit_v')?.addEventListener('click', () => { priceCfgV.commUnit = priceCfgV.commUnit === 'pct' ? 'eur' : 'pct'; priceCfgV = readPriceMenu('v', priceCfgV); apply(true); });
  document.getElementById('pmReset_v')?.addEventListener('click', () => { priceCfgV = Object.assign({}, PRICE_DEFAULT); apply(true); });
}
// Il dropdown "Prezzo €" sta a destra nella toolbar → ancora a destra; se sforerebbe a sinistra
// (bottone troppo a sx, es. toolbar stretta) ripiega su ancoraggio a sinistra. Niente overflow.
function positionPriceMenu(det) {
  const body = det && det.querySelector('.price-menu-body');
  if (!body) return;
  body.style.left = 'auto'; body.style.right = '0';
  if (body.getBoundingClientRect().left < 8) { body.style.left = '0'; body.style.right = 'auto'; }
}

// ─── Tema (light/dark commutabile) ──────────────────────────────────────────
function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'light'; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('amr_theme', t); } catch (_) {}
  if (themeToggle) { themeToggle.innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); themeToggle.title = t === 'dark' ? 'Tema chiaro' : 'Tema scuro'; }
}

// ─── Toast leggero ──────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.amr-toast');
  if (!el) { el = document.createElement('div'); el.className = 'amr-toast'; document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
