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
