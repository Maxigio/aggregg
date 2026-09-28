// ─── Pre-fill da URL params ───────────────────────────────────────────────────
// Torna true se l'URL ha davvero pilotato l'app: in quel caso il modo salvato non deve
// scavalcare cio' che l'utente ha chiesto col link.
async function applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has('marca')) return false;
  // Solo i due valori che esistono: qualunque altra cosa nell'URL (compreso un `"` che farebbe
  // lanciare querySelector e abortire init()) ricade su 'auto'.
  const tipo = p.get('tipo') === 'moto' ? 'moto' : 'auto';
  const tipoInput = document.querySelector(`input[name="tipo"][value="${tipo}"]`);
  if (tipoInput) {
    tipoInput.checked = true; document.body.dataset.tipo = tipo;
    // La barra primaria e' l'unico indicatore visibile (il seg-toggle radio e' nascosto):
    // senza questa riga, arrivando da un link ?tipo=moto l'app cercava moto mentre "Auto"
    // restava evidenziato. Stessa riga di selectPrimary, che qui non viene chiamato.
    document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === tipo));
  }
  // La porta dall'URL non passa dal change del radio: arrivando da ?tipo=moto le otto
  // tendine auto restavano a schermo, e la ricerca le buttava in silenzio.
  sincronizzaFiltriAuto(tipo);
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
    // Un link di ricerca precedente alla scelta obbligatoria della versione esprime una
    // ricerca generale: il replay lo rende esplicito senza chiedere un clic aggiuntivo.
    if (isValidMarca()) { versioneInput.value = VERSIONE_NESSUNA; doSearch(); }
  }
  return true;
}

// Ripristino dell'area di lavoro. Si applica solo a un modo valido e diverso dal predefinito:
// un valore sporco in localStorage non deve poter bloccare l'app fuori dalla ricerca.
/** Una modalita' esiste per l'utente solo se ha il suo bottone nella barra. */
const modoRaggiungibile = m => !!m && !!document.querySelector(`#modeToggle .mode-btn[data-mode="${CSS.escape(m)}"]`);

/** Quello che si era salvato l'ultima volta. Non lancia: localStorage puo' essere negato. */
function modoSalvato() {
  try { return localStorage.getItem('amrModoTipo'); }
  catch (_) { return null; }
}

/**
 * LO STATO VISIBILE, SUBITO — prima di ogni richiesta di rete.
 *
 * Mette a posto tre cose che altrimenti restano su Auto per tutta la durata del primo
 * caricamento: il radio del tipo, l'attributo del body e il bottone acceso nella barra.
 * Cosi' `populateMarca` scarica il catalogo GIUSTO, uno solo (prima ne scaricava due:
 * auto e poi quello vero), e chi lavora in Moto non vede piu' l'app passare da Auto.
 *
 * Il catalogo verra' caricato dopo; qui si tocca solo cio' che si vede.
 */
function preImpostaModo() {
  const t = modoSalvato();
  if (t === 'moto') { const r = document.getElementById('tipoMoto'); if (r) r.checked = true; }
  const bottone = t === 'moto' ? 'moto' : 'auto';
  if (modoRaggiungibile(bottone)) {
    document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === bottone));
  }
}

function ripristinaModo() {
  if (modoSalvato() === 'moto' && modoRaggiungibile('moto')) selectPrimary('moto');
}

// ─── Avvio ────────────────────────────────────────────────────────────────────
init();
