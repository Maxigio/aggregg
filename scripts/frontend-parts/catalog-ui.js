
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
    // la lista ora e' INTERA e scorre: l'evidenziato deve restare in vista mentre si naviga
    list.querySelector('.ac-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = i => { if (matches[i]) { marcaSelect.value = matches[i].nome; close(); validateMarca(); if (modelloSelect) modelloSelect.value = ''; resetModelloVersione(); document.getElementById('modello')?.focus(); } };

  /**
   * TUTTE LE VOCI, NON UN ASSAGGIO. C'era `slice(0, 8)`: la tendina mostrava otto marche
   * con la scrollbar, e chi scorreva credeva di aver visto l'elenco — le altre esistevano
   * solo se indovinavi le prime lettere. In una force-select l'elenco consultabile E'
   * il contratto: si mostra tutto (la lista scorre da sola, max-height nel CSS) e a campo
   * vuoto si apre l'elenco completo, come per il modello.
   */
  const compute = () => {
    const q = acn(marcaSelect.value);
    const brands = brandCache[currentTipo()] || [];
    if (q) {
      // Ranking: prefisso prima del semplice "contiene", poi posizione, poi alfabetico.
      // I SINONIMI valgono come il nome: «vespa» non e' piu' in tendina (vive sotto
      // Piaggio, decisione del proprietario) ma chi lo digita deve trovare Piaggio,
      // non un elenco vuoto.
      const perGemella = new Map();
      for (const s of (brandSinonimi[currentTipo()] || [])) {
        const g = acn(s.a);
        if (!perGemella.has(g)) perGemella.set(g, []);
        perGemella.get(g).push(acn(s.da));
      }
      const scored = [];
      for (const b of brands) {
        const n = acn(b.nome);
        let best = -1, prefisso = false;
        for (const cand of [n, ...(perGemella.get(n) || [])]) {
          const j = cand.indexOf(q);
          if (j < 0) continue;
          if (best < 0 || j < best) best = j;
          if (cand.startsWith(q)) prefisso = true;
        }
        if (best >= 0) scored.push({ b, rank: prefisso ? 0 : 1, i: best, n });
      }
      scored.sort((a, c) => a.rank - c.rank || a.i - c.i || a.n.localeCompare(c.n));
      matches = scored.map(s => s.b);
    } else matches = brands;
    active = matches.length ? 0 : -1;
    render(); validateMarca();
  };
  marcaSelect.addEventListener('input', () => { resetModelloVersione(); compute(); });
  marcaSelect.addEventListener('focus', compute);
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
      // Stessa regola del catch qui sotto, e per lo stesso motivo: un 401 (sessione
      // scaduta), un 429 o un 503 rispondono un JSON SENZA `modelli`, e il `|| []`
      // cacheava «questa marca non ha modelli» per tutta la sessione. Non e' un catalogo
      // vuoto: e' una risposta che non abbiamo ottenuto. Stesso guard di populateMarca.
      if (!res.ok) return [];
      const data = await res.json();
      modelCache[key] = data.modelli || [];
    } catch (_) {
      // UNA RISPOSTA MANCATA NON E' "QUESTA MARCA NON HA MODELLI". Qui si scriveva `[]` in
      // cache, e da li' in poi la tendina di quella marca restava vuota per TUTTA la
      // sessione: un intoppo di rete di un secondo si trasformava in un catalogo assente
      // fino al ricaricamento della pagina. Non si memorizza il fallimento: al tasto dopo
      // si riprova.
      return [];
    }
  }
  return modelCache[key];
}

// Una scelta vuota non equivale a una ricerca generale: per quella c'e' una voce esplicita.
const VERSIONE_NESSUNA = 'Nessuna Versione';
const senzaVersione = valore => acn(valore) === acn(VERSIONE_NESSUNA);
function sceltaVersione(valore, modelloScelto) {
  const testo = String(valore || '').trim();
  if (!testo) return { errore: 'Scegli una versione oppure Nessuna Versione prima di cercare.' };
  if (senzaVersione(testo)) return { versione: null };
  if (!modelloScelto) return { errore: 'Per cercare una versione specifica, scegli prima il modello dalla lista.' };
  return { versione: testo.slice(0, 80) };
}
function resetVersioneOnly() {
  if (versioneInput) versioneInput.value = '';
  syncVersione();
}
function resetModelloVersione() { selectedModel = null; resetVersioneOnly(); }

/**
 * La ricerca generale richiede «Nessuna Versione», anche senza modello. Una versione
 * specifica si puo' scrivere solo dopo aver scelto un modello dalla lista: doSearch
 * verifica la scelta prima di inviare una richiesta che altrimenti ignorerebbe il testo.
 */
function syncVersione() {
  if (!versioneInput) return;
  versioneInput.placeholder = selectedModel
    ? 'Scegli una versione o Nessuna Versione'
    : 'Seleziona Nessuna Versione o scegli un modello';
}

/**
 * Scelto un modello: si svuota la versione scritta prima (era di un altro modello) e si
 * tiene da parte la famiglia Moto.it, che serve a tradurre il testo in un codice.
 * Il campo e' sempre a schermo: qui non c'e' piu' niente da mostrare.
 */
