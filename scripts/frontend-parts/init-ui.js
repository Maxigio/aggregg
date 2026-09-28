
// ─── Filtri avanzati delle auto ─────────────────────────────────────────────
/**
 * LE TENDINE SE LE RIEMPIE IL SERVER, non l'HTML.
 *
 * Le voci (carrozzeria, cambio, alimentazione, …) vengono da /api/filtri-auto, che le legge
 * dalla STESSA tabella con cui il server le traduce nel dialetto di Subito e Autoscout.
 * Scriverle anche qui vorrebbe dire due elenchi da tenere allineati a mano, e il giorno che
 * una fonte cambia un codice non si vedrebbe niente: solo una ricerca che torna storta.
 *
 * Solo AUTO. Le moto hanno anche Moto.it, che questi filtri non li onora: mostrarli anche li'
 * sarebbe un filtro che una fonte su tre ignora in silenzio.
 */
let filtriAutoNomi = [];
let filtriAutoInVolo = false;
async function caricaFiltriAuto() {
  const griglia = document.getElementById('filtriAutoGrid');
  if (!griglia) return;
  // UNA RICHIESTA ALLA VOLTA, E UNA SOLA VOLTA. Il toggle del pannello riprova quando
  // `filtriAutoNomi` e' vuoto — ma e' vuoto anche mentre la chiamata del boot e' ancora in
  // volo: senza questa guardia le due risposte appendevano DUE volte le tendine (id
  // duplicati, e la copia che getElementById non vede perdeva le scelte in silenzio).
  // Il fallimento invece NON si memorizza: la bandiera si abbassa e si riprova all'apertura.
  if (filtriAutoInVolo || filtriAutoNomi.length) return;
  filtriAutoInVolo = true;
  let d = null;
  try { d = await fetch('/api/filtri-auto').then(r => (r.ok ? r.json() : null)); } catch (_) { d = null; }
  filtriAutoInVolo = false;
  if (!d || !Array.isArray(d.filtri)) return;   // senza elenco niente tendine: meglio di tendine vuote
  filtriAutoNomi = d.filtri.map(f => f.nome);
  const prima = griglia.firstElementChild;      // i due campi CV restano in coda
  for (const f of d.filtri) {
    const lab = document.createElement('label');
    lab.className = 'adv-field';
    const sp = document.createElement('span');
    sp.textContent = f.etichetta;
    const sel = document.createElement('select');
    sel.id = 'fa_' + f.nome;
    sel.dataset.filtro = f.nome;
    const vuota = document.createElement('option');
    vuota.value = ''; vuota.textContent = 'Tutte';
    sel.appendChild(vuota);
    for (const v of f.voci) {
      const o = document.createElement('option');
      o.value = v.id;
      // Le voci che su una fonte allargano invece di restringere lo dicono qui, non dopo:
      // il chilometro zero su Autoscout non esiste, e chi sceglie deve saperlo prima.
      o.textContent = v.etichetta + (v.allargaSu ? ` (su ${v.allargaSu.join(' e ')} allarga)` : '');
      sel.appendChild(o);
    }
    lab.append(sp, sel);
    griglia.insertBefore(lab, prima);
  }
}

/** Quello che l'utente ha scelto, pronto per la query. Vuoto = non impostato. */
function filtriAutoScelti() {
  const out = {};
  for (const n of filtriAutoNomi) {
    const v = (document.getElementById('fa_' + n) || {}).value;
    if (v) out[n] = v;
  }
  for (const k of ['cvMin', 'cvMax']) {
    const v = (document.getElementById(k) || {}).value;
    if (v) out[k] = v;
  }
  return out;
}

/** La griglia si vede solo in Auto: `data-solo` dice a chi appartiene. */
function sincronizzaFiltriAuto(tipo) {
  const g = document.getElementById('filtriAutoGrid');
  if (!g) return;
  /**
   * DUE CANCELLI, UNA REGOLA. La griglia (Carrozzeria, Cambio, …) si vede solo se il
   * pannello dei filtri e' APERTO e il tipo e' auto. Prima qui si guardava solo il tipo:
   * il `d-none` di partenza nell'HTML non lo toglieva nessuno finche' non CAMBIAVI tipo
   * — chi stava su Auto dalla partenza non vedeva quelle tendine MAI, e sembravano
   * «filtri esclusi dal pannello». Il toggle del pannello chiama questa stessa funzione:
   * la regola sta scritta una volta.
   */
  const pannelloAperto = advancedFilters && !advancedFilters.classList.contains('d-none');
  g.classList.toggle('d-none', tipo !== 'auto' || !pannelloAperto);
}

