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
const versioniRow     = document.getElementById('versioniRow');
/**
 * UN CAMPO SOLO, a testo libero. Erano tre, uno per catalogo, e sembrava la scelta
 * prudente: le fonti non chiamano "versione" la stessa cosa, quindi tre tendine invece
 * di una lista mescolata.
 *
 * Il difetto era piu' in fondo: scegliere una voce da un catalogo NON sceglie la stessa
 * nell'altro — misurato, su 588 testi-versione veri di Autoscout solo il 5,8% combacia
 * alla lettera con una voce del catalogo Subito. Le tre tendine promettevano una
 * corrispondenza che non esiste, e per averla dovevi sapere in quale catalogo stavi
 * comprando prima di poter cercare.
 *
 * Ora quello che scrivi va alle fonti com'e'. Subito e Autoscout una ricerca testuale
 * ce l'hanno; Moto.it e' l'unica dove il testo va tradotto in un codice, e li' la
 * traduzione e' contro il SUO catalogo, non contro quello di un'altra fonte.
 */
const versioneInput   = document.getElementById('versione');
const tipoInputs      = document.querySelectorAll('input[name="tipo"]');
const backToSearch    = document.getElementById('backToSearch');
const resultsToolbar  = document.getElementById('resultsToolbar');
const facetChipsEl    = document.getElementById('facetChips');
const sortMobile      = document.getElementById('sortMobile');
const advancedToggle  = document.getElementById('advancedToggle');
const advancedFilters = document.getElementById('advancedFilters');
const logoBtn         = document.getElementById('logoBtn');
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
// L'ultima fetta DISEGNATA (ordinata e ristretta dal cursore del prezzo). `currentResults`
// e' tutto lo scaricato: esportare quello significava consegnare un documento che descrive
// un insieme diverso da quello che si sta guardando.
let ultimiVisti = null;
// `.length` NO: zero a schermo e' un insieme, non un'assenza. Con il cursore del prezzo stretto
// su una fascia vuota, l'elenco disegnato e' vuoto — e cadere su `currentResults` faceva uscire
// un CSV e un PDF con TUTTI gli annunci scaricati, cioe' l'esatto contrario di quello che si
// stava guardando. Su un documento che esce di mano e' il tipo di errore che non si scopre.
// Il ripiego resta solo per il "mai disegnato" (null), dove ultimiVisti non esiste ancora.
const risultatiAVista = () => (Array.isArray(ultimiVisti) ? ultimiVisti : currentResults);
// Il bottone "Verifica" della targa: la sua visibilita' dipende sia dal campo sia dal fatto
// che ci siano annunci a schermo, quindi va risincronizzato quando cambia l'una o l'altra
// cosa. Definita qui perche' la assegna init() e la chiamano render/hide dei risultati.
let targaBtnSync = () => {};
let confronto      = [];                       // annunci selezionati per il confronto (cap 10)
let matrixList     = [];                        // annunci attualmente mostrati nella matrice
let salvati        = [];
let groupDim       = '';                        // dimensione di raggruppamento attiva ('' = nessuna)
// SOLO IVA ESPOSTA. Per un operatore un'auto a 10.000 con IVA esposta e' un'ALTRA auto
// rispetto a una a 10.000 in margine: la prima gliene costa 8.197 netti, la seconda 10.000.
// Il dato lo mandano gia' le fonti (`ivaEsposta`), non serve nessuna richiesta in piu'.
let soloIva = false;
// Lista (densa, confrontabile) o schede (foto grande). Si ricorda: e' una preferenza di
// come si guarda, non un pezzo della ricerca.
// Di default SCHEDE: la foto e' il primo filtro che fa un operatore, e la lista densa
// resta a un clic per chi vuole confrontare. Chi ha gia' scelto tiene la sua preferenza.
let vista          = (() => { try { return localStorage.getItem('amrVista') === 'lista' ? 'lista' : 'schede'; } catch (_) { return 'schede'; } })();
let modelCache     = {};                        // `${tipo}|${marca}` → [{nome, sites, mmmvAutoscout, slugMotoIt}]
let selectedModel  = null;                       // modello scelto dalla force-select (con _marca) o null (testo libero)
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
const rPricing = base => pricing(base, priceCfgR);
const eurRound = n => '€ ' + Math.round(n).toLocaleString('it-IT');
/**
 * L'ETICHETTA del prezzo per chi ne mostra UNO solo (confronto, salvati, avvisi): il
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
      <label class="pm-check"><input type="checkbox" id="pmIva_${ns}"${cfg.iva ? ' checked' : ''}> Scorporo IVA 22%</label>
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
    iva: !!(g('pmIva') && g('pmIva').checked),
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
async function caricaFiltriAuto() {
  const griglia = document.getElementById('filtriAutoGrid');
  if (!griglia) return;
  let d = null;
  try { d = await fetch('/api/filtri-auto').then(r => (r.ok ? r.json() : null)); } catch (_) { d = null; }
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
  if (g) g.classList.toggle('d-none', tipo !== 'auto');
}

// ─── Modalità demo (ospite read-only) ───────────────────────────────────────
/**
 * SOLA LETTURA NON VUOL DIRE UNA STANZA SOLA.
 *
 * Qui dentro c'erano `modeToggle` e `setSearchMode('cerca')`: insieme toglievano all'ospite
 * i quattro modi e lo inchiodavano alla ricerca Auto. Chi entrava con una password in sola
 * lettura non vedeva Moto, Ricambi e Competitor e non aveva modo di sapere che esistessero
 * — sembrava un'app rotta, non un'app limitata. Misurato sul gate del server (server.js,
 * `role === 'demo'`): di quei quattro modi solo le SCRITTURE del Competitor sono negate
 * (POST/DELETE su /api/competitor*). Auto, Moto, Ricambi e la lettura dei competitor sono
 * tutte GET permesse. Quindi il selettore resta, e a sparire sono i bottoni che
 * prenderebbero 403 — via CSS (`body.demo-mode`, in style.css), perche' il pannello
 * competitor si ridisegna a ogni azione e una pulizia in JS andrebbe rifatta ogni volta.
 *
 * Via anche `setSearchMode('cerca')`: girava DOPO `ripristinaModo()` e riportava l'ospite
 * su Auto a ogni ricaricamento, buttando via il modo in cui stava lavorando.
 */
