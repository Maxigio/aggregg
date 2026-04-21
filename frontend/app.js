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
const marcaSelect        = document.getElementById('marca');
const regioneSelect      = document.getElementById('regione');
const tipoInputs         = document.querySelectorAll('input[name="tipo"]');
const fonteChips         = document.getElementById('fonteChips');
const backToSearch       = document.getElementById('backToSearch');
const statsPanel         = document.getElementById('statsPanel');
const clientFiltersPanel = document.getElementById('clientFiltersPanel');
const excludeNoPrice     = document.getElementById('excludeNoPrice');
const prezzoSliderEl     = document.getElementById('prezzoSlider');
const btnStatCsv         = document.getElementById('btnStatCsv');
const btnStatPdf         = document.getElementById('btnStatPdf');

// ─── Stato ────────────────────────────────────────────────────────────────────
let currentResults       = [];
let confronto            = [];   // max 2 result objects per il confronto
let salvati              = [];   // annunci salvati nella sessione corrente
const fontiAttive        = { subito: true, autoscout: true, moto: true };
let prezzoSliderInstance = null;
let sliderGlobalBounds   = [0, 0];
let modelloTomSelect     = null;

// Cache brand list dal server per tipo corrente (con metadata sites)
const brandCache = { auto: null, moto: null };
// Mappa nome-brand → entry brands.js (per motoIt slug client-side)
function brandsJsEntry(tipo, nome) {
  return (BRANDS[tipo] || []).find(b => b.nome === nome) || null;
}

const FONTE_LABEL = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };

// Abbreviazioni siti per badge: S=Subito, A=Autoscout, M=Moto.it
function sitesBadge(sites, tipo) {
  const marks = [];
  if (sites.includes('subito'))    marks.push('S');
  if (sites.includes('autoscout')) marks.push('A');
  if (tipo === 'moto' && sites.includes('motoit')) marks.push('M');
  return marks.length ? ` [${marks.join('·')}]` : '';
}


// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const currentYear = new Date().getFullYear();
  document.getElementById('annoMin').max = currentYear;
  document.getElementById('annoMax').max = currentYear;
  document.getElementById('annoMax').placeholder = `es. ${currentYear}`;

  populateRegione();
  await populateMarca('auto');
  initModelloSelect();
  applyUrlParams();

  marcaSelect.addEventListener('change', () => {
    const tipo  = document.querySelector('input[name="tipo"]:checked').value;
    const marca = marcaSelect.value;
    if (marca) loadModelli(tipo, marca);
    else       resetModelloSelect('Seleziona prima la marca');
  });

  tipoInputs.forEach(input => input.addEventListener('change', () => {
    populateMarca(input.value);
    fonteChips.querySelector('[data-fonte="moto"]').style.display = input.value === 'moto' ? '' : 'none';
    resetModelloSelect('Seleziona prima la marca');
    currentResults = [];
    hideResults();
  }));

  fonteChips.querySelector('[data-fonte="moto"]').style.display = 'none';

  fonteChips.addEventListener('click', e => {
    const btn = e.target.closest('[data-fonte]');
    if (!btn) return;
    const fonte = btn.dataset.fonte;
    fontiAttive[fonte] = !fontiAttive[fonte];
    btn.classList.toggle('active', fontiAttive[fonte]);
    renderResults(currentResults);
  });

  sortSelect.addEventListener('change',    () => renderResults(currentResults));
  excludeNoPrice.addEventListener('change', () => renderResults(currentResults));

  btnStatCsv.addEventListener('click', () => exportCsv(currentResults));
  btnStatPdf.addEventListener('click', () => exportPdf(currentResults));
  errorClose.addEventListener('click', hideError);
  backToSearch.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  form.addEventListener('submit', async (e) => { e.preventDefault(); await doSearch(); });

  // ── Event delegation: card risultati ─────────────────────────────────────
  resultsGrid.addEventListener('click', e => {
    const card = e.target.closest('[data-url]');
    if (!card) return;
    const url = card.dataset.url;
    if (e.target.closest('.btn-salva'))     { toggleSalva(url);     return; }
    if (e.target.closest('.btn-confronta')) { toggleConfronto(url); return; }
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

  // ── Event delegation: min/max cliccabili nelle stats ─────────────────────
  statsPanel.addEventListener('click', e => {
    const btn = e.target.closest('.stat-clickable');
    if (btn) scrollToCard(btn.dataset.url);
  });

  // Stato iniziale salvati (lista vuota)
  renderSalvati();
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


async function populateMarca(tipo) {
  marcaSelect.innerHTML = '<option value="">Caricamento marche…</option>';
  marcaSelect.disabled = true;

  // Carica dal server (union Subito+AS24) e arricchisce con motoIt da brands.js
  if (!brandCache[tipo]) {
    try {
      const res = await fetch(`/api/brands?tipo=${encodeURIComponent(tipo)}`);
      const data = await res.json();
      const jsMap = new Map((BRANDS[tipo] || []).map(b => [b.nome, b]));
      brandCache[tipo] = (data.brands || []).map(b => {
        const js = jsMap.get(b.nome);
        const sites = [...b.sites];
        if (tipo === 'moto' && js?.motoIt) sites.push('motoit');
        return { ...b, sites };
      });
    } catch {
      // Fallback di sicurezza: lista statica brands.js
      brandCache[tipo] = (BRANDS[tipo] || []).map(b => ({
        nome:  b.nome,
        sites: ['subito', 'autoscout', ...(tipo === 'moto' && b.motoIt ? ['motoit'] : [])],
      }));
    }
  }

  const brands = brandCache[tipo];
  marcaSelect.innerHTML = '<option value="">Seleziona marca...</option>';
  brands.forEach(b => {
    const opt = document.createElement('option');
    opt.value = b.nome;
    opt.textContent = `${b.nome}${sitesBadge(b.sites, tipo)}`;
    marcaSelect.appendChild(opt);
  });
  marcaSelect.disabled = false;
  resetModelloSelect('Seleziona prima la marca');
}

// ─── Dropdown modello (tom-select) ───────────────────────────────────────────
function initModelloSelect() {
  modelloTomSelect = new TomSelect('#modello', {
    placeholder:      'Tutti i modelli',
    allowEmptyOption: true,
    searchField:      ['text'],
    maxOptions:       300,
    render: {
      no_results: () => '<div class="no-results">Nessun modello trovato</div>',
    },
  });
}

function resetModelloSelect(placeholder) {
  if (!modelloTomSelect) return;
  modelloTomSelect.clear();
  modelloTomSelect.clearOptions();
  modelloTomSelect.addOption({ value: '', text: '' });
  modelloTomSelect.settings.placeholder = placeholder || 'Tutti i modelli';
  modelloTomSelect.inputState();
  modelloTomSelect.disable();
}

let currentMotoBrandKey = null;

async function loadModelli(tipo, marca) {
  resetModelloSelect('Caricamento modelli...');
  currentMotoBrandKey = null;
  try {
    const res     = await fetch(`/api/models?tipo=${encodeURIComponent(tipo)}&marca=${encodeURIComponent(marca)}`);
    const data    = await res.json();
    const modelli = data.modelli || [];

    if (tipo === 'moto') currentMotoBrandKey = data.brandKey || null;

    modelloTomSelect.clear();
    modelloTomSelect.clearOptions();

    if (modelli.length === 0) {
      modelloTomSelect.settings.placeholder = 'Nessun modello disponibile';
      modelloTomSelect.inputState();
      modelloTomSelect.disable();
      return;
    }

    modelloTomSelect.addOption({ value: '', text: '' });
    modelli.forEach(m => {
      const label = `${m.nome}${sitesBadge(m.sites || [], tipo)}`;
      modelloTomSelect.addOption({
        value:       m.nome,
        text:        label,
        mmmv:        m.mmmvAutoscout || '',
        slugSubito:  m.slugSubito    || '',
        subitoKey:   m.subitoKey     || '',
      });
    });

    modelloTomSelect.settings.placeholder = 'Tutti i modelli';
    modelloTomSelect.inputState();
    modelloTomSelect.enable();
  } catch {
    modelloTomSelect.settings.placeholder = 'Errore caricamento modelli';
    modelloTomSelect.inputState();
    modelloTomSelect.disable();
  }
}

// ─── Ricerca ──────────────────────────────────────────────────────────────────
async function doSearch() {
  const tipo  = document.querySelector('input[name="tipo"]:checked').value;
  const marca = marcaSelect.value.trim();

  if (!marca) { showError('Seleziona una marca prima di cercare.'); return; }

  // Brand metadata: motoIt slug dal brands.js (client-side); il resto AS24/Subito
  // viene risolto server-side dal catalogo unificato.
  const brandJs            = brandsJsEntry(tipo, marca);
  const brandSitesMeta     = (brandCache[tipo] || []).find(b => b.nome === marca);
  const modelloNome        = modelloTomSelect?.getValue() || '';
  const modelloOpt         = modelloNome ? (modelloTomSelect?.options?.[modelloNome] ?? null) : null;
  const mmmvAutoscout      = modelloOpt?.mmmv       || '';
  const modelloSlugSubito  = modelloOpt?.slugSubito || '';
  const motoModelKey       = modelloOpt?.subitoKey  || '';

  const params = {
    tipo, marca,
    modello:   modelloNome,
    prezzoMin: document.getElementById('prezzoMin').value,
    prezzoMax: document.getElementById('prezzoMax').value,
    annoMin:   document.getElementById('annoMin').value,
    annoMax:   document.getElementById('annoMax').value,
    kmMax:     document.getElementById('kmMax').value,
  };

  if (regioneSelect.value) params.regione = regioneSelect.value;

  // Subito: server-side resolution non ancora in place per slug brand, usiamo brands.js
  if (brandJs?.subito) params.slugSubito = brandJs.subito;
  // Moto.it: solo da brands.js (catalogo motoIt ancora in brands.js)
  if (brandJs?.motoIt) params.slugMoto   = brandJs.motoIt;

  if (mmmvAutoscout)     params.mmmvAutoscout     = mmmvAutoscout;
  if (modelloSlugSubito) params.modelloSlugSubito = modelloSlugSubito;
  if (tipo === 'moto' && currentMotoBrandKey) params.motoBrandKey = currentMotoBrandKey;
  if (tipo === 'moto' && motoModelKey)        params.motoModelKey = motoModelKey;

  Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });

  excludeNoPrice.checked = false;
  confronto = [];

  showLoading();
  hideResults();

  try {
    const res  = await fetch(`/api/search?${new URLSearchParams(params)}`);
    const data = await res.json();

    if (!res.ok) { showError(data.error || 'Errore durante la ricerca.'); return; }

    currentResults = data.risultati || [];

    initPrezzoSlider(currentResults);

    if (!prezzoSliderInstance) renderResults(currentResults);

    if (currentResults.length > 0) {
      statsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

  } catch {
    showError('Impossibile contattare il server. Assicurati che sia avviato con "npm start".');
  } finally {
    hideLoading();
  }
}

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
  let filtered = results.filter(r => fontiAttive[r.fonte]);

  if (excludeNoPrice.checked) {
    filtered = filtered.filter(r => r.prezzo != null);
  }

  if (prezzoSliderInstance) {
    const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
    filtered = filtered.filter(r => r.prezzo == null || (r.prezzo >= sMin && r.prezzo <= sMax));
  }

const sorted = sortResults([...filtered], sortSelect.value);

  statsPanel.classList.remove('d-none');
  clientFiltersPanel.classList.remove('d-none');
  updateStats(sorted);

  if (sorted.length === 0) {
    noResults.classList.remove('d-none');
    resultsSection.classList.add('d-none');
    return;
  }

  noResults.classList.add('d-none');
  resultsSection.classList.remove('d-none');

  resultsCount.textContent = `${sorted.length} risultati trovati`;
  const breakdown = Object.entries(
    sorted.reduce((acc, r) => { acc[r.fonte] = (acc[r.fonte] || 0) + 1; return acc; }, {})
  ).map(([f, n]) => `${FONTE_LABEL[f] || f}: ${n}`).join(' · ');
  fonteBreakdown.textContent = breakdown;

  resultsGrid.innerHTML = sorted.map(cardHTML).join('');
}

