// ─── Elementi DOM ─────────────────────────────────────────────────────────────
const form               = document.getElementById('searchForm');
const statusBox          = document.getElementById('statusBox');
const loadingState       = document.getElementById('loadingState');
const errorState         = document.getElementById('errorState');
const errorText          = document.getElementById('errorText');
const errorClose         = document.getElementById('errorClose');
const resultsSection     = document.getElementById('resultsSection');
const resultsGrid        = document.getElementById('resultsGrid');
const resultsCount       = document.getElementById('resultsCount');
const fonteBreakdown     = document.getElementById('fonteBreakdown');
const noResults          = document.getElementById('noResults');
const sortSelect         = document.getElementById('sortSelect');
const groupSelect        = document.getElementById('groupSelect');
const marcaSelect        = document.getElementById('marca');
const regioneSelect      = document.getElementById('regione');
const tipoInputs         = document.querySelectorAll('input[name="tipo"]');
const groupChips         = document.getElementById('groupChips');
const backToSearch       = document.getElementById('backToSearch');
const resultsNav         = document.getElementById('resultsNav');
const isolaRow           = document.getElementById('isolaRow');
const isolaToggle        = document.getElementById('isolaToggle');
const isolaCount         = document.getElementById('isolaCount');
const chipsAllNone       = document.getElementById('chipsAllNone');
const advancedToggle     = document.getElementById('advancedToggle');
const advancedFilters    = document.getElementById('advancedFilters');
const logoBtn            = document.getElementById('logoBtn');
const qrPanel            = document.getElementById('qrPanel');
const prezzoSliderEl     = document.getElementById('prezzoSlider');
const btnStatCsv         = document.getElementById('btnStatCsv');
const btnStatPdf         = document.getElementById('btnStatPdf');
const subitoBanner       = document.getElementById('subitoBootstrapBanner');
const btnBootstrap       = document.getElementById('btnBootstrapSubito');
const bootstrapBtnText   = document.getElementById('bootstrapBtnText');
const bootstrapBtnSpinner = document.getElementById('bootstrapBtnSpinner');

// ─── Stato ────────────────────────────────────────────────────────────────────
let currentResults       = [];
let confronto            = [];   // max 2 result objects per il confronto
let salvati              = [];   // annunci salvati nella sessione corrente
let hiddenGroups         = new Set();   // chiavi-gruppo nascoste via chip (group-by attivo)
let lastGroupKeys        = [];          // chiavi gruppo dell'ultima resa (per Tutte/Nessuna)
let isolaOpen            = false;       // pannello Isola aperto/chiuso (dropdown)
let lastSources          = null;        // stato per-fonte dall'ultima ricerca
let prezzoSliderInstance = null;
let lastSearchParams     = null;        // §11: params dell'ultima ricerca (per "Salva ricerca")
let savedSearches        = [];          // §11: ricerche salvate (da /api/saved)
let sliderGlobalBounds   = [0, 0];

// Cache brand list dal server per tipo corrente (con metadata sites)
const brandCache = { auto: null, moto: null };

const FONTE_LABEL = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };

// ─── Icone Lucide (SVG inline, dependency-free / offline) ───────────────────
const ICONS = {
  bookmark:          '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  'bookmark-filled': '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" fill="currentColor"/>',
  compare:           '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M11 18H8a2 2 0 0 1-2-2V9"/>',
  chevron:           '<path d="m6 9 6 6 6-6"/>',
  x:                 '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};
function icon(name, cls = '') {
  return `<svg class="ico ${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}


// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const currentYear = new Date().getFullYear();
  document.getElementById('annoMin').max = currentYear;
  document.getElementById('annoMax').max = currentYear;
  document.getElementById('annoMax').placeholder = `es. ${currentYear}`;

  populateRegione();
  await populateMarca('auto');
  setupMarcaAutocomplete();
  applyUrlParams();

  // Cambio tipo (auto/moto): ricarica marche
  tipoInputs.forEach(input => input.addEventListener('change', async () => {
    await populateMarca(input.value);
    currentResults = [];
    hideResults();
    // Reset modello quando cambia tipo
    document.getElementById('modello').value = '';
  }));

  // Chip di gruppo: isolano/nascondono un gruppo (solo con group-by attivo)
  if (groupChips) groupChips.addEventListener('click', e => {
    const btn = e.target.closest('.grp-chip');
    if (!btn) return;
    const key = btn.dataset.group;
    if (hiddenGroups.has(key)) hiddenGroups.delete(key);
    else                       hiddenGroups.add(key);
    renderResults(currentResults);
  });

  sortSelect.addEventListener('change', () => renderResults(currentResults));
  if (groupSelect) groupSelect.addEventListener('change', () => {
    hiddenGroups.clear();                 // reset isolamento al cambio dimensione
    isolaOpen = false;                    // pannello Isola collassato di default
    renderResults(currentResults);
  });

  btnStatCsv.addEventListener('click', () => exportCsv(currentResults));
  btnStatPdf.addEventListener('click', () => exportPdf(currentResults));
  errorClose.addEventListener('click', hideError);
  backToSearch.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  form.addEventListener('submit', async (e) => { e.preventDefault(); await doSearch(); });

  // ── §11 Ricerche salvate + avvisi ────────────────────────────────────────
  document.getElementById('btnSalvaRicerca').addEventListener('click', saveCurrentSearch);
  document.getElementById('btnControllaTutte').addEventListener('click', () => checkRicerche());
  document.getElementById('ricercheList').addEventListener('click', onRicercheClick);
  loadSavedSearches();
  loadSalvati();   // §18: ripristina i salvati da localStorage

  // ── Event delegation: card risultati ─────────────────────────────────────
  resultsGrid.addEventListener('click', e => {
    // Collasso/espansione sezione gruppo
    const groupHeader = e.target.closest('.group-header');
    if (groupHeader) {
      const section = groupHeader.closest('.result-group');
      section?.classList.toggle('collapsed');
      return;
    }

    const card = e.target.closest('[data-url]');
    if (!card) return;
    const url = card.dataset.url;
    if (e.target.closest('.btn-salva'))     { toggleSalva(url);     return; }
    if (e.target.closest('.btn-confronta')) { toggleConfronto(url); return; }
    // Apri/chiudi il pannello dettagli senza aprire l'annuncio
    if (e.target.closest('.dettagli-toggle')) {
      const detail = card.querySelector('.row-detail');
      const toggle = card.querySelector('.dettagli-toggle');
      const open   = detail.classList.toggle('d-none');
      toggle.setAttribute('aria-expanded', String(!open));
      if (!open) loadSpec(card);   // appena aperto → carica i dettagli (lazy, una sola volta)
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  // ── Event delegation: pannello salvati ───────────────────────────────────
  document.getElementById('salvatiList').addEventListener('click', e => {
    const item = e.target.closest('[data-url]');
    if (!item) return;
    const url = item.dataset.url;
    if (e.target.closest('.btn-rimuovi-salvato'))   { toggleSalva(url);     return; }
    if (e.target.closest('.btn-confronta-salvato')) { toggleConfronto(url); return; }
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  // ── Event delegation: min/max cliccabili nelle stats (navbar) ────────────
  resultsNav.addEventListener('click', e => {
    const btn = e.target.closest('.stat-clickable');
    if (btn) scrollToCard(btn.dataset.url);
  });

  // ── Chip Isola: Tutte / Nessuna ──────────────────────────────────────────
  if (chipsAllNone) chipsAllNone.addEventListener('click', () => {
    if (hiddenGroups.size >= lastGroupKeys.length && lastGroupKeys.length) {
      hiddenGroups.clear();                       // erano tutte nascoste → mostra tutte
    } else {
      hiddenGroups = new Set(lastGroupKeys);      // nascondi tutte
    }
    renderResults(currentResults);
  });

  // ── Isola: dropdown apri/chiudi ──────────────────────────────────────────
  if (isolaToggle) isolaToggle.addEventListener('click', () => {
    isolaOpen = !isolaOpen;
    isolaToggle.setAttribute('aria-expanded', String(isolaOpen));
    isolaRow.classList.toggle('d-none', !isolaOpen);
  });

  // ── Filtri avanzati (hero): apri/chiudi ──────────────────────────────────
  if (advancedToggle) advancedToggle.addEventListener('click', () => {
    const open = advancedFilters.classList.toggle('d-none');
    advancedToggle.setAttribute('aria-expanded', String(!open));
    advancedToggle.classList.toggle('open', !open);
  });

  // ── Logo cliccabile: QR + link pubblico per aprire l'app dal telefono ────
  if (logoBtn) logoBtn.addEventListener('click', async () => {
    const open = qrPanel.classList.toggle('d-none');
    logoBtn.setAttribute('aria-expanded', String(!open));
    if (!open) await loadQrPanel();   // appena aperto → carica QR + link
  });

  // Stato iniziale salvati (lista vuota)
  renderSalvati();
}

// Carica il QR + link pubblico (per aprire l'app dal telefono, ovunque).
async function loadQrPanel() {
  qrPanel.innerHTML = '<p class="qr-empty">Caricamento…</p>';
  try {
    const r = await fetch('/api/public-url');
    const { url, svg } = await r.json();
    if (!url) {
      qrPanel.innerHTML = '<p class="qr-empty">Accesso pubblico non attivo (Funnel spento).</p>';
      return;
    }
    qrPanel.innerHTML =
      '<p class="qr-hint">Inquadra col telefono per aprire l\'app (serve la password):</p>' +
      `<div class="qr-img">${svg}</div>` +
      `<a class="qr-link" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  } catch (_) {
    qrPanel.innerHTML = '<p class="qr-empty">Impossibile leggere l\'indirizzo.</p>';
  }
}

