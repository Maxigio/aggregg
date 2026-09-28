// ─── Scheda tecnica veicolo (auto-data.net) — highlighted, collassabile, sopra gli annunci ──
/**
 * DOVE VIVE LA SCHEDA TECNICA. Era un contenitore fisso sopra la griglia dei risultati:
 * una scheda per RICERCA, che valeva per "il modello cercato" e per nessuno degli annunci
 * sotto — e con la versione diventata un campo libero non valeva piu' nemmeno per quello.
 *
 * Ora vive dentro il pannello dell'annuncio che l'ha chiesta. La scheda e' la stessa,
 * intera: generazioni, motorizzazioni, unita', confronto, export, ADD ON. Cambia solo
 * l'elemento su cui si disegna, e da dove prende i vincoli — vedi loadVehScheda.
 *
 * UNA SOLA ALLA VOLTA, perche' lo stato (vehData/vehSelUrl/vehSpecs/vehXf) e' unico:
 * aprirla su un altro annuncio la sposta li'. E' il comportamento di prima, con un
 * padrone diverso.
 */
let vehHost = null;                    // il .det-scheda del pannello che ospita la scheda
let vehHostUrl = null;                 // di quale annuncio e'
const vehEl = () => (vehHost && vehHost.isConnected) ? vehHost : null;
let vehData = null, vehSpecs = {}, vehSchedaCollapsed = false, vehSelUrl = null, vehGen = 0;   // vehGen: token anti-race — scarta risposte di ricerche/generazioni superate
/**
 * LA RISPOSTA E' VECCHIA, e chi la scarta deve anche DISFARE L'ATTESA che aveva messo.
 *
 * Ogni blocco che carica scrive prima `{loading:true}`, poi controlla il token e, se un'altra
 * scheda ha preso il posto, esce. Uscendo e basta lasciava l'attesa scritta: cambiando
 * generazione mentre ADD ON stava caricando, "Cerco nei due archivi…" restava li' per
 * sempre — e non ripartiva, perche' proprio quello stato non-nullo dice "sto gia' caricando".
 * `switchVehGen` incrementa il token senza toccare i blocchi, quindi il caso non e' raro.
 *
 * La regola: chi scarta AZZERA. Il blocco torna a "Apri per cercare", e riaprendolo riparte.
 */
const scartata = my => my !== vehGen;
let vehErrore = null;   // perche' la scheda non si e' potuta fare: si scrive, non si tace
// Il modello con cui la scheda e' stata CHIESTA. Dopo aver scelto una generazione,
// `vehData.modello` diventa il nome di quella ("Golf Cabriolet"): cercare le prove con
// quello non trovava niente, mentre il modello vero ("Golf") le trova tutte.
let vehModelloBase = '';
// Quando le candidate sono LO STESSO MOTORE: il server lo calcola sull'annuncio, e la griglia
// lo scrive invece di mostrare quattordici righe che si distinguono per il cambio.
let vehStessoMotore = null;
// Quante generazioni del catalogo non si sono lasciate leggere mentre il server deduceva la
// motorizzazione di QUESTO annuncio: il numero lo manda lui (`genNonLette`), qui si mostra.
let vehElencoMonco = 0;
function clearVehScheda() { vehGen++; vehData = null; vehErrore = null; vehSpecs = {}; vehSelUrl = null; vehXf.compare = null; vehXf.q = ''; vehRichiami = null; vehOmoStato = {}; vehMisure = null; vehProva = null; vehStessoMotore = null; vehElencoMonco = 0; vehAddonAperto = false; const el = vehEl(); if (el) el.innerHTML = ''; vehHost = null; vehHostUrl = null; }   // vehGen++ invalida le fetch in volo; i richiami sono del veicolo cercato, non si tengono

/**
 * LA SCHEDA CHE NON SI PUO' FARE LO DEVE DIRE.
 *
 * Prima ogni strada senza uscita finiva in `clearVehScheda()`: il bottone spariva, non
 * compariva niente al suo posto, e il pannello sembrava rotto. Peggio, al primo ridisegno
 * (bastava aprire il passaggio di proprieta') il bottone tornava, si ricliccava, e si
 * ripartiva da capo. Hai premuto tu: la risposta arriva, anche quando e' un no.
 */
/**
 * IL MODELLO SECONDO L'ANNUNCIO — ed e' l'ULTIMA scelta, non la prima.
 *
 * Le fonti non chiamano il modello come lo chiama il catalogo tecnico: misurato su una
 * ricerca vera, la stessa BMW e' "Serie 3 (E90/91)" su Subito, "320" su Autoscout e
 * "Serie 3" nel catalogo. Facendolo vincere sul modello CERCATO, la scheda non trovava piu'
 * niente in nessuna ricerca. Vale quindi solo dove un modello cercato non c'e' — il parco di
 * un concessionario — e il codice di generazione fra parentesi si toglie.
 */
