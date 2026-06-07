/**
 * §11 — Ricerche salvate + motore avvisi FILTRATO (anti-rumore).
 *
 * Persistenza: <USER_DATA_PATH>/saved-searches.json (Electron) o data/ (dev),
 * stesso pattern di subito-session. Solo logica dati + calcolo avvisi: il fetch
 * (runSearch) e l'analisi (analyzeResults) li orchestra server.js, che passa qui
 * risultati GIÀ analizzati (con _flags/_score).
 *
 * Avvisi con CONDIZIONI (requisito utente: niente "scam da 500€"):
 *  - esclude flag `sospetto` / `dato_mancante`
 *  - floor anti-scam assoluto/relativo (anche senza comparabili sufficienti)
 *  - NUOVO (url mai visto) · CALO (>= soglia) · AFFARE (flag affare)
 *  - coda persistente + set `alerted` per non ri-notificare lo stesso motivo
 */
const fs   = require('fs');
const path = require('path');

const FILE = 'saved-searches.json';

// ─── Soglie tarabili ──────────────────────────────────────────────────────────
const FLOOR_ABS   = 300;    // € — sotto è scam/errore a prescindere dai comparabili
const FLOOR_PCT   = 0.40;   // … oppure < 40% del prezzo minimo della ricerca
const DROP_ABS    = 200;    // € — calo minimo per notificare
const DROP_PCT    = 0.03;   // … oppure 3%
const SEEN_CAP    = 800;    // max URL ricordati per ricerca (prune FIFO)
const ALERTED_CAP = 500;    // max chiavi anti-ripetizione

function filePath() {
  const userData = process.env.USER_DATA_PATH;
  if (userData && fs.existsSync(userData)) return path.join(userData, FILE);
  return path.join(__dirname, '..', 'data', FILE);
}

