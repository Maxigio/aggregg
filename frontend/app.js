// ─── Elementi DOM ─────────────────────────────────────────────────────────────
const form            = document.getElementById('searchForm');
const statusBox       = document.getElementById('statusBox');
const loadingState    = document.getElementById('loadingState');
const errorState      = document.getElementById('errorState');
const errorText       = document.getElementById('errorText');
const errorClose      = document.getElementById('errorClose');
const resultsSection  = document.getElementById('resultsSection');
const resultsGrid     = document.getElementById('resultsGrid');
const resultsCount    = document.getElementById('resultsCount');
const fonteBreakdown  = document.getElementById('fonteBreakdown');
const noResults       = document.getElementById('noResults');
const marcaSelect     = document.getElementById('marca');
const marcaNote       = document.getElementById('marcaNote');
const btnCerca        = document.getElementById('btnCerca');
const regioneSelect   = document.getElementById('regione');
const modelloSelect   = document.getElementById('modello');
const versioneRow     = document.getElementById('versioneRow');
const versioneSelect  = document.getElementById('versione');
const versioneNote    = document.getElementById('versioneNote');
const tipoInputs      = document.querySelectorAll('input[name="tipo"]');
const backToSearch    = document.getElementById('backToSearch');
const resultsToolbar  = document.getElementById('resultsToolbar');
const facetChipsEl    = document.getElementById('facetChips');
const sortMobile      = document.getElementById('sortMobile');
const advancedToggle  = document.getElementById('advancedToggle');
const advancedFilters = document.getElementById('advancedFilters');
const logoBtn         = document.getElementById('logoBtn');
const qrPanel         = document.getElementById('qrPanel');
const themeToggle     = document.getElementById('themeToggle');
const prezzoSliderEl  = document.getElementById('prezzoSlider');
const btnStatCsv      = document.getElementById('btnStatCsv');
const btnStatPdf      = document.getElementById('btnStatPdf');
const subitoBanner    = document.getElementById('subitoBootstrapBanner');
const btnBootstrap    = document.getElementById('btnBootstrapSubito');
const bootstrapBtnText    = document.getElementById('bootstrapBtnText');
const bootstrapBtnSpinner = document.getElementById('bootstrapBtnSpinner');
// Confronto
const compareBar   = document.getElementById('compareBar');
const compareCount = document.getElementById('compareCount');
const compareOpen  = document.getElementById('compareOpen');
const compareClear = document.getElementById('compareClear');
const cmatrixPanel = document.getElementById('cmatrixPanel');
const cmatrixTitle = document.getElementById('cmatrixTitle');
const cmatrixClose = document.getElementById('cmatrixClose');
const cmatrixBody = document.getElementById('cmatrixBody');

// ─── Stato ────────────────────────────────────────────────────────────────────
let currentResults = [];
let confronto      = [];                       // annunci selezionati per il confronto (cap 10)
let matrixList     = [];                        // annunci attualmente mostrati nella matrice
let salvati        = [];
let groupDim       = '';                        // dimensione di raggruppamento attiva ('' = nessuna)
let modelCache     = {};                        // `${tipo}|${marca}` → [{nome, sites, mmmvAutoscout, slugMotoIt}]
let selectedModel  = null;                       // modello scelto dalla force-select (con _marca) o null (testo libero)
let selectedVersion = null;                      // versione Moto.it scelta {nome, code} o null
let versioniCorrenti = [];                       // versioni del modello attuale (per l'autocomplete)
let sortState      = { key: 'prezzo', dir: 'asc' };
let visibleCols    = ['anno', 'km'];            // colonne opzionali mostrate (default dai filtri usati)
let lastSources    = null;
let prezzoSliderInstance = null;
let lastSearchParams = null;
let savedSearches  = [];
let sliderGlobalBounds = [0, 0];
let myRole         = 'full';
let searchActive   = false;                     // true dopo una ricerca → la toolbar può apparire
const COMPARE_CAP  = 10;

const brandCache = { auto: null, moto: null };
const FONTE_LABEL = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };

// ─── Icone (SVG inline, offline) ────────────────────────────────────────────
const ICONS = {
  bookmark:          '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  'bookmark-filled': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" fill="currentColor"/>',
  square:            '<rect x="3" y="3" width="18" height="18" rx="2"/>',
  'square-check':    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 12 2 2 4-4"/>',
  info:              '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  chevron:           '<path d="m6 9 6 6 6-6"/>',
  search:            '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  x:                 '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  moon:              '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  sun:               '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  bulb:              '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5"/>',
};
function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// ─── Prezzo di listino: Commissione (+ € o %), Spese (− €), Margine (rivendita %), IVA 22% ──
// `pricing`/`priceAdjActive`/`PRICE_DEFAULT` arrivano da pricing.js (globale). Stato per contesto,
// persistito in localStorage. Applicato coerentemente a righe/stats/slider/export.
function loadPriceCfg(key) { try { return Object.assign({}, PRICE_DEFAULT, JSON.parse(localStorage.getItem(key) || '{}')); } catch (_) { return Object.assign({}, PRICE_DEFAULT); } }
function savePriceCfg(key, cfg) { try { localStorage.setItem(key, JSON.stringify(cfg)); } catch (_) {} }
let priceCfgV = loadPriceCfg('amr_price_v');   // veicoli (auto/moto)
let priceCfgR = loadPriceCfg('amr_price_r');   // ricambi
const vPricing = base => pricing(base, priceCfgV);
const rPricing = base => pricing(base, priceCfgR);
const eurRound = n => '€ ' + Math.round(n).toLocaleString('it-IT');

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
      <label class="pm-check"><input type="checkbox" id="pmIva_${ns}"${cfg.iva ? ' checked' : ''}> Scorporo IVA 22%</label>
      <button type="button" class="pm-reset" id="pmReset_${ns}">Azzera</button>
    </div>
  </details>`;
}
// Rilegge i campi del menu (namespace ns) → nuovo cfg (commUnit dal precedente, flippato altrove).
function readPriceMenu(ns, prev) {
  const g = id => document.getElementById(id + '_' + ns);
  const n = el => Math.max(0, Number(el && el.value) || 0);
  return { comm: n(g('pmComm')), commUnit: prev.commUnit, spese: n(g('pmSpese')), margine: n(g('pmMarg')), iva: !!(g('pmIva') && g('pmIva').checked) };
}
// Colonne/celle extra prezzo per export (rivendita/imponibile/IVA) in base a cfg.
function priceExtraHeaders(cfg) {
  const h = [];
  if (cfg.margine > 0) h.push('Rivendita (€)');
  if (cfg.iva) h.push('Imponibile (€)', 'IVA 22% (€)');
  return h;
}
function priceExtraValues(pr, cfg) {   // pr = pricing() | null ; ritorna numeri arrotondati o ''
  const v = [], r = x => (x == null ? '' : Math.round(x));
  if (cfg.margine > 0) v.push(r(pr && pr.rivendita));
  if (cfg.iva) { v.push(r(pr && pr.imponibile)); v.push(r(pr && pr.ivaQuota)); }
  return v;
}
// Sotto-note riga: "→ riv. €X" e "imp. €Y + IVA €Z" (vuoto se non attivi). fmt = formatter €.
function priceRowExtraHTML(pr, fmt) {
  if (!pr) return '';
  fmt = fmt || eurRound;
  let s = '';
  if (pr.rivendita != null) s += `<span class="row-riv">→ riv. ${fmt(pr.rivendita)}</span>`;
  if (pr.imponibile != null) s += `<span class="row-iva">imp. ${fmt(pr.imponibile)} + IVA ${fmt(pr.ivaQuota)}</span>`;
  return s;
}
// Menu prezzo veicoli (toolbar statica): render + wiring. Per i ricambi è dentro rcToolbarHTML.
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
  ['pmComm_v', 'pmSpese_v', 'pmMarg_v'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { priceCfgV = readPriceMenu('v', priceCfgV); apply(false); }));
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

// ─── Modalità demo (ospite read-only) ───────────────────────────────────────
function applyDemoMode() {
  document.body.classList.add('demo-mode');
  ['btnSalvaRicerca', 'btnControllaTutte', 'modeToggle'].forEach(id => {   // modo Valuta = solo papà
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  setSearchMode('cerca');   // demo resta in Cerca (niente Valuta)
  if (!document.querySelector('.demo-banner')) {
    const bar = document.createElement('div');
    bar.className = 'demo-banner';
    bar.textContent = 'Modalità demo — sola lettura: puoi cercare ed esplorare, i salvataggi sono disattivati.';
    document.body.prepend(bar);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  applyTheme(currentTheme());
  const currentYear = new Date().getFullYear();
  document.getElementById('annoMin').max = currentYear;
  document.getElementById('annoMax').max = currentYear;
  document.getElementById('annoMax').placeholder = `es. ${currentYear}`;
  document.body.dataset.tipo = currentTipo();

  populateRegione();
  renderFacetChips();
  await populateMarca('auto');
  setupMarcaAutocomplete();
  setupModelloAutocomplete();
  setupVersioneAutocomplete();
  document.getElementById('versioneNoteClose')?.addEventListener('click', () => versioneNote?.classList.add('d-none'));
  validateMarca();
  await applyUrlParams();

  try {
    const me = await fetch('/api/me').then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (me && me.role) myRole = me.role;
    if (myRole === 'demo') applyDemoMode();
  } catch (_) {}

  themeToggle?.addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));

  tipoInputs.forEach(input => input.addEventListener('change', async () => {
    document.body.dataset.tipo = input.value;
    await populateMarca(input.value);
    marcaSelect.value = '';
    document.getElementById('modello').value = '';
    resetModelloVersione();
    validateMarca();
    currentResults = []; hideResults();
  }));

  // Toolbar: sort mobile + facet
  sortMobile?.addEventListener('change', () => {
    const [key, dir] = sortMobile.value.split('_').length === 2
      ? [sortMobile.value.split('_')[0], sortMobile.value.split('_')[1]] : ['prezzo', 'asc'];
    sortState = { key, dir };
    renderResults(currentResults);
  });
  facetChipsEl?.addEventListener('click', e => {
    const chip = e.target.closest('.facet-chip'); if (!chip) return;
    groupDim = chip.dataset.dim || '';
    renderResults(currentResults);
  });
  // Menu "Colonne": toggle colonne opzionali (anno/km/carb/cv) live.
  document.querySelectorAll('.col-toggle').forEach(cb => cb.addEventListener('change', () => {
    visibleCols = OPTIONAL_COLS.filter(k => document.querySelector(`.col-toggle[value="${k}"]`)?.checked);
    renderResults(currentResults);
  }));
  renderPriceMenuV();   // menu "Prezzo €" (Commissione/Spese/Margine/IVA) nella toolbar veicoli
  // riposiziona il dropdown "Prezzo €" all'apertura (veicoli + ricambi; delegato → sopravvive ai re-render)
  document.addEventListener('click', e => {
    const sum = e.target.closest('.price-menu > summary');
    if (!sum) return;
    requestAnimationFrame(() => { const det = sum.parentElement; if (det && det.open) positionPriceMenu(det); });
  });
  // scheda veicolo: collapse + cambio generazione/motorizzazione (delegato, sopravvive ai re-render)
  const vehSchedaEl = document.getElementById('vehicleScheda');
  vehSchedaEl?.addEventListener('click', e => {
    const exp = e.target.closest('.veh-exp');   // Esporta ▾: Copia / CSV / PDF
    if (exp) {
      const kind = exp.dataset.exp;
      if (kind === 'copia') { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(vehSchedaText()).then(() => { exp.textContent = 'Copiato ✓'; setTimeout(() => exp.textContent = 'Copia negli appunti', 1200); }, () => {}); }
      else if (kind === 'csv') vehDownload('scheda-tecnica.csv', vehSchedaCsv(), 'text/csv;charset=utf-8');
      else if (kind === 'pdf') vehSchedaPdf();
      return;
    }
    const tb = e.target.closest('.veh-tb-btn');   // toolbar / toggle IT
    if (tb) {
      if (tb.classList.contains('veh-it')) { vehXf.translate = !vehXf.translate; tb.classList.toggle('on', vehXf.translate); renderVehBody(); }
      else if (tb.classList.contains('veh-tb-all')) { vehXf.allOpen = vehXf.allOpen === true ? false : true; renderVehScheda(); }
      else if (tb.classList.contains('veh-tb-cmp')) {
        if (vehXf.compare) vehXf.compare = null;
        else { const alt = (vehData && vehData.motorizzazioni || []).find(m => m.url !== vehSelUrl); vehXf.compare = alt ? alt.url : null; if (vehXf.compare) fetchVehSpecs(vehXf.compare); }
        renderVehScheda();
      }
      return;   // summary Unità/Esporta (anch'essi .veh-tb-btn) → nessun ramo, il <details> nativo fa il toggle
    }
    const showAllBtn = e.target.closest('.veh-showall');   // filtro anni: mostra tutte / filtra
    if (showAllBtn) { vehShowAll = showAllBtn.dataset.showall === '1'; renderVehBody(); return; }
    const genCard = e.target.closest('.veh-gen-card');   // griglia generazioni → scegli
    if (genCard) { switchVehGen(genCard.dataset.slug); return; }
    const motoCard = e.target.closest('.veh-moto-card');   // griglia motorizzazioni → scegli
    if (motoCard) { vehSelUrl = motoCard.dataset.url; renderVehScheda(); fetchVehSpecs(vehSelUrl); return; }
    const grpHead = e.target.closest('.veh-grp-head');   // sezione accordion interna
    if (grpHead) { grpHead.parentElement.classList.toggle('veh-collapsed'); return; }
    const head = e.target.closest('.rc-sched-head'); if (!head) return;
    const g = head.closest('.rc-group'); g.classList.toggle('collapsed'); vehSchedaCollapsed = g.classList.contains('collapsed');
    const s = vehSpecs[vehSelUrl];
    if (!vehSchedaCollapsed && vehSelUrl && (!s || (!s.loading && !s.ok))) fetchVehSpecs(vehSelUrl);   // riprova le specs fallite alla riapertura
  });
  // combobox scheda: lista visibile filtrata + click/keyboard (come marca/modello); + ricerca-campo toolbar
  vehSchedaEl?.addEventListener('input', e => {
    if (e.target.classList.contains('veh-combo')) vehComboOpen(e.target, true);
    else if (e.target.classList.contains('veh-tb-q')) { vehXf.q = e.target.value; applyVehViewState(); }
  });
  vehSchedaEl?.addEventListener('change', e => {
    if (e.target.classList.contains('veh-tb-unit')) {   // selettore unità → converti (solo corpo, il <details> resta aperto)
      const fam = e.target.dataset.fam;
      if (e.target.value) vehXf.units[fam] = e.target.value; else delete vehXf.units[fam];
      const det = e.target.closest('.veh-units'); if (det) det.classList.toggle('has-adj', Object.values(vehXf.units).some(Boolean));
      renderVehBody();
    } else if (e.target.classList.contains('veh-hl-cb')) {   // checkbox "in evidenza" per-campo
      const k = e.target.dataset.k;
      if (e.target.checked) vehXf.highlight.add(k); else vehXf.highlight.delete(k);
      renderVehBody();
    }
  });
  vehSchedaEl?.addEventListener('focusin', e => { if (e.target.classList.contains('veh-combo')) { e.target.select?.(); vehComboOpen(e.target, false); } });
  vehSchedaEl?.addEventListener('focusout', e => { if (e.target.classList.contains('veh-combo')) { const inp = e.target; setTimeout(() => { vehComboClose(inp); vehComboRestore(inp); }, 150); } });
  vehSchedaEl?.addEventListener('keydown', e => {
    const inp = e.target; if (!inp.classList || !inp.classList.contains('veh-combo')) return;
    const list = inp.parentElement.querySelector('.veh-ac'); if (!list || list.classList.contains('d-none')) return;
    const matches = inp._vehMatches || []; if (!matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); vehAcActive = (vehAcActive + 1) % matches.length; renderVehAc(inp, matches); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); vehAcActive = (vehAcActive - 1 + matches.length) % matches.length; renderVehAc(inp, matches); }
    else if (e.key === 'Enter') { if (vehAcActive >= 0) { e.preventDefault(); const it = matches[vehAcActive]; pickVehCombo(inp, it.key, it.label); } }
    else if (e.key === 'Escape') { vehComboClose(inp); vehComboRestore(inp); }
  });
  vehSchedaEl?.addEventListener('mousedown', e => {
    const li = e.target.closest('.veh-ac .ac-item'); if (!li) return;
    e.preventDefault();   // evita il blur prima del pick
    const inp = li.closest('.veh-combo-wrap').querySelector('.veh-combo');
    pickVehCombo(inp, li.dataset.key, li.dataset.label);
  });
  // Responsività colonne in JS (l'inline grid-template vince sulle media-query).
  let _resizeT;
  window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(() => {
    if (searchActive) renderResults(currentResults);
    if (!cmatrixPanel.classList.contains('d-none')) renderMatrix();   // tabella↔card attraversando il breakpoint
  }, 200); });

  btnStatCsv.addEventListener('click', () => exportCsv(currentResults));
  btnStatPdf.addEventListener('click', () => exportPdf(currentResults));
  errorClose.addEventListener('click', hideError);
  backToSearch.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  form.addEventListener('submit', async (e) => { e.preventDefault(); if (searchMode === 'valuta') await doValuta(); else if (searchMode === 'ricambi') await doRicambi(); else await doSearch(); });

  // Nav primaria Auto · Moto · Ricambi (data-mode). Auto/Moto = ricerca veicolo (pilota il
  // radio tipo nascosto); Ricambi = pipeline parti. 'Valuta' non è più nella UI (dormiente).
  document.getElementById('modeToggle')?.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn'); if (!btn) return;
    selectPrimary(btn.dataset.mode);
  });

  // Confronto / matrice
  compareOpen?.addEventListener('click', () => openCompareMatrix());
  compareClear?.addEventListener('click', () => { confronto = []; renderResults(currentResults); renderSalvati(); renderCompareBar(); closeMatrix(); });
  cmatrixClose?.addEventListener('click', closeMatrix);

  // Segnalazioni (bug-report)
  document.getElementById('btnReport')?.addEventListener('click', () => openReport());
  document.getElementById('reportClose')?.addEventListener('click', closeReport);
  document.getElementById('reportSend')?.addEventListener('click', submitReport);
  document.getElementById('reportModal')?.addEventListener('click', e => { if (e.target.id === 'reportModal') closeReport(); });

  // Ricerche salvate + avvisi
  document.getElementById('btnSalvaRicerca').addEventListener('click', saveCurrentSearch);
  document.getElementById('btnControllaTutte').addEventListener('click', () => checkRicerche());
  document.getElementById('ricercheList').addEventListener('click', onRicercheClick);
  loadSavedSearches();
  // Auto-check al boot = il server ricontrolla già le ricerche stantie (gentile, anti-ban).
  // Qui NON facciamo una POST (sarebbe doppio scraping): ricarichiamo i salvati dopo ~13s
  // (GET, zero scraping) per riflettere gli avvisi appena calcolati dal server.
  setTimeout(loadSavedSearches, 13000);
  loadSalvati();

  // Thumbnail rotta → slot grigio
  resultsGrid.addEventListener('error', e => {
    const img = e.target;
    if (img && img.tagName === 'IMG') { const t = img.closest('.row-thumb'); if (t) t.classList.add('noimg'); }
  }, true);

  // Delegation: griglia
  resultsGrid.addEventListener('click', e => {
    const sortBtn = e.target.closest('.gh-sort');
    if (sortBtn) { setSort(sortBtn.dataset.key); return; }
    const groupHeader = e.target.closest('.group-header');
    if (groupHeader) { groupHeader.closest('.result-group')?.classList.toggle('collapsed'); return; }

    const row = e.target.closest('[data-url]');
    if (!row) return;
    const url = row.dataset.url;
    // Galleria del pannello dettaglio inline → lightbox.
    if (e.target.closest('.det-gallery')) {
      const r = trovaResult(url);
      if (r && Array.isArray(r.immagini) && r.immagini.length) openLightbox(r.immagini);
      return;
    }
    // Azioni nel pannello dettaglio (hub azioni: Salva/Confronta; "Apri annuncio" è un <a> nativo).
    if (row.dataset.detail) {
      if (e.target.closest('.btn-salva'))    { toggleSalva(url); return; }
      if (e.target.closest('.btn-confronta')) { toggleConfronto(url); return; }
      return;   // altri click nel pannello: ignora
    }
    if (e.target.closest('.row-thumb')) {
      const r = trovaResult(url);
      if (r && Array.isArray(r.immagini) && r.immagini.length) openLightbox(r.immagini);
      return;
    }
    // Mobile: tap sulla riga (non sulla thumb) → apre il dettaglio (azioni dentro). Desktop: titolo→annuncio, bottoni espliciti.
    if (window.matchMedia('(max-width: 860px)').matches) { toggleDetail(row); return; }
    if (e.target.closest('.row-titolo')) { openAd(url); return; }
    if (e.target.closest('.btn-salva'))     { toggleSalva(url); return; }
    if (e.target.closest('.btn-confronta'))  { toggleConfronto(url); return; }
    if (e.target.closest('.btn-info'))       { toggleDetail(row); return; }
  });

  // Delegation: pannello salvati
  document.getElementById('salvatiList').addEventListener('click', e => {
    const item = e.target.closest('[data-url]'); if (!item) return;
    const url = item.dataset.url;
    if (e.target.closest('.btn-rimuovi-salvato'))   { toggleSalva(url); return; }
    if (e.target.closest('.btn-confronta-salvato'))  { toggleConfronto(url); return; }
    openAd(url);
  });

  // Delegation: confronto (rimuovi colonna/card) — sul wrapper, vale per tabella E card.
  cmatrixBody.addEventListener('click', e => {
    const rm = e.target.closest('.cm-rm'); if (rm) { removeMatrixCol(rm.dataset.url); return; }
  });

  // min/max cliccabili (toolbar)
  resultsToolbar.addEventListener('click', e => {
    const btn = e.target.closest('.stat-clickable'); if (btn) scrollToCard(btn.dataset.url);
  });

  // Filtri avanzati toggle
  advancedToggle?.addEventListener('click', () => {
    const open = advancedFilters.classList.toggle('d-none');
    advancedToggle.setAttribute('aria-expanded', String(!open));
    advancedToggle.classList.toggle('open', !open);
  });

  // Logo → QR
  logoBtn?.addEventListener('click', async () => {
    document.getElementById('qrModal')?.classList.remove('d-none');   // p1: modal, niente scroll pagina
    logoBtn.setAttribute('aria-expanded', 'true');
    await loadQrPanel();
  });
  document.getElementById('qrClose')?.addEventListener('click', closeQr);
  document.getElementById('qrModal')?.addEventListener('click', e => { if (e.target.id === 'qrModal') closeQr(); });
  document.getElementById('btnReportNav')?.addEventListener('click', () => openReport());   // p4: Segnala in navbar
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeQr(); closeReport(); } });

  renderSalvati();
}

// ─── QR ──────────────────────────────────────────────────────────────────────
async function loadQrPanel() {
  qrPanel.innerHTML = '<p class="qr-empty">Caricamento…</p>';
  try {
    const r = await fetch('/api/public-url');
    const { url, svg } = await r.json();
    if (!url) { qrPanel.innerHTML = '<p class="qr-empty">Accesso pubblico non attivo (Funnel spento).</p>'; return; }
    qrPanel.innerHTML =
      '<p class="qr-hint">Inquadra col telefono per aprire l\'app (serve la password):</p>' +
      `<div class="qr-img">${svg}</div>` +
      `<a class="qr-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  } catch (_) { qrPanel.innerHTML = '<p class="qr-empty">Impossibile leggere l\'indirizzo.</p>'; }
}

function populateRegione() {
  const regioni = ['abruzzo','basilicata','calabria','campania','emilia-romagna','friuli-venezia-giulia','lazio','liguria','lombardia','marche','molise','piemonte','puglia','sardegna','sicilia','toscana','trentino-alto-adige','umbria','valle-d-aosta','veneto'];
  regioneSelect.innerHTML = '<option value="">Tutta Italia</option>';
  regioni.forEach(slug => {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    regioneSelect.appendChild(opt);
  });
}

function currentTipo() { return document.querySelector('input[name="tipo"]:checked')?.value || 'auto'; }

async function populateMarca(tipo) {
  if (!brandCache[tipo]) {
    try {
      const res = await fetch(`/api/brands?tipo=${encodeURIComponent(tipo)}`);
      if (!res.ok) return;                       // review: non cachare su errore (sennò marca rotta per sempre)
      const data = await res.json();
      brandCache[tipo] = data.brands || [];
    } catch { /* transitorio: lascia brandCache[tipo] undefined → ritenta al prossimo giro */ }
  }
}

// ─── Marca: force-select dal catalogo ───────────────────────────────────────
const acn = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
// Marca valida = combacia (canonica) con una voce di catalogo. '' valido finché vuoto.
function matchedBrand() {
  const q = acn(marcaSelect.value);
  if (!q) return null;
  const brands = brandCache[currentTipo()] || [];
  return brands.find(b => acn(b.nome) === q) || null;
}
function isValidMarca() { return !!matchedBrand(); }
function validateMarca() {
  const raw = marcaSelect.value.trim();
  const ok = isValidMarca();
  marcaSelect.classList.toggle('invalid', raw.length > 0 && !ok);
  btnCerca.disabled = !ok;
  if (!raw) marcaNote.textContent = '';
  else if (!ok) marcaNote.textContent = 'Scegli una marca dalla lista (digita e seleziona).';
  else marcaNote.textContent = '';
}