function populateRegione() {
  const regioni = [
    'abruzzo','basilicata','calabria','campania','emilia-romagna',
    'friuli-venezia-giulia','lazio','liguria','lombardia','marche',
    'molise','piemonte','puglia','sardegna','sicilia','toscana',
    'trentino-alto-adige','umbria','valle-d-aosta','veneto',
  ];
  regioneSelect.innerHTML = '<option value="">Tutta Italia</option>';
  regioni.forEach(slug => {
    const opt = document.createElement('option');
    opt.value = slug;
    opt.textContent = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    regioneSelect.appendChild(opt);
  });
}


// ─── Marca: input testuale + autocomplete via <datalist> (P10) ──────────────
// Il dropdown rigido è stato rimosso: l'utente può digitare qualsiasi marca,
// l'autocomplete dal catalogo `data/models.json` è solo un suggerimento soft.
async function populateMarca(tipo) {
  // Carica le marche del tipo nella cache (consumata dall'autocomplete custom).
  if (!brandCache[tipo]) {
    try {
      const res  = await fetch(`/api/brands?tipo=${encodeURIComponent(tipo)}`);
      const data = await res.json();
      brandCache[tipo] = data.brands || [];
    } catch {
      brandCache[tipo] = [];
    }
  }
}

// ─── Autocomplete marca CUSTOM (sostituisce il <datalist> nativo) ───────────
// Stilabile (chiaro, selezione visibile) + Tab/Enter completano, ↑/↓ navigano.
function currentTipo() {
  return document.querySelector('input[name="tipo"]:checked')?.value || 'auto';
}
function setupMarcaAutocomplete() {
  const list = document.getElementById('marcaAC');
  if (!marcaSelect || !list) return;
  const acn = s => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  let matches = [], active = -1;

  const close = () => { list.classList.add('d-none'); list.innerHTML = ''; active = -1; marcaSelect.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    if (!matches.length) return close();
    list.innerHTML = matches.map((b, i) =>
      `<li class="ac-item${i === active ? ' active' : ''}" role="option" data-i="${i}">${escapeHtml(b.nome)}</li>`).join('');
    list.classList.remove('d-none');
    marcaSelect.setAttribute('aria-expanded', 'true');
  };
  const pick = i => { if (matches[i]) { marcaSelect.value = matches[i].nome; close(); document.getElementById('modello')?.focus(); } };

  marcaSelect.addEventListener('input', () => {
    const q = acn(marcaSelect.value);
    const brands = brandCache[currentTipo()] || [];
    matches = q ? brands.filter(b => acn(b.nome).includes(q)).slice(0, 8) : [];
    active = matches.length ? 0 : -1;
    render();
  });
  marcaSelect.addEventListener('keydown', e => {
    if (list.classList.contains('d-none') || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
    else if (e.key === 'Tab') { if (active >= 0) { e.preventDefault(); pick(active); } }   // Tab completa
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('.ac-item'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  marcaSelect.addEventListener('blur', () => setTimeout(close, 120));
}

// Modello è ora un input testuale libero (#modello). Niente più TomSelect.

// ─── Motore di analisi: rating 0-100 + evidenziazioni ───────────────────────
// Tutto calcolato client-side sul set di risultati, una sola volta dopo la
// ricerca. I comparabili di ogni annuncio sono gli altri annunci dello stesso
// CLUSTER-MODELLO (non l'intero set): così confrontiamo prezzi tra mezzi simili
// e lo stesso annuncio mantiene sempre lo stesso punteggio a prescindere dalla
// vista (ordinamento/raggruppamento/filtro fonti agiscono solo sulla resa).

// §21: rating rimosso (vedi RATING-DESIGN.md). Resta `clusterModello` per il
// group-by "Modello/variante" — funzione pura (era in frontend/analysis.js).
function clusterModello(titolo) {
  if (!titolo) return '?';
  const norm = String(titolo).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const tokens = norm.match(/[a-z0-9]+/g) || [];
  if (!tokens.length) return '?';
  const marca   = tokens.find(t => /[a-z]/.test(t)) || tokens[0];
  const modello = tokens.find(t => /\d/.test(t))
               || tokens.filter(t => t !== marca)[0]
               || '';
  return (marca + (modello ? ' ' + modello : '')).trim();
}

// ─── Raggruppamento (GROUP BY) ──────────────────────────────────────────────
function bucketKm(km) {
  if (km == null)   return 'Km non indicati';
  if (km < 50000)   return '< 50.000 km';
  if (km < 100000)  return '50.000 – 100.000 km';
  if (km < 150000)  return '100.000 – 150.000 km';
  if (km < 200000)  return '150.000 – 200.000 km';
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

// Raggruppa results → [{ key, items, minPrezzo }] ordinato per prezzo minimo asc.
function groupResults(results, dim) {
  const keyFn = groupKeyFn(dim);
  if (!keyFn) return null;
  const map = new Map();
  for (const r of results) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const groups = [...map.entries()].map(([key, items]) => {
    const prezzi = items.map(i => i.prezzo).filter(p => p != null && p > 0);
    return { key, items, minPrezzo: prezzi.length ? Math.min(...prezzi) : null };
  });
  groups.sort((a, b) => (a.minPrezzo ?? Infinity) - (b.minPrezzo ?? Infinity));
  return groups;
}


// ─── Ricerca ──────────────────────────────────────────────────────────────────
async function doSearch() {
  const tipo  = document.querySelector('input[name="tipo"]:checked').value;
  const marca = marcaSelect.value.trim();

  if (!marca) { showError('Inserisci una marca prima di cercare.'); return; }

  // P10: marca da input testuale (con autocomplete soft), modello completamente
  // libero. Il server risolve mmmvAutoscout/motoitBrandSlug dal catalogo se
  // disponibili — altrimenti fallback brand-only + post-filter (P6).
  const modelloLibero = document.getElementById('modello').value.trim();

  const params = {
    tipo, marca,
    modello:   modelloLibero,
    prezzoMin: document.getElementById('prezzoMin').value,
    prezzoMax: document.getElementById('prezzoMax').value,
    annoMin:   document.getElementById('annoMin').value,
    annoMax:   document.getElementById('annoMax').value,
    kmMax:     document.getElementById('kmMax').value,
  };

  if (regioneSelect.value) params.regione = regioneSelect.value;

  Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
  lastSearchParams = { ...params };   // §11: memorizza per "Salva ricerca"

  confronto = [];
  document.body.classList.add('has-results');   // hero va in alto (non più centrata)

  showLoading();
  hideResults();

  try {
    const res  = await fetch(`/api/search?${new URLSearchParams(params)}`);
    const data = await res.json();

    if (!res.ok) { showError(data.error || 'Errore durante la ricerca.'); return; }

    // §21: niente più rating — si usano i risultati grezzi.
    currentResults = data.risultati || [];
    lastSources    = data.sources || null;   // stato per-fonte (ok/empty/skipped/timeout/error)
    renderSourceStatus();

    // Subito bloccato da DataDome → mostra banner + aggiorna pillola
    if (data.subitoStatus === 'needs_bootstrap') showBootstrapBanner();
    else                                          hideBootstrapBanner();
    // La response può aver cambiato lo state lato server (es. sbloccato dopo refresh)
    fetchSubitoStatus();

    initPrezzoSlider(currentResults);

    if (!prezzoSliderInstance) renderResults(currentResults);

    if (currentResults.length > 0) {
      resultsNav.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

  } catch {
    showError('Impossibile contattare il server. Assicurati che sia avviato con "npm start".');
  } finally {
    hideLoading();
  }
}

// ─── Subito session bootstrap (UI) ───────────────────────────────────────────
function showBootstrapBanner() {
  statusBox.classList.remove('d-none');
  subitoBanner.classList.remove('d-none');
  subitoBanner.classList.add('d-flex');
}
function hideBootstrapBanner() {
  subitoBanner.classList.add('d-none');
  subitoBanner.classList.remove('d-flex');
}

async function runSubitoBootstrap() {
  bootstrapBtnText.textContent = 'Apertura finestra…';
  bootstrapBtnSpinner.classList.remove('d-none');
  btnBootstrap.disabled = true;

  try {
    const res  = await fetch('/api/subito/bootstrap', { method: 'POST' });
    const data = await res.json();

    if (data.ok) {
      hideBootstrapBanner();
      showError(''); // clear
      fetchSubitoStatus();
      const note = document.createElement('div');
      note.className = 'alert alert-success';
      const hours = data.expiresInHours ? ` (valida ~${data.expiresInHours} ore)` : '';
      note.textContent = `Sessione Subito aggiornata${hours}. Puoi rilanciare la ricerca.`;
      statusBox.appendChild(note);
      setTimeout(() => note.remove(), 6000);
    } else {
      // Messaggio dettagliato per aiutare l'utente a capire cosa fare.
      const reasonMap = {
        window_closed:        'Hai chiuso la finestra Chrome prima del completamento.',
        timeout:              'Tempo scaduto (5 minuti): il CAPTCHA non è stato completato.',
        chrome_launch_failed: 'Impossibile aprire Chrome. Riprova o contatta lo sviluppatore.',
        error:                'Errore tecnico durante il bootstrap.',
      };
      const reasonText = reasonMap[data.reason] || `Errore: ${data.reason || 'sconosciuto'}`;
      const hint       = data.hint ? ` ${data.hint}` : '';
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

// ─── Stato Subito → solo banner quando serve ────────────────────────────────
// Niente più pillola persistente: lo stato viene controllato (avvio, dopo ogni
// ricerca, ogni 60s) e mostra il banner bootstrap solo se la sessione è
// bloccata / mai configurata.
async function fetchSubitoStatus() {
  try {
    const res  = await fetch('/api/subito/status');
    const data = await res.json();
    if (data.health === 'blocked' || data.health === 'never_configured') showBootstrapBanner();
    else                                                                  hideBootstrapBanner();
    return data;
  } catch (_) {
    return null;
  }
}

const SUBITO_POLL_INTERVAL = 60 * 1000;
fetchSubitoStatus();
setInterval(fetchSubitoStatus, SUBITO_POLL_INTERVAL);

// ─── Slider prezzo ────────────────────────────────────────────────────────────
function initPrezzoSlider(results) {
  if (prezzoSliderInstance) {
    try { prezzoSliderInstance.destroy(); } catch (_) {}
    prezzoSliderInstance = null;
  }
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
    start:   [minP, maxP],
    connect: true,
    range:   { min: minP, max: maxP },
    step:    100,
    format:  { to: v => Math.round(v), from: v => Number(v) },
  });

  prezzoSliderInstance.on('update', ([sMin, sMax]) => {
    document.getElementById('sliderLabelMin').textContent = `€ ${Number(sMin).toLocaleString('it-IT')}`;
    document.getElementById('sliderLabelMax').textContent = `€ ${Number(sMax).toLocaleString('it-IT')}`;
    renderResults(currentResults);
  });
}


// ─── Rendering risultati ──────────────────────────────────────────────────────
function renderResults(results) {
  let filtered = results.slice();

  if (prezzoSliderInstance) {
    const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
    filtered = filtered.filter(r => r.prezzo == null || (r.prezzo >= sMin && r.prezzo <= sMax));
  }

  const sorted = sortResults([...filtered], sortSelect.value);

  // Raggruppamento + chip di isolamento (solo con group-by attivo)
  const dim = groupSelect ? groupSelect.value : '';
  let groups = null, visible = sorted;
  if (dim) {
    groups  = groupResults(sorted, dim);
    const keyOf = groupKeyFn(dim);
    visible = sorted.filter(r => !hiddenGroups.has(keyOf(r)));
  }
  renderGroupChips(dim, groups);

  resultsNav.classList.remove('d-none');   // navbar comandi visibile finché ci sono risultati
  updateStats(visible);

  if (visible.length === 0) {
    noResults.classList.remove('d-none');
    resultsSection.classList.add('d-none');
    fonteBreakdown.textContent = '';
    return;
  }

  noResults.classList.add('d-none');
  resultsSection.classList.remove('d-none');

  resultsCount.textContent = `${visible.length} risultati`;

  if (dim) {
    const shown = groups.filter(g => !hiddenGroups.has(g.key));
    resultsGrid.innerHTML = shown.map(g => groupHTML(g, dim)).join('');
  } else {
    resultsGrid.innerHTML = `<div class="result-list">${visible.map(r => rowHTML(r, dim)).join('')}</div>`;
  }
}

// Stato per-fonte: dice all'utente cosa è successo per ogni sito
// (ok+conteggio / nessun risultato / saltato+motivo / timeout / errore).
const SOURCE_STATUS = {
  ok:              { cls: 'src-ok' },
  empty:           { cls: 'src-muted', txt: 'nessun risultato' },
  skipped:         { cls: 'src-muted' },                              // usa reason
  timeout:         { cls: 'src-bad',   txt: 'timeout' },
  error:           { cls: 'src-bad',   txt: 'errore' },
  needs_bootstrap: { cls: 'src-warn',  txt: 'verifica richiesta' },
};
const SKIP_REASON_TXT = {
  'solo moto':             'solo moto',
  'marca non su Moto.it':  'non disponibile',
  'marca non su Autoscout':'non disponibile',
};
function renderSourceStatus() {
  if (!fonteBreakdown) return;
  if (!lastSources) { fonteBreakdown.innerHTML = ''; return; }
  const order = ['subito', 'autoscout', 'moto'];
  fonteBreakdown.innerHTML = order.map(f => {
    const s = lastSources[f];
    if (!s) return '';
    const meta = SOURCE_STATUS[s.status] || { cls: 'src-muted' };
    let txt;
    if (s.status === 'ok')           txt = `${s.count}`;
    else if (s.status === 'skipped') txt = SKIP_REASON_TXT[s.reason] || s.reason || 'saltato';
    else                             txt = meta.txt || s.status;
    const dim = s.status === 'ok' ? '' : ' src-dim';
    return `<span class="src ${meta.cls}${dim}">${FONTE_LABEL[f]} <b>${txt}</b></span>`;
  }).join('');
}

// Isola (navbar, dropdown): toggle "Isola (n)" + pannello chip + Tutte/Nessuna.
function renderGroupChips(dim, groups) {
  if (!groupChips || !isolaRow || !isolaToggle) return;

  // Nessun group-by → nascondi toggle e pannello
  if (!dim || !groups || !groups.length) {
    groupChips.innerHTML = '';
    isolaRow.classList.add('d-none');
    isolaToggle.classList.add('d-none');
    isolaOpen = false;
    isolaToggle.setAttribute('aria-expanded', 'false');
    lastGroupKeys = [];
    return;
  }

  lastGroupKeys = groups.map(g => g.key);

  // Toggle visibile; conteggio = gruppi attualmente nascosti (es. "2 nascosti")
  isolaToggle.classList.remove('d-none');
  const nHidden = groups.filter(g => hiddenGroups.has(g.key)).length;
  if (isolaCount) isolaCount.textContent = nHidden ? `(${nHidden} nascosti)` : `(${groups.length})`;

  // Pannello: visibile solo se aperto
  isolaRow.classList.toggle('d-none', !isolaOpen);
  isolaToggle.setAttribute('aria-expanded', String(isolaOpen));

  groupChips.innerHTML = groups.map(g => {
    const active = !hiddenGroups.has(g.key);
    return `<button type="button" class="grp-chip${active ? ' active' : ''}" data-group="${escapeHtml(String(g.key))}">${escapeHtml(String(g.key))} <span class="grp-chip-n">${g.items.length}</span></button>`;
  }).join('');

  if (chipsAllNone) {
    const allHidden = hiddenGroups.size >= lastGroupKeys.length;
    chipsAllNone.textContent = allHidden ? 'Tutte' : 'Nessuna';
  }
}

// Sezione gruppo collassabile: header (etichetta + conteggio + prezzo min) + lista.
function groupHTML(g, dim) {
  const fmt  = n => n != null ? `€ ${n.toLocaleString('it-IT')}` : '—';
  const rows = `<div class="result-list">${g.items.map(r => rowHTML(r, dim)).join('')}</div>`;
  return `
    <div class="result-group">
      <button type="button" class="group-header" aria-expanded="true">
        <span class="group-caret">${icon('chevron')}</span>
        <span class="group-title">${escapeHtml(String(g.key))}</span>
        <span class="group-meta">${g.items.length} annunci${g.minPrezzo != null ? ` · da ${fmt(g.minPrezzo)}` : ''}</span>
      </button>
      <div class="group-body">${rows}</div>
    </div>
  `;
}

// ─── Statistiche ──────────────────────────────────────────────────────────────
function updateStats(results) {
  const prices = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const fmt    = n => `€ ${n.toLocaleString('it-IT')}`;

  if (prices.length === 0) {
    document.getElementById('statMin').innerHTML = '—';
    document.getElementById('statMax').innerHTML = '—';
    return;
  }

  const min = prices[0];
  const max = prices[prices.length - 1];

  // Min/Max cliccabili → scroll alla card corrispondente
  const minResult = results.find(r => r.prezzo === min);
  const maxResult = results.find(r => r.prezzo === max);

  const makeClickable = (val, result) =>
    result
      ? `<button class="stat-clickable" data-url="${escapeHtml(result.url)}">${fmt(val)}</button>`
      : fmt(val);

  document.getElementById('statMin').innerHTML = makeClickable(min, minResult);
  document.getElementById('statMax').innerHTML = makeClickable(max, maxResult);
}

// ─── Scroll & highlight card ──────────────────────────────────────────────────
function scrollToCard(url) {
  const card = resultsGrid.querySelector(`[data-url="${CSS.escape(url)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('highlight-card');
  void card.offsetWidth; // force reflow per riavviare l'animazione
  card.classList.add('highlight-card');
  setTimeout(() => card.classList.remove('highlight-card'), 2000);
}

// ─── Ordinamento ──────────────────────────────────────────────────────────────
function sortResults(results, criteria) {
  switch (criteria) {
    case 'prezzo_asc':  return results.sort((a, b) => (a.prezzo ?? Infinity)  - (b.prezzo ?? Infinity));
    case 'prezzo_desc': return results.sort((a, b) => (b.prezzo ?? -Infinity) - (a.prezzo ?? -Infinity));
    case 'anno_desc':   return results.sort((a, b) => (b.anno   ?? 0)         - (a.anno   ?? 0));
    case 'km_asc':      return results.sort((a, b) => (a.km     ?? Infinity)  - (b.km     ?? Infinity));
    default:            return results;
  }
}

// ─── Card HTML ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// §22 — Pannello "Dettagli" on-click. Campi strutturati AS24 (cambio/cilindrata/
// versione) sono già sull'item → render ISTANTANEO; per Subito/Moto.it fetch lazy
// /api/detail (§15). `data-loaded` evita refetch.
const SPEC_LABELS = {
  variante: 'Versione', cambio: 'Cambio', cilindrata: 'Cilindrata',
  potenzaCv: 'Potenza', proprietari: 'Proprietari', allestimento: 'Allestimento', revisione: 'Revisione',
};
function renderSpec(obj) {
  const fmt = (k, v) => {
    if (v == null || v === '') return '';
    const val = k === 'potenzaCv' ? `${v} CV` : k === 'cilindrata' ? `${v} cc` : escapeHtml(String(v));
    return `<span class="spec-item"><span class="spec-k">${SPEC_LABELS[k]}</span> ${val}</span>`;
  };
  const items = Object.keys(SPEC_LABELS).map(k => fmt(k, obj[k])).filter(Boolean);
  return items.length ? items.join('') : '<span class="spec-empty">Nessun dettaglio aggiuntivo</span>';
}
async function loadSpec(card) {
  const box = card.querySelector('.row-spec');
  if (!box || box.dataset.loaded === '1') return;
  const item = trovaResult(card.dataset.url) || {};
  // Campi strutturati già presenti (AS24) → render immediato, niente fetch.
  if (['variante', 'cambio', 'cilindrata'].some(k => item[k] != null && item[k] !== '')) {
    box.dataset.loaded = '1';
    box.innerHTML = renderSpec(item);
    return;
  }
  // Altrimenti (Subito/Moto.it) → fetch lazy del dettaglio.
  box.dataset.loaded = '1';
  const url = card.dataset.url;
  if (!url || !/^https?:/.test(url)) { box.innerHTML = ''; return; }
  box.innerHTML = '<span class="spec-loading">Carico dettagli…</span>';
  try {
    const r = await fetch(`/api/detail?url=${encodeURIComponent(url)}`);
    const j = await r.json();
    box.innerHTML = (j.ok && j.detail) ? renderSpec(j.detail)
      : '<span class="spec-empty">Dettagli non disponibili</span>';
  } catch (_) {
    box.dataset.loaded = '0';   // errore di rete → retry alla prossima apertura
    box.innerHTML = '<span class="spec-empty">Dettagli non disponibili</span>';
  }
}

// Riga risultato (lista densa, §21: niente rating). Riga pulita: titolo · dati ·
// prezzo + toggle "Dettagli" on-click.
function rowHTML(item, dim = '') {
  const prezzoStr = item.prezzo != null ? `€ ${item.prezzo.toLocaleString('it-IT')}` : 'n/d';

  const dettagli = [
    item.anno       ? `${item.anno}`                           : null,
    item.km != null ? `${item.km.toLocaleString('it-IT')} km`  : null,
    item.carburante || null,
    item.provincia  || null,
  ].filter(Boolean).join(' · ');

  const fonteLabel  = FONTE_LABEL[item.fonte] || item.fonte;
  const fonteClass  = { subito: 'fonte-subito', autoscout: 'fonte-autoscout', moto: 'fonte-moto' }[item.fonte] || '';
  const urlSafe     = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
  const isSalvato   = salvati.some(r => r.url === item.url);
  const inConfronto = confronto.some(r => r.url === item.url);

  return `
    <div class="result-row" data-url="${urlSafe}">
      <div class="row-main">
        <div class="row-titolo">${escapeHtml(item.titolo)}</div>
        <div class="row-dett">${dettagli ? escapeHtml(dettagli) + ' · ' : ''}<span class="fonte ${fonteClass}">${escapeHtml(fonteLabel)}</span></div>
      </div>
      <div class="row-right">
        <div class="row-prezzo">${prezzoStr}</div>
        <div class="row-actions">
          <button type="button" class="dettagli-toggle" aria-expanded="false" title="Mostra dettagli">Dettagli ${icon('chevron', 'chevron')}</button>
          <button class="btn-confronta${inConfronto ? ' attivo' : ''}" title="Confronta">${icon('compare')}</button>
          <button class="btn-salva${isSalvato ? ' attivo' : ''}" title="${isSalvato ? 'Rimuovi dai salvati' : 'Salva annuncio'}">${icon(isSalvato ? 'bookmark-filled' : 'bookmark')}</button>
        </div>
      </div>
      <div class="row-detail d-none"><div class="row-spec" data-loaded="0"></div></div>
    </div>
  `;
}

// ─── Confronto annunci ────────────────────────────────────────────────────────
function trovaResult(url) {
  return currentResults.find(r => r.url === url)
      || salvati.find(r => r.url === url)
      || null;
}

function toggleConfronto(url) {
  const result = trovaResult(url);
  if (!result) return;
  const idx = confronto.findIndex(r => r.url === url);
  if (idx !== -1) {
    confronto.splice(idx, 1);           // deseleziona
  } else if (confronto.length < 2) {
    confronto.push(result);             // prima o seconda selezione
  } else {
    confronto[0] = confronto[1];        // sostituisce il più vecchio
    confronto[1] = result;
  }
  renderResults(currentResults);
  renderSalvati();
  if (confronto.length === 2) openConfrontoModal();
}

function openConfrontoModal() {
  const [a, b] = confronto;
  const fmt    = n => n != null ? `€ ${n.toLocaleString('it-IT')}` : '—';
  const fmtKm  = n => n != null ? `${n.toLocaleString('it-IT')} km` : '—';

  // Determina quale valore è migliore e assegna la classe CSS
  const better = (va, vb, lowerIsBetter = true) => {
    if (va == null && vb == null) return ['', ''];
    if (va == null) return ['', 'confronto-val-better'];
    if (vb == null) return ['confronto-val-better', ''];
    if (va === vb)  return ['', ''];
    return lowerIsBetter
      ? (va < vb ? ['confronto-val-better', ''] : ['', 'confronto-val-better'])
      : (va > vb ? ['confronto-val-better', ''] : ['', 'confronto-val-better']);
  };

  const [pA, pB] = better(a.prezzo, b.prezzo, true);
  const [kA, kB] = better(a.km, b.km, true);
  const [aA, aB] = better(a.anno, b.anno, false);

  const trunc = (s, n) => s.length > n ? s.slice(0, n) + '…' : s;

  document.getElementById('confrontoBody').innerHTML = `
    <table class="confronto-table">
      <thead>
        <tr>
          <th></th>
          <th>${escapeHtml(trunc(a.titolo, 50))}</th>
          <th>${escapeHtml(trunc(b.titolo, 50))}</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Fonte</td>
          <td>${escapeHtml(FONTE_LABEL[a.fonte] || a.fonte)}</td>
          <td>${escapeHtml(FONTE_LABEL[b.fonte] || b.fonte)}</td>
        </tr>
        <tr>
          <td>Prezzo</td>
          <td class="${pA}">${fmt(a.prezzo)}</td>
          <td class="${pB}">${fmt(b.prezzo)}</td>
        </tr>
        <tr>
          <td>Anno</td>
          <td class="${aA}">${a.anno || '—'}</td>
          <td class="${aB}">${b.anno || '—'}</td>
        </tr>
        <tr>
          <td>Km</td>
          <td class="${kA}">${fmtKm(a.km)}</td>
          <td class="${kB}">${fmtKm(b.km)}</td>
        </tr>
        <tr>
          <td>Carburante</td>
          <td>${escapeHtml(a.carburante || '—')}</td>
          <td>${escapeHtml(b.carburante || '—')}</td>
        </tr>
        <tr>
          <td>Provincia</td>
          <td>${escapeHtml(a.provincia || '—')}</td>
          <td>${escapeHtml(b.provincia || '—')}</td>
        </tr>
        <tr>
          <td>Link</td>
          <td><a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-outline-primary w-100">Vai ↗</a></td>
          <td><a href="${escapeHtml(b.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-outline-primary w-100">Vai ↗</a></td>
        </tr>
      </tbody>
    </table>
  `;

  bootstrap.Modal.getOrCreateInstance(document.getElementById('confrontoModal')).show();
}

// ─── Annunci salvati ──────────────────────────────────────────────────────────
function toggleSalva(url) {
  const idx = salvati.findIndex(r => r.url === url);
  if (idx !== -1) {
    salvati.splice(idx, 1);
  } else {
    const result = trovaResult(url);
    if (result) salvati.push(result);
  }
  persistSalvati();   // §18: persistenza tra sessioni
  aggiornaContatoreSalvati();
  renderSalvati();
  renderResults(currentResults);
}

// §18 — Persistenza salvati in localStorage (vive in userData Electron → segue
// anche il SSD in modalità portatile §14). Cap per non gonfiare.
const SALVATI_KEY = 'amr_salvati';
const SALVATI_CAP = 200;
function persistSalvati() {
  try { localStorage.setItem(SALVATI_KEY, JSON.stringify(salvati.slice(-SALVATI_CAP))); }
  catch (_) { /* quota/disabilitato → non-fatale */ }
}
function loadSalvati() {
  try {
    const raw = localStorage.getItem(SALVATI_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    salvati = Array.isArray(arr) ? arr : [];
  } catch (_) { salvati = []; }
  aggiornaContatoreSalvati();
  renderSalvati();
}

function aggiornaContatoreSalvati() {
  document.getElementById('salvatiCount').textContent = salvati.length;
  document.getElementById('btnSalvati').style.display = salvati.length > 0 ? 'flex' : 'none';
}

function renderSalvati() {
  const container = document.getElementById('salvatiList');
  if (salvati.length === 0) {
    container.innerHTML = '<p class="text-muted text-center py-4">Nessun annuncio salvato.</p>';
    return;
  }
  const fmt   = n => n != null ? `€ ${n.toLocaleString('it-IT')}` : '—';
  const fmtKm = n => n != null ? `${n.toLocaleString('it-IT')} km` : '—';

  container.innerHTML = salvati.map(r => {
    const inConf = confronto.some(c => c.url === r.url);
    return `
      <div class="salvato-item" data-url="${escapeHtml(r.url)}">
        <div class="salvato-info">
          <div class="salvato-titolo">${escapeHtml(r.titolo)}</div>
          <div class="salvato-dettagli">${fmt(r.prezzo)} · ${fmtKm(r.km)} · ${r.anno || '—'}</div>
        </div>
        <div class="salvato-actions">
          <button class="btn-confronta-salvato${inConf ? ' attivo' : ''}" title="Confronta">${icon('compare')}</button>
          <button class="btn-rimuovi-salvato" title="Rimuovi">${icon('x')}</button>
        </div>
      </div>
    `;
  }).join('');
}

// ─── §11 Ricerche salvate + avvisi ──────────────────────────────────────────
async function loadSavedSearches() {
  try {
    const r = await fetch('/api/saved');
    const j = await r.json();
    savedSearches = j.saved || [];
  } catch (_) { savedSearches = []; }
  renderRicerche();
  updateNovitaBadge();
}

function updateNovitaBadge() {
  const tot = savedSearches.reduce((a, s) => a + (s.novita || 0), 0);
  const badge = document.getElementById('novitaCount');
  const btn   = document.getElementById('btnRicerche');
  btn.style.display = savedSearches.length > 0 ? 'flex' : 'none';
  if (tot > 0) { badge.textContent = tot; badge.style.display = 'inline-block'; }
  else         { badge.style.display = 'none'; }
}

async function saveCurrentSearch() {
  if (!lastSearchParams || !lastSearchParams.marca) {
    showError('Fai prima una ricerca, poi salvala.'); return;
  }
  const btn = document.getElementById('btnSalvaRicerca');
  btn.disabled = true;
  try {
    const r = await fetch('/api/saved', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: lastSearchParams }),
    });
    if (!r.ok) throw new Error('save failed');
    await loadSavedSearches();
    btn.textContent = '✓ Salvata';
    setTimeout(() => { btn.textContent = 'Salva ricerca'; btn.disabled = false; }, 1500);
  } catch (_) {
    showError('Salvataggio ricerca non riuscito.'); btn.disabled = false;
  }
}

async function checkRicerche(id) {
  const url = id ? `/api/saved/check?id=${encodeURIComponent(id)}` : '/api/saved/check';
  const listEl = document.getElementById('ricercheList');
  // §19.3: disabilita solo il bottone della card interessata (o tutta la lista se "Controlla tutte").
  const btn = id ? listEl.querySelector(`.ric-card[data-id="${CSS.escape(id)}"] .ric-check`) : null;
  if (btn) { btn.disabled = true; btn.textContent = '…'; } else { listEl.classList.add('checking'); }
  try {
    const r = await fetch(url, { method: 'POST' });
    const j = await r.json();
    if (j.saved) { savedSearches = j.saved; renderRicerche(); updateNovitaBadge(); }
  } catch (_) {
    showError('Controllo non riuscito.');
  } finally {
    listEl.classList.remove('checking');   // renderRicerche ricrea il bottone (riabilitato)
  }
}

function onRicercheClick(e) {
  const card = e.target.closest('[data-id]');
  if (!card) return;
  const id = card.dataset.id;
  if (e.target.closest('.ric-check'))  { checkRicerche(id); return; }
  if (e.target.closest('.ric-del'))    { deleteRicerca(id); return; }
  const alertEl = e.target.closest('.ric-alert[data-url]');
  if (alertEl) {
    markRicercaRead(id);
    const u = alertEl.dataset.url;
    if (/^https?:/.test(u)) window.open(u, '_blank', 'noopener,noreferrer');
    return;
  }
  if (e.target.closest('.ric-head')) card.classList.toggle('open');   // espandi/chiudi avvisi
}

async function deleteRicerca(id) {
  try {
    await fetch(`/api/saved/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSavedSearches();
  } catch (_) { showError('Eliminazione non riuscita.'); }
}

async function markRicercaRead(id) {
  try { await fetch(`/api/saved/${encodeURIComponent(id)}/read`, { method: 'POST' }); }
  catch (_) {}
  const s = savedSearches.find(x => x.id === id);
  if (s) { s.novita = 0; s.digest = {}; updateNovitaBadge(); }
  // Feedback immediato: togli badge "N" e bordo-novità dalla card, senza
  // collassare la lista avvisi aperta.
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
    const badge  = novita > 0 ? `<span class="ric-badge">${novita}</span>` : '';
    // Digest: "2 nuovi · 1 calo · 1 affare"
    const dig = Object.entries(s.digest || {})
      .map(([m, n]) => `${n} ${MOTIVO_LABEL[m] || m}`).join(' · ');
    const digestLine = dig ? `<div class="ric-digest">${dig}</div>` : '';
    // Lista avvisi (espandibile)
    const alertsHtml = (s.alerts || []).map(a => `
      <div class="ric-alert ric-${a.motivo}" data-url="${escapeHtml(a.url)}" title="Apri annuncio">
        <span class="ric-motivo">${MOTIVO_LABEL[a.motivo]?.slice(0, -1) || a.motivo}</span>
        <span class="ric-alert-tit">${escapeHtml(a.titolo || 'Annuncio')}</span>
        <span class="ric-alert-prezzo">${fmt(a.prezzo)}</span>
      </div>`).join('');
    return `
      <div class="ric-card${novita ? ' has-novita' : ''}" data-id="${escapeHtml(s.id)}">
        <div class="ric-head">
          <div class="ric-title">${escapeHtml(s.label)} ${badge}</div>
          <div class="ric-sub">${escapeHtml(s.params?.tipo || '')} · controllata ${whenTxt(s.lastChecked)}</div>
          ${digestLine}
        </div>
        <div class="ric-actions">
          <button class="rnav-btn ric-check" title="Controlla ora">Controlla</button>
          <button class="rnav-btn ric-del" title="Elimina">${icon('x')}</button>
        </div>
        ${alertsHtml ? `<div class="ric-alerts">${alertsHtml}</div>` : ''}
      </div>`;
  }).join('');
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
function showLoading() {
  statusBox.classList.remove('d-none');
  loadingState.classList.remove('d-none');
  errorState.classList.add('d-none');
}

function hideLoading() {
  loadingState.classList.add('d-none');
  // Nascondiamo statusBox solo se nessun altro figlio (errore / banner Subito) è visibile.
  const errorVisible  = !errorState.classList.contains('d-none');
  const bannerVisible = !subitoBanner.classList.contains('d-none');
  if (!errorVisible && !bannerVisible) statusBox.classList.add('d-none');
}

function showError(msg) {
  statusBox.classList.remove('d-none');
  loadingState.classList.add('d-none');
  errorState.classList.remove('d-none');
  errorText.textContent = msg;
}

function hideError() {
  errorState.classList.add('d-none');
  // Mantieni statusBox aperto se il banner Subito è visibile
  if (subitoBanner.classList.contains('d-none')) statusBox.classList.add('d-none');
}

function hideResults() {
  resultsSection.classList.add('d-none');
  noResults.classList.add('d-none');
  resultsNav.classList.add('d-none');
  fonteBreakdown.textContent = '';
  resultsGrid.innerHTML = '';
}

// ─── Export CSV ───────────────────────────────────────────────────────────────
function exportCsv(results) {
  const cols = ['Fonte', 'Titolo', 'Prezzo (€)', 'Anno', 'KM', 'Carburante', 'Provincia', 'URL'];
  const rows = results.map(r => [
    r.fonte,
    r.titolo,
    r.prezzo != null ? r.prezzo : '',
    r.anno   != null ? r.anno   : '',
    r.km     != null ? r.km     : '',
    r.carburante || '',
    r.provincia  || '',
    r.url,
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

  const csv  = [cols.join(','), ...rows].join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `automotoradar-${new Date().toISOString().slice(0, 10)}.csv`,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Export PDF ───────────────────────────────────────────────────────────────
function exportPdf(results) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

  const today       = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
  const dateFilename = new Date().toISOString().slice(0, 10);
  const pageW       = doc.internal.pageSize.getWidth();   // 297
  const pageH       = doc.internal.pageSize.getHeight();  // 210

  // ─── Palette colori
  const C_BLUE_900  = [30,  58,  138];
  const C_BLUE_700  = [29,  78,  216];
  const C_BLUE_100  = [219, 234, 254];
  const C_WHITE     = [255, 255, 255];
  const C_SLATE_500 = [100, 116, 139];
  const C_SLATE_100 = [241, 245, 249];

  // ─── Header fascia
  doc.setFillColor(...C_BLUE_900);
  doc.rect(0, 0, pageW, 26, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...C_WHITE);
  doc.text('Auto Moto Radar', 14, 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(180, 205, 245);
  doc.text('Report annunci · ' + today, 14, 20);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...C_WHITE);
  doc.text(results.length + ' annunci totali', pageW - 14, 16, { align: 'right' });

  // ─── Box statistiche
  const prices  = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const fmtEur  = n => '€ ' + n.toLocaleString('it-IT');

  const min     = prices.length ? fmtEur(prices[0])                                                          : '—';
  const max     = prices.length ? fmtEur(prices[prices.length - 1])                                          : '—';
  const media   = prices.length ? fmtEur(Math.round(prices.reduce((a, b) => a + b, 0) / prices.length))      : '—';
  const mid     = prices.length / 2;
  const mediana = prices.length
    ? fmtEur(prices.length % 2 === 0 ? Math.round((prices[mid - 1] + prices[mid]) / 2) : prices[Math.floor(mid)])
    : '—';

  const statsBoxes = [
    { label: 'MINIMO',     value: min },
    { label: 'MEDIANA',    value: mediana },
    { label: 'MEDIA',      value: media },
    { label: 'MASSIMO',    value: max },
    { label: 'CON PREZZO', value: `${prices.length} / ${results.length}` },
  ];

  const boxW  = 51;
  const boxH  = 18;
  const boxY  = 31;
  const gap   = 2.5;
  const startX = 14;

  statsBoxes.forEach((s, i) => {
    const x = startX + i * (boxW + gap);
    doc.setFillColor(...C_BLUE_100);
    doc.roundedRect(x, boxY, boxW, boxH, 2.5, 2.5, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(...C_SLATE_500);
    doc.text(s.label, x + boxW / 2, boxY + 5.5, { align: 'center' });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(...C_BLUE_700);
    doc.text(s.value, x + boxW / 2, boxY + 13, { align: 'center' });
  });

  // ─── Tabella
  const FONTE_COLORS = {
    subito:    { fill: [224, 242, 254], text: [3,  105, 161] },
    autoscout: { fill: [254, 243, 199], text: [146, 64,  14] },
    moto:      { fill: [220, 252, 231], text: [22,  101, 52] },
  };
  const FONTE_LABEL_PDF = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };

  const tableBody = results.map(r => [
    FONTE_LABEL_PDF[r.fonte] || r.fonte,
    r.titolo,
    r.prezzo != null ? fmtEur(r.prezzo) : '—',
    r.anno   != null ? String(r.anno)   : '—',
    r.km     != null ? r.km.toLocaleString('it-IT') + ' km' : '—',
    r.carburante || '—',
    r.provincia  || '—',
  ]);

  doc.autoTable({
    startY: boxY + boxH + 5,
    head:   [['Fonte', 'Titolo', 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia']],
    body:   tableBody,
    styles: {
      font: 'helvetica',
      fontSize: 7.5,
      cellPadding: { top: 2.5, right: 3, bottom: 2.5, left: 3 },
      valign: 'middle',
      overflow: 'ellipsize',
    },
    headStyles: {
      fillColor: C_BLUE_900,
      textColor: C_WHITE,
      fontStyle: 'bold',
      fontSize: 7.5,
    },
    alternateRowStyles: { fillColor: C_SLATE_100 },
    columnStyles: {
      0: { halign: 'center', cellWidth: 24 },
      1: { cellWidth: 'auto' },
      2: { halign: 'right',  cellWidth: 24, fontStyle: 'bold', textColor: C_BLUE_700 },
      3: { halign: 'center', cellWidth: 14 },
      4: { halign: 'right',  cellWidth: 24 },
      5: { halign: 'center', cellWidth: 22 },
      6: { halign: 'center', cellWidth: 22 },
    },
    didDrawCell(data) {
      if (data.section !== 'body' || data.column.index !== 0) return;
      const fonte  = results[data.row.index]?.fonte;
      const colors = FONTE_COLORS[fonte];
      if (!colors) return;
      doc.setFillColor(...colors.fill);
      doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...colors.text);
      doc.text(
        FONTE_LABEL_PDF[fonte] || fonte,
        data.cell.x + data.cell.width / 2,
        data.cell.y + data.cell.height / 2,
        { align: 'center', baseline: 'middle' }
      );
    },
    margin: { left: 14, right: 14 },
  });

  // ─── Footer su ogni pagina
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setDrawColor(...C_BLUE_100);
    doc.setLineWidth(0.3);
    doc.line(14, pageH - 10, pageW - 14, pageH - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...C_SLATE_500);
    doc.text('Auto Moto Radar — uso personale', 14, pageH - 5.5);
    doc.text(`Pagina ${i} di ${pageCount}`, pageW - 14, pageH - 5.5, { align: 'right' });
  }

  doc.save(`automotoradar-${dateFilename}.pdf`);
}

// ─── Pre-fill da URL params (per test rapidi) ─────────────────────────────────
// Uso: http://localhost:3000?tipo=auto&marca=Ford&modello=Fiesta&regione=lazio&prezzoMax=8000
// Tutti i parametri sono opzionali. Se marca è presente, la ricerca parte automaticamente.
function applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has('marca')) return; // nessun param → comportamento normale

  // tipo (auto / moto)
  const tipo = p.get('tipo') || 'auto';
  const tipoInput = document.querySelector(`input[name="tipo"][value="${tipo}"]`);
  if (tipoInput) {
    tipoInput.checked = true;
    tipoInput.dispatchEvent(new Event('change'));
  }

  // marca
  const marca = p.get('marca') || '';
  if (marca) {
    marcaSelect.value = marca;
  }

  // campi numerici e testo semplice
  ['prezzoMin','prezzoMax','annoMin','annoMax','kmMax'].forEach(k => {
    if (p.has(k)) document.getElementById(k).value = p.get(k);
  });

  const applyGeo = () => {
    if (p.has('regione')) regioneSelect.value = p.get('regione');
  };

  // P10: marca + modello sono input liberi, niente più async loadModelli
  const modello = p.get('modello') || '';
  if (marca) {
    marcaSelect.value = marca;
    if (modello) document.getElementById('modello').value = modello;
    applyGeo();
    doSearch();
  }
}

// ─── Avvio ────────────────────────────────────────────────────────────────────
init();
