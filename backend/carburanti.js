'use strict';
/**
 * Prezzi carburante ufficiali per PROVINCIA — open data MIMIT (Osservaprezzi Carburanti).
 *
 * A cosa serve: incrociati col consumo della scheda tecnica danno il COSTO REALE al km
 * dove vive l'utente, non una media nazionale. Misurato: la stessa auto costa ~2.029 €/anno
 * a Palermo e ~1.988 € a Milano; benzina vs GPL sullo stesso modello sono 1.988 € contro 955 €.
 *
 * Fonte: https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti
 * Licenza IODL 2.0 → riuso anche commerciale CON ATTRIBUZIONE (la UI deve citare la fonte).
 * robots.txt di mimit.gov.it verificato: /images/ NON è in Disallow.
 *
 * INSIDIE VERIFICATE sui file veri (non ipotesi):
 *  - separatore PIPE "|", non virgola (cambiato dal 10/02/2026);
 *  - riga 1 = "Estrazione del AAAA-MM-GG", riga 2 = intestazione, dati dalla 3ª;
 *  - codifica latin1, non UTF-8;
 *  - ~0,4% delle righe anagrafica ha in Provincia un nome di comune invece della sigla
 *    → si tengono solo le sigle a 2 lettere;
 *  - 58 stringhe-carburante distinte: i premium (Blue Diesel, HVOlution, V-Power, Hi-Q…)
 *    costano più del carburante base, quindi NON si fondono con esso: si quotano solo i
 *    4 carburanti standard, altrimenti la mediana risulterebbe gonfiata;
 *  - GPL e metano hanno pochissimi impianti "self" (Milano: 1 e 4) → per loro si usano
 *    tutti i prezzi, altrimenti la mediana poggia su 1 solo impianto.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const HOST = 'https://www.mimit.gov.it';
const URL_PREZZI = `${HOST}/images/exportCSV/prezzo_alle_8.csv`;
const URL_IMPIANTI = `${HOST}/images/exportCSV/anagrafica_impianti_attivi.csv`;
const FONTE = 'MIMIT — Osservaprezzi Carburanti (IODL 2.0)';
const cacheDisco = require('./scrapers/cache-disco');
const CACHE_FILE = path.join(__dirname, '..', 'data', 'carburanti-cache.json');
const TTL_MS = 12 * 60 * 60 * 1000;   // i prezzi valgono "alle 8" del giorno: due controlli al giorno bastano
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Solo i 4 carburanti standard. I premium restano fuori di proposito (vedi intestazione).
const FAMIGLIE = { benzina: 'Benzina', gasolio: 'Gasolio', gpl: 'GPL', metano: 'Metano' };
// Famiglie per cui il campione "self" è troppo magro → si usano tutti i prezzi.
const SENZA_SELF = new Set(['gpl', 'metano']);

const isAllowedHost = h => /(^|\.)mimit\.gov\.it$/i.test(String(h || ''));

function scarica(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(new Error('url non valido')); }
    if (!isAllowedHost(u.hostname)) return reject(new Error('host non consentito'));
    const req = https.get(url, { headers: { 'user-agent': UA, accept: 'text/csv,*/*', 'accept-encoding': 'gzip, deflate' } }, res => {
      const code = res.statusCode;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects < 5) {
        res.resume();
        let next; try { next = new URL(res.headers.location, url); } catch (_) { return reject(new Error('redirect non valido')); }
        if (!isAllowedHost(next.hostname)) return reject(new Error('redirect fuori host'));
        return resolve(scarica(next.href, redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`http ${code}`)); }
      const chunks = [];
      let s = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      s.on('data', c => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));   // NON utf8: il file è latin1
      s.on('error', e => reject(e));
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
  });
}

const righe = txt => String(txt || '').split('\n').slice(2).filter(Boolean);   // salta "Estrazione del…" + intestazione

/**
 * Anagrafica completa → Map(idImpianto → { provincia, gestore, bandiera, tipo, nome, indirizzo,
 * comune, lat, lon }). Le dieci colonne sono quelle vere del file, verificate il 2026-07-26:
 *   idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Lat|Lon
 * Le righe con Provincia sporca (~0,4%, un nome di comune invece della sigla) restano ma con
 * provincia null: servono lo stesso a chi cerca per idImpianto, e scartarle qui le farebbe
 * sparire anche dal join con OpenStreetMap.
 */
function parseAnagrafica(txt) {
  const out = new Map();
  for (const r of righe(txt)) {
    const c = r.split('|');
    if (c.length < 8) continue;
    const id = c[0].trim();
    if (!id) continue;
    const pv = (c[7] || '').trim().toUpperCase();
    const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
    out.set(id, {
      id,
      provincia: /^[A-Z]{2}$/.test(pv) ? pv : null,
      gestore: (c[1] || '').trim() || null,
      bandiera: (c[2] || '').trim() || null,
      tipo: (c[3] || '').trim() || null,
      nome: (c[4] || '').trim() || null,
      indirizzo: (c[5] || '').trim().replace(/\s+/g, ' ') || null,
      comune: (c[6] || '').trim() || null,
      lat: n(c[8]), lon: n(c[9]),
    });
  }
  return out;
}