function setupMarcaAutocomplete() {
  const list = document.getElementById('marcaAC');
  if (!marcaSelect || !list) return;
  let matches = [], active = -1;
  const close = () => { list.classList.add('d-none'); list.innerHTML = ''; active = -1; marcaSelect.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    if (!matches.length) return close();
    list.innerHTML = matches.map((b, i) => `<li class="ac-item${i === active ? ' active' : ''}" role="option" data-i="${i}">${escapeHtml(b.nome)}</li>`).join('');
    list.classList.remove('d-none');
    marcaSelect.setAttribute('aria-expanded', 'true');
  };
  const pick = i => { if (matches[i]) { marcaSelect.value = matches[i].nome; close(); validateMarca(); if (modelloSelect) modelloSelect.value = ''; resetModelloVersione(); document.getElementById('modello')?.focus(); } };

  marcaSelect.addEventListener('input', () => {
    resetModelloVersione();
    const q = acn(marcaSelect.value);
    const brands = brandCache[currentTipo()] || [];
    if (q) {
      // Ranking: prefisso prima del semplice "contiene", poi posizione, poi alfabetico.
      const scored = [];
      for (const b of brands) {
        const n = acn(b.nome); const i = n.indexOf(q);
        if (i >= 0) scored.push({ b, rank: n.startsWith(q) ? 0 : 1, i, n });
      }
      scored.sort((a, c) => a.rank - c.rank || a.i - c.i || a.n.localeCompare(c.n));
      matches = scored.slice(0, 8).map(s => s.b);
    } else matches = [];
    active = matches.length ? 0 : -1;
    render(); validateMarca();
  });
  marcaSelect.addEventListener('keydown', e => {
    if (list.classList.contains('d-none') || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
    else if (e.key === 'Tab') { if (active >= 0) { e.preventDefault(); pick(active); } }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('.ac-item'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  marcaSelect.addEventListener('blur', () => setTimeout(() => { close(); validateMarca(); }, 120));
}

// ─── Modello: force-select dal catalogo (∪ API Moto.it) ─────────────────────
// F43: niente più testo libero fuzzy. L'utente SCEGLIE un modello reale; mandiamo
// gli ID esatti (mmmvAutoscout AS24, slugMotoIt). Testo libero resta come escape
// (Subito keyword): se non scegli, `selectedModel=null` e il server fa del suo meglio.
async function loadModels(tipo, marca) {
  const key = `${tipo}|${marca}`;
  if (!modelCache[key]) {
    try {
      const res = await fetch(`/api/models?tipo=${encodeURIComponent(tipo)}&marca=${encodeURIComponent(marca)}`);
      const data = await res.json();
      modelCache[key] = data.modelli || [];
    } catch { modelCache[key] = []; }
  }
  return modelCache[key];
}

function resetVersioneOnly() { selectedVersion = null; versioniCorrenti = []; if (versioneSelect) versioneSelect.value = ''; versioneRow?.classList.add('d-none'); versioneNote?.classList.add('d-none'); }
function resetModelloVersione() { selectedModel = null; resetVersioneOnly(); }

// Lazy-T2: carica le versioni-annata. Famiglia (slug) → bikes; voce-versione catalogo
// senza slug (es. "Dyna Fat Bob") → il server risolve famiglia+versioni dal nome.
// Salva il `_familySlug` risolto su selectedModel (= il `motoitModelSlug` da mandare).
async function loadVersioniFor(model) {
  const brand = matchedBrand();
  versioniCorrenti = [];
  if (selectedModel) selectedModel._familySlug = model.slugMotoIt || null;
  if (!brand) { resetVersioneOnly(); return; }
  const qs = new URLSearchParams({ marca: brand.nome });
  if (model.slugMotoIt) qs.set('modelSlug', model.slugMotoIt);
  else if (model.mmmvAutoscout) qs.set('modelNome', model.nome);   // voce-catalogo senza slug → risolvi
  else { resetVersioneOnly(); return; }
  try {
    const res = await fetch(`/api/moto-versions?${qs}`);
    const data = await res.json();
    versioniCorrenti = data.versioni || [];
    if (selectedModel && data.familySlug) selectedModel._familySlug = data.familySlug;
  } catch { versioniCorrenti = []; }
  if (versioniCorrenti.length) { versioneRow?.classList.remove('d-none'); versioneNote?.classList.add('d-none'); if (versioneSelect) versioneSelect.value = ''; }
  else { resetVersioneOnly(); versioneNote?.classList.remove('d-none'); }   // niente versioni → avviso dismissibile (no sparizione muta)
}

function setupModelloAutocomplete() {
  const list = document.getElementById('modelloAC');
  if (!modelloSelect || !list) return;
  let matches = [], active = -1;
  const close = () => { list.classList.add('d-none'); list.innerHTML = ''; active = -1; modelloSelect.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    if (!matches.length) return close();
    list.innerHTML = matches.map((m, i) => `<li class="ac-item${i === active ? ' active' : ''}" role="option" data-i="${i}">${escapeHtml(m.nome)}</li>`).join('');
    list.classList.remove('d-none'); modelloSelect.setAttribute('aria-expanded', 'true');
  };
  const pickModel = async (m) => {
    selectedModel = { ...m, _marca: matchedBrand()?.nome || '' };
    selectedVersion = null;
    modelloSelect.value = m.nome; close();
    if (currentTipo() === 'moto') await loadVersioniFor(m);   // decide slug-famiglia / nome-voce / niente
    else resetVersioneOnly();
  };
  const compute = async () => {
    const brand = matchedBrand();
    // testo cambiato a mano → annulla la scelta strutturata (no ID stantii)
    if (!selectedModel || acn(selectedModel.nome) !== acn(modelloSelect.value)) { selectedModel = null; resetVersioneOnly(); }
    if (!brand) { matches = []; return close(); }
    const models = await loadModels(currentTipo(), brand.nome);
    const q = acn(modelloSelect.value);
    if (q) {
      const scored = [];
      for (const m of models) { const n = acn(m.nome); const i = n.indexOf(q); if (i >= 0) scored.push({ m, rank: n.startsWith(q) ? 0 : 1, i, n }); }
      scored.sort((a, c) => a.rank - c.rank || a.i - c.i || a.n.localeCompare(c.n));
      matches = scored.slice(0, 10).map(s => s.m);
    } else matches = models.slice(0, 10);
    active = matches.length ? 0 : -1; render();
  };
  modelloSelect.addEventListener('input', compute);
  modelloSelect.addEventListener('focus', compute);
  modelloSelect.addEventListener('keydown', e => {
    if (list.classList.contains('d-none') || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pickModel(matches[active]); } }
    else if (e.key === 'Tab') { if (active >= 0) pickModel(matches[active]); }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('.ac-item'); if (li) { e.preventDefault(); pickModel(matches[+li.dataset.i]); } });
  modelloSelect.addEventListener('blur', () => setTimeout(close, 150));
}

function setupVersioneAutocomplete() {
  const list = document.getElementById('versioneAC');
  if (!versioneSelect || !list) return;
  let matches = [], active = -1;
  const close = () => { list.classList.add('d-none'); list.innerHTML = ''; active = -1; versioneSelect.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    if (!matches.length) return close();
    list.innerHTML = matches.map((v, i) => `<li class="ac-item${i === active ? ' active' : ''}" role="option" data-i="${i}">${escapeHtml(v.nome)}</li>`).join('');
    list.classList.remove('d-none'); versioneSelect.setAttribute('aria-expanded', 'true');
  };
  const pick = v => { selectedVersion = v; versioneSelect.value = v.nome; close(); };
  const compute = () => {
    if (!selectedVersion || acn(selectedVersion.nome) !== acn(versioneSelect.value)) selectedVersion = null;
    const q = acn(versioneSelect.value);
    if (q) {
      const scored = [];
      for (const v of versioniCorrenti) { const n = acn(v.nome); const i = n.indexOf(q); if (i >= 0) scored.push({ v, rank: n.startsWith(q) ? 0 : 1, i, n }); }
      scored.sort((a, c) => a.rank - c.rank || a.i - c.i || a.n.localeCompare(c.n));
      matches = scored.slice(0, 12).map(s => s.v);
    } else matches = versioniCorrenti.slice(0, 12);
    active = matches.length ? 0 : -1; render();
  };
  versioneSelect.addEventListener('input', compute);
  versioneSelect.addEventListener('focus', compute);
  versioneSelect.addEventListener('keydown', e => {
    if (list.classList.contains('d-none') || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(matches[active]); } }
    else if (e.key === 'Tab') { if (active >= 0) pick(matches[active]); }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('.ac-item'); if (li) { e.preventDefault(); pick(matches[+li.dataset.i]); } });
  versioneSelect.addEventListener('blur', () => setTimeout(close, 150));
}

// ─── Raggruppamento ──────────────────────────────────────────────────────────
function clusterModello(titolo) {
  if (!titolo) return '?';
  const norm = String(titolo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const tokens = norm.match(/[a-z0-9]+/g) || [];
  if (!tokens.length) return '?';
  const marca = tokens.find(t => /[a-z]/.test(t)) || tokens[0];
  const modello = tokens.find(t => /\d/.test(t)) || tokens.filter(t => t !== marca)[0] || '';
  return (marca + (modello ? ' ' + modello : '')).trim();
}
function bucketKm(km) {
  if (km == null) return 'Km non indicati';
  if (km < 50000) return '< 50.000 km';
  if (km < 100000) return '50.000 – 100.000 km';
  if (km < 150000) return '100.000 – 150.000 km';
  if (km < 200000) return '150.000 – 200.000 km';
  return '> 200.000 km';
}
function bucketAnno(anno) {
  if (anno == null) return 'Anno non indicato';
  if (anno >= 2020) return 'Dal 2020';
  if (anno >= 2015) return '2015 – 2019';
  if (anno >= 2010) return '2010 – 2014';
  if (anno >= 2000) return '2000 – 2009';
  return 'Prima del 2000';
}
function groupKeyFn(dim) {
  switch (dim) {
    case 'fonte':      return r => FONTE_LABEL[r.fonte] || r.fonte;
    case 'carburante': return r => r.carburante || 'Carburante non indicato';
    case 'km':         return r => bucketKm(r.km);
    case 'anno':       return r => bucketAnno(r.anno);
    case 'provincia':  return r => r.provincia || 'Zona non indicata';
    case 'modello':    return r => r._cluster || clusterModello(r.titolo);
    default:           return null;
  }
}
function groupResults(results, dim) {
  const keyFn = groupKeyFn(dim);
  if (!keyFn) return null;
  const map = new Map();
  for (const r of results) { const k = keyFn(r); if (!map.has(k)) map.set(k, []); map.get(k).push(r); }
  const groups = [...map.entries()].map(([key, items]) => {
    const prezzi = items.map(i => i.prezzo).filter(p => p != null && p > 0);
    return { key, items, minPrezzo: prezzi.length ? Math.min(...prezzi) : null };
  });
  groups.sort((a, b) => (a.minPrezzo ?? Infinity) - (b.minPrezzo ?? Infinity));
  return groups;
}

const FACET_DIMS = [
  ['', 'Nessuno'], ['modello', 'Modello'], ['fonte', 'Fonte'],
  ['carburante', 'Carburante'], ['anno', 'Anno'], ['km', 'Km'], ['provincia', 'Provincia'],
];
function renderFacetChips() {
  if (!facetChipsEl) return;
  facetChipsEl.innerHTML = FACET_DIMS.map(([dim, label]) =>
    `<button type="button" class="facet-chip${dim === groupDim ? ' active' : ''}" data-dim="${dim}">${label}</button>`).join('');
}

// ─── Modo Valuta (#6) ──────────────────────────────────────────────────────
let searchMode = 'cerca';
// Nav primaria: 'auto'|'moto' → ricerca veicolo (modo Cerca), 'ricambi' → pipeline parti.
// Pilota il radio tipo nascosto (che via il suo change-handler rinfresca marche/placeholder)
// e lo stato attivo dei bottoni. 'Valuta' non è più esposta (setSearchMode la gestisce ancora).
function selectPrimary(mode) {
  const primary = ['auto', 'moto', 'ricambi'].includes(mode) ? mode : 'auto';
  document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === primary));
  if (primary === 'ricambi') { setSearchMode('ricambi'); return; }
  const radio = document.getElementById(primary === 'moto' ? 'tipoMoto' : 'tipoAuto');
  if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  setSearchMode('cerca');
}
function setSearchMode(mode) {
  const prev = searchMode;
  searchMode = ['valuta', 'ricambi'].includes(mode) ? mode : 'cerca';
  const valuta = searchMode === 'valuta';
  const ricambi = searchMode === 'ricambi';
  // Ricambi ha i suoi campi (OEM) e nasconde i campi auto (marca/modello + tipo); Valuta li tiene.
  document.getElementById('ricambiFields').classList.toggle('d-none', !ricambi);
  document.querySelector('.search-fields').classList.toggle('d-none', ricambi);
  document.querySelector('.seg-toggle').classList.toggle('d-none', ricambi);
  // #marca è required: se resta hidden+required il submit nativo si blocca ("not focusable") → togli required in ricambi.
  document.getElementById('marca').required = !ricambi;
  document.getElementById('valutaFields').classList.toggle('d-none', !valuta);
  document.getElementById('advancedToggle').classList.toggle('d-none', valuta || ricambi);   // i filtri-ricerca non servono per valutare/ricambi
  if (valuta || ricambi) document.getElementById('advancedFilters').classList.add('d-none');
  btnCerca.textContent = valuta ? 'Valuta' : 'Cerca';
  document.getElementById('modello').placeholder = valuta
    ? 'Modello — es. V-Strom 1050 (obbligatorio)'
    : currentTipo() === 'moto' ? 'Modello — es. MT-07 (opzionale)' : 'Modello — es. 318d (opzionale)';
  // Pannelli output: mostra solo quello del modo attivo (lo popola il rispettivo do*()).
  if (!ricambi) document.getElementById('ricambiPanel').classList.add('d-none');
  if (!valuta) document.getElementById('valutaPanel').classList.add('d-none');
  if (ricambi || valuta) document.getElementById('versioneRow').classList.add('d-none');   // niente riga Versione Moto.it fuori da Moto
  if (valuta || ricambi || prev === 'ricambi') { rcData = null; currentResults = []; hideResults(); }   // modi-scheda / uscita da ricambi → pulizia piena
}

async function doValuta() {
  const brand = matchedBrand();
  if (!brand) { showError('Scegli una marca dalla lista.'); return; }
  const modello = document.getElementById('modello').value.trim();
  if (!modello) { showError('Per valutare serve il modello (es. V-Strom 1050).'); return; }
  const tipo = currentTipo();
  const anno = document.getElementById('vAnno').value, km = document.getElementById('vKm').value, prezzo = document.getElementById('vPrezzo').value;
  const prezzoMin = document.getElementById('vPrezzoMin').value, prezzoMax = document.getElementById('vPrezzoMax').value;
  const q = new URLSearchParams({ tipo, marca: brand.nome, modello });
  if (anno) q.set('anno', anno);
  if (km) q.set('km', km);
  if (prezzo) q.set('prezzo', prezzo);
  if (prezzoMin) q.set('prezzoMin', prezzoMin);   // filtro nativo → comparabili dal floor (esclude relitti/ricambi)
  if (prezzoMax) q.set('prezzoMax', prezzoMax);
  if (regioneSelect.value) q.set('regione', regioneSelect.value);

  hideResults();
  document.body.classList.add('has-results'); document.body.dataset.tipo = tipo;
  const panel = document.getElementById('valutaPanel');
  panel.classList.remove('d-none');
  panel.innerHTML = '<div class="vp-card vp-loading">Valuto sul mercato…</div>';
  try {
    const d = await fetch('/api/valuta?' + q.toString()).then(r => r.json());
    if (d.error) { panel.innerHTML = `<div class="vp-card"><div class="vp-empty">${escapeHtml(d.error)}</div></div>`; return; }
    renderValutaCard(panel, d, { marca: brand.nome, modello, anno, km, prezzo });
  } catch (_) { panel.innerHTML = '<div class="vp-card"><div class="vp-empty">Valutazione non disponibile.</div></div>'; }
}

function renderValutaCard(panel, d, inp) {
  const eur = n => n == null ? 'n/d' : '€ ' + Number(n).toLocaleString('it-IT');
  const titolo = `${escapeHtml(inp.marca)} ${escapeHtml(inp.modello)}${inp.anno ? ' · ' + inp.anno : ''}${inp.km ? ' · ' + Number(inp.km).toLocaleString('it-IT') + ' km' : ''}`;
  if (!d.ok || !d.fascia) {
    panel.innerHTML = `<div class="vp-card"><div class="vp-tit">${titolo}</div><div class="vp-empty">Dati insufficienti${d.n != null ? ` (${d.n} annunci simili)` : ''} — niente fascia inventata. Prova con un modello più diffuso o meno dettagli.</div></div>`;
    return;
  }
  const f = d.fascia;
  const myPrice = inp.prezzo ? Number(inp.prezzo) : null;
  let verdict = '';
  if (myPrice != null) {
    const cls = myPrice > f.p75 ? 'caro' : myPrice < f.p25 ? 'basso' : 'linea';
    const txt = cls === 'caro' ? 'sopra mercato' : cls === 'basso' ? 'sotto mercato' : 'in linea';
    const pos = d.posizione ? ` · ${d.posizione.percentile}° percentile` : '';
    verdict = `<div class="vp-mine">Il tuo prezzo <b>${eur(myPrice)}</b> <span class="vp-verdict vp-v-${cls}">${txt}</span>${pos}</div>`;
  }
  const split = d.split ? `conc ${d.split.conc.n ? eur(d.split.conc.mediana) : '—'} · privati ${d.split.priv.n ? eur(d.split.priv.mediana) : '—'}` : '';
  const fonti = d.fonti ? Object.entries(d.fonti).filter(([, s]) => s.count).map(([k, s]) => `${k} ${s.count}`).join(' · ') : '';
  const comp = (d.comparabili && d.comparabili.length)
    ? `<details class="vp-comp"><summary>${d.comparabili.length} annunci comparabili (verifica)</summary>${d.comparabili.slice(0, 15).map(c => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer">${eur(c.prezzo)} · ${c.anno || '—'} · ${c.km != null ? Number(c.km).toLocaleString('it-IT') + ' km' : '—'} · ${escapeHtml(c.fonte)}</a>`).join('')}</details>`
    : '';
  panel.innerHTML = `<div class="vp-card">
    <div class="vp-tit">${titolo}</div>
    <div class="vp-band"><span class="vp-med">${eur(f.mediana)}</span><span class="vp-lab">valore di mercato</span></div>
    <div class="vp-range">fascia ${eur(f.p25)} – ${eur(f.p75)}</div>
    ${verdict}
    <div class="vp-meta">su <b>${d.n}</b> annunci simili (${escapeHtml(d.tightness)})${d.troncato ? ' · <span class="vp-trunc">fascia bassa*</span>' : ''} · ${escapeHtml(d.regione || 'Italia')}${split ? ' · ' + split : ''}${fonti ? ' · ' + fonti : ''}</div>
    ${comp}
    <div class="vp-note">Dati reali dagli annunci ora a mercato.${d.troncato ? ' *mercato ampio: la fascia pesa verso i più economici.' : ''} Nessun valore inventato.</div>
  </div>`;
}

// ═══ Modo Ricambi — pipeline parti SEPARATA (multi-fonte, full-width) ═══════════
// Isolata dal path auto: stato/funzioni proprie (prefisso rc/Ricambi), non tocca
// currentResults/COLS/MATRIX_ROWS/exportCsv/renderResults.
const RC_FONTE = { autodoc: 'Autodoc', cmsnl: 'CMSNL', subito: 'Subito', ebay: 'eBay', web: 'Web' };
const RC_GROUP_DIMS = [['', 'Nessuno'], ['fonte', 'Fonte'], ['marca', 'Marca'], ['venditore', 'Venditore']];
const RC_SALVATI_KEY = 'amr_salvati_ricambi', RC_SALVATI_CAP = 200, RC_COMPARE_CAP = 6;
const RC_FAV_KEY = 'amr_oem_preferiti', RC_FAV_CAP = 30;   // codici OE/OEM/OEN preferiti (quick-launch)

let rcData = null;            // ultimo envelope {articoli, sources, tipoPezzo, veicoli, oen, mode, veicolo, oeAlternativi}
let ricambiMode = 'oem';
let rcVeicolo = 'auto';       // 'auto' | 'moto' — un ricambio è per auto O per moto
let rcGroupDim = '';
let rcView = 'grid';         // 'grid' (i salvati vivono nell'offcanvas, come auto)
let rcCompareOpen = false;   // confronto = sezione separata (come auto), la lista resta navigabile
let rcSortState = { key: 'prezzo', dir: 'asc' };   // ordinamento via header colonne (mirror auto)
let rcVisibleCols = [];      // colonne opzionali mostrate (marca/venditore/valutazione)
let rcVariantSel = { tipo: null, articleId: null };   // selezione nel selettore varianti catalogo (v7)
let rcVariantSpecs = {};     // cache specs lazy Autodoc per articleId ({loading}|{datiTecnici,compatibilita})
let rcCollapsed = new Set();  // chiavi-gruppo collassate (persistono al re-render, meglio di auto)
let rcSchedaCollapsed = false;  // scheda tecnica minimizzata (persiste al re-render)
let rcOpenDetails = new Set();// chiavi articolo con accordion info aperto (persistono al re-render)
let confrontoRicambi = [];
let salvatiRicambi = rcLoadSalvati();
let oemFav = rcLoadFav();   // codici OE/OEM/OEN preferiti
let rcGen = 0;               // generation token ricerche ricambi (mirror searchGen auto: la risposta vecchia non sovrascrive la nuova)

function rcLoadSalvati() { try { const a = JSON.parse(localStorage.getItem(RC_SALVATI_KEY)); return Array.isArray(a) ? a : []; } catch { return []; } }
function rcPersistSalvati() { try { localStorage.setItem(RC_SALVATI_KEY, JSON.stringify(salvatiRicambi.slice(0, RC_SALVATI_CAP))); } catch {} }

// ── Codici ricambio salvati (tab "Ricambi" dell'offcanvas Salvati, mirror di annunci/ricerche).
// Item = {q, mode}. Retro-compat: le vecchie voci stringa diventano {q, mode:'oem'}.
function rcLoadFav() {
  try {
    const a = JSON.parse(localStorage.getItem(RC_FAV_KEY));
    if (!Array.isArray(a)) return [];
    return a.map(x => (typeof x === 'string' ? { q: x, mode: 'oem' } : x)).filter(x => x && typeof x.q === 'string');
  } catch { return []; }
}
function rcPersistFav() { try { localStorage.setItem(RC_FAV_KEY, JSON.stringify(oemFav.slice(0, RC_FAV_CAP))); } catch {} }
const rcFavNorm = s => String(s || '').replace(/[^a-z0-9]/gi, '').toUpperCase();   // chiave di dedup
const rcFavHas = (q) => oemFav.some(f => rcFavNorm(f.q) === rcFavNorm(q));
function rcToggleFav(q, mode, veicolo) {
  const disp = String(q || '').trim();
  const key = rcFavNorm(disp);
  if (!key) return;
  if (rcFavHas(disp)) oemFav = oemFav.filter(f => rcFavNorm(f.q) !== key);
  else {
    oemFav.unshift({ q: mode === 'oem' ? disp.toUpperCase() : disp, mode: mode || 'oem', veicolo: veicolo === 'moto' ? 'moto' : 'auto' });
    if (oemFav.length > RC_FAV_CAP) oemFav.length = RC_FAV_CAP;
  }
  rcPersistFav(); renderRicambiFavTab();
  if (rcData) renderRicambiPanel();   // rinfresca lo stato del bottone "Salva codice"
}
const RC_MODE_LABEL = { oem: 'OEM', prodotto: 'Prodotto', nome: 'Nome' };
// Tab "Ricambi" dell'offcanvas: DUE sezioni come auto — Articoli salvati (♡) + Ricerche salvate (codice/OEM/nome).
function renderRicambiFavTab() {
  const t = document.getElementById('tabRicambiCount'); if (t) t.textContent = salvatiRicambi.length + oemFav.length;
  const box = document.getElementById('ricambiFavList'); if (!box) return;
  const artItems = salvatiRicambi.length ? salvatiRicambi.map(a => {
    const u = rcSafeUrl(a.url);
    const titolo = u ? `<a class="salvato-titolo" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.nome)}</a>` : `<div class="salvato-titolo">${escapeHtml(a.nome)}</div>`;
    return `<div class="salvato-item" data-rk="${escapeHtml(rcKey(a))}"><div class="salvato-info">${titolo}<div class="salvato-dettagli">${rcPriceText(a)} · ${escapeHtml(RC_FONTE[a.fonte] || a.fonte)}${a.marca ? ' · ' + escapeHtml(a.marca) : ''}</div></div><div class="salvato-actions"><button class="btn-rimuovi-art" data-rk="${escapeHtml(rcKey(a))}" title="Rimuovi">${icon('x')}</button></div></div>`;
  }).join('') : '<p class="text-muted small px-1 mb-2">Nessun articolo salvato. Usa il segnalibro sulle righe.</p>';
  const favItems = oemFav.length ? oemFav.map(f => `<div class="salvato-item" data-q="${escapeHtml(f.q)}" data-mode="${escapeHtml(f.mode || 'oem')}" data-veicolo="${escapeHtml(f.veicolo || 'auto')}"><div class="salvato-info"><div class="salvato-titolo">${escapeHtml(f.q)}</div><div class="salvato-dettagli">${RC_MODE_LABEL[f.mode] || 'OEM'} · ${f.veicolo === 'moto' ? 'Moto' : 'Auto'} · clicca per cercare</div></div><div class="salvato-actions"><button class="btn-rimuovi-salvato" title="Rimuovi">${icon('x')}</button></div></div>`).join('') : '<p class="text-muted small px-1 mb-0">Nessuna ricerca salvata. Usa "Salva ricerca" in toolbar.</p>';
  box.innerHTML = `<div class="rc-fav-sec"><div class="rc-fav-hd">Articoli salvati</div>${artItems}</div><div class="rc-fav-sec"><div class="rc-fav-hd">Ricerche salvate</div>${favItems}</div>`;
}
const rcKey = a => a._rk || `${a.fonte}:${a.url || a.articleId || a.nome}`;   // _rk assegnato in doRicambi (evita collisioni nome)
const rcHas = (arr, a) => arr.some(x => rcKey(x) === rcKey(a));
const rcEur = n => (typeof n === 'number' ? '€ ' + n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null);
const rcSafeUrl = u => (/^https?:\/\//i.test(u || '') ? u : null);   // solo http/https: blocca javascript:/data: (XSS)
function rcCurrentList() { return rcVisibleArts(); }
function rcPriceText(a) { const p = rcEur(a.prezzo); return p || (a.fonte === 'subito' ? 'trattabile' : 'prezzo sul sito'); }
function rcArt(key) { return (rcData && rcData.articoli || []).find(a => rcKey(a) === key) || salvatiRicambi.find(a => rcKey(a) === key) || confrontoRicambi.find(a => rcKey(a) === key); }

// Lista visibile in griglia = articoli ordinati. Se c'è un tipo scelto nel selettore varianti,
// gli annunci coerenti col tipo (titolo contiene i token) vanno PRIMA (soft, nessuno nascosto).
function rcVisibleArts() {
  const arts = rcSortArts((rcData && rcData.articoli) || []);
  const tokens = String(rcVariantSel.tipo || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
  if (!tokens.length) { arts.forEach(a => { a._tipoMatch = false; }); return arts; }
  arts.forEach(a => { const n = String(a.nome || '').toLowerCase(); a._tipoMatch = tokens.some(w => n.includes(w)); });
  return [...arts.filter(a => a._tipoMatch), ...arts.filter(a => !a._tipoMatch)];
}
// Colonne della lista ricambi (mirror COLS auto): base sempre, opzionali via dropdown "Colonne".
const RC_COLS = [
  { key: 'foto',        w: '52px',          base: true },
  { key: 'nome',        w: 'minmax(0,1fr)', base: true },
  { key: 'marca',       w: '120px', sort: 'marca',  label: 'Marca' },
  { key: 'venditore',   w: '150px',                 label: 'Venditore' },
  { key: 'valutazione', w: '78px',  sort: 'stelle', label: 'Voto' },
  { key: 'prezzo',      w: '112px', sort: 'prezzo', label: 'Prezzo', base: true },
  { key: 'fonte',       w: '96px',          base: true },
  { key: 'azioni',      w: '108px',         base: true },
];
const RC_OPTIONAL_COLS = ['marca', 'venditore', 'valutazione'];
function rcActiveCols() { return RC_COLS.filter(c => c.base || rcVisibleCols.includes(c.key)); }
function rcGridTemplate() { return rcActiveCols().map(c => c.w).join(' '); }
function rcGridHeadHTML() {   // header colonne ordinabili (mirror gridHeadHTML auto)
  const caret = key => rcSortState.key === key ? `<span class="sort-caret">${rcSortState.dir === 'asc' ? '↑' : '↓'}</span>` : '';
  const cells = rcActiveCols().map(c => {
    if (c.key === 'foto') return '<span class="gh">Foto</span>';
    if (c.key === 'nome') return '<span class="gh">Ricambio</span>';
    if (c.key === 'fonte') return '<span class="gh">Fonte</span>';
    if (c.key === 'azioni') return '<span class="gh" style="text-align:right">Azioni</span>';
    if (c.sort) return `<span class="gh"><button type="button" class="gh-sort${rcSortState.key === c.sort ? ' active' : ''}" data-rckey="${c.sort}">${c.label} ${caret(c.sort)}</button></span>`;
    return `<span class="gh">${c.label}</span>`;
  }).join('');
  return `<div class="grid-head rc-grid-head" style="grid-template-columns:${rcGridTemplate()}">${cells}</div>`;
}
function rcSortArts(arts) {
  const dir = rcSortState.dir === 'desc' ? -1 : 1;
  const cmpNum = (a, b, f) => { const va = f(a), vb = f(b); if (va == null && vb == null) return 0; if (va == null) return 1; if (vb == null) return -1; return dir * (va - vb); };
  const cmpStr = (a, b, f) => { const va = f(a), vb = f(b); if (!va && !vb) return 0; if (!va) return 1; if (!vb) return -1; return dir * va.localeCompare(vb); };
  const arr = arts.slice();
  if (rcSortState.key === 'stelle') arr.sort((a, b) => cmpNum(a, b, x => Number(x.stelle) || null));
  else if (rcSortState.key === 'marca') arr.sort((a, b) => cmpStr(a, b, x => x.marca || ''));
  else arr.sort((a, b) => cmpNum(a, b, x => (typeof x.prezzo === 'number' ? x.prezzo : null)));   // prezzo default
  return arr;
}
const rcMedian = nums => { if (!nums.length) return null; const s = [...nums].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function rcStats(arts) {
  const prices = arts.map(a => a.prezzo).filter(n => typeof n === 'number');
  if (!prices.length) return null;
  return { n: prices.length, min: Math.min(...prices), max: Math.max(...prices), mediana: rcMedian(prices) };
}
function rcBestKey(arts) {   // rcKey del più economico visibile (badge "più economico")
  let best = null;
  for (const a of arts) if (typeof a.prezzo === 'number' && (!best || a.prezzo < best.prezzo)) best = a;
  return best ? rcKey(best) : null;
}
// P4: click su min/max in toolbar → scroll + flash sull'annuncio di riferimento (apre il gruppo se collassato)
function rcJumpToStat(which) {
  const arts = rcVisibleArts().filter(a => typeof a.prezzo === 'number');
  if (!arts.length) return;
  const target = arts.reduce((m, a) => (which === 'max' ? (a.prezzo > m.prezzo ? a : m) : (a.prezzo < m.prezzo ? a : m)));
  const key = rcKey(target);
  const panel = document.getElementById('ricambiPanel');
  const sel = `.rc-item[data-rk="${CSS.escape(key)}"]`;
  let el = panel.querySelector(sel);
  const group = el && el.closest('.rc-group');
  if (group && group.classList.contains('collapsed')) { group.classList.remove('collapsed'); rcCollapsed.delete(group.dataset.gkey); el = panel.querySelector(sel); }
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('rc-flash'); setTimeout(() => el && el.classList.remove('rc-flash'), 1500);
}

async function doRicambi() {
  const q = rcActiveInput().value.trim();
  if (!q) { showError(ricambiMode === 'oem' ? 'Inserisci un codice OEM (es. 1K0905851B).' : ricambiMode === 'prodotto' ? 'Inserisci il codice articolo del produttore.' : 'Inserisci il nome del ricambio.'); return; }
  hideError(); hideResults();
  document.body.classList.add('has-results');
  const panel = document.getElementById('ricambiPanel');
  panel.classList.remove('d-none');
  panel.innerHTML = '<div class="rc-wrap">' + loadingBlockHTML('Cerco il ricambio su più fonti…') + '</div>';
  startLoadingTips(panel);
  const myGen = ++rcGen;   // due ricerche in volo → vince l'ultima lanciata, la vecchia si scarta
  try {
    const res = await fetch(`/api/ricambi?q=${encodeURIComponent(q)}&mode=${ricambiMode}&veicolo=${rcVeicolo}`);
    const d = await res.json();
    if (myGen !== rcGen) return;   // ricerca superata da una più recente
    if (!res.ok) { panel.innerHTML = `<div class="rc-wrap"><div class="rc-empty">${escapeHtml(d.error || 'Errore durante il lookup.')}</div></div>`; return; }
    // id stabile per articolo (gli item web possono non avere url/articleId → il nome collide) → indice per unicità
    (d.articoli || []).forEach((a, i) => { if (!a._rk) a._rk = `${a.fonte}:${a.url || a.articleId || (a.nome + '#' + i)}`; });
    rcData = d; rcView = 'grid';
    rcCollapsed = new Set(); rcOpenDetails = new Set(); rcSchedaCollapsed = false;   // nuova ricerca → reset gruppi/dettagli/scheda
    rcVariantSpecs = {};
    const cat = d.scheda && d.scheda.catalogo;   // v7: selettore varianti — dominante pre-aperto, default variante se tipo singolo
    rcVariantSel = cat ? { tipo: cat.tipoDominante, articleId: cat.defaultArticleId } : { tipo: null, articleId: null };
    renderRicambiPanel();
    if (cat && cat.defaultArticleId) rcFetchVariantSpecs(rcSelectedVariant());
  } catch (_) {
    if (myGen !== rcGen) return;
    panel.innerHTML = '<div class="rc-wrap"><div class="rc-empty">Servizio ricambi non raggiungibile.</div></div>';
  }
}

function rcGroupKey(a, dim) {
  if (dim === 'fonte') return RC_FONTE[a.fonte] || a.fonte;
  if (dim === 'marca') return a.marca || a.venditore || 'Non indicato';
  if (dim === 'venditore') return a.venditore || (a.fonte === 'autodoc' ? 'Autodoc' : 'Non indicato');
  return null;
}
function rcGroups(arts, dim) {
  const m = new Map();
  for (const a of arts) { const k = rcGroupKey(a, dim); if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
  return [...m.entries()].map(([key, items]) => ({ key, items })).sort((x, y) => y.items.length - x.items.length);
}

// Riga annuncio a tutta larghezza (mirror .result-row auto: thumb · titolo-link · meta · prezzo · azioni)
// + fratello .rc-detail (accordion, aperto dal bottone info). Icone IDENTICHE alla ricerca auto.
function rcRowHTML(a, bestKey) {
  const key = rcKey(a);
  const isBest = bestKey && key === bestKey;
  const rowUrl = rcSafeUrl(a.url);
  const inCmp = rcHas(confrontoRicambi, a), inSave = rcHas(salvatiRicambi, a);
  const openDet = rcOpenDetails.has(key);
  const cell = c => {
    switch (c.key) {
      case 'foto': return a.immagine ? `<span class="rc-img-wrap"><img class="rc-img" src="${escapeHtml(a.immagine)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : '<span class="rc-img-wrap rc-img-ph"></span>';
      case 'nome': {
        const nomeTxt = escapeHtml(a.nome);
        const nome = rowUrl ? `<a class="rc-nome-link" href="${escapeHtml(rowUrl)}" target="_blank" rel="noopener noreferrer" title="Apri annuncio">${nomeTxt}</a>` : nomeTxt;
        return `<div class="rc-nome">${isBest ? '<span class="rc-best-badge">min</span>' : ''}${a._tipoMatch ? '<span class="rc-tipo-match" title="Coerente col tipo scelto">tipo ✓</span>' : ''}${nome}</div>`;
      }
      case 'marca': return `<span class="rc-cell-txt">${a.marca ? escapeHtml(a.marca) : '—'}</span>`;
      case 'venditore': return `<span class="rc-cell-txt">${escapeHtml(a.venditore || (a.fonte === 'autodoc' ? 'Autodoc' : '—'))}</span>`;
      case 'valutazione': return `<span class="rc-cell-txt">${a.stelle ? '★ ' + escapeHtml(String(a.stelle)) : '—'}</span>`;
      case 'prezzo': { const pr = rPricing(a.prezzo); return pr ? `<span class="rc-prezzo">${rcEur(pr.finale)}${priceRowExtraHTML(pr, rcEur)}</span>` : `<span class="rc-prezzo rc-noprice">${rcPriceText(a)}</span>`; }
      case 'fonte': return `<span class="rc-cell-txt">${escapeHtml(RC_FONTE[a.fonte] || a.fonte)}</span>`;
      case 'azioni': return `<div class="rc-rowact">
        <button type="button" class="rc-act rc-btn-info" data-key="${escapeHtml(key)}" title="Dettagli e foto">${icon('info')}</button>
        <button type="button" class="rc-act rc-btn-cmp${inCmp ? ' on' : ''}" data-key="${escapeHtml(key)}" title="Aggiungi al confronto">${icon(inCmp ? 'square-check' : 'square')}</button>
        <button type="button" class="rc-act rc-btn-save${inSave ? ' on' : ''}" data-key="${escapeHtml(key)}" title="${inSave ? 'Rimuovi dai salvati' : 'Salva ricambio'}">${icon(inSave ? 'bookmark-filled' : 'bookmark')}</button></div>`;
      default: return '';
    }
  };
  const cells = rcActiveCols().map(cell).join('');
  const row = `<div class="rc-item${isBest ? ' rc-best' : ''}"${inCmp ? ' data-sel="1"' : ''} data-rk="${escapeHtml(key)}" style="grid-template-columns:${rcGridTemplate()}">${cells}</div>`;
  const detail = `<div class="rc-detail${openDet ? '' : ' d-none'}" data-key="${escapeHtml(key)}">${openDet ? rcDetailHTML(a) : ''}</div>`;
  return row + detail;
}

