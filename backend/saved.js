/**
 * §11 — Ricerche salvate + motore avvisi FILTRATO (anti-rumore).
 *
 * Persistenza: <USER_DATA_PATH>/saved-searches.json (Electron) o data/ (dev),
 * stesso pattern di subito-session. Solo logica dati + calcolo avvisi: il fetch
 * (runSearch) lo orchestra server.js, che passa qui i risultati grezzi.
 *
 * Avvisi PURAMENTE price-based (§21: rating rimosso, niente più "affare"):
 *  - NUOVO (url mai visto) · CALO (>= soglia DROP_ABS/DROP_PCT)
 *  - floor anti-scam assoluto/relativo → scarta i prezzi-spazzatura
 *  - scarta annunci con anno/km mancanti (rumore)
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

/**
 * UN FILE ILLEGGIBILE NON E' UN FILE ASSENTE — la regola gia' scritta in competitor.js:50,
 * che qui mancava. Rispondendo `[]` a entrambi, il pannello scriveva «Nessuna ricerca
 * salvata» su un elenco che c'era, e il gesto istintivo — risalvare la ricerca — chiamava
 * saveAll con quella sola voce: il file si riscriveva DA SOLO e le altre ricerche, con
 * tutto il loro storico (`seen`, `alerted`, avvisi), sparivano per sempre.
 *
 * Ora l'elenco resta vuoto (non si inventa niente) ma il guasto ha un nome, e chi SCRIVE
 * si ferma invece di sovrascrivere cio' che non e' riuscito a leggere.
 */
function loadAll() {
  const p = filePath();
  if (!fs.existsSync(p)) { loadAll.ultimoErrore = null; return []; }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('il file non contiene un elenco');
    loadAll.ultimoErrore = null;
    // Conversione delle chiavi vecchie (URL → id stabile), una volta sola: si riscrive
    // solo se qualcosa e' cambiato davvero. Vedi `migraChiavi`.
    let tocco = false;
    for (const s of arr) if (migraChiavi(s)) tocco = true;
    if (tocco) { try { saveAll(arr); } catch (_) {} }
    return arr;
  } catch (e) {
    loadAll.ultimoErrore = e.message;
    console.error(`[saved] elenco illeggibile (${e.message}) — NON si sovrascrive da solo: ${p}`);
    return [];
  }
}
/** Chi sta per SCRIVERE lo chiama prima: su un elenco illeggibile si rifiuta di riscrivere. */
function esigiLeggibile() {
  if (loadAll.ultimoErrore) {
    const e = new Error(`elenco delle ricerche salvate illeggibile (${loadAll.ultimoErrore}): non lo sovrascrivo`);
    e.code = 'ELENCO_ILLEGGIBILE';
    throw e;
  }
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
      // L'ultimo controllo in cui hanno risposto TUTTE le fonti, e quali sono state mute
      // nell'ultimo: senza, "nessuna novita'" e "una fonte non ha parlato" sono identiche.
      lastCheckedFull: s.lastCheckedFull || null,
      fontiMute: (s.fontiMute && s.fontiMute.length) ? s.fontiMute : null,
      novita: unread.length,
      digest,
      alerts: unread.slice(-30).reverse(),   // più recenti in cima
    };
  });
}

function addSaved({ label, params }) {
  const list = loadAll();
  esigiLeggibile();   // mai riscrivere un elenco che non si e' riusciti a leggere
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
  esigiLeggibile();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  saveAll(next);
  return true;
}

function getSaved(id) { return loadAll().find(s => s.id === id) || null; }

/**
 * SEGNA LETTO QUELLO SU CUI HAI CLICCATO, non tutti.
 *
 * `markRead` prendeva la RICERCA e metteva `letto = true` su ogni avviso della coda, mentre
 * l'interfaccia la chiama al clic su UN avviso, prima di aprire l'annuncio. Siccome la lista
 * espone solo i non letti, gli altri sparivano dalla scheda al primo ridisegno — non letti,
 * marcati letti dal clic sul primo — e dopo trenta giorni la potatura li toglieva dal file.
 * Con piu' persone il danno si moltiplicava: un collega che apriva un annuncio azzerava la
 * coda del proprietario.
 *
 * @param {string} url  l'avviso da segnare. Senza, si segnano tutti: e' il bottone
 *                      "segna tutti letti", un gesto esplicito e diverso dal clic su una riga.
 */