function mostraVersione(model) {
  if (versioneInput) versioneInput.value = '';
  if (selectedModel) selectedModel._familySlug = model.slugMotoIt || null;
  syncVersione();
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
    list.querySelector('.ac-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const pickModel = async (m) => {
    selectedModel = { ...m, _marca: matchedBrand()?.nome || '' };
    modelloSelect.value = m.nome; close();
    mostraVersione(m);
  };
  const compute = async () => {
    const brand = matchedBrand();
    // testo cambiato a mano → annulla la scelta strutturata (no ID stantii)
    if (!selectedModel || acn(selectedModel.nome) !== acn(modelloSelect.value)) { selectedModel = null; resetVersioneOnly(); }
    if (!brand) { matches = []; return close(); }
    const models = await loadModels(currentTipo(), brand.nome);
    const q = acn(modelloSelect.value);
    // TUTTE le voci, non le prime dieci: c'era `slice(0, 10)` su entrambi i rami, e la
    // scrollbar faceva credere di star scorrendo l'elenco intero mentre ne mostrava un
    // assaggio. La lista scorre da sola (max-height nel CSS).
    if (q) {
      const scored = [];
      for (const m of models) { const n = acn(m.nome); const i = n.indexOf(q); if (i >= 0) scored.push({ m, rank: n.startsWith(q) ? 0 : 1, i, n }); }
      scored.sort((a, c) => a.rank - c.rank || a.i - c.i || a.n.localeCompare(c.n));
      matches = scored.map(s => s.m);
    } else matches = models;
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

/**
 * LA TENDINA DELLA VERSIONE (richiesta del proprietario, 2026-08-08): come marca e
 * modello, testo libero + elenco consultabile. La differenza di contratto resta: qui
 * scegliere NON seleziona un id — riempie il testo, che va alle fonti com'e'. I
 * suggerimenti sono i nomi-versione del catalogo Subito per la famiglia scelta
 * (/api/versioni, disco): se la famiglia non c'e', la tendina resta vuota e il campo
 * e' testo libero puro, come prima.
 */
const versioniCache = {};   // `${tipo}|${marca}|${modello}` → [nomi]
async function loadVersioni() {
  if (!selectedModel) return [];
  const marca = selectedModel._marca || (marcaSelect && marcaSelect.value) || '';
  const key = `${currentTipo()}|${marca}|${selectedModel.nome}`;
  if (!versioniCache[key]) {
    try {
      const res = await fetch(`/api/versioni?tipo=${encodeURIComponent(currentTipo())}&marca=${encodeURIComponent(marca)}&modello=${encodeURIComponent(selectedModel.nome)}`);
      // stesso guard di loadModels: una risposta mancata non e' «questo modello non ha
      // versioni» — non si memorizza il fallimento, al tasto dopo si riprova
      if (!res.ok) return [];
      const data = await res.json();
      versioniCache[key] = data.versioni || [];
    } catch (_) { return []; }
  }
  return versioniCache[key];
}

function setupVersioneAutocomplete() {
  const list = document.getElementById('versioneAC');
  if (!versioneInput || !list) return;
  let matches = [], active = -1;
  const close = () => { list.classList.add('d-none'); list.innerHTML = ''; active = -1; versioneInput.setAttribute('aria-expanded', 'false'); };
  const render = () => {
    if (!matches.length) return close();
    list.innerHTML = matches.map((v, i) => `<li class="ac-item${i === active ? ' active' : ''}" role="option" data-i="${i}">${escapeHtml(v)}</li>`).join('');
    list.classList.remove('d-none'); versioneInput.setAttribute('aria-expanded', 'true');
    list.querySelector('.ac-item.active')?.scrollIntoView({ block: 'nearest' });
  };
  const pick = i => { if (matches[i] != null) { versioneInput.value = matches[i]; close(); } };
  const compute = async () => {
    const versioni = selectedModel ? await loadVersioni() : [];
    const q = acn(versioneInput.value);
    const opzioni = [VERSIONE_NESSUNA, ...versioni.filter(v => !senzaVersione(v))];
    if (q) {
      const scored = [];
      for (const v of opzioni) { const n = acn(v); const i = n.indexOf(q); if (i >= 0) scored.push({ v, rank: n.startsWith(q) ? 0 : 1, i, n }); }
      scored.sort((a, c) => a.rank - c.rank || a.i - c.i || a.n.localeCompare(c.n));
      matches = scored.map(s => s.v);
    } else matches = opzioni;   // la ricerca generale resta selezionabile anche senza modello
    active = matches.length ? 0 : -1; render();
  };
  versioneInput.addEventListener('input', compute);
  versioneInput.addEventListener('focus', compute);
  versioneInput.addEventListener('keydown', e => {
    if (list.classList.contains('d-none') || !matches.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % matches.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + matches.length) % matches.length; render(); }
    else if (e.key === 'Enter') { if (active >= 0) { e.preventDefault(); pick(active); } }
    else if (e.key === 'Tab') { if (active >= 0) pick(active); }
    else if (e.key === 'Escape') { close(); }
  });
  list.addEventListener('mousedown', e => { const li = e.target.closest('.ac-item'); if (li) { e.preventDefault(); pick(+li.dataset.i); } });
  versioneInput.addEventListener('blur', () => setTimeout(close, 150));
}