// Enrich LAZY di un annuncio eBay all'apertura dell'accordion: +1 nav item (venditore/spedizione/
// quantità/marca) solo on-demand. Muta `a` (riferimento in rcData.articoli) e re-renderizza se ancora aperto.
async function rcEnrichEbay(a, det) {
  if (!a || a.fonte !== 'ebay' || a._ebayDetails || !rcSafeUrl(a.url)) return;
  a._ebayDetails = 'loading';
  det.querySelector('.det-specs')?.insertAdjacentHTML('beforeend', '<div class="rc-det-loading" role="status">Carico dettagli annuncio…</div>');
  try {
    const r = await fetch(`/api/ricambi/ebay-item?url=${encodeURIComponent(a.url)}`);
    const d = r.ok ? await r.json() : {};
    for (const kk of ['venditore', 'spedizione', 'quantita', 'marca']) if (d[kk] != null && d[kk] !== '') a[kk] = d[kk];
  } catch { /* enrich best-effort */ }
  a._ebayDetails = true;
  if (!det.classList.contains('d-none')) det.innerHTML = rcDetailHTML(a);   // re-render solo se ancora aperto
}

// Contenuto dell'accordion info: tutti i campi extra della fonte (assenti → riga omessa).
function rcDetailHTML(a) {
  // stessa struttura/classi dell'accordion auto (.det-inner/.det-gallery/.det-specs/.det-spec/.det-foot/.det-open)
  const rows = [];
  const push = (k, v) => { if (v != null && v !== '') rows.push(`<div class="det-spec"><span class="det-k">${k}</span><span class="det-v">${escapeHtml(String(v))}</span></div>`); };
  push('Fonte', RC_FONTE[a.fonte] || a.fonte);
  push('Prezzo', rcPriceText(a));
  if (a.prezzoListino && a.sconto) push('Listino', `${rcEur(a.prezzoListino)} (-${a.sconto}%)`);
  push('Marca', a.marca);
  push('N° articolo', a.articolo);
  push('Codice CMSNL', a.codiceCmsnl);
  push('Variante', a.variante);
  push('Condizione', a.condizione);
  push('Spedizione', a.spedizione);
  push('Quantità', a.quantita);
  push('Disponibilità', a.disponibile == null ? null : (a.disponibile ? 'Disponibile' : 'Non disponibile'));
  push('Valutazione', a.stelle ? `★ ${a.stelle}/10 (${a.recensioni || 0} recensioni)` : null);
  push('Venditore', a.venditore);
  push('Provincia', a.provincia);
  const imgs = [...new Set([a.immagine, ...(Array.isArray(a.galleria) ? a.galleria : [])].filter(Boolean))];
  const gallery = imgs.length ? `<div class="det-gallery">${imgs.slice(0, 8).map(im => `<img src="${escapeHtml(im)}" loading="lazy" referrerpolicy="no-referrer" alt="">`).join('')}</div>` : '';
  const u = rcSafeUrl(a.url);
  const openBtn = u ? `<a class="det-open" href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">Apri annuncio ↗</a>` : '';
  const specs = rows.join('') || '<span class="spec-empty">Nessun dettaglio aggiuntivo</span>';
  return `<div class="det-inner">${gallery}<div class="det-specs">${specs}</div><div class="det-foot">${openBtn}</div></div>`;
}

// Brand a 2 parole (altrimenti la marca sarebbe il 1° token). Lowercase.
const RC_BRANDS_2W = ['moto guzzi', 'harley davidson', 'harley-davidson', 'alfa romeo', 'land rover', 'range rover',
  'mercedes benz', 'mercedes-benz', 'aston martin', 'royal enfield', 'can am', 'can-am'];
// Fit CMSNL "Marca modello anno" → {marca, modello, anno}. anno finale = singolo o range (2019, 2019-2023, 2019>).
function rcParseFit(raw) {
  const str = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!str) return { marca: '', modello: '', anno: '' };
  const m = str.match(/((?:19|20)\d{2}(?:\s*[-–/>]\s*(?:(?:19|20)\d{2}|oggi)?)?)\s*$/i);
  let anno = '', body = str;
  if (m && m.index > 0) { anno = m[1].trim(); body = str.slice(0, m.index).trim(); }
  const low = body.toLowerCase();
  const b2 = RC_BRANDS_2W.find(b => low === b || low.startsWith(b + ' '));
  let marca, modello;
  if (b2) { marca = body.slice(0, b2.length); modello = body.slice(b2.length).trim(); }
  else { const sp = body.indexOf(' '); marca = sp === -1 ? body : body.slice(0, sp); modello = sp === -1 ? '' : body.slice(sp + 1).trim(); }
  return { marca, modello, anno };
}
// Compatibilità → tabella Marca | Modello | Anno. Accetta array (reale) o stringa (retro-compat/web).
function rcFitsTable(compat) {
  const list = Array.isArray(compat) ? compat : String(compat || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return '';
  const cap = 20;
  const rows = list.slice(0, cap).map(f => {
    const p = rcParseFit(f);
    return `<tr><td>${escapeHtml(p.marca)}</td><td>${escapeHtml(p.modello)}</td><td>${escapeHtml(p.anno)}</td></tr>`;
  }).join('');
  const more = list.length > cap ? `<div class="rc-fits-more">+${list.length - cap} altri</div>` : '';
  // dropdown consultabile su interazione (chiuso di default) — pattern nativo <details>
  return `<div class="rc-sch-sec"><details class="rc-fits"><summary class="rc-fits-sum">Compatibilità · ${list.length} ${list.length === 1 ? 'modello' : 'modelli'}</summary>` +
    `<div class="rc-fits-wrap"><table class="rc-fits-tbl"><thead><tr><th>Marca</th><th>Modello</th><th>Anno</th></tr></thead><tbody>${rows}</tbody></table>${more}</div></details></div>`;
}

// Chiavi-codice della grid dati tecnici → valore copiabile al click.
const RC_COPY_KEYS = new Set(['Codice produttore', 'Codice articolo del produttore', 'Numero OEM', 'EAN', 'Numero di riferimento']);
// Chiavi commerciali (non dati tecnici) da NON mostrare nella grid scheda — restano negli annunci.
const RC_NONTECH_KEYS = new Set(['Condizione', 'Disponibilità', 'Spedizione', 'Valutazione']);
function rcCopy(text, el) {
  if (el.classList.contains('rc-copied')) return;   // già in animazione → non catturare "Copiato ✓" come testo da ripristinare
  const restore = el.textContent;
  const done = () => { el.classList.add('rc-copied'); el.textContent = 'Copiato ✓'; setTimeout(() => { el.textContent = restore; el.classList.remove('rc-copied'); }, 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => rcCopyFallback(text, done));
  else rcCopyFallback(text, done);
}
function rcCopyFallback(text, cb) {   // contesti senza Clipboard API (http non-secure)
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); cb(); } catch { /* no-op */ } finally { ta.remove(); }
}