// ─── Modalità demo (ospite read-only) ───────────────────────────────────────
/**
 * SOLA LETTURA NON VUOL DIRE UNA STANZA SOLA.
 *
 * Il selettore Auto/Moto resta disponibile anche in sola lettura. La modalita demo
 * nasconde soltanto i comandi che il server negherebbe.
 */
/**
 * Quello che NON e' del proprietario sparisce dallo schermo.
 *
 * Le funzioni riservate al proprietario si distinguono dalle azioni personali.
 */
function applySoloProprietario() {
  document.body.classList.add('non-proprietario');
}

function applyDemoMode() {
  document.body.classList.add('demo-mode');
  if (!document.querySelector('.demo-banner')) {
    const bar = document.createElement('div');
    bar.className = 'demo-banner';
    // La frase prometteva una guida e non ci portava: chi entra in sola lettura e' proprio
    // chi ne ha piu' bisogno. Il link e' costruito qui e non scritto come HTML per non
    // aprire una via a testo non fidato dentro innerHTML.
    bar.append('Modalità demo — ');
    const g = document.createElement('a');
    g.href = '/guida'; g.target = '_blank'; g.rel = 'noopener';
    g.textContent = 'Dubbi? Consulta la Guida!';
    bar.append(g);
    document.body.prepend(bar);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  applyTheme(currentTheme());
  // Nessun dato proveniente dai portali resta nel browser dopo l'aggiornamento.
  for (const key of ['amr_salvati', 'amr_salvati_ricambi', 'amr_oem_preferiti']) {
    try { localStorage.removeItem(key); } catch (_) {}
  }
  const currentYear = new Date().getFullYear();
  document.getElementById('annoMin').max = currentYear;
  document.getElementById('annoMax').max = currentYear;
  document.getElementById('annoMax').placeholder = `es. ${currentYear}`;
  // PRIMA di qualunque attesa. Il ripristino del modo stava in fondo a init(), dopo
  // `await populateMarca('auto')` e `await applyUrlParams()`: ogni ricaricamento partiva
  // da Auto — radio su Auto, bottone Auto attivo (e' cablato cosi' in index.html) e il
  // catalogo AUTO scaricato per intero — e solo alla fine saltava al modo vero. Misurato
  // rallentando quella sola richiesta di 1,5s: l'utente resta in Auto per 1,5s tondi.
  // Qui si mette a posto lo stato visibile subito, e si scarica UN catalogo solo: quello
  // giusto. `ripristinaModo()` piu' sotto fa il resto (pannelli, aree) ed e' idempotente.
  preImpostaModo();
  document.body.dataset.tipo = currentTipo();
  sincronizzaFiltriAuto(currentTipo());

  populateRegione();
  caricaFiltriAuto();
  renderFacetChips();
  await populateMarca(currentTipo());
  setupMarcaAutocomplete();
  setupModelloAutocomplete();
  setupVersioneAutocomplete();
  validateMarca();

  // PRIMA del ripristino, non dopo: `ripristinaModo()` rimette il radio su Moto e lancia il
  // suo `change`, ed e' QUESTO gestore l'unico posto che chiama populateMarca('moto').
  // Registrandolo dopo, l'evento partiva senza ascoltatori: chi chiudeva l'app in Moto la
  // riapriva con la barra su Moto e il catalogo marche vuoto — nessuna marca accettata,
  // "Cerca" spento, e l'unico modo di uscirne era passare da Auto e tornare indietro.
  // Token di generazione (gemello di searchGen/rcGen/vehGen): chi commuta Moto→Auto mentre
  // le marche moto sono ancora in volo NON deve vedersi svuotare la marca appena digitata
  // dalla continuazione del gestore vecchio quando quella fetch finalmente risponde.
  let tipoGen = 0;
  tipoInputs.forEach(input => input.addEventListener('change', async () => {
    const myGen = ++tipoGen;
    document.body.dataset.tipo = input.value;
    sincronizzaFiltriAuto(input.value);
    await populateMarca(input.value);
    if (myGen !== tipoGen) return;   // commutazione superata: il reset lo fa quella nuova
    marcaSelect.value = '';
    document.getElementById('modello').value = '';
    resetModelloVersione();
    validateMarca();
    hideResults();   // l'azzeramento di currentResults sta dentro resetContesto, un posto solo
  }));

  const daUrl = await applyUrlParams();
  if (!daUrl) ripristinaModo();

  try {
    const me = await fetch('/api/me').then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (me && me.role) myRole = me.role;
    if (me) { myId = me.id || null; sonoProprietario = me.proprietario === true; }
    // L'ospite anonimo resta in sola lettura anche per tutte le altre funzioni mutabili.
    if (myRole === 'demo' && myId === 'demo') applyDemoMode();
    if (!sonoProprietario) applySoloProprietario();
  } catch (_) {}

  themeToggle?.addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));

  // Toolbar: sort mobile + facet
  sortMobile?.addEventListener('change', () => {
    const [key, dir] = sortMobile.value.split('_').length === 2
      ? [sortMobile.value.split('_')[0], sortMobile.value.split('_')[1]] : ['prezzo', 'asc'];
    sortState = { key, dir };
    renderResults(currentResults);
  });
  facetChipsEl?.addEventListener('click', e => {
    const chip = e.target.closest('.facet-chip'); if (!chip) return;
    // Il chip dell'IVA e' un interruttore, non un raggruppamento: non deve azzerare `groupDim`.
    if (chip.dataset.iva) { soloIva = !soloIva; renderResults(currentResults); return; }
    groupDim = chip.dataset.dim || '';
    renderResults(currentResults);
  });
  document.getElementById('vistaChips')?.addEventListener('click', e => {
    const chip = e.target.closest('.facet-chip'); if (!chip) return;
    vista = chip.dataset.vista === 'schede' ? 'schede' : 'lista';
    try { localStorage.setItem('amrVista', vista); } catch (_) {}
    // Il default cambia con la vista (vedi colsDefault), ma solo se non l'hai gia' deciso tu.
    if (!colsToccate) { visibleCols = colsDefault(lastSearchParams); syncColMenu(); }
    renderResults(currentResults);
  });
  // Menu "Colonne": toggle colonne opzionali (anno/km/carb/cv) live.
  document.querySelectorAll('.col-toggle').forEach(cb => cb.addEventListener('change', () => {
    visibleCols = OPTIONAL_COLS.filter(k => document.querySelector(`.col-toggle[value="${k}"]`)?.checked);
    colsToccate = true;   // da qui in poi comandi tu, anche cambiando vista
    ridisegnaTenendoAperti();
  }));
  renderPriceMenuV();   // menu "Prezzo €" (Commissione/Spese/Margine/IVA) nella toolbar veicoli
  // riposiziona il dropdown "Prezzo €" all'apertura (delegato → sopravvive ai re-render)
  document.addEventListener('click', e => {
    const sum = e.target.closest('.price-menu > summary');
    if (!sum) return;
    requestAnimationFrame(() => { const det = sum.parentElement; if (det && det.open) positionPriceMenu(det); });
  });
  // Scheda veicolo: collapse + cambio generazione/motorizzazione. I gestori stanno sulla
  // GRIGLIA e non sul contenitore della scheda, perche' quel contenitore ora si sposta —
  // vive nel pannello dell'annuncio che ha chiesto la scheda. La delega sopravvive.
  const vehSchedaEl = resultsGrid;
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
    // Nessun bottone "Calcola": provincia e km/anno ricalcolano da soli mentre li cambi.
    // Il bottone era nato perche' la cifra grande restava indietro, ma quello era un
    // difetto (aggiornava un elemento che non esisteva piu'), non una mancanza.
    const prova = e.target.closest('.veh-mis-cand');   // una prova moto dell'elenco → aprila
    if (prova) { vehProvaCarica(prova.dataset.prova); return; }
    const grpHead = e.target.closest('.veh-grp-head');   // sezione accordion interna
    if (grpHead) {
      const grp = grpHead.parentElement;
      grp.classList.toggle('veh-collapsed');
      // ADD ON ricorda se e' aperto: il ricalcolo del costo ridisegna il corpo della
      // scheda, e senza memoria il gruppo si richiudeva sotto le mani.
      if (grp.dataset.addon) vehAddonAperto = !grp.classList.contains('veh-collapsed');
      return;
    }
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
    } else if (e.target.classList.contains('veh-carb-prov')) {   // provincia: cambia il prezzo al litro
      salvaPref('amrCarbProvincia', e.target.value);
      vehCostoAggiorna();          // l'indice ha già tutte le province: nessuna richiesta
    }
  });
  // km/anno a mano: si aggiorna a ogni tasto SENZA ridisegnare, altrimenti il campo perde il
  // fuoco a metà del numero. Si riscrivono solo le cifre già a schermo.
  // Mentre si scrive, un valore incompleto (il "2" di 23456) NON deve far ballare la cifra:
  // si aggiorna solo su valori utilizzabili, e il campo fuori scala lo segnala il browser da
  // sé (min/max nativi). Al termine (blur) un valore inservibile viene buttato, così non
  // resta spazzatura in localStorage da una sessione all'altra.
  vehSchedaEl?.addEventListener('input', e => {
    if (!e.target.classList.contains('veh-carb-km')) return;
    const n = carbKmValido(e.target.value);
    if (!(n >= KM_MIN && n <= KM_MAX)) return;
    salvaPref('amrCarbKm', String(n));
    vehCostoAggiorna();
  });
  vehSchedaEl?.addEventListener('change', e => {
    if (!e.target.classList.contains('veh-carb-km')) return;
    const n = carbKmValido(e.target.value);
    if (n >= KM_MIN && n <= KM_MAX) return;
    salvaPref('amrCarbKm', '');
    renderVehBody();                      // il campo torna al valore usato davvero
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
  /**
   * IL RIDIMENSIONAMENTO NON DEVE COSTARE QUELLO CHE STAI LEGGENDO.
   *
   * Qui si ridisegnava la griglia a OGNI resize, e `renderResults` rifa' l'innerHTML:
   * spariva il pannello dell'annuncio aperto e, dentro, la scheda tecnica — con la
   * motorizzazione scelta, l'ADD ON aperto, il conto del passaggio gia' fatto. Bastava
   * allargare la finestra di un centimetro.
   *
   * Due cose: (1) si ridisegna solo quando la larghezza cambia DAVVERO la griglia, cioe'
   * quando si attraversa la soglia dei 1180px (sotto, carburante e CV non sono colonne);
   * (2) quando serve davvero, i pannelli aperti si riaprono da soli — `toggleDetail` passa
   * da `renderDetailInto`, che riaggancia la scheda quando l'annuncio e' il suo ospite.
   */
  let _layoutPrec = effVisibleCols().join(',');
  window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(() => {
    const ora = effVisibleCols().join(',');
    // Si ridisegna solo quando la larghezza cambia DAVVERO la griglia: sotto i 1180
    // carburante e CV non sono colonne, sopra si'. Ogni altro resize non tocca niente.
    if (searchActive && ora !== _layoutPrec) { _layoutPrec = ora; ridisegnaTenendoAperti(); }
    if (!cmatrixPanel.classList.contains('d-none')) renderMatrix();   // tabella↔card attraversando il breakpoint
  }, 200); });

  // "Carica altri annunci": il collegamento era andato perso insieme alla sezione registri
  // (8f3501e). Il bottone c'era, la funzione c'era, il clic non arrivava a nessuno.
  document.getElementById('caricaAltri')?.addEventListener('click', e => {
    if (e.target.closest('button')) caricaAltri();
  });
  // SI ESPORTA QUELLO CHE SI STA GUARDANDO. `currentResults` e' tutto lo scaricato: con il
  // cursore del prezzo stretto, il CSV e il PDF uscivano con annunci e statistiche di un
  // insieme diverso da quello a schermo — e sono i documenti che escono di mano.
  // Zero a schermo = zero da esportare. Un file con la sola intestazione sarebbe ambiguo.
  const daEsportare = () => { const v = risultatiAVista(); if (!v.length) { showError('Niente da esportare: a schermo non c\'e\' nessun annuncio.'); return null; } return v; };
  btnStatCsv.addEventListener('click', () => { const v = daEsportare(); if (v) exportCsv(v); });
  btnStatPdf.addEventListener('click', () => { const v = daEsportare(); if (v) exportPdf(v); });
  errorClose.addEventListener('click', hideError);
  backToSearch.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await doSearch();
  });

  // Nav primaria Auto/Moto: il radio nascosto resta la sorgente del tipo.
  document.getElementById('modeToggle')?.addEventListener('click', e => {
    const btn = e.target.closest('.mode-btn'); if (!btn) return;
    selectPrimary(btn.dataset.mode);
  });

  // Confronto / matrice
  compareOpen?.addEventListener('click', () => openCompareMatrix());
  compareClear?.addEventListener('click', () => { confronto = []; renderResults(currentResults); renderCompareBar(); closeMatrix(); });
  cmatrixClose?.addEventListener('click', closeMatrix);

  // Segnalazioni (bug-report)
  document.getElementById('btnReport')?.addEventListener('click', () => openReport());
  searchAlerts?.addEventListener('click', e => {
    const btn = e.target.closest('[data-search-alert]');
    if (!btn || !searchAlerts.contains(btn)) return;
    const i = Number(btn.dataset.searchAlert);
    if (!Number.isInteger(i) || !searchAlertTexts[i]) return;
    openReport(searchAlertTexts[i]);
  });
  searchAlerts?.addEventListener('toggle', () => { if (searchAlerts.open) requestAnimationFrame(positionSearchAlertMenu); });
  document.getElementById('reportClose')?.addEventListener('click', closeReport);
  document.getElementById('reportSend')?.addEventListener('click', submitReport);
  document.getElementById('reportModal')?.addEventListener('click', e => { if (e.target.id === 'reportModal') closeReport(); });

  // Le preferenze di prezzo dei veicoli restano sincronizzate con l'account.
  mieiCarica().catch(e => console.warn('[miei] caricamento saltato:', e && e.message));

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
    // Azioni nel pannello dettaglio; "Apri annuncio" è un <a> nativo.
    if (row.dataset.detail) {
      if (e.target.closest('.btn-confronta')) { toggleConfronto(url); return; }
      // Passaggio di proprieta': si calcola su richiesta, sui dati di QUESTO annuncio.
      if (e.target.closest('.btn-passaggio')) { const r = trovaResult(url); if (r) calcolaPassaggio(r, row); return; }
      // Scambio provincia (tua / del venditore): stessa pratica, importo diverso.
      const alt = e.target.closest('.det-pass-alt');
      if (alt) {
        const r = trovaResult(url);
        if (r) { r._passProvAnnuncio = alt.dataset.alt === 'annuncio'; calcolaPassaggio(r, row); }
        return;
      }
      // Cerchi e gomme: marca, modello e anno li ha gia' l'annuncio, ma la richiesta
      // parte solo se la chiedi — e' rete, come il passaggio di proprieta'.
      if (e.target.closest('.btn-gomme')) { const r = trovaResult(url); if (r) caricaGomme(r, row); return; }   // `row` qui E' il pannello (ramo dataset.detail)
      // Una misura cliccata apre (o chiude) l'etichetta europea di quella gomma.
      const mis = e.target.closest('.gom-mis');
      if (mis) { const r = trovaResult(url); if (r) caricaPneumatico(r, mis.dataset.misura, row); return; }
      // "Scheda tecnica": la carica dentro QUESTO annuncio. Deve stare QUI DENTRO, prima
      // del `return` che ignora il resto: fuori non ci arriva mai un click del pannello.
      const apri = e.target.closest('.det-scheda-apri');
      if (apri) { const r = trovaResult(url); if (r) loadVehScheda(r, apri.parentElement); return; }
      return;   // altri click nel pannello: ignora
    }
    if (e.target.closest('.row-thumb')) {
      const r = trovaResult(url);
      if (r && Array.isArray(r.immagini) && r.immagini.length) openLightbox(r.immagini);
      return;
    }
    const avviso = e.target.closest('.btn-avvisi');
    if (avviso) { alternaAvvisi(avviso); return; }
    // Mobile: tap sulla riga (non sulla thumb) → apre il dettaglio (azioni dentro). Desktop: titolo→annuncio, bottoni espliciti.
    if (window.matchMedia('(max-width: 860px)').matches) { toggleDetail(row); return; }
    if (e.target.closest('.row-titolo')) { openAd(url); return; }
    if (e.target.closest('.btn-confronta'))  { toggleConfronto(url); return; }
    if (e.target.closest('.btn-info'))       { toggleDetail(row); return; }
  });
  resultsGrid.addEventListener('pointerover', e => {
    const btn = e.target.closest('.btn-avvisi');
    if (btn) mostraAvvisi(btn);
  });
  resultsGrid.addEventListener('pointerout', e => {
    if (e.target.closest('.btn-avvisi') && !e.relatedTarget?.closest?.('.btn-avvisi')) nascondiAvvisi();
  });
  resultsGrid.addEventListener('focusin', e => {
    const btn = e.target.closest('.btn-avvisi');
    if (btn) mostraAvvisi(btn);
  });
  resultsGrid.addEventListener('focusout', e => {
    if (e.target.closest('.btn-avvisi')) nascondiAvvisi();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('.btn-avvisi')) nascondiAvvisi(true);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') nascondiAvvisi(true);
  });
  document.addEventListener('scroll', () => nascondiAvvisi(true), true);

  // Sezioni richiudibili dentro il pannello annuncio. `toggle` non risale il DOM: cattura.
  resultsGrid.addEventListener('toggle', e => miniToggle(e, (cosa, d) => {
    const pan = d.closest('[data-detail]');
    const r = pan && trovaResult(pan.dataset.url);
    if (!r || !pan) return;
    // Il gruppo "Passaggi di proprieta" ha due meta': quanto costa girare QUESTO veicolo, e
    // quanto gira il MODELLO. Nessuna delle due parte da sola: si chiedono all'apertura.
    if (cosa === 'pass' && !r._pass) calcolaPassaggio(r, pan);
    if (cosa === 'pass') liqAnnCarica(r);
    if (cosa === 'gomme' && !r._gomme) caricaGomme(r, pan);
    // I blocchi della SCHEDA TECNICA dichiaravano `carica:` da sempre, ma chi li ascoltava
    // era il vecchio contenitore fisso: da quando la scheda vive dentro l'annuncio, aprire
    // "Richiami" o "Targa" non faceva partire niente. Stessa famiglia del costo carburante.
    if (cosa === 'richiami' && !vehRichiami) vehRichiamiCarica();
    if (cosa === 'misure' && !vehMisure) vehMisureCarica();
  }), true);

  // Spunta "veicolo storico" dentro il pannello di un annuncio: cambia la tariffa, si rifa' il conto.
  resultsGrid.addEventListener('change', e => {
    // La TUA provincia per il passaggio. Cambiandola, i conti gia' fatti sugli altri annunci
    // sono di un'altra provincia: si buttano, cosi' riaprendoli si rifanno invece di mostrare
    // un importo vecchio sotto una sigla nuova.
    if (e.target.classList.contains('pp-prov-sel')) {
      salvaPref('amrPassProvincia', e.target.value);
      for (const x of currentResults) if (x._pass && !x._passProvAnnuncio) delete x._pass;
      const rw = e.target.closest('[data-url]');
      const rr = rw && trovaResult(rw.dataset.url);
      if (rr) calcolaPassaggio(rr, rw);
      return;
    }
    const storico = e.target.classList.contains('pass-storico-chk');
    const iva = e.target.classList.contains('pass-iva-chk');
    if (!storico && !iva) return;
    const row = e.target.closest('[data-url]'); if (!row) return;
    const r = trovaResult(row.dataset.url); if (!r) return;
    if (storico) r._passStorico = e.target.checked; else r._passIva = e.target.checked;
    calcolaPassaggio(r, row);
  });

  // Delegation: confronto (rimuovi colonna/card) — sul wrapper, vale per tabella E card.
  cmatrixBody.addEventListener('click', e => {
    const rm = e.target.closest('.cm-rm'); if (rm) { removeMatrixCol(rm.dataset.url); return; }
  });

  // Filtri avanzati toggle
  advancedToggle?.addEventListener('click', () => {
    const open = advancedFilters.classList.toggle('d-none');
    advancedToggle.setAttribute('aria-expanded', String(!open));
    advancedToggle.classList.toggle('open', !open);
    // LE TENDINE MANCANTI SI RIPROVANO QUI. /api/filtri-auto parte una volta al boot: se
    // in quel momento la rete (o il server in riavvio) non rispondeva, il pannello
    // restava SENZA Carrozzeria/Cambio/Alimentazione per tutta la sessione — un intoppo
    // di un secondo diventava un pannello monco per sempre. Stessa regola di loadModels:
    // il fallimento non si memorizza, all'apertura si riprova.
    if (!open && !filtriAutoNomi.length) caricaFiltriAuto();
    // e la griglia auto segue il pannello: aperto+auto = visibile (la regola sta la')
    sincronizzaFiltriAuto(currentTipo());
  });

  // Logo → RICARICA. Prima apriva un QR per aprire l'app dal telefono: da dentro l'app non
  // serve (sei gia' davanti allo schermo), e il logo e' il posto dove si clicca aspettandosi
  // di tornare a casa. Il QR resta sulla pagina di accesso, dove ha senso.
  // Il modo si ricorda, quindi ricaricando si torna nella sezione dove si stava.
  logoBtn?.addEventListener('click', () => location.reload());

  // Il bottone della targa compare solo quando una targa c'e' davvero: un comando che non
  // puo' funzionare e' peggio di nessun comando.
  const targaInput = document.getElementById('targaFiltro');
  const targaBtn = document.getElementById('targaVai');
  // Serve UNA TARGA E DEGLI ANNUNCI A SCHERMO: la verifica vive dentro la scheda tecnica
  // di un annuncio, quindi prima della ricerca non ha dove andare. Mostrarlo comunque
  // significava offrire un comando che risponde solo con un errore.
  /**
   * LA VERIFICA TARGA NON DIPENDE DALLA RICERCA.
   *
   * Il bottone compariva solo con annunci a schermo. Ma la targa non filtra niente: e' del
   * veicolo che hai davanti — te l'ha data un cliente al telefono, l'hai letta su un
   * parabrezza — e la verifica va al Portale dell'Automobilista, che con la ricerca non
   * c'entra. Legarla ai risultati significava che per controllare una targa bisognava prima
   * fare una ricerca di auto che non serviva a niente. Adesso basta scriverla.
   */
  targaBtnSync = () => {
    const t = String(targaInput?.value || '').replace(/[^A-Za-z0-9]/g, '');
    targaBtn?.classList.toggle('d-none', t.length < 5);
  };
  targaInput?.addEventListener('input', targaBtnSync);
  targaBtnSync();
  targaBtn?.addEventListener('click', () => tgApriModale());
  // Comandi DENTRO la finestra: gli stessi id del blocco in ADD ON, quindi i gestori si
  // agganciano alla finestra e non al documento — senno' un clic qui finirebbe all'altro.
  const tgModal = document.getElementById('targaModal');
  document.getElementById('targaClose')?.addEventListener('click', tgChiudiModale);
  tgModal?.addEventListener('click', e => { if (e.target === tgModal) tgChiudiModale(); });
  tgModal?.addEventListener('click', e => {
    if (e.target.closest('#tgVai')) return tgVerifica();
    if (e.target.closest('#tgCambia') || e.target.closest('#tgRiprova')) return tgNuovaSfida();
  });
  tgModal?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'tgCaptcha') { e.preventDefault(); tgVerifica(); }
  });
  document.getElementById('btnReportNav')?.addEventListener('click', () => openReport());   // p4: Segnala in navbar
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeReport(); tgChiudiModale(); } });

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

// `${tipo}` → [{da, a}]: i nomi NASCOSTI dalla tendina e la gemella che li accoglie
// («vespa» → Piaggio). Arrivano da /api/brands insieme all'elenco: chi digita il nome
// che non c'e' piu' non trova un buco, trova la marca giusta.
const brandSinonimi = {};
async function populateMarca(tipo) {
  if (!brandCache[tipo]) {
    try {
      const res = await fetch(`/api/brands?tipo=${encodeURIComponent(tipo)}`);
      if (!res.ok) return;                       // review: non cachare su errore (sennò marca rotta per sempre)
      const data = await res.json();
      brandCache[tipo] = data.brands || [];
      brandSinonimi[tipo] = data.sinonimi || [];
    } catch { /* transitorio: lascia brandCache[tipo] undefined → ritenta al prossimo giro */ }
  }
}