function applyDemoMode() {
  document.body.classList.add('demo-mode');
  ['btnSalvaRicerca', 'btnControllaTutte'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
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
  validateMarca();

  // PRIMA del ripristino, non dopo: `ripristinaModo()` rimette il radio su Moto e lancia il
  // suo `change`, ed e' QUESTO gestore l'unico posto che chiama populateMarca('moto').
  // Registrandolo dopo, l'evento partiva senza ascoltatori: chi chiudeva l'app in Moto la
  // riapriva con la barra su Moto e il catalogo marche vuoto — nessuna marca accettata,
  // "Cerca" spento, e l'unico modo di uscirne era passare da Auto e tornare indietro.
  tipoInputs.forEach(input => input.addEventListener('change', async () => {
    document.body.dataset.tipo = input.value;
    sincronizzaFiltriAuto(input.value);
    await populateMarca(input.value);
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
    if (myRole === 'demo') applyDemoMode();
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
  // riposiziona il dropdown "Prezzo €" all'apertura (veicoli + ricambi; delegato → sopravvive ai re-render)
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
      try { localStorage.setItem('amrCarbProvincia', e.target.value); } catch (_) {}
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
    try { localStorage.setItem('amrCarbKm', String(n)); } catch (_) {}
    vehCostoAggiorna();
  });
  vehSchedaEl?.addEventListener('change', e => {
    if (!e.target.classList.contains('veh-carb-km')) return;
    const n = carbKmValido(e.target.value);
    if (n >= KM_MIN && n <= KM_MAX) return;
    try { localStorage.removeItem('amrCarbKm'); } catch (_) {}
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
  // Zero a schermo = zero da esportare, e lo si dice — come fa gia' l'export dei ricambi
  // (`exportCsvRicambi`). Un file col solo intestazione sarebbe muto quanto quello sbagliato.
  const daEsportare = () => { const v = risultatiAVista(); if (!v.length) { showError('Niente da esportare: a schermo non c\'e\' nessun annuncio.'); return null; } return v; };
  btnStatCsv.addEventListener('click', () => { const v = daEsportare(); if (v) exportCsv(v); });
  btnStatPdf.addEventListener('click', () => { const v = daEsportare(); if (v) exportPdf(v); });
  errorClose.addEventListener('click', hideError);
  backToSearch.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (searchMode === 'ricambi') return void await doRicambi();
    if (searchMode === 'competitor') return void await cpAggiungi();
    await doSearch();
  });

  // Nav primaria Auto · Moto · Ricambi (data-mode). Auto/Moto = ricerca veicolo (pilota il
  // radio tipo nascosto); Ricambi = pipeline parti.
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
      // Il venditore di questo annuncio, nella lista di Competitor. Solo aggiunto: il parco
      // lo si scarica da li', quando si vuole — e' una richiesta lunga e non parte a sorpresa.
      const btnCp = e.target.closest('.btn-competitor');
      if (btnCp) { const r = trovaResult(url); if (r) aggiungiVenditoreAlCompetitor(r, btnCp); return; }
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
    // Mobile: tap sulla riga (non sulla thumb) → apre il dettaglio (azioni dentro). Desktop: titolo→annuncio, bottoni espliciti.
    if (window.matchMedia('(max-width: 860px)').matches) { toggleDetail(row); return; }
    if (e.target.closest('.row-titolo')) { openAd(url); return; }
    if (e.target.closest('.btn-salva'))     { toggleSalva(url); return; }
    if (e.target.closest('.btn-confronta'))  { toggleConfronto(url); return; }
    if (e.target.closest('.btn-info'))       { toggleDetail(row); return; }
  });

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
      try { localStorage.setItem('amrPassProvincia', e.target.value); } catch (_) {}
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

  // Filtri avanzati toggle
  advancedToggle?.addEventListener('click', () => {
    const open = advancedFilters.classList.toggle('d-none');
    advancedToggle.setAttribute('aria-expanded', String(!open));
    advancedToggle.classList.toggle('open', !open);
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

  renderSalvati();
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

// Si svuota il testo, ma il campo RESTA a schermo: e' facoltativo e a testo libero, e
// nasconderlo nascondeva anche il fatto che esistesse. L'unico posto che lo toglie sono i
// Ricambi, dove non c'entra niente.
function resetVersioneOnly() {
  if (versioneInput) versioneInput.value = '';
  syncVersione();
}
function resetModelloVersione() { selectedModel = null; resetVersioneOnly(); }

/**
 * LA VERSIONE SI SCRIVE SOLO SOPRA UN MODELLO SCELTO DALL'ELENCO.
 *
 * Il campo accettava testo sempre, ma `doSearch` lo spediva solo dentro il ramo
 * `selectedModel`: scritta senza aver scelto un modello dalla tendina, la versione veniva
 * buttata in silenzio e partiva una ricerca piu' larga di quella che si era chiesta —
 * senza che niente lo dicesse. Delle tre fonti solo Autoscout e Moto.it saprebbero
 * usarla da sola; su Subito serve il nodo di catalogo, che senza modello scelto non c'e'.
 * Decisione del proprietario: non permetterlo. Il campo resta spento, e dice perche'.
 */
function syncVersione() {
  if (!versioneInput) return;
  const ok = !!selectedModel;
  versioneInput.disabled = !ok;
  versioneInput.placeholder = ok
    ? 'facoltativa — es. Highline, GTI, S line, ABS'
    : 'scegli prima un modello dall’elenco';
}

/**
 * Scelto un modello: si svuota la versione scritta prima (era di un altro modello) e si
 * tiene da parte la famiglia Moto.it, che serve a tradurre il testo in un codice.
 * Il campo e' sempre a schermo: qui non c'e' piu' niente da mostrare.
 */
function mostraVersione(model) {
  if (versioneInput) versioneInput.value = '';
  if (selectedModel) selectedModel._familySlug = model.slugMotoIt || null;
  syncVersione();   // il modello c'e': il campo si accende
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

// ─── Raggruppamento ──────────────────────────────────────────────────────────
/**
 * IL MODELLO CHE L'ANNUNCIO DICHIARA — non uno indovinato dal titolo.
 *
 * Qui c'era `clusterModello(titolo)`: prendeva la prima parola con una lettera e la prima
 * con una cifra. Misurato su 200 Volkswagen veri, ne usciva questo:
 *   "volkswagen 1"    38 annunci — la Golf 1.2, la Golf 1.0 e la Passat 1.6 nello stesso mucchio
 *   "volkswagen 5p"   32 annunci — le cinque porte
 *   "volkswagen 2013"  6 annunci — l'anno
 * Settanta gruppi con etichette che non esistono da nessuna parte, scritte in minuscolo e
 * senza accenti perche' erano token, non nomi.
 *
 * Il modello lo dichiarano 198 annunci su 200, e sono gli stessi nomi che usa il resto
 * dell'app (`modelloAnnuncio`, gia' regola per scheda, gomme e liquidita'). Le generazioni
 * restano distinte — "Golf" e "Golf 7ª serie" sono due gruppi — perche' e' quello che la
 * fonte dichiara, e unirle vorrebbe dire decidere noi al posto sua. Quarantasei gruppi, coi
 * nomi veri. Chi non lo dichiara finisce in "Modello non dichiarato": due su duecento.
 */
function modelloGruppo(r) {
  return modelloAnnuncio(r) || 'Modello non dichiarato';
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
    case 'modello':    return modelloGruppo;
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

/**
 * I RAGGRUPPAMENTI, gli stessi per auto e moto — e non e' una svista, e' una misura.
 *
 * "Carburante" sulle moto e' quasi morto (sono tutte benzina) e la CILINDRATA, che su una
 * moto e' il primo dato che si guarda, qui non c'e'. La correzione sembrava ovvia: scambiare
 * i due chip quando si guardano moto. Provata sui dati veri, non si puo' fare — misurato su
 * una ricerca Yamaha MT-07, 239 annunci:
 *
 *   Subito     100 annunci → cilindrata dichiarata su   0
 *   Autoscout  100 annunci → cilindrata dichiarata su  40
 *   Moto.it     39 annunci → cilindrata dichiarata su   0
 *
 * Un chip "Cilindrata" farebbe un gruppo "non indicata" da 199 su 239: peggio del chip morto
 * che sostituisce. E il campo `tipo` non arriva da NESSUNA fonte (0 su 239), quindi nemmeno
 * si potrebbe decidere dai risultati se mostrarlo.
 *
 * Prima viene il dato: la cilindrata Subito e Moto.it la scrivono nel titolo ("MT-07 689"),
 * e va letta li' — e' un lavoro sugli scraper, non sui chip. Fino ad allora questi restano.
 */
const FACET_DIMS = [
  ['', 'Nessuno'], ['modello', 'Modello'], ['fonte', 'Fonte'],
  ['carburante', 'Carburante'], ['anno', 'Anno'], ['km', 'Km'], ['provincia', 'Provincia'],
];
function renderFacetChips() {
  if (!facetChipsEl) return;
  facetChipsEl.innerHTML = FACET_DIMS.map(([dim, label]) =>
    `<button type="button" class="facet-chip${dim === groupDim ? ' active' : ''}" data-dim="${dim}">${label}</button>`).join('')
    // QUANTI SONO, scritto nel chip. Misurato su annunci veri: su cento Golf usate Autoscout
    // ne dichiara zero con IVA esposta e cento in margine, Subito venticinque in margine e
    // settantacinque che non lo dicono. Senza il numero davanti, chi clicca vede una lista
    // vuota e pensa che il filtro sia rotto: cosi' invece sa prima di premere.
    + (() => {
        const n = (currentResults || []).filter(r => r.ivaEsposta === true).length;
        const dis = n === 0 && !soloIva ? ' facet-chip-vuoto' : '';
        return `<button type="button" class="facet-chip${soloIva ? ' active' : ''}${dis}" data-iva="1"`
          + ` title="Solo annunci con IVA esposta: quelli su cui l'imposta la scarichi. In questa ricerca sono ${n}.">Solo IVA esposta <b>${n}</b></button>`;
      })();
}

// ─── Modi di ricerca (Cerca / Ricambi / Catalogo) ──────────────────────────
let searchMode = 'cerca';
// Nav primaria: 'auto'|'moto' → ricerca veicolo (modo Cerca), 'ricambi' → pipeline parti,
// 'catalogo' → listino del nuovo, che NON parte da una ricerca (vedi il blocco cat* in fondo).
// Pilota il radio tipo nascosto (che via il suo change-handler rinfresca marche/placeholder)
// e lo stato attivo dei bottoni.
/**
 * Le AREE dell'app: modi senza form di ricerca, ognuno col suo pannello e le sue funzioni di
 * apertura e chiusura. Aggiungerne una e' una riga qui, invece di quattro casi speciali sparsi
 * fra selectPrimary, setSearchMode, ripristinaModo e la pulizia dei pannelli.
 */
const AREE = {
  competitor: { pannello: 'competitorPanel', apri: () => cpApri(), chiudi: () => cpChiudi() },
};

/**
 * Una voce di tabella cercata con una chiave che arriva DA FUORI — localStorage, un data-attribute,
 * un parametro. Con la lettura diretta, 'constructor' e '__proto__' rispondono qualcosa di vero:
 * `amrModo` sporco in localStorage bastava a far cercare all'app un'area che non esiste.
 */
const voceDi = (tab, k) => (Object.prototype.hasOwnProperty.call(tab, k) ? tab[k] : undefined);
const area = k => voceDi(AREE, k);

function selectPrimary(mode) {
  const primary = ['auto', 'moto', 'ricambi'].includes(mode) || area(mode) ? mode : 'auto';
  document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === primary));
  if (primary === 'ricambi' || area(primary)) { setSearchMode(primary); return; }
  const radio = document.getElementById(primary === 'moto' ? 'tipoMoto' : 'tipoAuto');
  if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  setSearchMode('cerca');
}
function setSearchMode(mode) {
  const prev = searchMode;
  searchMode = (mode === 'ricambi' || area(mode)) ? mode : 'cerca';
  // Ricordare l'area: ricaricando la pagina si torna dove si stava lavorando, invece di
  // ripartire sempre dalla ricerca auto. Si salva anche il tipo, che distingue Auto da Moto.
  try {
    localStorage.setItem('amrModo', searchMode);
    if (searchMode === 'cerca') localStorage.setItem('amrModoTipo', currentTipo());
  } catch (_) {}
  const ricambi = searchMode === 'ricambi';
  const attiva = area(searchMode) || null;
  // Le AREE non hanno un form di ricerca: nascondono tutta la barra invece di riconfigurarla, e
  // vivono nel loro pannello. Stanno in una tabella e non in una catena di if: erano tre casi
  // speciali ripetuti in quattro punti, e ogni area nuova ne aggiungeva uno a ciascuno.
  document.querySelector('section.search').classList.toggle('area-attiva', !!attiva);
  for (const [id, a] of Object.entries(AREE)) {
    const el = document.getElementById(a.pannello);
    if (el) el.classList.toggle('d-none', id !== searchMode);
  }
  // Pannelli output: mostra solo quello del modo attivo (lo popola il rispettivo do*()).
  // Stanno PRIMA del ramo con return perche' quello le saltava: da Ricambi a Catalogo
  // la lista ricambi restava a schermo, e stando prima nel DOM finiva sopra la griglia marche.
  if (!ricambi) document.getElementById('ricambiPanel').classList.add('d-none');
  // `rcGen++` come il searchGen++ di resetContesto (508ea84): uscendo dai Ricambi una
  // risposta ancora in volo aveva myGen === rcGen, atterrava e RESUSCITAVA rcData appena
  // azzerato — la lista di prima ridipinta in un contesto che non e' piu' il suo.
  if (ricambi || prev === 'ricambi') { rcGen++; rcData = null; hideResults(); }   // ingresso/uscita ricambi → pulizia piena (currentResults lo azzera resetContesto)
  if (area(prev) && prev !== searchMode) area(prev).chiudi();
  // Competitor e' l'unica area che tiene la barra: ha una riga di campi sua.
  document.getElementById('competitorFields').classList.toggle('d-none', searchMode !== 'competitor');
  if (attiva) {
    // #marca resta nascosto ma `required`: il submit nativo si bloccherebbe su un campo
    // che non si puo' mettere a fuoco, e il bottone "Analizza" non farebbe niente.
    document.getElementById('marca').required = false;
    hideResults(); attiva.apri(); return;
  }
  // Ricambi ha i suoi campi (OEM) e nasconde i campi auto (marca/modello + tipo).
  document.getElementById('ricambiFields').classList.toggle('d-none', !ricambi);
  document.querySelector('.search-fields').classList.toggle('d-none', ricambi);
  document.querySelector('.seg-toggle').classList.toggle('d-none', ricambi);
  // #marca è required: se resta hidden+required il submit nativo si blocca ("not focusable") → togli required in ricambi.
  document.getElementById('marca').required = !ricambi;
  document.getElementById('advancedToggle').classList.toggle('d-none', ricambi);   // i filtri-ricerca non servono per i ricambi
  if (ricambi) document.getElementById('advancedFilters').classList.add('d-none');
  // La FUNZIONE UNICA della visibilita' dei filtri auto, non una seconda copia del toggle:
  // in Ricambi le otto tendine restavano a schermo e la scelta si perdeva in silenzio
  // (filtriAutoScelti si legge solo nel ramo tipo==='auto'). 'ricambi' non e' 'auto' →
  // nasconde; al rientro in 'cerca' mostra solo se il tipo corrente e' auto — anche
  // quando il radio non cambia e il change non parte.
  sincronizzaFiltriAuto(ricambi ? 'ricambi' : currentTipo());
  btnCerca.textContent = 'Cerca';
  document.getElementById('modello').placeholder =
    currentTipo() === 'moto' ? 'Modello — es. MT-07 (opzionale)' : 'Modello — es. 318d (opzionale)';
  // Nei Ricambi la versione non c'entra; ovunque altro il campo torna, senno' uscendo dai
  // Ricambi resterebbe nascosto per sempre (prima lo riaccendeva solo la scelta di un modello).
  versioniRow?.classList.toggle('d-none', ricambi);
}

// ═══ Modo Ricambi — pipeline parti SEPARATA (multi-fonte, full-width) ═══════════
// Isolata dal path auto: stato/funzioni proprie (prefisso rc/Ricambi), non tocca
// currentResults/COLS/MATRIX_ROWS/exportCsv/renderResults.
const RC_FONTE = { autodoc: 'Autodoc', cmsnl: 'CMSNL', subito: 'Subito', ebay: 'eBay', web: 'Web' };
const RC_GROUP_DIMS = [['', 'Nessuno'], ['fonte', 'Fonte'], ['marca', 'Marca'], ['venditore', 'Venditore']];
const RC_SALVATI_KEY = 'amr_salvati_ricambi', RC_SALVATI_CAP = 200, RC_COMPARE_CAP = 6;
const RC_FAV_KEY = 'amr_oem_preferiti', RC_FAV_CAP = 30;   // codici OE/OEM/OEN preferiti (quick-launch)

/**
 * QUANTE RICERCHE RESTANO PRIMA DI ESSERE FERMATI.
 *
 * Il limitatore lo dice a ogni risposta (`restanti`), e prima non lo leggeva nessuno: si
 * scopriva il tetto sbattendoci contro. Si mostra solo quando sta per finire — un contatore
 * sempre acceso e' rumore, un avviso all'ultimo momento e' una sorpresa.
 */
let rcRestanti = null;        // null = non lo sappiamo ancora
let cpRestanti = null;
const budgetHTML = (restanti, sing, plur) => (restanti != null && restanti <= 3
  ? `<div class="budget-avviso">${restanti === 0
      ? 'Per ora basta'
      : `${restanti === 1 ? 'Resta 1' : 'Restano ' + restanti} ${restanti === 1 ? sing : plur}`}: il limite serve a non farsi bloccare dalle fonti, e si riapre da solo.</div>`
  : '');
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
// `rcMedian` e `rcStats` (min/max/mediana sui ricambi) sono state tolte con la striscia in
// toolbar: nessuno le chiamava piu', e lasciarle in giro e' un invito a rimettere quei numeri
// da qualche altra parte.
function rcBestKey(arts) {   // rcKey del più economico visibile (badge "più economico")
  let best = null;
  for (const a of arts) if (typeof a.prezzo === 'number' && (!best || a.prezzo < best.prezzo)) best = a;
  return best ? rcKey(best) : null;
}
// `rcJumpToStat` (salto all'articolo piu' economico / piu' caro dalla toolbar) e' sparita
// insieme ai due bottoni min/max che la chiamavano.

/**
 * LA SCHEDA DEL PEZZO, accanto alla ricerca per codice originale.
 *
 * Lo stesso pezzo fisico e' in vendita sotto codici diversi: l'originale di un
 * costruttore, quello del gruppo, i numeri sostituiti. Cercando un codice si trovano
 * SOLO gli annunci che hanno scritto quel codice, e la lista sembra completa mentre non
 * lo e'. Prima questa informazione stava in un'altra scheda (Fonti → Ricambi OE): per
 * usarla bisognava espandere a mano, copiare e ricercare uno per uno.
 *
 * Non si cercano tutti in automatico — sarebbe un ventaglio di richieste per una domanda
 * che l'utente non ha fatto. Si mostrano, e ognuno e' cliccabile.
 *
 * I CODICI SONO RAGGRUPPATI PER COSTRUTTORE. In piano erano 31 pastiglie in fila con
 * "Volkswagen (VW)" ripetuto undici volte: il nome del costruttore occupava piu' spazio
 * del codice, che e' l'unica cosa che si legge davvero.
 *
 * E si mostrano anche le MISURE, che sono la ragione per cui uno guarda un ricambio:
 * due dischi con codici diversi possono essere lo stesso pezzo o differire di 3 mm.
 *
 * Arriva DOPO i risultati e non li fa aspettare: la fonte (bilstein) e' una navigazione
 * col browser stealth, la piu' lenta di tutte. Se non risponde, la ricerca vale lo stesso.
 */
let rcOe = { codice: null, stato: 'idle', articoli: [], motivo: null };

function rcOeMisureHTML(misure) {
  if (!misure || !misure.length) return '';
  return '<dl class="rc-pz-mis">' + misure.map(m =>
    `<div><dt>${escapeHtml(m.nome)}</dt><dd>${escapeHtml(m.valore)}${m.unita ? ' ' + escapeHtml(m.unita) : ''}</dd></div>`
  ).join('') + '</dl>';
}

function rcOeCodiciHTML(originali, cercato) {
  // UNA RIGA PER CODICE, non per costruttore. La fonte elenca lo stesso numero VAG sotto
  // ogni marchio del gruppo: "5Q0 615 301 F" compariva cinque volte, sotto Audi, CUPRA,
  // Seat, Skoda e Volkswagen. Raggruppando per costruttore erano 31 voci per 14 codici
  // veri, e il codice — l'unica cosa che si legge — annegava nella ripetizione.
  const per = new Map();
  for (const g of (originali || [])) {
    for (const c of (g.codici || [])) {
      const k = normOenLite(c);
      if (!k) continue;
      if (!per.has(k)) per.set(k, { codice: c, chi: new Set() });
      if (g.costruttore) per.get(k).chi.add(g.costruttore);
    }
  }
  if (!per.size) return '';
  const voci = [...per.values()];
  // CHIUSA DI DEFAULT. Sono quattordici righe su un disco freno e possono essere molte di
  // piu': aperte spingevano giu' le offerte, che sono la ragione per cui si e' qui.
  return `<details class="rc-pz-dd"><summary class="rc-pz-sum">Codici originali equivalenti`
    + `<span class="rc-pz-n">${voci.length}</span>`
    + '<span class="rc-pz-hint">clicca un codice per cercarlo</span></summary>'
    + '<div class="rc-pz-lista">'
    + voci.map(v => {
        const suo = normOenLite(v.codice) === normOenLite(cercato);
        const chi = [...v.chi].join(', ');
        return '<div class="rc-pz-riga">'
          + `<button type="button" class="rc-pz-c${suo ? ' suo' : ''}" data-codice="${escapeHtml(v.codice)}"`
          + (suo ? ' title="e\' il codice che stai cercando"' : '') + `>${escapeHtml(v.codice)}</button>`
          + `<span class="rc-pz-mk">${escapeHtml(chi)}</span></div>`;
      }).join('')
    + '</div></details>';
}

/** confronto codici alla buona: solo per evidenziare quello cercato, non per decidere niente. */
const normOenLite = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function rcOeHTML() {
  if (ricambiMode !== 'oem' || !rcOe.codice) return '';
  // Vive DENTRO la scheda tecnica, non in un riquadro suo: sono dati dello stesso pezzo,
  // e due cornici affiancate facevano sembrare due schede quello che e' una sola.
  const cap = t => `<div class="rc-pz"><div class="rc-pz-h">Dati del pezzo <span class="rc-pz-src">bilstein group — febi / SWAG / Blue Print</span></div>${t}</div>`;
  if (rcOe.stato === 'carico') return cap('<div class="rc-pz-att">cerco i dati del pezzo…</div>');
  if (rcOe.stato === 'ko') return cap(`<div class="rc-pz-att">${escapeHtml(rcOe.motivo || 'fonte non disponibile ora')}</div>`);
  if (!rcOe.articoli.length) return cap('<div class="rc-pz-att">questo codice non e\' nel catalogo febi / SWAG / Blue Print</div>');
  return cap(rcOe.articoli.map(a => `<article class="rc-pz-a">
    <header class="rc-pz-a-h">
      <b>${escapeHtml(a.marchio || '')} ${escapeHtml(a.articolo || '')}</b>
      <span class="rc-pz-desc">${escapeHtml(a.descrizione || '')}${a.lato ? ' · ' + escapeHtml(a.lato) : ''}</span>
      ${a.scheda ? `<a class="rc-pz-link" href="${escapeHtml(a.scheda)}" target="_blank" rel="noopener noreferrer">scheda ↗</a>` : ''}
    </header>
    ${rcOeMisureHTML(a.misure)}
    ${rcOeCodiciHTML(a.originali, rcOe.codice)}
  </article>`).join(''));
}

async function rcCaricaOe(codice, gen) {
  rcOe = { codice, stato: 'carico', articoli: [], motivo: null };
  renderRicambiPanel();
  try {
    const r = await fetch('/api/fonti/ricambi-oe/cerca?codice=' + encodeURIComponent(codice)
      + '&tipo=' + encodeURIComponent(rcVeicolo));
    const d = await r.json();
    if (gen !== rcGen) return;                       // ricerca superata: non toccare piu' niente
    // La rotta risponde `ok:false` con il motivo, non `error`: cercando il campo sbagliato
    // un blocco della fonte diventava "questo codice non e' a catalogo", che e'
    // un'affermazione di fatto sul catalogo e non un avviso di servizio.
    if (!r.ok || d.error || d.ok === false) rcOe = { codice, stato: 'ko', articoli: [], motivo: d.motivo || d.error || null, bloccataFino: d.bloccataFino || null };
    else rcOe = { codice, stato: 'ok', articoli: d.articoli || [], motivo: d.motivo || null };
  } catch (_) {
    if (gen !== rcGen) return;
    rcOe = { codice, stato: 'ko', articoli: [], motivo: null };
  }
  renderRicambiPanel();
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
  // I DATI DI PRIMA ESCONO SUBITO. Restando, una ricerca fallita lasciava rcData della
  // ricerca PRECEDENTE: l'errore andava a schermo, ma la porta del pannello
  // (`if (rcData) renderRicambiPanel()`) ridipingeva la lista vecchia sotto il codice nuovo.
  rcData = null;
  rcOe = { codice: null, stato: 'idle', articoli: [], motivo: null };   // nuova ricerca, nuova scheda
  try {
    const res = await fetch(`/api/ricambi?q=${encodeURIComponent(q)}&mode=${ricambiMode}&veicolo=${rcVeicolo}`);
    const d = await res.json();
    if (myGen !== rcGen) return;   // ricerca superata da una più recente
    if (!res.ok) { rcRestanti = (d.restanti != null ? d.restanti : rcRestanti); panel.innerHTML = `<div class="rc-wrap"><div class="rc-empty">${escapeHtml(d.error || 'Errore durante il lookup.')}</div></div>`; return; }
    // id stabile per articolo (gli item web possono non avere url/articleId → il nome collide) → indice per unicità
    (d.articoli || []).forEach((a, i) => { if (!a._rk) a._rk = `${a.fonte}:${a.url || a.articleId || (a.nome + '#' + i)}`; });
    rcData = d; rcView = 'grid';
    if (d.restanti != null) rcRestanti = d.restanti;
    rcCollapsed = new Set(); rcOpenDetails = new Set(); rcSchedaCollapsed = false;   // nuova ricerca → reset gruppi/dettagli/scheda
    rcVariantSpecs = {};
    const cat = d.scheda && d.scheda.catalogo;   // v7: selettore varianti — dominante pre-aperto, default variante se tipo singolo
    rcVariantSel = cat ? { tipo: cat.tipoDominante, articleId: cat.defaultArticleId } : { tipo: null, articleId: null };
    renderRicambiPanel();
    if (cat && cat.defaultArticleId) rcFetchVariantSpecs(rcSelectedVariant());
    // Gli equivalenti dopo, e senza await: i risultati non devono aspettare la fonte piu' lenta.
    if (ricambiMode === 'oem') rcCaricaOe(d.oen || q, myGen);
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
function rcFitsTable(compat, totale) {
  const list = Array.isArray(compat) ? compat : String(compat || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return '';
  const cap = 20;
  const rows = list.slice(0, cap).map(f => {
    const p = rcParseFit(f);
    return `<tr><td>${escapeHtml(p.marca)}</td><td>${escapeHtml(p.modello)}</td><td>${escapeHtml(p.anno)}</td></tr>`;
  }).join('');
  /**
   * QUANTI SONO IN TUTTO, non quanti me ne hanno passati.
   *
   * Il server manda al massimo venti modelli, e qui si scriveva `list.length`: un pezzo
   * compatibile con sessanta modelli diceva "20 modelli". La riga "+N altri" esisteva gia'
   * ma non poteva scattare, perche' il tetto qui era lo stesso di la'. Ora il totale vero
   * viaggia col dato (`compatibilitaTotale`), e la riga dice quanti restano fuori.
   */
  const quanti = (Number.isFinite(totale) && totale > list.length) ? totale : list.length;
  const nascosti = quanti - Math.min(list.length, cap);
  const more = nascosti > 0
    ? `<div class="rc-fits-more">+${nascosti} altri, ne vuoi di più? Parliamone!</div>` : '';
  // dropdown consultabile su interazione (chiuso di default) — pattern nativo <details>
  return `<div class="rc-sch-sec"><details class="rc-fits"><summary class="rc-fits-sum">Compatibilità · ${quanti} ${quanti === 1 ? 'modello' : 'modelli'}</summary>` +
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
  // Solo le immagini del CATALOGO: `fotoReale` e `galleria` venivano da un'inserzione eBay o
  // dal primo annuncio usato di Subito, e in una scheda di catalogo non ci stanno (vedi
  // ricambi-core.js). Le foto degli annunci restano sugli annunci.
  const imgs = [(v && v.immagine)].filter(Boolean);
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
  const foto = v.immagine;   // del catalogo, non di un annuncio (vedi rcLightboxImgs)
  const img = foto ? `<img class="rc-sch-img" src="${escapeHtml(foto)}" alt="" referrerpolicy="no-referrer">` : '<div class="rc-sch-img rc-img-ph"></div>';
  const url = rcSafeUrl(v.url);
  const buybox = `<div class="rc-sch-buybox"><span class="rc-sch-price-lab">Prezzo nuovo${v.marca ? ' · ' + escapeHtml(v.marca) : ''}</span>` +
    `<div class="rc-sch-priceline"><span class="rc-prezzo">${v.prezzo != null ? rcEur(v.prezzo) : 'n/d'}</span>${v.prezzoListino && v.sconto ? `<span class="rc-listino">${rcEur(v.prezzoListino)}</span><span class="rc-sconto">-${escapeHtml(String(v.sconto))}%</span>` : ''}</div>` +
    `${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">su ${escapeHtml(RC_FONTE[v.fonte] || v.fonte)} ↗</a>` : ''}</div>`;
  const lazy = rcVariantSpecs[v.articleId];
  // loading SOLO se il fetch lazy può davvero partire (stessa guardia di rcFetchVariantSpecs):
  // variante senza url prodotto → nessun fetch → niente spinner eterno
  const loading = v.fonte === 'autodoc' && !!rcSafeUrl(v.url) && (!lazy || lazy.loading);
  const datiTecnici = { ...(v.datiTecnici || {}), ...((lazy && !lazy.loading && lazy.datiTecnici) || {}) };   // solo catalogo
  const compat = v.compatibilita || (lazy && !lazy.loading && lazy.compatibilita) || null;
  const dtBlock = rcDtGridHTML(datiTecnici);
  // specs/compatibilità = chiamata lazy alla product-page → indicatore chiaro finché arriva
  const loadingBlock = loading
    ? '<div class="rc-sch-sec"><div class="rc-det-loading"><span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span> Carico dati tecnici e compatibilità…</div></div>'
    : '';
  const compatTot = v.compatibilitaTotale || (lazy && !lazy.loading && lazy.compatibilitaTotale) || null;
  const compatBlock = loading ? '' : rcFitsTable(compat, compatTot);
  // Il vuoto ha due cause diverse: Autodoc non ha specifiche per questo articolo, oppure la
  // pagina non si e' lasciata leggere (challenge Cloudflare, HTTP, timeout). Prima uscivano
  // identiche — la sezione spariva e basta — e si leggeva come "questo articolo non ha
  // specifiche", che e' un'affermazione sul catalogo che nessuno aveva verificato.
  const motivoKo = (!loading && lazy && lazy.motivo && !['ok', 'senza-tabelle'].includes(lazy.motivo)) ? lazy.motivo : null;
  const koBlock = (motivoKo && !dtBlock && !compatBlock)
    ? `<div class="rc-sch-sec"><div class="rc-sch-emptymsg">Dati tecnici e compatibilità non letti da Autodoc (${escapeHtml(motivoKo === 'bloccato' ? 'pagina protetta' : motivoKo)}) — riprova tra poco.</div></div>`
    : '';
  const oe = (s.oeAlternativi && s.oeAlternativi.length)
    ? `<div class="rc-sch-sec"><div class="rc-sch-sechd">Codici OE equivalenti</div><div class="rc-oechips">${s.oeAlternativi.slice(0, 14).map(c => `<button type="button" class="rc-oe" data-oe="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}</div></div>`
    : '';
  return `<div class="rc-sch-main">${img}${buybox}</div><div class="rc-sch-secs">${dtBlock}${loadingBlock}${compatBlock}${koBlock}${oe}</div>`;
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
    // I dati OE non dipendono da Autodoc: se quello non ha il pezzo, questi restano.
    const oe = rcOeHTML();
    const vuota = `<div class="rc-scheda rc-scheda-empty"><div class="rc-sch-body"><div class="rc-sch-tit">${idLine}</div><div class="rc-sch-emptymsg">${msg}</div></div>${oe}</div>`;
    if (!oe) return vuota;
    return `<div class="rc-group${rcSchedaCollapsed ? ' collapsed' : ''}">`
      + `<button type="button" class="rc-group-head rc-sched-head"><span class="rc-gcaret">${icon('chevron')}</span><span class="rc-group-title">Scheda tecnica</span><span class="rc-group-meta">${idParts.join(' · ').slice(0, 90)}</span></button>`
      + `<div class="rc-group-body">${vuota}</div></div>`;
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
  const inner = `<div class="rc-scheda">${tipiChips}${varDropdown}${body}${rcOeHTML()}</div>`;
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
    // Anche il fallimento della NOSTRA rotta e' un motivo: senza, restava un oggetto vuoto
    // indistinguibile da "Autodoc non ha specifiche per questo articolo".
    rcVariantSpecs[v.articleId] = r.ok ? await r.json() : { motivo: 'errore' };
  } catch { rcVariantSpecs[v.articleId] = { motivo: 'errore' }; }
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
  const oeOpen = !!panel.querySelector('.rc-pz-dd[open]');   // altrimenti si richiude sotto il dito
  const restoreOpen = () => {
    if (ddOpen) panel.querySelector('.rc-var-dd')?.setAttribute('open', '');
    if (colsOpen) panel.querySelector('.tb-cols:not(.price-menu)')?.setAttribute('open', '');
    if (priceOpen) panel.querySelector('.price-menu')?.setAttribute('open', '');
    if (oeOpen) panel.querySelector('.rc-pz-dd')?.setAttribute('open', '');
  };
  const rawArts = d.articoli || [];
  // SOLO fonti in errore (diagnostica) — le pill "ok" ridondano col group-by Fonte, via.
  const badSrc = Object.entries(d.sources || {}).filter(([, s]) => ['blocked', 'error', 'timeout'].includes(s.status));
  const statusLine = badSrc.length
    ? `<div class="rc-srcline">${badSrc.map(([k, s]) => `<span class="rc-src rc-src-bad"${s.reason ? ` title="${escapeHtml(s.reason)}"` : ''}>${escapeHtml(RC_FONTE[k] || k)}: ${s.status === 'blocked' ? 'bloccato' : escapeHtml(s.status)}</span>`).join('')}</div>`
    : '';
  /**
   * PAGINE TROVATE SUL WEB, non offerte.
   *
   * Quando la ricerca web non riesce a dire chi vende cosa, restano i link che il motore ha
   * trovato cercando quel codice. Prima finivano nella lista delle offerte, col dominio al
   * posto del venditore e il prezzo vuoto: in mezzo a Subito e eBay erano indistinguibili da
   * un'offerta vera. Adesso stanno qui, con scritto cosa sono.
   */
  const pagine = Array.isArray(d.pagineWeb) ? d.pagineWeb : [];
  const pagineLine = pagine.length
    ? `<div class="rc-pagine"><div class="rc-pagine-h">Pagine trovate sul web — non sono offerte, sono risultati di ricerca su questo codice</div>`
      + pagine.map(x => `<a class="rc-pagina" href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">`
          + `<span class="rc-pagina-t">${escapeHtml(String(x.nome || x.url).slice(0, 90))}</span>`
          + `<span class="rc-pagina-d">${escapeHtml(x.dominio || '')}</span></a>`).join('')
      + '</div>'
    : '';
  const head = `<div class="rc-head">${rcSchedaHTML(d)}${statusLine}${budgetHTML(rcRestanti, 'ricerca', 'ricerche')}${pagineLine}</div>`;
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
      // La testata dice il RETTIFICATO come le righe che riassume: il minimo si sceglie sul
      // grezzo (finale = base + aggiunte − spese, stessa monotonia: il vincitore non cambia)
      // ma la cifra stampata sopra righe rettificate non puo' essere di un'altra scala.
      const daMin = prezzi.length ? (rPricing(Math.min(...prezzi)) || {}).finale : null;
      const meta = `${g.items.length} ricambi${daMin != null ? ' · da ' + rcEur(daMin) : ''}`;
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
  // NIENTE min/max. Il campione mette insieme cose che non si confrontano — un catalogo di
  // ricambi nuovi, annunci usati e offerte eBay — quindi un intervallo aggregato descrive un
  // mercato che non esiste. Il piu' economico si trova ordinando la colonna Prezzo, che e'
  // un'operazione che si vede, non un numero da credere.
  const statsHTML = `<span class="tb-count">${list.length} ricambi</span>`;
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
  /**
   * Anche questo documento lo disegna il server, con lo STESSO layout del PDF veicoli.
   * Qui c'era la quarta copia dello stesso foglio — header, tabella, pastiglia fonte — e si
   * vedeva: banda alta 20mm invece di 24, niente logo, niente piede numerato, caratteri di un
   * altro corpo. "Allineato" non si ottiene ricopiando meglio, si ottiene smettendo di copiare.
   */
  const meta = rcData || {};
  const cfg = priceCfgR;
  const extraH = priceExtraHeaders(cfg);
  const conConti = extraH.length > 0;
  const colonne = ['Fonte', 'Ricambio', 'Marca', conConti ? 'Prezzo finale' : 'Prezzo', 'Venditore', ...extraH];
  const righe = arts.map(a => {
    const pr = rPricing(a.prezzo);
    return [' ', a.nome || '\u2014', a.marca || '\u2014', pr ? rcEur(pr.finale) : rcPriceText(a), a.venditore || '\u2014',
      ...priceExtraValues(pr, cfg).map(x => x === '' ? '\u2014' : rcEur(x))];
  });
  const colonneStile = Object.assign(
    { 0: { halign: 'center', cellWidth: 24 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 34 },
      3: { halign: 'right', cellWidth: 30, fontStyle: 'bold', textColor: [31, 111, 235] }, 4: { cellWidth: 44 } },
    ...extraH.map((_, i) => ({ [5 + i]: { cellWidth: 26, halign: 'right' } })));
  const nome = `ricambi-${String(meta.oen || 'export').toLowerCase().replace(/[^a-z0-9]/g, '')}-${new Date().toISOString().slice(0, 10)}.pdf`;
  scaricaPdf({
    titolo: 'AUTO MOTO RADAR \u2014 Ricambi',
    sottotitolo: [[meta.tipoPezzo, meta.veicoli].filter(Boolean).join(' \u00b7 '), meta.oen ? 'OE/OEM ' + meta.oen : null].filter(Boolean).join('   \u00b7   '),
    contatore: arts.length + (arts.length === 1 ? ' ricambio' : ' ricambi'),
    colonne, righe, colonneStile,
    fonti: arts.map(a => a.fonte),
    nome,
  });
}

/**
 * L'unica porta verso il PDF: compone la richiesta, riceve il documento e lo scarica.
 * Sta qui perche' i due bottoni (veicoli e ricambi) facevano ognuno il suo download a mano.
 */
function scaricaPdf(payload) {
  fetch('/api/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: payload.nome || 'automotoradar.pdf' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })
    .catch(e => { console.error('[pdf]', e); showError('PDF non generato: ' + e.message); });
}

// 3 input DEDICATI (uno per modo, valore persistente al cambio tab) + selettore veicolo.
// La ricerca e' ANCORATA a #ricambiFields: `.rc-input` non e' uno stile, e' il gancio con cui
// si sceglie quale dei tre input mostrare. Presa larga su tutto il documento agganciava anche
// #cpUrl (il link della vetrina, che sta in un'altra riga della stessa barra): non avendo
// `data-rcfor`, il confronto era vero sempre e ogni cambio tab dei Ricambi lo nascondeva —
// la sezione Competitor restava senza campo, e senza ricaricare la pagina non tornava.
const rcActiveInput = () => document.querySelector(`#ricambiFields .rc-input[data-rcfor="${ricambiMode}"]`);
function setRicambiMode(m) {
  ricambiMode = ['nome', 'prodotto'].includes(m) ? m : 'oem';
  document.querySelectorAll('#ricambiModeToggle .rc-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.rcmode === ricambiMode));
  document.querySelectorAll('#ricambiFields .rc-input').forEach(i => i.classList.toggle('d-none', i.dataset.rcfor !== ricambiMode));
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
    // Un codice equivalente cliccato diventa la ricerca, e il campo si aggiorna con lui:
    // altrimenti staresti guardando i risultati di un codice mentre l'input ne mostra
    // un altro, e non avresti modo di accorgertene.
    const eq = t.closest('.rc-pz-c:not(.suo)');
    if (eq) {
      e.preventDefault();
      const inp = rcActiveInput();
      if (inp) { inp.value = eq.dataset.codice; doRicambi(); }
      return;
    }
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
/**
 * "CARICA ALTRI 100" — la fetta successiva, chiesta quando la chiedi tu.
 *
 * NON e' una pagina 2 che sostituisce la 1, ed e' una scelta, non una scorciatoia:
 * l'app ordina per prezzo e FONDE tre fonti, quindi la fetta successiva di Subito puo'
 * contenere un'auto piu' economica dell'ultima di Autoscout. Con le pagine vedresti un
 * prezzo piu' basso DOPO uno piu' alto; aggiungendo e riordinando l'ordine resta vero.
 *
 * Il bottone compare solo se una fonte ha ancora roba: il totale ce l'abbiamo dalle
 * risposte, quindi non si tira a indovinare.
 */
let fettaPresa = 0;            // ultima fetta caricata (0 = la prima ricerca)
let caricandoAltri = false;

function altriDisponibili() {
  const s = lastSources || {};
  return ['subito', 'autoscout', 'moto'].some(f => {
    const x = s[f];
    return x && x.status === 'ok' && x.totale != null && x.totale > presiDa(f);
  });
}
// Quanti ne abbiamo gia' presi da quella fonte, contando tutte le fette caricate.
function presiDa(fonte) {
  return currentResults.filter(r => r.fonte === fonte).length;
}

async function caricaAltri() {
  if (caricandoAltri || !lastSearchParams) return;
  caricandoAltri = true; renderAltriBtn();
  const myGen = searchGen;
  try {
    const q = new URLSearchParams({ ...lastSearchParams, fetta: String(fettaPresa + 1) });
    const res = await fetch(`/api/search?${q}`);
    const data = await res.json();
    if (myGen !== searchGen) return;         // una ricerca nuova ha preso il posto
    if (!res.ok) { toast(data.error || 'Non riuscito'); return; }
    const visti = new Set(currentResults.map(r => r.url));
    const nuovi = (data.risultati || []).filter(r => r && r.url && !visti.has(r.url));
    /**
     * CHI NON HA RISPOSTO IN QUESTA FETTA.
     *
     * Serve guardarlo QUI perche' `fondiTotali` tiene di proposito lo stato 'ok' della fetta
     * precedente — senza, un timeout sulla fetta 2 cancellava la pill verde della fetta 1 e
     * faceva sparire il bottone. Ma proprio per quella scelta, se non si legge adesso
     * `data.sources`, la caduta non la vede piu' nessuno: restava un toast che diceva «Non ci
     * sono altri annunci», cioe' una frase sul MERCATO, dopo aver chiesto e non ricevuto.
     */
    const cadute = ['subito', 'autoscout', 'moto'].filter(f => {
      const s = (data.sources || {})[f];
      return s && s.status && !['ok', 'empty', 'skipped'].includes(s.status);
    });
    const nomiCadute = cadute.map(f => FONTE_LABEL[f] || f).join(' e ');
    // LA FETTA SI CONSUMA SOLO SE E' STATA CONSEGNATA. Con `fettaPresa++` incondizionato, la
    // finestra che la fonte caduta non ha portato non veniva piu' chiesta: il clic dopo saltava
    // direttamente a quella successiva, e quei ~100 annunci erano persi per tutta la sessione.
    if (!cadute.length) fettaPresa++;
    if (!nuovi.length) {
      lastSources = fondiTotali(data.sources, cadute);
      renderSourceStatus();          // mancava del tutto su questo ramo
      toast(cadute.length
        ? `${nomiCadute} non ${cadute.length === 1 ? 'ha' : 'hanno'} risposto — premi ancora per riprovare`
        : 'Non ci sono altri annunci');
      return;
    }
    // IL CURSORE VA RIFATTO. Il suo BINARIO (non solo le maniglie) era calcolato sui prezzi
    // della PRIMA fetta soltanto, e renderResults filtra su quel binario: ogni annuncio nuovo
    // fuori da quella finestra spariva in silenzio, e l'utente non poteva nemmeno allargarlo.
    // Nel caso peggiore — una fonte sola, ordinata per prezzo crescente — la fetta successiva
    // e' per costruzione tutta sopra il massimo: 100 annunci scaricati, uno solo a schermo.
    const stretta = manigliePrezzoStrette();
    currentResults = currentResults.concat(nuovi);
    lastSources = fondiTotali(data.sources, cadute);
    renderSourceStatus();
    initPrezzoSlider(currentResults, stretta);
    if (!prezzoSliderInstance) renderResults(currentResults);   // niente cursore → disegna qui
    const fuori = stretta ? nuovi.filter(r => r.prezzo != null && (r.prezzo < stretta[0] || r.prezzo > stretta[1])).length : 0;
    // Una fetta puo' portare annunci nuovi E avere una fonte caduta: si dicono tutte e due.
    toast([`Aggiunti ${nuovi.length} annunci`,
      fuori ? `${fuori} fuori dal filtro prezzo` : null,
      cadute.length ? `${nomiCadute} non ${cadute.length === 1 ? 'ha' : 'hanno'} risposto` : null,
    ].filter(Boolean).join(' · '));
  } catch (_) {
    toast('Impossibile contattare il server');
  } finally { caricandoAltri = false; renderAltriBtn(); }
}

// I conteggi per fonte devono contare TUTTE le fette, non l'ultima: il totale della
// fonte invece resta quello che dichiara lei.
// `cadute`: le fonti che non hanno risposto in QUESTA fetta. Lo stato buono si conserva (vedi
// sotto), quindi senza questa marcatura la caduta non arriverebbe da nessuna parte.
function fondiTotali(nuove, cadute = []) {
  const out = {};
  const eCaduta = f => cadute.includes(f);
  for (const f of ['subito', 'autoscout', 'moto']) {
    const vecchia = (lastSources || {})[f] || null;
    const n = (nuove || {})[f] || null;
    if (!vecchia && !n) continue;
    // UNO STATO BUONO NON SI PERDE PER UNA FETTA ANDATA MALE. Con lo spread nudo, un
    // timeout sulla fetta 2 sovrascriveva l' 'ok' della prima: la pill passava da
    // "Subito 100 di 11.610" a "Subito timeout" con i 100 annunci ancora a schermo, e
    // "Carica altri" spariva (altriDisponibili pretende 'ok') senza modo di riprovare.
    // Il conteggio invece si aggiorna sempre: conta cio' che si vede.
    if (vecchia && vecchia.status === 'ok' && n && n.status !== 'ok') {
      out[f] = { ...vecchia, count: presiDa(f), ultimaFettaKo: (n && n.status) || 'error' };
      continue;
    }
    out[f] = { ...(vecchia || {}), ...(n || {}), count: presiDa(f),
               totale: (n && n.totale != null) ? n.totale : (vecchia && vecchia.totale),
               // L'avviso di allargamento vale per gli annunci a schermo, non per l'ultima
               // fetta: se resta anche una riga allargata, l'avviso deve restare con lei.
               allargato: (n && n.allargato) || (vecchia && vecchia.allargato) || null,
               reason: (n && n.reason) || (vecchia && vecchia.reason) || null,
               // La caduta vale per l'ULTIMA fetta soltanto: appena una riesce, sparisce.
               ultimaFettaKo: eCaduta(f) ? ((n && n.status) || 'error') : null };
  }
  return out;
}

function renderAltriBtn() {
  const el = document.getElementById('caricaAltri');
  if (!el) return;
  const mostra = searchActive && currentResults.length > 0 && altriDisponibili();
  el.classList.toggle('d-none', !mostra);
  const b = el.querySelector('button');
  if (b) { b.disabled = caricandoAltri; b.textContent = caricandoAltri ? 'Carico…' : 'Carica altri annunci'; }
}

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
    // LA VERSIONE, com'e' stata scritta. Una sola, e il server la smista:
    //   Subito     va in `q=` SOPRA gli id di marca e modello — la fonte restringe, noi
    //              non ci mettiamo in mezzo
    //   Autoscout  va nel suo `modelVersionInput`, che e' nativo
    //   Moto.it    e' l'unica dove va tradotta, e contro il SUO catalogo
    const vt = (versioneInput?.value || '').trim();
    if (vt) params.versione = vt.slice(0, 80);
  }
  // I filtri avanzati delle auto: il server li ignora sulle moto, ma non glieli mandiamo
  // nemmeno — un parametro che viaggia e non fa niente e' un parametro che un giorno
  // qualcuno legge e crede applicato.
  if (tipo === 'auto') Object.assign(params, filtriAutoScelti());
  Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });
  closeMatrix();   // le spunte restano (attraversano i contesti), il pannello aperto no
  // `has-results` NON si mette qui: quattro righe piu' sotto `hideResults()` la toglie —
  // sempre, in tutti i rami — quindi in Auto/Moto il body non l'ha avuta mai, nemmeno dopo la
  // prima ricerca. Effetto: la barra di ricerca restava alta un'intera schermata (misurato:
  // 670px invece di 158 su un viewport da 900) e lo sfondo dello stato-vuoto restava in
  // filigrana dietro i risultati. Si mette quando i risultati ci sono davvero.
  document.body.dataset.tipo = tipo;

  // ORDINE OBBLIGATO: `hideResults()` azzera il contesto (vedi `resetContesto`) e brucia il
  // token, quindi TUTTO cio' che descrive questa ricerca si scrive DOPO — senno' lo
  // cancellava il reset — e il token di QUESTA ricerca si prende per ultimo, senno' la
  // ricerca scarterebbe se stessa.
  showLoading(); hideResults();
  lastSearchParams = { ...params };
  // Liquidita per la marca cercata: alimenta il segno accanto a ogni annuncio. Solo auto
  // (le moto non hanno il dato) e solo con una marca: una richiesta per ricerca, cachata.
  // Il ramo negativo lo fa gia' `resetContesto`: senza, i dati della marca AUTO precedente
  // restavano e finivano accanto a una moto — "Fiat 500: 94.618 passaggi" su una Honda CB 500.
  if (params.tipo !== 'moto' && params.marca) liqCarica(params.marca, params.modello, params.tipo);
  visibleCols = colsDefault(params);   // il default della ricerca, piu' preciso di quello a vuoto
  syncColMenu();
  const myGen = ++searchGen;   // review: se ne parte un'altra mentre questa è in volo, la stantia si scarta
  try {
    const res = await fetch(`/api/search?${new URLSearchParams(params)}`);
    const data = await res.json();
    if (myGen !== searchGen) return;   // una ricerca più recente ha già preso il posto → non sovrascrivere
    if (!res.ok) { showError(data.error || 'Errore durante la ricerca.'); return; }

    currentResults = data.risultati || [];
    searchActive = true;
    // La ricerca e' andata: la pagina smette di vestirsi da schermo vuoto (barra compatta,
    // niente sfondo). Anche a zero risultati — perche' a quel punto la risposta e' il pannello
    // "nessun annuncio", non la schermata di partenza.
    document.body.classList.add('has-results');
    fettaPresa = 0;                      // ricerca nuova: si riparte dalla prima fetta
    lastSources = data.sources || null;
    renderSourceStatus();

    if (data.subitoStatus === 'needs_bootstrap') showBootstrapBanner(); else hideBootstrapBanner();
    fetchSubitoStatus();

    initPrezzoSlider(currentResults);
    if (!prezzoSliderInstance) renderResults(currentResults);
    // La scheda tecnica non parte piu' con la ricerca: vive dentro l'annuncio e la chiedi
    // tu da li'. L'azzeramento e' gia' passato da `resetContesto` (via hideResults), che e'
    // l'unico punto: qui una seconda copia poteva solo divergere.
    if (currentResults.length > 0) resultsToolbar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch {
    if (myGen === searchGen) showError('Impossibile contattare il server. Assicurati che sia avviato con "npm start".');
  } finally { if (myGen === searchGen) hideLoading(); }
}

// ─── Subito bootstrap ─────────────────────────────────────────────────────────
function showBootstrapBanner() { statusBox.classList.remove('d-none'); subitoBanner.classList.remove('d-none'); subitoBanner.classList.add('d-flex'); }
function hideBootstrapBanner() { subitoBanner.classList.add('d-none'); subitoBanner.classList.remove('d-flex'); }
async function runSubitoBootstrap() {
  // La finestra col CAPTCHA si apre sull'iMac dove gira AMR, non su questo schermo: se non
  // sei tu quello seduto li', premere non ti fa vedere niente. Il server lo dichiara
  // (campo `dove`), e lo si dice PRIMA, mentre il bottone gira.
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
      if (data.dove === 'iMac') note.textContent += ' Il CAPTCHA è stato risolto sull\'iMac.';
      statusBox.appendChild(note);
      setTimeout(() => note.remove(), 6000);
    } else {
      // `dove: 'iMac'` = la richiesta non e' arrivata dalla macchina che ospita AMR, quindi
      // la finestra si e' aperta altrove: senza dirlo, da qui si vede solo un errore muto.
      const altrove = data.dove === 'iMac' ? ' La finestra del CAPTCHA si apre sull\'iMac dove gira AMR: va risolta lì.' : '';
      const reasonMap = {
        window_closed: 'Hai chiuso la finestra Chrome prima del completamento.',
        timeout: 'Tempo scaduto (5 minuti): il CAPTCHA non è stato completato.',
        chrome_launch_failed: 'Impossibile aprire Chrome. Riprova o contatta lo sviluppatore.',
        error: 'Errore tecnico durante il bootstrap.',
      };
      const reasonText = reasonMap[data.reason] || `Errore: ${data.reason || 'sconosciuto'}`;
      const hint = data.hint ? ` ${data.hint}` : '';
      showError(`Bootstrap Subito fallito. ${reasonText}${hint}${altrove}`);
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
/** Le maniglie sono state mosse a mano? (cioe' non stanno agli estremi del binario) */
function manigliePrezzoStrette() {
  if (!prezzoSliderInstance) return null;
  const [a, b] = prezzoSliderInstance.get().map(Number);
  const [gMin, gMax] = sliderGlobalBounds;
  return (a > gMin || b < gMax) ? [a, b] : null;
}

function initPrezzoSlider(results, mantieni = null) {
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
  // `mantieni` lo passa solo "Carica altri": il BINARIO si allarga sui prezzi di tutto lo
  // scaricato, ma la stretta fatta a mano resta dov'era invece di essere buttata via.
  const da = mantieni ? Math.max(minP, Math.min(maxP, mantieni[0])) : minP;
  const a  = mantieni ? Math.max(minP, Math.min(maxP, mantieni[1])) : maxP;
  prezzoSliderInstance = noUiSlider.create(prezzoSliderEl, {
    start: [da, a], connect: true, range: { min: minP, max: maxP }, step: 100,
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
/**
 * LA VERSIONE E' UN FILTRO, e chi non la porta esce dalla lista.
 *
 * Il server MARCA e non toglie: cosi' il totale resta onesto e questi annunci si possono
 * rimettere con un clic. Qui si tolgono, si contano, e si scrive quanti sono — nascondere
 * senza dirlo sarebbe il post-filtro muto che in questa app non si fa.
 *
 * 'ignota' resta dentro: vuol dire che l'annuncio non dichiara niente e il titolo non aiuta,
 * cioe' non lo sappiamo. Toglierlo sarebbe far passare "non lo so" per "non e' quella".
 */
let mostraVersioniSmentite = false;

function rigaVersione(tolti) {
  let el = document.getElementById('avvisoVersione');
  if (!el) {
    el = document.createElement('div');
    el.id = 'avvisoVersione';
    el.className = 'avviso-versione d-none';
    fonteBreakdown?.parentNode?.insertBefore(el, fonteBreakdown);
  }
  if (!tolti) { el.classList.add('d-none'); el.innerHTML = ''; return; }
  el.classList.remove('d-none');
  el.textContent = mostraVersioniSmentite
    ? `${tolti} annunci non dichiarano questa versione: li stai vedendo. `
    : `Nascosti ${tolti} annunci che non dichiarano questa versione. `;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'avviso-versione-btn';
  b.textContent = mostraVersioniSmentite ? 'nascondili' : 'mostrali';
  b.addEventListener('click', () => { mostraVersioniSmentite = !mostraVersioniSmentite; renderResults(currentResults); });
  el.appendChild(b);
}

function renderResults(results) {
  // Nessuna ricerca attiva (es. renderResults chiamato da toggleSalva dopo un reload):
  // niente toolbar/risultati. La toolbar appare solo dopo una ricerca vera.
  if (!searchActive) {
    resultsToolbar.classList.add('d-none'); compareBar.classList.add('d-none');
    resultsSection.classList.add('d-none'); noResults.classList.add('d-none');
    return;
  }
  let filtered = results.slice();
  // La versione chiesta: chi la smentisce esce, e sotto il conteggio si scrive quanti sono.
  const smentiti = filtered.filter(r => r.versioneEsito === 'smentita').length;
  if (smentiti && !mostraVersioniSmentite) filtered = filtered.filter(r => r.versioneEsito !== 'smentita');
  rigaVersione(smentiti);
  // `ivaEsposta` e' a tre stati: true, false, e null quando la fonte non lo dice. Il filtro
  // tiene SOLO i true — un annuncio che non lo dichiara non e' un annuncio con IVA esposta,
  // e tenerlo dentro renderebbe il filtro una speranza invece di un filtro.
  if (soloIva) filtered = filtered.filter(r => r.ivaEsposta === true);
  if (prezzoSliderInstance) {
    const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
    filtered = filtered.filter(r => r.prezzo == null || (r.prezzo >= sMin && r.prezzo <= sMax));
  }
  const sorted = sortResults([...filtered]);
  ultimiVisti = sorted;              // quello che e' davvero a schermo: lo esportano CSV e PDF
  renderFacetChips();

  resultsToolbar.classList.remove('d-none');
  if (!document.querySelector('#priceMenuV summary')) renderPriceMenuV();   // rete di sicurezza: menu "Prezzo €" popolato quando la toolbar appare
  updateStats();
  targaBtnSync();   // annunci a schermo → il bottone della targa ha dove andare

  if (sorted.length === 0) {
    /**
     * "NESSUN RISULTATO" DEVE DIRE DI CHI E' LA COLPA.
     *
     * Qui compariva sempre "Nessun risultato trovato. Prova a modificare i filtri" — anche
     * quando gli annunci c'erano eccome ed era un filtro NOSTRO a nasconderli tutti.
     * Misurato: una ricerca Golf da 210 annunci in cui nessuno dichiara l'IVA esposta;
     * acceso il chip "Solo IVA esposta", lo schermo si svuota e il pannello dava la colpa
     * al mercato. E' la stessa forma di tutto il resto: una lista vuota per un filtro non
     * e' un piazzale vuoto, e chi guarda deve poter distinguere le due cose.
     */
    const nascosti = (results || []).length;
    const perFiltro = [];
    if (soloIva) perFiltro.push('il filtro «Solo IVA esposta»');
    if (prezzoSliderInstance) {
      const [sMin, sMax] = prezzoSliderInstance.get().map(Number);
      if (results.some(r => r.prezzo != null && (r.prezzo < sMin || r.prezzo > sMax))) perFiltro.push('il cursore dei prezzi');
    }
    const testo = noResults.querySelector('p');
    const nota = noResults.querySelector('p.small');
    if (nascosti > 0 && perFiltro.length && testo) {
      testo.textContent = `Nessuno di questi ${nascosti} annunci passa ${perFiltro.join(' e ')}.`;
      if (nota) nota.textContent = 'Gli annunci ci sono: a nasconderli è un filtro, non la ricerca. Toglilo per rivederli.';
    } else if (testo) {
      testo.textContent = 'Nessun risultato trovato.';
      if (nota) nota.textContent = 'Prova a modificare i filtri o selezionare una regione più ampia.';
    }
    noResults.classList.remove('d-none'); resultsSection.classList.add('d-none');
    return;
  }
  noResults.classList.add('d-none'); resultsSection.classList.remove('d-none');
  resultsCount.textContent = `${sorted.length} risultati`;

  // Lista o schede: cambia solo COME si disegna la stessa fetta di annunci. Il resto
  // (raggruppamento, ordinamento, pannello dell'annuncio, salvati, confronto) e' identico
  // — le schede sono righe con la foto grande, non un secondo elenco con regole sue.
  vistaChipsRender();
  const disegna = (items, best) => vista === 'schede'
    ? `<div class="card-grid">${items.map(r => cardHTML(r, best)).join('')}</div>`
    : gridHeadHTML() + `<div class="result-list">${items.map(r => rowHTML(r, best)).join('')}</div>`;
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
        <div class="group-body">${disegna(g.items, best)}</div>
      </div>`;
    }).join('');
  } else {
    resultsGrid.innerHTML = disegna(sorted, bestUrlSet(sorted));
  }
  renderAltriBtn();
}

// ─── Dettagli Moto.it: AL CLIC, non allo scorrimento ──────────────────────────
// La galleria piena e le spec di Moto.it stanno sulla pagina-dettaglio, non nella card della
// ricerca. Fino a ieri un IntersectionObserver le chiedeva mentre scorrevi (fino a 4 in
// parallelo, con 300px di margine): una sola ricerca Yamaha MT-07 — misurata dal vivo, 239
// annunci di cui 39 di Moto.it — faceva partire 39 richieste a Moto.it per annunci che non
// avevi ancora deciso di guardare. E meta' di quel lavoro non si vedeva nemmeno:
// `updateRowThumb` cercava `.result-row`, e la vista predefinita e' quella a SCHEDE
// (`.ann-card`). Decisione del proprietario: i dati mancanti si chiedono APRENDO l'annuncio.
// Chi lo fa e' il pannello di dettaglio (vedi `renderDetail`), che gia' chiamava questa
// funzione. In griglia non si perde niente di visibile: la cover ce l'hanno gia' tutte
// (misurato: 39 su 39), quello che arriva al clic e' la galleria piena e le spec.
async function enrichMotoRow(url) {
  const r = trovaResult(url);
  if (!r || r._enriched) return;   // già arricchita (cover-only NON conta: ha solo 1 foto)
  try {
    const j = await fetch(`/api/detail?url=${encodeURIComponent(url)}`).then(x => x.json());
    if (j.ok && j.detail) {
      // QUANTI CAMPI HA PORTATO DAVVERO. `{ok:true, detail:{...tutto null}}` e' la risposta
      // che il parser da' su una pagina che non ha detto niente: marcandola comunque
      // «arricchita», l'annuncio non veniva PIU' richiesto — nemmeno quando la fonte fosse
      // tornata a rispondere, e il TTL breve del dettaglio diventava inutile.
      let portati = 0;
      Object.keys(j.detail).forEach(k => {
        const v = j.detail[k]; if (v == null) return;
        if (k === 'immagini') { if (Array.isArray(v) && v.length) { r.immagini = v; portati++; } }  // galleria piena rimpiazza la cover
        else if (r[k] == null) { r[k] = v; portati++; }
      });
      if (portati) r._enriched = true;   // solo a merge riuscito: un fetch fallito resta ri-tentabile
    }
  } catch (_) {}
  updateRowThumb(url);
}
function updateRowThumb(url) {
  // LE DUE VISTE, non una. Qui c'era solo `.result-row`, e la vista predefinita e' quella a
  // SCHEDE (`.ann-card`): la foto appena scaricata da Moto.it non compariva mai, a meno di
  // essere passati alla lista densa. Stesso selettore doppio gia' usato da `refreshRowState`.
  const row = resultsGrid.querySelector(`.result-row[data-url="${CSS.escape(url)}"], .ann-card[data-url="${CSS.escape(url)}"]`);
  if (!row) return;
  const thumb = row.querySelector('.row-thumb'); if (!thumb) return;
  const r = trovaResult(url); const imgs = (r && Array.isArray(r.immagini)) ? r.immagini : [];
  if (imgs.length) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'row-thumb'; btn.title = 'Vedi foto';
    btn.innerHTML = `<img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt="">`;
    thumb.replaceWith(btn);
  }
}

// Set di URL col prezzo più basso (1 per gruppo/lista) → evidenziazione "best".
/**
 * IL PIU' ECONOMICO SI DICE SOLO SE SI STA CONFRONTANDO LA STESSA COSA.
 *
 * Su una ricerca allargata alla marca in lista ci sono anche annunci di altri modelli: il
 * piu' economico e' quasi sempre uno di quelli, perche' e' un veicolo piu' piccolo. La
 * stella verde li' non segnala un affare, segnala un confronto senza senso — e con la
 * pastiglia «altro modello» sulla stessa riga si contraddicono a vicenda. Con l'insieme
 * misto non si assegna a nessuno: nessuna bugia, e la colonna prezzo resta ordinabile.
 */
/**
 * FUORI BERSAGLIO = una delle DUE marcature, non una sola: quella degli scraper
 * (`dichiarazione`: un altro modello) e quella della verifica versioni (`versioneEsito`:
 * l'annuncio dichiara un'altra versione). Ogni cancello ne conosceva una — e la stella
 * verde finiva sulla Golf 1.6 base che l'app aveva appena marcato «non e' quella
 * versione». Una funzione sola; backend/saved.js ha la riga GEMELLA per gli avvisi, e il
 * test blinda che diano lo stesso verdetto sugli stessi ingressi.
 */
const fuoriBersaglio = r => !!r && ((r.dichiarazione && r.dichiarazione !== 'esatto' && r.dichiarazione !== 'senza-versione')
  || r.versioneEsito === 'smentita');
function bestUrlSet(items) {
  const misto = items.some(fuoriBersaglio);
  if (misto) return new Set();
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
/**
 * IL DEFAULT NON E' LO STESSO NELLE DUE VISTE, e non e' una svista.
 *
 * Nella LISTA ogni campo acceso e' una COLONNA in piu': larghezza vera sottratta al
 * titolo, per questo di partenza si accendono solo quelle su cui hai davvero filtrato.
 * Nella SCHEDA sono parole in una riga che va a capo da sola: non costano niente, e
 * partono tutte accese — com'era prima che il menu le comandasse.
 * Se le spunte le hai toccate tu, comandano loro: cambiare vista non te le rimette a posto.
 */
let colsToccate = false;
const colsDefault = params => (vista === 'schede' ? OPTIONAL_COLS.slice() : colsFromFilters(params));
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

/**
 * Cosa la fonte dichiara di questo annuncio. `esatto` non compare: e' il caso normale,
 * e marcare la normalita' rende invisibile l'eccezione.
 */
const DICHIARAZIONE = {
  'senza-versione': { et: 'versione n.d.', cl: 'med', tit: 'Il venditore non ha indicato la versione: il modello e\' quello giusto, l\'allestimento non e\' dichiarato.' },
  'senza-modello':  { et: 'da verificare', cl: 'med', tit: 'Il venditore non ha indicato il modello: riconosciuto dal titolo, non dal catalogo.' },
  'altro-modello':  { et: 'altro modello', cl: 'ko',  tit: 'Questa fonte non ha il modello cercato: la ricerca si e\' allargata alla marca e questo e\' un modello diverso.' },
  // Diverso da "versione n.d.": li' e' il venditore a non averla scritta, qui siamo noi
  // a non aver potuto controllare. Su Autoscout la versione e' testo libero, e certe
  // versioni ("320 2 porte") non lasciano un testo da confrontare — la carrozzeria li'
  // sta in un campo numerico. Dirlo "esatto" sarebbe una corrispondenza mai guardata.
  'versione-non-verificata': { et: 'versione non verificata', cl: 'med', tit: 'Il modello e\' quello giusto, ma su questa fonte la versione che hai scelto non si e\' potuta confrontare: potrebbe essere un altro allestimento.' },
};

/**
 * LA PASTIGLIA DELLA CORRISPONDENZA, in un posto solo.
 *
 * Stava dentro `rowHTML`, quindi la vista a schede — che dal commit 853ce47 e' quella
 * PREDEFINITA — mostrava i titoli nudi: un annuncio di un altro modello arrivava a schermo
 * senza nessun segnale, proprio dove si guarda. Ogni vista nuova ripartirebbe cieca allo
 * stesso modo finche' la regola vive dentro una funzione di disegno.
 *
 * La regola resta quella decisa a suo tempo: sulla riga (e sulla scheda) solo i casi in cui
 * il VEICOLO potrebbe non essere quello cercato — "altro modello", "da verificare" — perche'
 * sono rari e cambiano cosa stai guardando; la versione mancante capita di continuo e una
 * chip su una riga su due non segnala piu' niente, quindi si legge nel pannello dell'annuncio
 * (`detailSpecsHTML` → riga "Corrispondenza"). Nel PDF e nel CSV, dove c'e' una colonna
 * apposta e nessun ingombro, compaiono tutte.
 */
function dichBadgeHTML(item) {
  const dich = DICHIARAZIONE[item.dichiarazione];
  if (!dich || /versione/.test(item.dichiarazione || '')) return '';
  return `<span class="dich-badge dich-${dich.cl}" title="${escapeHtml(dich.tit)}">${escapeHtml(dich.et)}</span>`;
}

function rowHTML(item, bestSet) {
  const pr = vPricing(item.prezzo, passDi(item), item);
  // "su richiesta" non e' "n/d": il venditore il prezzo ce l'ha, ha scelto di non scriverlo.
  const prezzoStr = pr ? eurRound(pr.finale) : (item.prezzoSuRichiesta ? 'su richiesta' : 'n/d');
  const fonteLabel = FONTE_LABEL[item.fonte] || item.fonte;
  const fonteTag = { subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || '';
  const urlSafe = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
  const isSalvato = salvati.some(r => stessoAnnuncio(r, item));
  const inConfronto = confronto.some(r => stessoAnnuncio(r, item));
  const isBest = bestSet && bestSet.has(item.url);
  const imgs = Array.isArray(item.immagini) ? item.immagini : [];
  // Foto: chi le ha → thumbnail (click=lightbox). Moto.it ha la cover dalla card, la
  // galleria piena arriva aprendo l'annuncio. Il segnaposto NON fa piu' l'animazione di
  // caricamento: adesso che nessuno arricchisce allo scorrimento, quel luccichio prometteva
  // una foto che non stava arrivando. Subito/AS24 senza foto → stesso segnaposto fermo.
  const thumbHTML = imgs.length
    ? `<button type="button" class="row-thumb" title="Vedi foto"><img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`
    : '<div class="row-thumb noimg" aria-hidden="true"></div>';

  const conc = item.venditore && /conc/i.test(item.venditore);
  const vendBadge = item.venditore ? `<span class="vend-badge vend-${conc ? 'conc' : 'priv'}">${conc ? 'Conc.' : 'Privato'}</span>` : '';
  // Quanto e' sicuro che QUESTO annuncio sia il veicolo che hai chiesto. Il backend lo
  // sa per certo — Subito dai livelli che l'annuncio dichiara, Autoscout dal modello che
  // dichiara — e finora restava nel JSON. Un annuncio di un altro modello, o senza la
  // versione, deve dirlo sulla riga: il totale in cima non basta a fidarsi di una riga.
  // `esatto` non si marca: e' la normalita', e un pallino su ogni riga non e' un segnale.
  //
  // SULLA RIGA restano solo i casi in cui il VEICOLO potrebbe non essere quello cercato
  // ("altro modello", "da verificare"): sono rari e cambiano cosa stai guardando.
  // La versione mancante invece capita di continuo, e una chip su una riga su due e' un
  // ingombro che non segnala piu' niente: quella si legge aprendo l'annuncio, insieme a
  // tutti gli altri dati (`detailSpecsHTML` → riga "Corrispondenza").
  const dichBadge = dichBadgeHTML(item);
  const sub = [item.provincia ? escapeHtml(item.provincia) : '', vendBadge].filter(Boolean).join(' ');
  const ggV = giorniInVendita(item);
  const subM = [item.anno || null, item.km != null ? `${item.km.toLocaleString('it-IT')} km` : null, item.carburante || null, item.potenzaCv != null ? `${item.potenzaCv} CV` : null, ggV != null ? `in vendita da ${ggV} gg` : null, fonteLabel].filter(Boolean).join(' · ');

  const cell = key => {
    switch (key) {
      case 'foto':    return thumbHTML;
      case 'veicolo': return `<div class="row-main">
          <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}${dichBadge}</div>
          ${item.variante ? `<div class="row-variante">${escapeHtml(item.variante)}</div>` : ''}
          ${sub ? `<div class="row-sub">${sub}</div>` : ''}
          <div class="row-sub-m">${escapeHtml(subM)}${liqBadgeHTML(item)}</div>
        </div>`;
      case 'anno':   return `<div class="row-cell num muted">${item.anno || '—'}</div>`;
      case 'km':     return `<div class="row-cell num muted">${item.km != null ? item.km.toLocaleString('it-IT') : '—'}</div>`;
      case 'carb':   return `<div class="row-cell muted">${item.carburante ? escapeHtml(item.carburante) : '—'}</div>`;
      case 'cv':     return `<div class="row-cell num muted">${item.potenzaCv != null ? item.potenzaCv : '—'}</div>`;
      case 'prezzo': return `<div class="row-prezzo">${prezzoStr}<span class="row-extra">${priceRowExtraHTML(pr, null, notaIva(item))}</span></div>`;
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

function vistaChipsRender() {
  document.querySelectorAll('#vistaChips .facet-chip').forEach(b => b.classList.toggle('active', b.dataset.vista === vista));
  // In vista schede colonne non ce ne sono: le stesse quattro spunte comandano i campi
  // della riga di dati, e il bottone lo dice invece di promettere una cosa che non c'e'.
  const cols = document.querySelector('.tb-cols-group .tb-cols > summary');
  if (cols) cols.textContent = (vista === 'schede' ? 'Campi' : 'Colonne') + ' ▾';
}

/**
 * LA STESSA RIGA, con la foto grande. Non e' un secondo modo di mostrare gli annunci: e'
 * lo stesso, con altre proporzioni. Classi e attributi restano quelli della riga
 * (`data-url`, `.row-thumb`, `.row-titolo`, `.row-actions`, il `.row-detail` fratello),
 * cosi' lightbox, pannello annuncio, salvati e confronto funzionano senza sapere che
 * vista e' attiva — e non ci sono due strade da tenere allineate.
 */
function cardHTML(item, bestSet) {
  const pr = vPricing(item.prezzo, passDi(item), item);
  const urlSafe = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
  const imgs = Array.isArray(item.immagini) ? item.immagini : [];
  const foto = imgs.length     // vedi rowHTML: niente luccichio, la foto piena arriva al clic
    ? `<button type="button" class="row-thumb" title="Vedi foto"><img src="${escapeHtml(imgs[0].thumb)}" loading="lazy" referrerpolicy="no-referrer" alt=""></button>`
    : '<div class="row-thumb noimg" aria-hidden="true"></div>';
  const conc = item.venditore && /conc/i.test(item.venditore);
  const ggV = giorniInVendita(item);
  /**
   * LE STESSE SPUNTE DELLA LISTA, qui applicate alla riga di dati sotto il titolo.
   * In vista schede colonne non ce ne sono, ma i campi facoltativi sono gli stessi
   * quattro: il menu comanda le due viste allo stesso modo invece di restare acceso e
   * non fare niente. I giorni in vendita non sono fra i quattro e restano sempre.
   */
  // `visibleCols` e non `effVisibleCols()`: quest'ultima toglie carburante e CV sotto i
  // 1180px perche' le COLONNE della lista hanno larghezze fisse e sfonderebbero. Qui
  // colonne non ce ne sono — la riga di dati va a capo da sola — quindi la spunta vale
  // a qualunque larghezza, senno' sparirebbe senza che nessuno l'abbia tolta.
  const vis = visibleCols;
  const meta = [vis.includes('anno') ? (item.anno || null) : null,
    vis.includes('km') && item.km != null ? `${item.km.toLocaleString('it-IT')} km` : null,
    vis.includes('carb') ? (item.carburante || null) : null,
    vis.includes('cv') && item.potenzaCv != null ? `${item.potenzaCv} CV` : null,
    ggV != null ? `in vendita da ${ggV} gg` : null].filter(Boolean).join(' · ');
  const isSalvato = salvati.some(r => stessoAnnuncio(r, item));
  const inConfronto = confronto.some(r => stessoAnnuncio(r, item));
  return `<article class="ann-card${bestSet && bestSet.has(item.url) ? ' best' : ''}${inConfronto ? ' selected' : ''}" data-url="${urlSafe}">
      <div class="ann-foto">${foto}</div>
      <div class="ann-corpo">
        <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}${dichBadgeHTML(item)}</div>
        ${item.variante ? `<div class="ann-variante">${escapeHtml(item.variante)}</div>` : ''}
        <div class="ann-meta">${escapeHtml(meta) || '&nbsp;'}</div>
        <div class="ann-riga">
          <span class="tag ${{ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || ''}">${escapeHtml(FONTE_LABEL[item.fonte] || item.fonte)}</span>
          ${item.provincia ? `<span class="ann-dove">${escapeHtml(item.provincia)}</span>` : ''}
          ${item.venditore ? `<span class="vend-badge vend-${conc ? 'conc' : 'priv'}">${conc ? 'Conc.' : 'Privato'}</span>` : ''}
        </div>
        <div class="ann-piede">
          <span class="ann-prezzo">${pr ? eurRound(pr.finale) : (item.prezzoSuRichiesta ? 'su richiesta' : 'n/d')}</span>
          <div class="row-actions">
            <button class="row-act btn-info" title="Dettagli e foto">${icon('info')}</button>
            <button class="row-act btn-confronta${inConfronto ? ' attivo' : ''}" title="Aggiungi al confronto">${icon(inConfronto ? 'square-check' : 'square')}</button>
            <button class="row-act btn-salva${isSalvato ? ' attivo' : ''}" title="${isSalvato ? 'Rimuovi dai salvati' : 'Salva annuncio'}">${icon(isSalvato ? 'bookmark-filled' : 'bookmark')}</button>
          </div>
        </div>
      </div>
    </article>` +
    `<div class="row-detail d-none" data-url="${urlSafe}" data-detail="1"></div>`;
}

/**
 * RIDISEGNA SENZA PORTARE VIA QUELLO CHE STAI LEGGENDO.
 *
 * `renderResults` rifa' l'innerHTML della griglia: con lui spariscono i pannelli degli
 * annunci aperti e, dentro, la scheda tecnica — motorizzazione scelta, ADD ON aperto,
 * conto del passaggio gia' fatto. Succedeva a ogni ridimensionamento della finestra e a
 * ogni spunta nel menu dei campi. Qui si segna cosa era aperto, si ridisegna e si riapre:
 * `toggleDetail` passa da `renderDetailInto`, che riaggancia da sola la scheda
 * all'annuncio che la ospita.
 */
function ridisegnaTenendoAperti() {
  const aperti = [...resultsGrid.querySelectorAll('.row-detail:not(.d-none)')].map(d => d.dataset.url);
  const scorrimento = window.scrollY;
  renderResults(currentResults);
  for (const u of aperti) {
    const riga = resultsGrid.querySelector(`.result-row[data-url="${CSS.escape(u)}"], .ann-card[data-url="${CSS.escape(u)}"]`);
    if (riga) toggleDetail(riga);
  }
  window.scrollTo({ top: scorrimento });
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
  if (r.prezzo != null) { const _pr = vPricing(r.prezzo, passDi(r), r); base.push(['Prezzo', _pr ? eurRound(_pr.finale) : `€ ${r.prezzo.toLocaleString('it-IT')}`]); }
  // Il MESE quando la fonte lo dice (Subito lo dice sempre): fra gennaio e dicembre
  // dello stesso anno ballano dodici mesi di eta'.
  if (r.anno != null)   base.push(['Immatricolazione', r.mese ? `${String(r.mese).padStart(2, '0')}/${r.anno}` : String(r.anno)]);
  if (r.km != null)     base.push(['Km', `${r.km.toLocaleString('it-IT')} km`]);
  if (r.provincia)      base.push(['Provincia', r.provincia]);
  const extra = Object.keys(SPEC_LABELS).map(k => { const v = specVal(k, r[k]); return v ? [SPEC_LABELS[k], v] : null; }).filter(Boolean);
  // Quanto la fonte dichiara su QUESTO annuncio: se la versione manca, o se il modello
  // e' stato riconosciuto dal titolo invece che dal catalogo, si legge qui — non piu' con
  // una chip in mezzo alla riga dei risultati.
  const dich = DICHIARAZIONE[r.dichiarazione];
  const dett = dich ? [['Corrispondenza', dich.et]] : [];
  const all = base.concat(extra, versioneDedottaRiga(r), dett, campiNativi(r));
  if (!all.length) return '<span class="spec-empty">Nessun dettaglio aggiuntivo</span>';
  return coppieHTML(all);
}

/**
 * LA VERSIONE DEDOTTA, e si vede che e' dedotta.
 *
 * Il venditore non ha scelto la versione dal menu, ma l'ha scritta nell'annuncio: il
 * backend la riconosce contro il catalogo di Subito (backend/scrapers/versione-dedotta.js).
 * Sta accanto agli altri dati dell'annuncio perche' e' un dato dell'annuncio, non
 * un'integrazione esterna — ma con l'etichetta che dice da dove viene.
 *
 * Due forme, e non valgono uguale: il nome intero quando era scritto per intero, il solo
 * allestimento quando restano piu' versioni compatibili. "e' una Lounge" e' meno di un
 * nome, ma e' molto piu' di "versione n.d.".
 */
function versioneDedottaRiga(r) {
  const d = r && r.versioneDedotta;
  if (!d || r.variante) return [];
  const nota = 'Non l\'ha dichiarata il venditore: e\' riconosciuta nel testo dell\'annuncio contro il catalogo Subito. ' + (d.perche || '');
  if (d.esito === 'esatta') return [['Versione (dedotta)', d.versione, nota]];
  // "320d" e' la MOTORIZZAZIONE, e il catalogo lo dice da solo (e' la parola con cui apre il
  // nome della versione). Il dato resta, l'etichetta smette di chiamarlo allestimento.
  return d.cosa === 'motorizzazione'
    ? [['Motorizzazione (dedotta)', d.allestimento, nota]]
    : [['Allestimento (dedotto)', d.allestimento, nota]];
}

// ─── Quello che le fonti dicevano e non leggevamo ────────────────────────────
/**
 * Le tre fonti mandano molto piu' di quanto la scheda mostrasse. Niente di tutto
 * questo costa una richiesta in piu': Subito e Autoscout lo dicono nella risposta di
 * ricerca, Moto.it nella pagina-annuncio che il pannello scarica gia'.
 *
 * DOVE VANNO, e non e' un dettaglio estetico: questi sono DATI DELL'ANNUNCIO, come la
 * potenza o il venditore, quindi stanno in chiaro nella scheda insieme agli altri. I
 * blocchi da aprire restano solo per le INTEGRAZIONI ESTERNE — il passaggio di proprieta'
 * (tariffe ACI) e cerchi e gomme (Wheel-Size, EPREL) — che costano una richiesta e
 * riguardano dati che l'annuncio non contiene.
 *
 * REGOLA che vale per tutti: un campo assente NON diventa una riga. "Non dichiarato" e
 * "No" sono due cose diverse — un annuncio che non parla di incidenti non e' un annuncio
 * senza incidenti.
 */
// Il terzo elemento e' un titolo facoltativo: serve ai valori che vanno spiegati (una
// versione dedotta non e' una versione dichiarata, e chi legge deve poterlo sapere).
const coppieHTML = coppie => coppie
  .map(([k, v, tit]) => `<div class="det-spec"${tit ? ` title="${escapeHtml(String(tit))}"` : ''}><span class="det-k">${escapeHtml(String(k))}</span><span class="det-v">${escapeHtml(String(v))}</span></div>`)
  .join('');

const siNo = v => (v == null ? null : (v ? 'Sì' : 'No'));
// Raccoglie [etichetta, valore] scartando i valori assenti. `null` sparisce, `false` no.
function righe(...coppie) {
  return coppie.filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]);
}

// Le fasce dei contatti sono quattro, non tre: "VeryMany" e' comparso solo misurando
// 200 annunci (2 volte). Una fascia non tradotta si stamperebbe in inglese.
const CONTATTI_IT = { Zero: 'nessuna', Some: 'qualcuna', Many: 'molte', VeryMany: 'moltissime' };

/**
 * Tutti i campi nativi in una lista sola, nell'ordine in cui servono: prima i soldi,
 * poi lo stato del mezzo, poi il mercato, poi chi vende.
 *
 * DUE regole che non sono cosmetiche:
 *  - l'IVA si mostra solo quando dice qualcosa. Misurato su Subito: il campo compare
 *    anche su 13 annunci PRIVATI su 37, sempre a "No", e su un privato "IVA esposta: No"
 *    non e' un'informazione (un privato non puo' esporla). Su un concessionario invece
 *    il "No" e' informazione vera: vuol dire regime del margine.
 *  - il "non fumatore" si mostra solo se sì: misurati 87 "false" su 100, e quel "No" non
 *    vuol dire fumatore — vuol dire che il venditore non ha spuntato la casella.
 */
function campiNativi(r) {
  const ivaParla = r.ivaEsposta === true || (r.ivaEsposta === false && r.venditore === 'concessionario');
  const val = r.valutazione;
  const scost = (val && r.prezzo != null) ? r.prezzo - val.mediana : null;
  return righe(
    // Fisco e garanzia — per un operatore e' il prezzo VERO, non il cartellino.
    ['IVA esposta', ivaParla ? siNo(r.ivaEsposta) : null],
    ['Imponibile', r.prezzoNetto != null ? `€ ${r.prezzoNetto.toLocaleString('it-IT')}` : null],
    ['Aliquota IVA', r.ivaAliquota != null ? `${r.ivaAliquota}%` : null],
    ['Garanzia', r.garanziaMesi != null ? (r.garanziaMesi > 0 ? `${r.garanziaMesi} mesi` : 'sì, durata non dichiarata') : (r.garanzia || null)],
    ['Trattabile', siNo(r.trattabile)],
    ['Passaggio', r.tipoOfferta || null],          // Moto.it: dice CHI lo paga
    ['Spedizione', siNo(r.spedizione)],
    // Stato e storia
    ['Senza incidenti', siNo(r.senzaIncidenti)],
    ['Incidentata', siNo(r.incidentata)],
    ['Marciante', siNo(r.marciante)],
    ['Revisione fino a', r.revisioneScadenza],
    ['Tagliandi', r.tagliandi],
    ['Ultimo tagliando', r.ultimoTagliando],
    ['Cinghia distribuzione', r.cinghiaData],
    ['Non fumatore', r.nonFumatore === true ? 'Sì' : null],
    ['Depotenziata', siNo(r.depotenziata)],
    ['Solo uso pista', siNo(r.usoPista)],
    ['ABS', siNo(r.abs)],
    ['Mercato d\'origine', r.mercatoOrigine],
    ['Prodotta', r.dataProduzione],
    // Mercato — sono numeri di AUTOSCOUT e l'etichetta lo dice. Il voto 1-6 che allegano
    // NON si mostra: e' una scala di cui non conosciamo la definizione, e riportarla come
    // se la capissimo sarebbe spacciare un'opinione per dato. Lo scostamento invece e' una
    // sottrazione nostra, non un giudizio.
    ['Mediana Autoscout', val ? `€ ${Number(val.mediana).toLocaleString('it-IT')}` : null],
    ['Scostamento', scost != null ? `${scost > 0 ? '+' : ''}${scost.toLocaleString('it-IT')} €` : null],
    ['Richieste di contatto', r.contatti ? (CONTATTI_IT[r.contatti] || String(r.contatti)) : null],
    // DA QUANTO E' FERMO QUESTO MEZZO. E' il numero con cui si tratta, e finora finiva solo
    // dentro una mediana del piazzale. Sta qui, con gli altri dati di mercato.
    ['In vendita da', (() => {
      const g = giorniInVendita(r);
      return g == null ? null : `${g} giorni · dal ${new Date(r.posted_at).toLocaleDateString('it-IT')}`;
    })()],
    // Chi vende. L'etichetta e' "Nome venditore" e non "Venditore" perche' quella e'
    // gia' presa dal TIPO (privato / concessionario): due righe con lo stesso nome e
    // due contenuti diversi si leggono come un errore.
    ['Nome venditore', r.venditoreNome],
    ['Rif. magazzino', r.refVenditore],
    ['Annunci online', r.venditoreAnnunciOnline],
    ['Annunci pubblicati', r.venditoreAnnunciPubblicati],
    ['Su Moto.it dal', r.venditoreDal],
  );
}

/**
 * Optional: la lista che il venditore ha spuntato, raggruppata come la manda Autoscout.
 *
 * CHIUSO di default, come il testo dell'annuncio: e' un dato dell'annuncio, ma su una
 * berlina tedesca ben accessoriata sono ottanta voci, e aperte spingono in fondo tutto
 * quello che viene dopo. Chiuso si vede che c'e' e quanti sono; aperto si leggono.
 */
function optionalHTML(r) {
  const list = Array.isArray(r.optional) ? r.optional.filter(o => o && o.nome) : [];
  if (!list.length) return '';
  const perCat = new Map();
  for (const o of list) {
    const c = o.categoria || 'Altro';
    if (!perCat.has(c)) perCat.set(c, []);
    perCat.get(c).push(o.nome);
  }
  const corpo = [...perCat.entries()].map(([cat, voci]) =>
    `<div class="opt-cat"><span class="opt-cat-t">${escapeHtml(cat)}</span>`
    + `<div class="opt-voci">${voci.map(v => `<span class="opt-v">${escapeHtml(v)}</span>`).join('')}</div></div>`).join('');
  // Stessa forma richiudibile del testo annuncio (miniHTML): la chiave e' per-annuncio,
  // cosi' aprirne uno non apre quello di tutti gli altri.
  return miniHTML('optional:' + r.url, 'Optional', list.length + (list.length === 1 ? ' voce' : ' voci'), corpo);
}

// Il testo dell'annuncio: quello che il venditore ha voluto scrivere. Alto al massimo
// una ventina di righe, poi scorre da solo — non spinge in basso il resto della scheda.
/**
 * Il testo dell'annuncio, richiudibile. E' un dato nativo, quindi sta qui e non fra le
 * integrazioni — ma sono in media mille caratteri di prosa, e aperti spingono in fondo
 * tutto il resto. Chiuso si vede che c'e'; aperto si legge.
 */
function testoHTML(r) {
  const d = (r.descrizione || '').trim();
  if (!d) return '';
  return miniHTML('testo:' + r.url, 'Testo dell\'annuncio', d.length + ' caratteri',
    `<div class="det-testo">${escapeHtml(d)}</div>`);
}

/**
 * CHI VENDE, e la porta per andarlo a guardare.
 *
 * Il link alla vetrina quando la fonte lo dice (Moto.it), e il bottone che mette quel
 * venditore nella lista di Competitor. L'id che serve sta GIA' nell'annuncio ed e' lo stesso
 * spazio di id che Competitor usa come porta d'ingresso — verificato sulle due fonti:
 *   Subito    venditoreId 105412305 → uid=105412305        → 100 annunci, un solo venditore
 *   Autoscout venditoreId 7008      → as24Customer=7008     → 44 annunci, un solo venditore
 * Quindi non serve incollare nessun link: si aggiunge e basta.
 *
 * SOLO CONCESSIONARI. Sui privati Subito scrive il nome della persona, e comunque un privato
 * non ha un parco da guardare: il bottone non comparirebbe a vuoto, non comparirebbe affatto.
 * Il parco NON si scarica qui: si aggiunge alla lista, e quando scaricarlo lo decide chi guarda.
 */
function competitorDaAnnuncio(r) {
  if (!r || r.venditore !== 'concessionario') return null;
  if (r.fonte === 'moto') return r.vetrinaUrl ? { url: r.vetrinaUrl } : null;
  if ((r.fonte === 'subito' || r.fonte === 'autoscout') && r.venditoreId) {
    return { fonte: r.fonte, id: String(r.venditoreId), nome: r.venditoreNome || null };
  }
  return null;
}

/** Mette il venditore di questo annuncio nella lista di Competitor. Non scarica niente. */
async function aggiungiVenditoreAlCompetitor(r, btn) {
  const cp = competitorDaAnnuncio(r);
  if (!cp) return;
  const testo = btn.textContent;
  btn.disabled = true; btn.textContent = 'Aggiungo…';
  try {
    // Moto.it ha il link della vetrina: passa dalla porta di sempre, che legge anche
    // l'anagrafica. Subito e Autoscout hanno l'id e basta: la loro anagrafica sta sulla
    // pagina della vetrina, e si legge quando il parco lo si scarica davvero.
    const via = cp.url ? '/api/competitor' : '/api/competitor/da-annuncio';
    const res = await fetch(via, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cp),
    });
    const d = await res.json().catch(() => ({}));
    // 409 = c'era gia'. Non e' un errore: e' una risposta, e va detta come tale. E la voce
    // che il server rimanda si mette in elenco: cosi' le altre righe dello stesso venditore
    // smettono subito di offrire "Aggiungi".
    if (res.status === 409) {
      toast(d.error || 'Era gia\' nell\'elenco'); btn.textContent = 'Gia\' in Competitor';
      if (d.voce) cpVoci = (cpVoci || []).concat([d.voce]);
      return;
    }
    if (!res.ok || !d.ok) { showError(d.error || 'Non riuscito'); btn.disabled = false; btn.textContent = testo; return; }
    toast(`${(d.voce && d.voce.nome) || 'Venditore'} aggiunto a Competitor — il parco lo scarichi da lì`);
    btn.textContent = 'In Competitor ✓';
    // L'elenco in memoria si AGGIORNA invece di azzerarsi: azzerandolo, ogni altra riga
    // dello stesso venditore tornava a offrire "Aggiungi" fino alla riapertura della sezione.
    if (d.voce) cpVoci = (cpVoci || []).concat([d.voce]);
  } catch (_) {
    showError('Impossibile contattare il server'); btn.disabled = false; btn.textContent = testo;
  }
}

function vetrinaHTML(r) {
  const vet = r.vetrinaUrl
    ? `<a class="det-open" href="${escapeHtml(r.vetrinaUrl)}" target="_blank" rel="noopener noreferrer">Vetrina venditore ↗</a>`
    : '';
  const cp = competitorDaAnnuncio(r);
  if (!cp) return vet;
  const chi = r.venditoreNome ? ` (${escapeHtml(r.venditoreNome)})` : '';
  /**
   * CHI E' GIA' IN ELENCO NON SI PUO' AGGIUNGERE. Guardando gli annunci di un concorrente
   * dalla sezione Competitor, ogni riga offriva "Aggiungi a Competitor" per il
   * concorrente che si stava gia' guardando: il server rispondeva 409 e l'app un avviso,
   * cioe' un giro completo per sapere una cosa che sapeva gia'. `cpVoci` e' l'elenco vero,
   * ed e' caricato ogni volta che la sezione e' stata aperta almeno una volta; se non lo
   * e' (null) il bottone resta com'era — meglio offrirlo che nasconderlo per un dubbio.
   */
  const gia = Array.isArray(cpVoci) && cpVoci.some(v => v.fonte === cp.fonte && String(v.id) === String(cp.id));
  if (gia) return vet + `<span class="det-open det-open-gia" title="Questo venditore e' gia' nella sezione Competitor">Già in Competitor${chi}</span>`;
  return vet + `<button type="button" class="det-open btn-competitor">Aggiungi a Competitor${chi}</button>`;
}
// ── Passaggio di proprieta' del singolo annuncio ─────────────────────────────
// Potenza e localita' sono gia' scritte nell'annuncio: il costo per metterlo a nome proprio
// si puo' calcolare li', senza andare a cercare provincia e kW da un'altra parte. Non parte
// da solo: e' una richiesta al server, e la fa solo chi la vuole.
// Risultato in cache sull'oggetto annuncio (r._pass): riaprire la riga non ricalcola.
//
// DUE cose che sembrano ovvie e non lo sono:
//  - il TIPO di veicolo va preso dalla RICERCA, non dalla fonte dell'annuncio: cercando moto,
//    Subito e AutoScout rispondono con moto, e trattarle come auto darebbe la tariffa
//    autoveicoli su un mezzo per cui l'IPT non e' nemmeno calcolabile;
//  - l'IPT si paga sulla provincia di RESIDENZA di chi intesta (fonte ACI), non su quella
//    dove sta il venditore. Se l'operatore ha scelto la sua provincia si usa quella; la
//    localita' dell'annuncio e' un ripiego, e si dice sempre quale delle due si sta usando.
// IL TIPO LO DICE L'ANNUNCIO. Prendendolo dall'ultima ricerca, nel parco di un
// concessionario — dove una ricerca non c'e' mai stata — una moto riceveva la tariffa
// autoveicoli e usciva un importo credibile per un conto che sulle moto non si fa.
function passTipo(r) {
  const t = (r && r.tipo) || (lastSearchParams || {}).tipo;
  return (t === 'moto' || (r && r.fonte === 'moto')) ? 'moto' : 'auto';
}
/**
 * LA TUA PROVINCIA PER IL PASSAGGIO, che non e' quella del carburante.
 *
 * Erano la stessa preferenza. Cambiare la tendina dentro "Costo carburante" per confrontare
 * il prezzo al litro spostava anche l'IPT: sono 107 province con quattro aliquote
 * (0/20/25/30%), e su un'auto da 90 kW il passaggio va da 343,07 € ad Aosta a 437,89 € a
 * Viterbo — 94,82 € mossi da una tendina che parlava di benzina. Due domande diverse, due
 * preferenze. La prima volta si eredita quella del carburante, cosi' chi l'aveva gia'
 * impostata non si ritrova il bottone "usa la tua provincia" sparito; da li' in poi vivono
 * separate.
 */
const passProvinciaMia = () => {
  try {
    const p = localStorage.getItem('amrPassProvincia');
    if (p != null) return p;
    const eredita = localStorage.getItem('amrCarbProvincia') || '';
    localStorage.setItem('amrPassProvincia', eredita);
    return eredita;
  } catch (_) { return ''; }
};
function passProvincia(r) {
  const mia = passProvinciaMia();
  if (r._passProvAnnuncio) return { testo: r.provincia || '', mia: false };
  return mia ? { testo: mia, mia: true } : { testo: r.provincia || '', mia: false };
}

async function calcolaPassaggio(r, panel) {
  r._pass = { stato: 'carico' };
  // Il blocco vive dentro ADD ON, cioe' dentro la SCHEDA: ridisegnare l'intero pannello
  // dell'annuncio la butterebbe via e la rimonterebbe a ogni ricalcolo. Si ridisegna solo
  // la scheda; se la scheda non e' di questo annuncio, vale il pannello come prima.
  const disegna = () => {
    if (vehHostUrl === r.url) renderVehBody();
    else if (panel && panel._render) panel._render();
  };
  disegna();
  const pv = passProvincia(r);
  const q = new URLSearchParams({ provincia: pv.testo, tipo: passTipo(r) });
  // marca e modello servono al server per cercare i kW DICHIARATI di listino invece di
  // stimarli dai CV: sulla soglia dei 53 kW la differenza e' una categoria di tariffa.
  // Marca e modello di QUESTO annuncio; la ricerca resta solo come rete.
  const sp = lastSearchParams || {};
  const pMarca = r.marca || sp.marca;
  const pModello = r.modello || r.modelloDichiarato || sp.modello;
  if (pMarca) q.set('marca', pMarca);
  if (pModello) q.set('modello', pModello);
  if (r._passStorico) q.set('storico', '1');
  if (!pv.mia) { const z = r.zip || r.cap; if (z) q.set('cap', String(z)); }   // il CAP e' dell'annuncio
  if (r.potenzaCv > 0) q.set('cv', String(r.potenzaCv));
  // L'anno serve al server per NON chiedere i kW al listino del nuovo quando il veicolo e'
  // troppo vecchio perche' quel listino lo abbia ancora (vedi backend/scrapers/motornet.js).
  if (r.anno) q.set('anno', String(r.anno));
  // A Torino un atto con IVA esposta paga il 20% invece del 30%: per un operatore che compra
  // con fattura e' la normalita', quindi la scelta esiste (e vale solo la' — vedi ipt.js).
  if (r._passIva) q.set('ivaEsposta', '1');
  try {
    const d = await fetch('/api/passaggio?' + q.toString()).then(x => x.json());
    r._pass = { stato: 'ok', d, mia: pv.mia };
  } catch (_) { r._pass = { stato: 'ko' }; }
  if (vehHostUrl === r.url) renderVehBody();
  else if (panel && panel.isConnected && panel._render) panel._render();
  aggiornaNoteRiga(r);
}

// Le sotto-note di prezzo di UNA riga, riscritte in loco: il margine netto di quell'annuncio
// cambia appena si conosce il costo della sua pratica. Un renderResults() qui chiuderebbe il
// pannello da cui e' stato chiesto il calcolo.
function aggiornaNoteRiga(r) {
  if (!r || !r.url) return;
  const pr = vPricing(r.prezzo, passDi(r), r);
  resultsGrid.querySelectorAll(`[data-url="${CSS.escape(r.url)}"]`).forEach(el => {
    if (el.dataset.detail) return;
    el.querySelectorAll('.row-extra').forEach(n => { n.innerHTML = priceRowExtraHTML(pr, null, notaIva(r)); });
  });
}

// ─── Sezioni richiudibili dentro le schede ───────────────────────────────────
// Passaggio di proprieta', cerchi e gomme, costo carburante, passaggi del modello: quattro
// blocchi che stavano sempre aperti e riempivano la scheda anche quando non li guardavi.
//
// Sono la stessa cosa, quindi e' una funzione sola: intestazione cliccabile, il DATO che
// conta scritto li' accanto (cosi' non serve aprire per vederlo) e il dettaglio sotto.
//
// Chiuse di default. Quelle che costano rete non partono all'apertura della scheda: e'
// l'apertura della sezione a farle partire — un click invece di due, e nessuna richiesta
// per chi non la apre.
//
// `toggle` NON risale il DOM: i due ascoltatori sono in cattura, altrimenti non arrivano.
const miniAperte = new Set();

function miniHTML(chiave, titolo, meta, corpo, opts = {}) {
  if (!corpo && !opts.carica) return '';
  const aperta = miniAperte.has(chiave);
  return `<details class="mini"${aperta ? ' open' : ''} data-mini="${escapeHtml(chiave)}"${opts.carica ? ` data-carica="${escapeHtml(opts.carica)}"` : ''}>`
    + `<summary class="mini-h"><span class="mini-t">${escapeHtml(titolo)}</span>`
    + (meta ? `<span class="mini-meta">${meta}</span>` : '')
    + '</summary>'
    + `<div class="mini-b">${corpo || ''}</div></details>`;
}

/** tiene memoria di cosa e' aperto, e fa partire il carico alla prima apertura */
function miniToggle(e, ctx) {
  const d = e.target;
  if (!d || !d.classList || !d.classList.contains('mini')) return;
  const k = d.dataset.mini;
  if (d.open) miniAperte.add(k); else miniAperte.delete(k);
  if (!d.open || !d.dataset.carica) return;
  ctx(d.dataset.carica, d);
}

// Il guscio del blocco "Passaggio di proprieta" stava qui: ora il corpo (`passCorpoHTML`)
// e' dentro ADD ON, unito alla statistica del modello — vedi `vehPassaggiHTML`.
// Il bottone dentro compare solo se i dati per calcolare ci sono davvero: senza potenza o
// senza localita' il conto non si fa, e lo si dice invece di mostrare un pulsante che
// fallisce. Le due spunte (storico, IVA) restano raggiungibili SEMPRE, anche quando il
// calcolo non riesce: sono proprio loro a poterlo far riuscire.

function passCorpoHTML(r) {
  const haPot = r.potenzaCv > 0;
  const st = r._pass;
  const opz = passOpzioniHTML(r);
  if (!st) {
    if (!r.provincia && !passProvinciaMia()) return '';
    if (!haPot && !r._passStorico) {
      return `<div class="det-pass-no">Manca la potenza in questo annuncio: il conto non si fa.</div>${opz}`;
    }
    return `<div class="det-pass-no">Calcolo…</div>${opz}`;
  }
  if (st.stato === 'carico') return '<div class="det-pass-no">Calcolo…</div>';
  if (st.stato === 'ko') {
    return `<div class="det-pass-no">Calcolo non riuscito (rete).</div>`
      + `<button type="button" class="det-act btn-passaggio"><span class="ra-txt">Riprova</span></button>${opz}`;
  }
  const d = st.d || {};
  if (!d.ok) return `<div class="det-pass-no">Non calcolabile: ${escapeHtml(d.motivo || 'dati insufficienti')}.</div>`
    + `${passAvvisiHTML(d)}${opz}`;
  const eur = n => Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const loc = d.localita || {};
  // Da quale provincia viene l'importo, e come si passa all'altra: la differenza tra le due
  // sono euro veri (dallo 0% di Bolzano al 30% di quasi tutte le altre).
  const altra = st.mia ? (r.provincia || '') : passProvinciaMia();
  const scambio = altra
    ? ` <button type="button" class="det-pass-alt" data-alt="${st.mia ? 'annuncio' : 'mia'}">usa ${st.mia ? `la provincia dell'annuncio (${escapeHtml(altra)})` : `la tua provincia (${escapeHtml(altra)})`}</button>`
    : '';
  /**
   * SOLO I NUMERI. Qui c'erano cinque righe di prosa attorno a tre cifre: da dove viene la
   * potenza, chi paga l'IPT e su quale residenza, la fonte, cosa non e' incluso. Roba giusta
   * ma spiegata ogni volta a chi il conto lo conosce meglio di noi. Restano l'importo, i due
   * addendi, la provincia con il bottone per cambiarla, e gli avvisi — che non sono prosa:
   * sono condizioni che cambiano quanto paghi.
   */
  return `<div class="det-pass-box">
    <div class="pp-tot"><b>${eur(d.totaleNoto)} €</b><span class="pp-tot-lab">per metterlo a nome tuo</span></div>
    <div class="pp-voci">
      <span class="pp-voce"><em>IPT</em>${eur(d.ipt)} €</span>
      <span class="pp-piu">+</span>
      <span class="pp-voce"><em>emolumenti</em>${eur(d.emolumenti)} €</span>
    </div>
    <div class="det-pass-det">${passProvSelHTML(loc.sigla || '', st.mia)}${scambio}</div>
    ${opz}
    ${passAvvisiHTML(d)}
  </div>`;
}

/**
 * La sigla della provincia da cui viene l'importo: scegliibile quando e' LA TUA, ferma
 * quando e' quella dell'annuncio (quella la decide il venditore, non tu — per cambiarla c'e'
 * il bottone accanto). Prima l'unico modo di dire quale fosse "la tua" era la tendina del
 * carburante, che pero' parla d'altro: separate le due preferenze, serviva un posto per
 * dirlo, ed e' questo — accanto al numero che decide.
 *
 * L'elenco e' quello dell'indice carburanti (le stesse 107 province della tabella IPT): e'
 * gia' scaricato o si scarica da se'. Finche' non c'e', resta la sigla scritta.
 */
function passProvSelHTML(sigla, mia) {
  const prov = (carbIdx && carbIdx.province) ? Object.keys(carbIdx.province).sort() : [];
  if (!mia || !prov.length) {
    if (mia && carbStato === 'mai') loadCarburanti();   // serve l'elenco: si chiede una volta sola
    return `<span class="pp-prov">${escapeHtml(sigla)}</span>`;
  }
  return `<select class="pp-prov pp-prov-sel" aria-label="la tua provincia per il costo del passaggio">`
    + prov.map(x => `<option value="${escapeHtml(x)}"${x === sigla ? ' selected' : ''}>${escapeHtml(x)}</option>`).join('')
    + '</select>';
}

// TUTTI gli avvisi, non solo il primo: sono condizioni verificate su fonte (uso professionale,
// passaggi consecutivi, decadenza dei ventennali) e ognuna puo' cambiare l'importo dovuto.
function passAvvisiHTML(d) {
  const a = (d && d.avvisi) || [];
  if (!a.length) return '';
  return `<div class="det-pass-avviso">${a.map(x => escapeHtml(x)).join('<br>')}</div>`;
}

function passOpzioniHTML(r) {
  const iva = passIvaHTML(r);
  const st = passStoricoHTML(r);
  return (iva || st) ? `<div class="det-pass-opz">${st}${iva}</div>` : '';
}

// La scelta IVA cambia l'importo SOLO a Torino (unica provincia con due aliquote): si mostra
// dove serve, non su tutte le altre 106 dove non cambierebbe nulla.
function passIvaHTML(r) {
  const sig = (r._pass && r._pass.d && r._pass.d.localita && r._pass.d.localita.sigla) || null;
  if (sig !== 'TO' && !r._passIva) return '';
  return `<label class="det-pass-opzv"><input type="checkbox" class="pass-iva-chk"${r._passIva ? ' checked' : ''}> atto con IVA esposta (fattura)</label>`;
}

// La riduzione per veicoli storici (51,65 € auto / 25,82 € moto) vale oltre i 30 anni, e
// l'anno di questo annuncio lo sappiamo: la spunta compare solo dove ha senso. Resta manuale
// perche' la riduzione NON spetta ai veicoli usati nell'attivita' d'impresa: lo sa l'operatore,
// non il programma. Le moto non storiche non sono calcolabili affatto, quindi li' la spunta e'
// l'unica via a un importo: si mostra anche senza anno.
function passStoricoHTML(r) {
  const eta = r.anno > 1900 ? new Date().getFullYear() - r.anno : null;
  // Per le moto la spunta e' l'UNICA strada a un importo (le non storiche non sono
  // calcolabili), quindi si mostra anche senza anno.
  const plausibile = (eta != null && eta >= 30) || (passTipo(r) === 'moto');
  if (!plausibile && !r._passStorico) return '';
  return `<label class="det-pass-opzv"><input type="checkbox" class="pass-storico-chk"${r._passStorico ? ' checked' : ''}>`
    + ` veicolo storico${eta != null ? ` (${eta} anni)` : ' (oltre 30 anni)'}, non usato nell'attivita'</label>`;
}

// ─── Cerchi, gomme e pneumatici, dentro l'annuncio ───────────────────────────
// Wheel-Size vuole marca, modello e anno di UN'AUTO: sono esattamente i dati che un
// annuncio ha per forza. Chiederli di nuovo in un'altra sezione era far ridigitare
// all'utente cio' che l'app gia' sa.
//
// NON PARTE DA SOLA, come il passaggio di proprieta': e' una richiesta in rete, e la fa
// solo chi la vuole. Stessa cosa per l'etichetta europea del pneumatico: la misura
// diventa un bottone, e la ricerca parte se la si preme.
//
// La misura non ha bisogno di essere ripulita: Wheel-Size la scrive "175/65R15" ed EPREL
// accetta quella stringa cosi' com'e' — verificato, 100 pneumatici in risposta.
//
// Il risultato resta sull'oggetto annuncio (r._gomme, r._pneu): riaprire la riga non
// ricarica niente.

/**
 * MARCA E MODELLO DI QUESTO ANNUNCIO, una regola sola per chiunque debba chiedere qualcosa
 * a una fonte esterna a nome di un annuncio (gomme, liquidita', e chi verra').
 *
 * La chiave la dice l'ANNUNCIO, non l'ultima ricerca. Nel parco di un concessionario gli
 * annunci non vengono da una ricerca, e `lastSearchParams` restava quello di prima: aprendo
 * una Fiat Panda dopo aver cercato una BMW 320d, sotto la Panda comparivano cerchi, gomme e
 * pressioni della BMW, attribuiti a lei. Stessa forma gia' usata da passTipo e loadVehScheda.
 */
function coppiaAnnuncio(r) {
  const p = lastSearchParams || {};
  // La MARCA di catalogo vince quando c'e' (doSearch rifiuta una ricerca senza marca a
  // catalogo, quindi in griglia e' sempre valorizzata e canonica); nel parco si spegne e vale
  // quella dell'annuncio. Facendo vincere sempre l'annuncio si peggiorava la griglia normale,
  // dove `r.marca` e' il nome grezzo della fonte e non quello del catalogo.
  const marca = (cpApertoId ? '' : p.marca) || (r && r.marca) || '';
  // Il MODELLO invece lo dice l'annuncio: chiedere le misure del modello CERCATO sotto un
  // annuncio marcato "altro modello" significa mostrare i dati di un altro veicolo. Il
  // modello della ricerca vale solo quando la fonte ha confermato che l'annuncio e' quello,
  // ed e' la stessa regola che usa `loadVehScheda`.
  const confermato = !r || !r.dichiarazione || ['esatto', 'senza-versione', 'versione-non-verificata'].includes(r.dichiarazione);
  const modello = modelloAnnuncio(r) || (confermato && !cpApertoId ? p.modello : '') || '';
  // 'Altro' e' il segnaposto di Subito quando il venditore la marca non l'ha scelta: non e'
  // una marca, e chiederla a una fonte darebbe una risposta a caso o nessuna.
  return { marca: marca === 'Altro' ? '' : marca, modello };
}

/** marca e modello dall'annuncio (vedi `coppiaAnnuncio`), l'anno dall'annuncio. */
function gommeChiave(r) {
  if (passTipo(r) !== 'auto') return null;                    // Wheel-Size qui e' solo auto
  const { marca, modello } = coppiaAnnuncio(r);
  if (!marca || !modello || !r.anno) return null;
  return { marca, modello, anno: r.anno };
}

function gommePneuHTML(r, misura) {
  const st = (r._pneu || {})[misura];
  if (!st) return '';
  if (st.stato === 'carico') return '<div class="gom-pneu"><span class="gom-att">cerco le etichette…</span></div>';
  if (st.stato === 'ko') return '<div class="gom-pneu"><span class="gom-att">etichette non disponibili ora</span></div>';
  const p = st.d || [];
  if (!p.length) return '<div class="gom-pneu"><span class="gom-att">nessun pneumatico registrato con questa misura</span></div>';
  /**
   * IL NUMERO DELL'ARCHIVIO, non quello della pagina che abbiamo chiesto.
   *
   * Qui usciva `p.length`, cioe' quanti ne abbiamo scaricati: la fonte ne manda cento per
   * volta, quindi una misura con quattromila pneumatici registrati diceva "100 pneumatici
   * registrati". EPREL il totale lo dichiara (`totale`), e viaggiava gia' nella risposta.
   */
  const quanti = (st.totale != null && st.totale > p.length) ? st.totale : p.length;
  return '<div class="gom-pneu"><div class="gom-pneu-h">' + quanti.toLocaleString('it-IT')
    + ' pneumatici registrati · etichetta europea EPREL' + (quanti > p.length ? ' · ne mostro ' + Math.min(p.length, 8) : '') + '</div>'
    + p.slice(0, 8).map(x => `<div class="gom-pneu-r"><span class="gom-pneu-m">${escapeHtml([x.marca, x.modello].filter(Boolean).join(' ')).slice(0, 46)}</span>`
        + `<span class="gom-pneu-v">${escapeHtml(x.classeEfficienza || '—')}<em>consumo</em></span>`
        + `<span class="gom-pneu-v">${escapeHtml(x.classeBagnato || '—')}<em>bagnato</em></span>`
        + `<span class="gom-pneu-v">${x.rumoreDb ? escapeHtml(String(x.rumoreDb)) + ' dB' : '—'}<em>rumore</em></span>`
        + (x.neve ? '<span class="gom-pneu-s" title="marcatura 3PMSF">❄︎</span>' : '')
        + '</div>').join('')
    + (p.length > 8 ? `<div class="gom-att">e altri ${p.length - 8} · lista limitata dall'area demo</div>` : '') + '</div>';
}

function gommeHTML(r) {
  const k = gommeChiave(r);
  if (!k) return '';
  const st = r._gomme;
  const calz = (st && st.stato === 'ok') ? ((st.d && st.d.calzate) || []).filter(c => c.misura) : [];
  const misure = new Set(calz.map(c => c.misura));
  const meta = misure.size ? `${misure.size} misure` : '';
  return miniHTML('gom:' + r.url, 'Cerchi e gomme', meta, gommeCorpoHTML(r, k), { carica: 'gomme' });
}

function gommeCorpoHTML(r, k) {
  const st = r._gomme;
  if (!st) return '<div class="gom-att">Cerco cerchi e gomme…</div>';
  if (st.stato === 'carico') return '<div class="gom-att">Cerco cerchi e gomme…</div>';
  if (st.stato === 'ko') return '<div class="gom-att">Fonte non raggiungibile.</div>'
    + '<button type="button" class="det-act btn-gomme"><span class="ra-txt">Riprova</span></button>';
  const d = st.d || {};
  const calz = (d.calzate || []).filter(c => c.misura);
  if (!calz.length) {
    // Wheel-Size mette la misura in chiaro solo sul primo allestimento di ogni generazione:
    // se qui non ce n'e' nessuna, dirlo e' l'unica cosa onesta — un riquadro vuoto no.
    // Il nome che si dice deve essere quello DAVVERO interrogato: il server ripulisce il
    // suffisso di generazione ("Panda 3ª serie" → "Panda"), e scrivere qui il nome grezzo
    // farebbe cercare all'utente un errore dove non c'e'.
    const nome = (d && d.modello) || k.modello;
    return `<div class="gom-att">Nessuna misura in chiaro per ${escapeHtml(k.marca)} ${escapeHtml(nome)} ${k.anno}`
      + ((d.calzate || []).length ? ` (la fonte elenca ${d.calzate.length} allestimenti ma senza misura)` : '') + '.</div>';
  }
  // una riga per MISURA distinta: la stessa gomma torna su piu' allestimenti
  const per = new Map();
  for (const c of calz) {
    if (!per.has(c.misura)) per.set(c.misura, { cerchi: new Set(), press: new Set() });
    if (c.cerchio) per.get(c.misura).cerchi.add(c.cerchio);
    if (c.pressioneAntBar) per.get(c.misura).press.add(c.pressioneAntBar + (c.pressionePostBar ? ' / ' + c.pressionePostBar : '') + ' bar');
  }
  return '<div class="gom"><div class="gom-h"><span class="gom-src">Wheel-Size</span>'
    + '<span class="gom-hint">clicca una misura per l\'etichetta europea</span></div>'
    + [...per.entries()].map(([mis, v]) => `<div class="gom-riga">
        <button type="button" class="gom-mis" data-misura="${escapeHtml(mis)}">${escapeHtml(mis)}</button>
        <span class="gom-det">${escapeHtml([...v.cerchi].slice(0, 3).join(' · '))}${v.press.size ? ' — ' + escapeHtml([...v.press].slice(0, 2).join(' · ')) : ''}</span>
      </div>${gommePneuHTML(r, mis)}`).join('')
    + (d.nota ? `<div class="gom-att">${escapeHtml(d.nota)}</div>` : '') + '</div>';
}

async function caricaGomme(r, pannello) {
  const k = gommeChiave(r); if (!k) return;
  r._gomme = { stato: 'carico' };
  pannello?._render?.();
  try {
    const d = await fetch(`/api/fonti/cerchi/calzate?marca=${encodeURIComponent(k.marca)}`
      + `&modello=${encodeURIComponent(k.modello)}&anno=${encodeURIComponent(k.anno)}`).then(x => x.json());
    r._gomme = d && d.ok !== false ? { stato: 'ok', d } : { stato: 'ko' };
  } catch (_) { r._gomme = { stato: 'ko' }; }
  pannello?._render?.();
}

async function caricaPneumatico(r, misura, pannello) {
  r._pneu = r._pneu || {};
  if (r._pneu[misura]) { delete r._pneu[misura]; pannello?._render?.(); return; }   // secondo click: chiudi
  r._pneu[misura] = { stato: 'carico' };
  pannello?._render?.();
  try {
    const d = await fetch('/api/fonti/pneumatici/cerca?misura=' + encodeURIComponent(misura)).then(x => x.json());
    r._pneu[misura] = (d && d.ok !== false) ? { stato: 'ok', d: d.pneumatici || [], totale: d.totale ?? null } : { stato: 'ko' };
  } catch (_) { r._pneu[misura] = { stato: 'ko' }; }
  pannello?._render?.();
}

/**
 * DA QUANDO E' IN VENDITA QUESTO MEZZO — il singolo, non la mediana del piazzale.
 * Autoscout dichiara la prima pubblicazione; Moto.it la dice nella pagina dell'annuncio e
 * arriva con l'arricchimento della riga. Su Subito no: li' quella data si azzera a ogni
 * rilancio (misurato: 27 auto tutte "pubblicate oggi"), e mostrarla sarebbe un numero falso.
 */
function giorniInVendita(r) {
  if (!r || !r.posted_at || r.fonte === 'subito') return null;
  const g = Math.round((Date.now() - new Date(r.posted_at).getTime()) / 86400000);
  return Number.isFinite(g) && g >= 0 && g < 4000 ? g : null;
}

function renderDetailInto(panel, r) {
  panel.dataset.loaded = '1';
  const renderBody = () => {
    const gallery = (Array.isArray(r.immagini) && r.immagini.length)
      ? `<div class="det-gallery">${r.immagini.slice(0, 8).map(im => `<img src="${escapeHtml(im.thumb)}" loading="lazy" referrerpolicy="no-referrer" alt="">`).join('')}</div>`
      : '';
    const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="det-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri annuncio ↗</a>` : '';
    // Hub azioni nel pannello (unico accesso su mobile dove la riga non ha bottoni).
    const isSal = salvati.some(x => stessoAnnuncio(x, r)), inConf = confronto.some(x => stessoAnnuncio(x, r));
    const salBtn  = `<button type="button" class="det-act btn-salva${isSal ? ' attivo' : ''}">${icon(isSal ? 'bookmark-filled' : 'bookmark')}<span class="ra-txt">${isSal ? 'Salvato' : 'Salva'}</span></button>`;
    const confBtn = `<button type="button" class="det-act btn-confronta${inConf ? ' attivo' : ''}">${icon(inConf ? 'square-check' : 'square')}<span class="ra-txt">${inConf ? 'Nel confronto' : 'Confronta'}</span></button>`;
    panel.innerHTML = `<div class="det-inner">${gallery}<div class="det-specs">${detailSpecsHTML(r)}</div>`
      /**
       * I BLOCCHI RICHIUDIBILI IN GRIGLIA, non in colonna.
       *
       * Optional, testo, passaggio e cerchi erano quattro <div> uno sotto l'altro: su uno
       * schermo largo restavano quattro righe alte una riga, con mezzo pannello vuoto a
       * destra, e per arrivare all'ultimo si scorreva. E' la stessa griglia che l'area
       * ADD ON usa gia' (`auto-fit` a 290px): dove c'e' spazio si affiancano, dove non
       * c'e' tornano in colonna da soli.
       * Da qui in giu' ci sono anche le INTEGRAZIONI ESTERNE: costano una richiesta e non
       * stanno nell'annuncio, quindi restano richiudibili e non partono da sole.
       */
      + `<div class="det-blocchi">${optionalHTML(r)}${testoHTML(r)}`
      + `<div class="det-gomme">${gommeHTML(r)}</div></div>`
      // La vetrina del venditore sono BOTTONI, non un blocco richiudibile: resta fuori
      // dalla griglia, sulla sua riga.
      + `<div class="det-fonte">${vetrinaHTML(r)}</div>`
      // LA SCHEDA TECNICA di QUESTO annuncio: sta qui e non nella ricerca, perche' i
      // vincoli con cui si trova la motorizzazione giusta li dichiara l'annuncio. Pigra:
      // niente parte finche' non premi. Quando si apre e' larga quanto il pannello, quindi
      // resta fuori dalla griglia: dentro finirebbe schiacciata in una colonna da 290px.
      + `<div class="det-scheda">${vehHostUrl === r.url ? '' : '<button type="button" class="det-scheda-apri">Scheda tecnica</button>'}</div>`
      + `<div class="det-foot">${openBtn}${salBtn}${confBtn}</div></div>`;
  };
  panel._render = () => {
    renderBody();
    // Se questo pannello ospitava la scheda, il re-render ha appena buttato via il suo
    // contenitore: si riaggancia e si ridisegna, altrimenti la scheda sparisce al primo
    // ricalcolo del passaggio di proprieta'.
    if (vehHostUrl === r.url) {
      const h = panel.querySelector('.det-scheda');
      if (h) { vehHost = h; renderVehScheda(); }
    }
  };
  // SEMPRE `panel._render()`, mai `renderBody()` da fuori: il solo corpo butta via il
  // contenitore della scheda tecnica senza riagganciarla, e siccome l'annuncio risulta
  // ancora il suo proprietario al posto del bottone resta il vuoto — la scheda spariva e
  // non c'era piu' modo di richiederla.
  panel._render();   // apertura immediata (cover + dati on-search) → niente freeze del click
  // Moto.it: galleria piena + spec dalla pagina-dettaglio. Riusa enrichMotoRow (merge
  // immagini+spec, cache 12h server, aggiorna anche il thumb della riga); poi ri-rende.
  if (r.fonte === 'moto' && !r._enriched && /^https?:/.test(r.url || '')) {
    enrichMotoRow(r.url).then(() => { if (panel.isConnected) panel._render(); });
  }
}

function openAd(url) { if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer'); }

// Il prezzo min/max in toolbar non c'e' piu': ripeteva la prima e l'ultima riga della
// griglia ordinata per prezzo. `updateStats` resta come punto unico da cui chiamare, se
// un giorno torna una statistica che aggiunge qualcosa.
function updateStats() {}

// ─── Stato per-fonte ──────────────────────────────────────────────────────────
const SOURCE_STATUS = {
  ok: { cls: 'src-ok' }, empty: { cls: 'src-muted', txt: 'nessun risultato' },
  skipped: { cls: 'src-muted' }, timeout: { cls: 'src-bad', txt: 'timeout' },
  error: { cls: 'src-bad', txt: 'errore' }, needs_bootstrap: { cls: 'src-warn', txt: 'verifica richiesta' },
};
const SKIP_REASON_TXT = { 'solo moto': 'solo moto', 'marca non su Moto.it': 'non disponibile', 'marca non su Autoscout': 'non disponibile' };
function renderSourceStatus() {
  if (!fonteBreakdown) return;
  if (!lastSources) { fonteBreakdown.innerHTML = ''; return; }
  const order = ['subito', 'autoscout', 'moto'];
  fonteBreakdown.innerHTML = order.map(f => {
    const s = lastSources[f]; if (!s) return '';
    const meta = SOURCE_STATUS[s.status] || { cls: 'src-muted' };
    let txt;
    /**
     * DUE NUMERI, NON UNO: quanti ne mostriamo e quanti ne ha la fonte.
     *
     * Il secondo arriva dentro le risposte che gia' leggiamo — `count_all` di Subito,
     * `metadata.totalItems` di Autoscout, il conteggio in pagina di Moto.it — quindi non
     * costa una richiesta. Dice una cosa che prima non si poteva sapere: se la ricerca ha
     * visto tutto o solo la punta. Su "Golf" sono 100 mostrati e 11.610 esistenti.
     *
     * Non e' "quanti ne abbiamo scartati": sono due popolazioni diverse, il totale e'
     * quello del filtro della FONTE, il conteggio e' dopo i NOSTRI filtri. Per questo
     * restano affiancati e non si sottraggono.
     */
    if (s.status === 'ok') {
      txt = `${s.count}`;
      // DI CHI E' QUEL TOTALE. Su Moto.it, quando lo slug del modello non c'e', la ricerca
      // si allarga alla marca e il conteggio in pagina e' quello della marca: scriverlo
      // nudo lo faceva sembrare il bacino del modello che hai chiesto.
      if (s.totale != null && s.totale > s.count) {
        txt += ` <em>di ${Number(s.totale).toLocaleString('it-IT')}${s.totaleLargo ? ' sulla marca' : ''}</em>`;
      }
    }
    else if (s.status === 'skipped') txt = SKIP_REASON_TXT[s.reason] || s.reason || 'saltato';
    else txt = meta.txt || s.status;
    const dim = s.status === 'ok' ? '' : ' src-dim';
    return `<span class="src ${meta.cls}${dim}">${FONTE_LABEL[f]} <b>${txt}</b></span>`;
  }).join('');
  // L'AVVISO DI ALLARGAMENTO. `reason` veniva stampata solo per le fonti 'skipped', ma la frase
  // "nessun X su Autoscout: mostro Y" nasce a status 'ok' — quindi non compariva mai, e si
  // leggevano annunci di un altro modello (o di un altro allestimento) senza nessun segnale.
  // Riga propria sotto le pill, come `.veh-liq-avviso` per la liquidita'.
  const as = lastSources.autoscout;
  if (as && as.allargato && as.reason) {
    fonteBreakdown.innerHTML += `<span class="src-avviso">${escapeHtml(as.reason)}</span>`;
  }
  /**
   * IL RISULTATO PARZIALE, che il server calcola e finora buttavamo qui.
   *
   * `parziale` nasce quando una fonte ha risposto solo in parte: su Autoscout perche' alcune
   * grafie del modello sono cadute (succede sulle moto, dove `as24Spellings` ne prova piu'
   * d'una), altrove perche' alcune pagine non si sono lasciate leggere. Il server lo mette in
   * `reason`, ma questa funzione stampava `reason` solo per le fonti 'skipped' e per Autoscout
   * solo insieme a `allargato`: con lo stato 'ok' e nessun allargamento, la frase non
   * compariva mai. A schermo la fonte sembrava aver risposto per intero.
   */
  for (const f of order) {
    const s = lastSources[f];
    if (s && s.status === 'ok' && s.parziale && !(f === 'autoscout' && s.allargato)) {
      fonteBreakdown.innerHTML += `<span class="src-avviso">${escapeHtml(String(s.parziale))}</span>`;
    }
  }
  // Una fonte che non ha risposto all'ULTIMA fetta: la pastiglia resta verde di proposito
  // (conserva lo stato buono della fetta precedente), quindi senza questa riga la caduta non
  // avrebbe nessun posto dove comparire.
  const kaputt = order.filter(f => lastSources[f] && lastSources[f].ultimaFettaKo);
  if (kaputt.length) {
    const nomi = kaputt.map(f => FONTE_LABEL[f] || f).join(' e ');
    fonteBreakdown.innerHTML += `<span class="src-avviso">${escapeHtml(nomi)} non ${kaputt.length === 1 ? 'ha' : 'hanno'} risposto all'ultimo «Carica altri»: quella parte di mercato non è stata vista. Premi ancora per riprovare.</span>`;
  }
  // Le parole della versione che Moto.it non conosce vengono ignorate di proposito — un filtro
  // che svuoterebbe l'insieme si scarta — ma finora quel "di proposito" restava in un log del
  // server: a schermo la colonna Moto.it si presentava filtrata come le altre.
  /**
   * SUBITO CERCATO A PAROLE. Quando il modello non sta nel catalogo di Subito la ricerca
   * parte come testo libero, con una precisione misurata del 71% (e zero su nomi corti come
   * "Audi 80", dove "80" pesca dentro "180 CV" e "80.000 km"). Il server lo dichiara da
   * sempre in `come`, e questa funzione non lo leggeva: quella colonna si presentava precisa
   * come le altre due. Niente pastiglia riga per riga — sarebbero tutte — ma una riga qui.
   */
  const sb = lastSources.subito;
  if (sb && sb.come === 'testo libero' && sb.status === 'ok' && sb.count > 0) {
    fonteBreakdown.innerHTML += '<span class="src-avviso">Ricerca pari alla ricerca a testo libero di Subito. Vuoi gestire le tue ricerche in modo diverso? Parliamone!</span>';
  }
  const mo = lastSources.moto;
  // Il menu versioni di Moto.it che non ha risposto: il filtro non e' stato applicato (o lo e'
  // stato su un elenco monco), e finora la colonna si presentava filtrata come le altre.
  if (mo && mo.versioneElencoMonco) {
    fonteBreakdown.innerHTML += `<span class="src-avviso">${escapeHtml(String(mo.versioneElencoMonco))}</span>`;
  }
  if (mo && mo.versioneIgnorata && mo.versioneIgnorata.length) {
    const p = mo.versioneIgnorata;
    fonteBreakdown.innerHTML += `<span class="src-avviso">Moto.it non ha ${p.length === 1 ? 'la parola' : 'le parole'} “${escapeHtml(p.join('”, “'))}” nel suo catalogo versioni: quella parte del filtro non è stata applicata.</span>`;
  }
  // Il filtro km di Subito e' a fasce, non a numero, su ENTRAMBI i lati: chiedendo un massimo di
  // 200.000 arrivano annunci fino a 249.999, chiedendone un minimo di 22.000 arrivano da 20.000.
  // Ora che la colonna Km mostra il chilometraggio VERO e non il fondo-fascia, quelli si vedono
  // — e senza questa riga sembrerebbero un errore dell'app. Coi numeri tondi non compare nulla.
  const sub = lastSources.subito;
  if (sub && sub.status === 'ok' && sub.count > 0 && (sub.kmFino || sub.kmDa)) {
    const km = n => Number(n).toLocaleString('it-IT');
    const pezzi = [];
    if (sub.kmDa) pezzi.push(`da ${km(sub.kmDa)}`);
    if (sub.kmFino) pezzi.push(`fino a ${km(sub.kmFino)}`);
    fonteBreakdown.innerHTML += `<span class="src-avviso">Subito filtra i km a fasce: possono arrivare annunci ${pezzi.join(' e ')} km</span>`;
  }
}

// ─── Spec (dettaglio) ────────────────────────────────────────────────────────
const SPEC_LABELS = {
  variante: 'Versione', cambio: 'Cambio', cilindrata: 'Cilindrata', cilindri: 'Cilindri',
  potenzaCv: 'Potenza', carrozzeria: 'Carrozzeria', colore: 'Colore', porte: 'Porte', posti: 'Posti',
  classeEmissioni: 'Classe emissioni', neopatentati: 'Neopatentati', nuovo: 'Condizione', danni: 'Danni',
  venditore: 'Venditore', proprietari: 'Proprietari', allestimento: 'Allestimento', revisione: 'Revisione',
  // Nativi delle fonti, letti da poco: i kW li dichiara Subito (l'IPT ci gira sopra e
  // prima erano stimati dai CV), il resto lo dichiara Autoscout.
  potenzaKw: 'Potenza kW', generazione: 'Generazione', motore: 'Motore',
  tappezzeria: 'Interni', pesoVuoto: 'Peso a vuoto', cerchiPollici: 'Cerchi',
};
function specVal(k, v) {
  if (v == null || v === '') return '';
  if (k === 'potenzaCv') return `${v} CV`;
  if (k === 'potenzaKw') return `${v} kW`;
  if (k === 'pesoVuoto') return `${Number(v).toLocaleString('it-IT')} kg`;
  if (k === 'cerchiPollici') return `${v}"`;
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
/**
 * DUE OGGETTI SONO LO STESSO ANNUNCIO?
 *
 * Fino a ieri la risposta era "hanno lo stesso URL". Ma l'URL di Subito contiene il titolo
 * scritto dal venditore: se lui lo ritocca, un annuncio SALVATO ieri oggi non si riconosce
 * piu' — la stella sparisce dalla riga, e nei salvati resta una copia che punta a un
 * indirizzo vecchio. Le fonti che un'identita' stabile la dichiarano la mettono in `id`
 * (vedi backend/scrapers/subito-api.js); le altre restano sull'URL, che li' non porta il
 * titolo dentro. Quando uno dei due lati l'id non ce l'ha, si ricade sull'URL: e' il caso
 * di un salvato di ieri non ancora convertito.
 */
const stessoAnnuncio = (a, b) => {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return a.url === b.url;
};
/** L'annuncio con questo URL, fra quelli che l'app ha in mano adesso. */
function trovaResult(url) {
  return currentResults.find(r => r.url === url) || salvati.find(r => r.url === url) || confronto.find(r => r.url === url) || null;
}
// Aggiorna SOLO i bottoni/stato di un URL (riga + pannello dettaglio) senza re-render
// totale → non collassa il dettaglio aperto né perde lo scroll (flusso mobile).
function refreshRowState(url) {
  const rif = trovaResult(url);
  const isSal  = salvati.some(r => stessoAnnuncio(r, rif) || r.url === url);
  const inConf = confronto.some(r => stessoAnnuncio(r, rif) || r.url === url);
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
  const rifC = trovaResult(url);
  const idx = confronto.findIndex(r => stessoAnnuncio(r, rifC) || r.url === url);
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
  const rifM = trovaResult(url);
  const i = confronto.findIndex(r => stessoAnnuncio(r, rifM) || r.url === url);
  if (i !== -1) { confronto.splice(i, 1); refreshRowState(url); renderSalvati(); renderCompareBar(); }
  // Chi cambia la lista riscrive l'intestazione che la conta: il titolo lo scriveva solo
  // showMatrix, e «Selezionati: 3» restava accanto a «Confronto annunci (4)».
  cmatrixTitle.textContent = cmatrixTitle.textContent.replace(/\(\d+\)\s*$/, `(${matrixList.length})`);
  if (!matrixList.length) closeMatrix(); else renderMatrix();
}

const MATRIX_ROWS = [
  // Il prezzo del confronto e' il RETTIFICATO, come in griglia e negli export: `fmt`
  // riceve anche la riga intera proprio per questo. La stella del migliore resta sul
  // grezzo (stessa monotonia: finale = base + aggiunte − spese, il vincitore non cambia).
  { key: 'prezzo', label: 'Prezzo', best: 'min', fmt: (v, r) => prezzoEtichetta(r) },
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
  // La corrispondenza sta nel confronto come sta nella lista e nel PDF: qui piu' che altrove,
  // perche' e' il posto dove si mettono due annunci fianco a fianco per decidere, e finora
  // niente diceva che uno dei due poteva essere un altro modello.
  // «Corrispondenza» legge TUTTI E DUE i canali del fuori-bersaglio: senza il secondo,
  // una riga che l'app aveva marcato «smentita» qui usciva «corrisponde».
  { key: 'dichiarazione', label: 'Corrispondenza', fmt: (v, r) => (r && r.versioneEsito === 'smentita')
    ? 'non e\' quella versione' : (DICHIARAZIONE[v] ? DICHIARAZIONE[v].et : 'corrisponde') },
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
  // Stessa regola della lista: se nel confronto e' finito anche un annuncio di un altro
  // modello, il PREZZO migliore non si assegna — il piu' economico e' quasi sempre quello,
  // perche' e' un altro veicolo. Le altre righe (anno, km, potenza) restano confrontabili.
  const cmMisto = list.some(fuoriBersaglio);
  const bestByRow = MATRIX_ROWS.map(cfg => (cfg.best && !(cmMisto && cfg.key === 'prezzo'))
    ? bestIndexes(list.map(r => r[cfg.key]), cfg.best) : new Set());

  if (window.matchMedia('(max-width: 760px)').matches) {
    const cards = list.map((r, ci) => {
      const thumb = (Array.isArray(r.immagini) && r.immagini[0])
        ? `<img class="cm-card-img" src="${escapeHtml(r.immagini[0].thumb)}" referrerpolicy="no-referrer" alt="">`
        : `<div class="cm-card-img cm-card-noimg">—</div>`;
      const openBtn = /^https?:\/\//i.test(r.url) ? `<a class="cm-open" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">Apri ↗</a>` : '';
      const priceBest = bestByRow[0].has(ci);   // MATRIX_ROWS[0] = prezzo
      const price = prezzoEtichetta(r);
      const specs = MATRIX_ROWS.map((cfg, ri) => ({ cfg, ri })).filter(x => x.cfg.key !== 'prezzo').map(({ cfg, ri }) => {
        const best = bestByRow[ri].has(ci);
        return `<div class="cm-card-spec"><span class="cm-card-k">${cfg.label}</span><span class="cm-card-v${best ? ' cm-best' : ''}">${escapeHtml(String(cfg.fmt(r[cfg.key], r)))}${best ? ' <span class="cm-star">★</span>' : ''}</span></div>`;
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
    const vals = list.map(r => String(cfg.fmt(r[cfg.key], r)));
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
  const rifS = trovaResult(url);
  const idx = salvati.findIndex(r => stessoAnnuncio(r, rifS) || r.url === url);
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
  // I salvati di ieri non hanno l'id stabile: si ricava dalla coda del vecchio URL, che e'
  // lo stesso progressivo che la fonte dichiara in `urn`. Senza, un annuncio salvato prima
  // del passaggio smetteva di riconoscersi appena il venditore ritoccava il titolo.
  let tocco = false;
  for (const r of salvati) {
    if (r && !r.id && typeof r.url === 'string' && /(^|\.)subito\.it\//i.test(r.url)) {
      const m = r.url.match(/-(\d+)\.htm(?:$|[?#])/);
      if (m) { r.id = 'subito:' + m[1]; tocco = true; }
    }
  }
  if (tocco) persistSalvati();
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
  const fmtKm = n => n != null ? `${n.toLocaleString('it-IT')} km` : '—';
  container.innerHTML = salvati.map(r => {
    const inConf = confronto.some(c => stessoAnnuncio(c, r));
    return `<div class="salvato-item" data-url="${escapeHtml(r.url)}">
      <div class="salvato-info">
        <div class="salvato-titolo">${escapeHtml(r.titolo)}</div>
        <div class="salvato-dettagli">${prezzoEtichetta(r)} · ${fmtKm(r.km)} · ${r.anno || '—'}</div>
      </div>
      <div class="salvato-actions">
        <button class="btn-confronta-salvato${inConf ? ' attivo' : ''}" title="Confronta">${icon(inConf ? 'square-check' : 'square')}</button>
        <button class="btn-rimuovi-salvato" title="Rimuovi">${icon('x')}</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Ricerche salvate + avvisi ──────────────────────────────────────────────
/**
 * Perche' l'elenco non si e' letto: senza, un 403 (demo) o un 401 (sessione scaduta)
 * scendevano come lista vuota e il pannello diceva «Nessuna ricerca salvata» — cioe'
 * un'affermazione sui DATI fatta su un permesso negato. E' anche lo stampo per le altre
 * fetch: `!r.ok` non si appiattisce mai su «non c'e' niente».
 */
let savedSearchesKo = null;   // null | 'demo' | 'sessione' | 'rete'
async function loadSavedSearches() {
  savedSearchesKo = null;
  try {
    const r = await fetch('/api/saved');
    if (!r.ok) { savedSearches = []; savedSearchesKo = r.status === 403 ? 'demo' : r.status === 401 ? 'sessione' : 'rete'; }
    else { const j = await r.json(); savedSearches = j.saved || []; }
  } catch (_) { savedSearches = []; savedSearchesKo = 'rete'; }
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
  // Si segna letto SOLO l'avviso cliccato: prima il clic sul primo di dodici li faceva
  // sparire tutti, e con piu' persone svuotava la coda del proprietario.
  if (alertEl) { markRicercaRead(id, alertEl.dataset.url); openAd(alertEl.dataset.url); return; }
  if (e.target.closest('.ric-head')) card.classList.toggle('open');
}
async function deleteRicerca(id) {
  try { await fetch(`/api/saved/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadSavedSearches(); }
  catch (_) { showError('Eliminazione non riuscita.'); }
}
async function markRicercaRead(id, url) {
  // L'url dell'avviso: si segna letto QUELLO, non tutta la coda della ricerca. Senza,
  // aprire il primo di dodici avvisi faceva sparire gli altri undici.
  try {
    const q = url ? `?url=${encodeURIComponent(url)}` : '';
    await fetch(`/api/saved/${encodeURIComponent(id)}/read${q}`, { method: 'POST' });
  } catch (_) {}
  const s = savedSearches.find(x => x.id === id);
  if (s) {
    if (url) {
      // Uno solo in meno, non la coda intera: il conteggio deve dire la verita' anche
      // prima del prossimo giro sul server.
      s.alerts = (s.alerts || []).filter(a => a.url !== url);
      s.novita = Math.max(0, (s.novita || 0) - 1);
      s.digest = s.alerts.reduce((d, a) => { d[a.motivo] = (d[a.motivo] || 0) + 1; return d; }, {});
    } else { s.novita = 0; s.digest = {}; s.alerts = []; }
    updateNovitaBadge();
  }
  const card = document.querySelector(`.ric-card[data-id="${CSS.escape(id)}"]`);
  if (card) { card.classList.remove('has-novita'); card.querySelector('.ric-badge')?.remove(); }
}
const MOTIVO_LABEL = { nuovo: 'nuovi', calo: 'cali' };
function renderRicerche() {
  const c = document.getElementById('ricercheList');
  if (!savedSearches.length) {
    // La frase segue il PERCHE': «nessuna ricerca» e' un fatto sui dati e si dice solo
    // quando i dati si sono letti davvero. Il messaggio demo non invita a premere un
    // bottone che applyDemoMode ha appena nascosto.
    const vuoto = {
      demo: 'Le ricerche salvate sono del proprietario.<br><small>In modalita\' demo non si leggono.</small>',
      sessione: 'Sessione scaduta.<br><small>Rientra dalla pagina di accesso per rivedere le tue ricerche.</small>',
      rete: 'Ricerche salvate non raggiungibili ora.<br><small>Riprova fra poco.</small>',
    }[savedSearchesKo] || 'Nessuna ricerca salvata.<br><small>Fai una ricerca e premi "Salva ricerca".</small>';
    c.innerHTML = `<p class="text-muted text-center py-4">${vuoto}</p>`;
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
  c.innerHTML = savedSearches.map(s => {
    const novita = s.novita || 0;
    const badge = novita > 0 ? `<span class="ric-badge">${novita}</span>` : '';
    const dig = Object.entries(s.digest || {}).map(([m, n]) => `${n} ${MOTIVO_LABEL[m] || m}`).join(' · ');
    const digestLine = dig ? `<div class="ric-digest">${dig}</div>` : '';
    // Un controllo con una fonte muta veniva mostrato come un controllo qualunque: l'ora
    // c'era, e "nessuna novita'" si leggeva come una risposta. Ora si dice chi non ha parlato,
    // e quand'e' stata l'ultima volta che hanno risposto tutte.
    const muteLine = (s.fontiMute && s.fontiMute.length)
      ? ` · <span class="ric-mute">senza ${escapeHtml(s.fontiMute.map(f => FONTE_LABEL[f] || f).join(' e '))}${s.lastCheckedFull ? `, complete ${whenTxt(s.lastCheckedFull)}` : ''}</span>`
      : '';
    const alertsHtml = (s.alerts || []).map(a => `
      <div class="ric-alert ric-${a.motivo}" data-url="${escapeHtml(a.url)}" title="Apri annuncio">
        <span class="ric-motivo">${MOTIVO_LABEL[a.motivo]?.slice(0, -1) || a.motivo}</span>
        <span class="ric-alert-tit">${escapeHtml(a.titolo || 'Annuncio')}</span>
        <span class="ric-alert-prezzo">${prezzoEtichetta(a)}</span>
      </div>`).join('');
    return `<div class="ric-card${novita ? ' has-novita' : ''}" data-id="${escapeHtml(s.id)}">
      <div class="ric-head">
        <div class="ric-title">${escapeHtml(s.label)} ${badge}</div>
        <div class="ric-sub">${escapeHtml(s.params?.tipo || '')} · controllata ${whenTxt(s.lastChecked)}${muteLine}</div>
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
  // "Allega i dati della ricerca" esiste se una RICERCA c'e' stata. `searchActive` e' vero
  // anche nel parco di un concessionario, dove i criteri non esistono: la spunta si offriva
  // e allegava il nulla (o, prima del reset, i criteri di tutt'altro).
  if (att) { att.checked = false; att.parentElement.style.display = lastSearchParams ? '' : 'none'; }
  m.classList.remove('d-none');
  document.getElementById('reportMsg').focus();
}
function closeReport() { document.getElementById('reportModal')?.classList.add('d-none'); }
async function submitReport() {
  const msg = document.getElementById('reportMsg').value.trim();
  const status = document.getElementById('reportStatus');
  if (!msg) { status.textContent = 'Scrivi un messaggio.'; return; }
  const attach = document.getElementById('reportAttach')?.checked && !!lastSearchParams;
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
/**
 * IL CONTESTO E' CAMBIATO. Un punto solo, chiamato da chiunque cambi cosa si sta guardando.
 *
 * Erano TRE i posti che riempiono la griglia — `doSearch`, il parco di un concessionario
 * (`cpMostraParco`) e un gruppo di vetrine (`cpMostraGruppo`) — piu' `hideResults` che la
 * svuota e il cambio Auto/Moto. Ognuno azzerava un sottoinsieme diverso, e quello che
 * restava indietro descriveva la schermata di PRIMA: la liquidita' della BMW cercata sotto
 * la Panda del parco, il PDF del parco con in testa i criteri di un'altra ricerca, "Solo
 * IVA esposta" che sopravvive alla ricerca nuova e la svuota mentre il pannello dice che
 * non c'e' niente, il raggruppamento della ricerca auto ancora attivo passando alle moto.
 *
 * Il confine e' quello deciso dal proprietario: si azzera QUELLO CHE DESCRIVE LA RICERCA
 * (i suoi dati, i filtri attivi, le colonne). NON si azzera come guardi — ordinamento,
 * vista lista/schede, menu prezzi, provincia, unita' — ne' gli annunci spuntati per il
 * confronto, che di proposito attraversano i contesti: spunti la tua auto nel parco, torni
 * alla ricerca, spunti un annuncio di mercato e li metti a fianco.
 */
function resetContesto() {
  // Una fetta di "Carica altri" ancora in volo non deve piu' atterrare: la risposta in
  // ritardo rimetteva `lastSources` e concatenava annunci in uno stato gia' azzerato.
  searchGen++;
  lastSearchParams = null;
  lastSources = null;
  fettaPresa = 0;
  ultimiVisti = null;
  soloIva = false;
  // Il toggle «mostrali» delle versioni smentite descrive LA ricerca, non il modo di
  // guardare: lasciato acceso, condizionava la ricerca successiva senza che nessuno
  // l'avesse chiesto in quel contesto.
  mostraVersioniSmentite = false;
  // La lista stessa: era azzerata in due punti fuori di qui, contro la regola scritta
  // qui sotto («un posto solo»). Chi riempie riassegna subito dopo, quindi e' innocuo.
  currentResults = [];
  groupDim = '';
  colsToccate = false;
  visibleCols = colsDefault(null);
  syncColMenu();
  // I segni di liquidita' accanto alle righe sono della MARCA cercata: senza ricerca non
  // esistono, e tenerli significava attribuirli agli annunci di un altro contesto.
  liqMarca = null; liqModelli = null; liqVoce = null; liqStato = 'mai';
  liqAnn = null;
  clearVehScheda();
}
function hideResults() {
  resetContesto();
  searchActive = false;
  targaBtnSync();   // niente annunci: il bottone della targa non ha dove andare
  document.body.classList.remove('has-results');   // torna allo stato iniziale → sfondo + search centrata
  resultsSection.classList.add('d-none'); noResults.classList.add('d-none'); resultsToolbar.classList.add('d-none');
  fonteBreakdown.innerHTML = ''; resultsGrid.innerHTML = ''; compareBar.classList.add('d-none'); closeMatrix();
  // L'avviso «Nascosti N annunci...» e' FRATELLO di fonteBreakdown, fuori da
  // resultsSection: svuotare i risultati non lo raggiungeva, e restava a schermo un
  // conteggio che non descriveva piu' nessuna lista, con un bottone che non faceva niente.
  rigaVersione(0);
  renderCompareBar();   // le spunte restano: la barra torna se ci sono ancora annunci a confronto
}

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
function clearVehScheda() { vehGen++; vehData = null; vehErrore = null; vehSpecs = {}; vehSelUrl = null; vehXf.compare = null; vehXf.q = ''; vehRichiami = null; vehOmoStato = {}; vehMisure = null; vehProva = null; vehStessoMotore = null; vehAddonAperto = false; const el = vehEl(); if (el) el.innerHTML = ''; vehHost = null; vehHostUrl = null; }   // vehGen++ invalida le fetch in volo; i richiami sono del veicolo cercato, non si tengono

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
  const daRicerca = cpApertoId ? '' : (p.modello || (selectedModel && selectedModel.nome) || '');
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
  vehRichiami = null; vehOmoStato = {}; vehMisure = null; vehProva = null; vehStessoMotore = null; vehAddonAperto = false;   // richiami e misure sono di QUEL veicolo: cambiando annuncio ripartono
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
    if (vehStessoMotore) renderVehScheda();
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
  return (vehData && vehData.marca) || (cpApertoId ? '' : p.marca) || '';
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
        + `<span class="veh-mis-cand-m">${[c.anno, c.categoria].filter(Boolean).join(' · ')}</span></button>`).join('');
      corpo = `<div class="veh-mis-lista">${scelte}</div>${vehProvaHTML()}`;
    }
  } else {
    const voci = st.voci || [];
    meta = String(st.quante || voci.length);
    if (!voci.length) corpo = '<div class="veh-mis-att">auto.it non ha rilevamenti di questo modello.</div>';
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
          + `<span class="veh-mis-m">${[v.anno, v.prova].filter(Boolean).join(' · ')}</span></div>`
          + `<div class="veh-mis-d">${dati.map(([k, x]) => `<span><em>${k}</em>${escapeHtml(String(x))}</span>`).join('')}</div></div>`;
      }).join('');
      corpo = `<div class="veh-mis">${righe}</div>`
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

// ─── Export CSV ───────────────────────────────────────────────────────────────
function exportCsv(results) {
  const cell = csvCell;
  const cfg = priceCfgV;
  const conPass = results.some(r => passDi(r) != null);
  // "Corrispondenza": senza, un CSV aperto in foglio di calcolo mette sulla stessa riga un
  // annuncio del modello cercato e uno di un altro modello, e chi ci costruisce sopra un
  // conto non ha modo di accorgersene. Qui non c'e' ingombro: e' una colonna in fondo.
  const cols = ['Fonte', 'Titolo', 'Prezzo (€)', 'Anno', 'KM', 'Carburante', 'Provincia', ...priceExtraHeaders(cfg, conPass), 'Corrispondenza', 'URL'];
  const rows = results.map(r => {
    const pr = vPricing(r.prezzo, passDi(r), r);
    const d = DICHIARAZIONE[r.dichiarazione];
    // L'export non porta con se' il contesto dello schermo («li stai vedendo»): una riga
    // smentita che esce «corrisponde» in un foglio di calcolo e' una certificazione falsa.
    const corr = r.versioneEsito === 'smentita' ? 'non e\' quella versione' : (d ? d.et : 'corrisponde');
    return [r.fonte, r.titolo, pr ? Math.round(pr.finale) : '', r.anno != null ? r.anno : '', r.km != null ? r.km : '', r.carburante || '', r.provincia || '', ...priceExtraValues(pr, cfg, conPass), corr, r.url].map(cell).join(',');
  });
  const csv = [cols.join(','), ...rows].join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `automotoradar-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ─── Export PDF ───────────────────────────────────────────────────────────────
function exportPdf(results) {
  /**
   * IL DISEGNO LO FA IL SERVER, non questa funzione.
   *
   * Qui c'erano centoventi righe che ridisegnavano lo stesso documento di
   * `backend/report-pdf.js`: due implementazioni dello stesso PDF, gia' divergenti (questa
   * aveva le colonne dei prezzi finali e una striscia di metriche calcolata su valori
   * diversi). Restava solo da aspettare che una correzione toccasse una sola delle due.
   *
   * Quello che il server NON puo' sapere sono i prezzi finali — commissione, spese, margine,
   * passaggio e IVA vivono nelle preferenze del browser — quindi le righe si compongono qui e
   * si spediscono gia' fatte. La marcatura di corrispondenza viaggia con loro: e' il motivo
   * per cui prima nel PDF una riga "altro modello" e una giusta erano identiche.
   */
  const cfg = priceCfgV;
  const conPass = results.some(r => passDi(r) != null);
  const extraH = priceExtraHeaders(cfg, conPass);
  const fmtEur = n => '\u20ac ' + n.toLocaleString('it-IT');
  // Il prezzo lo dice l'INTESTAZIONE, non una riga di legenda sopra la tabella: se i tuoi
  // conti (commissione, spese, margine, IVA) sono attivi, quella colonna non e' il prezzo
  // dell'annuncio ed e' giusto che il nome della colonna lo dica.
  const conConti = extraH.length > 0 || cfg.comm || cfg.spese || cfg.iva;
  const colonne = ['Fonte', 'Veicolo', conConti ? 'Prezzo finale' : 'Prezzo', 'Anno', 'Km', 'Carburante', 'Provincia', ...extraH, 'Corrispondenza'];
  const righe = results.map(r => {
    const pr = vPricing(r.prezzo, passDi(r), r);
    const d = DICHIARAZIONE[r.dichiarazione];
    return [
      ' ',                                   // la cella della fonte la disegna il server (chip)
      r.titolo,
      pr ? fmtEur(Math.round(pr.finale)) : '\u2014',
      r.anno != null ? String(r.anno) : '\u2014',
      r.km != null ? r.km.toLocaleString('it-IT') + ' km' : '\u2014',
      r.carburante || '\u2014',
      r.provincia || '\u2014',
      ...priceExtraValues(pr, cfg, conPass).map(x => x === '' ? '\u2014' : fmtEur(x)),
      // Come nel CSV: il PDF viaggia da solo, e una smentita non puo' uscire \u00abcorrisponde\u00bb.
      r.versioneEsito === 'smentita' ? 'non e\' quella versione' : (d ? d.et : 'corrisponde'),
    ];
  });
  scaricaPdf({
    params: lastSearchParams || {},
    colonne, righe,
    fonti: results.map(r => r.fonte),
    nome: `automotoradar-${new Date().toISOString().slice(0, 10)}.pdf`,
  });
}

// ─── Pre-fill da URL params ───────────────────────────────────────────────────
// Torna true se l'URL ha davvero pilotato l'app: in quel caso il modo salvato non deve
// scavalcare cio' che l'utente ha chiesto col link.
async function applyUrlParams() {
  const p = new URLSearchParams(window.location.search);
  if (!p.has('marca')) return false;
  const tipo = p.get('tipo') || 'auto';
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
    if (isValidMarca()) doSearch();
  }
  return true;
}

// Ripristino dell'area di lavoro. Si applica solo a un modo valido e diverso dal predefinito:
// un valore sporco in localStorage non deve poter bloccare l'app fuori dalla ricerca.
/** Una modalita' esiste per l'utente solo se ha il suo bottone nella barra. */
const modoRaggiungibile = m => !!m && !!document.querySelector(`#modeToggle .mode-btn[data-mode="${CSS.escape(m)}"]`);

/** Quello che si era salvato l'ultima volta. Non lancia: localStorage puo' essere negato. */
function modoSalvato() {
  try { return { m: localStorage.getItem('amrModo'), t: localStorage.getItem('amrModoTipo') }; }
  catch (_) { return { m: null, t: null }; }
}

/**
 * LO STATO VISIBILE, SUBITO — prima di ogni richiesta di rete.
 *
 * Mette a posto tre cose che altrimenti restano su Auto per tutta la durata del primo
 * caricamento: il radio del tipo, l'attributo del body e il bottone acceso nella barra.
 * Cosi' `populateMarca` scarica il catalogo GIUSTO, uno solo (prima ne scaricava due:
 * auto e poi quello vero), e chi lavora in Moto non vede piu' l'app passare da Auto.
 *
 * Non apre pannelli e non chiama `setSearchMode`: quello resta a `ripristinaModo()`, che
 * gira a fine init quando il catalogo c'e'. Qui si tocca solo cio' che si vede.
 */
function preImpostaModo() {
  const { m, t } = modoSalvato();
  if (t === 'moto') { const r = document.getElementById('tipoMoto'); if (r) r.checked = true; }
  // Il bottone acceso: per 'cerca' e' il tipo, per le aree e' l'area stessa. Se il modo
  // salvato non ha piu' un bottone (area tolta dalla barra), non si tocca niente.
  const bottone = m === 'cerca' ? (t === 'moto' ? 'moto' : 'auto') : m;
  if (modoRaggiungibile(bottone)) {
    document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === bottone));
  }
}

function ripristinaModo() {
  const { m, t } = modoSalvato();
  // 'cerca' non e' un bottone della barra: i bottoni sono auto, moto, ricambi, competitor.
  // La guardia qui sotto lo scartava sempre, quindi chi lavorava in Moto ripartiva in Auto
  // a ogni ricaricamento — mentre Ricambi e Competitor tornavano al loro posto.
  if (m === 'cerca') { if (t === 'moto' && modoRaggiungibile('moto')) selectPrimary('moto'); return; }
  // Una modalita' tolta dalla barra non deve tornare da localStorage: chi l'aveva salvata
  // ci resterebbe dentro senza avere il bottone per uscirne.
  if (!modoRaggiungibile(m)) return;
  if (m === 'ricambi' || area(m)) return selectPrimary(m);
}

// ─── Avvio ────────────────────────────────────────────────────────────────────
init();

// ─── COMPETITOR ───────────────────────────────────────────────────────────────
// Il parco di un concessionario: il tuo e quello di chi ti sta intorno.
//
// Un concessionario e' una VETRINA, e le fonti la servono per intero — Autoscout con
// `customer:{id}`, Subito con `uid=`, Moto.it con la vetrina `dealer.moto.it/<slug>` (li'
// il motore di ricerca non filtra per venditore: la vetrina si', ed e' servita dal server).
// Si incolla il link e l'app ricava l'id da sola.
//
// IL PARCO NON SI SCARICA DA SOLO. Aprire questa sezione non costa niente: si vede
// l'elenco salvato e basta. Il parco arriva quando lo chiedi, perche' un concessionario
// grosso costa una richiesta ogni cinquanta veicoli.
let cpVoci = null;                 // l'elenco salvato (null = mai caricato)
let cpParchi = {};                 // chiave → { stato, dati }
let cpErrore = null;
let cpApertoId = null;             // di chi sono gli annunci che stanno nella griglia
let cpGruppi = {};                 // gruppo → { stato, dati }: le vetrine unite, scaricate insieme
const cpAperte = new Set();        // quali schede sono aperte: il re-render non deve richiuderle

// La chiave di una voce e' `fonte:id`, non il solo id: le fonti numerano ognuna per conto
// suo, e con una collisione il solo id apriva il parco del venditore sbagliato. E' la
// stessa chiave che il backend usa nelle rotte e nella cache.
const cpChiave = v => v.fonte + ':' + v.id;

// Gli orari arrivano come li scrive Autoscout ("Mo 09:00-12:30, 14:30-19:30").
const CP_GIORNI = { Mo: 'Lun', Tu: 'Mar', We: 'Mer', Th: 'Gio', Fr: 'Ven', Sa: 'Sab', Su: 'Dom' };
function cpOrariHTML(orari) {
  if (!Array.isArray(orari) || !orari.length) return '';
  return '<div class="cp-orari">' + orari.map(o => {
    const m = String(o).match(/^([A-Za-z]{2})\s+(.+)$/);
    if (!m) return `<span class="cp-ora">${escapeHtml(o)}</span>`;
    return `<span class="cp-ora"><b>${escapeHtml(voceDi(CP_GIORNI, m[1]) || m[1])}</b> ${escapeHtml(m[2])}</span>`;
  }).join('') + '</div>';
}

const cpEl = () => document.getElementById('competitorPanel');
const cpNum = n => (n == null ? '—' : Number(n).toLocaleString('it-IT'));
const cpEur = n => (n == null ? '—' : '€ ' + Number(n).toLocaleString('it-IT', { maximumFractionDigits: 0 }));

async function cpApri() {
  const el = cpEl(); if (!el) return;
  el.classList.remove('d-none');
  document.body.classList.add('has-results');   // via lo sfondo dello stato-vuoto
  if (!cpVoci) {
    el.innerHTML = '<div class="cp-wrap"><div class="cp-att">Carico l\'elenco…</div></div>';
    try {
      const d = await fetch('/api/competitor').then(r => r.json());
      cpVoci = d.voci || [];
      // Elenco vuoto per file corrotto ≠ elenco vuoto davvero: se il server lo dichiara,
      // si avvisa PRIMA che il gesto istintivo (reincollare un link) peggiori le cose.
      if (d.erroreElenco) cpErrore = `L'elenco su disco e' illeggibile (${d.erroreElenco}): non aggiungere niente, il file si recupera a mano.`;
    } catch (_) { cpVoci = []; cpErrore = 'elenco non raggiungibile'; }
  }
  cpRender();
}
function cpChiudi() {
  // Uscendo dalla sezione, gli annunci del parco non possono restare nella griglia: la
  // ricerca che si apre dopo troverebbe a schermo i risultati di un'altra cosa.
  if (cpApertoId) hideResults();
  cpApertoId = null;
  const el = cpEl(); if (el) { el.classList.add('d-none'); el.innerHTML = ''; }
}

const cpRiga = (k, v) => `<div class="cp-n"><span>${escapeHtml(k)}</span><b>${v}</b></div>`;

/**
 * QUELLO CHE NON SI VEDE SCORRENDO GLI ANNUNCI.
 *
 * Le mediane dicevano poco: il prezzo mediano di un piazzale non e' il prezzo di nessun
 * veicolo, e marche e alimentazione le raggruppa gia' la toolbar sugli annunci veri, dove
 * si possono anche filtrare. Qui restano solo i conteggi che scorrendo la griglia non si
 * ricavano — chi e' fermo da troppo, chi e' appena arrivato, quanto ha venduto in dieci
 * anni.
 */
function cpNumeriChiave(n, storico, v, troncato, illeggibili, totaleFonte, passateKo) {
  if (!n) return '';
  const dich = v && v.annunciDichiarati;
  // Quattro avvisi, non quattro statistiche: dicono che quello che stai guardando potrebbe
  // non essere tutto, o non essere solo suo. Il tetto e la passata caduta sono due cose
  // diverse e vanno dette diverse: la prima sa che manca dell'altro, la seconda no.
  const avvisi = ((passateKo && passateKo.length)
      ? `<div class="cp-avviso">La passata ${escapeHtml(passateKo.map(p => p.tipo).join(' e '))} non e\' riuscita (${escapeHtml(passateKo.map(p => p.motivo).join(' · ')).slice(0, 120)}): di quella parte del parco non si sa niente, e i numeri qui sotto non la comprendono.</div>`
      : '')
    + (troncato ? '<div class="cp-avviso">Elenco troncato al tetto di sicurezza: questo parco e\' piu\' grande di quello mostrato.</div>' : '')
    + (illeggibili ? `<div class="cp-avviso">${illeggibili} annunci della vetrina non si sono lasciati leggere: i numeri qui sotto sono calcolati senza di loro.</div>` : '')
    + (n.venditori && n.venditori.length > 1
        ? `<div class="cp-avviso">Attenzione: nella risposta compaiono ${n.venditori.length} venditori diversi (${escapeHtml(n.venditori.map(x => x.nome).join(', ')).slice(0, 90)}). Il filtro della fonte non ha tenuto.</div>` : '');
  return '<div class="cp-numeri">'
    // Quanti ne abbiamo presi SUL TOTALE che la fonte dichiara: senza il secondo numero non
    // si sa se e' tutto il piazzale o la punta.
    + cpRiga('veicoli presi', cpNum(n.veicoli)
        + (totaleFonte != null && totaleFonte > n.veicoli ? ` <em>di ${cpNum(totaleFonte)} dichiarati dalla fonte</em>` : '')
        + ((n.auto || n.moto) ? ` <em>${n.auto} auto · ${n.moto} moto</em>` : '')
        + (n.nuovo ? ` <em>${cpNum(n.usato)} usati · ${cpNum(n.nuovo)} nuovi</em>` : '')
        // Non e' una statistica, e' un controllo: se la vetrina ne dichiara piu' di quanti
        // ne abbiamo presi, manca qualcosa e deve vedersi.
        + (dich ? ` <em>la vetrina ne dichiara ${cpNum(dich)}${dich !== n.veicoli ? ' — ne manca qualcuno' : ''}</em>` : ''))
    + (n.fermi ? cpRiga('fermi da oltre 6 mesi', `${n.fermi.oltre180} <em>il piu' vecchio da ${n.fermi.max} gg · su ${n.fermi.su} con la data, dato Autoscout</em>`) : '')
    + (n.nuoviArrivi ? cpRiga('arrivati di recente', `${n.nuoviArrivi.g30} <em>nell'ultimo mese · ${n.nuoviArrivi.g90} negli ultimi tre</em>`) : '')
    + (storico ? cpRiga('storico su Moto.it', `${cpNum(storico.online)} online`
        + ` <em>${cpNum(storico.pubblicati)} pubblicati in tutto${storico.dal ? ` · sulla piattaforma dal ${storico.dal}` : ''}</em>`) : '')
    + '</div>' + avvisi;
}

/**
 * UNIRE DUE VETRINE. Lo stesso concessionario sta su piu' siti — Raineri Massimo su
 * Autoscout e su Moto.it, Lucasmotorrad su Subito — ma nessuna fonte lo dice, e due nomi
 * simili non sono una prova. Quindi lo dici tu, scegliendo dall'elenco.
 */
function cpUnisciHTML(v) {
  if (v.gruppo) return '<button type="button" class="cp-btn cp-separa" title="Togli dal profilo unico">Separa</button>';
  const altre = (cpVoci || []).filter(x => cpChiave(x) !== cpChiave(v));
  if (!altre.length) return '';
  return `<select class="cp-btn cp-unisci"><option value="">Unisci a…</option>`
    + altre.map(x => `<option value="${escapeHtml(cpChiave(x))}">${escapeHtml(x.nome)} · ${escapeHtml(FONTE_LABEL[x.fonte] || x.fonte)}</option>`).join('')
    + '</select>';
}

function cpSchedaHTML(v) {
  const st = cpParchi[cpChiave(v)];
  const corpo = !st ? '<div class="cp-att">Il parco non e\' ancora stato scaricato.</div>'
    : st.stato === 'carico' ? '<div class="cp-att">Scarico il parco… su un concessionario grande ci vuole un minuto.</div>'
    : st.stato === 'ko' ? `<div class="cp-att">Non riuscito: ${escapeHtml(st.errore || 'la fonte non risponde')}</div>`
    : cpNumeriChiave(st.dati.numeri, st.dati.storico, v, st.dati.troncato, st.dati.illeggibili, st.dati.totaleFonte, st.dati.passateKo);
  const quando = st && st.stato === 'ok' && st.dati.quando
    ? `<span class="cp-quando">dati del ${new Date(st.dati.quando).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${st.dati.daCache ? ' · dalla cache' : ''}</span>` : '';
  const aperto = cpApertoId === cpChiave(v);
  const tel = (v.telefoni && v.telefoni.length ? v.telefoni : [v.telefono].filter(Boolean));
  const fatti = [
    v.valutazione ? `<span class="cp-fatto cp-voto">★ ${String(v.valutazione.media).replace('.', ',')}<em>${v.valutazione.n} recensioni</em></span>` : '',
    ...tel.slice(0, 2).map(t => `<a class="cp-fatto" href="tel:${escapeHtml(String(t).replace(/[^\d+]/g, ''))}">${escapeHtml(t)}</a>`),
    v.email ? `<a class="cp-fatto" href="mailto:${escapeHtml(v.email)}">${escapeHtml(v.email)}</a>` : '',
    v.sito ? `<a class="cp-fatto" href="${escapeHtml(v.sito)}" target="_blank" rel="noopener noreferrer">sito ↗</a>` : '',
  ].filter(Boolean).join('');
  // La riga chiusa dice chi e' e dov'e', e basta. Tutto il resto — contatti, orari,
  // servizi, descrizione, numeri — sta dentro, e ogni pezzo si richiude per conto suo.
  return `<article class="cp-scheda${v.mio ? ' cp-mio' : ''}${aperto ? ' cp-aperto' : ''}" data-cid="${escapeHtml(cpChiave(v))}">
    <details class="cp-det"${cpAperte.has(cpChiave(v)) ? ' open' : ''} data-cpdet="${escapeHtml(cpChiave(v))}">
      <summary class="cp-sum">
        <span class="cp-nome">${escapeHtml(v.nome)}</span>
        <span class="tag ${{ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[v.fonte] || ''}">${escapeHtml(FONTE_LABEL[v.fonte] || v.fonte)}</span>
        <span class="cp-dove">${escapeHtml(v.dove || v.via || '')}</span>
        ${v.mio ? '<span class="cp-tag">il tuo</span>' : ''}
      </summary>
      <div class="cp-corpo">
        <div class="cp-azioni">
          ${quando}
          ${st && st.stato === 'ok' ? `<button type="button" class="cp-btn cp-mostra${aperto ? ' attivo' : ''}">${aperto ? 'Annunci a schermo' : 'Vedi gli annunci'}</button>` : ''}
          <button type="button" class="cp-btn cp-aggiorna">${st && st.stato === 'ok' ? 'Aggiorna' : 'Scarica il parco'}</button>
          <a class="cp-btn cp-link" href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer">vetrina ↗</a>
          ${cpUnisciHTML(v)}
          <button type="button" class="cp-btn cp-togli" title="Togli dall'elenco">✕</button>
        </div>
        <div class="cp-anagrafica">
          ${v.logo ? `<img class="cp-logo" src="${escapeHtml(v.logo)}" referrerpolicy="no-referrer" alt="" loading="lazy">` : ''}
          <div class="cp-ana-testo">
            ${v.slogan ? `<div class="cp-slogan">${escapeHtml(v.slogan)}</div>` : ''}
            <div class="cp-dove">${escapeHtml([v.via, v.cap, v.dove].filter(Boolean).join(' · ')) || '&nbsp;'}</div>
            ${v.referente ? `<div class="cp-ref">${escapeHtml(v.referente.nome)}${v.referente.ruolo ? ` <em>${escapeHtml(v.referente.ruolo)}</em>` : ''}</div>` : ''}
            ${fatti ? `<div class="cp-fatti">${fatti}</div>` : ''}
          </div>
        </div>
        ${miniHTML('cp-orari:' + cpChiave(v), 'Orari', (v.orari || []).length ? `${v.orari.length} giorni` : '', cpOrariHTML(v.orari))}
        ${miniHTML('cp-serv:' + cpChiave(v), 'Servizi', (v.servizi || []).length ? String(v.servizi.length) : '',
          (v.servizi || []).length ? `<div class="cp-servizi">${v.servizi.map(s => `<span class="opt-v">${escapeHtml(s)}</span>`).join('')}</div>` : '')}
        ${miniHTML('cp-desc:' + cpChiave(v), 'Come si descrive', '', v.descrizione ? `<div class="cp-desc">${escapeHtml(v.descrizione)}</div>` : '')}
        ${corpo}
      </div>
    </details>
  </article>`;
}

/**
 * IL PROFILO UNICO: piu' vetrine, un concessionario.
 *
 * Sopra le sue vetrine sta l'unica cosa che nessuna fonte da' da sola — quanti mezzi ha
 * DAVVERO contro quanti annunci mostra. Misurato su un concessionario vero: 41 annunci
 * fra Autoscout, Subito e Moto.it, 16 veicoli.
 */
/**
 * I numeri del gruppo, con quello che MANCA scritto accanto.
 *
 * Prima era una riga sola — "N annunci sulle X vetrine" — e X erano le vetrine dell'elenco,
 * non quelle che avevano davvero risposto. Il backend sapeva gia' per ogni parte se era
 * troncata, se una passata era caduta e quante card non si erano lasciate leggere: nessuno di
 * quei campi arrivava fin qui, quindi un totale monco si presentava come il parco intero.
 */
function cpGruppoNumeriHTML(dati, voci) {
  const parti = dati.parti || [];
  const errori = dati.errori || [];
  const nomeDi = p => (p.voce && (p.voce.nome || p.voce.fonte)) || 'una vetrina';
  const guai = [];
  for (const p of parti) {
    if (p.passateKo && p.passateKo.length) guai.push(`${nomeDi(p)}: la passata ${p.passateKo.map(x => x.tipo).join(' e ')} non e' riuscita`);
    else if (p.troncato) guai.push(`${nomeDi(p)}: elenco troncato al tetto, ha piu' mezzi di quelli presi`);
    if (p.illeggibili) guai.push(`${nomeDi(p)}: ${p.illeggibili} annunci non si sono lasciati leggere`);
  }
  const coperte = parti.length;
  return '<div class="cp-numeri">'
    + cpRiga('annunci in tutto', `${cpNum((dati.veicoli || []).length)} <em>su ${coperte} ${coperte === 1 ? 'vetrina' : 'vetrine'} di ${voci.length}</em>`)
    + '</div>'
    + (errori.length ? `<div class="cp-avviso">${errori.map(e => escapeHtml(`${e.nome}: ${e.error}`)).join(' · ')}</div>` : '')
    + (guai.length ? `<div class="cp-avviso">Il totale qui sopra e' parziale — ${escapeHtml(guai.join(' · '))}.</div>` : '');
}

function cpGruppoHTML(g, voci) {
  const st = cpGruppi[g];
  const nome = (voci.find(v => v.nome) || {}).nome || 'Concessionario';
  const dove = (voci.find(v => v.dove) || {}).dove || '';
  const corpo = !st ? ''
    : st.stato === 'carico' ? '<div class="cp-att">Scarico le vetrine…</div>'
    : st.stato === 'ko' ? `<div class="cp-att">Non riuscito: ${escapeHtml(st.errore || 'la fonte non risponde')}</div>`
    : cpGruppoNumeriHTML(st.dati, voci);
  return `<section class="cp-grp" data-gid="${escapeHtml(g)}">
    <header class="cp-grp-h">
      <span class="cp-grp-nome">${escapeHtml(nome)}</span>
      <span class="cp-grp-meta">${voci.length} vetrine${dove ? ' · ' + escapeHtml(dove) : ''}</span>
      <span class="cp-grp-fonti">${voci.map(v => `<span class="tag ${{ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[v.fonte] || ''}">${escapeHtml(FONTE_LABEL[v.fonte] || v.fonte)}</span>`).join('')}</span>
      <button type="button" class="cp-btn cp-grp-scarica">${st && st.stato === 'ok' ? 'Aggiorna tutte' : 'Scarica tutte le vetrine'}</button>
      ${st && st.stato === 'ok' ? `<button type="button" class="cp-btn cp-grp-mostra${cpApertoId === 'g:' + g ? ' attivo' : ''}">Vedi tutti gli annunci</button>` : ''}
    </header>
    ${corpo}
    ${voci.map(cpSchedaHTML).join('')}
  </section>`;
}

function cpRender() {
  const el = cpEl(); if (!el) return;
  const voci = cpVoci || [];
  // Un gruppo si disegna una volta sola, dove compare la sua prima vetrina: l'ordine
  // dell'elenco resta quello che c'era, e le voci unite non saltano in fondo.
  const fatti = new Set();
  const pezzi = [];
  for (const v of [...voci.filter(x => x.mio), ...voci.filter(x => !x.mio)]) {
    if (!v.gruppo) { pezzi.push(cpSchedaHTML(v)); continue; }
    if (fatti.has(v.gruppo)) continue;
    fatti.add(v.gruppo);
    pezzi.push(cpGruppoHTML(v.gruppo, voci.filter(x => x.gruppo === v.gruppo)));
  }
  el.innerHTML = `<div class="cp-wrap">
    ${cpErrore ? `<div class="cp-avviso">${escapeHtml(cpErrore)}</div>` : ''}
    ${!voci.length ? '<div class="cp-att">Nessun concessionario ancora. Incolla il link di una vetrina — anche la tua.</div>' : ''}
    ${budgetHTML(cpRestanti, 'scarico', 'scarichi')}
    ${pezzi.join('')}
  </div>`;
}

async function cpUnisci(id, con) {
  cpErrore = null;
  try {
    const d = await fetch(`/api/competitor/${encodeURIComponent(id)}/gruppo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ con }),
    }).then(r => r.json());
    if (!d.ok) cpErrore = d.error || 'non riesco a unirle';
    else cpVoci = d.voci;
  } catch (_) { cpErrore = 'il server non risponde'; }
  cpRender();
}

async function cpScaricaGruppo(g, forza) {
  cpGruppi[g] = { stato: 'carico' };
  cpRender();
  try {
    const d = await fetch(`/api/competitor/gruppo/${encodeURIComponent(g)}/parco${forza ? '?forza=1' : ''}`).then(r => r.json());
    cpGruppi[g] = d.ok ? { stato: 'ok', dati: d } : { stato: 'ko', errore: d.error };
  } catch (_) { cpGruppi[g] = { stato: 'ko', errore: 'il server non risponde' }; }
  cpRender();
  if (cpGruppi[g].stato === 'ok') cpMostraGruppo(g);
}

function cpMostraGruppo(g) {
  const st = cpGruppi[g];
  if (!st || st.stato !== 'ok') return;
  cpApertoId = 'g:' + g;
  // Il contesto cambia: quello che descriveva la ricerca di prima non descrive questo
  // gruppo di vetrine (vedi `resetContesto`). Prima qui si azzeravano tre cose su dieci.
  resetContesto();
  currentResults = st.dati.veicoli;
  searchActive = true;
  document.body.classList.add('has-results');
  initPrezzoSlider(currentResults);
  if (!prezzoSliderInstance) renderResults(currentResults);
  cpRender();
}

async function cpAggiungi() {
  const inp = document.getElementById('cpUrl');
  const url = (inp && inp.value || '').trim();
  // Il silenzio non aiuta: come fa la gemella dei Ricambi (doRicambi), si dice cosa manca.
  if (!url) { showError('Incolla il link della vetrina di un concessionario.'); return; }
  const mio = !!(document.getElementById('cpMio') || {}).checked;
  cpErrore = null;
  // Il bottone ora sta nella barra e non viene ridisegnato: se non lo si rimette a posto
  // resta disabilitato per sempre (prima lo "riparava" il re-render del pannello).
  const btn = document.getElementById('cpAdd'); if (btn) { btn.disabled = true; btn.textContent = 'Cerco…'; }
  let nuova = null;
  try {
    const d = await fetch('/api/competitor', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, mio }) }).then(r => r.json());
    // Gia' in elenco (409): non e' un errore da mostrare, e' quel concessionario. Si apre.
    if (!d.ok && d.voce) { nuova = d.voce; inp.value = ''; }
    else if (!d.ok) cpErrore = d.error || 'non riesco ad aggiungerlo';
    else { nuova = d.voce; cpVoci = (cpVoci || []).concat([d.voce]); inp.value = ''; }
  } catch (_) { cpErrore = 'il server non risponde'; }
  if (btn) { btn.disabled = false; btn.textContent = 'Analizza'; }
  cpRender();
  // Incollare il link E' la richiesta: il parco si scarica subito. La regola "non si
  // scarica da solo" vale per l'apertura della sezione, non per chi ha appena chiesto
  // questo concessionario.
  if (nuova) cpScarica(cpChiave(nuova));
}

async function cpScarica(chiave, forza) {
  cpParchi[chiave] = { stato: 'carico' };
  cpRender();
  try {
    const d = await fetch(`/api/competitor/${encodeURIComponent(chiave)}/parco${forza ? '?forza=1' : ''}`).then(r => r.json());
    if (d.scarichiRestanti != null) cpRestanti = d.scarichiRestanti;
    else if (d.restanti != null) cpRestanti = d.restanti;
    cpParchi[chiave] = d.ok ? { stato: 'ok', dati: d } : { stato: 'ko', errore: d.error };
    // L'anagrafica puo' essere stata riletta dal server (le vetrine vecchie non avevano
    // orari, telefoni, valutazione): si prende quella, altrimenti la scheda resta magra.
    if (d.ok && d.voce) cpVoci = (cpVoci || []).map(v => (cpChiave(v) === chiave ? d.voce : v));
  } catch (_) { cpParchi[chiave] = { stato: 'ko', errore: 'il server non risponde' }; }
  cpRender();
  if (cpParchi[chiave].stato === 'ok') cpMostraParco(chiave);
}

/**
 * GLI ANNUNCI DEL PARCO NELLA GRIGLIA DELLA RICERCA, non in una lista tutta sua.
 *
 * Un parco e' un elenco di annunci, e questa app sa gia' mostrarli: foto, pannello con la
 * scheda tecnica, salvati, confronto, raggruppamenti, ordinamenti, CSV. Rifarli qui
 * dentro avrebbe voluto dire tenerne allineate due versioni per sempre.
 */
function cpMostraParco(chiave) {
  const st = cpParchi[chiave];
  if (!st || st.stato !== 'ok' || !Array.isArray(st.dati.veicoli)) return;
  cpApertoId = chiave;
  // Un parco NON e' la ricerca di prima: `resetContesto` porta via i suoi criteri, i suoi
  // filtri e le sue colonne. Porta via anche `lastSources`, ed e' voluto — un parco arriva
  // intero, non c'e' una fetta successiva da chiedere e "Carica altri" qui rimanderebbe
  // alla ricerca precedente.
  resetContesto();
  currentResults = st.dati.veicoli;
  searchActive = true;
  document.body.classList.add('has-results');
  initPrezzoSlider(currentResults);
  if (!prezzoSliderInstance) renderResults(currentResults);
  cpRender();
}

async function cpTogli(chiave) {
  try { await fetch(`/api/competitor/${encodeURIComponent(chiave)}`, { method: 'DELETE' }); } catch (_) {}
  cpVoci = (cpVoci || []).filter(v => cpChiave(v) !== chiave);
  delete cpParchi[chiave];
  // Se a schermo c'erano i SUOI annunci, vanno via con lui: restare li' vorrebbe dire
  // guardare il parco di un concessionario che non e' piu' in elenco.
  if (cpApertoId === chiave) { cpApertoId = null; hideResults(); }
  cpRender();
}

// `toggle` non risale il DOM: cattura. Serve a ricordare cosa e' aperto, perche' ogni
// scarico ridisegna il pannello e senza memoria richiuderebbe tutto sotto le mani.
document.getElementById('competitorPanel')?.addEventListener('toggle', e => {
  const d = e.target;
  if (d && d.classList && d.classList.contains('cp-det')) {
    if (d.open) cpAperte.add(d.dataset.cpdet); else cpAperte.delete(d.dataset.cpdet);
    return;
  }
  miniToggle(e, () => {});
}, true);

// Unire due vetrine: e' una tendina, quindi un `change`, non un click.
document.getElementById('competitorPanel')?.addEventListener('change', e => {
  const sel = e.target.closest('.cp-unisci'); if (!sel || !sel.value) return;
  const sch = sel.closest('.cp-scheda'); if (!sch) return;
  cpUnisci(sch.dataset.cid, sel.value);
});

document.getElementById('competitorPanel')?.addEventListener('click', e => {
  const t = e.target;
  const grp = t.closest('.cp-grp');
  if (grp && (t.closest('.cp-grp-scarica') || t.closest('.cp-grp-mostra'))) {
    const g = grp.dataset.gid;
    if (t.closest('.cp-grp-mostra')) cpMostraGruppo(g);
    else cpScaricaGruppo(g, !!cpGruppi[g]);
    return;
  }
  const sch = t.closest('.cp-scheda'); if (!sch) return;
  if (t.closest('.cp-separa')) { cpUnisci(sch.dataset.cid, null); return; }
  const id = sch.dataset.cid;
  if (t.closest('.cp-mostra')) { cpMostraParco(id); return; }
  if (t.closest('.cp-aggiorna')) { cpScarica(id, !!cpParchi[id]); return; }
  if (t.closest('.cp-togli')) { cpTogli(id); return; }
});

// ─── VERIFICA PER TARGA ───────────────────────────────────────────────────────
/**
 * Classe ambientale, CO2 e ultima revisione dal Portale dell'Automobilista.
 *
 * DOVE STA, e non e' un caso. La targa si scrive ACCANTO ALLA VERSIONE, in chiaro nella
 * barra di ricerca. Stava nei filtri avanzati — cioe' in un pannello chiuso, insieme ai
 * campi che restringono — ed era la posizione sbagliata due volte: la targa NON filtra
 * niente (e' del mezzo che stai valutando, non di quelli in vendita) e sepolta li' non la
 * trovava nessuno. Versione e targa sono i due campi che DESCRIVONO il veicolo: stanno
 * insieme, sempre visibili. Il risultato compare in ADD ON, dentro la scheda tecnica,
 * accanto alle altre integrazioni esterne — perche' e' esattamente quello: un dato che
 * viene da fuori e costa una richiesta.
 *
 * IL CAPTCHA LO RISOLVI TU. L'immagine e' quella del portale, arriva qui dentro e la
 * leggi tu: nessun tentativo di indovinarla. Il server tiene la sessione e rimanda i
 * tuoi caratteri.
 *
 * LA TARGA NON SI SALVA: non in cache, non su disco, non nei log. Serve per il veicolo
 * che hai davanti adesso, e poi non serve piu'. Per questo qui non c'e' uno storico.
 */
let targaCercata = '';   // quella scritta nei filtri, per QUESTA ricerca
let tgSfida = null;      // { id, immagine, tipi } oppure { errore }
let tgEsito = null;      // { coppie, tabelle, avvisi, nuove } oppure { errore }
let tgOccupato = false;
// Il tipo si ricorda fra un tentativo e l'altro: dopo un invio il blocco si ridisegna
// (serve un'immagine nuova) e senza questo andava riscelto. I caratteri no: cambiano sempre.
let tgTipoScelto = 'A';

function tgReset() { tgSfida = null; tgEsito = null; tgOccupato = false; }

async function tgNuovaSfida(tieniEsito) {
  tgOccupato = true;
  if (!tieniEsito) tgEsito = null;
  tgRender();
  try {
    const d = await fetch('/api/targa/sfida').then(r => r.json());
    tgSfida = d.ok ? d : { errore: d.error || 'il portale non risponde' };
  } catch (_) { tgSfida = { errore: 'server non raggiungibile' }; }
  tgOccupato = false; tgRender();
}

async function tgVerifica() {
  if (tgOccupato || !tgSfida || !tgSfida.id) return;
  // Il campo sta dentro la finestra: si legge da li', non dal documento.
  const box = document.getElementById('targaModalBody') || document;
  const el = id => box.querySelector('#' + id);
  const captcha = ((el('tgCaptcha') || {}).value || '').trim();
  tgTipoScelto = (el('tgTipo') || {}).value || 'A';
  if (!targaCercata) { toast('Scrivi la targa nel campo accanto alla versione, poi riapri la scheda'); return; }
  if (!captcha) { toast('Scrivi i caratteri dell\'immagine'); return; }
  tgOccupato = true; tgEsito = null; tgRender();
  try {
    const r = await fetch('/api/targa/verifica', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: tgSfida.id, tipo: tgTipoScelto, targa: targaCercata, captcha }),
    });
    const d = await r.json();
    tgEsito = d.ok ? d : { errore: d.error || 'non riuscito' };
  } catch (_) { tgEsito = { errore: 'server non raggiungibile' }; }
  tgOccupato = false;
  // La sfida e' bruciata: il portale ne rigenera una a ogni invio. L'esito appena letto
  // resta a schermo — azzerarlo qui lo faceva sparire nell'istante in cui arrivava.
  tgSfida = null; tgRender();
  await tgNuovaSfida(true);
}

/**
 * Il risultato, nella forma in cui il portale lo manda davvero: una riga di intestazioni
 * e una di valori. Si mostra come coppie etichetta/valore, che e' come si legge — non
 * come due elenchi in fila, dove non si sa piu' quale numero appartiene a quale voce.
 * Se le righe di valori sono piu' d'una (piu' revisioni) restano gruppi distinti.
 */
function tgEsitoHTML() {
  if (!tgEsito) return '';
  if (tgEsito.errore) return `<div class="tg-avviso">${escapeHtml(tgEsito.errore)}</div>`;
  const avvisi = (tgEsito.avvisi || []).map(a => `<div class="tg-avviso">${escapeHtml(a)}</div>`).join('');
  const coppia = (k, v) => `<div class="det-spec"><span class="det-k">${escapeHtml(k)}</span><span class="det-v">${escapeHtml(v)}</span></div>`;
  const blocchi = (tgEsito.tabelle || []).map(t => t.righe.map(r =>
    `<div class="det-specs">${t.intestazioni.map((h, i) => (r[i] ? coppia(h, r[i]) : '')).join('')}</div>`).join('')).join('');
  const sciolte = (tgEsito.coppie || []).map(([k, v]) => coppia(k, v)).join('');
  // Cio' che il portale ha aggiunto e che non e' finito in tabella: si mostra com'e'.
  const extra = (tgEsito.nuove || []).map(x => `<div class="tg-riga">${escapeHtml(x)}</div>`).join('');
  if (!avvisi && !blocchi && !sciolte && !extra) {
    return '<div class="tg-avviso">Il portale ha risposto, ma non c\'era niente da leggere. Riprova con l\'immagine nuova.</div>';
  }
  return `<div class="tg-esito">${avvisi}${blocchi}${sciolte ? `<div class="det-specs">${sciolte}</div>` : ''}${extra}</div>`;
}

/** La verifica vive in un posto solo — la sua finestra — e li' si ridisegna. */
const tgModaleAperta = () => !document.getElementById('targaModal')?.classList.contains('d-none');
function tgRender() {
  if (!tgModaleAperta()) return;
  const b = document.getElementById('targaModalBody');
  if (b) b.innerHTML = tgCorpoHTML();
}

/**
 * LA VERIFICA IN PIEDI DA SOLA. La targa e' del mezzo che hai davanti, non di un annuncio:
 * per leggerne i dati non deve servire aprire un annuncio qualunque, la sua scheda tecnica
 * e sceglierne la motorizzazione. Il bottone accanto al campo apre questa finestra, chiede
 * subito l'immagine al portale, e il risultato compare qui dentro.
 *
 * IL CAPTCHA LO RISOLVI TU: l'immagine e' quella del portale, la leggi e la scrivi. Il
 * server tiene la sessione e rimanda i tuoi caratteri — non c'e' nessun tentativo di
 * indovinarla, ne' ci sara'.
 */
function tgApriModale() {
  const t = String((document.getElementById('targaFiltro') || {}).value || '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!t) { showError('Scrivi prima la targa.'); return; }
  targaCercata = t;
  const m = document.getElementById('targaModal'); if (!m) return;
  m.classList.remove('d-none');
  tgEsito = null; tgSfida = null;
  tgRender();
  if (!tgOccupato) tgNuovaSfida();
}
function tgChiudiModale() { document.getElementById('targaModal')?.classList.add('d-none'); }

function tgCorpoHTML() {
  const s = tgSfida;
  let form;
  if (!s && tgOccupato) form = '<div class="tg-att">Chiedo l\'immagine al portale…</div>';
  else if (!s) form = '<div class="tg-att">Apri per chiedere l\'immagine al portale.</div>';
  else if (s.errore) {
    form = `<div class="tg-avviso">${escapeHtml(s.errore)}</div>`
      + '<button type="button" class="btn-ghost tg-btn" id="tgRiprova">Riprova</button>';
  } else {
    const tipi = (s.tipi || []).map(t =>
      `<option value="${escapeHtml(t.v)}"${t.v === tgTipoScelto ? ' selected' : ''}>${escapeHtml(t.t)}</option>`).join('');
    form = `<div class="tg-form">
      <select id="tgTipo" class="field-input" aria-label="tipo di veicolo">${tipi}</select>
      <div class="tg-captcha">
        <img src="${escapeHtml(s.immagine)}" alt="caratteri da leggere" width="150" height="50">
        <button type="button" class="tg-cambia" id="tgCambia" title="Cambia immagine">&#8635;</button>
      </div>
      <input type="text" id="tgCaptcha" class="field-input tg-cin" placeholder="Caratteri" maxlength="5" autocomplete="off" spellcheck="false">
      <button type="button" class="btn-cerca tg-btn" id="tgVai"${tgOccupato ? ' disabled' : ''}>${tgOccupato ? 'Cerco…' : 'Verifica'}</button>
    </div>`;
  }
  return `<div class="tg-corpo">
    <p class="tg-nota">Vuoi più dati? Faccelo sapere!</p>
    ${form}${tgEsitoHTML()}</div>`;
}

// Il blocco compare SOLO se una targa e' stata scritta nei filtri: senza, non c'e'
// niente da chiedere e un riquadro vuoto sarebbe solo ingombro.

resultsGrid?.addEventListener('click', e => {
  const omoBtn = e.target.closest('.veh-omo-btn');
  if (omoBtn) return vehOmoCarica(omoBtn.dataset.omo);
  if (e.target.closest('#tgVai')) return tgVerifica();
  if (e.target.closest('#tgCambia') || e.target.closest('#tgRiprova')) return tgNuovaSfida();
});
resultsGrid?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'tgCaptcha') { e.preventDefault(); tgVerifica(); }
});