// ── SCHEDA v7: selettore varianti (un codice = più tipi + più marche/materiali) ──
function rcCatalogo() { return rcData && rcData.scheda && rcData.scheda.catalogo; }
function rcSelectedVariant() {
  const cat = rcCatalogo(); if (!cat || !rcVariantSel.articleId) return null;
  for (const t of cat.tipi) for (const v of t.articoli) if (v.articleId === rcVariantSel.articleId) return v;
  return null;
}
function rcActiveTipoArticoli() {
  const cat = rcCatalogo(); if (!cat) return [];
  const t = cat.tipi.find(x => x.tipo === rcVariantSel.tipo) || cat.tipi[0];
  return t ? t.articoli : [];
}
// Immagini per il lightbox: foto della variante scelta + galleria eBay (se presente), dedup.
function rcSchedaImages() {
  const s = rcData && rcData.scheda; if (!s) return [];
  const v = rcSelectedVariant();
  const imgs = [(v && v.immagine), s.fotoReale, ...(Array.isArray(s.galleria) ? s.galleria : [])].filter(Boolean);
  return [...new Set(imgs)].map(u => ({ full: u }));
}
// grid dati tecnici (codici copiabili + dropdown produttore/articolo) — riusata dalla variante scelta.
function rcDtGridHTML(datiTecnici) {
  const dt = {};
  for (const [k, v] of Object.entries(datiTecnici || {})) if (!(k in dt) && !RC_NONTECH_KEYS.has(k)) dt[k] = v;
  if (!Object.keys(dt).length) return '';
  const dvHtml = (k, v) => RC_COPY_KEYS.has(k)
    ? `<button type="button" class="rc-det-v rc-copy" data-copy="${escapeHtml(String(v))}" title="Copia negli appunti">${escapeHtml(String(v)).slice(0, 70)}</button>`
    : `<span class="rc-det-v">${escapeHtml(String(v)).slice(0, 70)}</span>`;
  const prod = dt['Codice produttore'], art = dt['Codice articolo del produttore'];
  const bothCodes = prod && art;
  const dtRows = Object.entries(dt).slice(0, 10)
    .filter(([k]) => !(bothCodes && k === 'Codice articolo del produttore'))
    .map(([k, v]) => bothCodes && k === 'Codice produttore'
      ? `<div class="rc-det-row"><span class="rc-det-k">Codice produttore</span><details class="rc-code-more"><summary>${dvHtml('Codice produttore', prod)}<span class="rc-code-caret"></span></summary><div class="rc-code-extra"><span class="rc-det-k">Cod. articolo produttore</span>${dvHtml('Codice articolo del produttore', art)}</div></details></div>`
      : `<div class="rc-det-row"><span class="rc-det-k">${escapeHtml(k)}</span>${dvHtml(k, v)}</div>`).join('');
  return `<div class="rc-sch-sec"><div class="rc-sch-sechd">Dati tecnici</div><div class="rc-sch-grid">${dtRows}</div></div>`;
}
// riga variante selezionabile (marca · nota · voto · prezzo)
function rcVariantRowHTML(v) {
  const on = rcVariantSel.articleId === v.articleId;
  const nota = v.variante ? ` · ${escapeHtml(v.variante)}` : '';
  const voto = v.stelle ? ` · ★${escapeHtml(String(v.stelle))}${v.recensioni ? '/' + v.recensioni : ''}` : '';
  const disp = v.disponibile === false ? ' · non disp.' : '';
  return `<button type="button" class="rc-var-row${on ? ' active' : ''}" data-artid="${escapeHtml(v.articleId)}">` +
    `<span class="rc-var-marca">${escapeHtml(v.marca || 'Marca ?')}</span><span class="rc-var-nota">${nota}${voto}${disp}</span>` +
    `<span class="rc-var-prezzo">${v.prezzo != null ? rcEur(v.prezzo) : '—'}</span></button>`;
}
// riferimento nuovo della variante scelta: foto + prezzo + specs (cmsnl embedded / autodoc lazy) + OE
function rcVariantDetailHTML(v, s) {
  const foto = v.immagine || s.fotoReale;
  const img = foto ? `<img class="rc-sch-img" src="${escapeHtml(foto)}" alt="" referrerpolicy="no-referrer">` : '<div class="rc-sch-img rc-img-ph"></div>';
  const url = rcSafeUrl(v.url);
  const buybox = `<div class="rc-sch-buybox"><span class="rc-sch-price-lab">Prezzo nuovo${v.marca ? ' · ' + escapeHtml(v.marca) : ''}</span>` +
    `<div class="rc-sch-priceline"><span class="rc-prezzo">${v.prezzo != null ? rcEur(v.prezzo) : 'n/d'}</span>${v.prezzoListino && v.sconto ? `<span class="rc-listino">${rcEur(v.prezzoListino)}</span><span class="rc-sconto">-${escapeHtml(String(v.sconto))}%</span>` : ''}</div>` +
    `${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">su ${escapeHtml(RC_FONTE[v.fonte] || v.fonte)} ↗</a>` : ''}</div>`;
  const lazy = rcVariantSpecs[v.articleId];
  // loading SOLO se il fetch lazy può davvero partire (stessa guardia di rcFetchVariantSpecs):
  // variante senza url prodotto → nessun fetch → niente spinner eterno
  const loading = v.fonte === 'autodoc' && !!rcSafeUrl(v.url) && (!lazy || lazy.loading);
  const datiTecnici = { ...(s.datiTecniciEbay || {}), ...(v.datiTecnici || {}), ...((lazy && !lazy.loading && lazy.datiTecnici) || {}) };
  const compat = v.compatibilita || (lazy && !lazy.loading && lazy.compatibilita) || null;
  const dtBlock = rcDtGridHTML(datiTecnici);
  // specs/compatibilità = chiamata lazy alla product-page → indicatore chiaro finché arriva
  const loadingBlock = loading
    ? '<div class="rc-sch-sec"><div class="rc-det-loading"><span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Carico dati tecnici e compatibilità…</div></div>'
    : '';
  const compatBlock = loading ? '' : rcFitsTable(compat);
  const oe = (s.oeAlternativi && s.oeAlternativi.length)
    ? `<div class="rc-sch-sec"><div class="rc-sch-sechd">Codici OE equivalenti</div><div class="rc-oechips">${s.oeAlternativi.slice(0, 14).map(c => `<button type="button" class="rc-oe" data-oe="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}</div></div>`
    : '';
  return `<div class="rc-sch-main">${img}${buybox}</div><div class="rc-sch-secs">${dtBlock}${loadingBlock}${compatBlock}${oe}</div>`;
}
function rcSchedaHTML(d) {
  const s = d.scheda;
  if (!s || !s.catalogo) {   // nessun catalogo
    if (d.mode && d.mode !== 'oem') return '';   // ricerca non-OEM (nome/codice prodotto) → niente scheda, solo le offerte
    const idParts = [d.tipoPezzo, d.veicoli].filter(Boolean).map(escapeHtml);
    const idLine = `${idParts.join(' · ').slice(0, 160) || 'Ricambio'}${d.oen ? ` · <span class="rc-code">${escapeHtml(d.oen)}</span>` : ''}`;
    const catName = d.veicolo === 'auto' ? 'Autodoc' : 'CMSNL';
    const cat = d.veicolo === 'auto' ? d.sources?.autodoc : d.sources?.cmsnl;
    const msg = (cat && ['blocked', 'error', 'timeout'].includes(cat.status)) ? `Catalogo ${catName} non disponibile ora — riprova tra poco.` : `Ricambio non presente nel catalogo ${catName}.`;
    return `<div class="rc-scheda rc-scheda-empty"><div class="rc-sch-body"><div class="rc-sch-tit">${idLine}</div><div class="rc-sch-emptymsg">${msg}</div></div></div>`;
  }
  const cat = s.catalogo;
  const code = escapeHtml(s.codice || d.oen || '');
  // chip tipi (solo multi-tipo) — evita di spacciare un tipo per un altro (il bug del €8.29)
  const tipiChips = cat.multiTipo ? `<div class="rc-var-tipi"><span class="rc-var-lab">Questo codice ha ${cat.tipi.length} tipi:</span>${cat.tipi.map(t => `<button type="button" class="rc-tipo-chip${rcVariantSel.tipo === t.tipo ? ' active' : ''}" data-tipo="${escapeHtml(t.tipo)}">${escapeHtml(t.tipo)} <span class="rc-tipo-n">${t.articoli.length}</span></button>`).join('')}</div>` : '';
  const arts = rcActiveTipoArticoli();
  const sel = rcSelectedVariant();
  const selInTipo = sel && arts.some(v => v.articleId === sel.articleId) ? sel : null;
  // dropdown scrollabile (sempre, anche con 1 variante) — chiuso se c'è una scelta, aperto se no
  const summaryTxt = selInTipo
    ? `${escapeHtml(selInTipo.marca || 'Variante')}${selInTipo.variante ? ' · ' + escapeHtml(selInTipo.variante) : ''} · ${selInTipo.prezzo != null ? rcEur(selInTipo.prezzo) : '—'}`
    : `Scegli variante · ${arts.length}`;
  const varDropdown = arts.length
    ? `<details class="rc-var-dd"${selInTipo ? '' : ' open'}><summary class="rc-var-sum">${summaryTxt}</summary><div class="rc-var-menu">${arts.map(rcVariantRowHTML).join('')}</div></details>`
    : '';
  const body = sel ? rcVariantDetailHTML(sel, s) : '';   // nessuna scelta → il dropdown basta (niente prompt testuale)
  // Scheda avvolta in un gruppo collassabile (riuso pattern "Raggruppa": .rc-group + caret).
  const inner = `<div class="rc-scheda">${tipiChips}${varDropdown}${body}</div>`;
  return `<div class="rc-group${rcSchedaCollapsed ? ' collapsed' : ''}">`
    + `<button type="button" class="rc-group-head rc-sched-head"><span class="rc-gcaret">${icon('chevron')}</span><span class="rc-group-title">Scheda tecnica</span><span class="rc-group-meta">${escapeHtml(s.tipoPezzo || 'Ricambio')}${code ? ' · ' + code : ''}</span></button>`
    + `<div class="rc-group-body">${inner}</div></div>`;
}

// Specs LAZY della variante Autodoc selezionata (datiTecnici + compatibilità) — 1 nav on-demand, cache client.
async function rcFetchVariantSpecs(v) {
  if (!v || v.fonte !== 'autodoc' || rcVariantSpecs[v.articleId] || !rcSafeUrl(v.url)) return;
  rcVariantSpecs[v.articleId] = { loading: true };
  try {
    const r = await fetch(`/api/ricambi/autodoc-specs?url=${encodeURIComponent(v.url)}`);
    rcVariantSpecs[v.articleId] = r.ok ? await r.json() : {};
  } catch { rcVariantSpecs[v.articleId] = {}; }
  if (rcVariantSel.articleId === v.articleId) renderRicambiPanel();
}

function renderRicambiPanel() {
  stopLoadingTips(document.getElementById('ricambiPanel'));   // i risultati sostituiscono l'attesa → ferma la rotazione
  const panel = document.getElementById('ricambiPanel');
  const d = rcData || { articoli: [], sources: {} };
  panel.dataset.veicolo = d.veicolo || rcVeicolo;   // pilota il placeholder immagine 🚗/🏍
  // i <details> aperti (dropdown varianti / Colonne) sopravvivono all'innerHTML replace —
  // altrimenti il re-render asincrono delle specs li richiude sotto il cursore
  const ddOpen = !!panel.querySelector('.rc-var-dd[open]');
  const colsOpen = !!panel.querySelector('.tb-cols:not(.price-menu)[open]');
  const priceOpen = !!panel.querySelector('.price-menu[open]');
  const restoreOpen = () => {
    if (ddOpen) panel.querySelector('.rc-var-dd')?.setAttribute('open', '');
    if (colsOpen) panel.querySelector('.tb-cols:not(.price-menu)')?.setAttribute('open', '');
    if (priceOpen) panel.querySelector('.price-menu')?.setAttribute('open', '');
  };
  const rawArts = d.articoli || [];
  // SOLO fonti in errore (diagnostica) — le pill "ok" ridondano col group-by Fonte, via.
  const badSrc = Object.entries(d.sources || {}).filter(([, s]) => ['blocked', 'error', 'timeout'].includes(s.status));
  const statusLine = badSrc.length
    ? `<div class="rc-srcline">${badSrc.map(([k, s]) => `<span class="rc-src rc-src-bad"${s.reason ? ` title="${escapeHtml(s.reason)}"` : ''}>${escapeHtml(RC_FONTE[k] || k)}: ${s.status === 'blocked' ? 'bloccato' : escapeHtml(s.status)}</span>`).join('')}</div>`
    : '';
  const head = `<div class="rc-head">${rcSchedaHTML(d)}${statusLine}</div>`;
  // barra confronto (mirror auto: "Selezionati N · Apri confronto · Svuota") + sezione matrice separata
  const bar = confrontoRicambi.length ? rcCompareBarHTML() : '';
  const cmp = (rcCompareOpen && confrontoRicambi.length) ? rcCompareSection() : '';

  if (!rawArts.length) {
    const allEmpty = Object.values(d.sources || {}).length && Object.values(d.sources).every(s => s.status === 'empty');
    const msg = d.scheda ? 'Nessun annuncio sul mercato per questo ricambio (vedi prezzo nuovo nella scheda).'
      : allEmpty ? 'Nessun ricambio trovato. Verifica il codice/nome.' : 'Fonti non disponibili al momento. Riprova tra poco.';
    panel.innerHTML = `${head}${rcToolbarHTML()}${bar}${cmp}<div class="rc-wrap"><div class="rc-empty">${msg}</div></div>`;
    restoreOpen();
    return;
  }

  const arts = rcVisibleArts();          // ordinati
  const bestKey = rcBestKey(arts);

  let body;
  if (rcGroupDim) {
    body = rcGroups(arts, rcGroupDim).map(g => {
      const gkey = String(g.key);
      const collapsed = rcCollapsed.has(gkey);
      const prezzi = g.items.map(i => i.prezzo).filter(n => typeof n === 'number');
      const meta = `${g.items.length} ricambi${prezzi.length ? ' · da ' + rcEur(Math.min(...prezzi)) : ''}`;
      return `<div class="rc-group${collapsed ? ' collapsed' : ''}" data-gkey="${escapeHtml(gkey)}">
        <button type="button" class="rc-group-head"><span class="rc-gcaret">${icon('chevron')}</span><span class="rc-group-title">${escapeHtml(gkey)}</span><span class="rc-group-meta">${meta}</span></button>
        <div class="rc-group-body"><div class="rc-list">${g.items.map(a => rcRowHTML(a, bestKey)).join('')}</div></div>
      </div>`;
    }).join('');
  } else {
    body = `<div class="rc-list">${arts.map(a => rcRowHTML(a, bestKey)).join('')}</div>`;
  }
  // head + toolbar a larghezza-container (come auto); SOLO la lista in .rc-wrap (full-bleed)
  panel.innerHTML = `${head}${rcToolbarHTML()}${bar}${cmp}<div class="rc-wrap">${rcGridHeadHTML()}${body}</div>`;
  restoreOpen();
}

// Toolbar rispecchiata su quella auto/moto (.results-toolbar a sezioni .tb-group / .tb-sep).
function rcToolbarHTML() {
  const list = rcVisibleArts();
  const finals = list.map(a => { const pr = rPricing(a.prezzo); return pr ? pr.finale : null; }).filter(n => typeof n === 'number');
  const stats = finals.length ? { n: finals.length, min: Math.min(...finals), max: Math.max(...finals), mediana: rcMedian(finals) } : null;
  // sez.1 — conteggio + statistiche prezzo (min/max cliccabili → annuncio di riferimento)
  const statJump = (which, val) => `<button type="button" class="tb-stat rc-stat-jump" data-which="${which}" title="Vai all'annuncio ${which === 'min' ? 'più economico' : 'più caro'}"><span class="tb-stat-label">${which}</span><b>${rcEur(val)}</b></button>`;
  const statsHTML = `<span class="tb-count">${list.length} ricambi</span>` + (stats
    ? `${statJump('min', stats.min)}<span class="tb-stat"><span class="tb-stat-label">med</span><b>${rcEur(stats.mediana)}</b></span>${statJump('max', stats.max)}` : '');
  // sez.2 — raggruppa (facet-chips, "Fonte" è QUI)
  const facets = RC_GROUP_DIMS.map(([dim, lab]) => `<button type="button" class="facet-chip${rcGroupDim === dim ? ' active' : ''}" data-dim="${dim}">${escapeHtml(lab)}</button>`).join('');
  // sez.3 — colonne (dropdown come auto) + salva ricerca + export
  const colsMenu = RC_OPTIONAL_COLS.map(k => { const c = RC_COLS.find(x => x.key === k); return `<label><input type="checkbox" class="rc-col-toggle" value="${k}"${rcVisibleCols.includes(k) ? ' checked' : ''}> ${escapeHtml(c.label || k)}</label>`; }).join('');
  const colsDropdown = `<details class="tb-cols"><summary class="tb-btn">Colonne ▾</summary><div class="tb-cols-menu">${colsMenu}</div></details>`;
  const term = rcData && rcData.oen;
  const saved = term && rcFavHas(term);
  const saveBtn = term ? `<button type="button" class="tb-btn${saved ? ' active' : ''}" id="rcSaveCode" title="Salva la ricerca nei Salvati → Ricambi">${saved ? '✓ Ricerca salvata' : 'Salva ricerca'}</button>` : '';
  return `<div class="results-toolbar rc-tbar">
    <div class="tb-group">${statsHTML}</div>
    <span class="tb-sep"></span>
    <div class="tb-group"><span class="tb-label">Raggruppa</span><div class="facet-chips">${facets}</div></div>
    <span class="tb-sep"></span>
    <div class="tb-group">
      ${priceMenuHTML(priceCfgR, 'r')}
      ${colsDropdown}
      ${saveBtn}
      <button type="button" class="tb-btn" id="rcCsv">CSV</button>
      <button type="button" class="tb-btn" id="rcPdf">PDF</button>
    </div></div>`;
}

const RC_CMP_ROWS = [
  { label: 'Prezzo', fmt: a => { const pr = rPricing(a.prezzo); return pr ? rcEur(pr.finale) : rcPriceText(a); }, val: a => { const pr = rPricing(a.prezzo); return pr ? pr.finale : null; }, best: 'min' },
  { label: 'Marca', fmt: a => a.marca || '—' },
  { label: 'Venditore', fmt: a => a.venditore || (a.fonte === 'autodoc' ? 'Autodoc' : '—') },
  { label: 'Fonte', fmt: a => RC_FONTE[a.fonte] || a.fonte },
  { label: 'Valutazione', fmt: a => a.stelle ? `★ ${a.stelle}/10 (${a.recensioni || 0})` : '—', val: a => Number(a.stelle) || null, best: 'max' },
  { label: 'Disponibilità', fmt: a => a.disponibile == null ? '—' : (a.disponibile ? 'Disponibile' : 'No') },
];
// Barra confronto persistente (mirror #compareBar auto): "Selezionati N · Apri confronto · Svuota".
function rcCompareBarHTML() {
  return `<div class="compare-bar rc-compare-bar"><span>Selezionati: <b>${confrontoRicambi.length}</b></span><span class="cbar-spacer"></span>` +
    `<button type="button" class="primary${rcCompareOpen ? ' active' : ''}" id="rcOpenCompare">${rcCompareOpen ? 'Chiudi confronto' : 'Apri confronto'}</button>` +
    `<button type="button" id="rcCompareClear">Svuota</button></div>`;
}
// Sezione confronto separata (mirror #cmatrixPanel auto): non sostituisce la lista, ci sta accanto.
function rcCompareSection() {   // riuso le classi .cmatrix-* della ricerca auto (stesso look)
  return `<section class="cmatrix-panel"><div class="cmatrix-head"><span class="cmatrix-title">Confronto (${confrontoRicambi.length})</span>` +
    `<button type="button" class="cmatrix-close" id="rcCompareClose" aria-label="Chiudi">&times;</button></div>${rcCompareHTML()}</section>`;
}
function rcCompareHTML() {
  if (!confrontoRicambi.length) return '<div class="rc-empty">Nessun ricambio selezionato. Usa ⇄ sulle righe.</div>';
  const cols = confrontoRicambi;
  const head = `<tr><th></th>${cols.map(a => `<th><div class="rc-cmp-h">${a.immagine ? `<img src="${escapeHtml(a.immagine)}" referrerpolicy="no-referrer" alt="">` : ''}<span>${escapeHtml((a.marca ? a.marca + ' ' : '') + a.nome).slice(0, 60)}</span><button type="button" class="rc-cmp-remove" data-key="${escapeHtml(rcKey(a))}">✕</button></div></th>`).join('')}</tr>`;
  const rows = RC_CMP_ROWS.map(cfg => {   // celle migliori in verde (mirror .cm-best auto)
    const bestSet = cfg.best ? bestIndexes(cols.map(cfg.val), cfg.best) : new Set();
    const cells = cols.map((a, i) => `<td class="${bestSet.has(i) ? 'cm-best' : ''}">${escapeHtml(String(cfg.fmt(a)))}${bestSet.has(i) ? ' <span class="cm-star">★</span>' : ''}</td>`).join('');
    return `<tr><td class="rc-cmp-lab">${cfg.label}</td>${cells}</tr>`;
  }).join('');
  const links = `<tr><td class="rc-cmp-lab">Link</td>${cols.map(a => { const u = rcSafeUrl(a.url); return `<td>${u ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer">apri →</a>` : '—'}</td>`; }).join('')}</tr>`;
  return `<div class="rc-cmp-scroll"><table class="rc-cmp">${head}${rows}${links}</table></div>`;
}

function rcToggleCmp(key) {
  const a = rcArt(key); if (!a) return;
  const i = confrontoRicambi.findIndex(x => rcKey(x) === key);
  if (i >= 0) confrontoRicambi.splice(i, 1);
  else { if (confrontoRicambi.length >= RC_COMPARE_CAP) { showError(`Massimo ${RC_COMPARE_CAP} ricambi a confronto.`); return; } confrontoRicambi.push(a); }
  if (!confrontoRicambi.length) rcCompareOpen = false;
  renderRicambiPanel();
}
function rcToggleSave(key, remove) {
  const a = rcArt(key); if (!a) return;
  const i = salvatiRicambi.findIndex(x => rcKey(x) === key);
  if (i >= 0 || remove) { if (i >= 0) salvatiRicambi.splice(i, 1); }
  else { salvatiRicambi.unshift(a); if (salvatiRicambi.length > RC_SALVATI_CAP) salvatiRicambi.length = RC_SALVATI_CAP; }   // cap live = cap persistito
  rcPersistSalvati();
  renderRicambiFavTab();   // gli articoli salvati vivono nell'offcanvas (come gli annunci auto)
  renderRicambiPanel();
}

function exportCsvRicambi() {
  const arts = rcCurrentList(); if (!arts.length) { showError('Niente da esportare.'); return; }
  const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const cfg = priceCfgR;
  const cols = ['Fonte', 'Ricambio', 'Marca', 'Prezzo (€)', 'Venditore', ...priceExtraHeaders(cfg), 'URL'];
  const rows = arts.map(a => { const pr = rPricing(a.prezzo); return [RC_FONTE[a.fonte] || a.fonte, a.nome, a.marca || '', pr ? Number(pr.finale.toFixed(2)) : '', a.venditore || '', ...priceExtraValues(pr, cfg), a.url || ''].map(cell).join(','); });
  const csv = ['﻿' + cols.join(','), ...rows].join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `ricambi-${(rcData && rcData.oen || 'export')}-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

function exportPdfRicambi() {
  const arts = rcCurrentList(); if (!arts.length) { showError('Niente da esportare.'); return; }
  if (!window.jspdf || !window.jspdf.jsPDF) { showError('Export PDF non disponibile (libreria non caricata).'); return; }
  try {
  const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  doc.setFillColor(20, 24, 31); doc.rect(0, 0, pageW, 20, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(255, 255, 255); doc.text('AUTO MOTO RADAR — Ricambi', 14, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(170, 185, 210);
  const meta = rcData || {};
  doc.text(`${[meta.tipoPezzo, meta.veicoli].filter(Boolean).join(' · ').slice(0, 110)}  ·  ${meta.oen || ''}`, 14, 17);
  const rcCfg = priceCfgR, rcExtraH = priceExtraHeaders(rcCfg);
  doc.autoTable({
    startY: 26,
    head: [['Fonte', 'Ricambio', 'Marca', 'Prezzo', 'Venditore', ...rcExtraH]],
    body: arts.map(a => { const pr = rPricing(a.prezzo); return [RC_FONTE[a.fonte] || a.fonte, a.nome, a.marca || '—', pr ? rcEur(pr.finale) : rcPriceText(a), a.venditore || '—', ...priceExtraValues(pr, rcCfg).map(x => x === '' ? '—' : rcEur(x))]; }),
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 2, overflow: 'ellipsize' },
    headStyles: { fillColor: [20, 24, 31], textColor: [255, 255, 255], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [247, 248, 250] },
    columnStyles: Object.assign({ 0: { cellWidth: 22 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 30 }, 3: { cellWidth: 30, halign: 'right', fontStyle: 'bold' }, 4: { cellWidth: 40 } }, ...rcExtraH.map((_, i) => ({ [5 + i]: { cellWidth: 26, halign: 'right' } }))),
    margin: { left: 14, right: 14 },
  });
  doc.save(`ricambi-${meta.oen || 'export'}-${new Date().toISOString().slice(0, 10)}.pdf`);
  } catch (e) { console.error('[ricambi pdf]', e); showError('Export PDF non riuscito.'); }
}

// 3 input DEDICATI (uno per modo, valore persistente al cambio tab) + selettore veicolo.
const rcActiveInput = () => document.querySelector(`.rc-input[data-rcfor="${ricambiMode}"]`);
function setRicambiMode(m) {
  ricambiMode = ['nome', 'prodotto'].includes(m) ? m : 'oem';
  document.querySelectorAll('#ricambiModeToggle .rc-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.rcmode === ricambiMode));
  document.querySelectorAll('.rc-input').forEach(i => i.classList.toggle('d-none', i.dataset.rcfor !== ricambiMode));
}
function setRcVeicolo(v) {
  rcVeicolo = v === 'moto' ? 'moto' : 'auto';
  document.querySelectorAll('#rcVeicoloToggle .rc-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.rcveicolo === rcVeicolo));
}

// wiring (delegazione, una volta)
(function wireRicambi() {
  const toggle = document.getElementById('ricambiModeToggle');
  toggle?.addEventListener('click', e => { const b = e.target.closest('.rc-mode-btn'); if (b) setRicambiMode(b.dataset.rcmode); });
  // tab "Ricambi" nell'offcanvas Salvati: click item → rilancia la ricerca; ✕ → rimuove
  document.getElementById('ricambiFavList')?.addEventListener('click', e => {
    // rimozione articolo salvato
    const rmArt = e.target.closest('.btn-rimuovi-art');
    if (rmArt) { const k = rmArt.dataset.rk; salvatiRicambi = salvatiRicambi.filter(a => rcKey(a) !== k); rcPersistSalvati(); renderRicambiFavTab(); if (rcData) renderRicambiPanel(); return; }
    const item = e.target.closest('.salvato-item'); if (!item) return;
    if (e.target.closest('.btn-rimuovi-salvato')) { oemFav = oemFav.filter(f => rcFavNorm(f.q) !== rcFavNorm(item.dataset.q)); rcPersistFav(); renderRicambiFavTab(); return; }
    if (!item.dataset.q) return;   // articolo salvato: il click sul titolo apre già l'annuncio (link)
    // riapre ESATTAMENTE la sua ricerca: modo → il SUO input, veicolo, poi cerca
    selectPrimary('ricambi');
    setRicambiMode(item.dataset.mode || 'oem');
    setRcVeicolo(item.dataset.veicolo || 'auto');
    rcActiveInput().value = item.dataset.q;
    bootstrap.Offcanvas.getInstance(document.getElementById('offcanvasSaved'))?.hide();
    doRicambi();
  });
  document.getElementById('rcVeicoloToggle')?.addEventListener('click', e => { const b = e.target.closest('.rc-mode-btn'); if (b) setRcVeicolo(b.dataset.rcveicolo); });
  renderRicambiFavTab();
  const panel = document.getElementById('ricambiPanel');
  panel?.addEventListener('click', e => {
    const t = e.target;
    // foto → lightbox (riuso openLightbox). Scheda: galleria; riga annuncio: la sua thumb.
    if (t.closest('img.rc-sch-img')) { const imgs = rcSchedaImages(); if (imgs.length) openLightbox(imgs); return; }
    const imgWrap = t.closest('.rc-img-wrap:not(.rc-img-ph)');
    if (imgWrap) { const im = imgWrap.querySelector('img'); if (im && im.src) openLightbox([{ full: im.src }]); return; }
    const detGal = t.closest('.det-gallery'); if (detGal && t.tagName === 'IMG') { openLightbox([...detGal.querySelectorAll('img')].map(i => ({ full: i.src }))); return; }
    const cp = t.closest('.rc-copy'); if (cp) { e.preventDefault(); rcCopy(cp.dataset.copy, cp); return; }   // preventDefault: non togglare il <details> quando il copy-button è nel summary
    // selettore varianti v7: scegli tipo → scegli variante → specs lazy.
    // La selezione chiude il dropdown: tolgo open dal DOM vivo PRIMA del re-render, così
    // il capture in renderRicambiPanel non lo ripristina (persiste solo per i re-render passivi).
    const tc = t.closest('.rc-tipo-chip'); if (tc) {
      const tObj = (rcCatalogo()?.tipi || []).find(x => x.tipo === tc.dataset.tipo);
      const auto = tObj && tObj.articoli.length === 1 ? tObj.articoli[0].articleId : null;   // tipo mono-variante → auto-select (niente vicolo cieco)
      rcVariantSel = { tipo: tc.dataset.tipo, articleId: auto };
      panel.querySelector('.rc-var-dd')?.removeAttribute('open');
      renderRicambiPanel(); if (auto) rcFetchVariantSpecs(rcSelectedVariant()); return;
    }
    const vr = t.closest('.rc-var-row'); if (vr) {
      const id = vr.dataset.artid;
      rcVariantSel.articleId = rcVariantSel.articleId === id ? null : id;   // toggle-off al re-click
      panel.querySelector('.rc-var-dd')?.removeAttribute('open');
      renderRicambiPanel(); if (rcVariantSel.articleId) rcFetchVariantSpecs(rcSelectedVariant()); return;
    }
    const chip = t.closest('.facet-chip'); if (chip) { rcGroupDim = chip.dataset.dim; renderRicambiPanel(); return; }
    // ordinamento via header colonna (mirror .gh-sort auto)
    const gs = t.closest('.gh-sort'); if (gs) { const k = gs.dataset.rckey; if (rcSortState.key === k) rcSortState.dir = rcSortState.dir === 'asc' ? 'desc' : 'asc'; else rcSortState = { key: k, dir: k === 'stelle' ? 'desc' : 'asc' }; renderRicambiPanel(); return; }
    // prezzo min/max in toolbar → vai all'annuncio di riferimento
    const sj = t.closest('.rc-stat-jump'); if (sj) { rcJumpToStat(sj.dataset.which); return; }
    // collapse gruppo: toggle diretto (niente re-render → no scroll jump); rcCollapsed persiste
    const gh = t.closest('.rc-group-head'); if (gh) { const g = gh.closest('.rc-group');
      if (gh.classList.contains('rc-sched-head')) { g.classList.toggle('collapsed'); rcSchedaCollapsed = g.classList.contains('collapsed'); return; }
      const k = g.dataset.gkey; g.classList.toggle('collapsed'); rcCollapsed.has(k) ? rcCollapsed.delete(k) : rcCollapsed.add(k); return; }
    // accordion info: toggle diretto + lazy content; rcOpenDetails persiste al re-render
    const info = t.closest('.rc-btn-info'); if (info) {
      const k = info.dataset.key, det = info.closest('.rc-item').nextElementSibling;
      if (det && det.classList.contains('rc-detail')) {
        const opening = det.classList.contains('d-none');
        det.classList.toggle('d-none');
        if (opening) { const art = rcArt(k); if (art) { det.innerHTML = rcDetailHTML(art); rcEnrichEbay(art, det); } rcOpenDetails.add(k); } else rcOpenDetails.delete(k);
      }
      return;
    }
    if (t.closest('#rcOpenCompare')) { rcCompareOpen = !rcCompareOpen; renderRicambiPanel(); return; }
    if (t.closest('#rcCompareClose')) { rcCompareOpen = false; renderRicambiPanel(); return; }
    if (t.closest('#rcCompareClear')) { confrontoRicambi = []; rcCompareOpen = false; renderRicambiPanel(); return; }
    if (t.closest('#pmUnit_r')) { priceCfgR.commUnit = priceCfgR.commUnit === 'pct' ? 'eur' : 'pct'; priceCfgR = readPriceMenu('r', priceCfgR); savePriceCfg('amr_price_r', priceCfgR); renderRicambiPanel(); return; }
    if (t.closest('#pmReset_r')) { priceCfgR = Object.assign({}, PRICE_DEFAULT); savePriceCfg('amr_price_r', priceCfgR); renderRicambiPanel(); return; }
    if (t.closest('#rcCsv')) { exportCsvRicambi(); return; }
    if (t.closest('#rcPdf')) { exportPdfRicambi(); return; }
    if (t.closest('#rcSaveCode')) { if (rcData && rcData.oen) rcToggleFav(rcData.oen, rcData.mode, rcData.veicolo); return; }
    const oe = t.closest('.rc-oe'); if (oe) { setRicambiMode('oem'); rcActiveInput().value = oe.dataset.oe; doRicambi(); return; }
    const cmp = t.closest('.rc-btn-cmp'); if (cmp) { rcToggleCmp(cmp.dataset.key); return; }
    const sv = t.closest('.rc-btn-save'); if (sv) { rcToggleSave(sv.dataset.key, sv.dataset.rm === '1'); return; }
    const rm = t.closest('.rc-cmp-remove'); if (rm) { rcToggleCmp(rm.dataset.key); return; }
  });
  // dropdown "Colonne": toggle colonne opzionali live (mirror .col-toggle auto)
  panel?.addEventListener('change', e => {
    if (e.target.classList.contains('rc-col-toggle')) {
      rcVisibleCols = RC_OPTIONAL_COLS.filter(k => panel.querySelector(`.rc-col-toggle[value="${k}"]`)?.checked);
      renderRicambiPanel();
      return;
    }
    if (['pmComm_r', 'pmSpese_r', 'pmMarg_r', 'pmIva_r'].includes(e.target.id)) {
      priceCfgR = readPriceMenu('r', priceCfgR); savePriceCfg('amr_price_r', priceCfgR); renderRicambiPanel();
    }
  });
  // immagine rotta → placeholder 🚗/🏍 (mirror del listener auto su resultsGrid)
  panel?.addEventListener('error', e => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    const wrap = img.closest('.rc-img-wrap');
    if (wrap) { wrap.classList.add('rc-img-ph'); img.remove(); return; }
    if (img.classList.contains('rc-sch-img')) { const ph = document.createElement('div'); ph.className = 'rc-sch-img rc-img-ph'; img.replaceWith(ph); }
  }, true);
})();

// ─── Ricerca ──────────────────────────────────────────────────────────────────
let searchGen = 0;   // review: token di generazione — solo la ricerca PIÙ RECENTE applica i risultati
async function doSearch() {
  const tipo = currentTipo();
  const brand = matchedBrand();
  if (!brand) { showError('Scegli una marca dalla lista prima di cercare.'); return; }
  const marca = brand.nome;

  const modelloLibero = document.getElementById('modello').value.trim();
  const params = {
    tipo, marca, modello: modelloLibero,
    prezzoMin: document.getElementById('prezzoMin').value,
    prezzoMax: document.getElementById('prezzoMax').value,
    annoMin:   document.getElementById('annoMin').value,
    annoMax:   document.getElementById('annoMax').value,
    kmMin:     document.getElementById('kmMin').value,
    kmMax:     document.getElementById('kmMax').value,
    raggio:    document.getElementById('raggio').value,   // solo AS24, ignorato senza regione (server default 100)
  };
  if (regioneSelect.value) params.regione = regioneSelect.value;
  // F43 — modello strutturato: se l'utente ha SCELTO un modello (force-select) per
  // questa marca, manda gli ID esatti → niente fuzzy lato server. Versione solo moto.
  if (selectedModel && selectedModel._marca === marca && acn(selectedModel.nome) === acn(modelloLibero)) {
    if (selectedModel.mmmvAutoscout) params.mmmvAutoscout = selectedModel.mmmvAutoscout;
    const motoSlug = selectedModel._familySlug || selectedModel.slugMotoIt;   // famiglia risolta (Lazy-T2) o slug diretto
    if (motoSlug) params.motoitModelSlug = motoSlug;
    if (tipo === 'moto' && selectedVersion && acn(selectedVersion.nome) === acn(versioneSelect?.value || '')) {
      params.motoitBikeCode = selectedVersion.code;
      // anni della versione-annata → restringono AS24/Subito alla stessa annata (se l'utente non li ha messi)
      if (selectedVersion.annoMin && !params.annoMin) params.annoMin = String(selectedVersion.annoMin);
      if (selectedVersion.annoMax && !params.annoMax) params.annoMax = String(selectedVersion.annoMax);
    } else if (tipo === 'moto' && versioniCorrenti.length) {
      params.motoitNeedsVersion = '1';   // F47.2: versioni presenti ma nessuna scelta → salta SOLO Moto.it (Subito/AS24 girano)
    }
  }
  Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
  lastSearchParams = { ...params };
  visibleCols = colsFromFilters(params);   // colonne default = filtri usati (anno/km); resto via menu
  syncColMenu();

  confronto = []; renderCompareBar(); closeMatrix();
  document.body.classList.add('has-results');
  document.body.dataset.tipo = tipo;

  const myGen = ++searchGen;   // review: se ne parte un'altra mentre questa è in volo, la stantia si scarta
  showLoading(); hideResults();
  try {
    const res = await fetch(`/api/search?${new URLSearchParams(params)}`);
    const data = await res.json();
    if (myGen !== searchGen) return;   // una ricerca più recente ha già preso il posto → non sovrascrivere
    if (!res.ok) { showError(data.error || 'Errore durante la ricerca.'); return; }

    currentResults = data.risultati || [];
    searchActive = true;
    lastSources = data.sources || null;
    renderSourceStatus();

    if (data.subitoStatus === 'needs_bootstrap') showBootstrapBanner(); else hideBootstrapBanner();
    fetchSubitoStatus();

    initPrezzoSlider(currentResults);
    if (!prezzoSliderInstance) renderResults(currentResults);
    loadVehScheda();   // scheda tecnica veicolo (sopra la griglia, non tocca gli annunci)
    if (currentResults.length > 0) resultsToolbar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    if (myGen === searchGen) showError('Impossibile contattare il server. Assicurati che sia avviato con "npm start".');
  } finally { if (myGen === searchGen) hideLoading(); }
}

// ─── Subito bootstrap ─────────────────────────────────────────────────────────
function showBootstrapBanner() { statusBox.classList.remove('d-none'); subitoBanner.classList.remove('d-none'); subitoBanner.classList.add('d-flex'); }
function hideBootstrapBanner() { subitoBanner.classList.add('d-none'); subitoBanner.classList.remove('d-flex'); }
async function runSubitoBootstrap() {
  bootstrapBtnText.textContent = 'Apertura finestra…';
  bootstrapBtnSpinner.classList.remove('d-none');
  btnBootstrap.disabled = true;
  try {
    const res = await fetch('/api/subito/bootstrap', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      hideBootstrapBanner(); hideError(); fetchSubitoStatus();   // review: showError('') mostrava un alert rosso VUOTO
      const note = document.createElement('div');
      note.className = 'alert alert-success';
      const hours = data.expiresInHours ? ` (valida ~${data.expiresInHours} ore)` : '';
      note.textContent = `Sessione Subito aggiornata${hours}. Puoi rilanciare la ricerca.`;
      statusBox.appendChild(note);
      setTimeout(() => note.remove(), 6000);
    } else {
      const reasonMap = {
        window_closed: 'Hai chiuso la finestra Chrome prima del completamento.',
        timeout: 'Tempo scaduto (5 minuti): il CAPTCHA non è stato completato.',
        chrome_launch_failed: 'Impossibile aprire Chrome. Riprova o contatta lo sviluppatore.',
        error: 'Errore tecnico durante il bootstrap.',
      };
      const reasonText = reasonMap[data.reason] || `Errore: ${data.reason || 'sconosciuto'}`;
      const hint = data.hint ? ` ${data.hint}` : '';
      showError(`Bootstrap Subito fallito. ${reasonText}${hint}`);
    }
  } catch (err) {
    showError('Errore comunicazione con il server durante il bootstrap.');
  } finally {
    bootstrapBtnText.textContent = 'Aggiorna sessione';
    bootstrapBtnSpinner.classList.add('d-none');
    btnBootstrap.disabled = false;
  }
}
if (btnBootstrap) btnBootstrap.addEventListener('click', runSubitoBootstrap);

let subitoBlocked = false;
async function fetchSubitoStatus() {
  try {
    const res = await fetch('/api/subito/status');
    const data = await res.json();
    subitoBlocked = (data.health === 'blocked' || data.health === 'never_configured');
    if (subitoBlocked) showBootstrapBanner(); else hideBootstrapBanner();
    return data;
  } catch (_) { return null; }
}
const SUBITO_POLL_INTERVAL = 60 * 1000;
fetchSubitoStatus();
setInterval(fetchSubitoStatus, SUBITO_POLL_INTERVAL);

// ─── Slider prezzo ──────────────────────────────────────────────────────────
function initPrezzoSlider(results) {
  if (prezzoSliderInstance) { try { prezzoSliderInstance.destroy(); } catch (_) {} prezzoSliderInstance = null; }
  prezzoSliderEl.innerHTML = '';
  document.getElementById('sliderLabelMin').textContent = '';
  document.getElementById('sliderLabelMax').textContent = '';
  const prices = results.map(r => r.prezzo).filter(p => p != null && p > 0);
  if (prices.length < 2) return;
  const minP = Math.floor(Math.min(...prices) / 100) * 100;
  const maxP = Math.ceil(Math.max(...prices) / 100) * 100;
  if (minP === maxP) return;
  sliderGlobalBounds = [minP, maxP];
  prezzoSliderInstance = noUiSlider.create(prezzoSliderEl, {
    start: [minP, maxP], connect: true, range: { min: minP, max: maxP }, step: 100,
    format: { to: v => Math.round(v), from: v => Number(v) },
  });
  prezzoSliderInstance.on('update', ([sMin, sMax]) => {
    document.getElementById('sliderLabelMin').textContent = eurRound(vPricing(Number(sMin)).finale);
    document.getElementById('sliderLabelMax').textContent = eurRound(vPricing(Number(sMax)).finale);
    renderResults(currentResults);
  });
}

// ─── Ordinamento ──────────────────────────────────────────────────────────────
function setSort(key) {
  if (sortState.key === key) sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
  else sortState = { key, dir: key === 'prezzo' || key === 'km' ? 'asc' : 'desc' };
  if (sortMobile) sortMobile.value = `${sortState.key}_${sortState.dir}`;
  renderResults(currentResults);
}
function sortResults(results) {
  const { key, dir } = sortState;
  const mul = dir === 'asc' ? 1 : -1;
  const hi = dir === 'asc' ? Infinity : -Infinity;
  return results.sort((a, b) => mul * (((a[key] ?? hi) - (b[key] ?? hi))));
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function renderResults(results) {
  // Nessuna ricerca attiva (es. renderResults chiamato da toggleSalva dopo un reload):
  // niente toolbar/risultati. La toolbar appare solo dopo una ricerca vera.
  if (!searchActive) {
    resultsToolbar.classList.add('d-none'); compareBar.classList.add('d-none');
    resultsSection.classList.add('d-none'); noResults.classList.add('d-none');
    return;
  }
  let filtered = results.slice();
  if (prezzoSliderInstance) {
    const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
    filtered = filtered.filter(r => r.prezzo == null || (r.prezzo >= sMin && r.prezzo <= sMax));
  }
  const sorted = sortResults([...filtered]);
  renderFacetChips();

  resultsToolbar.classList.remove('d-none');
  if (!document.querySelector('#priceMenuV summary')) renderPriceMenuV();   // rete di sicurezza: menu "Prezzo €" popolato quando la toolbar appare
  updateStats(sorted);

  if (sorted.length === 0) {
    noResults.classList.remove('d-none'); resultsSection.classList.add('d-none');
    return;
  }
  noResults.classList.add('d-none'); resultsSection.classList.remove('d-none');
  resultsCount.textContent = `${sorted.length} risultati`;

  if (groupDim) {
    const groups = groupResults(sorted, groupDim);
    resultsGrid.innerHTML = groups.map(g => {
      const best = bestUrlSet(g.items);
      return `<div class="result-group">
        <button type="button" class="group-header" aria-expanded="true">
          <span class="group-caret">${icon('chevron')}</span>
          <span class="group-title">${escapeHtml(String(g.key))}</span>
          <span class="group-meta">${g.items.length} annunci${(() => { const gm = vPricing(g.minPrezzo); return gm ? ` · da ${eurRound(gm.finale)}` : ''; })()}</span>
        </button>
        <div class="group-body">${gridHeadHTML()}<div class="result-list">${g.items.map(r => rowHTML(r, best)).join('')}</div></div>
      </div>`;
    }).join('');
  } else {
    const best = bestUrlSet(sorted);
    resultsGrid.innerHTML = gridHeadHTML() + `<div class="result-list">${sorted.map(r => rowHTML(r, best)).join('')}</div>`;
  }
  observeEnrich();   // Moto.it: foto+spec reali quando la riga entra in viewport
}

// ─── Arricchimento Moto.it on-scroll (foto + spec reali dalla pagina-dettaglio) ─
// Le card Moto.it on-search non hanno foto; la pagina-dettaglio sì. Quando una
// riga moto entra nel viewport → fetch /api/detail (pool concorrenza 4), merge
// immagini+spec nel result, aggiorna la thumbnail IN PLACE (niente full re-render).
let enrichObserver = null;
let _enrichActive = 0; const _enrichQueue = [];
function _enrichPump() {
  while (_enrichActive < 4 && _enrichQueue.length) {
    const fn = _enrichQueue.shift(); _enrichActive++;
    fn().finally(() => { _enrichActive--; _enrichPump(); });
  }
}
function _enqueueEnrich(url) { _enrichQueue.push(() => enrichMotoRow(url)); _enrichPump(); }
function observeEnrich() {
  if (enrichObserver) enrichObserver.disconnect();
  const targets = resultsGrid.querySelectorAll('.row-thumb[data-enrich]');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    [...targets].slice(0, 12).forEach(el => { const u = el.closest('[data-url]')?.dataset.url; if (u) _enqueueEnrich(u); });
    return;
  }
  enrichObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      enrichObserver.unobserve(e.target);
      const u = e.target.closest('[data-url]')?.dataset.url;
      if (u) _enqueueEnrich(u);
    });
  }, { rootMargin: '300px' });
  targets.forEach(el => enrichObserver.observe(el));
}
async function enrichMotoRow(url) {
  const r = trovaResult(url);
  if (!r || r._enriched) return;   // già arricchita (cover-only NON conta: ha solo 1 foto)
  try {
    const j = await fetch(`/api/detail?url=${encodeURIComponent(url)}`).then(x => x.json());
    if (j.ok && j.detail) {
      Object.keys(j.detail).forEach(k => {
        const v = j.detail[k]; if (v == null) return;
        if (k === 'immagini') { if (Array.isArray(v) && v.length) r.immagini = v; }  // galleria piena rimpiazza la cover
        else if (r[k] == null) r[k] = v;
      });
      r._enriched = true;   // solo a merge riuscito: un fetch fallito resta ri-tentabile dall'apertura dettaglio
    }
  } catch (_) {}
  updateRowThumb(url);
}
function updateRowThumb(url) {
  const row = resultsGrid.querySelector(`.result-row[data-url="${CSS.escape(url)}"]`);
  if (!row) return;
  const thumb = row.querySelector('.row-thumb'); if (!thumb) return;
  const r = trovaResult(url); const imgs = (r && Array.isArray(r.immagini)) ? r.immagini : [];
  if (imgs.length) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'row-thumb'; btn.title = 'Vedi foto';
    btn.innerHTML = `<img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt="">`;
    thumb.replaceWith(btn);
  } else { thumb.classList.remove('enrich'); thumb.removeAttribute('data-enrich'); }
}

// Set di URL col prezzo più basso (1 per gruppo/lista) → evidenziazione "best".
function bestUrlSet(items) {
  let min = Infinity, url = null;
  for (const r of items) { if (r.prezzo != null && r.prezzo > 0 && r.prezzo < min) { min = r.prezzo; url = r.url; } }
  return new Set(url ? [url] : []);
}

// ─── Colonne griglia (dinamiche) ────────────────────────────────────────────
// Base = sempre presenti. anno/km/carb/cv = opzionali: default dai FILTRI usati
// in ricerca + menu "Colonne". Sotto 1180px carb/cv cadono (overflow); il template
// è inline (vince sulle media-query) → la responsività è in JS (effVisibleCols).
const COLS = [
  { key: 'foto',    w: '120px',         base: true },
  { key: 'veicolo', w: 'minmax(0,1fr)', base: true },
  { key: 'anno',    w: '64px',  num: true, sort: 'anno',      label: 'Anno' },
  { key: 'km',      w: '98px',  num: true, sort: 'km',        label: 'Km' },
  { key: 'carb',    w: '92px',             label: 'Carb.' },
  { key: 'cv',      w: '58px',  num: true, sort: 'potenzaCv', label: 'CV' },
  { key: 'prezzo',  w: '124px', num: true, sort: 'prezzo',    label: 'Prezzo', base: true },
  { key: 'fonte',   w: '96px',  base: true },
  { key: 'azioni',  w: '104px', base: true },
];
const OPTIONAL_COLS = ['anno', 'km', 'carb', 'cv'];
function effVisibleCols() {
  const wide = window.innerWidth >= 1180;   // sotto: niente carb/cv (mobile <860 → stacked CSS)
  return visibleCols.filter(k => wide || (k !== 'carb' && k !== 'cv'));
}
function activeCols() {
  const vis = effVisibleCols();
  return COLS.filter(c => c.base || vis.includes(c.key));
}
function gridTemplate() {
  return activeCols().map(c => c.w).join(' ');
}
function colsFromFilters(p) {
  const v = [];
  if (p && (p.annoMin || p.annoMax)) v.push('anno');
  if (p && (p.kmMin || p.kmMax)) v.push('km');
  return v;
}
function syncColMenu() {
  document.querySelectorAll('.col-toggle').forEach(cb => { cb.checked = visibleCols.includes(cb.value); });
}

function gridHeadHTML() {
  const caret = key => sortState.key === key ? `<span class="sort-caret">${sortState.dir === 'asc' ? '↑' : '↓'}</span>` : '';
  const cells = activeCols().map(c => {
    if (c.key === 'foto')    return '<span class="gh">Foto</span>';
    if (c.key === 'veicolo') return '<span class="gh">Veicolo</span>';
    if (c.key === 'fonte')   return '<span class="gh">Fonte</span>';
    if (c.key === 'azioni')  return `<span class="gh" style="text-align:right">Azioni</span>`;
    if (c.sort) return `<span class="gh gh-num"><button type="button" class="gh-sort${sortState.key === c.sort ? ' active' : ''}" data-key="${c.sort}">${c.label} ${caret(c.sort)}</button></span>`;
    return `<span class="gh">${c.label}</span>`;
  }).join('');
  return `<div class="grid-head" style="grid-template-columns:${gridTemplate()}">${cells}</div>`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rowHTML(item, bestSet) {
  const pr = vPricing(item.prezzo);
  const prezzoStr = pr ? eurRound(pr.finale) : 'n/d';
  const fonteLabel = FONTE_LABEL[item.fonte] || item.fonte;
  const fonteTag = { subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || '';
  const urlSafe = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
  const isSalvato = salvati.some(r => r.url === item.url);
  const inConfronto = confronto.some(r => r.url === item.url);
  const isBest = bestSet && bestSet.has(item.url);
  const imgs = Array.isArray(item.immagini) ? item.immagini : [];
  // Foto: chi le ha → thumbnail (click=lightbox). Moto.it ha la cover dalla card
  // (thumb subito) ma la galleria piena arriva dall'arricchimento /api/detail →
  // la riga resta marcata `data-enrich` finché non arricchita (l'observer la fetcha).
  // Subito/AS24 senza foto → placeholder semplice.
  const needEnrich = item.fonte === 'moto' && !item._enriched;
  const enrichAttr = needEnrich ? ' data-enrich="1"' : '';
  const thumbHTML = imgs.length
    ? `<button type="button" class="row-thumb"${enrichAttr} title="Vedi foto"><img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`
    : `<div class="row-thumb noimg${needEnrich ? ' enrich' : ''}"${enrichAttr} aria-hidden="true"></div>`;

  const conc = item.venditore && /conc/i.test(item.venditore);
  const vendBadge = item.venditore ? `<span class="vend-badge vend-${conc ? 'conc' : 'priv'}">${conc ? 'Conc.' : 'Privato'}</span>` : '';
  const sub = [item.provincia ? escapeHtml(item.provincia) : '', vendBadge].filter(Boolean).join(' ');
  const subM = [item.anno || null, item.km != null ? `${item.km.toLocaleString('it-IT')} km` : null, item.carburante || null, item.potenzaCv != null ? `${item.potenzaCv} CV` : null, fonteLabel].filter(Boolean).join(' · ');

  const cell = key => {
    switch (key) {
      case 'foto':    return thumbHTML;
      case 'veicolo': return `<div class="row-main">
          <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}</div>
          ${item.variante ? `<div class="row-variante">${escapeHtml(item.variante)}</div>` : ''}
          ${sub ? `<div class="row-sub">${sub}</div>` : ''}
          <div class="row-sub-m">${escapeHtml(subM)}</div>
        </div>`;
      case 'anno':   return `<div class="row-cell num muted">${item.anno || '—'}</div>`;
      case 'km':     return `<div class="row-cell num muted">${item.km != null ? item.km.toLocaleString('it-IT') : '—'}</div>`;
      case 'carb':   return `<div class="row-cell muted">${item.carburante ? escapeHtml(item.carburante) : '—'}</div>`;
      case 'cv':     return `<div class="row-cell num muted">${item.potenzaCv != null ? item.potenzaCv : '—'}</div>`;
      case 'prezzo': return `<div class="row-prezzo">${prezzoStr}${priceRowExtraHTML(pr)}</div>`;
      case 'fonte':  return `<div class="row-fonte"><span class="tag ${fonteTag}">${escapeHtml(fonteLabel)}</span></div>`;
      case 'azioni': return `<div class="row-actions">
          <button class="row-act btn-info" title="Dettagli e foto">${icon('info')}</button>
          <button class="row-act btn-confronta${inConfronto ? ' attivo' : ''}" title="Aggiungi al confronto">${icon(inConfronto ? 'square-check' : 'square')}</button>
          <button class="row-act btn-salva${isSalvato ? ' attivo' : ''}" title="${isSalvato ? 'Rimuovi dai salvati' : 'Salva annuncio'}">${icon(isSalvato ? 'bookmark-filled' : 'bookmark')}</button>
        </div>`;
      default: return '';
    }
  };
  const cells = activeCols().map(c => cell(c.key)).join('');
  // Pannello dettaglio inline (fisarmonica), sibling full-width nella .result-list.
  return `<div class="result-row${isBest ? ' best' : ''}${inConfronto ? ' selected' : ''}" data-url="${urlSafe}" style="grid-template-columns:${gridTemplate()}">${cells}</div>` +
    `<div class="row-detail d-none" data-url="${urlSafe}" data-detail="1"></div>`;
}

// ─── Dettaglio inline (ℹ → fisarmonica sotto la riga, niente salto in cima) ────
function toggleDetail(rowEl) {
  const panel = rowEl.nextElementSibling;
  if (!panel || !panel.classList.contains('row-detail')) return;
  const opening = panel.classList.contains('d-none');
  panel.classList.toggle('d-none');
  rowEl.classList.toggle('detail-open', opening);
  if (opening && panel.dataset.loaded !== '1') {
    const r = trovaResult(rowEl.dataset.url);
    if (r) renderDetailInto(panel, r);
  }
}
function detailSpecsHTML(r) {
  const base = [];
  if (r.prezzo != null) { const _pr = vPricing(r.prezzo); base.push(['Prezzo', _pr ? eurRound(_pr.finale) : `€ ${r.prezzo.toLocaleString('it-IT')}`]); }
  if (r.anno != null)   base.push(['Anno', r.anno]);
  if (r.km != null)     base.push(['Km', `${r.km.toLocaleString('it-IT')} km`]);
  if (r.provincia)      base.push(['Provincia', r.provincia]);
  const extra = Object.keys(SPEC_LABELS).map(k => { const v = specVal(k, r[k]); return v ? [SPEC_LABELS[k], v] : null; }).filter(Boolean);
  const all = base.concat(extra);
  if (!all.length) return '<span class="spec-empty">Nessun dettaglio aggiuntivo</span>';
  return all.map(([k, v]) => `<div class="det-spec"><span class="det-k">${escapeHtml(String(k))}</span><span class="det-v">${escapeHtml(String(v))}</span></div>`).join('');
}
function renderDetailInto(panel, r) {
  panel.dataset.loaded = '1';
  const renderBody = () => {
    const gallery = (Array.isArray(r.immagini) && r.immagini.length)
      ? `<div class="det-gallery">${r.immagini.slice(0, 8).map(im => `<img src="${escapeHtml(im.thumb)}" loading="lazy" referrerpolicy="no-referrer" alt="">`).join('')}</div>`
      : '';
    const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="det-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri annuncio ↗</a>` : '';
    // Hub azioni nel pannello (unico accesso su mobile dove la riga non ha bottoni).
    const isSal = salvati.some(x => x.url === r.url), inConf = confronto.some(x => x.url === r.url);
    const salBtn  = `<button type="button" class="det-act btn-salva${isSal ? ' attivo' : ''}">${icon(isSal ? 'bookmark-filled' : 'bookmark')}<span class="ra-txt">${isSal ? 'Salvato' : 'Salva'}</span></button>`;
    const confBtn = `<button type="button" class="det-act btn-confronta${inConf ? ' attivo' : ''}">${icon(inConf ? 'square-check' : 'square')}<span class="ra-txt">${inConf ? 'Nel confronto' : 'Confronta'}</span></button>`;
    panel.innerHTML = `<div class="det-inner">${gallery}<div class="det-specs">${detailSpecsHTML(r)}</div><div class="det-foot">${openBtn}${salBtn}${confBtn}</div></div>`;
  };
  renderBody();   // apertura immediata (cover + dati on-search) → niente freeze del click
  // Moto.it: galleria piena + spec dalla pagina-dettaglio. Riusa enrichMotoRow (merge
  // immagini+spec, cache 12h server, aggiorna anche il thumb della riga); poi ri-rende.
  if (r.fonte === 'moto' && !r._enriched && /^https?:/.test(r.url || '')) {
    enrichMotoRow(r.url).then(() => { if (panel.isConnected) renderBody(); });
  }
}