function markRead(id, url) {
  const list = loadAll();
  esigiLeggibile();
  const s = list.find(x => x.id === id);
  if (!s) return false;
  const coda = s.alerts || [];
  if (url) {
    const a = coda.find(x => x.url === url && !x.letto);
    if (!a) return false;
    a.letto = true;
  } else {
    coda.forEach(a => { a.letto = true; });
  }
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
    /**
     * UN ANNUNCIO DI UN ALTRO MODELLO NON SUONA.
     *
     * Una ricerca salvata su un modello che Autoscout non ha a catalogo si allarga alla
     * marca: gli avvisi che arrivavano potevano essere di altri modelli, e nel pannello
     * erano identici agli altri — «Nuovo · <titolo> · <prezzo>». Una ricerca salvata segue
     * QUEL modello, non la marca.
     *
     * Non e' un post-filtro che nasconde: l'annuncio resta visibile quando la ricerca la
     * fai, semplicemente non ti sveglia. E `recordCheck` lo registra comunque in `seen`,
     * cosi' se domani la risoluzione del modello migliora non arriva come "nuovo" un mezzo
     * che sta in lista da settimane.
     */
    // RIGA GEMELLA di `fuoriBersaglio()` in frontend/app.js: browser e avvisi devono dare
    // lo stesso verdetto sugli stessi ingressi (il test lo blinda). Il secondo canale —
    // `versioneEsito`, la verifica versioni del server — qui mancava, e l'avviso suonava
    // per un annuncio che lo schermo della stessa ricerca nasconde come «non e' quella
    // versione»: la coppia peggiore, suona ED e' invisibile.
    if ((r.dichiarazione && r.dichiarazione !== 'esatto' && r.dichiarazione !== 'senza-versione')
      || r.versioneEsito === 'smentita') continue;
    // review: NON gateare su anno/km null. recordCheck (sotto) registra COMUNQUE l'annuncio in
    // `seen` → col vecchio gate un annuncio nuovo con km=null (comune su Moto.it/Subito) non
    // avvisava MAI e restava soppresso per sempre (prev != null al giro dopo). Il rumore è già
    // contenuto da prezzo>0 + floor anti-scam + soglie di calo; un annuncio nuovo È nuovo.
    if (r.prezzo < floor) continue;                 // floor anti-scam (price-based)

    const k = chiaveAnnuncio(r);
    const prev = seen[k];
    let motivo = null, key = null;
    if (prev == null) {
      // Annuncio NUOVO (mai visto). §21: niente più 'affare' (rating rimosso).
      motivo = 'nuovo'; key = `${k}|nuovo`;
    } else if (r.prezzo <= prev - Math.max(DROP_ABS, prev * DROP_PCT)) {
      motivo = 'calo';  key = `${k}|calo|${r.prezzo}`;   // include prezzo → ulteriori cali ri-notificano
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
/** La fonte di un URL salvato, per capire quali `seen` non sono verificabili adesso. */
/**
 * L'IDENTITA' DI UN ANNUNCIO, che non e' il suo indirizzo.
 *
 * `seen` e `alerted` erano indicizzati per URL. Ma l'URL di Subito contiene il TITOLO
 * scritto dal venditore: se lui lo ritocca — abbassa il prezzo e lo scrive, aggiunge
 * "VENDUTA", corregge un dettaglio — l'URL cambia, e da qui in poi quello e' un altro
 * annuncio: arriva un avviso "nuovo" per un mezzo in lista da settimane, e lo storico del
 * suo prezzo (cioe' la base per accorgersi di un calo) riparte da zero.
 *
 * Le fonti che un'identita' stabile la dichiarano la mettono in `id` (vedi subito-api.js).
 * Le altre restano sull'URL, che li' non porta il titolo dentro.
 */
const chiaveAnnuncio = r => (r && r.id) || (r && r.url) || null;

const fonteDaUrl = u => /^subito:/i.test(u) ? 'subito'
  : /(^|\.)subito\.it\//i.test(u) ? 'subito'
  : /(^|\.)autoscout24\.[a-z]+\//i.test(u) ? 'autoscout'
  : /(^|\.)moto\.it\//i.test(u) ? 'moto' : null;

/**
 * IL PASSATO SI CONVERTE, NON SI BUTTA.
 *
 * Il giorno del passaggio, i visti e le chiavi anti-ripetizione gia' su disco sono
 * indicizzati per URL: senza conversione il primo controllo vedrebbe OGNI annuncio come
 * nuovo — una raffica di avvisi falsi su tutte le ricerche salvate insieme — e lo storico
 * dei prezzi ripartirebbe da zero. Il progressivo di Subito sta anche in coda al vecchio
 * URL (".../…-cagliari-651863039.htm"), quindi la conversione e' esatta e si fa una volta.
 */
const idDaUrlSubito = u => {
  if (typeof u !== 'string' || /^subito:/.test(u)) return null;
  if (!/(^|\.)subito\.it\//i.test(u)) return null;
  const m = u.match(/-(\d+)\.htm(?:$|[?#])/);
  return m ? 'subito:' + m[1] : null;
};
/** Ritorna true se ha cambiato qualcosa (allora la ricerca va riscritta su disco). */
function migraChiavi(s) {
  let tocco = false;
  if (s.seen) {
    const nuovo = {};
    for (const [k, v] of Object.entries(s.seen)) {
      const id = idDaUrlSubito(k);
      if (id) tocco = true;
      nuovo[id || k] = v;                      // l'ordine di inserimento resta quello, e conta (vedi capObject)
    }
    if (tocco) s.seen = nuovo;
  }
  if (Array.isArray(s.alerted)) {
    const conv = s.alerted.map(k => {
      const i = String(k).indexOf('|');
      if (i < 0) return k;
      const id = idDaUrlSubito(String(k).slice(0, i));
      if (!id) return k;
      tocco = true;
      return id + String(k).slice(i);
    });
    if (tocco) s.alerted = conv;
  }
  return tocco;
}

/**
 * @param {string[]} [opts.fontiMute] fonti che in questo giro non hanno risposto: i loro
 *   annunci NON vanno sfrattati da `seen`. Un annuncio di una fonte giu' non e' "non
 *   visto", e' "non verificabile" — e trattarlo da vecchio lo fa tornare "nuovo" al
 *   ritorno della fonte, cioe' un falso avviso su un mezzo in lista da settimane.
 */
function recordCheck(id, results, { extraSeen = {}, removedUrls = [], fontiMute = [] } = {}) {
  const list = loadAll();
  esigiLeggibile();
  const s = list.find(x => x.id === id);
  if (!s) return [];

  const { alerts, fingerprint: fp, alertedKeys } = computeAlerts(s, results);

  // seen ← prezzi correnti (shallow) + ri-fetch profondi; rimuovi i 404 (venduti).
  const seen = s.seen || {};
  for (const r of results) { const k = chiaveAnnuncio(r); if (k && r.prezzo != null && r.prezzo > 0) seen[k] = r.prezzo; }
  for (const [u, p] of Object.entries(extraSeen)) if (p != null && p > 0) seen[u] = p;
  for (const u of removedUrls) delete seen[u];

  // Coda avvisi: prune dei LETTI più vecchi di 30g (i non-letti restano), poi cap.
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const queue = [...(s.alerts || []), ...alerts].filter(a => !a.letto || (a.ts || 0) >= cutoff);

  /**
   * IL TAGLIO DEVE PRENDERE I PIU' VECCHI DA VEDERE, NON I PRIMI ENTRATI.
   *
   * L'ordine delle chiavi di `seen` e' quello di INSERIMENTO, cioe' il PRIMO avvistamento, e
   * `capObject` taglia da li'. Un annuncio ancora VIVO ma entrato mesi fa veniva sfrattato, e al
   * check successivo `prev` era di nuovo null: arrivava come "nuovo" un mezzo in lista da
   * settimane. Riassegnare la chiave non basta — in JS non sposta la posizione — quindi quello
   * che si e' visto ADESSO si toglie e si rimette, e finisce in coda.
   */
  const inCoda = u => {
    if (u && Object.prototype.hasOwnProperty.call(seen, u)) { const p = seen[u]; delete seen[u]; seen[u] = p; }
  };
  for (const r of results) inCoda(chiaveAnnuncio(r));
  // I "non verificabili" vanno IN FONDO, dopo i visti davvero: sono gli unici che un
  // controllo successivo non puo' recuperare da solo, quindi sono i piu' cari da tenere.
  // Messi prima, una fonte molto prolifica li avrebbe spinti fuori lo stesso.
  if (fontiMute.length) {
    const mute = new Set(fontiMute);
    for (const u of Object.keys(seen)) if (mute.has(fonteDaUrl(u))) inCoda(u);
  }
  s.seen        = capObject(seen, SEEN_CAP);
  s.alerted     = alertedKeys.slice(-ALERTED_CAP);
  s.alerts      = queue.slice(-200);
  s.fingerprint = fp;
  s.lastChecked = Date.now();
  // Un controllo fatto con una fonte muta NON e' un controllo completo. Prima l'informazione
  // serviva solo a non sfrattare da `seen` gli annunci della fonte caduta e poi veniva buttata:
  // il record timbrava l'ora e basta, e la scheda diceva "controllata adesso, nessuna novita'"
  // anche quando Autoscout — dove stava il grosso degli annunci — era andato in timeout.
  s.fontiMute = fontiMute.length ? fontiMute.slice() : null;
  if (!fontiMute.length) s.lastCheckedFull = s.lastChecked;
  saveAll(list);
  return alerts;
}

/** Il perche' l'elenco non si e' letto (null se sta bene): la rotta lo porta a schermo. */
const ultimoErroreElenco = () => loadAll.ultimoErrore || null;

module.exports = {
  listSaved, addSaved, removeSaved, getSaved, markRead, ultimoErroreElenco,
  computeAlerts, recordCheck, fingerprint,
  _const: { FLOOR_ABS, FLOOR_PCT, DROP_ABS, DROP_PCT },
};