// anagrafica → Map(idImpianto → sigla provincia). Scarta le righe con Provincia sporca.
// Derivata da parseAnagrafica per non avere due parser della stessa riga che divergono.
function parseImpianti(txt) {
  const out = new Map();
  for (const [id, v] of parseAnagrafica(txt)) if (v.provincia) out.set(id, v.provincia);
  return out;
}

const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

// prezzi + anagrafica → { aggiornato, fonte, province: { MI: { benzina:{p,n}, … } }, italia: {…} }
function costruisciIndice(txtPrezzi, txtImpianti) {
  const provDi = parseImpianti(txtImpianti);
  const perFam = {};   // famiglia → { self:[], tutti:[] } nazionale
  const perProv = {};  // provincia → famiglia → { self:[], tutti:[] }
  const nome2fam = {};
  for (const [fam, etichetta] of Object.entries(FAMIGLIE)) nome2fam[etichetta.toLowerCase()] = fam;

  for (const r of righe(txtPrezzi)) {
    const c = r.split('|');
    if (c.length < 4) continue;
    const fam = nome2fam[(c[1] || '').trim().toLowerCase()];
    if (!fam) continue;                                  // premium/HVO fuori
    const p = parseFloat(c[2]);
    if (!isFinite(p) || p <= 0 || p > 10) continue;       // scarta valori impossibili
    const self = String(c[3]).trim() === '1';
    const pv = provDi.get(c[0].trim());
    if (!pv) continue;
    (perProv[pv] = perProv[pv] || {});
    const vuoto = () => ({ self: [], tutti: [], impSelf: new Set(), impTutti: new Set() });
    const slot = (perProv[pv][fam] = perProv[pv][fam] || vuoto());
    const nz = (perFam[fam] = perFam[fam] || vuoto());
    const imp = c[0].trim();
    slot.tutti.push(p); nz.tutti.push(p);
    // GLI IMPIANTI, non le quotazioni. Un distributore che vende self E servito manda DUE
    // righe per la stessa famiglia, e contando le righe l'avviso "solo N impianti" diceva
    // il doppio del vero — proprio su GPL e metano, dove il campione e' magro ed e' l'unico
    // posto in cui quell'avviso serve. E si contano gli impianti del campione DAVVERO usato
    // per la mediana (self o tutti), senno' il numero descrive un insieme diverso dal prezzo.
    slot.impTutti.add(imp); nz.impTutti.add(imp);
    if (self) { slot.self.push(p); nz.self.push(p); slot.impSelf.add(imp); nz.impSelf.add(imp); }
  }

  const riduci = m => {
    const o = {};
    for (const [fam, v] of Object.entries(m)) {
      // self quando il campione è consistente, altrimenti tutti (GPL/metano hanno pochi self)
      const usaSelf = !SENZA_SELF.has(fam) && v.self.length >= 5;
      const arr = usaSelf ? v.self : v.tutti;
      const med = mediana(arr);
      // `n` = quanti IMPIANTI stanno dietro QUESTO prezzo (vedi sopra), non quante quotazioni.
      if (med != null) o[fam] = { p: +med.toFixed(3), n: (usaSelf ? v.impSelf : v.impTutti).size, self: usaSelf };
    }
    return o;
  };
  const province = {};
  for (const [pv, m] of Object.entries(perProv)) {
    const r = riduci(m);
    if (Object.keys(r).length) province[pv] = r;
  }
  const estrazione = (String(txtPrezzi).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  return { aggiornato: estrazione, scaricato: new Date().toISOString(), fonte: FONTE, italia: riduci(perFam), province };
}

/**
 * LA NONA CACHE. Le altre otto stanno in backend/scrapers/ e passano tutte da cache-disco;
 * questa viveva qui, scritta a mano, e le mancavano le stesse tre cose:
 *  - il NUMERO DI SCHEMA. Ed e' costato subito: cambiando `n` da "quante quotazioni" a
 *    "quanti impianti" (vedi `riduci`), l'indice gia' su disco continuava a servire il
 *    conteggio vecchio, e la correzione non si vedeva affatto;
 *  - DOVE SI SCRIVE: dentro la cartella dell'app, che nel pacchetto Electron e' di sola
 *    lettura, con l'errore ingoiato da un `catch` vuoto;
 *  - e serviva la copia SCADUTA quando la fonte cadeva, in silenzio — la cosa che il
 *    proprietario ha deciso di togliere a tutte.
 * Il tetto qui non serve: la chiave e' una sola.
 */
const conCache = cacheDisco.crea(CACHE_FILE, { tag: 'carburanti', schema: 2, ttl: TTL_MS, max: 4 });

/**
 * Indice prezzi. Una chiave sola: cache-disco fa da se' la cache fresca, la richiesta
 * unica quando due arrivano insieme, e il rifiuto di servire una copia scaduta.
 */
async function indice() {
  try {
    return await conCache('indice', async () => {
      const [p, i] = await Promise.all([scarica(URL_PREZZI), scarica(URL_IMPIANTI)]);
      const idx = costruisciIndice(p, i);
      if (!Object.keys(idx.province).length) throw new Error('indice vuoto');
      return idx;
    });
  } catch (e) {
    console.warn('[carburanti] aggiornamento KO:', e.message);
    return null;                    // la fonte non ha risposto: si dice, non si inventa
  }
}

// `famigliaDa` e `consumoDa` stavano qui, esportate e con nove test. Non le chiamava
// NESSUNO: la coppia viva e' `carbFamigliaDa`/`carbConsumoDa` nel frontend, che e' dove il
// costo carburante si calcola davvero. E le due erano anche diverse — correggendo la
// lettura della virgola all'italiana ("6,9-7,2") si era toccata solo la viva, quindi i nove
// test provavano una copia sbagliata che nessuno esegue: un test che non puo' fallire dove
// serve e' peggio di nessun test. Tolte da qui; i test sono passati sulla copia vera.

/**
 * PREZZI PER SINGOLO IMPIANTO, che l'indice per provincia butta via aggregando.
 *
 * Serve per una cosa sola ma che vale: OpenStreetMap mappa 20.030 distributori italiani col tag
 * `ref:mise`, che e' esattamente questo idImpianto. Incrociandoli, alla posizione verificata sul
 * posto, agli orari e ai carburanti disponibili di OSM si aggiunge il PREZZO REALE di oggi.
 *
 * Non passa da costruisciIndice: quello aggrega e va bene com'e', e riscriverlo per farlo fare
 * due cose diverse lo renderebbe piu' fragile senza motivo.
 */
function perImpianto(txtPrezzi, txtAnagrafica) {
  const ana = parseAnagrafica(txtAnagrafica);
  const nome2fam = {};
  for (const [fam, etichetta] of Object.entries(FAMIGLIE)) nome2fam[etichetta.toLowerCase()] = fam;

  const prezzi = new Map();          // id → famiglia → { self, servito }
  for (const r of righe(txtPrezzi)) {
    const c = r.split('|');
    if (c.length < 4) continue;
    const fam = nome2fam[(c[1] || '').trim().toLowerCase()];
    if (!fam) continue;                                  // premium fuori, come nell'aggregato
    const p = parseFloat(c[2]);
    if (!isFinite(p) || p <= 0 || p > 10) continue;
    const id = c[0].trim();
    if (!id) continue;
    const self = String(c[3]).trim() === '1';
    const v = prezzi.get(id) || {};
    v[fam] = v[fam] || {};
    // Un impianto puo' avere piu' righe per la stessa famiglia (self e servito): si tengono
    // separate invece di fonderle, perche' la differenza fra le due e' reale e visibile.
    const chiave = self ? 'self' : 'servito';
    if (v[fam][chiave] == null || p < v[fam][chiave]) v[fam][chiave] = +p.toFixed(3);
    prezzi.set(id, v);
  }

  // Si tengono TUTTI gli impianti attivi, anche quelli che oggi non hanno comunicato niente, con
  // `prezzi: null`. Scartarli faceva perdere una distinzione che serve a chi incrocia per codice:
  // "impianto attivo che oggi tace" e "codice che nell'anagrafica non c'e' piu'" sono due cose
  // diverse, e chiamarle entrambe "non trovato" nasconde quale delle due e'.
  const fuori = {};
  for (const [id, a] of ana) fuori[id] = { ...a, prezzi: prezzi.get(id) || null };
  return fuori;
}

/** Prezzi per impianto, con la stessa cache e lo stesso ripiego di indice(). */
let impiantiMemo = null;
let impiantiVolo = null;
async function impianti() {
  if (impiantiMemo && Date.now() - impiantiMemo.t < TTL_MS) return impiantiMemo.d;
  if (impiantiVolo) return impiantiVolo;
  impiantiVolo = (async () => {
    try {
      const [p, i] = await Promise.all([scarica(URL_PREZZI), scarica(URL_IMPIANTI)]);
      const d = perImpianto(p, i);
      if (!Object.values(d).some(x => x.prezzi)) throw new Error('nessun impianto con prezzi');
      impiantiMemo = { t: Date.now(), d };
      return d;
    } catch (e) {
      console.warn('[carburanti] impianti KO:', e.message);
      return impiantiMemo ? impiantiMemo.d : null;       // meglio i prezzi di ieri che nessuno
    } finally { impiantiVolo = null; }
  })();
  return impiantiVolo;
}

module.exports = {
  indice, costruisciIndice, parseImpianti, parseAnagrafica, perImpianto, impianti,
  FAMIGLIE, FONTE, _scarica: scarica,
};