function openAd(url) { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); }

// ─── Statistiche ──────────────────────────────────────────────────────────────
function updateStats(results) {
  const withP = results.map(r => ({ r, p: vPricing(r.prezzo) })).filter(x => x.p && x.p.finale > 0).sort((a, b) => a.p.finale - b.p.finale);
  if (!withP.length) {
    document.getElementById('statMin').innerHTML = '—'; document.getElementById('statMax').innerHTML = '—'; return;
  }
  const lo = withP[0], hi = withP[withP.length - 1];
  const mk = (val, r) => r ? `<button class="stat-clickable" data-url="${escapeHtml(r.url)}">${eurRound(val)}</button>` : eurRound(val);
  document.getElementById('statMin').innerHTML = mk(lo.p.finale, lo.r);
  document.getElementById('statMax').innerHTML = mk(hi.p.finale, hi.r);
}

function scrollToCard(url) {
  const card = resultsGrid.querySelector(`[data-url="${CSS.escape(url)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('highlight-card'); void card.offsetWidth; card.classList.add('highlight-card');
  setTimeout(() => card.classList.remove('highlight-card'), 2000);
}

// ─── Stato per-fonte ──────────────────────────────────────────────────────────
const SOURCE_STATUS = {
  ok: { cls: 'src-ok' }, empty: { cls: 'src-muted', txt: 'nessun risultato' },
  skipped: { cls: 'src-muted' }, timeout: { cls: 'src-bad', txt: 'timeout' },
  error: { cls: 'src-bad', txt: 'errore' }, needs_bootstrap: { cls: 'src-warn', txt: 'verifica richiesta' },
};
const SKIP_REASON_TXT = { 'solo moto': 'solo moto', 'marca non su Moto.it': 'non disponibile', 'marca non su Autoscout': 'non disponibile', 'scegli versione': 'scegli versione' };
function renderSourceStatus() {
  if (!fonteBreakdown) return;
  if (!lastSources) { fonteBreakdown.innerHTML = ''; return; }
  const order = ['subito', 'autoscout', 'moto'];
  fonteBreakdown.innerHTML = order.map(f => {
    const s = lastSources[f]; if (!s) return '';
    const meta = SOURCE_STATUS[s.status] || { cls: 'src-muted' };
    let txt;
    if (s.status === 'ok') txt = `${s.count}`;
    else if (s.status === 'skipped') txt = SKIP_REASON_TXT[s.reason] || s.reason || 'saltato';
    else txt = meta.txt || s.status;
    const dim = s.status === 'ok' ? '' : ' src-dim';
    return `<span class="src ${meta.cls}${dim}">${FONTE_LABEL[f]} <b>${txt}</b></span>`;
  }).join('');
}

// ─── Spec (dettaglio) ────────────────────────────────────────────────────────
const SPEC_LABELS = {
  variante: 'Versione', cambio: 'Cambio', cilindrata: 'Cilindrata', cilindri: 'Cilindri',
  potenzaCv: 'Potenza', carrozzeria: 'Carrozzeria', colore: 'Colore', porte: 'Porte', posti: 'Posti',
  classeEmissioni: 'Classe emissioni', neopatentati: 'Neopatentati', nuovo: 'Condizione', danni: 'Danni',
  venditore: 'Venditore', proprietari: 'Proprietari', allestimento: 'Allestimento', revisione: 'Revisione',
};
function specVal(k, v) {
  if (v == null || v === '') return '';
  if (k === 'potenzaCv') return `${v} CV`;
  if (k === 'cilindrata') return `${v} cc`;
  if (k === 'nuovo') return v ? 'Nuovo' : 'Usato';
  if (k === 'danni') return v ? 'Incidentato' : 'Integro';
  if (k === 'neopatentati') return v ? 'Sì' : 'No';
  return String(v);
}
function hasSpec(item) {
  return ['variante', 'cambio', 'cilindrata', 'potenzaCv', 'venditore', 'colore', 'carrozzeria', 'porte', 'posti', 'classeEmissioni', 'proprietari', 'nuovo']
    .some(k => item[k] != null && item[k] !== '');
}

// ─── Lightbox foto ────────────────────────────────────────────────────────────
let lightboxState = null;
function openLightbox(images) {
  closeLightbox();
  let idx = 0;
  const overlay = document.createElement('div');
  overlay.className = 'img-lightbox';
  overlay.innerHTML = `
    <button class="lb-close" aria-label="Chiudi">&times;</button>
    <button class="lb-prev" aria-label="Precedente">&#10094;</button>
    <img class="lb-img" src="" alt="" referrerpolicy="no-referrer">
    <button class="lb-next" aria-label="Successiva">&#10095;</button>
    <div class="lb-count"></div>`;
  const imgEl = overlay.querySelector('.lb-img');
  const countEl = overlay.querySelector('.lb-count');
  const show = () => { imgEl.src = images[idx].full || images[idx].thumb; countEl.textContent = `${idx + 1} / ${images.length}`; };
  const go = d => { idx = (idx + d + images.length) % images.length; show(); };
  overlay.querySelector('.lb-prev').addEventListener('click', e => { e.stopPropagation(); go(-1); });
  overlay.querySelector('.lb-next').addEventListener('click', e => { e.stopPropagation(); go(1); });
  overlay.querySelector('.lb-close').addEventListener('click', closeLightbox);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeLightbox(); });
  const onKey = e => { if (e.key === 'Escape') closeLightbox(); else if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1); };
  document.addEventListener('keydown', onKey);
  let x0 = null;
  overlay.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  overlay.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); x0 = null; }, { passive: true });
  if (images.length < 2) { overlay.querySelector('.lb-prev').style.display = 'none'; overlay.querySelector('.lb-next').style.display = 'none'; }
  document.body.appendChild(overlay);
  lightboxState = { overlay, onKey };
  show();
}
function closeLightbox() {
  if (!lightboxState) return;
  document.removeEventListener('keydown', lightboxState.onKey);
  lightboxState.overlay.remove(); lightboxState = null;
}

// ─── Confronto / matrice ──────────────────────────────────────────────────────
function trovaResult(url) {
  return currentResults.find(r => r.url === url) || salvati.find(r => r.url === url) || confronto.find(r => r.url === url) || null;
}
// Aggiorna SOLO i bottoni/stato di un URL (riga + pannello dettaglio) senza re-render
// totale → non collassa il dettaglio aperto né perde lo scroll (flusso mobile).
function refreshRowState(url) {
  const isSal  = salvati.some(r => r.url === url);
  const inConf = confronto.some(r => r.url === url);
  // Rimpiazza SOLO l'icona (.ico) e l'eventuale label (.ra-txt) → bottoni icona-soli (riga)
  // e icona+testo (pannello dettaglio) restano coerenti.
  const setBtn = (b, on, onIco, offIco, onTxt, offTxt) => {
    b.classList.toggle('attivo', on);
    const ic = b.querySelector('.ico'); if (ic) ic.outerHTML = icon(on ? onIco : offIco);
    const tx = b.querySelector('.ra-txt'); if (tx) tx.textContent = on ? onTxt : offTxt;
  };
  resultsGrid.querySelectorAll(`[data-url="${CSS.escape(url)}"]`).forEach(el => {
    if (el.classList.contains('result-row')) el.classList.toggle('selected', inConf);
    el.querySelectorAll('.btn-salva').forEach(b => {
      setBtn(b, isSal, 'bookmark-filled', 'bookmark', 'Salvato', 'Salva');
      b.title = isSal ? 'Rimuovi dai salvati' : 'Salva annuncio';
    });
    el.querySelectorAll('.btn-confronta').forEach(b => setBtn(b, inConf, 'square-check', 'square', 'Nel confronto', 'Confronta'));
  });
}
function toggleConfronto(url) {
  const result = trovaResult(url); if (!result) return;
  const idx = confronto.findIndex(r => r.url === url);
  if (idx !== -1) confronto.splice(idx, 1);
  else if (confronto.length < COMPARE_CAP) confronto.push(result);
  else { toast(`Massimo ${COMPARE_CAP} annunci a confronto`); return; }
  refreshRowState(url); renderSalvati(); renderCompareBar();
  if (!cmatrixPanel.classList.contains('d-none') && matrixList.length > 1) openCompareMatrix();
}
function renderCompareBar() {
  if (!compareBar) return;
  compareCount.textContent = confronto.length;
  compareBar.classList.toggle('d-none', confronto.length < 1);
}

// Apri matrice: confronto (N colonne) o singolo dettaglio (1 colonna)
function openCompareMatrix() { matrixList = confronto.slice(); showMatrix(confronto.length > 1 ? 'Confronto annunci' : 'Dettaglio annuncio'); }
function closeMatrix() { cmatrixPanel.classList.add('d-none'); matrixList = []; }
function removeMatrixCol(url) {
  matrixList = matrixList.filter(r => r.url !== url);
  const i = confronto.findIndex(r => r.url === url);
  if (i !== -1) { confronto.splice(i, 1); refreshRowState(url); renderSalvati(); renderCompareBar(); }
  if (!matrixList.length) closeMatrix(); else renderMatrix();
}

const MATRIX_ROWS = [
  { key: 'prezzo', label: 'Prezzo', best: 'min', fmt: v => v != null ? `€ ${v.toLocaleString('it-IT')}` : '—' },
  { key: 'anno', label: 'Anno', best: 'max', fmt: v => v != null ? v : '—' },
  { key: 'km', label: 'Km', best: 'min', fmt: v => v != null ? `${v.toLocaleString('it-IT')} km` : '—' },
  { key: 'carburante', label: 'Carburante', fmt: v => v || '—' },
  { key: 'potenzaCv', label: 'Potenza', best: 'max', fmt: v => v != null ? `${v} CV` : '—' },
  { key: 'cilindrata', label: 'Cilindrata', fmt: v => v != null ? `${v} cc` : '—' },
  { key: 'cambio', label: 'Cambio', fmt: v => v || '—' },
  { key: 'colore', label: 'Colore', fmt: v => v || '—' },
  { key: 'carrozzeria', label: 'Carrozzeria', fmt: v => v || '—' },
  { key: 'venditore', label: 'Venditore', fmt: v => v || '—' },
  { key: 'provincia', label: 'Provincia', fmt: v => v || '—' },
  { key: 'variante', label: 'Versione', fmt: v => v || '—' },
];
function showMatrix(title) {
  cmatrixTitle.textContent = `${title} (${matrixList.length})`;
  cmatrixPanel.classList.remove('d-none');
  renderMatrix();
  cmatrixPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  enrichMotoSpecs(matrixList);
}
function bestIndexes(vals, mode) {
  const nums = vals.map(v => (typeof v === 'number' ? v : null));
  const valid = nums.filter(v => v != null);
  if (valid.length < 2) return new Set();
  const target = mode === 'min' ? Math.min(...valid) : Math.max(...valid);
  const set = new Set();
  nums.forEach((v, i) => { if (v === target) set.add(i); });
  return set;
}
// Responsive: desktop = matrice trasposta (densa, confronto a colpo d'occhio);
// mobile = una card per veicolo impilata (scroll verticale naturale, leggibile).
function renderMatrix() {
  const list = matrixList;
  const fmtFonte = r => FONTE_LABEL[r.fonte] || r.fonte;
  const fonteTag = r => ({ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[r.fonte] || '');
  // Indici del valore migliore del set per ogni spec (riusato da tabella e card).
  const bestByRow = MATRIX_ROWS.map(cfg => cfg.best ? bestIndexes(list.map(r => r[cfg.key]), cfg.best) : new Set());

  if (window.matchMedia('(max-width: 760px)').matches) {
    const cards = list.map((r, ci) => {
      const thumb = (Array.isArray(r.immagini) && r.immagini[0])
        ? `<img class="cm-card-img" src="${escapeHtml(r.immagini[0].thumb)}" referrerpolicy="no-referrer" alt="">`
        : `<div class="cm-card-img cm-card-noimg">—</div>`;
      const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="cm-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri ↗</a>` : '';
      const priceBest = bestByRow[0].has(ci);   // MATRIX_ROWS[0] = prezzo
      const price = r.prezzo != null ? `€ ${r.prezzo.toLocaleString('it-IT')}` : 'n/d';
      const specs = MATRIX_ROWS.map((cfg, ri) => ({ cfg, ri })).filter(x => x.cfg.key !== 'prezzo').map(({ cfg, ri }) => {
        const best = bestByRow[ri].has(ci);
        return `<div class="cm-card-spec"><span class="cm-card-k">${cfg.label}</span><span class="cm-card-v${best ? ' cm-best' : ''}">${escapeHtml(String(cfg.fmt(r[cfg.key])))}${best ? ' <span class="cm-star">★</span>' : ''}</span></div>`;
      }).join('');
      return `<div class="cm-card">
        <div class="cm-card-head">${thumb}<div class="cm-card-tt">
          <span class="tag ${fonteTag(r)}">${escapeHtml(fmtFonte(r))}</span>
          <div class="cm-card-title">${escapeHtml(r.titolo || '')}</div>
          <div class="cm-card-price${priceBest ? ' cm-best' : ''}">${price}${priceBest ? ' ★' : ''}</div>
        </div></div>
        <div class="cm-card-specs">${specs}</div>
        <div class="cm-card-foot">${openBtn}<button class="cm-rm" data-url="${escapeHtml(r.url)}" title="Rimuovi dal confronto">✕ Rimuovi</button></div>
      </div>`;
    }).join('');
    cmatrixBody.innerHTML = `<div class="cmatrix-cards">${cards}</div>`;
    return;
  }

  // DESKTOP: tabella trasposta. Foto in testa; valore migliore in verde; righe con
  // valori diversi evidenziate (label piena), righe tutte-uguali attenuate.
  const head = `<thead><tr><th class="cm-label">Annuncio</th>${list.map(r => {
    const thumb = (Array.isArray(r.immagini) && r.immagini[0]) ? `<img class="cm-thumb" src="${escapeHtml(r.immagini[0].thumb)}" referrerpolicy="no-referrer" alt="">` : `<span class="cm-thumb" style="display:flex;align-items:center;justify-content:center">—</span>`;
    const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="cm-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri ↗</a>` : '';
    return `<th><div class="cm-colhead">${thumb}<div class="cm-tt"><div class="cm-coltitle">${escapeHtml(r.titolo || '')}</div><div class="cm-colactions">${openBtn}<button class="cm-rm" data-url="${escapeHtml(r.url)}" title="Rimuovi">✕</button></div></div></div></th>`;
  }).join('')}</tr></thead>`;
  const rows = MATRIX_ROWS.map((cfg, ri) => {
    const vals = list.map(r => String(cfg.fmt(r[cfg.key])));
    const differ = new Set(vals).size > 1;
    const bestIdx = bestByRow[ri];
    const cells = list.map((_, i) => `<td class="cm-val${bestIdx.has(i) ? ' cm-best' : ''}">${escapeHtml(vals[i])}</td>`).join('');
    return `<tr class="${differ ? 'cm-diff' : 'cm-same'}"><td class="cm-label">${cfg.label}</td>${cells}</tr>`;
  }).join('');
  const fonteRow = `<tr class="cm-same"><td class="cm-label">Fonte</td>${list.map(r => `<td class="cm-val">${escapeHtml(fmtFonte(r))}</td>`).join('')}</tr>`;
  cmatrixBody.innerHTML = `<table class="cmatrix">${head}<tbody>${rows}${fonteRow}</tbody></table>`;
}
// Moto.it: spec piene solo via /api/detail (lazy). Riempie le colonne moto poi ri-rende.
async function enrichMotoSpecs(list) {
  const targets = list.filter(r => r.fonte === 'moto' && !hasSpec(r) && /^https?:/.test(r.url || ''));
  if (!targets.length) return;
  await Promise.all(targets.map(async r => {
    if (r._detailLoaded) return;
    try {
      const j = await fetch(`/api/detail?url=${encodeURIComponent(r.url)}`).then(x => x.json());
      // review: marca _detailLoaded SOLO sul successo, sennò un errore transitorio blocca per sempre l'arricchimento
      if (j.ok && j.detail) { Object.keys(j.detail).forEach(k => { if (r[k] == null && j.detail[k] != null) r[k] = j.detail[k]; }); r._detailLoaded = true; }
    } catch (_) {}
  }));
  if (!cmatrixPanel.classList.contains('d-none')) renderMatrix();
}

// ─── Annunci salvati ──────────────────────────────────────────────────────────
function toggleSalva(url) {
  const idx = salvati.findIndex(r => r.url === url);
  if (idx !== -1) salvati.splice(idx, 1);
  else { const result = trovaResult(url); if (result) salvati.push(result); }
  persistSalvati(); aggiornaContatoreSalvati(); renderSalvati(); refreshRowState(url);
}
const SALVATI_KEY = 'amr_salvati';
const SALVATI_CAP = 200;
function persistSalvati() { try { localStorage.setItem(SALVATI_KEY, JSON.stringify(salvati.slice(-SALVATI_CAP))); } catch (_) {} }
function loadSalvati() {
  try { const raw = localStorage.getItem(SALVATI_KEY); const arr = raw ? JSON.parse(raw) : []; salvati = Array.isArray(arr) ? arr : []; }
  catch (_) { salvati = []; }
  aggiornaContatoreSalvati(); renderSalvati();
}
// Badge topbar "Salvati" = annunci salvati + ricerche salvate (così salvare una
// ricerca dà riscontro: Salvati 1 → 2). I tab dell'offcanvas distinguono i due.
function aggiornaContatoreSalvati() {
  const c = document.getElementById('salvatiCount'); if (c) c.textContent = salvati.length + savedSearches.length;
  const t = document.getElementById('tabSalvatiCount'); if (t) t.textContent = salvati.length;
  updateSavedButton();
}
function updateSavedButton() {
  // Bottone "Salvati" persistente nel topbar (niente più pill flottante).
  const btn = document.getElementById('btnSaved');
  if (btn) btn.style.display = 'inline-flex';
}
function renderSalvati() {
  const container = document.getElementById('salvatiList');
  if (salvati.length === 0) { container.innerHTML = '<p class="text-muted text-center py-4">Nessun annuncio salvato.</p>'; return; }
  const fmt = n => n != null ? `€ ${n.toLocaleString('it-IT')}` : '—';
  const fmtKm = n => n != null ? `${n.toLocaleString('it-IT')} km` : '—';
  container.innerHTML = salvati.map(r => {
    const inConf = confronto.some(c => c.url === r.url);
    return `<div class="salvato-item" data-url="${escapeHtml(r.url)}">
      <div class="salvato-info">
        <div class="salvato-titolo">${escapeHtml(r.titolo)}</div>
        <div class="salvato-dettagli">${fmt(r.prezzo)} · ${fmtKm(r.km)} · ${r.anno || '—'}</div>
      </div>
      <div class="salvato-actions">
        <button class="btn-confronta-salvato${inConf ? ' attivo' : ''}" title="Confronta">${icon(inConf ? 'square-check' : 'square')}</button>
        <button class="btn-rimuovi-salvato" title="Rimuovi">${icon('x')}</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Ricerche salvate + avvisi ──────────────────────────────────────────────
