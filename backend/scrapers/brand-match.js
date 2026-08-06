/**
 * Matcher di marca/modello condiviso (DRY) — riusato da: lookup catalogo,
 * resolver Moto.it, resolver AS24, risoluzione slug-modello on-demand.
 *
 * BRAND (makeResolver): alias-curati → esatto-normalizzato. NIENTE contenimento
 * (generava falsi match cross-brand: Mars→Marshal, Arc→Arctic Cat). I cross-name
 * veri (Beta=Betamotor) stanno in data/brand-aliases.json, non si "indovinano".
 *
 * MODELLO (makeModelResolver): esatto-normalizzato → prefix bidirezionale.
 * Entro UN solo brand il rischio di falso positivo è basso, e serve un minimo
 * di tolleranza (es. "alp 4.0" ↔ slug "alp-4-0").
 */
const path = require('path');

/**
 * LA normalizzazione dei nomi di veicolo: minuscolo, senza accenti, solo lettere e cifre.
 * "Citro\u00ebn" e "Citroen", "Regolarit\u00e0" e "Regolarita" diventano la stessa cosa.
 *
 * E' UNA SOLA apposta, e chi confronta marche o modelli importa questa. Erano tre copie che
 * facevano cose diverse \u2014 quella di server.js e quella di watchlist-overlaps.js NON toglievano
 * gli accenti \u2014 e due funzioni che normalizzano diverso sono la sorgente classica del mismatch
 * silenzioso: l'annuncio sparisce dai risultati e nessuno vede un errore. Misurato sui dati veri:
 * 69 nomi trattati diversamente dalle due forme, fra cui il marchio Citroen ("citron" contro
 * "citroen") e 32 modelli moto accentati, proprio dove il filtro sui titoli e' attivo.
 *
 * NON e' la stessa cosa di model-key.norm, che comprime i separatori in trattino ("serie 3" \u2192
 * "serie-3") invece di toglierli: quella produce una chiave SCRITTA in colonna sul database, e
 * cambiarla vorrebbe dire ricalcolare le listings. Sono due mestieri diversi e restano separate.
 */
const norm = s => String(s == null ? '' : s).toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

// ─── Alias brand curati (gruppi di nomi = stesso brand reale) ────────────────
// Ritorna map: norm(qualsiasi-nome-del-gruppo) → TUTTO il gruppo (canonico per primo).
//
// Prima tornava il solo nome canonico, e questo rendeva gli alias inutili proprio dove
// servivano: il gruppo ["Beta","Betamotor"] ha per canonico "Beta", ma l'elenco marche di
// Moto.it contiene "Betamotor" — il resolver cercava "Beta" fra i candidati, non lo trovava e
// rispondeva null. Misurato: 8 gruppi su 10 fallivano cosi' (Beta, Fantic, Benda, Brixton,
// Can-Am, Keeway, Mash, Mondial), cioe' marche vendute davvero in Italia.
// Col gruppo intero il resolver puo' provare ogni grafia finche' una e' fra i candidati.
function loadAliasMap(tipo) {
  let groups = [];
  try {
    const data = require(path.join(__dirname, '..', '..', 'data', 'brand-aliases.json'));
    groups = (data[tipo] || []).concat(data.all || []);
  } catch (_) {}
  const map = {};
  for (const g of groups) {
    if (!Array.isArray(g) || !g.length) continue;
    for (const name of g) map[norm(name)] = g;
  }
  return map;
}

/**
 * Resolver BRAND: alias → esatto. candidates: [{name, value}].
 * @param {Object} [opts.alias]  map norm(variante) → nome canonico
 */
