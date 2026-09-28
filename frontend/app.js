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
const searchAlerts    = document.getElementById('searchAlerts');
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
let sliderGlobalBounds = [0, 0];
let myRole         = 'full';
// CHI SONO, non solo con che ruolo. 'demo' come id e' l'ospite anonimo della vecchia password
// condivisa; una persona registrata ha il suo. Il proprietario e' id 'owner' con ruolo 'full',
// e solo lui vede i comandi che valgono per tutta la macchina.
// I default vestono l'OSPITE, non il proprietario: se /api/me non arriva (riavvio del server,
// 502 del proxy) i comandi che il server negherebbe devono restare nascosti, non comparire.
let myId           = null;
let sonoProprietario = false;

/** Le preferenze di prezzo sono configurazione dell'account, non dati dei portali. */
let mieiPronti = false;
const MIEI_ATTESA = 800;          // una raffica di clic diventa un invio solo
const mieiTimer = {};

function mieiPreferenza(chiave, valore) {
  if (!mieiPronti) return;
  clearTimeout(mieiTimer['p:' + chiave]);
  mieiTimer['p:' + chiave] = setTimeout(() => {
    fetch(`/api/miei/preferenze/${encodeURIComponent(chiave)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ valore: String(valore == null ? '' : valore) }),
    }).catch(() => {});
  }, MIEI_ATTESA);
}

/** Scrive una preferenza nel browser E sul proprio account: un gesto solo, due posti. */
function salvaPref(chiave, valore) {
  try {
    if (valore == null || valore === '') localStorage.removeItem(chiave);
    else localStorage.setItem(chiave, String(valore));
  } catch (_) {}
  mieiPreferenza(chiave, valore);
}

/** Carica le sole preferenze consentite per questo account. */
async function mieiCarica() {
  let d = null;
  try { d = await fetch('/api/miei').then(r => (r.ok ? r.json() : null)); } catch (_) { d = null; }
  if (!d || d.guasto) {
    console.warn('[miei] le preferenze del mio account non si leggono: tengo quelle di questo dispositivo.');
    return;
  }
  const p = d.preferenze || {};
  for (const [k, v] of Object.entries(p)) { try { localStorage.setItem(k, v); } catch (_) {} }
  if (p.amr_price_v) priceCfgV = loadPriceCfg('amr_price_v');
  // Il cfg e il suo menu devono cambiare INSIEME. Quello dei veicoli e' disegnato una volta sola
  // da init(), prima che l'account risponda: lasciandolo indietro mostrerebbe zero mentre i prezzi
  // a schermo sono gia' rettificati, e `readPriceMenu` rilegge TUTTI i campi dal DOM — il primo
  // tocco su un campo riporterebbe su gli altri, cancellando dall'account (e dagli altri computer)
  // quello che ci era stato impostato.
  try {
    if (p.amr_price_v) renderPriceMenuV();
  } catch (e) { console.warn('[miei] menu prezzi non ridisegnato:', e && e.message); }
  mieiPronti = true;

  for (const k of ['amr_price_v', 'amrCarbProvincia', 'amrCarbKm', 'amrPassProvincia']) {
    if (Object.prototype.hasOwnProperty.call(p, k)) continue;   // di la' c'e' gia': ha vinto lui
    let v = null; try { v = localStorage.getItem(k); } catch (_) {}
    if (v) mieiPreferenza(k, v);
  }
}
let searchActive   = false;                     // true dopo una ricerca → la toolbar può apparire
const COMPARE_CAP  = 10;

const brandCache = { auto: null, moto: null };
const FONTE_LABEL = { subito: 'Subito.it', autoscout: 'Autoscout24', moto: 'Moto.it' };

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

// ─── Modi di ricerca ──────────────────────────────────────────────────────────
function selectPrimary(mode) {
  const primary = mode === 'moto' ? 'moto' : 'auto';
  document.querySelectorAll('#modeToggle .mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === primary));
  const radio = document.getElementById(primary === 'moto' ? 'tipoMoto' : 'tipoAuto');
  if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  try {
    localStorage.setItem('amrModoTipo', currentTipo());
  } catch (_) {}
  sincronizzaFiltriAuto(currentTipo());
  btnCerca.textContent = 'Cerca';
  modelloSelect.placeholder =
    currentTipo() === 'moto' ? 'Modello — es. MT-07 (opzionale)' : 'Modello — es. 318d (opzionale)';
}

function scaricaPdf(payload) {
  return fetch('/api/report-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async r => {
    if (r.ok) return r.blob();
    const d = await r.json().catch(() => ({}));
    throw new Error(typeof d.error === 'string' ? d.error : 'HTTP ' + r.status);
  })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: payload.nome || 'automotoradar.pdf' });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })
    .catch(e => { console.error('[pdf]', e); showError('PDF non generato: ' + e.message); });
}

// ─── Ricerca ──────────────────────────────────────────────────────────────────
let searchGen = 0;   // review: token di generazione — solo la ricerca PIÙ RECENTE applica i risultati
/**
 * "CARICA ALTRI ANNUNCI" — la fetta successiva, chiesta quando la chiedi tu.
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
const MAX_FETTE = 50;          // stesso tetto di parseSearchParams: oltre il server ripeterebbe la fetta 50
let caricandoAltri = false;
let paginaErrore = null;
let paginaRetryTimer = null;
let paginaSubitoInSospeso = null; // solo righe normalizzate della pagina nativa riuscita
let paginaFontiInSospeso = null; // porzioni complete della sola pagina da riprovare

function fontiConAltri() {
  const s = lastSources || {};
  return ['subito', 'autoscout', 'moto'].filter(f => {
    const x = s[f];
    return x && (x.status === 'ok' || x.status === 'empty') && x.hasMore === true;
  });
}
function altriDisponibili() { return fontiConAltri().length > 0; }
// Quanti ne abbiamo gia' presi da quella fonte, contando tutte le fette caricate.
function presiDa(fonte) {
  return currentResults.filter(r => r.fonte === fonte).length;
}

// Il retry conserva solo la pagina incompleta, non un archivio delle ricerche.
// Le colonne complete restano qui anche se la pausa supera il TTL della cache server.
function completaPagina(data, fonti, fetta) {
  const attesa = paginaFontiInSospeso;
  if (attesa) {
    data.risultati = attesa.risultati.concat(data.risultati);
    data.sources = { ...data.sources, ...attesa.sources };
  }
  const fallita = s => s && (s.status === 'error' || s.status === 'timeout' || s.parzialeRete
    || (s.status === 'skipped' && s.pausa?.fermo));
  if (paginaSubitoInSospeso && !fallita(data.sources.subito)) {
    const p = paginaSubitoInSospeso;
    const s = data.sources.subito;
    data.risultati = p.risultati.concat(data.risultati);
    data.sources.subito = { ...s, status: p.risultati.length ? 'ok' : s.status,
      count: p.risultati.length + (s.count || 0), totale: p.source.totale ?? s.totale,
      mainNextStart: p.source.mainNextStart,
      hasMore: p.source.mainNextStart != null || s.recuperoNextStart != null };
    paginaSubitoInSospeso = null;
  }
  const cadute = (attesa?.fonti || fonti).filter(f => fallita(data.sources[f]));
  if (cadute.length) {
    const s = data.sources.subito;
    if (!paginaSubitoInSospeso && fonti.includes('subito')
        && s?.parzialeRete && s.errori?.some(e => e.fase === 'recupero')) {
      paginaSubitoInSospeso = { risultati: data.risultati.filter(r => r.fonte === 'subito'),
        source: s, recuperoStart: s.recuperoNextStart };
    }
    const complete = Object.fromEntries(Object.entries(data.sources).filter(([, s]) =>
      (s.status === 'ok' || s.status === 'empty') && !fallita(s)));
    paginaFontiInSospeso = { fetta, fonti: attesa?.fonti || fonti, sources: complete,
      risultati: data.risultati.filter(r => complete[r.fonte]) };
    const fonte = cadute.map(f => FONTE_LABEL[f] || f).join(' e ');
    const stati = cadute.map(f => data.sources[f]);
    const errori = cadute.flatMap(f => {
      const s = data.sources[f];
      return (Array.isArray(s.errori) && s.errori.length ? s.errori
        : [{ http: s.erroreHttp, tipo: s.erroreTipo }]).map(e => ({ ...e, fonte: f }));
    });
    const bloccata = stati.find(s => s.erroreHttp === 429 || s.pausa?.fermo
      || (Array.isArray(s.errori) && s.errori.some(e => e.http === 429)));
    const troppoGrande = stati.some(s => s.erroreCodice === 'SUBITO_BODY_TOO_LARGE'
      || s.erroreCodice === 'AS24_BODY_TOO_LARGE' || s.erroreCodice === 'MOTO_BODY_TOO_LARGE');
    const definitiva = errori.some(e => e.http === 403 || e.tipo === 'auth' || e.tipo === 'error');
    const transitoria = errori.every(e => e.tipo === 'transient' || e.http >= 500)
      || stati.every(s => s.status === 'timeout');
    const riprovabile = !definitiva && (!!bloccata || transitoria);
    const fino = bloccata && Number(bloccata.pausa?.fino);
    const dopo = bloccata
      ? (Number.isSafeInteger(fino) && fino > Date.now() && fino < 8640000000000000 ? fino : Date.now() + 60000)
      : Date.now() + 15000;
    const motivo = troppoGrande ? 'risposta della fonte oltre il limite di dimensione'
      : errori.some(e => e.http === 403) ? 'accesso rifiutato dalla fonte (403)'
      : errori.some(e => e.tipo === 'auth') ? 'accesso alla fonte non valido (401)'
        : definitiva ? 'risposta della fonte non leggibile'
          : errori.some(e => e.http === 429) ? 'la fonte ha limitato le richieste (429)'
            : bloccata ? 'la fonte è ancora in pausa' : 'errore di rete temporaneo';
    const elenco = errori.filter(e => Number.isInteger(e.http)).map(e =>
      `${FONTE_LABEL[e.fonte] || e.fonte}${Number.isInteger(e.famiglia) ? ` famiglia ${e.famiglia}` : ''}: HTTP ${e.http}`).join('; ');
    paginaErrore = { testo: `${fonte}: pagina non completata (${motivo}).${elenco ? ` Errori: ${elenco}.` : ''} Nessun nuovo annuncio è stato aggiunto.${riprovabile && bloccata ? ` Riprova dal ${new Date(dopo).toLocaleString('it-IT')}.` : riprovabile ? ' Riprova fra 15 secondi.' : ''}`,
      riprovabile,
      dopo };
    renderSourceStatus(); toast(paginaErrore.testo); return false;
  }
  paginaFontiInSospeso = null;
  return true;
}

// L'identità appartiene alla fonte; il titolo (e quindi la URL) può cambiare fra clic.
// La prima copia mantiene prezzi e avvisi già mostrati, senza fondere annunci distinti.
function annunciUnici(righe) {
  const visti = new Set();
  return righe.filter(r => {
    if (!r?.url) return false;
    const id = (typeof r.id === 'string' || typeof r.id === 'number') && String(r.id).trim();
    const k = JSON.stringify([r.fonte, id ? 'id' : 'url', id || r.url]);
    if (visti.has(k)) return false;
    visti.add(k); return true;
  });
}

async function caricaAltri() {
  if (caricandoAltri || fettaPresa >= MAX_FETTE || !lastSearchParams || (paginaErrore &&
      (!paginaErrore.riprovabile || Date.now() < paginaErrore.dopo))) return;
  const fonti = paginaFontiInSospeso
    ? paginaFontiInSospeso.fonti.filter(f => !paginaFontiInSospeso.sources[f]) : fontiConAltri();
  const fetta = paginaFontiInSospeso?.fetta ?? fettaPresa + 1;
  if (!fonti.length) return;
  caricandoAltri = true; renderAltriBtn();
  const myGen = searchGen;
  try {
    const q = new URLSearchParams({ ...lastSearchParams, fetta: String(fetta), fonti: fonti.join(',') });
    const subito = lastSources?.subito;
    if (fonti.includes('subito') && subito && 'mainNextStart' in subito && 'recuperoNextStart' in subito) {
      q.set('subitoMainStart', String(paginaSubitoInSospeso ? -1 : subito.mainNextStart ?? -1));
      q.set('subitoRecuperoStart', String(paginaSubitoInSospeso
        ? paginaSubitoInSospeso.recuperoStart : subito.recuperoNextStart ?? -1));
    }
    const res = await fetch(`/api/search?${q}`);
    const data = await res.json();
    if (myGen !== searchGen) return;         // una ricerca nuova ha preso il posto
    if (!res.ok) {
      const limiteBreve = res.status === 429 && Number.isFinite(data.riprovaFra) && !data.riprovaDomani;
      paginaErrore = { testo: data.error || 'Il server non ha completato la pagina.',
        riprovabile: res.status >= 500 || limiteBreve,
        dopo: Date.now() + (limiteBreve ? data.riprovaFra * 1000 : 15000) };
      renderSourceStatus(); toast(paginaErrore.testo); return;
    }
    if (!Array.isArray(data.risultati) || !data.sources ||
        !['subito', 'autoscout', 'moto'].every(f => data.sources[f]?.status)) {
      paginaErrore = { testo: 'La risposta del server non descrive tutte le fonti: pagina non aggiunta.',
        riprovabile: false, dopo: 0 };
      renderSourceStatus(); toast(paginaErrore.testo); return;
    }
    if (!completaPagina(data, fonti, fetta)) return;
    paginaErrore = null;
    fettaPresa = fetta;
    const uniti = annunciUnici(currentResults.concat(data.risultati || []));
    const nuovi = uniti.slice(currentResults.length);
    if (!nuovi.length) {
      lastSources = fondiTotali(data.sources);
      renderSourceStatus();
      toast(altriDisponibili() ? 'Nessun annuncio nuovo in questa pagina; puoi continuare.' : 'Non ci sono altri annunci');
      return;
    }
    // IL CURSORE VA RIFATTO. Il suo BINARIO (non solo le maniglie) era calcolato sui prezzi
    // della PRIMA fetta soltanto, e renderResults filtra su quel binario: ogni annuncio nuovo
    // fuori da quella finestra spariva in silenzio, e l'utente non poteva nemmeno allargarlo.
    // Nel caso peggiore — una fonte sola, ordinata per prezzo crescente — la fetta successiva
    // e' per costruzione tutta sopra il massimo: 100 annunci scaricati, uno solo a schermo.
    const stretta = manigliePrezzoStrette();
    currentResults = currentResults.concat(nuovi);
    lastSources = fondiTotali(data.sources);
    renderSourceStatus();
    initPrezzoSlider(currentResults, stretta);
    if (!prezzoSliderInstance) renderResults(currentResults);   // niente cursore → disegna qui
    const fuori = stretta ? nuovi.filter(r => r.prezzo != null && (r.prezzo < stretta[0] || r.prezzo > stretta[1])).length : 0;
    toast([`Aggiunti ${nuovi.length} annunci`,
      fuori ? `${fuori} fuori dal filtro prezzo` : null,
    ].filter(Boolean).join(' · '));
  } catch (_) {
    if (myGen !== searchGen) return;
    paginaErrore = { testo: 'Impossibile contattare il server. La pagina è rimasta invariata.',
      riprovabile: true, dopo: Date.now() + 15000 };
    renderSourceStatus(); toast(paginaErrore.testo);
  } finally { caricandoAltri = false; renderAltriBtn(); }
}

// I conteggi per fonte devono contare TUTTE le fette, non l'ultima: il totale della
// fonte invece resta quello che dichiara lei.
function fondiTotali(nuove) {
  const out = {};
  for (const f of ['subito', 'autoscout', 'moto']) {
    const vecchia = (lastSources || {})[f] || null;
    const n = (nuove || {})[f] || null;
    if (!vecchia && !n) continue;
    // Una fetta vuota non cancella gli annunci gia' mostrati da questa fonte.
    if (vecchia && (vecchia.status === 'ok' || vecchia.status === 'empty')
        && n && (n.status === 'empty' || n.status === 'skipped')) {
      out[f] = { ...vecchia, ...(n.status === 'empty' ? n : {}),
        status: n.status === 'skipped' ? vecchia.status : presiDa(f) ? 'ok' : 'empty', count: presiDa(f),
        allargato: n.allargato || vecchia.allargato || null,
        hasMore: n.status === 'empty' ? n.hasMore ?? false : vecchia.hasMore,
        ...(f === 'subito' && n.status === 'empty'
          ? { mainNextStart: n.mainNextStart ?? null, recuperoNextStart: n.recuperoNextStart ?? null }
          : {}),
        pausa: n.pausa || vecchia.pausa };
      continue;
    }
    out[f] = { ...(vecchia || {}), ...(n || {}), count: presiDa(f),
               totale: (n && n.totale != null) ? n.totale : (vecchia && vecchia.totale),
               // L'avviso di allargamento vale per gli annunci a schermo, non per l'ultima
               // fetta: se resta anche una riga allargata, l'avviso deve restare con lei.
               allargato: (n && n.allargato) || (vecchia && vecchia.allargato) || null,
               reason: vecchia?.parzialeRete && n && !n.parzialeRete ? n.reason || null
                 : (n && n.reason) || (vecchia && vecchia.reason) || null };
  }
  return out;
}

function renderAltriBtn() {
  const el = document.getElementById('caricaAltri');
  if (!el) return;
  if (paginaRetryTimer) { clearTimeout(paginaRetryTimer); paginaRetryTimer = null; }
  const alLimite = fettaPresa >= MAX_FETTE && altriDisponibili();
  const mostra = searchActive && (alLimite || (paginaErrore ? paginaErrore.riprovabile : altriDisponibili()));
  el.classList.toggle('d-none', !mostra);
  const b = el.querySelector('button');
  if (b) {
    const attesa = paginaErrore && Date.now() < paginaErrore.dopo;
    b.disabled = caricandoAltri || !!attesa || alLimite;
    b.textContent = alLimite ? 'Limite di pagine raggiunto'
      : caricandoAltri ? 'Carico…' : paginaErrore ? 'Riprova questa pagina' : 'Carica altro';
    if (attesa) paginaRetryTimer = setTimeout(renderAltriBtn, Math.min(paginaErrore.dopo - Date.now() + 100, 2147483647));
  }
}

async function doSearch() {
  const tipo = currentTipo();
  const brand = matchedBrand();
  if (!brand) { showError('Scegli una marca dalla lista prima di cercare.'); return; }
  const marca = brand.nome;

  const modelloLibero = document.getElementById('modello').value.trim();
  const modelloScelto = selectedModel && selectedModel._marca === marca && acn(selectedModel.nome) === acn(modelloLibero);
  const scelta = sceltaVersione(versioneInput?.value, modelloScelto);
  if (scelta.errore) {
    showError(scelta.errore);
    (versioneInput?.value.trim() ? modelloSelect : versioneInput)?.focus();
    return;
  }
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
  // questa marca, manda gli ID esatti → niente fuzzy lato server.
  if (modelloScelto) {
    if (selectedModel.mmmvAutoscout) params.mmmvAutoscout = selectedModel.mmmvAutoscout;
    const motoSlug = selectedModel._familySlug || selectedModel.slugMotoIt;   // famiglia risolta (Lazy-T2) o slug diretto
    if (motoSlug) params.motoitModelSlug = motoSlug;
  }
  // Una versione specifica passa com'e' stata scritta: Subito la mette in `q=`,
  // AutoScout24 nel campo testuale nativo e Moto.it prova a tradurla nel suo catalogo.
  // «Nessuna Versione» non deve diventare una parola nella richiesta alle fonti.
  if (scelta.versione) params.versione = scelta.versione;
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

    searchActive = true;
    // La ricerca e' andata: la pagina smette di vestirsi da schermo vuoto (barra compatta,
    // niente sfondo). Anche a zero risultati — perche' a quel punto la risposta e' il pannello
    // "nessun annuncio", non la schermata di partenza.
    document.body.classList.add('has-results');
    fettaPresa = 0;                      // ricerca nuova: si riparte dalla prima fetta
    paginaErrore = null;
    paginaSubitoInSospeso = null;
    paginaFontiInSospeso = null;
    lastSources = data.sources || null;
    let pubblicabile = true;
    if (Object.values(data.sources || {}).some(s => s?.parzialeRete)) {
      const fonti = ['subito', 'autoscout', 'moto'].filter(f => data.sources[f]
        && (data.sources[f].status !== 'skipped' || data.sources[f].pausa?.fermo));
      pubblicabile = completaPagina(data, fonti, 0);
    }
    if (pubblicabile) currentResults = annunciUnici(data.risultati || []);
    for (const [f, stato] of Object.entries(lastSources || {})) stato.count = presiDa(f);
    renderSourceStatus();


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
    ? `${tolti} annunci dichiarano una versione diversa: li stai vedendo. `
    : `Nascosti ${tolti} annunci che dichiarano una versione diversa da quella cercata. `;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'avviso-versione-btn';
  b.textContent = mostraVersioniSmentite ? 'nascondili' : 'mostrali';
  b.addEventListener('click', () => { mostraVersioniSmentite = !mostraVersioniSmentite; renderResults(currentResults); });
  el.appendChild(b);
}

function renderResults(results) {
  nascondiAvvisi(true); // le righe vengono ricreate: il pulsante aperto non esiste piu'
  // Nessuna ricerca attiva: niente toolbar/risultati.
  // La toolbar appare solo dopo una ricerca vera.
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
      testo.textContent = altriDisponibili() ? 'Nessun annuncio in questa pagina.' : 'Nessun risultato trovato.';
      if (nota) nota.textContent = altriDisponibili()
        ? 'La fonte ha altre pagine: puoi continuare la ricerca qui sotto.'
        : 'Prova a modificare i filtri o selezionare una regione più ampia.';
    }
    noResults.classList.remove('d-none'); resultsSection.classList.add('d-none');
    renderAltriBtn();
    return;
  }
  noResults.classList.add('d-none'); resultsSection.classList.remove('d-none');
  resultsCount.textContent = `${sorted.length} risultati`;

  // Lista o schede: cambia solo COME si disegna la stessa fetta di annunci. Il resto
  // (raggruppamento, ordinamento, pannello dell'annuncio, confronto) e' identico
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
  const myGen = searchGen;
  try {
    const j = await fetch(`/api/detail?url=${encodeURIComponent(url)}`).then(x => x.json());
    if (myGen !== searchGen || !currentResults.includes(r)) return;
    segnalaPausaDettaglio(j);
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
  if (myGen === searchGen && currentResults.includes(r)) updateRowThumb(url);
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
 * versione». Una funzione sola evita verdetti diversi nello stesso elenco.
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
  'senza-modello':  { et: 'modello non dichiarato', cl: 'med', tit: 'Il venditore non ha indicato il modello: riconosciuto dal titolo, non dal catalogo.' },
  'altro-modello':  { et: 'altro modello', cl: 'ko',  tit: 'Questa fonte non ha il modello cercato: la ricerca si e\' allargata alla marca e questo e\' un modello diverso.' },
  // Diverso da "versione n.d.": li' e' il venditore a non averla scritta, qui siamo noi
  // a non aver potuto controllare. Su Autoscout la versione e' testo libero, e certe
  // versioni ("320 2 porte") non lasciano un testo da confrontare — la carrozzeria li'
  // sta in un campo numerico. Dirlo "esatto" sarebbe una corrispondenza mai guardata.
  'versione-non-verificata': { et: 'versione non verificata', cl: 'med', tit: 'Il modello e\' quello giusto, ma la versione cercata non si e\' potuta confrontare: potrebbe essere un altro allestimento.' },
};

function corrispondenzaDi(r) {
  if (r.versioneEsito === 'smentita') return { et: 'non e\' quella versione', cl: 'ko' };
  const d = DICHIARAZIONE[r.dichiarazione];
  if (r.versioneEsito === 'ignota' && !['altro-modello', 'senza-modello'].includes(r.dichiarazione))
    return DICHIARAZIONE['versione-non-verificata'];
  return d || { et: 'corrisponde' };
}

/** Gli avvisi della riga si raccolgono in un solo pulsante, separato dal titolo cliccabile. */
function avvisiAnnuncio(item) {
  const out = [];
  if (item.dichiarazione === 'altro-modello')
    out.push({ tipo: 'critico', titolo: 'Altro modello', testo: 'La fonte dichiara un modello diverso da quello cercato.' });
  if (item.dichiarazione === 'senza-modello')
    out.push({ tipo: 'attenzione', titolo: 'Modello non dichiarato', testo: 'Riconosciuto dal titolo, non dal catalogo della fonte.' });
  if (item.versioneEsito === 'smentita')
    out.push({ tipo: 'critico', titolo: 'Versione diversa', testo: 'L’annuncio dichiara una versione diversa da quella cercata.' });
  else if (item.versioneEsito === 'ignota' || item.dichiarazione === 'versione-non-verificata')
    out.push({ tipo: 'attenzione', titolo: 'Versione non verificata', testo: 'I dati dell’annuncio non permettono di confermare la versione cercata.' });
  return out;
}

function avvisiPulsanteHTML(item) {
  const avvisi = avvisiAnnuncio(item);
  if (!avvisi.length) return '';
  const critico = avvisi.some(a => a.tipo === 'critico') ? ' critico' : '';
  return `<button type="button" class="row-act btn-avvisi${critico}" aria-label="Avvisi sull'annuncio: ${avvisi.length}" aria-expanded="false">${icon('alert')}</button>`;
}

let avvisiAperto = null, avvisiFisso = false;
function nascondiAvvisi(forza = false) {
  if (avvisiFisso && !forza) return;
  const pop = document.getElementById('avvisiAnnuncioPopup');
  if (pop) pop.hidden = true;
  if (avvisiAperto) {
    avvisiAperto.setAttribute('aria-expanded', 'false');
    avvisiAperto.removeAttribute('aria-describedby');
  }
  avvisiAperto = null; avvisiFisso = false;
}
function mostraAvvisi(btn, fisso = false) {
  if (avvisiFisso && avvisiAperto === btn && !fisso) return;
  if (avvisiFisso && avvisiAperto !== btn && !fisso) return;
  const item = trovaResult(btn.closest('[data-url]')?.dataset.url);
  const avvisi = item && avvisiAnnuncio(item);
  if (!avvisi?.length) return;
  let pop = document.getElementById('avvisiAnnuncioPopup');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'avvisiAnnuncioPopup'; pop.className = 'ann-avvisi-pop'; pop.setAttribute('role', 'tooltip');
    document.body.appendChild(pop); // fuori dalla scheda e dalla lista: entrambe tagliano l'overflow
  }
  if (avvisiAperto && avvisiAperto !== btn) nascondiAvvisi(true);
  pop.innerHTML = `<strong>Avvisi sull'annuncio</strong>${avvisi.map(a =>
    `<div class="ann-avviso ann-avviso-${a.tipo}"><b>${escapeHtml(a.titolo)}</b><span>${escapeHtml(a.testo)}</span></div>`).join('')}`;
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${r.top > pop.offsetHeight + 12 ? r.top - pop.offsetHeight - 6 : r.bottom + 6}px`;
  btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-describedby', pop.id);
  avvisiAperto = btn; avvisiFisso = fisso;
}
function alternaAvvisi(btn) {
  if (avvisiAperto === btn && avvisiFisso) nascondiAvvisi(true);
  else mostraAvvisi(btn, true);
}

function rowHTML(item, bestSet) {
  const pr = vPricing(item.prezzo, passDi(item), item);
  // "su richiesta" non e' "n/d": il venditore il prezzo ce l'ha, ha scelto di non scriverlo.
  const prezzoStr = pr ? eurRound(pr.finale) : (item.prezzoSuRichiesta ? 'su richiesta' : 'n/d');
  const fonteLabel = FONTE_LABEL[item.fonte] || item.fonte;
  const fonteTag = { subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || '';
  const urlSafe = /^https?:\/\//i.test(item.url) ? escapeHtml(item.url) : '#';
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
  const avvisiBtn = avvisiPulsanteHTML(item);
  const sub = [item.provincia ? escapeHtml(item.provincia) : '', vendBadge].filter(Boolean).join(' ');
  const ggV = giorniInVendita(item);
  const subM = [item.anno || null, item.km != null ? `${item.km.toLocaleString('it-IT')} km` : null, item.carburante || null, item.potenzaCv != null ? `${item.potenzaCv} CV` : null, ggV != null ? `in vendita da ${ggV} gg` : null, fonteLabel].filter(Boolean).join(' · ');

  const cell = key => {
    switch (key) {
      case 'foto':    return thumbHTML;
      case 'veicolo': return `<div class="row-main">
          <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}</div>
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
      case 'azioni': return `<div class="row-actions${avvisiBtn ? ' has-alerts' : ''}">
          ${avvisiBtn}
          <button class="row-act btn-info" title="Dettagli e foto">${icon('info')}</button>
          <button class="row-act btn-confronta${inConfronto ? ' attivo' : ''}" title="Aggiungi al confronto">${icon(inConfronto ? 'square-check' : 'square')}</button>
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
   * cosi' lightbox, pannello annuncio e confronto funzionano senza sapere che
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
  const inConfronto = confronto.some(r => stessoAnnuncio(r, item));
  const avvisiBtn = avvisiPulsanteHTML(item);
  return `<article class="ann-card${bestSet && bestSet.has(item.url) ? ' best' : ''}${inConfronto ? ' selected' : ''}" data-url="${urlSafe}">
      <div class="ann-foto">${foto}</div>
      <div class="ann-corpo">
        <div class="row-titolo" title="Apri annuncio">${escapeHtml(item.titolo)}</div>
        ${item.variante ? `<div class="ann-variante">${escapeHtml(item.variante)}</div>` : ''}
        <div class="ann-meta">${escapeHtml(meta) || '&nbsp;'}</div>
        <div class="ann-riga">
          <span class="tag ${{ subito: 'tag-subito', autoscout: 'tag-autoscout', moto: 'tag-moto' }[item.fonte] || ''}">${escapeHtml(FONTE_LABEL[item.fonte] || item.fonte)}</span>
          ${item.provincia ? `<span class="ann-dove">${escapeHtml(item.provincia)}</span>` : ''}
          ${item.venditore ? `<span class="vend-badge vend-${conc ? 'conc' : 'priv'}">${conc ? 'Conc.' : 'Privato'}</span>` : ''}
        </div>
        <div class="ann-piede">
          <span class="ann-prezzo">${pr ? eurRound(pr.finale) : (item.prezzoSuRichiesta ? 'su richiesta' : 'n/d')}</span>
          <div class="row-actions${avvisiBtn ? ' has-alerts' : ''}">
            ${avvisiBtn}
            <button class="row-act btn-info" title="Dettagli e foto">${icon('info')}</button>
            <button class="row-act btn-confronta${inConfronto ? ' attivo' : ''}" title="Aggiungi al confronto">${icon(inConfronto ? 'square-check' : 'square')}</button>
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
  const dich = corrispondenzaDi(r);
  const dett = r.versioneEsito === 'ignota' || r.versioneEsito === 'smentita' || DICHIARAZIONE[r.dichiarazione]
    ? [['Corrispondenza', dich.et]] : [];
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
  if (r.fonte === 'autoscout' && r.venditore !== 'concessionario') return '';
  const d = (r.descrizione || '').trim();
  if (!d) return '';
  return miniHTML('testo:' + r.url, 'Testo dell\'annuncio', d.length + ' caratteri',
    `<div class="det-testo">${escapeHtml(d)}</div>`);
}

function vetrinaHTML(r) {
  return r.vetrinaUrl
    ? `<a class="det-open" href="${escapeHtml(r.vetrinaUrl)}" target="_blank" rel="noopener noreferrer">Vetrina venditore ↗</a>`
    : '';
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
    salvaPref('amrPassProvincia', eredita);
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
  const marca = p.marca || (r && r.marca) || '';
  // Il MODELLO invece lo dice l'annuncio: chiedere le misure del modello CERCATO sotto un
  // annuncio marcato "altro modello" significa mostrare i dati di un altro veicolo. Il
  // modello della ricerca vale solo quando la fonte ha confermato che l'annuncio e' quello,
  // ed e' la stessa regola che usa `loadVehScheda`.
  const confermato = !r || !r.dichiarazione || ['esatto', 'senza-versione', 'versione-non-verificata'].includes(r.dichiarazione);
  const modello = modelloAnnuncio(r) || (confermato ? p.modello : '') || '';
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
    // ZERO MISURE HA DUE CAUSE, E NON SI DICONO CON LA STESSA FRASE. Lo scraper accende
    // `sospetto` quando la pagina ha le generazioni ma nessuna riga leggibile: li' e' il NOSTRO
    // parser a non sapere piu' leggere la tabella, e la frase qui sotto affermerebbe un fatto sul
    // veicolo partendo da un guasto nostro. Un modello che Wheel-Size non ha risponde 404 e
    // finisce nel ramo `ko`: un vuoto con `sospetto` non e' mai «questo mezzo non ha calzate».
    if (d.sospetto) return `<div class="gom-att">Misure non leggibili adesso: ${escapeHtml(d.sospetto)}.</div>`;
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
    const inConf = confronto.some(x => stessoAnnuncio(x, r));
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
      + `<div class="det-foot">${openBtn}${confBtn}</div></div>`;
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
  error: { cls: 'src-bad', txt: 'errore' },
};
// La chiave e' il `reason` che arriva dal server, uguale identico. 'in pausa dopo un blocco'
// lo scrive backend/fonti-salute.js quando la fonte ci ha respinti due volte di fila: non e'
// un guasto nostro e non e' "non disponibile", e' una scelta di non insistere per un po'.
const SKIP_REASON_TXT = { 'solo moto': 'solo moto', 'marca non su Moto.it': 'non disponibile', 'marca non su Autoscout': 'non disponibile', 'in pausa dopo un blocco': 'in pausa' };
let searchAlertTexts = [];
function positionSearchAlertMenu() {
  const menu = searchAlerts?.querySelector('.search-alerts-menu');
  if (!searchAlerts?.open || !menu) return;
  menu.style.transform = '';
  const box = menu.getBoundingClientRect();
  const dx = box.left < 8 ? 8 - box.left : box.right > window.innerWidth - 8 ? window.innerWidth - 8 - box.right : 0;
  menu.style.transform = `translateX(${dx}px)`;
}
function renderSearchAlerts(avvisi) {
  const uguali = avvisi.length === searchAlertTexts.length && avvisi.every((v, i) => v === searchAlertTexts[i]);
  searchAlertTexts = avvisi;
  if (!searchAlerts) return;
  searchAlerts.classList.toggle('d-none', !avvisi.length);
  if (!avvisi.length) { searchAlerts.open = false; searchAlerts.innerHTML = ''; return; }
  if (uguali && searchAlerts.innerHTML) return; // preserva il fuoco mentre un dettaglio si aggiorna
  searchAlerts.innerHTML = `<summary class="tb-btn btn-avvisi" aria-label="Avvisi sulla ricerca: ${avvisi.length}">${icon('alert')} Avvisi sulla ricerca (${avvisi.length})</summary>`
    + `<div class="search-alerts-menu">${avvisi.map((testo, i) => `<div class="search-alert-item"><span>${escapeHtml(testo)}</span><button type="button" class="tb-btn" data-search-alert="${i}" aria-label="Segnala l'avviso ${i + 1} all'assistenza">Segnala</button></div>`).join('')}</div>`;
  if (searchAlerts.open) requestAnimationFrame(positionSearchAlertMenu);
}
function renderSourceStatus() {
  if (!fonteBreakdown) return;
  if (!lastSources) { fonteBreakdown.innerHTML = ''; renderSearchAlerts([]); return; }
  const avvisi = [];
  const aggiungi = testo => { if (testo) avvisi.push(testo); };
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
    else if (s.status === 'skipped') txt = escapeHtml(SKIP_REASON_TXT[s.reason] || s.reason || 'saltato');
    else txt = meta.txt || s.status;
    const dim = s.status === 'ok' ? '' : ' src-dim';
    const totaleIgnoto = f === 'subito' && (s.status === 'ok' || s.status === 'empty') && s.totale == null
      ? ' <span class="src-total-ignoto" tabindex="0" role="img" aria-label="Totale annunci non comunicato da Subito" data-tip="Totale annunci non comunicato da Subito">?</span>'
      : '';
    return `<span class="src ${meta.cls}${dim}">${FONTE_LABEL[f]} <b>${txt}</b>${totaleIgnoto}</span>`;
  }).join('');
  // L'AVVISO DI ALLARGAMENTO. `reason` veniva stampata solo per le fonti 'skipped', ma la frase
  // "nessun X su Autoscout: mostro Y" nasce a status 'ok' — quindi non compariva mai, e si
  // leggevano annunci di un altro modello (o di un altro allestimento) senza nessun segnale.
  // Riga propria sotto le pill, come `.veh-liq-avviso` per la liquidita'.
  const as = lastSources.autoscout;
  if (as && as.allargato && as.reason) {
    aggiungi(as.reason);
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
    aggiungi(fontePausaTesto(FONTE_LABEL[f], s?.pausa)
      || (s?.erroreDettaglio ? `Dettagli ${FONTE_LABEL[f]}: ${s.erroreDettaglio}` : ''));
    if (s && (s.status === 'ok' || s.status === 'error' || s.status === 'empty') && s.parziale && !(f === 'autoscout' && s.allargato)) {
      aggiungi(String(s.parziale));
    }
    if (f === 'subito' && s?.erroreCodice === 'SUBITO_BODY_TOO_LARGE' && !s.parziale) {
      aggiungi('Subito ha inviato una risposta oltre il limite di dimensione. La richiesta è stata interrotta: gli annunci di questa pagina non sono stati letti.');
    }
    if (f === 'moto' && s?.erroreCodice === 'MOTO_BODY_TOO_LARGE' && !s.parziale) {
      aggiungi('Moto.it ha inviato una risposta oltre il limite di dimensione. La richiesta è stata interrotta: gli annunci di questa pagina non sono stati letti.');
    }
    if (f === 'moto' && (s?.status === 'error' || s?.status === 'timeout') && !s.parziale
        && !s.pausa?.fermo && s.erroreCodice !== 'MOTO_BODY_TOO_LARGE') {
      const motivo = s.erroreHttp === 401 ? 'autenticazione rifiutata dalla fonte'
        : s.erroreHttp === 403 || s.erroreHttp === 429 ? `richieste respinte (HTTP ${s.erroreHttp})`
        : s.erroreTipo === 'transient' || s.status === 'timeout' ? 'errore di rete o risposta temporaneamente non disponibile'
        : 'risposta non leggibile';
      aggiungi(`Moto.it: ${motivo}. Gli annunci di questa pagina non sono stati letti.`);
    }
    if (f === 'autoscout' && (s?.status === 'error' || s?.status === 'timeout') && !s.parziale && !s.pausa?.fermo) {
      const motivo = s.erroreCodice === 'AS24_BODY_TOO_LARGE' ? 'risposta oltre il limite di dimensione'
        : s.erroreHttp === 401 ? 'autenticazione rifiutata dalla fonte'
        : s.erroreHttp === 403 || s.erroreHttp === 429 ? `richieste respinte (HTTP ${s.erroreHttp})`
        : s.erroreTipo === 'transient' ? 'errore di rete o risposta temporaneamente non disponibile'
        : 'risposta non leggibile';
      aggiungi(`AutoScout24: ${motivo}. Gli annunci di questa pagina non sono stati letti.`);
    }
    if (f === 'subito' && Array.isArray(s?.errori) && s.errori.length) {
      const righe = s.errori.map(e => {
        const dove = Number.isInteger(e.famiglia) ? `Famiglia ${e.famiglia}` : 'Ricerca';
        const fase = e.fase === 'recupero' ? 'recupero annunci senza modello'
          : Number.isInteger(e.pagina) ? `pagina ${e.pagina}` : 'pagina';
        const esito = e.codice === 'SUBITO_BODY_TOO_LARGE' ? 'risposta oltre il limite di dimensione'
          : Number.isInteger(e.http) ? `HTTP ${e.http}`
          : e.tipo === 'transient' ? 'errore di rete' : 'risposta non leggibile';
        return `${dove}: ${fase} — ${esito}`;
      }).join('; ');
      aggiungi(`Subito: errori delle richieste — ${righe}`);
    }
  }
  // La pagina fallita non entra nella lista: il motivo resta visibile qui e sul pulsante.
  if (paginaErrore) aggiungi(`${paginaErrore.testo}${paginaErrore.riprovabile ? ' Potrai riprovare questa pagina dal pulsante qui sotto.' : ' Per riprendere, avvia una nuova ricerca.'}`);
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
    aggiungi('Ricerca pari alla ricerca a testo libero di Subito. Vuoi gestire le tue ricerche in modo diverso? Parliamone!');
  }
  /**
   * L'ALLESTIMENTO CERCATO DENTRO LA SUA FAMIGLIA, e chi guarda deve saperlo. Il catalogo
   * di Subito si ferma alla famiglia: una «Mercedes A 190» la si chiede come «Classe A»
   * col nome scritto per restringere. E' molto meglio di cercare tutta la Mercedes — che
   * e' quel che succedeva — ma non e' la stessa cosa di un id esatto, e presentarla come
   * tale sarebbe far passare per precisa una ricerca che precisa non e'.
   */
  if (sb && sb.come === 'allestimento' && sb.status === 'ok' && sb.count > 0) {
    aggiungi(`Su Subito questo modello è un allestimento: la ricerca parte dalla famiglia${sb.famigliaNome ? ' «' + sb.famigliaNome + '»' : ''} e si restringe col nome.`);
  }
  /**
   * LA MARCA OSPITE, e chi guarda deve saperlo. Su Subito «Vespa» non esiste come marca:
   * le sue famiglie vivono sotto PIAGGIO, e il ponte degli ospiti (subito-nodo) ce le fa
   * trovare per id. E' la ricerca giusta — prima era testo libero puro — ma la marca a
   * schermo non e' quella digitata, e tacerlo farebbe passare il passaggio per magia.
   */
  if (sb && /^ospite \(/.test(String(sb.come || '')) && sb.status === 'ok' && sb.count > 0) {
    aggiungi(`Su Subito questa marca vive sotto un'altra (${String(sb.come).slice(8, -1)})${sb.famigliaNome ? ': si cerca la famiglia «' + sb.famigliaNome + '»' : ''}.`);
  }
  const mo = lastSources.moto;
  if (mo?.modelloKoRete) {
    aggiungi('Moto.it: il catalogo modelli non è stato letto correttamente. La ricerca è stata allargata alla marca e filtrata sui titoli; riprova per verificare il modello.');
  }
  // Il menu versioni di Moto.it che non ha risposto: il filtro non e' stato applicato (o lo e'
  // stato su un elenco monco), e finora la colonna si presentava filtrata come le altre.
  if (mo && mo.versioneElencoMonco) {
    aggiungi(String(mo.versioneElencoMonco));
  }
  if (mo && mo.versioneIgnorata && mo.versioneIgnorata.length) {
    const p = mo.versioneIgnorata;
    aggiungi(`Moto.it non ha ${p.length === 1 ? 'la parola' : 'le parole'} “${p.join('”, “')}” nel suo catalogo versioni: quella parte del filtro non è stata applicata.`);
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
    aggiungi(`Subito filtra i km a fasce: possono arrivare annunci ${pezzi.join(' e ')} km`);
  }
  renderSearchAlerts(avvisi);
}
function fontePausaHTML(nome, pausa) {
  const testo = fontePausaTesto(nome, pausa);
  return testo ? `<div class="src-avviso">${escapeHtml(testo)}</div>` : '';
}

function fontePausaTesto(nome, pausa) {
  if (!pausa) return '';
  const ora = new Date();
  const fine = Number.isFinite(pausa.fino) && pausa.fino > 0 ? new Date(pausa.fino) : null;
  const valida = fine && Number.isFinite(fine.getTime());
  let testo;
  if (pausa.verifica === true && pausa.fermo === true) {
    testo = `Verifica della disponibilità di ${nome} in corso.`;
  } else if (pausa.verifica === true || (valida && fine <= ora)) {
    testo = `Pausa terminata: la prossima richiesta verificherà se ${nome} è nuovamente disponibile.`;
  } else if (pausa.fermo === true) {
    const quando = valida
      ? fine.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
        + (fine.toDateString() !== ora.toDateString() ? ` del ${fine.toLocaleDateString('it-IT')}` : '')
      : null;
    testo = `Fonte ${nome}: richieste sospese. ` + (quando ? `Potrai riprovare dalle ${quando}; la` : 'La')
      + ' disponibilità sarà verificata alla prossima richiesta.';
  } else return '';
  return testo;
}

// Al massimo un avviso per fonte/stato nel contesto corrente, anche fra dettaglio e confronto.
const avvisiPausaDettaglio = new Map();
function segnalaPausaDettaglio(data) {
  if (typeof data?.ok !== 'boolean' || !data.pausa || !['subito', 'autoscout', 'moto'].includes(data.fonte)) return;
  const f = data.fonte;
  const errore = data.ok ? null : data.error || 'Dettaglio temporaneamente non disponibile.';
  if (lastSources) {
    lastSources[f] = { status: 'error', ...lastSources[f], pausa: data.pausa, erroreDettaglio: errore };
    renderSourceStatus();
  } else {
    const testo = fontePausaTesto(FONTE_LABEL[f], data.pausa) || (errore ? `Dettagli ${FONTE_LABEL[f]}: ${errore}` : '');
    if (!testo) return;
    const stato = JSON.stringify([searchGen, data.pausa.fermo, data.pausa.fino, data.pausa.verifica]);
    if (avvisiPausaDettaglio.get(f) === stato) return;
    avvisiPausaDettaglio.set(f, stato);
    // toast usa textContent: il testo della fonte non diventa HTML.
    toast(testo);
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
 * Le fonti che un'identita' stabile la dichiarano la mettono in `id`; le altre restano
 * sull'URL. Serve al confronto per riconoscere la stessa riga anche dopo un ridisegno.
 */
const stessoAnnuncio = (a, b) => {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  return a.url === b.url;
};
/** L'annuncio con questo URL, fra quelli che l'app ha in mano adesso. */
function trovaResult(url) {
  return currentResults.find(r => r.url === url) || confronto.find(r => r.url === url) || null;
}
// Aggiorna SOLO i bottoni/stato di un URL (riga + pannello dettaglio) senza re-render
// totale → non collassa il dettaglio aperto né perde lo scroll (flusso mobile).
function refreshRowState(url) {
  const rif = trovaResult(url);
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
  refreshRowState(url); renderCompareBar();
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
  if (i !== -1) { confronto.splice(i, 1); refreshRowState(url); renderCompareBar(); }
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
  { key: 'dichiarazione', label: 'Corrispondenza', fmt: (v, r) => corrispondenzaDi(r).et },
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
  const myGen = searchGen;
  await Promise.all(targets.map(async r => {
    if (r._detailLoaded || r._detailInFlight || Date.now() < (r._detailRetryAt || 0)) return;
    r._detailInFlight = true;
    r._detailRetryAt = Date.now() + 30000;
    try {
      const j = await fetch(`/api/detail?url=${encodeURIComponent(r.url)}`).then(x => x.json());
      if (myGen !== searchGen || !matrixList.includes(r)) return;
      segnalaPausaDettaglio(j);
      if (j.ok && j.detail) {
        const utili = Object.entries(j.detail).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length));
        for (const [k, v] of utili) if (r[k] == null) r[k] = v;
        if (utili.length) r._detailLoaded = true;
        // Un vuoto best-effort sul server dura 15 minuti: un render non deve
        // martellare quella cache ne' segnare la riga completata per sempre.
        else r._detailRetryAt = Date.now() + 15 * 60 * 1000;
      }
    } catch (_) {
      r._detailRetryAt = Date.now() + 30000;
    } finally { delete r._detailInFlight; }
  }));
  if (myGen === searchGen && matrixList === list && !cmatrixPanel.classList.contains('d-none')) renderMatrix();
}

// ─── Segnalazioni (bug-report) ───────────────────────────────────────────────
function openReport(avviso = '') {
  const m = document.getElementById('reportModal'); if (!m) return;
  document.getElementById('reportMsg').value = avviso ? `Avviso sulla ricerca: ${avviso}\n` : '';
  document.getElementById('reportStatus').textContent = '';
  const att = document.getElementById('reportAttach');
  // "Allega i dati della ricerca" esiste se una RICERCA c'e' stata. `searchActive` e' vero
  // anche nel parco di un concessionario, dove i criteri non esistono: la spunta si offriva
  // e allegava il nulla (o, prima del reset, i criteri di tutt'altro).
  if (att) { att.checked = !!avviso && !!lastSearchParams; att.parentElement.style.display = lastSearchParams ? '' : 'none'; }
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
// timer per-elemento (memorizzato su el._tipTimer): caricamenti concorrenti dei veicoli
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
  if (!errorVisible) statusBox.classList.add('d-none');
}
function showError(msg) { statusBox.classList.remove('d-none'); loadingState.classList.add('d-none'); errorState.classList.remove('d-none'); errorText.textContent = msg; }
function hideError() { errorState.classList.add('d-none'); statusBox.classList.add('d-none'); }
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
  renderSearchAlerts([]);
  fettaPresa = 0;
  paginaErrore = null;
  paginaSubitoInSospeso = null;
  paginaFontiInSospeso = null;
  if (paginaRetryTimer) { clearTimeout(paginaRetryTimer); paginaRetryTimer = null; }
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