async function loadSavedSearches() {
  try { const r = await fetch('/api/saved'); const j = await r.json(); savedSearches = j.saved || []; }
  catch (_) { savedSearches = []; }
  renderRicerche(); updateNovitaBadge();
}
function totalNovita() { return savedSearches.reduce((a, s) => a + (s.novita || 0), 0); }
function updateNovitaBadge() {
  const tot = totalNovita();
  const badge = document.getElementById('novitaCount');
  const sc = document.getElementById('salvatiCount'); if (sc) sc.textContent = salvati.length + savedSearches.length;
  const tr = document.getElementById('tabRicercheCount'); if (tr) tr.textContent = savedSearches.length;
  if (badge) { if (tot > 0) { badge.textContent = tot; badge.style.display = 'inline-block'; } else badge.style.display = 'none'; }
  updateSavedButton();
}
async function saveCurrentSearch() {
  if (!lastSearchParams || !lastSearchParams.marca) { showError('Fai prima una ricerca, poi salvala.'); return; }
  const btn = document.getElementById('btnSalvaRicerca');
  btn.disabled = true;
  try {
    const r = await fetch('/api/saved', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params: lastSearchParams }) });
    if (!r.ok) throw new Error('save failed');
    await loadSavedSearches();
    btn.textContent = '✓ Salvata';
    setTimeout(() => { btn.textContent = 'Salva ricerca'; btn.disabled = false; }, 1500);
  } catch (_) { showError('Salvataggio ricerca non riuscito.'); btn.disabled = false; }
}
async function checkRicerche(id) {
  const url = id ? `/api/saved/check?id=${encodeURIComponent(id)}` : '/api/saved/check';
  const listEl = document.getElementById('ricercheList');
  const btn = id ? listEl.querySelector(`.ric-card[data-id="${CSS.escape(id)}"] .ric-check`) : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; } else listEl.classList.add('checking');
  try {
    const r = await fetch(url, { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Controllo non riuscito');   // review: prima un 500 dava "Nessuna novità" (falso negativo)
    if (j.saved) { savedSearches = j.saved; updateNovitaBadge(); }
    const nuovi = Array.isArray(j.esiti) ? j.esiti.reduce((a, e) => a + (e?.nuovi || 0), 0) : 0;
    toast(nuovi > 0 ? `${nuovi} ${nuovi === 1 ? 'novità trovata' : 'novità trovate'}` : 'Nessuna novità');
  } catch (e) { showError(e.message || 'Controllo non riuscito.'); }
  finally { listEl.classList.remove('checking'); renderRicerche(); }   // ripristina i bottoni ('…' bloccato) in OGNI esito
}
function onRicercheClick(e) {
  const card = e.target.closest('[data-id]'); if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.ric-check')) { checkRicerche(id); return; }
  if (e.target.closest('.ric-del')) { deleteRicerca(id); return; }
  const alertEl = e.target.closest('.ric-alert[data-url]');
  if (alertEl) { markRicercaRead(id); openAd(alertEl.dataset.url); return; }
  if (e.target.closest('.ric-head')) card.classList.toggle('open');
}
async function deleteRicerca(id) {
  try { await fetch(`/api/saved/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadSavedSearches(); }
  catch (_) { showError('Eliminazione non riuscita.'); }
}
async function markRicercaRead(id) {
  try { await fetch(`/api/saved/${encodeURIComponent(id)}/read`, { method: 'POST' }); } catch (_) {}
  const s = savedSearches.find(x => x.id === id);
  if (s) { s.novita = 0; s.digest = {}; updateNovitaBadge(); }
  const card = document.querySelector(`.ric-card[data-id="${CSS.escape(id)}"]`);
  if (card) { card.classList.remove('has-novita'); card.querySelector('.ric-badge')?.remove(); }
}
const MOTIVO_LABEL = { nuovo: 'nuovi', calo: 'cali' };
function renderRicerche() {
  const c = document.getElementById('ricercheList');
  if (!savedSearches.length) {
    c.innerHTML = '<p class="text-muted text-center py-4">Nessuna ricerca salvata.<br><small>Fai una ricerca e premi "Salva ricerca".</small></p>';
    return;
  }
  const isDemo = document.body.classList.contains('demo-mode');
  const whenTxt = ts => {
    if (!ts) return 'mai controllata';
    const min = Math.round((Date.now() - ts) / 60000);
    if (min < 1) return 'adesso';
    if (min < 60) return `${min} min fa`;
    const h = Math.round(min / 60);
    return h < 24 ? `${h}h fa` : `${Math.round(h / 24)}g fa`;
  };
  const fmt = n => n != null ? `€ ${n.toLocaleString('it-IT')}` : '—';
  c.innerHTML = savedSearches.map(s => {
    const novita = s.novita || 0;
    const badge = novita > 0 ? `<span class="ric-badge">${novita}</span>` : '';
    const dig = Object.entries(s.digest || {}).map(([m, n]) => `${n} ${MOTIVO_LABEL[m] || m}`).join(' · ');
    const digestLine = dig ? `<div class="ric-digest">${dig}</div>` : '';
    const alertsHtml = (s.alerts || []).map(a => `
      <div class="ric-alert ric-${a.motivo}" data-url="${escapeHtml(a.url)}" title="Apri annuncio">
        <span class="ric-motivo">${MOTIVO_LABEL[a.motivo]?.slice(0, -1) || a.motivo}</span>
        <span class="ric-alert-tit">${escapeHtml(a.titolo || 'Annuncio')}</span>
        <span class="ric-alert-prezzo">${fmt(a.prezzo)}</span>
      </div>`).join('');
    return `<div class="ric-card${novita ? ' has-novita' : ''}" data-id="${escapeHtml(s.id)}">
      <div class="ric-head">
        <div class="ric-title">${escapeHtml(s.label)} ${badge}</div>
        <div class="ric-sub">${escapeHtml(s.params?.tipo || '')} · controllata ${whenTxt(s.lastChecked)}</div>
        ${digestLine}
      </div>
      <div class="ric-actions">
        ${isDemo ? '' : '<button class="rnav-btn ric-check" title="Controlla ora">Controlla</button>'}
        ${isDemo ? '' : `<button class="rnav-btn ric-del" title="Elimina">${icon('x')}</button>`}
      </div>
      ${alertsHtml ? `<div class="ric-alerts">${alertsHtml}</div>` : ''}
    </div>`;
  }).join('');
}

// ─── Segnalazioni (bug-report) ───────────────────────────────────────────────
function openReport() {
  const m = document.getElementById('reportModal'); if (!m) return;
  document.getElementById('reportMsg').value = '';
  document.getElementById('reportStatus').textContent = '';
  const att = document.getElementById('reportAttach');
  if (att) { att.checked = false; att.parentElement.style.display = searchActive ? '' : 'none'; }
  m.classList.remove('d-none');
  document.getElementById('reportMsg').focus();
}
function closeReport() { document.getElementById('reportModal')?.classList.add('d-none'); }
function closeQr() { document.getElementById('qrModal')?.classList.add('d-none'); }
async function submitReport() {
  const msg = document.getElementById('reportMsg').value.trim();
  const status = document.getElementById('reportStatus');
  if (!msg) { status.textContent = 'Scrivi un messaggio.'; return; }
  const attach = document.getElementById('reportAttach')?.checked && searchActive;
  const body = { type: attach ? 'search' : 'bug', message: msg };
  if (attach) { body.searchParams = lastSearchParams; body.count = currentResults.length; }
  const btn = document.getElementById('reportSend'); btn.disabled = true; status.textContent = 'Invio…';
  try {
    const r = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) { closeReport(); toast('Grazie, segnalazione inviata.'); }
    else if (r.status === 429) status.textContent = 'Troppe segnalazioni, riprova tra qualche minuto.';
    else status.textContent = 'Invio non riuscito.';
  } catch (_) { status.textContent = 'Errore di rete.'; }
  finally { btn.disabled = false; }
}

// ─── Attesa di caricamento: skeleton + consiglio rotante ──────────────────────
const LOADING_TIPS = [
  'Raggruppa i risultati per modello, fonte, carburante o anno dalla toolbar.',
  'Dal menu “Prezzo €” aggiungi commissione e spese: vedi subito il prezzo di listino.',
  'Confronta più annunci fianco a fianco: spuntali e premi “Apri confronto”.',
  'Salva una ricerca e AMR ti avvisa su annunci nuovi e cali di prezzo.',
  'Esporta i risultati in PDF o CSV con un click.',
  'Ordina per prezzo, anno o km cliccando l’intestazione della colonna.',
  'Per i ricambi con codice OE/OEM trovi anche scheda tecnica e compatibilità.',
  'Filtra per regione; su Autoscout puoi cercare entro un raggio in km dal capoluogo.',
  'Hai domande? Ti rispondiamo subito in chat su WhatsApp.',
];
function loadingBlockHTML(status) {
  const skel = '<div class="skel-row"><div class="skel-thumb"></div><div class="skel-lines"><span></span><span></span></div><div class="skel-price"></div></div>'.repeat(6);
  return `<div class="amr-loading">
    <div class="amr-loading-bar"><span class="spinner-border text-primary" role="status" style="width:1.1rem;height:1.1rem;border-width:2px"></span><span class="amr-loading-status">${escapeHtml(status)}</span></div>
    <div class="amr-loading-tip">${icon('bulb', 'tip-ico')}<span class="tip-text">${escapeHtml(LOADING_TIPS[0])}</span></div>
    <div class="skel-list">${skel}</div>
  </div>`;
}
// timer per-elemento (memorizzato su el._tipTimer): due loading concorrenti (ricambi + veicoli)
// non si uccidono a vicenda e non condividono un id duplicato.
function startLoadingTips(root) {
  const el = root && root.querySelector && root.querySelector('.amr-loading-tip'); if (!el) return;
  if (el._tipTimer) clearInterval(el._tipTimer);
  let idx = 0;
  el._tipTimer = setInterval(() => {
    if (!el.isConnected) { clearInterval(el._tipTimer); el._tipTimer = null; return; }   // DOM sostituito → stop
    idx = (idx + 1) % LOADING_TIPS.length;
    const txt = el.querySelector('.tip-text');
    el.classList.add('fade');
    setTimeout(() => { if (txt) txt.textContent = LOADING_TIPS[idx]; el.classList.remove('fade'); }, 220);
  }, 3200);
}
function stopLoadingTips(root) { const el = root && root.querySelector && root.querySelector('.amr-loading-tip'); if (el && el._tipTimer) { clearInterval(el._tipTimer); el._tipTimer = null; } }

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showLoading() { statusBox.classList.remove('d-none'); loadingState.innerHTML = loadingBlockHTML('Cerco su più siti…'); loadingState.classList.remove('d-none'); errorState.classList.add('d-none'); startLoadingTips(loadingState); }
function hideLoading() {
  stopLoadingTips(loadingState);
  loadingState.classList.add('d-none');
  const errorVisible = !errorState.classList.contains('d-none');
  const bannerVisible = !subitoBanner.classList.contains('d-none');
  if (!errorVisible && !bannerVisible) statusBox.classList.add('d-none');
}
function showError(msg) { statusBox.classList.remove('d-none'); loadingState.classList.add('d-none'); errorState.classList.remove('d-none'); errorText.textContent = msg; }
function hideError() { errorState.classList.add('d-none'); if (subitoBanner.classList.contains('d-none')) statusBox.classList.add('d-none'); }
function hideResults() {
  searchActive = false;
  document.body.classList.remove('has-results');   // torna allo stato iniziale → sfondo + search centrata
  _enrichQueue.length = 0; if (enrichObserver) enrichObserver.disconnect();   // stop enrichment Moto.it pendente
  resultsSection.classList.add('d-none'); noResults.classList.add('d-none'); resultsToolbar.classList.add('d-none');
  fonteBreakdown.innerHTML = ''; resultsGrid.innerHTML = ''; compareBar.classList.add('d-none'); closeMatrix();
  clearVehScheda();
}

// ─── Scheda tecnica veicolo (auto-data.net) — highlighted, collassabile, sopra gli annunci ──
let vehData = null, vehSpecs = {}, vehSchedaCollapsed = false, vehSelUrl = null, vehGen = 0;   // vehGen: token anti-race — scarta risposte di ricerche/generazioni superate
function clearVehScheda() { vehGen++; vehData = null; vehSpecs = {}; vehSelUrl = null; vehXf.compare = null; vehXf.q = ''; const el = document.getElementById('vehicleScheda'); if (el) el.innerHTML = ''; }   // vehGen++ invalida le fetch in volo

async function loadVehScheda() {
  const el = document.getElementById('vehicleScheda'); if (!el) return;
  const my = ++vehGen;   // invalida ogni scheda ancora in volo di una ricerca precedente
  // agganciati alla ricerca ESEGUITA (lastSearchParams), non allo stato UI live (che l'utente può aver già cambiato)
  const p = lastSearchParams || {};
  const tipo = p.tipo || currentTipo();
  if (tipo !== 'auto' && tipo !== 'moto') { clearVehScheda(); return; }   // scheda solo auto/moto
  const marca = p.marca || (matchedBrand() && matchedBrand().nome) || '';
  const modello = p.modello || (selectedModel && selectedModel.nome) || '';
  if (!marca || !modello) { clearVehScheda(); return; }   // scheda solo con un modello specifico
  const anno = p.annoMin || p.annoMax || '';
  vehSchedaCollapsed = true;   // scheda chiusa di default
  vehXf.compare = null; vehXf.q = ''; vehXf.highlight = new Set(); vehGenChosen = false; vehShowAll = false;   // reset per ricerca (traduci/unità restano preferenze)
  el.innerHTML = '<div class="rc-group"><div class="rc-group-body"><div class="rc-loading">Carico la scheda tecnica…</div></div></div>';
  try {
    const r = await fetch(`/api/scheda-veicolo?tipo=${encodeURIComponent(tipo)}&marca=${encodeURIComponent(marca)}&modello=${encodeURIComponent(modello)}&anno=${encodeURIComponent(anno)}`);
    const d = await r.json();
    if (my !== vehGen) return;   // una ricerca più recente ha già preso il posto → non toccare la scheda
    const hasData = d.ok && (((d.generations || []).length) || ((d.motorizzazioni || []).length));
    if (!hasData) { clearVehScheda(); return; }
    // NIENTE auto-selezione: l'utente sceglie generazione → motorizzazione. Moto: voci pronte subito.
    vehData = d; vehSpecs = {}; vehSelUrl = null;
    renderVehScheda();
  } catch (_) { if (my === vehGen) clearVehScheda(); }
}

function renderVehScheda() {
  const el = document.getElementById('vehicleScheda'); if (!el || !vehData) return;
  const d = vehData;
  const tipo = vehTipo();
  // combobox (search + dropdown): input vuoto di default; value = etichetta solo dopo la scelta. Caret = dropdown.
  const genSel = tipo === 'auto' && d.generations.length
    ? vehCombo('veh-combo-gen', vehGenChosen && d.gen ? d.gen.name : '', 'Generazione')
    : '';
  const curMoto = (d.motorizzazioni || []).find(m => m.url === vehSelUrl) || {};
  const curLabel = vehSelUrl && curMoto.label ? curMoto.label + (curMoto.hp ? ` · ${curMoto.hp} CV` : '') : '';
  const motoSel = vehCombo('veh-combo-moto', curLabel, tipo === 'moto' ? 'Anno / allestimento' : 'Motorizzazione');
  // auto = specifiche già native in italiano (/it/) → toggle IT solo per la moto (fonte inglese, dizionario)
  const itBtn = tipo === 'moto' ? `<button type="button" class="veh-tb-btn veh-it${vehXf.translate ? ' on' : ''}" title="Traduci in italiano">IT</button>` : '';
  // toolbar + combos vivono FUORI da .rc-sch-secs (persistenti): l'arrivo async delle specs
  // aggiorna solo .rc-sch-secs (renderVehBody) senza distruggere ciò che l'utente sta digitando.
  el.innerHTML = `<div class="rc-group${vehSchedaCollapsed ? ' collapsed' : ''}">`
    + `<button type="button" class="rc-group-head rc-sched-head"><span class="rc-gcaret">${icon('chevron')}</span><span class="rc-group-title">Scheda tecnica</span><span class="rc-group-meta">${escapeHtml(d.title)}</span></button>`
    + `<div class="rc-group-body"><div class="veh-sel-row">${genSel}${motoSel}${itBtn}</div>${vehSelUrl ? vehToolbarHTML() : ''}<div class="rc-sch-secs">${vehBodyHTML()}</div></div></div>`;
  applyVehViewState();   // ri-applica ricerca-campo + espandi/comprimi dopo ogni render
}
function vehBodyHTML() {
  const tipo = vehTipo();
  if (!vehGenChosen && vehGenStep()) return vehGenGridHTML();   // griglia foto generazioni (auto con generazioni)
  if (!vehSelUrl) {
    if (!((vehData && vehData.motorizzazioni) || []).length) return '<div class="rc-empty">Nessuna motorizzazione per questa selezione.</div>';
    return vehMotoGridHTML(tipo);   // griglia card motorizzazione/anno
  }
  const spec = vehSpecs[vehSelUrl];
  if (!spec || spec.loading) return '<div class="rc-loading">Carico le specifiche…</div>';
  if (!spec.ok || !spec.groups || !spec.groups.length) return '<div class="rc-empty">Specifiche non disponibili per questa motorizzazione.</div>';
  return (vehXf.compare ? '' : vehHlBandHTML(spec)) + vehSectionsHTML(spec);
}
// ── Filtro/suggerimento per anno (dai filtri ricerca "anno da/anno a"): suggerisce ma NON sceglie ──
function vehYearFilter() {
  const p = lastSearchParams || {};
  const min = Number(p.annoMin) || null, max = Number(p.annoMax) || null;
  return (min || max) ? { min, max } : null;
}
function vehInRange(s, e, f) {   // periodo [s,e] (e null = ancora in produzione) interseca [f.min,f.max]?
  if (s == null) return false;
  return s <= (f.max || Infinity) && (e == null ? Infinity : e) >= (f.min || -Infinity);
}
function vehItemYears(m) {   // start + end dai campi years/yearRange/year
  if (Array.isArray(m.years)) return m.years.length ? [Math.min(...m.years), Math.max(...m.years)] : [null, null];
  const s = m.year || null, em = /–\s*(\d{4})/.exec(m.yearRange || '');
  const e = em ? Number(em[1]) : (/–\s*$/.test(m.yearRange || '') ? null : s);   // "2024–" = aperto; singolo = s
  return [s, e];
}
function vehYearNoteHTML(f, hidden, showAll, noMatch) {
  const label = f.min && f.max ? `${f.min}–${f.max}` : (f.min ? `dal ${f.min}` : `fino al ${f.max}`);
  if (noMatch) return `<div class="veh-year-note">Nessuna corrisponde al periodo cercato (${label}) — le mostro tutte.</div>`;
  return showAll
    ? `<div class="veh-year-note">Anni cercati ${label} <span class="veh-sug-dot"></span>evidenziati. <button type="button" class="veh-showall" data-showall="0">Filtra per periodo</button></div>`
    : `<div class="veh-year-note">Filtrate per anni ${label}${hidden ? ` · ${hidden} nascoste` : ''}. <button type="button" class="veh-showall" data-showall="1">Mostra tutte</button></div>`;
}
// grid generica con filtro/evidenza per anno (mai auto-seleziona)
function vehCardGrid(items, cardFn, gridClass, hint) {
  const f = vehYearFilter();
  const ann = items.map(it => ({ it, match: f ? vehInRange(...vehItemYears(it), f) : false }));
  const anyMatch = f && ann.some(x => x.match);
  const showAll = !f || vehShowAll || !anyMatch;
  const shown = showAll ? ann : ann.filter(x => x.match);
  const note = f ? vehYearNoteHTML(f, ann.length - shown.length, showAll, !anyMatch) : '';
  const cards = shown.map(x => cardFn(x.it, showAll && anyMatch && x.match)).join('');   // badge "suggerito" solo mostrando tutte
  return `<div class="veh-gen-pick"><div class="veh-gen-pick-hint">${escapeHtml(hint)}</div>${note}<div class="${gridClass}">${cards}</div></div>`;
}

// Griglia visiva selezione generazione (auto): card foto + nome + anni.
function vehGenCardHTML(g, sug) {
  const prefix = new RegExp('^' + `${(vehData && vehData.marca) || ''} ${(vehData && vehData.modello) || ''} `.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const img = /^https:\/\/(www\.)?auto-data\.net\//i.test(g.img || '') ? g.img : '';
  const name = String(g.name || '').replace(prefix, '') || g.name;
  const yr = g.years && g.years.length ? `${Math.min(...g.years)}–${Math.max(...g.years)}` : '';
  return `<button type="button" class="veh-gen-card${sug ? ' veh-card-sug' : ''}" data-slug="${escapeHtml(g.slug)}">`
    + (img ? `<img class="veh-gen-card-img" src="${escapeHtml(img)}" alt="" loading="lazy">` : '<span class="veh-gen-card-noimg"></span>')
    + `<span class="veh-gen-card-name">${escapeHtml(name)}</span>${yr ? `<span class="veh-gen-card-years">${escapeHtml(yr)}</span>` : ''}</button>`;
}
function vehGenGridHTML() {
  const gens = (vehData && vehData.generations) || [];
  if (!gens.length) return '<div class="rc-empty">Nessuna generazione disponibile.</div>';
  return vehCardGrid(gens, vehGenCardHTML, 'veh-gen-grid', 'Scegli la generazione dalla foto:');
}
// Griglia card motorizzazione: anno in evidenza + label + hp/carburante. Selezione via click.
function vehMotoCardHTML(m, sug) {
  const yr = m.yearRange || (m.year ? String(m.year) : '');
  const meta = [m.hp ? `${m.hp} CV` : '', m.fuel || ''].filter(Boolean).join(' · ');
  return `<button type="button" class="veh-moto-card${sug ? ' veh-card-sug' : ''}" data-url="${escapeHtml(m.url)}">`
    + `<span class="veh-moto-card-year">${escapeHtml(yr || '—')}</span>`
    + `<span class="veh-moto-card-label">${escapeHtml(m.label)}</span>`
    + (meta ? `<span class="veh-moto-card-meta">${escapeHtml(meta)}</span>` : '') + `</button>`;
}
function vehMotoGridHTML(tipo) {
  const list = (vehData && vehData.motorizzazioni) || [];
  return vehCardGrid(list, vehMotoCardHTML, 'veh-moto-grid', `Scegli ${tipo === 'moto' ? "l'annata / allestimento" : 'la motorizzazione'}:`);
}
// banda "In evidenza": SOLO i campi spuntati dall'utente (niente highlight automatico)
function vehHlBandHTML(spec) {
  if (!vehXf.highlight.size) return '';
  const flat = {}; spec.groups.forEach(g => g.rows.forEach(r => { if (flat[r.k] == null) flat[r.k] = r; }));
  const picks = [...vehXf.highlight].map(k => flat[k]).filter(Boolean).map(vehXfRow);
  if (!picks.length) return '';
  return `<div class="veh-hl-band">${picks.map(r => `<div class="veh-ks veh-hl"><span class="veh-ks-k">${escapeHtml(r.k)}</span><span class="veh-ks-v">${escapeHtml(r.v)}</span></div>`).join('')}</div>`;
}
// aggiorna SOLO il corpo dati (toolbar/combos restano): usato all'arrivo async delle specs
function renderVehBody() {
  const el = document.getElementById('vehicleScheda'); const secs = el && el.querySelector('.rc-sch-secs');
  if (!secs || !vehData) return renderVehScheda();
  secs.innerHTML = vehBodyHTML();
  applyVehViewState();
}

const VEH_UNIT_ROWS = [
  ['len', 'Lunghezze', [['', 'mm'], ['cm', 'cm'], ['m', 'm']]],
  ['disp', 'Cilindrata', [['', 'cm³'], ['L', 'L']]],
  ['mass', 'Peso', [['', 'kg'], ['t', 't']]],
  ['pow', 'Potenza', [['', 'CV/Hp'], ['kW', 'kW']]],
  ['trq', 'Coppia', [['', 'Nm'], ['kgm', 'kgm']]],
];
function vehToolbarHTML() {
  const unitsActive = Object.values(vehXf.units).some(Boolean);
  const unitsMenu = VEH_UNIT_ROWS.map(([fam, lab, opts]) => `<label class="veh-u-row"><span>${lab}</span><select class="veh-tb-unit" data-fam="${fam}" aria-label="${lab}">${opts.map(([v, l]) => `<option value="${v}"${(vehXf.units[fam] || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`).join('');
  let cmpCombo = '';
  if (vehXf.compare) {
    const cm = vehData.motorizzazioni.find(m => m.url === vehXf.compare) || {};
    const cl = cm.label ? cm.label + (cm.hp ? ` · ${cm.hp} CV` : '') : '';
    cmpCombo = vehCombo('veh-combo-cmp', cl, 'Confronta con…');
  }
  return `<div class="veh-toolbar">`
    + `<div class="veh-q-wrap">${icon('search', 'veh-q-ico')}<input type="search" class="veh-tb-q" placeholder="Cerca campo…" value="${escapeHtml(vehXf.q)}"></div>`
    + `<details class="tb-cols veh-units${unitsActive ? ' has-adj' : ''}"><summary class="veh-tb-btn">Unità</summary><div class="tb-cols-menu veh-units-menu">${unitsMenu}</div></details>`
    + `<button type="button" class="veh-tb-btn veh-tb-all">${vehXf.allOpen === true ? 'Comprimi tutto' : 'Espandi tutto'}</button>`
    + `<button type="button" class="veh-tb-btn veh-tb-cmp${vehXf.compare ? ' on' : ''}">Confronta</button>`
    + `<details class="tb-cols veh-export"><summary class="veh-tb-btn">Esporta</summary><div class="tb-cols-menu veh-export-menu"><button type="button" class="veh-exp" data-exp="copia">Copia negli appunti</button><button type="button" class="veh-exp" data-exp="csv">Scarica CSV</button><button type="button" class="veh-exp" data-exp="pdf">Scarica PDF</button></div></details>`
    + cmpCombo
    + `</div>`;
}
function vehGrpHTML(title, count, i, bodyInner, extraCls) {
  return `<div class="veh-grp${i === 0 ? '' : ' veh-collapsed'}"><button type="button" class="veh-grp-head"><span class="veh-grp-caret">${icon('chevron')}</span><span class="veh-grp-tit">${escapeHtml(title)}</span><span class="veh-grp-count">${count}</span></button><div class="veh-grp-body${extraCls || ''}">${bodyInner}</div></div>`;
}
function vehSectionsHTML(spec) {
  if (vehXf.compare) {
    const specB = vehSpecs[vehXf.compare];
    const bOk = specB && specB.ok && specB.groups;
    const la = (vehData.motorizzazioni.find(m => m.url === vehSelUrl) || {}).label || 'A';
    const lb = (vehData.motorizzazioni.find(m => m.url === vehXf.compare) || {}).label || 'B';
    const head = `<div class="veh-cmp-head"><span></span><span>${escapeHtml(la)}</span><span>${escapeHtml(lb)}</span></div>`;
    let note = '';
    if (!specB || specB.loading) note = '<div class="rc-loading">Carico il confronto…</div>';
    else if (!bOk) note = '<div class="rc-empty">Confronto non disponibile per questa voce.</div>';
    // unione gruppo→chiave→{a,b}: mostra anche i campi presenti SOLO nella voce B
    const order = []; const groups = {};
    const add = (gt, k, w, val) => { if (!groups[gt]) { groups[gt] = {}; order.push(gt); } if (!groups[gt][k]) groups[gt][k] = { k }; groups[gt][k][w] = val; };
    spec.groups.forEach(g => g.rows.forEach(r => add(g.title, r.k, 'a', r.v)));
    if (bOk) specB.groups.forEach(g => g.rows.forEach(r => add(g.title, r.k, 'b', r.v)));
    const secs = order.map((gt, i) => {
      const rows = Object.values(groups[gt]);
      const inner = rows.map(row => {
        const aD = row.a != null ? vehTrVal(vehConv(row.a)) : '';
        const bD = row.b != null ? vehTrVal(vehConv(row.b)) : '';
        const diff = row.a != null && row.b != null && aD !== bD;   // confronto sui valori MOSTRATI (post-trasformazione)
        return `<div class="veh-row veh-crow${diff ? ' veh-diff' : ''}"><span class="veh-k">${escapeHtml(vehTrKey(row.k))}</span><span class="veh-v">${escapeHtml(aD || '—')}</span><span class="veh-v">${escapeHtml(bD || '—')}</span></div>`;
      }).join('');
      return vehGrpHTML(gt, rows.length, i, inner, ' veh-grp-cmp');
    }).join('');
    return head + note + secs;
  }
  return spec.groups.map((g, gi) => {
    const inner = g.rows.map(r => {
      const hl = vehXf.highlight.has(r.k);
      return `<div class="veh-row${hl ? ' veh-hl' : ''}"><input type="checkbox" class="veh-hl-cb" data-k="${escapeHtml(r.k)}"${hl ? ' checked' : ''} title="Metti in evidenza"><span class="veh-k">${escapeHtml(vehTrKey(r.k))}</span><span class="veh-v">${escapeHtml(vehTrVal(vehConv(r.v)))}</span></div>`;
    }).join('');
    return vehGrpHTML(g.title, g.rows.length, gi, inner);
  }).join('');
}
// ricerca-campo + espandi/comprimi: manipola il DOM (niente re-render → non perde il focus)
function applyVehViewState() {
  const el = document.getElementById('vehicleScheda'); if (!el) return;
  const q = acn(vehXf.q || '');
  el.querySelectorAll('.veh-grp').forEach(grp => {
    let vis = 0;
    grp.querySelectorAll('.veh-row').forEach(row => {
      const k = acn((row.querySelector('.veh-k') || {}).textContent || '');
      const show = !q || k.includes(q);
      row.style.display = show ? '' : 'none'; if (show) vis++;
    });
    grp.style.display = (q && !vis) ? 'none' : '';
    if (q) grp.classList.toggle('veh-collapsed', !vis);
    else if (vehXf.allOpen === true) grp.classList.remove('veh-collapsed');
    else if (vehXf.allOpen === false) grp.classList.add('veh-collapsed');
  });
}

async function fetchVehSpecs(url) {
  if (!url) return;
  const my = vehGen;   // token: una nuova ricerca/gen invalida la scrittura tardiva
  const shows = () => (vehSelUrl === url || vehXf.compare === url) && my === vehGen;
  const hit = vehSpecs[url];
  if (hit && hit.loading) return;                       // già in volo → niente doppioni
  if (hit && hit.ok) { if (shows()) renderVehBody(); return; }   // già ok → mostra (ok:false ricade sotto → riprova)
  vehSpecs[url] = { loading: true };
  if (shows()) renderVehBody();
  try { const r = await fetch(`/api/scheda-veicolo/specs?url=${encodeURIComponent(url)}`); const j = await r.json(); if (my !== vehGen) return; vehSpecs[url] = j; }
  catch (_) { if (my !== vehGen) return; vehSpecs[url] = { ok: false }; }
  if (shows()) renderVehBody();
}

async function switchVehGen(genSlug) {
  if (!vehData) return;
  const my = ++vehGen;   // cambio generazione rapido → vince l'ultimo, gli altri si scartano
  const tipo = vehTipo();   // tipo della scheda, non della UI
  const el = document.getElementById('vehicleScheda');
  const secs = el && el.querySelector('.rc-sch-secs'); if (secs) secs.innerHTML = '<div class="rc-loading">Carico…</div>';
  try {
    const r = await fetch(`/api/scheda-veicolo?tipo=${encodeURIComponent(tipo)}&marca=${encodeURIComponent(vehData.marca)}&modello=${encodeURIComponent(vehData.modello)}&gen=${encodeURIComponent(genSlug)}`);
    const d = await r.json();
    if (my !== vehGen) return;   // una selezione/ricerca più recente ha già preso il posto
    // gen scelta: aggiorna le voci ma NON auto-selezionare la motorizzazione (la sceglie l'utente)
    if (d.ok && d.generations) { vehData = d; vehSpecs = {}; vehXf.compare = null; vehSelUrl = null; vehGenChosen = !!d.gen; vehShowAll = false; renderVehScheda(); }   // gen non trovata (d.gen null) → torna alla griglia generazioni
    else if (secs) secs.innerHTML = '<div class="rc-empty">Nessuna specifica per questa generazione.</div>';
  } catch (_) { if (my === vehGen && secs) secs.innerHTML = '<div class="rc-empty">Scheda non disponibile.</div>'; }
}

// ── Combobox scheda (lista visibile filtrata): sorgente/filtro/render/pick ──
let vehAcActive = -1;   // indice evidenziato nella lista aperta (una sola alla volta)
function vehComboSrc(input) {
  if (input.classList.contains('veh-combo-gen')) return { kind: 'gen', src: ((vehData && vehData.generations) || []).map(g => ({ label: g.name, key: g.slug, img: g.img })) };
  // auto con generazioni: le motorizzazioni compaiono solo DOPO aver scelto la generazione (search-landing: subito)
  let src = (!vehGenChosen && vehGenStep()) ? [] : ((vehData && vehData.motorizzazioni) || []).map(m => ({ label: m.label + (m.hp ? ` · ${m.hp} CV` : ''), key: m.url }));
  if (input.classList.contains('veh-combo-cmp')) src = src.filter(x => x.key !== vehSelUrl);   // niente auto-confronto
  return { kind: 'moto', src };
}
// ripristina nel campo l'etichetta della selezione corrente (chiusura senza pick → non lasciare il testo-filtro)
function vehComboRestore(input) {
  if (!vehData) return;
  if (input.classList.contains('veh-combo-gen')) { input.value = vehGenChosen && vehData.gen ? vehData.gen.name : ''; return; }
  const url = input.classList.contains('veh-combo-cmp') ? vehXf.compare : vehSelUrl;
  const m = (vehData.motorizzazioni || []).find(x => x.url === url) || {};
  input.value = url && m.label ? m.label + (m.hp ? ` · ${m.hp} CV` : '') : '';
}
function vehComboMatches(input) {
  const { src } = vehComboSrc(input);
  const q = acn(input.value);
  if (!q) return src;
  const scored = [];
  for (const it of src) { const n = acn(it.label); const i = n.indexOf(q); if (i >= 0) scored.push({ it, rank: n.startsWith(q) ? 0 : 1, i, n }); }
  scored.sort((a, b) => a.rank - b.rank || a.i - b.i || a.n.localeCompare(b.n));
  return scored.map(s => s.it);
}
function renderVehAc(input, matches) {
  const list = input.parentElement.querySelector('.veh-ac'); if (!list) return;
  if (!matches.length) { list.classList.add('d-none'); list.innerHTML = ''; input.setAttribute('aria-expanded', 'false'); return; }
  list.innerHTML = matches.map((it, i) => {
    const img = it.img && /^https:\/\/(www\.)?auto-data\.net\//i.test(it.img) ? it.img : '';   // solo thumb auto-data.net
    return `<li class="ac-item${img ? ' veh-ac-photo' : ''}${i === vehAcActive ? ' active' : ''}" role="option" aria-selected="${i === vehAcActive}" data-key="${escapeHtml(it.key)}" data-label="${escapeHtml(it.label)}">${img ? `<img class="veh-ac-thumb" src="${escapeHtml(img)}" alt="" loading="lazy">` : ''}<span>${escapeHtml(it.label)}</span></li>`;
  }).join('');
  list.classList.remove('d-none'); input.setAttribute('aria-expanded', 'true');
}
function vehComboOpen(input, useFilter) {
  const matches = useFilter ? vehComboMatches(input) : vehComboSrc(input).src;
  vehAcActive = matches.length ? 0 : -1;
  input._vehMatches = matches;   // per la navigazione da tastiera
  renderVehAc(input, matches);
}
function vehComboClose(input) {
  const list = input.parentElement && input.parentElement.querySelector('.veh-ac');
  if (list) { list.classList.add('d-none'); list.innerHTML = ''; }
  input.setAttribute('aria-expanded', 'false');
  vehAcActive = -1;
}
function pickVehCombo(input, key, label) {
  input.value = label;
  vehComboClose(input);
  if (input.classList.contains('veh-combo-gen')) switchVehGen(key);
  else if (input.classList.contains('veh-combo-cmp')) { vehXf.compare = key; renderVehBody(); fetchVehSpecs(key); }
  else { vehSelUrl = key; renderVehScheda(); fetchVehSpecs(vehSelUrl); }   // renderVehScheda: fa comparire la toolbar (visibile solo con una voce scelta)
}

// ─── Toolbar scheda: trasformazioni NON distruttive (dati grezzi intatti) ─────
// Stato persistente tra i re-render e i cambi di voce. compare = 2a voce da confrontare.
// translate ON di default; highlight = Set di chiavi-campo messe in evidenza dall'utente.
function vehTipo() { return vehData && vehData.source && /ultimatespecs/i.test(vehData.source) ? 'moto' : 'auto'; }
// auto con generazioni → si sceglie prima la generazione. Search-landing (kind:'search', nessuna gen) → dritto ai trim, come la moto.
function vehGenStep() { return vehTipo() === 'auto' && ((vehData && vehData.generations) || []).length > 0; }
// markup combobox scheda (input + caret + lista): condiviso tra sel-row e toolbar confronto
const vehCombo = (cls, val, ph) => `<div class="ac-wrap veh-combo-wrap"><input type="text" class="veh-combo ${cls}" role="combobox" autocomplete="off" aria-autocomplete="list" aria-expanded="false" placeholder="${escapeHtml(ph)}" value="${escapeHtml(val)}"><span class="veh-combo-caret">${icon('chevron')}</span><ul class="ac-list veh-ac d-none" role="listbox"></ul></div>`;
const vehXf = { translate: true, units: {}, q: '', allOpen: null, compare: null, highlight: new Set() };
let vehGenChosen = false;   // auto: le motorizzazioni compaiono solo dopo aver scelto la generazione
let vehShowAll = false;     // griglie: false = filtra per anni cercati, true = mostra tutte

// Dizionario chiavi EN→IT (campi osservati su auto-data.net + ultimatespecs). Non mappato → invariato.
const VEH_TR_KEY = {
  'Engine displacement': 'Cilindrata', 'Number of cylinders': 'Numero di cilindri', 'Cylinder Bore': 'Alesaggio',
  'Piston Stroke': 'Corsa', 'Number of valves per cylinder': 'Valvole per cilindro', 'Fuel injection system': "Sistema d'iniezione",
  'Engine aspiration': 'Aspirazione', 'Valvetrain': 'Distribuzione', 'Powertrain Architecture': 'Architettura powertrain',
  'Acceleration 0 - 100 km/h': 'Accelerazione 0-100 km/h', 'Acceleration 0 - 62 mph': 'Accelerazione 0-62 mph',
  'Maximum speed': 'Velocità massima', 'Weight-to-power ratio': 'Rapporto peso/potenza', 'Weight-to-torque ratio': 'Rapporto peso/coppia',
  'Power': 'Potenza', 'Power per litre': 'Potenza per litro', 'Torque': 'Coppia', 'Power steering': 'Servosterzo',
  'Fuel Type': 'Alimentazione', 'Emission standard': 'Standard emissioni', 'Combined fuel consumption (WLTP)': 'Consumo combinato (WLTP)',
  'CO2 emissions (WLTP)': 'Emissioni CO2 (WLTP)', 'Drive wheel': 'Trazione', 'Number of gears and type of gearbox': 'Cambio (marce e tipo)',
  'Front suspension': 'Sospensione anteriore', 'Rear suspension': 'Sospensione posteriore', 'Front brakes': 'Freni anteriori',
  'Rear brakes': 'Freni posteriori', 'Assisting systems': 'Sistemi di assistenza', 'Steering type': 'Tipo di sterzo',
  'Tires size': 'Misura pneumatici', 'Wheel rims size': 'Misura cerchi', 'Length': 'Lunghezza', 'Width': 'Larghezza',
  'Width including mirrors': 'Larghezza con specchietti', 'Height': 'Altezza', 'Wheelbase': 'Passo',
  'Front track': 'Carreggiata anteriore', 'Rear (Back) track': 'Carreggiata posteriore', 'Minimum turning circle (turning diameter)': 'Diametro di sterzata',
  'Kerb Weight': 'Peso a vuoto', 'Max. weight': 'Peso massimo', 'Trunk (boot) space - minimum': 'Bagagliaio (min)',
  'Trunk (boot) space - maximum': 'Bagagliaio (max)', 'Fuel tank capacity': 'Capacità serbatoio', 'Body type': 'Tipo di carrozzeria',
  'Seats': 'Posti', 'Doors': 'Porte', 'Engine layout': 'Disposizione motore', 'Engine Model/Code': 'Modello/codice motore',
  'Engine configuration': 'Configurazione motore', 'Drivetrain Architecture': 'Architettura trasmissione',
  // moto
  'Category': 'Categoria', 'Factory Warranty (Years / miles)': 'Garanzia', 'Frame type': 'Tipo di telaio',
  'Seat Height': 'Altezza sella', 'Ground Clearance': 'Altezza da terra', 'Trail size': 'Avancorsa', 'Wheels details': 'Cerchi',
  'Front Tyres - Rims dimensions': 'Pneumatico anteriore', 'Rear Tyres - Rims dimensions': 'Pneumatico posteriore',
  'Rear Brakes Dimensions - Disc Dimensions': 'Disco posteriore', 'Curb Weight (including fluids)': 'Peso in ordine di marcia',
  'Fuel Tank Capacity': 'Capacità serbatoio', 'Front Suspension': 'Sospensione anteriore', 'Front Suspension Travel': 'Escursione anteriore',
  'Rear Suspension': 'Sospensione posteriore', 'Rear Suspension Travel': 'Escursione posteriore',
  'Engine type - Number of cylinders': 'Tipo motore / cilindri', 'Fuel system': 'Alimentazione',
  'Engine size - Displacement - Engine capacity': 'Cilindrata', 'Bore x Stroke': 'Alesaggio x corsa',
  'Compression Ratio': 'Rapporto di compressione', 'Camshaft Valvetrain Configuration': 'Distribuzione',
  'Maximum power - Output - Horsepower': 'Potenza massima', 'Maximum torque': 'Coppia massima', 'Cooling system': 'Raffreddamento',
  'Lubrication system': 'Lubrificazione', 'Engine oil capacity': 'Capacità olio motore', 'Exhaust system': 'Scarico',
  'Gearbox': 'Cambio', 'Transmission type, final drive ratio': 'Trasmissione finale', 'Clutch type': 'Frizione',
  'Driveline': 'Trasmissione', 'Fuel Consumption - MPG - Economy - Efficiency': 'Consumo', 'CO2 emissions': 'Emissioni CO2',
  'Emissions': 'Emissioni', 'Ignition Type': 'Accensione', 'Starter Type': 'Avviamento', 'Instruments': 'Strumentazione', 'Lights': 'Fari',
};
const VEH_TR_WORD = [['Petrol', 'Benzina'], ['Gasoline', 'Benzina'], ['Diesel', 'Diesel'], ['Electric', 'Elettrico'], ['Hybrid', 'Ibrido'],
  ['Manual', 'Manuale'], ['Automatic', 'Automatico'], ['Chain', 'Catena'], ['Belt', 'Cinghia'], ['Shaft', 'Cardano'],
  ['Liquid', 'Liquido'], ['four-stroke', 'quattro tempi'], ['Wet sump', 'Coppa umida'], ['Injection', 'Iniezione']];
const VEH_TR_RE = VEH_TR_WORD.map(([en, it]) => [new RegExp('\\b' + en + '\\b', 'gi'), it]);   // precompilate a module-scope
function vehTrKey(k) { return vehXf.translate && VEH_TR_KEY[k] ? VEH_TR_KEY[k] : k; }
function vehTrVal(v) { if (!vehXf.translate) return v; let out = v; for (const [re, it] of VEH_TR_RE) out = out.replace(re, it); return out; }

// Conversione unità per famiglia (dal grezzo). Salta i rapporti (unità seguita da "/").
// NB: la virgola è separatore delle MIGLIAIA sulle fonti ("1,460 mm") → va rimossa, non trattata come decimale.
const vehFmt = n => (isFinite(n) ? String(Math.round(n * 100) / 100) : '');
const VEH_UNITS = [
  { fam: 'len', pat: 'mm', f: { cm: 0.1, m: 0.001 }, lab: { cm: 'cm', m: 'm' } },
  { fam: 'disp', pat: 'cm3|ccm', f: { L: 0.001 }, lab: { L: 'L' } },
  { fam: 'mass', pat: 'kg', f: { t: 0.001 }, lab: { t: 't' } },
  { fam: 'pow', pat: 'Hp|HP|PS|CV', f: { kW: 0.7355 }, lab: { kW: 'kW' } },
  { fam: 'trq', pat: 'Nm', f: { kgm: 0.101972 }, lab: { kgm: 'kgm' } },
];
VEH_UNITS.forEach(u => { u.re = new RegExp('([\\d][\\d.,]*(?:\\s*[-x×]\\s*[\\d][\\d.,]*)?)\\s*(?:' + u.pat + ')\\b(?!\\s*\\/)', 'g'); });   // precompilata
function vehConv(v) {
  let out = v;
  for (const u of VEH_UNITS) {
    const tgt = vehXf.units[u.fam]; if (!tgt || !u.f[tgt]) continue;
    out = out.replace(u.re, (m, nums) => nums.replace(/[\d][\d.,]*/g, n => vehFmt(parseFloat(n.replace(/,/g, '')) * u.f[tgt])) + ' ' + u.lab[tgt]);
  }
  return out;
}
function vehXfRow(r) { return { k: vehTrKey(r.k), v: vehTrVal(vehConv(r.v)) }; }
function vehXfGroups(spec) {
  return spec.groups.map(g => ({ title: g.title, rows: g.rows.map(vehXfRow) })).filter(g => g.rows.length);
}

// Testo/CSV della scheda (post-trasformazioni) per Copia / Esporta.
function vehSchedaText() {
  const spec = vehSpecs[vehSelUrl]; if (!spec || !spec.groups) return '';
  const cur = ((vehData.motorizzazioni || []).find(m => m.url === vehSelUrl) || {}).label || '';
  const out = [`${vehData.title} — ${cur}`];
  for (const g of vehXfGroups(spec)) { out.push('', `## ${g.title}`); for (const r of g.rows) out.push(`- ${r.k}: ${r.v}`); }
  return out.join('\n');
}
function vehSchedaCsv() {
  const spec = vehSpecs[vehSelUrl]; if (!spec || !spec.groups) return '';
  const rows = [['Sezione', 'Campo', 'Valore']];
  for (const g of vehXfGroups(spec)) for (const r of g.rows) rows.push([g.title, r.k, r.v]);
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');   // BOM + CRLF + anti formula-injection (Excel)
}
function vehDownload(name, text, mime) {
  const blob = new Blob([text], { type: mime }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// PDF scheda (riuso jsPDF + autoTable come exportPdf). Righe in evidenza sfondo azzurro.
function vehSchedaPdf() {
  if (!window.jspdf) return;
  const spec = vehSpecs[vehSelUrl]; if (!spec || !spec.groups) return;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const INK = [20, 24, 31], ACCENT = [31, 111, 235], WHITE = [255, 255, 255], HL = [230, 240, 253];
  const cur = ((vehData.motorizzazioni || []).find(m => m.url === vehSelUrl) || {}).label || '';
  doc.setFillColor(...INK); doc.rect(0, 0, pageW, 22, 'F');
  doc.setFillColor(...ACCENT); doc.rect(14, 7, 7, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...WHITE); doc.text('SCHEDA TECNICA', 25, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(170, 185, 210);
  doc.text(`${vehData.title}${cur ? ' · ' + cur : ''}`.slice(0, 95), 25, 17.5);
  const body = [], rawKeys = [];   // rawKeys[i] = chiave grezza della riga i → evidenza per chiave grezza (come a schermo, niente collisioni di traduzione)
  for (const g of spec.groups) for (const r of g.rows) { body.push([g.title, vehTrKey(r.k), vehTrVal(vehConv(r.v))]); rawKeys.push(r.k); }
  doc.autoTable({
    startY: 28, head: [['Sezione', 'Campo', 'Valore']], body, theme: 'plain',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: { top: 2, right: 3, bottom: 2, left: 3 }, valign: 'middle', overflow: 'linebreak' },
    headStyles: { fillColor: INK, textColor: WHITE, fontStyle: 'bold' },
    columnStyles: { 0: { cellWidth: 40, textColor: [91, 100, 114] }, 1: { cellWidth: 58, fontStyle: 'bold' }, 2: { cellWidth: 'auto' } },
    didParseCell: c => { if (c.section === 'body' && vehXf.highlight.has(rawKeys[c.row.index])) c.cell.styles.fillColor = HL; },
  });
  const name = `scheda-${(vehData.marca || '')}-${(vehData.modello || '')}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scheda';
  doc.save(name + '.pdf');
}

// review: i titoli arrivano da siti esterni → anti formula-injection. Un valore che inizia
// con = + - @ (o tab/CR) viene eseguito come formula da Excel/Sheets nonostante le virgolette
// (che sono solo quoting CSV): lo neutralizziamo con un apostrofo iniziale (OWASP).
function csvCell(v) { let s = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; }

// ─── Export CSV ───────────────────────────────────────────────────────────────
function exportCsv(results) {
  const cell = csvCell;
  const cfg = priceCfgV;
  const cols = ['Fonte', 'Titolo', 'Prezzo (€)', 'Anno', 'KM', 'Carburante', 'Provincia', ...priceExtraHeaders(cfg), 'URL'];
  const rows = results.map(r => { const pr = vPricing(r.prezzo); return [r.fonte, r.titolo, pr ? Math.round(pr.finale) : '', r.anno != null ? r.anno : '', r.km != null ? r.km : '', r.carburante || '', r.provincia || '', ...priceExtraValues(pr, cfg), r.url].map(cell).join(','); });
  const csv = [cols.join(','), ...rows].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `automotoradar-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ─── Export PDF ───────────────────────────────────────────────────────────────
// PDF "scheda tecnica": header scuro full-width + criteri + striscia metriche
// inline + tabella pulita con chip-fonte. (Niente Top5/riepilogo — rimossi.)
function exportPdf(results) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const dateFilename = new Date().toISOString().slice(0, 10);
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const INK = [20, 24, 31], ACCENT = [31, 111, 235], SLATE = [91, 100, 114];
  const LINE = [210, 216, 222], WHITE = [255, 255, 255], ZEBRA = [247, 248, 250];
  const fmtEur = n => '€ ' + n.toLocaleString('it-IT');
  const FONTE_LABEL_PDF = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };
  const FONTE_COLORS = { subito: { fill: [231, 240, 253], text: [19, 87, 196] }, autoscout: { fill: [250, 240, 213], text: [138, 97, 0] }, moto: { fill: [225, 243, 232], text: [17, 122, 55] } };

  // ── Header band scura full-width
  doc.setFillColor(...INK); doc.rect(0, 0, pageW, 24, 'F');
  doc.setFillColor(...ACCENT); doc.rect(14, 8, 7, 7, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...WHITE); doc.text('AUTO MOTO RADAR', 25, 13.5);
  const _p = lastSearchParams || {};
  const crit = [
    [_p.marca, _p.modello].filter(Boolean).join(' '),
    _p.regione ? _p.regione.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Tutta Italia',
    (_p.prezzoMin || _p.prezzoMax) ? `prezzo ${_p.prezzoMin || 0}-${_p.prezzoMax || 'max'}` : null,
    (_p.annoMin || _p.annoMax) ? `anni ${_p.annoMin || ''}-${_p.annoMax || ''}` : null,
    (_p.kmMin || _p.kmMax) ? `km ${_p.kmMin || 0}-${_p.kmMax || 'max'}` : null,
  ].filter(Boolean).join('   ·   ');
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(170, 185, 210);
  doc.text((crit + '   ·   ' + today).slice(0, 150), 25, 19);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...WHITE); doc.text(results.length + ' annunci', pageW - 14, 14, { align: 'right' });

  // ── Striscia metriche inline (sui prezzi finali: base + commissione − spese)
  const cfg = priceCfgV;
  const prices = results.map(r => vPricing(r.prezzo)).filter(p => p && p.finale > 0).map(p => p.finale).sort((a, b) => a - b);
  const mid = prices.length / 2;
  const metrics = [
    ['MIN', prices.length ? fmtEur(prices[0]) : '—'],
    ['MEDIANA', prices.length ? fmtEur(prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[Math.floor(mid)]) : '—'],
    ['MEDIA', prices.length ? fmtEur(Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)) : '—'],
    ['MAX', prices.length ? fmtEur(prices[prices.length - 1]) : '—'],
    ['CON PREZZO', `${prices.length}/${results.length}`],
  ];
  const stripY = 31, colW = (pageW - 28) / metrics.length;
  metrics.forEach(([label, val], i) => {
    const x = 14 + i * colW;
    if (i > 0) { doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(x, stripY - 1, x, stripY + 7); }
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...SLATE); doc.text(label, x + 4, stripY + 1.5);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(...INK); doc.text(String(val), x + 4, stripY + 7);
  });

  // ── Nota adjustment + tabella pulita + chip fonte
  const extraH = priceExtraHeaders(cfg);
  const tableBody = results.map(r => { const pr = vPricing(r.prezzo); return [FONTE_LABEL_PDF[r.fonte] || r.fonte, r.titolo, pr ? fmtEur(Math.round(pr.finale)) : '—', r.anno != null ? String(r.anno) : '—', r.km != null ? r.km.toLocaleString('it-IT') + ' km' : '—', r.carburante || '—', r.provincia || '—', ...priceExtraValues(pr, cfg).map(x => x === '' ? '—' : fmtEur(x))]; });
  if (priceAdjActive(cfg)) {
    const bits = [];
    if (cfg.comm) bits.push(`Commissione +${cfg.comm}${cfg.commUnit === 'pct' ? '%' : ' €'}`);
    if (cfg.spese) bits.push(`Spese −${cfg.spese} €`);
    if (cfg.margine) bits.push(`Margine ${cfg.margine}%`);
    if (cfg.iva) bits.push('IVA 22% scorporata');
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(...SLATE);
    doc.text('Prezzi finali · ' + bits.join(' · '), 14, stripY + 11);
  }
  doc.autoTable({
    startY: stripY + (priceAdjActive(cfg) ? 15 : 12),
    head: [['Fonte', 'Veicolo', 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia', ...extraH]],
    body: tableBody,
    theme: 'plain',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: { top: 2.6, right: 3, bottom: 2.6, left: 3 }, valign: 'middle', overflow: 'ellipsize' },
    headStyles: { fillColor: INK, textColor: WHITE, fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: ZEBRA },
    columnStyles: Object.assign({ 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { halign: 'right', cellWidth: 26, fontStyle: 'bold', textColor: ACCENT }, 3: { halign: 'center', cellWidth: 14 }, 4: { halign: 'right', cellWidth: 24 }, 5: { halign: 'center', cellWidth: 24 }, 6: { halign: 'center', cellWidth: 24 } }, ...extraH.map((_, i) => ({ [7 + i]: { halign: 'right', cellWidth: 22 } }))),
    didParseCell(data) { if (data.section === 'body' && data.column.index === 0) data.cell.text = [' ']; },   // chip disegnato a mano
    didDrawCell(data) {
      if (data.section !== 'body' || data.column.index !== 0) return;
      const fonte = results[data.row.index]?.fonte; const colors = FONTE_COLORS[fonte]; if (!colors) return;
      const cw = data.cell.width - 4, ch = 5, cx = data.cell.x + 2, cy = data.cell.y + (data.cell.height - ch) / 2;
      doc.setFillColor(...colors.fill); doc.roundedRect(cx, cy, cw, ch, 1, 1, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(...colors.text);
      doc.text(FONTE_LABEL_PDF[fonte] || fonte, cx + cw / 2, cy + ch / 2 + 0.3, { align: 'center', baseline: 'middle' });
    },
    margin: { left: 14, right: 14 },
  });

  // ── Footer per pagina
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(14, pageH - 10, pageW - 14, pageH - 10);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...SLATE);
    doc.text('Auto Moto Radar — uso personale', 14, pageH - 5.5);
    doc.text(`Pagina ${i} di ${pageCount}`, pageW - 14, pageH - 5.5, { align: 'right' });
  }
  doc.save(`automotoradar-${dateFilename}.pdf`);
}

// ─── Pre-fill da URL params ───────────────────────────────────────────────────
async function applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has('marca')) return;
  const tipo = p.get('tipo') || 'auto';
  const tipoInput = document.querySelector(`input[name="tipo"][value="${tipo}"]`);
  if (tipoInput) { tipoInput.checked = true; document.body.dataset.tipo = tipo; }
  await populateMarca(tipo);   // brand cache del tipo (serve al force-select per il replay)
  const marca = p.get('marca') || '';
  if (marca) marcaSelect.value = marca;
  ['prezzoMin', 'prezzoMax', 'annoMin', 'annoMax', 'kmMin', 'kmMax'].forEach(k => { if (p.has(k)) document.getElementById(k).value = p.get(k); });
  const modello = p.get('modello') || '';
  if (marca) {
    if (modello) document.getElementById('modello').value = modello;
    if (p.has('regione')) regioneSelect.value = p.get('regione');
    validateMarca();
    // Replay programmatico: bypassa il force-select se la marca combacia col catalogo.
    if (isValidMarca()) doSearch();
  }
}

// ─── Avvio ────────────────────────────────────────────────────────────────────
init();