function makeResolver(candidates, opts = {}) {
  const alias = opts.alias || {};
  const items = candidates.map(c => ({ n: norm(c.name), value: c.value })).filter(c => c.n);
  const exact = new Map(items.map(c => [c.n, c.value]));
  return function resolve(query) {
    const q = norm(query);
    if (!q) return null;
    /**
     * LA CORRISPONDENZA ESATTA VIENE PRIMA DELL'ALIAS. Chi chiede un nome che esiste tale
     * e quale deve ricevere quello, non il capogruppo.
     * Prima era il contrario, e faceva danno in due modi:
     *  - "KL Motors" (10 modelli CON codice Autoscout) veniva dirottato su "Kl" (8 modelli
     *    senza nessun codice): la ricerca su Autoscout restava senza modello;
     *  - "Vespa" (marca a se' su Autoscout, makeId 50404) finiva su "Piaggio".
     * L'alias resta per chi chiede una grafia che NON esiste fra i candidati ("TM Racing"
     * quando in catalogo c'e' solo "TM"), che e' il suo mestiere.
     */
    if (exact.has(q)) return exact.get(q);
    const a = alias[q];
    if (a) {
      for (const name of (Array.isArray(a) ? a : [a])) {
        const ck = norm(name);
        if (exact.has(ck)) return exact.get(ck);
      }
    }
    return null;
  };
}

/**
 * Resolver MODELLO: esatto → prefix bidirezionale (min 3 char). candidates: [{name, value}].
 */