function loadAll() {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function saveAll(list) {
  const p = filePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, p);   // scrittura atomica
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Etichetta leggibile dai params se non fornita.
function defaultLabel(params) {
  return [params.marca, params.modello].filter(Boolean).join(' ').trim()
      || `${params.tipo || 'ricerca'}`;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────
function listSaved() {
  // non esporre seen/alerted (pesanti) nella lista UI; include il digest e gli
  // avvisi non letti (piccoli) per la resa.
  return loadAll().map(s => {
    const unread = (s.alerts || []).filter(a => !a.letto);
    const digest = unread.reduce((d, a) => { d[a.motivo] = (d[a.motivo] || 0) + 1; return d; }, {});
    return {
      id: s.id, label: s.label, params: s.params, createdAt: s.createdAt,
      lastChecked: s.lastChecked || null,
      novita: unread.length,
      digest,
      alerts: unread.slice(-30).reverse(),   // più recenti in cima
    };
  });
}

function addSaved({ label, params }) {
  const list = loadAll();
  const s = {
    id: newId(),
    label: (label && String(label).trim()) || defaultLabel(params),
    params,
    createdAt: Date.now(),
    lastChecked: null,
    seen: {},          // url → ultimo prezzo visto
    alerted: [],        // chiavi "url|motivo[|prezzo]" già notificate
    alerts: [],         // coda avvisi { url, titolo, prezzo, motivo, ts, letto }
    fingerprint: null,
  };
  list.push(s);
  saveAll(list);
  return { id: s.id, label: s.label, params: s.params, createdAt: s.createdAt, lastChecked: null, novita: 0 };
}

function removeSaved(id) {
  const list = loadAll();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  saveAll(next);
  return true;
}

function getSaved(id) { return loadAll().find(s => s.id === id) || null; }

function markRead(id) {
  const list = loadAll();
  const s = list.find(x => x.id === id);
  if (!s) return false;
  (s.alerts || []).forEach(a => { a.letto = true; });
  saveAll(list);
  return true;
}

// ─── Motore avvisi ──────────────────────────────────────────────────────────
// Firma leggera: conteggio + price-vector (ordinato) + hash dei top URL. Include
// i prezzi così un calo profondo cambia comunque la firma (non lo maschera).
function fingerprint(results) {
  const prezzi = results.map(r => r.prezzo).filter(p => p != null && p > 0).sort((a, b) => a - b);
  const topUrls = results.slice(0, 20).map(r => r.url || '').join('|');
  let h = 0;
  for (let i = 0; i < topUrls.length; i++) h = (h * 31 + topUrls.charCodeAt(i)) | 0;
  return `${results.length}:${prezzi.join(',')}:${h}`;
}

/**
 * Calcola gli avvisi FILTRATI per una ricerca dato il set di risultati (già
 * analizzato). NON muta la ricerca: ritorna { alerts, fingerprint }.
 * `seen` è lo stato precedente (search.seen).
 */
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function computeAlerts(search, results) {
  const seen = search.seen || {};
  // PRIMO check (nessun baseline): NON inondare con "tutto è nuovo". Si stabilisce
  // solo la baseline (seen) in silenzio; gli avvisi partono dalle modifiche dopo.
  const isBaseline = Object.keys(seen).length === 0;
  if (isBaseline) return { alerts: [], fingerprint: fingerprint(results), alertedKeys: search.alerted || [] };

  const prezzi = results.map(r => r.prezzo).filter(p => p != null && p > 0);
  // Floor relativo alla MEDIANA (non al minimo: il minimo è spesso lo scam stesso
  // e si auto-sabota). Sotto floor → mai un avviso, anche senza comparabili.
  const floor  = Math.max(FLOOR_ABS, median(prezzi) * FLOOR_PCT);
  const alerted = new Set(search.alerted || []);
  const out = [];

  for (const r of results) {
    if (!r.url || r.prezzo == null || r.prezzo <= 0) continue;
    const flags = r._flags || [];
    if (flags.includes('sospetto') || flags.includes('dato_mancante')) continue;  // scarta rumore
    if (r.prezzo < floor) continue;                                               // floor anti-scam

    const prev = seen[r.url];
    let motivo = null, key = null;
    if (prev == null) {
      // Annuncio NUOVO (mai visto): se è anche affare forte → 'affare' (più saliente),
      // altrimenti 'nuovo'. NB: gli affari PREESISTENTI non riallertano (sono già
      // visibili nei risultati) → niente flood a ogni check.
      if (flags.includes('affare')) { motivo = 'affare'; key = `${r.url}|affare`; }
      else                          { motivo = 'nuovo';  key = `${r.url}|nuovo`; }
    } else if (r.prezzo <= prev - Math.max(DROP_ABS, prev * DROP_PCT)) {
      motivo = 'calo';  key = `${r.url}|calo|${r.prezzo}`;   // include prezzo → ulteriori cali ri-notificano
    }

    if (!motivo || alerted.has(key)) continue;
    alerted.add(key);
    out.push({ url: r.url, titolo: r.titolo, prezzo: r.prezzo, motivo, ts: Date.now(), letto: false });
  }
  return { alerts: out, fingerprint: fingerprint(results), alertedKeys: [...alerted] };
}

// Cap FIFO su oggetto (preserva ordine d'inserimento delle chiavi stringa).
function capObject(obj, max) {
  const keys = Object.keys(obj);
  if (keys.length <= max) return obj;
  const drop = keys.slice(0, keys.length - max);
  for (const k of drop) delete obj[k];
  return obj;
}

/**
 * Applica l'esito di un check a una ricerca salvata su disco: accoda i nuovi
 * avvisi, aggiorna seen/alerted/fingerprint/lastChecked. `extraSeen` = prezzi
 * dei tracciati "profondi" ri-fetchati (two-tier). Ritorna i nuovi avvisi.
 */
function recordCheck(id, results, { extraSeen = {}, removedUrls = [] } = {}) {
  const list = loadAll();
  const s = list.find(x => x.id === id);
  if (!s) return [];

  const { alerts, fingerprint: fp, alertedKeys } = computeAlerts(s, results);

  // seen ← prezzi correnti (shallow) + ri-fetch profondi; rimuovi i 404 (venduti).
  const seen = s.seen || {};
  for (const r of results) if (r.url && r.prezzo != null && r.prezzo > 0) seen[r.url] = r.prezzo;
  for (const [u, p] of Object.entries(extraSeen)) if (p != null && p > 0) seen[u] = p;
  for (const u of removedUrls) delete seen[u];

  s.seen        = capObject(seen, SEEN_CAP);
  s.alerted     = alertedKeys.slice(-ALERTED_CAP);
  s.alerts      = [...(s.alerts || []), ...alerts].slice(-200);
  s.fingerprint = fp;
  s.lastChecked = Date.now();
  saveAll(list);
  return alerts;
}

module.exports = {
  listSaved, addSaved, removeSaved, getSaved, markRead,
  computeAlerts, recordCheck, fingerprint,
  _const: { FLOOR_ABS, FLOOR_PCT, DROP_ABS, DROP_PCT },
};