function modelloAnnuncio(r) {
  const m = (r && (r.modello || r.modelloDichiarato)) || '';
  return String(m).replace(/\s*\(.*$/, '').trim();
}

function vehFallita(motivo) {
  vehData = null; vehSpecs = {}; vehSelUrl = null;
  vehErrore = motivo || 'Scheda tecnica non disponibile per questo annuncio.';
  renderVehScheda();
}

/**
 * LA SCHEDA DI UN ANNUNCIO. Stessa scheda di prima, intera; cambiano due cose:
 *   DOVE si disegna  → nel pannello di quell'annuncio (`host`), non sopra la griglia;
 *   DA DOVE prende i vincoli → dall'annuncio, non dai filtri di ricerca. L'anno e' quello
 *     dell'auto che stai guardando, non "annoMin dei filtri", e potenza/carburante/cambio/
 *     carrozzeria servono a PRESELEZIONARE la motorizzazione invece di fartela cercare.
 *
 * La preselezione non sceglie mai fra pari: il server risponde con UNA motorizzazione solo
 * quando ne resta una sola compatibile (backend/scheda-veicolo-route.js → schedaPerAnnuncio).
 * Altrimenti si apre la griglia come sempre e scegli tu.
 */
/**
 * QUANDO L'ANNUNCIO NON DICE CHE MODELLO E'.
 *
 * La marca c'e' quasi sempre, il modello su Subito no. Indovinarlo dal titolo scritto dal
 * venditore vorrebbe dire mostrare richiami e dati tecnici di un veicolo dedotto, e
 * prendere quello CERCATO vorrebbe dire il difetto di prima. Quindi si chiede: l'elenco dei
 * modelli di quella marca e' lo stesso che serve la ricerca, e sceglierlo e' un gesto solo.
 */
async function vehChiediModello(marca, tipo, r, host) {
  const el = vehEl(); if (!el) return;
  const my = vehGen;
  el.innerHTML = `<div class="rc-group"><div class="rc-group-body">`
    + `<div class="veh-chiedi"><div class="veh-chiedi-msg">Questo annuncio non dichiara il modello: la marca è <b>${escapeHtml(marca)}</b>, il resto lo scrive il venditore nel titolo. Scegli tu il modello, così la scheda è quella giusta e non una dedotta.</div>`
    + `<select class="veh-chiedi-sel" disabled><option>Carico i modelli…</option></select></div>`
    + `</div></div>`;
  // `loadModels` e' lo stesso elenco (e la stessa cache) che serve la tendina della ricerca:
  // nessun secondo modo di chiedere i modelli di una marca.
  const modelli = await loadModels(tipo, marca);
  if (my !== vehGen) return;                     // un'altra scheda ha preso il posto
  const sel = el.querySelector('.veh-chiedi-sel');
  if (!sel) return;
  if (!modelli.length) {
    sel.outerHTML = '<div class="veh-chiedi-msg">L\'elenco dei modelli non è arrivato: riprova fra poco.</div>';
    return;
  }
  const nome = m => (typeof m === 'string' ? m : (m.nome || m.name || ''));
  sel.disabled = false;
  sel.innerHTML = '<option value="">Scegli il modello…</option>'
    + modelli.map(m => `<option value="${escapeHtml(nome(m))}">${escapeHtml(nome(m))}</option>`).join('');
  sel.addEventListener('change', () => { if (sel.value) loadVehScheda(r, host, sel.value); });
}

async function loadVehScheda(r, host, modelloScelto) {
  if (!host) return;
  /**
   * LA SCHEDA SI SPOSTA, E QUELLA DI PRIMA DEVE ANDARSENE DALLO SCHERMO.
   *
   * Lo stato della scheda e' unico (vehData/vehSelUrl/vehSpecs) e i gestori stanno in delega
   * sulla GRIGLIA: nessuno di loro sa da quale pannello arriva il clic. Lasciando il markup
   * nel pannello precedente — che non si ridisegna da solo, `renderDetailInto` gli ha gia'
   * messo `dataset.loaded='1'` — restava a schermo una scheda morta ma cliccabile, che
   * pilotava quella VIVA: una card delle motorizzazioni della Panda finiva sotto
   * l'intestazione della BMW (specifiche, consumo, costo carburante), e «Esporta» premuto
   * li' scaricava la scheda dell'altro annuncio.
   *
   * Si riporta quel pannello al suo bottone, che e' esattamente cio' che `renderDetailInto`
   * disegna per un annuncio che non ospita la scheda: il difetto non lascia in eredita' un
   * pannello monco da cui la scheda non si puo' piu' richiedere.
   */
  if (vehHost && vehHost !== host && vehHost.isConnected) vehHost.innerHTML = '<button type="button" class="det-scheda-apri">Scheda tecnica</button>';
  vehHost = host; vehHostUrl = r ? r.url : null;
  const el = vehEl(); if (!el) return;
  const my = ++vehGen;   // invalida ogni scheda ancora in volo
  const p = lastSearchParams || {};
  // MARCA E MODELLO LI DICE L'ANNUNCIO, non la ricerca. Prima il modello veniva solo dai
  // filtri: aprendo un annuncio del parco di un concessionario — dove una ricerca non c'e'
  // mai stata — restava vuoto e la scheda si spegneva senza dire niente. Ora l'annuncio
  // porta il proprio modello (`modello` su Subito e Moto.it, `modelloDichiarato` su
  // Autoscout) e i filtri restano solo come rete.
  const tipo = (r && r.tipo) || p.tipo || currentTipo();
  if (tipo !== 'auto' && tipo !== 'moto') { vehFallita('La scheda tecnica esiste solo per auto e moto.'); return; }
  const marca = (r && r.marca) || p.marca || (matchedBrand() && matchedBrand().nome) || '';
  // Nel parco di un concessionario la ricerca precedente non c'entra: se restasse a bordo,
  // aprendo un Transit si chiederebbe la scheda della Serie 3 cercata mezz'ora prima.
  const daRicerca = (p.modello || (selectedModel && selectedModel.nome) || '');
  /**
   * IL MODELLO LO DECIDE L'ANNUNCIO, NON LA RICERCA.
   *
   * Prima l'ordine era il contrario (`daRicerca || modelloAnnuncio(r)`), e su una ricerca
   * allargata alla marca — quella in cui arrivano annunci di altri modelli, marcati — la
   * scheda si componeva sul modello CERCATO. Aprendo una Dorsoduro 750 marcata «altro
   * modello» si leggevano motorizzazioni, consumi, costo carburante, misure gomme e
   * soprattutto RICHIAMI della 1200: l'app sapeva riga per riga che quell'annuncio era un
   * altro veicolo, e proprio li' mostrava i dati di quello cercato.
   *
   * Il modello cercato resta buono quando la fonte ha CONFERMATO che l'annuncio e' quello:
   * sono i casi in cui il filtro e' passato per il catalogo della fonte. Fuori da quelli,
   * comanda cio' che l'annuncio dichiara di se'.
   */
  const NEL_BERSAGLIO = ['esatto', 'senza-versione', 'versione-non-verificata'];
  const confermato = !r || !r.dichiarazione || NEL_BERSAGLIO.includes(r.dichiarazione);
  const modello = modelloScelto || modelloAnnuncio(r) || (confermato ? daRicerca : '');
  if (!marca) { vehFallita('Questo annuncio non dichiara la marca: senza quella la scheda non si compone.'); return; }
  // Marca si', modello no: non si indovina dal titolo e non si prende quello cercato. Si
  // chiede, dicendo perche'.
  if (!modello) { vehChiediModello(marca, tipo, r, host); return; }
  // L'anno dell'ANNUNCIO. Prima era `annoMin || annoMax` dei filtri: un numero che parla
  // della ricerca, non del veicolo, e su una ricerca senza filtri era vuoto.
  const anno = (r && r.anno) || p.annoMin || p.annoMax || '';
  vehModelloBase = modello;
  vehSchedaCollapsed = false;  // l'hai aperta tu dall'annuncio: si apre
  vehXf.compare = null; vehXf.q = ''; vehXf.highlight = new Set(); vehGenChosen = false; vehShowAll = false;   // reset per ricerca (traduci/unità restano preferenze)
  vehRichiami = null; vehOmoStato = {}; vehMisure = null; vehProva = null; vehStessoMotore = null; vehElencoMonco = 0; vehAddonAperto = false;   // richiami e misure sono di QUEL veicolo: cambiando annuncio ripartono
  // La targa NON e' un parametro di ricerca: non filtra gli annunci e non va alle fonti.
  // Si legge qui e resta nel browser, cosi' non finisce nemmeno nella chiave di cache.
  targaCercata = String((document.getElementById('targaFiltro') || {}).value || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  tgReset();
  el.innerHTML = '<div class="rc-group"><div class="rc-group-body"><div class="rc-loading">Carico la scheda tecnica…</div></div></div>';
  try {
    // `res`, non `r`: dentro il `try` un `const r` avrebbe fatto ombra all'ANNUNCIO, e piu'
    // sotto la preselezione riceveva la risposta HTTP al posto del veicolo — quindi non
    // preselezionava mai niente.
    const res = await fetch(`/api/scheda-veicolo?tipo=${encodeURIComponent(tipo)}&marca=${encodeURIComponent(marca)}&modello=${encodeURIComponent(modello)}&anno=${encodeURIComponent(anno)}`);
    const d = await res.json();
    if (my !== vehGen) return;   // una ricerca più recente ha già preso il posto → non toccare la scheda
    const hasData = d.ok && (((d.generations || []).length) || ((d.motorizzazioni || []).length));
    // "Il catalogo non ha questo modello" e' un'affermazione sul catalogo: si scrive solo se
    // il catalogo ha risposto. Se non si e' lasciato leggere (403, 429, timeout, pagina di
    // transizione) il server ora lo dice, e qui si dice a chi guarda.
    if (!hasData) {
      vehFallita(d.fonteKo
        ? `Il catalogo non si e' lasciato leggere per ${marca} ${modello} — riprova tra poco.`
        : `Il catalogo non ha ${marca} ${modello}.`);
      return;
    }
    // NIENTE auto-selezione per DEDUZIONE: l'utente sceglie generazione → motorizzazione.
    // UNICA eccezione: la versione Moto.it che l'utente ha scelto LUI nella ricerca. Non è
    // un'ipotesi nostra, è la sua scelta esplicita — e l'aggancio è esatto perché la scheda
    // Moto.it usa lo STESSO codice-versione della ricerca (nessun rischio di sbagliare moto).
    vehData = d; vehSpecs = {}; vehSelUrl = vehVersionePreScelta(d) || null;
    renderVehScheda();
    // La motorizzazione dedotta dai campi dell'annuncio. Arriva DOPO il primo disegno:
    // la scheda e' gia' a schermo e non si aspetta una seconda richiesta per vederla.
    if (!vehSelUrl && r) preselezionaDaAnnuncio(r, my);
  } catch (_) { if (my === vehGen) vehFallita('Il catalogo non risponde.'); }
}

/**
 * Dai campi che l'annuncio dichiara alla motorizzazione giusta, quando ce n'e' UNA sola.
 * Il conto lo fa il server (schedaPerAnnuncio): anno, potenza, carburante, cambio e
 * carrozzeria sono esattamente i campi con cui il catalogo distingue una motorizzazione
 * dall'altra. Se ne restano piu' d'una non si sceglie: resta la griglia, e scegli tu.
 */
async function preselezionaDaAnnuncio(r, my) {
  let mio = my;   // `switchVehGen` incrementa vehGen: senza risincronizzare, ogni controllo dopo scarterebbe
  const p = lastSearchParams || {};
  // Stessi tipo/marca/modello con cui la scheda e' stata chiesta: li dice l'ANNUNCIO. Con
  // `p.modello` e basta, sugli annunci di un concessionario partiva una richiesta senza
  // modello e la fonte rispondeva 400 — la preselezione non poteva mai riuscire.
  const qs = new URLSearchParams({
    tipo: r.tipo || p.tipo || 'auto',
    marca: (r.marca || p.marca || ''),
    // GREZZO: "Golf 5ª serie" porta dentro la generazione, e il server la legge prima di
    // ripulire il nome. Ripulendolo qui, quell'informazione la buttavamo via.
    // E GREZZO DELL'ANNUNCIO, non della ricerca: `vehModelloBase` e' il modello con cui la
    // scheda e' stata composta (quello dichiarato dall'annuncio, o quello che hai scelto tu
    // se l'annuncio taceva). Prendendo prima `p.modello` si incrociavano i vincoli di QUESTO
    // annuncio — anno, potenza, carburante — col catalogo di un ALTRO modello, e la
    // motorizzazione usciva preselezionata come se fosse la sua.
    modello: (r.modello || r.modelloDichiarato || vehModelloBase || ''),
  });
  if (r.anno) qs.set('anno', r.anno);
  if (r.potenzaCv) qs.set('cv', r.potenzaCv);
  if (r.carburante) qs.set('carburante', r.carburante);
  if (r.cambio) qs.set('cambio', r.cambio);
  if (r.carrozzeria) qs.set('carrozzeria', r.carrozzeria);
  // Il titolo: sulle moto e' da li' che si legge la variante, e il periodo di produzione da
  // solo non la separa. Misurato: 71 risposte giuste 65 con il solo anno, 157 su 157 con
  // anno + titolo (verita' esatta = lo slug versione nell'URL dell'annuncio Moto.it).
  if (r.titolo) qs.set('titolo', r.titolo);
  // Versione e cilindrata dell'annuncio: sulle auto sono i due vincoli che, insieme alla
  // generazione, portano i riconoscimenti da 19 a 39 su 117 (misurato). Sulle moto il titolo
  // serve alla variante, il resto non c'entra.
  if (r.variante) qs.set('variante', r.variante);
  if (r.cilindrata) qs.set('cilindrata', r.cilindrata);
  try {
    const d = await fetch('/api/scheda-veicolo/annuncio?' + qs).then(x => x.json());
    if (mio !== vehGen || !d || !d.ok) return;
    // Anche quando non si sceglie, il server ha qualcosa da dire: se le candidate sono lo
    // stesso motore, la griglia lo scrive invece di far scegliere fra righe quasi identiche.
    vehStessoMotore = d.stessoMotore || null;
    // E DA QUANTO CATALOGO HA DEDOTTO. `genNonLette` sono le generazioni che non si sono
    // lasciate leggere: finche' nessuno lo mostrava, "unica compatibile" arrivava identica a
    // una certezza anche quando era l'unica compatibile di META' elenco.
    vehElencoMonco = Number(d.genNonLette) || 0;
    if (vehStessoMotore || vehElencoMonco) renderVehScheda();
    // La generazione si apre anche senza una motorizzazione scelta, purche' le candidate
    // stiano tutte li': non e' una scelta al posto tuo, e' una griglia in meno da leggere.
    const gen = (d.scelta && d.scelta.genSlug) || d.genUnica;
    if (!gen && !d.scelta) return;
    /**
     * PRIMA LA GENERAZIONE, POI LA MOTORIZZAZIONE. Sulle auto `vehData.motorizzazioni` e'
     * VUOTO finche' una generazione non e' scelta — cercarci dentro l'URL non avrebbe mai
     * agganciato niente. `switchVehGen` e' la stessa funzione che usa il menu: si apre la
     * generazione giusta e poi si sceglie la voce, esattamente come faresti a mano.
     */
    if (gen && (!vehData.gen || vehData.gen.slug !== gen)) {
      const prima = vehGen;
      await switchVehGen(gen);
      if (vehGen !== prima + 1) return;   // qualcun altro ha cambiato scheda nel frattempo
      mio = vehGen;
      if (!vehData || !vehData.gen || vehData.gen.slug !== gen) return;
    }
    if (!d.scelta) return;   // generazione aperta, la motorizzazione la scegli tu
    // L'aggancio e' per URL: e' lo stesso indirizzo della stessa pagina, niente da indovinare.
    const hit = (vehData.motorizzazioni || []).find(m => m.url === d.scelta.url);
    if (!hit) return;
    vehGenChosen = true; vehSelUrl = hit.url;
    renderVehScheda(); fetchVehSpecs(vehSelUrl);
  } catch (_) { /* la scheda resta usabile a mano */ }
}

function renderVehScheda() {
  const el = vehEl(); if (!el) return;
  if (!vehData) {
    // Il motivo resta a schermo anche dopo un ridisegno del pannello, altrimenti sparirebbe
    // al primo click su qualunque altra cosa.
    el.innerHTML = vehErrore
      ? `<div class="rc-group"><div class="rc-group-body"><div class="veh-ko">${escapeHtml(vehErrore)}</div></div></div>`
      : '';
    return;
  }
  const d = vehData;
  const tipo = vehTipo();
  // combobox (search + dropdown): input vuoto di default; value = etichetta solo dopo la scelta. Caret = dropdown.
  const genSel = tipo === 'auto' && d.generations.length
    ? vehCombo('veh-combo-gen', vehGenChosen && d.gen ? d.gen.name : '', 'Generazione')
    : '';
  const curMoto = (d.motorizzazioni || []).find(m => m.url === vehSelUrl) || {};
  const curLabel = vehSelUrl && curMoto.label ? curMoto.label + (curMoto.hp ? ` · ${curMoto.hp} CV` : '') : '';
  const motoSel = vehCombo('veh-combo-moto', curLabel, tipo === 'moto' ? 'Anno / allestimento' : 'Motorizzazione');
  // Toggle IT solo dove serve il dizionario: auto-data.net (/it/) e Moto.it sono già italiane.
  const itBtn = vehNeedsTr() ? `<button type="button" class="veh-tb-btn veh-it${vehXf.translate ? ' on' : ''}" title="Traduci in italiano">IT</button>` : '';
  // toolbar + combos vivono FUORI da .rc-sch-secs (persistenti): l'arrivo async delle specs
  // aggiorna solo .rc-sch-secs (renderVehBody) senza distruggere ciò che l'utente sta digitando.
  el.innerHTML = `<div class="rc-group${vehSchedaCollapsed ? ' collapsed' : ''}">`
    + `<button type="button" class="rc-group-head rc-sched-head"><span class="rc-gcaret">${icon('chevron')}</span><span class="rc-group-title">Scheda tecnica</span><span class="rc-group-meta">${escapeHtml(d.title)}</span></button>`
    + `<div class="rc-group-body"><div class="veh-sel-row">${genSel}${motoSel}${itBtn}</div>${vehMoncoHTML()}${vehSelUrl ? vehToolbarHTML() : ''}<div class="rc-sch-secs">${vehBodyHTML()}</div></div></div>`;
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
  /**
   * Le integrazioni ESTERNE stanno PRIME, in un gruppo come gli altri.
   *
   * Sono il motivo per cui questa scheda esiste: le specifiche le trovi ovunque, quello
   * che gli succede intorno — quanto costa girarlo, quanto costa tenerlo, se ha un
   * richiamo aperto — no. Stavano in fondo, dopo sei gruppi di specifiche, e per
   * arrivarci si scorreva. Restano CHIUSE di default come tutte le altre: prime non vuol
   * dire aperte, vuol dire a portata di clic.
   *
   * Dentro, blocchi richiudibili con la loro fonte scritta: costo carburante (MIMIT),
   * passaggi di proprieta' (ACI + il conto dell'IPT) e richiami (RDW e Safety Gate). Non
   * si mescolano fra loro e non si mescolano con le specifiche: quelle descrivono il
   * veicolo, queste dicono cosa gli succede intorno.
   */
  return (vehXf.compare ? '' : vehHlBandHTML(spec))
    + (vehXf.compare ? '' : vehAddonHTML(spec))
    + vehSectionsHTML(spec);
}

// ── ADD ON: le integrazioni esterne, in un gruppo come gli altri ─────────────
// I richiami NON partono da soli: si scaricano alla prima apertura del loro blocco.
// La marca e il modello sono quelli della RICERCA ESEGUITA, gli stessi con cui e' stata
// costruita la scheda — non lo stato del form, che l'utente puo' aver gia' cambiato.
let vehRichiami = null;        // null = mai chiesti · {loading} · {rdw, sg} · {ko}
// Le versioni di un'omologazione, chieste una alla volta: chiave = numero grezzo.
let vehOmoStato = {};

async function vehOmoCarica(numero) {
  if (!numero || vehOmoStato[numero]) return;
  vehOmoStato[numero] = 'carico';
  const my = vehGen;
  renderVehBody();
  try {
    const d = await fetch('/api/richiami/omologazione?n=' + encodeURIComponent(numero)).then(r => r.json());
    if (scartata(my)) { delete vehOmoStato[numero]; return; }
    vehOmoStato[numero] = d && d.ok && (d.nomi || []).length
      ? d : { ko: (d && d.motivo) || 'nessuna versione trovata per questa omologazione' };
  } catch (_) {
    if (scartata(my)) { delete vehOmoStato[numero]; return; }
    vehOmoStato[numero] = { ko: 'catalogo non raggiungibile' };
  }
  renderVehBody();
}
let vehAddonAperto = false;    // il gruppo resta aperto quando il corpo si ridisegna

/**
 * LA MARCA DI CUI CERCARE I RICHIAMI, in un posto solo.
 *
 * Le campagne sono quelle del VEICOLO che si sta guardando. La scheda si apre solo dal
 * pannello di un annuncio, e nel parco di un concessionario gli annunci non vengono da una
 * ricerca: prendendo marca e modello dai filtri, dentro la scheda di una Fiat Panda si
 * leggevano i richiami della BMW cercata prima, con scritto "per questo modello".
 * Stessa forma di coppiaAnnuncio e loadVehScheda: la ricerca vale solo fuori dal parco.
 *
 * Chi CARICA e chi DISEGNA devono usare lo stesso valore. Erano due espressioni diverse —
 * il caricamento guardava `vehData`, il disegno solo `lastSearchParams` — e il blocco
 * spariva dallo schermo esattamente nei casi in cui la ricerca dei richiami sarebbe
 * riuscita: nel parco, e in qualunque scheda aperta senza una ricerca prima.
 */
function richiamiMarca() {
  const p = lastSearchParams || {};
  return (vehData && vehData.marca) || p.marca || '';
}

async function vehRichiamiCarica() {
  const marca = richiamiMarca();
  // `p.modello` non e' fra i ripieghi: `vehModelloBase` e' il modello con cui la scheda
  // e' stata composta, e quello lo decide l'annuncio. Tenere la ricerca come rete
  // significava, su una lista allargata alla marca, cercare i richiami del modello CERCATO
  // dentro il pannello di un annuncio che e' un altro veicolo — ed e' l'unico dato di
  // sicurezza della scheda.
  const modello = vehModelloBase || (vehData && vehData.modello) || '';
  if (!marca || vehRichiami) return;
  vehRichiami = { loading: true };
  const my = vehGen;
  renderVehBody();
  const q = new URLSearchParams({ marca });
  if (modello) q.set('modello', modello);
  try {
    const [rdw, sg] = await Promise.all([
      fetch('/api/richiami/rdw/cerca?' + q.toString() + '&quante=8').then(r => r.json()).catch(() => null),
      fetch('/api/richiami/cerca?' + q.toString() + '&quante=8').then(r => r.json()).catch(() => null),
    ]);
    if (scartata(my)) { vehRichiami = null; return; }
    vehRichiami = { rdw, sg };
  } catch (_) {
    if (scartata(my)) { vehRichiami = null; return; }
    vehRichiami = { ko: true };
  }
  renderVehBody();
}

function vehRichiamiHTML() {
  if (!richiamiMarca()) return '';   // la stessa marca che userebbe il caricamento, vedi richiamiMarca
  const st = vehRichiami;
  let corpo, meta = '';
  if (!st) corpo = '<div class="veh-rich-att">Apri per cercare negli archivi dei richiami.</div>';
  else if (st.loading) corpo = '<div class="veh-rich-att">Cerco nei due archivi…</div>';
  else if (st.ko) corpo = '<div class="veh-rich-att">Archivi non raggiungibili.</div>';
  else {
    // "Zero richiami" e "l'archivio non ha risposto" sono la stessa cosa solo per chi guarda
    // il numero: qui si separano PER ARCHIVIO. Il ramo st.ko era irraggiungibile — le due
    // fetch hanno gia' un .catch(() => null), quindi la Promise.all non rigetta mai — e
    // l'unico ramo che restava scriveva "Nessuna allerta per questo modello" anche quando
    // l'archivio non era stato costruito o la rotta era caduta. E' l'unico dato di sicurezza
    // della scheda: dichiararlo assente senza averlo guardato e' il silenzio piu' caro.
    const koR = !st.rdw || !st.rdw.ok;
    const koS = !st.sg || !st.sg.ok;
    const nR = koR ? null : st.rdw.totale;
    const nS = koS ? null : st.sg.totale;
    // Nell'intestazione i due numeri restano DUE, separati: sommarli darebbe un totale
    // che non vuol dire niente, perche' i due archivi contano cose diverse.
    meta = [nR != null ? `${nR} RDW` : (koR ? 'RDW muto' : null),
            nS != null ? `${nS} Safety Gate` : (koS ? 'Safety Gate muto' : null)].filter(Boolean).join(' · ');
    /**
     * Ogni riga porta al richiamo VERO. Qui il testo del guasto non c'e' — l'RDW lo
     * scrive in olandese e non lo mettiamo a schermo — quindi il link non e' un di piu':
     * e' l'unico modo di leggere cosa c'e' che non va. Su Safety Gate il link e'
     * l'allerta ufficiale della Commissione, in italiano.
     */
    const rigaHTML = (url, cat, meta, sotto) => {
      const dentro = `<span class="veh-rich-cat">${escapeHtml(cat)}</span>`
        + `<span class="veh-rich-meta">${escapeHtml(meta)}</span>`;
      const riga = url && /^https?:\/\//i.test(url)
        ? `<a class="veh-rich-r veh-rich-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${dentro}</a>`
        : `<div class="veh-rich-r">${dentro}</div>`;
      // L'omologazione sta FUORI dal link: dentro non potrebbe portare un bottone, e il
      // bottone e' il punto — da li' si passa dal modello alle versioni.
      return riga + (sotto || '');
    };
    const riga = c => rigaHTML(c.url, c.categoriaIt || c.categoria || '—',
      [c.data ? new Date(c.data).toLocaleDateString('it-IT') : null, c.rischio].filter(Boolean).join(' · '));
    /**
     * L'OMOLOGAZIONE e' l'unico campo che permette di dire se IL SINGOLO esemplare e'
     * coinvolto invece di quel modello: e' il numero da confrontare col libretto.
     *
     * Ma un'allerta puo' elencarne DICIOTTO in un campo solo, separate da trattini, e
     * scritte per intero riempiono la riga di testo che nessuno legge. Se ne mostrano
     * due e si dice quante restano; per l'elenco completo c'e' la scheda ufficiale, che
     * e' dove porta la riga.
     */
    const omoBreve = a => {
      const tutte = (a.omologazioni || []).flatMap(x => String(x).split(/\s+-\s+/)).map(x => x.trim()).filter(Boolean);
      if (!tutte.length) return null;
      return tutte.slice(0, 2).join(' · ') + (tutte.length > 2 ? `  +${tutte.length - 2}` : '');
    };
    /**
     * DAL MODELLO ALLE VERSIONI. Il numero di omologazione da solo e' una stringa da
     * guardare; il catalogo RDW lo apre e dice QUALI versioni copre. Non parte da solo:
     * due richieste all'RDW per ogni allerta di una lista sarebbero un peso inutile.
     */
    const omoHTML = a => {
      const breve = omoBreve(a);
      if (!breve) return '';
      const primo = (a.omologazioni || []).flatMap(x => String(x).split(/\s+-\s+/))[0] || '';
      const st = vehOmoStato[primo];
      let sotto = '';
      if (st === 'carico') sotto = '<div class="veh-omo-att">Cerco le versioni…</div>';
      else if (st && st.ko) sotto = `<div class="veh-omo-att">${escapeHtml(st.ko)}</div>`;
      else if (st && st.nomi) {
        const alim = (st.alimentazioni || []).map(x =>
          escapeHtml(x.nome) + (x.cvMin ? ` <em>${x.cvMin}–${x.cvMax} CV</em>` : '')).join(' · ');
        const nomi = st.nomi.slice(0, 12).map(x => `<span class="veh-omo-v">${escapeHtml(x.nome)}</span>`).join('');
        const altri = st.nomi.length > 12 ? `<span class="veh-omo-v veh-omo-piu">+${st.nomi.length - 12}</span>` : '';
        sotto = `<div class="veh-omo-esito">${alim ? `<div class="veh-omo-alim">${alim}</div>` : ''}`
          + `<div class="veh-omo-nomi">${nomi}${altri}</div>`
          + `<div class="veh-omo-fonte">Versioni secondo il catalogo omologazioni RDW. I nomi sono quelli del mercato olandese; la potenza copre le versioni a combustione.</div></div>`;
      }
      return `<div class="veh-rich-omo"><span class="veh-omo-n">${escapeHtml(breve)}</span>`
        + (st && st.nomi ? '' : `<button type="button" class="veh-omo-btn" data-omo="${escapeHtml(primo)}"${st === 'carico' ? ' disabled' : ''}>versioni</button>`)
        + `</div>${sotto}`;
    };
    // `modelloPerParole`: l'allerta e' stata agganciata confrontando le PAROLE del modello,
    // non la frase intera — l'archivio e' testo libero scritto dalle autorita' dei vari
    // Stati, dove la Serie 3 e' "3 series" o "3series". Vale, ma si dice: su un dato di
    // sicurezza chi guarda deve poter distinguere le certe dalle probabili.
    // LA DATA PER PRIMA, come la riga RDW qui sopra. Le allerte arrivano dalla piu' recente
    // (il server le ordina per data del bollettino), ma senza la data a schermo non si
    // distingue un'allerta di luglio da una di due anni fa — e su una campagna di sicurezza
    // "quando" e' la prima cosa che si guarda. `dataReport` c'e' su tutte e 1.034.
    const rigaSg = a => rigaHTML(a.scheda, a.prodotto || a.categoria || 'Veicolo',
      [a.dataReport || null, a.anni ? `${a.anni.da}–${a.anni.a}` : a.anno, a.livello,
       a.modelloPerParole ? 'modello riconosciuto dalle parole' : null].filter(Boolean).join(' · '),
      omoHTML(a));
    const bloccoR = koR
      ? '<div class="veh-rich-b"><div class="veh-rich-h">Campagne RDW</div><div class="veh-rich-att">Archivio non raggiungibile: non si sa se ci sono campagne. Riprova tra poco.</div></div>'
      : nR
        ? `<div class="veh-rich-b"><div class="veh-rich-h">Campagne RDW <b>${nR}</b></div>${(st.rdw.campagne || []).slice(0, 5).map(riga).join('')}</div>`
        : '<div class="veh-rich-b"><div class="veh-rich-h">Campagne RDW <b>0</b></div><div class="veh-rich-att">Nessuna campagna per questo modello.</div></div>';
    const bloccoS = koS
      ? '<div class="veh-rich-b"><div class="veh-rich-h">Allerte Safety Gate</div><div class="veh-rich-att">Archivio non raggiungibile: non si sa se ci sono allerte. Riprova tra poco.</div></div>'
      : nS
        ? `<div class="veh-rich-b"><div class="veh-rich-h">Allerte Safety Gate <b>${nS}</b></div>${(st.sg.allerte || []).slice(0, 5).map(rigaSg).join('')}</div>`
        : '<div class="veh-rich-b"><div class="veh-rich-h">Allerte Safety Gate <b>0</b></div><div class="veh-rich-att">Nessuna allerta per questo modello.</div></div>';
    corpo = `<div class="veh-rich">${bloccoR}${bloccoS}</div>`;
  }
  return miniHTML('veh-rich', 'Richiami', escapeHtml(meta), corpo, { carica: 'richiami' });
}

/**
 * LE MISURE DELLA REDAZIONE, accanto a quello che dichiara il costruttore.
 *
 * Auto: i rilevamenti di auto.it — velocita' massima vera, 0-100, frenata da 100 in metri,
 * e i consumi REALI, che sono la riga che vale soldi: il riquadro qui sopra calcola il costo
 * del carburante sul consumo DICHIARATO.
 * Moto: le prove di inSella — la potenza al banco ALLA RUOTA contro quella dichiarata.
 *
 * NON SI SCEGLIE FRA PARI: una prova e' di un allestimento preciso e i nomi non combaciano
 * con quelli degli annunci ("Z 900" aggancia anche la Z900RS, che e' un'altra moto). Si
 * elencano le candidate col loro titolo e il loro anno, e la prova si apre se la apri tu.
 */
let vehMisure = null;          // null = mai chieste · {loading} · {voci|candidate} · {ko}
let vehProva = null;           // la prova moto aperta: {loading} · {dati} · {ko}

async function vehMisureCarica() {
  const d = vehData; if (!d) return;
  const tipo = vehTipo();
  vehMisure = { loading: true }; vehProva = null;
  const my = vehGen;
  renderVehBody();
  const q = new URLSearchParams({ marca: d.marca || '', modello: vehModelloBase || d.modello || '' });
  const anno = (vehSelUrl && (vehData.motorizzazioni || []).find(m => m.url === vehSelUrl) || {}).year;
  if (anno) q.set('anno', anno);
  try {
    const r = await fetch(`/api/prove/${tipo === 'moto' ? 'moto' : 'auto'}?${q}`).then(x => x.json());
    if (scartata(my)) { vehMisure = null; return; }
    vehMisure = r && r.ok ? r : { ko: (r && r.error) || 'fonte non raggiungibile' };
  } catch (_) { vehMisure = scartata(my) ? null : { ko: 'fonte non raggiungibile' }; }
  renderVehBody();
}

async function vehProvaCarica(slug) {
  vehProva = { loading: true };
  const my = vehGen;
  renderVehBody();
  try {
    const r = await fetch('/api/prove/moto/prova?slug=' + encodeURIComponent(slug)).then(x => x.json());
    if (scartata(my)) { vehProva = null; return; }
    vehProva = r && r.ok ? { dati: r.prova } : { ko: (r && r.error) || 'prova non disponibile' };
  } catch (_) { vehProva = scartata(my) ? null : { ko: 'prova non disponibile' }; }
  renderVehBody();
}

const misNum = (v, u) => (v == null || v === '' ? null : String(v).replace('.', ',') + (u ? ' ' + u : ''));
/** L'unita' dei consumi di un rilevamento auto.it: la dichiara il record, non la scriviamo noi. */
const unitaCons = v => (v && /kwh/i.test(String(v.unitaConsumo || '')) ? 'kWh/100 km' : 'l/100 km');

function vehMisureHTML() {
  if (!vehData) return '';
  const tipo = vehTipo();
  const st = vehMisure;
  let corpo, meta = '';
  if (!st) corpo = '<div class="veh-mis-att">Apri per cercare le misure della redazione.</div>';
  else if (st.loading) corpo = '<div class="veh-mis-att">Cerco…</div>';
  else if (st.ko) corpo = `<div class="veh-mis-att">${escapeHtml(st.ko)}</div>`;
  else if (tipo === 'moto') {
    const cand = st.candidate || [];
    meta = String(st.quante || cand.length);
    if (!cand.length) corpo = '<div class="veh-mis-att">inSella non ha una prova di questo modello.</div>';
    else {
      const scelte = cand.map(c => `<button type="button" class="veh-mis-cand" data-prova="${escapeHtml(c.slug)}">`
        + `<span class="veh-mis-cand-t">${escapeHtml(c.titolo)}</span>`
        + `<span class="veh-mis-cand-m">${[c.anno, c.categoria].filter(Boolean).map(x => escapeHtml(String(x))).join(' · ')}</span></button>`).join('');
      corpo = `<div class="veh-mis-lista">${scelte}</div>${vehProvaHTML()}`;
    }
  } else {
    const voci = st.voci || [];
    meta = String(st.quante || voci.length);
    // Tre stati, non due: `completo === false` vuol dire che la paginazione della fonte si e'
    // interrotta e l'elenco letto e' MONCO. Dichiarare «non ha rilevamenti» su una lista parziale
    // sarebbe affermare un'assenza che la fonte non ha affermato. (`dichiarati` arriva dalla
    // fonte: si mostra solo se e' un numero, mai come testo da fuori.)
    const monco = st.completo === false;
    const dich = Number.isFinite(st.dichiarati) ? ' (ne dichiara ' + st.dichiarati + ')' : '';
    const avviso = monco
      ? `<div class="veh-mis-att">auto.it ha risposto solo in parte${dich}: elenco incompleto, un rilevamento di questo modello potrebbe esserci lo stesso.</div>`
      : '';
    if (!voci.length) corpo = monco ? avviso : '<div class="veh-mis-att">auto.it non ha rilevamenti di questo modello.</div>';
    else {
      const righe = voci.map(v => {
        const dati = [
          ['velocità max', misNum(v.velocitaMax, 'km/h')],
          ['0-100', v.acc0_100 || null],
          ['ripresa 80-120', v.ripresa80_120 || null],
          ['frenata 100-0', misNum(v.frenata100_0, 'm')],
          // L'UNITA' LA DICHIARA LA FONTE. `unitaConsumo` viaggia dal 2026 accanto ai numeri
          // (vale 'kWh/100km' sulle elettriche) e qui era scritta a mano: oggi non si vede,
          // perche' i record elettrici arrivano tutti col consumo a null e la riga sparisce
          // da sola — misurato su 252 rilevamenti, 41 elettrici, 11 dichiarati in kWh, zero
          // con un numero. Basta che la fonte cominci a pubblicarlo e l'etichetta mentirebbe.
          ['consumo medio', misNum(v.l100Medio, unitaCons(v))],
          ['città', misNum(v.l100Citta, unitaCons(v))],
          ['autostrada', misNum(v.l100Autostrada, unitaCons(v))],
        ].filter(([, x]) => x);
        return `<div class="veh-mis-r"><div class="veh-mis-h">${escapeHtml(v.nome || '')}`
          // `v.prova` e' il numero di prova scritto da auto.it (`autoit-rilevamenti.js:156`), e li'
          // passa solo da String().trim(): e' testo di terzi, non un numero. Era l'unico campo di
          // fonte esterna che entrava grezzo in innerHTML in tutta l'app — la riga sopra e quella
          // sotto escapavano gia', questa no. Un'app senza CSP ha un solo strato di difesa, e uno
          // strato solo non sopporta le dimenticanze.
          + `<span class="veh-mis-m">${[v.anno, v.prova].filter(Boolean).map(x => escapeHtml(String(x))).join(' · ')}</span></div>`
          + `<div class="veh-mis-d">${dati.map(([k, x]) => `<span><em>${k}</em>${escapeHtml(String(x))}</span>`).join('')}</div></div>`;
      }).join('');
      corpo = avviso
        + `<div class="veh-mis">${righe}</div>`
        + '<div class="veh-mis-fonte">Valori <b>misurati</b> dalla redazione di Auto (auto.it), non dichiarati dal costruttore: '
        + 'il consumo reale e quello di targa non sono lo stesso numero, e il riquadro del carburante qui sopra calcola sul dichiarato.</div>';
    }
  }
  return miniHTML('veh-mis', tipo === 'moto' ? 'Prove su strada (inSella)' : 'Rilevamenti (auto.it)', meta, corpo, { carica: 'misure' });
}

function vehProvaHTML() {
  const p = vehProva;
  if (!p) return '';
  if (p.loading) return '<div class="veh-mis-att">Apro la prova…</div>';
  if (p.ko) return `<div class="veh-mis-att">${escapeHtml(p.ko)}</div>`;
  const d = p.dati || {};
  const m = d.misure || {};
  const pr = m.potenzaRuota || {};
  const gruppi = [];
  /**
   * UN NUMERO NON SI STAMPA SENZA LA SUA UNITA'.
   *
   * Qui usciva il numero nudo. Le etichette di inSella dicono la CONDIZIONE della misura
   * ("Da 100 km/h", "A 120 km/h", "0-400 metri"), non cosa si sta misurando: "Da 100 km/h
   * 39,6" sono metri di frenata, "A 120 km/h 198,9" sono chilometri di autonomia, "0-400
   * metri 10,6" sono secondi. Tre grandezze diverse, affiancate, tutte senza unita'.
   * L'unita' la dichiara la fonte nella riga-titolo della sezione ("Consumi | km/l"), che il
   * parser scarta: finche' non la porta fuori, sta qui — una per sezione, verificata sui dati.
   */
  const coppie = (o, u) => Object.entries(o || {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<span><em>${escapeHtml(k)}</em>${escapeHtml(misNum(v, u) || '')}</span>`).join('');
  /**
   * I DICHIARATI DELLA CASA SONO GIA' TESTO ITALIANO, non numeri da formattare. `misNum`
   * scambia il punto per un separatore decimale all'inglese, e sui dichiarati — che sono
   * stringhe come «170(125,1)/9750» o «8.750» giri — trasformava le MIGLIAIA in decimali:
   * 8.750 giri diventavano «8,750». Qui si stampa quello che la fonte ha scritto.
   */
  const coppieTesto = o => Object.entries(o || {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<span><em>${escapeHtml(k)}</em>${escapeHtml(String(v))}</span>`).join('');
  /**
   * I CONSUMI COME LI SCRIVONO LE AUTO. inSella li misura in km/l, e il pannello del costo
   * carburante — dieci centimetri piu' su, per un'auto — scrive l/100 km: sono grandezze
   * INVERSE, e affiancate senza unita' un 16 sembrava peggio di un 6,25 quando e' meglio.
   * La conversione il backend la calcola gia' (`consumiL100`) e non la mostrava nessuno.
   * Il numero della fonte resta a fianco: e' quello che inSella ha misurato davvero.
   */
  const consumiHTML = () => Object.entries(m.consumi || {}).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => {
      const l = (m.consumiL100 || {})[k];
      const corpo = l != null
        ? `${escapeHtml(misNum(l, 'l/100 km'))} <small class="veh-mis-alt">(${escapeHtml(misNum(v, 'km/l'))})</small>`
        : escapeHtml(misNum(v, 'km/l') || '');
      return `<span><em>${escapeHtml(k)}</em>${corpo}</span>`;
    }).join('');
  const misurate = [
    m.velocitaMax ? `<span><em>velocità max</em>${misNum(m.velocitaMax, 'km/h')}</span>` : '',
    pr.cv ? `<span><em>potenza alla ruota</em>${misNum(pr.cv, 'CV')}${pr.giri ? ' a ' + pr.giri + ' giri' : ''}</span>` : '',
    // `m.autonomia` (km, misurata) arriva dalla fonte e non e' mai stata mostrata: e' una voce
    // da aggiungere, non un'unita' da correggere, e non si infila di straforo in questa passata.
    coppie(m.acc, 's'), coppie(m.ripresa, 's'), coppie(m.frenata, 'm'), consumiHTML(),
  ].filter(Boolean).join('');
  if (misurate) gruppi.push(`<div class="veh-mis-b"><div class="veh-mis-bh">Misurato al banco e in pista</div><div class="veh-mis-d">${misurate}</div></div>`);
  if (d.dichiarati && Object.keys(d.dichiarati).length) {
    gruppi.push(`<div class="veh-mis-b"><div class="veh-mis-bh">Dichiarato dalla casa</div><div class="veh-mis-d">${coppieTesto(d.dichiarati)}</div></div>`);
  }
  if (d.voti && Object.keys(d.voti).length) {
    gruppi.push(`<div class="veh-mis-b"><div class="veh-mis-bh">Voti della redazione</div><div class="veh-mis-d">${coppie(d.voti)}</div></div>`);
  }
  const link = d.url ? `<a class="veh-mis-link" href="${escapeHtml(d.url)}" target="_blank" rel="noopener noreferrer">leggi la prova ↗</a>` : '';
  return `<div class="veh-mis-prova"><div class="veh-mis-ph">${escapeHtml(d.titolo || '')}${link}</div>${gruppi.join('')}`
    // `metodoDiMisura`: e' il nome che usa la fonte (insella-prove.js). Qui si leggeva
    // `metodologia`, che non esiste: la frase che spiega COME sono state prese le misure —
    // cioe' quello che distingue un numero da una misura — non e' mai arrivata a schermo.
    + (d.metodoDiMisura ? `<div class="veh-mis-fonte">${escapeHtml(String(d.metodoDiMisura).slice(0, 400))}</div>` : '')
    + '</div>';
}

function vehAddonHTML(spec) {
  const pezzi = [vehCostoHTML(spec), vehPassaggiHTML(), vehMisureHTML(), vehRichiamiHTML()].filter(Boolean);
  if (!pezzi.length) return '';
  return vehGrpHTML('ADD ON — Ne vuoi di più? Si può!', pezzi.length, 1, `<div class="veh-addon">${pezzi.join('')}</div>`, '',
    { chiuso: !vehAddonAperto, attr: ' data-addon="1"' });
}
// Versione Moto.it scelta nella ricerca → la stessa voce nella scheda, già selezionata.
// L'aggancio è per CODICE: l'URL della scheda Moto.it finisce col codice-versione.
//
// INERTE da quando la versione è un campo libero: il codice non lo manda più il browser,
// lo risolve il server, e qui non arriva. Resta perché la scheda tecnica sta per passare
// dentro l'annuncio (dove il codice-versione è nell'URL dell'annuncio stesso, verificato),
// e allora questa funzione sparisce insieme al resto. Fino a lì: null → scegli dalla griglia.
function vehVersionePreScelta(d) {
  const code = (lastSearchParams || {}).motoitBikeCode;
  if (!code || !/moto\.it/i.test(d.source || '')) return null;
  const hit = (d.motorizzazioni || []).find(m => String(m.url || '').endsWith('/' + code));
  return hit ? hit.url : null;
}

// ── Costo carburante reale, coi prezzi ufficiali della TUA provincia ──────────
// Dati MIMIT (open data, IODL 2.0 → attribuzione obbligatoria in UI), aggiornati ogni
// giorno. Si incrociano col consumo dichiarato dalla scheda: il consumo è presente nel
// 100% dei trim campionati, quindi la banda compare quasi sempre. Le elettriche restano
// fuori di proposito: il prezzo dell'energia è un'altra fonte e non lo inventiamo.
let carbIdx = null, carbStato = 'mai';           // 'mai' | 'carico' | 'ok' | 'ko'
const CARB_ETICHETTA = { benzina: 'benzina', gasolio: 'gasolio', gpl: 'GPL', metano: 'metano' };
const carbProvincia = () => { try { return localStorage.getItem('amrCarbProvincia') || ''; } catch (_) { return ''; } };
// km/anno scritti a mano. I limiti stanno in un posto solo: se l'input dicesse una cosa e la
// validazione un'altra, il bordo rosso non significherebbe niente. E quando il valore scritto
// non e' utilizzabile NON si ricade sul default in silenzio: si dice che la cifra e' quella
// dei 15.000 km, altrimenti il campo mostra 999999 e il riquadro un conto che non c'entra.
const KM_MIN = 100, KM_MAX = 200000, KM_DEF = 15000;
// Solo cifre: "15.000" scritto all'italiana per Number() vale 15, e sarebbe un conto ridicolo
// spacciato per buono.
const carbKmValido = t => (/^\s*\d{1,6}\s*$/.test(String(t == null ? '' : t)) ? Number(t) : NaN);
function carbKmStato() {
  let t = null;
  try { t = localStorage.getItem('amrCarbKm'); } catch (_) { t = null; }
  if (t == null || t === '') return { km: KM_DEF, difetto: false };
  const n = carbKmValido(t);
  if (!(n >= KM_MIN && n <= KM_MAX)) return { km: KM_DEF, difetto: true, scritto: String(t).slice(0, 12) };
  return { km: n, difetto: false };
}
const carbKmAnno = () => carbKmStato().km;

async function loadCarburanti() {
  if (carbStato === 'carico' || carbStato === 'ok') return;
  carbStato = 'carico';
  try {
    const d = await fetch('/api/carburanti').then(r => r.json());
    if (d && d.ok) { carbIdx = d; carbStato = 'ok'; } else carbStato = 'ko';
  } catch (_) { carbStato = 'ko'; }
  renderVehBody();
}

/**
 * spec → { consumo, famiglia } leggendo le righe GREZZE (auto-data.net e Moto.it insieme).
 *
 * IL CICLO MISTO, non la prima riga che capita. Le schede portano i tre cicli, e nell'ordine
 * in cui arrivano il primo e' sempre l'URBANO: misurato su Golf VII, 4 schede su 6 hanno
 * tutti e tre i cicli, e sulla R 2.0 TSI il conto partiva da 8,6-8,9 l/100 km invece dei
 * 6,9-7,2 del misto. A 15.000 km l'anno sono circa 446 € di differenza, scritti sotto
 * l'etichetta "consumo dichiarato".
 *
 * Fra due misti si preferisce quello europeo: certe schede portano anche il ciclo EPA, che e'
 * lo standard americano e da' numeri piu' alti. Se il misto non c'e' si prende quello che
 * c'e' — meglio un ciclo dichiarato che nessun costo.
 */
function vehConsumo(spec) {
  const righe = (spec.groups || []).flatMap(g => g.rows || []);
  let alim = '';
  const cand = [];
  for (const r of righe) {
    if (!alim && /tipo carburante|alimentazione/i.test(r.k)) alim = r.v;
    if (!/consumo/i.test(r.k)) continue;
    const v = carbConsumoDa(r.v);
    if (!v) continue;
    // "misto" (NEDC/WLTP italiano) e "combinato" (WLTP) sono lo stesso ciclo, due traduzioni.
    cand.push({ v, rank: (/mist|combinat/i.test(r.k) ? 0 : 2) + (/epa/i.test(r.k) ? 1 : 0) });
  }
  cand.sort((a, b) => a.rank - b.rank);   // stabile: a parita' vince chi arriva prima
  return { consumo: cand.length ? cand[0].v : null, famiglia: carbFamigliaDa(alim) };
}
// stesse regole del backend (backend/carburanti.js): tenute uguali di proposito
function carbConsumoDa(v) {
  const s = String(v || '');
  if (!/l\s*\/\s*100/i.test(s)) return null;             // kWh/100km → non quotabile qui
  // TUTTE le virgole, non la prima: `replace(',', '.')` senza `g` ne cambia una sola, e su
  // un intervallo scritto all'italiana ("6,9-7,2 l/100 km") la seconda restava virgola. La
  // cifra dopo diventava un numero a se' — 6.9, poi 7, poi 2 — e la media usciva 6,95
  // invece di 7,05: un consumo che la fonte non ha mai dichiarato.
  const n = (s.replace(/,/g, '.').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(x => x > 0 && x < 60).slice(0, 2);
  return n.length ? +(n.reduce((a, b) => a + b, 0) / n.length).toFixed(2) : null;
}
function carbFamigliaDa(a) {
  const s = String(a || '').toLowerCase();
  if (!s) return null;
  if (/elettric/.test(s) && !/ibrid/.test(s)) return null;
  if (/gpl/.test(s)) return 'gpl';
  if (/metano/.test(s)) return 'metano';
  if (/diesel|gasolio/.test(s)) return 'gasolio';
  if (/benzin/.test(s)) return 'benzina';
  return null;
}

// Aritmetica del costo, isolata: la usano sia il primo disegno sia l'aggiornamento a ogni
// tasto sui km. Tenerla in un posto solo evita che le due strade divergano.
function carbCalcola(consumo, prezzoLitro, km) {
  const per100 = consumo * prezzoLitro;
  return { per100, anno: per100 / 100 * km };
}

// Anche la riga di dettaglio e' una sola funzione: scritta due volte, la versione
// dell'aggiornamento in loco perdeva l'avviso "solo N impianti" (diventava testo grigio).
function carbDetHTML(per100, consumo, voce, kmSt) {
  const pochi = voce.n < 5
    ? ` <span class="veh-costo-warn" title="pochi impianti rilevati: prezzo poco rappresentativo">· solo ${voce.n} impianti</span>` : '';
  const difetto = kmSt && kmSt.difetto
    ? ` <span class="veh-costo-warn" title="km/anno non utilizzabili">· km/anno &laquo;${escapeHtml(kmSt.scritto || '')}&raquo; non validi: conto su ${KM_DEF.toLocaleString('it-IT')} km</span>` : '';
  return `${per100.toFixed(2).replace('.', ',')} € ogni 100 km · consumo dichiarato ${String(consumo).replace('.', ',')} l/100 km · ${voce.p.toFixed(3).replace('.', ',')} €/l${pochi}${difetto}`;
}

// Aggiorna le cifre gia' a schermo senza ricostruire il DOM: se ridisegnassimo, il campo dei
// km perderebbe il fuoco a meta' del numero e l'operatore non riuscirebbe a scriverlo.
function vehCostoAggiorna() {
  // La scheda vive dentro l'annuncio: `#vehicleScheda` non esiste piu' da c543983, e questa
  // funzione usciva alla prima riga — cambiavi provincia o chilometri e a schermo non si
  // muoveva niente, mentre il passaggio di proprieta' usava subito la provincia nuova.
  const host = vehEl();
  const box = host && host.querySelector('.veh-costo');
  const spec = vehSpecs[vehSelUrl];
  if (!box || !spec || carbStato !== 'ok' || !carbIdx) return;
  const { consumo, famiglia } = vehConsumo(spec);
  if (!consumo || !famiglia) return;
  const pv = carbProvincia();
  const voce = ((pv && carbIdx.province[pv]) || carbIdx.italia)[famiglia];
  // Provincia che non quota quel carburante (il metano manca in 8 province): senza questo
  // ramo restavano a schermo le cifre della provincia PRECEDENTE, credibili e sbagliate.
  if (!voce) { renderVehBody(); return; }
  const kmSt = carbKmStato();
  const { per100, anno } = carbCalcola(consumo, voce.p, kmSt.km);
  const eur = n => n.toLocaleString('it-IT', { maximumFractionDigits: 0 });
  const det = box.querySelector('.veh-costo-det');
  if (det) det.innerHTML = carbDetHTML(per100, consumo, voce, kmSt);
  // Anche l'etichetta dei prezzi segue la provincia: `self` e' una proprieta' della singola
  // voce, non dell'indice. Aggiornando solo le cifre, la riga sotto poteva restare a
  // descrivere il campione della provincia di prima.
  const fonte = box.querySelector('.veh-costo-fonte');
  if (fonte) fonte.innerHTML = `${carbEtichettaPrezzi(voce)} ${carbIdx.aggiornato ? 'del ' + carbIdx.aggiornato : ''} — ${escapeHtml(carbIdx.fonte)}. Stima: consumo dichiarato, non reale.`;
  /**
   * LA CIFRA GROSSA STA NELL'INTESTAZIONE DEL BLOCCO, non piu' dentro il corpo.
   *
   * Quando il costo carburante e' diventato un blocco richiudibile, la cifra si e'
   * spostata in `.mini-meta` e questa funzione ha continuato ad aggiornare un elemento
   * che non esisteva piu': cambiando provincia il dettaglio sotto si aggiornava e il
   * numero grande restava quello di prima. Due cifre in disaccordo nella stessa scheda,
   * e quella che si legge per prima era la sbagliata.
   */
  const mini = box.closest('.mini');
  const meta = mini && mini.querySelector('.mini-meta');
  if (meta) meta.innerHTML = `${eur(anno)} €<em>all'anno</em>`;
}

/**
 * DA DOVE VIENE QUEL PREZZO AL LITRO, riga per riga.
 *
 * La banda chiudeva con "Prezzi self" per tutti. Misurato sull'indice vero: 206 voci su 420
 * non sono self, e sono esattamente tutto il GPL (107 province su 107) e tutto il metano
 * (99 su 99) — li' gli impianti self sono troppo pochi perche' una mediana ci stia in piedi,
 * e il backend usa self e servito insieme. Lo dichiara gia' (`voce.self`), non lo leggeva
 * nessuno. I calcoli non cambiano: cambia cosa c'e' scritto sotto il numero.
 */
const carbEtichettaPrezzi = voce =>
  (voce && voce.self === false) ? 'Prezzi self e servito insieme — pochi impianti self' : 'Prezzi self';

function vehCostoHTML(spec) {
  const { consumo, famiglia } = vehConsumo(spec);
  if (!consumo || !famiglia) return '';                      // niente dati → niente banda (mai stime inventate)
  if (carbStato === 'mai') { loadCarburanti(); return '<div class="veh-costo veh-costo-attesa">Calcolo il costo carburante…</div>'; }
  if (carbStato === 'carico') return '<div class="veh-costo veh-costo-attesa">Calcolo il costo carburante…</div>';
  if (carbStato !== 'ok' || !carbIdx) return '';
  const pv = carbProvincia();
  const tab = (pv && carbIdx.province[pv]) || carbIdx.italia;
  const voce = tab[famiglia];
  if (!voce) return '';
  const kmSt = carbKmStato();
  const km = kmSt.km;
  const { per100, anno } = carbCalcola(consumo, voce.p, km);
  const eur = n => n.toLocaleString('it-IT', { maximumFractionDigits: 0 });
  const provOpts = ['<option value="">Media Italia</option>']
    .concat(Object.keys(carbIdx.province).sort().map(x => `<option value="${x}"${x === pv ? ' selected' : ''}>${x}</option>`)).join('');
  return miniHTML('carb', 'Costo carburante', `${eur(anno)} €<em>all'anno</em>`, `<div class="veh-costo">
    <div class="veh-costo-det">${carbDetHTML(per100, consumo, voce, kmSt)}</div>
    <div class="veh-costo-ctrl">
      <select class="veh-carb-prov" aria-label="provincia per il prezzo del carburante">${provOpts}</select>
      <label class="veh-carb-kmw"><input type="number" class="veh-carb-km" value="${kmSt.difetto ? '' : km}" min="${KM_MIN}" max="${KM_MAX}" step="any" inputmode="numeric" aria-label="chilometri all'anno"><span>km/anno</span></label>
    </div>
    <div class="veh-costo-fonte">${carbEtichettaPrezzi(voce)} ${carbIdx.aggiornato ? 'del ' + carbIdx.aggiornato : ''} — ${escapeHtml(carbIdx.fonte)}. Stima: consumo dichiarato, non reale.</div>
  </div>`);
}

// ── Liquidita accanto a ogni annuncio ────────────────────────────────────────
// Nelle ricerche per sola MARCA ogni riga e' un modello diverso: sapere quali si
// rivendono in fretta cambia la scelta quando ne valuti venti insieme. Il dato e' ACI
// Autoritratto (parco + passaggi/anno per modello): si scarica una volta per marca.
// L'attribuzione riga→modello usa il nome ACI piu' LUNGO contenuto nel titolo: e' preciso
// perche' la marca e' gia' fissata dalla ricerca. Nessun match → nessun segno, mai un
// numero attribuito a caso. Le moto non hanno questo dato (vedi backend/liquidita.js).
let liqMarca = null, liqModelli = null, liqStato = 'mai';
const liqNorm = x => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function liqCarica(marca, modello, tipo) {
  const chiave = liqNorm(marca) + '|' + liqNorm(modello);
  if (liqStato === 'carico' || liqMarca === chiave) return;
  liqStato = 'carico'; liqMarca = chiave;
  try {
    const q = new URLSearchParams({ marca });
    if (modello) q.set('modello', modello);
    if (tipo) q.set('tipo', tipo);
    const d = await fetch('/api/liquidita?' + q.toString()).then(r => r.json());
    // Nel frattempo l'utente puo' aver cambiato ricerca: una risposta per una domanda superata
    // non deve sovrascrivere i dati di quella corrente. Stesso guardiano di tutte le altre fetch.
    if (liqMarca !== chiave) return;
    // `d.voce` (il modello CERCATO) non si tiene piu': il riquadro dentro la scheda parla
    // dell'annuncio aperto, non della ricerca, e ha il suo stato — vedi `liqAnn`.
    liqAnno = (d && d.anno) || liqAnno;
    if (d && d.ok && d.modelli.length) {
      // ordinati per nome decrescente di lunghezza: il primo che combacia e' il piu' specifico
      liqModelli = d.modelli.map(m => ({ ...m, n: liqNorm(m.modello) })).filter(m => m.n.length >= 2)
        .sort((a, b) => b.n.length - a.n.length);
      liqStato = 'ok';
    } else { liqModelli = null; liqStato = 'vuoto'; }
  } catch (_) { liqStato = 'ko'; }
  if (liqStato === 'ok') {
    renderResults(currentResults);   // le righe si ridisegnano col segno
    renderVehBody();                 // e la scheda tecnica mostra il riquadro liquidita
  }
}

// titolo annuncio → voce di liquidita, o null. Confine-parola per non far matchare "500" in "1500".
function liqPerTitolo(titolo) {
  if (liqStato !== 'ok' || !liqModelli) return null;
  const t = ' ' + liqNorm(titolo) + ' ';
  for (const m of liqModelli) if (t.includes(' ' + m.n + ' ')) return m;
  return null;
}

function liqBadgeHTML(item) {
  // Si memorizza SOLO quando il dato c'e' davvero. Memorizzando anche il "non lo so", la
  // prima disegnata — che capita mentre l'archivio ACI sta ancora arrivando — fissava un
  // `null` su ogni riga, e la ridisegnata che l'archivio innesca lo trovava gia' deciso:
  // i segni non comparivano piu' per tutta la ricerca.
  if (liqStato !== 'ok') return '';
  if (item._liq === undefined) item._liq = liqPerTitolo(item.titolo);   // memo: una volta per riga
  const m = item._liq;
  if (!m || m.ricambio == null) return '';
  // Il numero e basta. Niente frase e niente colore: anche il verde e' un giudizio, e
  // qui la fonte da' passaggi e parco circolante, non un parere sulla vendibilita'.
  // «fra privati» era sbagliato: i NETTI escludono le minivolture (il passaggio al
  // concessionario), non le vendite dei concessionari — che nei netti ci sono. La
  // formulazione giusta e' quella che il server usa gia' (server.js:828).
  const tip = `${m.modello}: ${Number(m.trasferimenti).toLocaleString('it-IT')} passaggi netti nel ${liqAnno} (minivolture escluse)`
    + (m.trasferimentiTotali > m.trasferimenti ? `, ${Number(m.trasferimentiTotali).toLocaleString('it-IT')} in tutto (minivolture incluse)` : '') +
    (m.parco ? ` su ${Number(m.parco).toLocaleString('it-IT')} in circolazione` : '') + '. Fonte ACI Autoritratto.';
  return `<span class="liq-badge" title="${escapeHtml(tip)}">&#8635; ${String(m.ricambio).replace('.', ',')}%</span>`;
}
let liqAnno = 2025;

// ── Liquidita del modello, dentro la scheda tecnica ──────────────────────────
// Quanto si rivende un modello e' un dato economico, ma parla della STESSA cosa di cui parla
// la scheda: il veicolo. Sta qui e non in un pannello a parte perche' l'operatore che guarda
// le specifiche di una Panda vuole sapere nella stessa occhiata quanto quel modello gira.
//
// IL MODELLO E' QUELLO DELL'ANNUNCIO APERTO, non quello cercato. Prima il blocco leggeva
// `lastSearchParams`: nel parco di un concessionario — dove una ricerca non c'e' mai stata —
// sotto ogni veicolo comparivano i passaggi del modello cercato prima, e su una lista
// allargata alla marca un annuncio marcato "altro modello" mostrava i numeri di un altro
// veicolo. Stessa regola di gomme e scheda tecnica: la coppia la dice `coppiaAnnuncio`.
//
// Una richiesta per MODELLO DIVERSO APERTO, e solo all'apertura del gruppo "Passaggi di
// proprieta" (vedi il gestore `carica: 'pass'`): chi non guarda il blocco non chiede niente.
let liqAnn = null;   // { chiave, stato: 'carico'|'ok'|'vuoto'|'ko', voce } del modello aperto

async function liqAnnCarica(r) {
  const { marca, modello } = coppiaAnnuncio(r);
  if (!marca || passTipo(r) !== 'auto') return;   // le moto non hanno il dato (backend/liquidita.js)
  const chiave = liqNorm(marca) + '|' + liqNorm(modello);
  if (liqAnn && (liqAnn.chiave === chiave)) return;
  liqAnn = { chiave, stato: 'carico', voce: null };
  const mio = liqAnn;
  renderVehBody();
  try {
    const q = new URLSearchParams({ marca, tipo: 'auto' });
    if (modello) q.set('modello', modello);
    const d = await fetch('/api/liquidita?' + q.toString()).then(x => x.json());
    if (liqAnn !== mio) return;                    // un altro annuncio ha preso il posto
    liqAnno = (d && d.anno) || liqAnno;
    const voce = (d && d.voce && d.voce.ok) ? d.voce : null;
    liqAnn = { chiave, stato: voce ? 'ok' : 'vuoto', voce };
  } catch (_) {
    if (liqAnn !== mio) return;
    liqAnn = { chiave, stato: 'ko', voce: null };
  }
  renderVehBody();
}

/** Quanti ne cambiano proprietario in un anno, sul MODELLO. Solo il corpo: il guscio lo
 *  mette `vehPassaggiHTML`, che lo unisce al costo del passaggio di QUESTO annuncio. */
function liqCorpoHTML(r) {
  // Le moto non hanno il dato e senza marca non si puo' chiedere: niente riquadro vuoto e
  // niente attesa che non finisce mai — il blocco proprio non esiste.
  if (!r || passTipo(r) !== 'auto' || !coppiaAnnuncio(r).marca) return '';
  if (!liqAnn) return '<div class="veh-liq veh-liq-attesa">Apri per avere i passaggi di questo modello.</div>';
  if (liqAnn.stato === 'carico') return '<div class="veh-liq veh-liq-attesa">Carico la liquidita del modello…</div>';
  // "Zero passaggi" e "l'archivio non ha risposto" non sono la stessa cosa: si separano.
  if (liqAnn.stato === 'ko') return '<div class="veh-liq veh-liq-attesa">Archivio ACI non raggiungibile.</div>';
  const m = liqAnn.voce;
  /**
   * «NON HA UNA VOCE» E' UN FATTO SULL'ARCHIVIO, e si dice solo quando la voce manca
   * davvero. Il tasso di ricambio e' UN campo della voce, non la voce: pretendendolo,
   * 669 modelli su 1.997 con dati veri (380 coi passaggi, 289 col parco) uscivano come
   * «l'archivio non ha una voce» — un'affermazione falsa su cio' che ACI pubblica.
   * Ora si mostra quello che c'e' e si omette solo il riquadro che manca.
   */
  if (!m) return '<div class="veh-liq veh-liq-attesa">L\'archivio ACI non ha una voce per questo modello.</div>';
  const n = x => Number(x).toLocaleString('it-IT');
  // Tre numeri, tre riquadri. Erano una riga sola separata da puntini — "GOLF · 1.037.466
  // in circolazione · ricambio 7%/anno" — dove per leggere il secondo bisognava contare i
  // punti. Sono grandezze diverse e stanno una accanto all'altra, ognuna con la sua unita'.
  const tile = (val, lab) => `<div class="pp-tile"><b>${val}</b><span>${lab}</span></div>`;
  /**
   * DUE NUMERI, PERCHE' SONO DUE COSE.
   *
   * Qui usciva un numero solo, quello dei trasferimenti NETTI, sotto l'etichetta "passaggi":
   * i netti escludono le MINIVOLTURE, cioe' il passaggio al concessionario che poi rivende.
   * Misurato sull'archivio ACI, 1.708 modelli: netti 3.189.416 contro 5.599.752 totali —
   * mancavano all'appello 2.410.336 formalita', il 43%. E per un operatore quella meta'
   * mancante e' esattamente il giro che lo riguarda: quanto di quel modello passa dal
   * commercio invece che da privato a privato.
   *
   * `trasferimentiTotali` viaggiava gia' nel payload e non lo leggeva nessuno.
   */
  const conTotali = m.trasferimentiTotali != null && m.trasferimentiTotali > m.trasferimenti;
  return `<div class="veh-liq">
    <div class="pp-tiles">
      ${m.trasferimenti != null ? tile(n(m.trasferimenti), `passaggi netti nel ${m.anno || liqAnno} (minivolture escluse)`) : ''}
      ${conTotali ? tile(n(m.trasferimentiTotali), 'tutti i passaggi, minivolture incluse') : ''}
      ${m.parco ? tile(n(m.parco), 'in circolazione') : ''}
      ${m.ricambio != null ? tile(String(m.ricambio).replace('.', ',') + '%', 'ricambio all\'anno') : ''}
    </div>
    ${m.viaPadre ? `<div class="veh-liq-avviso">Dato del modello base &laquo;${escapeHtml(m.viaPadre)}&raquo;, non della variante cercata.</div>` : ''}
    <div class="veh-liq-fonte">${escapeHtml(m.modello)} — ${escapeHtml(m.fonte || ('ACI Autoritratto ' + liqAnno))}. ${escapeHtml(m.nota || 'Dato aggregato sul modello, non sulla singola versione.')}</div>
  </div>`;
}

/**
 * PASSAGGI DI PROPRIETA', i due sensi in un blocco solo.
 *
 * Erano separati e distanti: il COSTO per mettere a nome tuo QUESTO veicolo stava fra i
 * blocchi dell'annuncio, e quanti esemplari di quel MODELLO cambiano proprietario in un
 * anno stava in ADD ON. Due cose diverse — una e' un euro da pagare, l'altra una
 * statistica ACI — ma parlano della stessa pratica, e chi guarda le vuole vicine: quanto
 * mi costa girarlo, e quanto spesso si gira. Il numero in intestazione e' il costo,
 * perche' e' quello che decide.
 */
function vehPassaggiHTML() {
  const r = vehHostUrl ? trovaResult(vehHostUrl) : null;
  const costo = r ? passCorpoHTML(r) : '';
  const modello = liqCorpoHTML(r);
  if (!costo && !modello) return '';
  const st = r && r._pass;
  const meta = (st && st.stato === 'ok' && st.d && st.d.ok && st.d.totaleNoto != null)
    ? escapeHtml(eurRound(st.d.totaleNoto)) : '';
  // Le due meta' si DICHIARANO. Prima erano quattro righe di seguito e non si capiva dove
  // finiva il conto di questo veicolo e dove cominciava la statistica del modello: sono
  // due domande diverse — quanto mi costa girarlo, quanto spesso si gira — e ognuna ha la
  // sua intestazione. Su schermo largo stanno affiancate, su stretto una sotto l'altra.
  const meta2 = [
    costo ? `<section class="pp-meta"><h4 class="pp-h">Quanto costa girarlo<em>questo veicolo</em></h4>${costo}</section>` : '',
    modello ? `<section class="pp-meta"><h4 class="pp-h">Quanto si gira<em>tutto il modello, in Italia</em></h4>${modello}</section>` : '',
  ].filter(Boolean).join('');
  return miniHTML('passaggi', 'Passaggi di proprieta', meta,
    `<div class="pp-wrap">${meta2}</div>`, { carica: 'pass' });
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
// Griglia card motorizzazione/versione: foto (se la fonte la dà) + anno in evidenza + label
// + hp/carburante/prezzo. Stessa forma della griglia-generazioni auto → coerenza estetica.
// La foto si disegna SOLO se presente: le motorizzazioni auto non ne hanno e resterebbero
// riquadri vuoti (questa funzione è condivisa tra auto e moto).
function vehMotoCardHTML(m, sug) {
  const yr = m.yearRange || (m.year ? String(m.year) : '');
  const meta = [m.hp ? `${m.hp} CV` : '', m.fuel || '', m.prezzo || ''].filter(Boolean).join(' · ');
  const img = /^https:\/\/cdn-img\.moto\.it\//i.test(m.img || '') ? m.img : '';   // solo il CDN di Moto.it
  return `<button type="button" class="veh-moto-card${img ? ' veh-card-foto' : ''}${sug ? ' veh-card-sug' : ''}" data-url="${escapeHtml(m.url)}">`
    + (img ? `<img class="veh-gen-card-img" src="${escapeHtml(img)}" alt="" loading="lazy">` : '')
    + `<span class="veh-moto-card-year">${escapeHtml(yr || '—')}</span>`
    + `<span class="veh-moto-card-label">${escapeHtml(m.label)}</span>`
    + (meta ? `<span class="veh-moto-card-meta">${escapeHtml(meta)}</span>` : '') + `</button>`;
}
function vehMotoGridHTML(tipo) {
  const list = (vehData && vehData.motorizzazioni) || [];
  return vehStessoMotoreHTML() + vehCardGrid(list, vehMotoCardHTML, 'veh-moto-grid', `Scegli ${tipo === 'moto' ? "l'annata / allestimento" : 'la motorizzazione'}:`);
}

/**
 * IL MOTORE E' QUELLO, L'ALLESTIMENTO NO — e la differenza si dice.
 *
 * Misurato: quando restano piu' candidate, in due casi su tre hanno cilindrata, potenza e
 * carburante identici e si distinguono per cambio, trazione e sigle commerciali, cose che
 * l'annuncio non scrive mai. Una griglia da quattordici righe non e' una scelta: e' una resa.
 */
function vehStessoMotoreHTML() {
  const s = vehStessoMotore;
  if (!s || !s.quante) return '';
  const cosa = (s.differenze || []).length
    ? ` — cambia: ${escapeHtml(s.differenze.join(' · '))}`
    : '';
  return `<div class="veh-motore-uno"><b>Il motore e' questo: ${escapeHtml(s.motore)}</b>`
    + `<span>${s.quante} allestimenti a catalogo lo condividono${cosa}. L'annuncio non dice quale sia, quindi la scelta resta a te.</span></div>`;
}

/**
 * IL CATALOGO LETTO A META' SI DICHIARA, NON SI NASCONDE DIETRO UNA SCELTA.
 *
 * Tre stati, non due: quando una generazione non si lascia leggere (pagina di transizione,
 * 403, timeout) le sue motorizzazioni non entrano nel confronto, e "unica del catalogo
 * compatibile" diventa "unica fra quelle lette" — che non e' la stessa cosa. Il server lo
 * conta da tempo, ma il numero non aveva un lettore: la motorizzazione veniva preselezionata
 * e le sue specifiche caricate senza un segno, e chi legge non aveva modo di accorgersene.
 */
function vehMoncoHTML() {
  const n = vehElencoMonco;
  if (!n) return '';
  const quante = n === 1 ? 'una generazione non si e\' lasciata leggere' : `${n} generazioni non si sono lasciate leggere`;
  // La frase parla della DEDUZIONE, non di quello che c'e' a schermo: resta vera anche dopo
  // che hai cambiato generazione o motorizzazione a mano.
  return `<div class="veh-monco">Catalogo letto in parte: ${quante}.`
    + ' Il confronto coi dati dell\'annuncio e\' partito da un elenco incompleto: la motorizzazione compatibile puo\' essere anche un\'altra.'
    + ' Riapri la scheda fra qualche minuto per rifarlo sull\'intero catalogo.</div>';
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
  const el = vehEl(); const secs = el && el.querySelector('.rc-sch-secs');
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
  // Solo le famiglie che su QUESTA fonte hanno qualcosa da convertire: sulle moto potenza
  // e coppia arrivano gia' in due unita', e offrirle sarebbe un comando che non fa niente.
  const righeUnita = VEH_UNIT_ROWS.filter(([fam]) => vehFamAttiva(fam));
  const unitsMenu = righeUnita.map(([fam, lab, opts]) => `<label class="veh-u-row"><span>${lab}</span><select class="veh-tb-unit" data-fam="${fam}" aria-label="${lab}">${opts.map(([v, l]) => `<option value="${v}"${(vehXf.units[fam] || '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`).join('');
  let cmpCombo = '';
  if (vehXf.compare) {
    const cm = vehData.motorizzazioni.find(m => m.url === vehXf.compare) || {};
    const cl = cm.label ? cm.label + (cm.hp ? ` · ${cm.hp} CV` : '') : '';
    cmpCombo = vehCombo('veh-combo-cmp', cl, 'Confronta con…');
  }
  return `<div class="veh-toolbar">`
    + `<div class="veh-q-wrap">${icon('search', 'veh-q-ico')}<input type="search" class="veh-tb-q" placeholder="Cerca campo…" value="${escapeHtml(vehXf.q)}"></div>`
    + (righeUnita.length ? `<details class="tb-cols veh-units${unitsActive ? ' has-adj' : ''}"><summary class="veh-tb-btn">Unità</summary><div class="tb-cols-menu veh-units-menu">${unitsMenu}</div></details>` : '')
    + `<button type="button" class="veh-tb-btn veh-tb-all">${vehXf.allOpen === true ? 'Comprimi tutto' : 'Espandi tutto'}</button>`
    + `<button type="button" class="veh-tb-btn veh-tb-cmp${vehXf.compare ? ' on' : ''}">Confronta</button>`
    + `<details class="tb-cols veh-export"><summary class="veh-tb-btn">Esporta</summary><div class="tb-cols-menu veh-export-menu"><button type="button" class="veh-exp" data-exp="copia">Copia negli appunti</button><button type="button" class="veh-exp" data-exp="csv">Scarica CSV</button><button type="button" class="veh-exp" data-exp="pdf">Scarica PDF</button></div></details>`
    + cmpCombo
    + `</div>`;
}
function vehGrpHTML(title, count, i, bodyInner, extraCls, opts = {}) {
  const chiuso = opts.chiuso != null ? opts.chiuso : i !== 0;
  return `<div class="veh-grp${chiuso ? ' veh-collapsed' : ''}"${opts.attr || ''}><button type="button" class="veh-grp-head"><span class="veh-grp-caret">${icon('chevron')}</span><span class="veh-grp-tit">${escapeHtml(title)}</span><span class="veh-grp-count">${count}</span></button><div class="veh-grp-body${extraCls || ''}">${bodyInner}</div></div>`;
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
  const el = vehEl(); if (!el) return;
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
  try { const r = await fetch(`/api/scheda-veicolo/specs?url=${encodeURIComponent(url)}`); const j = await r.json(); if (scartata(my)) { delete vehSpecs[url]; return; } vehSpecs[url] = j; }
  catch (_) { if (scartata(my)) { delete vehSpecs[url]; return; } vehSpecs[url] = { ok: false }; }
  if (shows()) renderVehBody();
}

async function switchVehGen(genSlug) {
  if (!vehData) return;
  const my = ++vehGen;   // cambio generazione rapido → vince l'ultimo, gli altri si scartano
  const tipo = vehTipo();   // tipo della scheda, non della UI
  const el = vehEl();
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
// Fonti moto: Moto.it (primaria, italiano nativo) e ultimatespecs (ripiego, inglese).
function vehTipo() { return /ultimatespecs|moto\.it/i.test((vehData && vehData.source) || '') ? 'moto' : 'auto'; }
// Serve il dizionario EN→IT? Solo per ultimatespecs: auto-data.net /it/ e Moto.it sono già in italiano.
function vehNeedsTr() { return /ultimatespecs/i.test((vehData && vehData.source) || ''); }
// Moto.it scrive i numeri in formato ITALIANO (migliaia col punto, decimali con la virgola:
// "91,2 CV", "1.531 mm"). Il convertitore di unità tratta la virgola da separatore di migliaia
// → mostrerebbe 912 CV. auto-data.net, anche su /it/, usa il punto decimale. Quindi su Moto.it
// la conversione si spegne e il menu Unità non viene offerto: meglio nessuna conversione che
// un numero sbagliato di dieci volte.
function vehNumeriIT() { return /moto\.it/i.test((vehData && vehData.source) || ''); }
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
/**
 * LE DUE CONVENZIONI DEI NUMERI, e perche' vanno distinte.
 *
 * Il catalogo auto scrive all'inglese ("1,460 mm" = millequattrocentosessanta), quello
 * moto all'italiana ("73,4 CV", "8.750 rpm"): la virgola e' migliaia nella prima e
 * DECIMALE nella seconda. Leggendo l'una con le regole dell'altra, 73,4 CV diventano 734.
 * Per questo la conversione sulle moto era spenta del tutto — ma cosi' spariva anche
 * quella che serve (cilindrata, peso, lunghezze). Qui si legge e si riscrive con la
 * convenzione della fonte, e la conversione torna disponibile su entrambe.
 */
const vehParse = s => (vehNumeriIT()
  ? parseFloat(String(s).replace(/\./g, '').replace(',', '.'))
  : parseFloat(String(s).replace(/,/g, '')));
const vehFmt = n => {
  if (!isFinite(n)) return '';
  const t = String(Math.round(n * 100) / 100);
  return vehNumeriIT() ? t.replace('.', ',') : t;
};
const VEH_UNITS = [
  // 'ccm' PRIMA di 'cc', senno' il confine di parola dopo 'cc' non combacia mai su "ccm".
  { fam: 'len', pat: 'mm', f: { cm: 0.1, m: 0.001 }, lab: { cm: 'cm', m: 'm' } },
  { fam: 'disp', pat: 'cm3|ccm|cc', f: { L: 0.001 }, lab: { L: 'L' } },
  { fam: 'mass', pat: 'kg', f: { t: 0.001 }, lab: { t: 't' } },
  { fam: 'pow', pat: 'Hp|HP|PS|CV', f: { kW: 0.7355 }, lab: { kW: 'kW' } },
  { fam: 'trq', pat: 'Nm', f: { kgm: 0.101972 }, lab: { kgm: 'kgm' } },
];
VEH_UNITS.forEach(u => { u.re = new RegExp('([\\d][\\d.,]*(?:\\s*[-x×]\\s*[\\d][\\d.,]*)?)\\s*(?:' + u.pat + ')\\b(?!\\s*\\/)', 'g'); });   // precompilata
/**
 * Potenza e coppia NON si convertono sulla fonte moto: le stampa gia' in due unita'
 * ("73,4 CV - 54 kW", "6,9 kgm - 68 Nm"), e convertirle darebbe "54 kW - 54 kW".
 * Non e' un limite del convertitore: e' che li' non c'e' niente da convertire.
 */
const VEH_FAM_DOPPIE = new Set(['pow', 'trq']);
const vehFamAttiva = fam => !(vehNumeriIT() && VEH_FAM_DOPPIE.has(fam));
function vehConv(v) {
  let out = v;
  for (const u of VEH_UNITS) {
    if (!vehFamAttiva(u.fam)) continue;
    const tgt = vehXf.units[u.fam]; if (!tgt || !u.f[tgt]) continue;
    out = out.replace(u.re, (m, nums) => nums.replace(/[\d][\d.,]*/g, n => vehFmt(vehParse(n) * u.f[tgt])) + ' ' + u.lab[tgt]);
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