function makeModelResolver(candidates) {
  const items = candidates.map(c => ({ n: norm(c.name), value: c.value })).filter(c => c.n);
  const exact = new Map(items.map(c => [c.n, c.value]));
  return function resolve(query) {
    const q = norm(query);
    if (!q) return null;
    if (exact.has(q)) return exact.get(q);
    if (q.length >= 3) {
      const cont = items.filter(c => c.n.length >= 3 && (c.n.startsWith(q) || q.startsWith(c.n)));
      if (cont.length) {
        // A parita' di distanza serve un criterio STABILE, altrimenti decide l'ordine in cui
        // il catalogo e' arrivato: con [320d,320i] la query "320" dava 320d, invertendo la
        // lista dava 320i, e bastava un sort a monte per cambiare gli annunci mostrati senza
        // che nulla lo segnalasse. Misurato sul catalogo vero: il pari merito capita nel 26%
        // delle query con piu' candidati, ma fissarlo in ordine alfabetico cambia solo 25
        // risposte su 12.078 (0,2%) — e in quelle la scelta era comunque arbitraria.
        cont.sort((a, b) => Math.abs(a.n.length - q.length) - Math.abs(b.n.length - q.length)
          || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
        return cont[0].value;
      }
    }
    return null;
  };
}

/**
 * Restringimento AS24 per i modelli SENZA codice-modello (18,6% delle moto).
 *
 * Oggi quei modelli finiscono in pesca brand-only: AS24 manda i 100 annunci più
 * economici della marca, dove il modello cercato spesso non compare affatto
 * (misurato: CFMOTO brand-only copre 1.450-4.150 €, ma le 800MT-X partono da 6.900 €).
 *
 * Qui si ricava il restringimento migliore usando SOLO il catalogo — nessuna lista
 * scritta a mano, la parentela è dedotta per prefisso normalizzato:
 *  - `mmmv`: il codice del modello-PADRE se esiste ("800MT-X" → padre "800MT"), così
 *    la pesca avviene nel bucket giusto invece che su tutta la marca;
 *  - `versionText`: il modello cercato, che AS24 filtra server-side. Verificato live:
 *    il campo cerca sia nel nome-modello sia nell'allestimento, per parola intera,
 *    più token in AND, senza wildcard.
 *
 * @param {Array}  models  voci-modello della marca ({ nome, mmmvAutoscout })
 * @param {string} modello nome cercato dall'utente
 * @param {number} makeId  id marca AS24 (per il fallback brand-only)
 */
function resolveAs24Narrowing(models, modello, makeId) {
  const brandOnly = makeId ? `${makeId}|||` : '';
  const q = norm(modello);
  if (!q) return { mmmv: brandOnly, versionText: '', padre: null };
  // Un prefisso che SPEZZA UN NUMERO non e' una parentela: "fz6" dentro "fz600" metteva la
  // FZ 600 (1986) nel secchio della FZ6 (2004), e la fascia di stato stampava una genealogia
  // falsa. Due numeri diversi non sono padre e figlio. Ma il taglio e' LEGITTIMO in due casi:
  // cade su un confine di token del nome cercato ("AF 1" ⊂ "AF1 125", "RSV4" ⊂ "RSV4 1100"),
  // oppure estende delle lettere ("800mt" ⊂ "800mtx", "CRF 250" ⊂ "CRF 250R").
  // Misurato sui 1.768 modelli moto senza codice: cambiano SOLO i due padri falsi
  // (Rev 3 → "Rev 300", FZ6 → "FZ 600"), nessun padre vero si perde.
  const toks = String(modello || '').toLowerCase().normalize('NFD').split(/[^a-z0-9]+/).filter(Boolean);
  const confini = new Set();
  for (let i = 0, acc = ''; i < toks.length - 1; i++) { acc += toks[i]; confini.add(acc); }
  const taglioValido = n => confini.has(n) || !(/\d$/.test(n) && /^\d/.test(q.slice(n.length)));
  let padre = null, padreLen = 0;
  for (const m of (models || [])) {
    if (!m || !m.mmmvAutoscout) continue;         // il padre deve avere il codice, altrimenti non aiuta
    const n = norm(m.nome);
    if (n.length < 3 || !q.startsWith(n) || n === q || !taglioValido(n)) continue;   // prefisso STRETTO: "800mt" ⊂ "800mtx"
    if (n.length > padreLen) { padre = m; padreLen = n.length; }  // il più specifico vince
  }
  return {
    mmmv: padre ? padre.mmmvAutoscout : brandOnly,
    versionText: String(modello || '').trim(),
    padre: padre ? padre.nome : null,
  };
}

/**
 * Grafie plausibili di un nome-modello per il filtro nativo AS24.
 *
 * AS24 confronta per PAROLA INTERA con i token in AND: "800MT-X" (token 800MT + X)
 * aggancia "CFMOTO 800MT-X BASSA" ma NON "CFMOTO 800 MT X" né "CFMOTO Mtx", che i
 * venditori scrivono di continuo. Una grafia sola perde la maggior parte degli annunci,
 * e non esiste un OR: serve una query per grafia, poi si uniscono i risultati.
 *
 * Regole (deterministiche, nessuna lista scritta a mano):
 *  1. il nome come cercato                         "800MT-X"
 *  2. separando cifre e lettere                    "800 MT X"
 *  solo per i codici compatti (senza spazi), dove le varianti di scrittura abbondano:
 *  3. tutto attaccato                              "800mtx"
 *  4. sole lettere (>=3), che è come molti abbreviano   "MTX"
 * Per i nomi multi-parola le ultime due produrrebbero stringhe inesistenti → saltate.
 */
function as24Spellings(modello) {
  const raw = String(modello || '').trim();
  if (!raw) return [];
  const out = [];
  const push = s => {
    const v = String(s).trim().replace(/\s+/g, ' ');
    if (v && !out.some(x => x.toLowerCase() === v.toLowerCase())) out.push(v);
  };
  push(raw);
  push(raw.replace(/([0-9])([a-z])/gi, '$1 $2').replace(/([a-z])([0-9])/gi, '$1 $2').replace(/[^a-z0-9]+/gi, ' '));
  if (!/\s/.test(raw)) {                    // codice compatto: "800MT-X", "300CL-X"
    push(norm(raw));
    const lettere = raw.replace(/[^a-z]/gi, '');
    if (lettere.length >= 3) push(lettere);
  }
  return out.slice(0, 4);                   // tetto: max 4 richieste per ricerca
}

module.exports = { norm, makeResolver, makeModelResolver, loadAliasMap, resolveAs24Narrowing, as24Spellings };