// ─── Statistiche ──────────────────────────────────────────────────────────────
function updateStats(results) {
  const prices = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const fmt    = n => `€ ${n.toLocaleString('it-IT')}`;

  if (prices.length === 0) {
    document.getElementById('statMin').innerHTML     = '—';
    document.getElementById('statMax').innerHTML     = '—';
    document.getElementById('statCount').textContent = `0 / ${results.length}`;
    return;
  }

  const min = prices[0];
  const max = prices[prices.length - 1];

  // Trova i result corrispondenti a min e max per rendere i valori cliccabili
  const minResult = results.find(r => r.prezzo === min);
  const maxResult = results.find(r => r.prezzo === max);

  const makeClickable = (val, result) =>
    result
      ? `<button class="stat-clickable" data-url="${escapeHtml(result.url)}">${fmt(val)}</button>`
      : fmt(val);

  document.getElementById('statMin').innerHTML     = makeClickable(min, minResult);
  document.getElementById('statMax').innerHTML     = makeClickable(max, maxResult);
  document.getElementById('statCount').textContent = `${prices.length} / ${results.length}`;
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

function cardHTML(item) {
  const prezzoStr  = item.prezzo != null
    ? `€ ${item.prezzo.toLocaleString('it-IT')}`
    : 'Prezzo non disponibile';

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
    <div class="col-12 col-md-6 col-lg-4">
      <div class="result-card" data-url="${urlSafe}">
        <div class="result-main">
          <span class="fonte ${fonteClass}">${escapeHtml(fonteLabel)}</span>
          <div class="titolo">${escapeHtml(item.titolo)}</div>
          <div class="prezzo">${prezzoStr}</div>
          ${dettagli ? `<div class="dettagli">${escapeHtml(dettagli)}</div>` : ''}
        </div>
        <div class="card-actions">
          <button class="btn-confronta${inConfronto ? ' attivo' : ''}" title="Confronta">⚖️ Confronta</button>
          <button class="btn-salva${isSalvato ? ' attivo' : ''}" title="${isSalvato ? 'Rimuovi dai salvati' : 'Salva annuncio'}">🔖</button>
        </div>
      </div>
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
  aggiornaContatoreSalvati();
  renderSalvati();
  renderResults(currentResults);
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
          <button class="btn-confronta-salvato${inConf ? ' attivo' : ''}" title="Confronta">⚖️</button>
          <button class="btn-rimuovi-salvato" title="Rimuovi">✕</button>
        </div>
      </div>
    `;
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
  if (errorState.classList.contains('d-none')) statusBox.classList.add('d-none');
}

function showError(msg) {
  statusBox.classList.remove('d-none');
  loadingState.classList.add('d-none');
  errorState.classList.remove('d-none');
  errorText.textContent = msg;
}

function hideError() {
  errorState.classList.add('d-none');
  statusBox.classList.add('d-none');
}

function hideResults() {
  resultsSection.classList.add('d-none');
  noResults.classList.add('d-none');
  statsPanel.classList.add('d-none');
  clientFiltersPanel.classList.add('d-none');
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
      2: { halign: 'right',  cellWidth: 26, fontStyle: 'bold', textColor: C_BLUE_700 },
      3: { halign: 'center', cellWidth: 14 },
      4: { halign: 'right',  cellWidth: 26 },
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

  // modello: va caricato async dopo la marca
  const modello = p.get('modello') || '';
  if (marca && modello) {
    loadModelli(tipo, marca).then(() => {
      // Imposta il valore nel TomSelect dopo il caricamento
      if (modelloTomSelect) {
        modelloTomSelect.setValue(modello, true); // true = silent (no events)
      }
      applyGeo();
      // Lancia la ricerca automaticamente
      doSearch();
    });
  } else if (marca) {
    loadModelli(tipo, marca);
    applyGeo();
    doSearch();
  }
}

// ─── Avvio ────────────────────────────────────────────────────────────────────
init();
