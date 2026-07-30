'use strict';
/**
 * Scraper Subito via API di prima parte (hades.subito.it).
 *
 * Path PRIMARIO per Subito: GET JSON diretto, niente browser/DataDome/bootstrap
 * CAPTCHA → elimina il punto più fragile dell'app. Su errore/blocco → throw, così
 * server.js fa fallback a subito-playwright (browser+stealth).
 *
 * Schema verificato:
 *  GET /v1/search/items?c=<cat>&t=s&q=<marca modello>&lim=<n>&start=<off>
 *  c=2 Auto, c=3 Moto e Scooter (macrocategoria Motori).
 *  ad.subject (titolo), ad.urls.default (URL), ad.geo.region.friendly_name +
 *  ad.geo.city.value, ad.features[] (label→values[0].value): Prezzo, Km,
 *  Immatricolazione, Carburante, Cambio, Potenza, …
 *
 *  ATTENZIONE alle etichette DOPPIE. 'Km' non e' una: sono due feature con la stessa label,
 *  `/mileage` (fascia) e `/mileage_scalar` (valore esatto), e la fascia viene prima. Chi
 *  aggiunge un campo qui controlli l'`uri` prima di fidarsi della label, come fa il ramo km.
 */
const https = require('https');

const { kindForStatus, fail } = require('./utils');   // classificazione salute crawler (F1.5)
const budget = require('../budget-richieste');        // conta le richieste, non le limita
const { livelliAnnuncio, dichiarato } = require('./subito-nodo'); // cosa l'annuncio dichiara di se'
const dedotta = require('./versione-dedotta');        // la versione che il venditore non ha scelto dal menu
const { _perMarca } = require('./versioni-unificate');// il catalogo versioni, gia' in cache per marca

const HOST = 'hades.subito.it';
// Categorie hades (macro Motori=1). accessoriAuto/Moto scoperti live 2026-07-07 per la sezione Ricambi.
const CAT = { auto: '2', moto: '3', accessoriAuto: '5', accessoriMoto: '36' };
const PAGE_SIZE = 50;
const MAX_PAGES = 2;            // 2×50 = 100
const TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function httpGetJson(path) {
  budget.conta('subito');
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path,
      headers: { 'user-agent': UA, 'referer': 'https://www.subito.it/', 'accept': 'application/json' },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
}

// feature per label → primo value
function feat(ad, label) {
  const f = (ad.features || []).find(x => x.label === label);
  if (!f) return null;
  const v = f.values && f.values[0];
  return (v && (v.value != null ? v.value : v.key)) || null;
}

// Sub-valore per label dentro una feature multi-livello (es. feature 'Auto'/'Moto'
// → values con label Marca/Modello/Versione). Solo nativo: null se assente.
function subFeat(ad, parentLabel, subLabel) {
  const f = (ad.features || []).find(x => x.label === parentLabel);
  if (!f || !Array.isArray(f.values)) return null;
  const v = f.values.find(x => x && x.label === subLabel);
  return (v && (v.value != null ? v.value : v.key)) || null;
}

// CV dal valore nativo Potenza ("60 kW / 82 Cv" → 82). null se assente/solo-kW.
const cvFrom = s => { const m = String(s == null ? '' : s).match(/(\d+)\s*Cv/i); return m ? parseInt(m[1], 10) : null; };
// kW dallo stesso valore. Non e' un di piu': l'IPT del passaggio di proprieta' gira sui kW,
// che oggi vengono STIMATI dai CV, e sulla soglia dei 53 kW cambia la categoria di tariffa.
// Subito i kW ce li dice (chiave nativa "51/69" = kW/CV), quindi smettiamo di stimarli.
const kwFrom = s => { const m = String(s == null ? '' : s).match(/(\d+)\s*kW/i); return m ? parseInt(m[1], 10) : null; };

// La chiave grezza di una feature, quando vale piu' del testo: 'Garanzia' ha
// key="12" e value="12 mesi", e il numero e' quello che serve per fare i conti.
function featKey(ad, label) {
  const f = (ad.features || []).find(x => x.label === label);
  const v = f && f.values && f.values[0];
  return v && v.key != null ? String(v.key) : null;
}
// Le feature booleane native rispondono "Sì"/"No" (key "1"/"0"). Assente → null, che
// e' diverso da "No": un annuncio che non dichiara l'IVA non e' un annuncio senza IVA.
function featBool(ad, label) {
  const k = featKey(ad, label);
  return k == null ? null : k === '1';
}

const digits = s => { const m = String(s == null ? '' : s).replace(/\./g, '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };
const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) && y > 1900 ? y : null; };

function mapAd(ad, opts = {}) {
  const url = ad.urls && (ad.urls.default || ad.urls.mobile);
  if (!url) return null;
  // KM: il VALORE ESATTO, non la fascia. Nel payload di hades l'etichetta 'Km' compare DUE
  // volte — `/mileage` (la fascia: "95.000 - 99.999") e `/mileage_scalar` (il valore vero:
  // "98000 Km") — e la fascia viene prima. Cercando per label si prendeva sempre quella e se
  // ne teneva l'estremo inferiore: sul fixture del repo un'auto con "Km 98.000 certificati"
  // scritto dal venditore usciva come 95.000, e sopra i 200.000 l'errore arriva a -49.999.
  // Si sceglie per `uri`, come fa gia' subito-playwright.js:124 sullo stesso dato.
  // La fascia resta il RIPIEGO dichiarato: quando lo scalare non c'e', meglio l'estremo
  // inferiore che nessun chilometraggio.
  // La fascia si prende per `uri` e, se l'uri non c'e', per label ESCLUDENDO lo scalare —
  // altrimenti quando la fascia manca si ripescava lo scalare stesso e il guard sul
  // segnaposto 9999999 non serviva a niente.
  const feats = ad.features || [];
  const primoValore = f => { const v = f && f.values && f.values[0]; return v ? (v.value != null ? v.value : v.key) : null; };
  const fScal = feats.find(x => x.uri === '/mileage_scalar');
  const fFascia = feats.find(x => x.uri === '/mileage') || feats.find(x => x.label === 'Km' && x !== fScal);
  const kmEsatto = digits(primoValore(fScal));
  const fascia = primoValore(fFascia);
  const kmFascia = fascia ? digits(String(fascia).split('-')[0]) : null;
  // 9999999 e' il segnaposto di "non dichiarato" (stesso guard di subito-playwright.js:125):
  // stamparlo come chilometraggio sarebbe peggio che non stampare niente.
  const km = (kmEsatto != null && kmEsatto < 9999999) ? kmEsatto : kmFascia;
  // data pubblicazione: hades espone ad.date (ISO) — usata come posted_at.
  const posted = ad.date || (ad.dates && (ad.dates.display || ad.dates.created)) || null;
  // Condizione nativa 'Condizioni del veicolo': Nuovo/Km 0 → nuovo=true, Usato → false.
  const cond = feat(ad, 'Condizioni del veicolo');
  const nuovo = cond == null ? null : (cond === 'Nuovo' || cond === 'Km 0');
  // Neopatentati: 'Sì'/'No' nativo → bool; assente → null.
  const neo = feat(ad, 'Per neopatentati');
  // I tre livelli che l'annuncio dichiara di se'. Letti UNA volta: servono sia alla marca
  // sia alla versione, e prima si leggevano due volte in due modi diversi.
  const liv = livelliAnnuncio(ad);
  const out = {
    fonte: 'subito',
    titolo: ad.subject || 'Annuncio senza titolo',
    prezzo: digits(feat(ad, 'Prezzo')),
    km,
    anno: yearOf(feat(ad, 'Immatricolazione') || feat(ad, 'Anno di immatricolazione')),
    carburante: feat(ad, 'Carburante'),
    provincia: (ad.geo && ad.geo.city && ad.geo.city.value) || null,
    regione: (ad.geo && ad.geo.region && ad.geo.region.friendly_name) || null,   // nativa (slug già giusto)
    cambio: feat(ad, 'Cambio'),
    cilindrata: digits(feat(ad, 'Cilindrata')),
    /**
     * Versione/allestimento NATIVA. `null` quando il venditore non l'ha dichiarata — e
     * questo NON e' il caso in cui il campo manca.
     *
     * Subito non lascia il campo vuoto: ci mette il proprio segnaposto, "Altro
     * allestimento", con id 000000. Leggendolo alla lettera finiva nella scheda come se
     * fosse una versione, e sono 874 annunci su 959 senza versione (misurato su 7.431).
     * Un segnaposto stampato accanto alla potenza e ai chilometri si legge come un dato.
     */
    variante: dichiarato(liv.versione) ? liv.versione.nome : null,
    // Venditore dal boolean nativo advertiser.company (true=conce, false=privato).
    venditore: (ad.advertiser && typeof ad.advertiser.company === 'boolean')
      ? (ad.advertiser.company ? 'concessionario' : 'privato') : null,
    // CHI vende, non solo che tipo e': serve alla sezione Competitor per sapere di chi e'
    // il parco, e per accorgersi se la fonte ci mescola dentro qualcun altro.
    // La marca che l'ANNUNCIO dichiara, non la prima parola del titolo: li' "Alfa Romeo"
    // diventava "Alfa" e "Land Rover" diventava "Land".
    marca: (liv.marca || {}).nome || null,
    // Il MODELLO che l'annuncio dichiara. Lo leggevamo gia' insieme a marca e versione e lo
    // buttavamo: senza, la scheda tecnica di un annuncio doveva pescare il modello dai
    // filtri di ricerca, e in Competitor una ricerca non c'e' mai stata.
    modello: dichiarato(liv.modello) ? liv.modello.nome : null,
    venditoreId: (ad.advertiser && ad.advertiser.user_id) ? String(ad.advertiser.user_id) : null,
    venditoreNome: (ad.advertiser && (ad.advertiser.shop_name || ad.advertiser.name)) || null,
    potenzaCv: cvFrom(feat(ad, 'Potenza')),
    potenzaKw: kwFrom(feat(ad, 'Potenza')),
    // Specs ricche NATIVE (già nel payload, zero richieste extra); null se assenti.
    colore: feat(ad, 'Colore'),
    carrozzeria: feat(ad, 'Carrozzeria') || feat(ad, 'Tipologia'),   // auto / moto
    porte: feat(ad, 'Numero di porte'),       // stringa nativa "4/5"
    posti: digits(feat(ad, 'Posti')),
    classeEmissioni: feat(ad, 'Classe emissioni'),
    neopatentati: neo == null ? null : neo === 'Sì',
    /**
     * ROBA CHE ERA GIA' NELLA RISPOSTA E BUTTAVAMO. Nessuna richiesta in piu': stesso
     * payload di prima, mappato fino in fondo. Misurato su 100 annunci auto veri:
     *   Garanzia 38%, Iva esposta 24%, Mese di immatricolazione 100%, spedizione 71%,
     *   Ref. ~50% (solo concessionari), testo 86%, comune 100%.
     */
    // Per un operatore l'IVA esposta e' il prezzo vero: a parita' di cartellino, con l'IVA
    // esposta il costo per chi la detrae e' un altro numero. Assente = non dichiarato.
    ivaEsposta: featBool(ad, 'Iva esposta'),
    garanziaMesi: (() => { const k = featKey(ad, 'Garanzia'); const n = k == null ? NaN : parseInt(k, 10); return Number.isFinite(n) ? n : null; })(),
    // Il MESE di immatricolazione, non solo l'anno: fra gennaio e dicembre dello stesso
    // anno ballano dodici mesi di eta' e di garanzia residua.
    mese: (() => { const k = featKey(ad, 'Mese di immatricolazione'); const n = k == null ? NaN : parseInt(k, 10); return n >= 1 && n <= 12 ? n : null; })(),
    spedizione: featBool(ad, 'Disponibile alla spedizione'),
    // Il codice di magazzino del venditore: e' come lui chiama quel veicolo nel suo
    // gestionale, e permette di riconoscere lo stesso mezzo riesposto.
    refVenditore: feat(ad, 'Ref.'),
    descrizione: typeof ad.body === 'string' && ad.body.trim() ? ad.body.trim() : null,
    // Il COMUNE, non la provincia — con il codice ISTAT, che e' la chiave con cui si
    // aggancia qualunque dato pubblico territoriale.
    comune: (ad.geo && ad.geo.town && ad.geo.town.value) || null,
    istat: (ad.geo && ad.geo.town && ad.geo.town.istat) || null,
    // Immagini NATIVE (già nel payload, zero richieste extra): URL webp dalla CDN
    // costruiti dal cdn_base_url + rule (thumb mobile per la lista, fullscreen per lo slider).
    immagini: (Array.isArray(ad.images) ? ad.images : [])
      .filter(i => i && i.cdn_base_url)
      .slice(0, 10)
      .map(i => ({
        thumb: `${i.cdn_base_url}?rule=gallery-mobile-1x-auto`,
        full:  `${i.cdn_base_url}?rule=fullscreen-1x-auto`,
      })),
    url,
    // Campi per il DB (crawler). nuovo ora nativo da 'Condizioni'; danni non esposto.
    nuovo,
    danni: null,
    posted_at: posted,
  };
  if (opts.attachRaw) out._raw = ad;   // foto grezza per raw_json (keep-last)
  return out;
}

/**
 * LA VERSIONE CHE MANCA, letta dal testo dell'annuncio. Vedi versione-dedotta.js per il
 * come e per i numeri; qui c'e' solo l'aggancio.
 *
 * NESSUNA RICHIESTA IN PIU': il catalogo delle versioni e' gia' su disco e
 * versioni-unificate lo tiene in cache per marca. Si paga un parsing per modello, tenuto
 * qui: i nomi di un modello si parsano una volta e servono tutti i suoi annunci.
 *
 * SOLO AUTO. Sulle moto il buco non e' stato misurato e il vocabolario e' un altro
 * (li' la cilindrata e' un campo nativo, e la versione la risolve gia' risolvi-versione.js
 * contro Moto.it). Meglio niente che una deduzione mai provata.
 */
const memoVersioni = new Map();     // `tipo/marcaId/modelloId` → versioni preparate
const MEMO_MAX = 40;
function versioniPreparate(tipo, marcaId, modelloId, modelloNome) {
  const k = tipo + '/' + marcaId + '/' + modelloId;
  if (memoVersioni.has(k)) { const v = memoVersioni.get(k); memoVersioni.delete(k); memoVersioni.set(k, v); return v; }
  const dati = _perMarca(tipo, marcaId);
  const l = dati && dati[String(modelloId)];
  const out = Array.isArray(l) ? dedotta.preparaVersioni(l.map(v => v.subito && v.subito.nome), modelloNome) : null;
  memoVersioni.set(k, out);
  while (memoVersioni.size > MEMO_MAX) memoVersioni.delete(memoVersioni.keys().next().value);
  return out;
}

/** L'annuncio mappato + `versioneDedotta`, quando la versione manca e il testo la dice. */
function conVersioneDedotta(m, ad, tipo) {
  if (!m || m.variante || tipo !== 'auto') return m;
  const liv = livelliAnnuncio(ad);
  const marcaId = liv.marca && liv.marca.id;
  const mod = liv.modello;
  if (!marcaId || !mod || !mod.id || mod.id === NON_DICHIARATO) return m;
  const versioni = versioniPreparate(tipo, marcaId, mod.id, mod.nome || '');
  if (!versioni || !versioni.length) return m;
  const r = dedotta.deduci(versioni, dedotta.datiAnnuncio(m));
  return r ? { ...m, versioneDedotta: r } : m;
}

// Filtri NATIVI hades (verificati live): regione `r`, prezzo `ps`/`pe`, anno
// `ys`/`ye`, ordinamento `sort`. Mappa friendly_name→key (== `province.json.regione`,
// derivata iterando r=1..20 sull'API). Senza nativo, il filtro veniva applicato
// client-side su 2 pagine NAZIONALI → economici/regione persi (vedi piano F17).
const SUBITO_REGION_KEY = {
  'valle-d-aosta': '1', 'piemonte': '2', 'liguria': '3', 'lombardia': '4',
  'trentino-alto-adige': '5', 'veneto': '6', 'friuli-venezia-giulia': '7',
  'emilia-romagna': '8', 'toscana': '9', 'umbria': '10', 'lazio': '11',
  'marche': '12', 'abruzzo': '13', 'molise': '14', 'campania': '15',
  'puglia': '16', 'basilicata': '17', 'calabria': '18', 'sardegna': '19',
  'sicilia': '20',
};
const SORT_VALIDI = new Set(['priceasc', 'pricedesc', 'datedesc', 'relevance']);

// Km NATIVO hades: param `ms`/`me` (mileage start/end) come CHIAVE CATEGORIA 1..36,
// NON km raw (verificato live: ms/me operano sull'indice categoria, inclusivi).
// Fonte tabella: https://hades.subito.it/v1/values/mileage/max (key→soglia).
// `kmToKey(x)` = prima categoria il cui tetto ≥ x = la categoria che CONTIENE x →
// usata sia per `me` (tetto km max) sia per `ms` (bound inferiore: la categoria di kmMin).
const KM_KEY_TABLE = [
  [4999, 1], [9999, 2], [14999, 3], [19999, 4], [24999, 5], [29999, 6], [34999, 7],
  [39999, 8], [44999, 9], [49999, 10], [54999, 11], [59999, 12], [64999, 13], [69999, 14],
  [74999, 15], [79999, 16], [84999, 17], [89999, 18], [94999, 19], [99999, 20], [109999, 21],
  [119999, 22], [129999, 23], [139999, 24], [149999, 25], [159999, 26], [169999, 27],
  [179999, 28], [189999, 29], [199999, 30], [249999, 31], [299999, 32], [349999, 33],
  [399999, 34], [449999, 35], [499999, 36],
];
function kmToKey(km) {
  for (const [limit, key] of KM_KEY_TABLE) if (limit >= km) return key;
  return 36; // oltre 499.999 km
}
/**
 * Il TETTO VERO che si ottiene chiedendo `kmMax`. `me` e' una categoria, non un numero: la
 * categoria che contiene kmMax arriva fino al suo estremo superiore, quindi chiedendo 200.000
 * tornano annunci fino a 249.999. Prima non si vedeva perche' l'app stampava il fondo-fascia
 * (95.000 al posto di 98.000); ora che i km sono quelli veri, va detto invece che nascosto.
 * Null quando il tetto coincide con quello chiesto: non c'e' niente da avvertire.
 */
function kmTettoFascia(kmMax) {
  const n = Number(kmMax);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const [limit] of KM_KEY_TABLE) if (limit >= n) return limit > n ? limit : null;
  return null;   // oltre 499.999 il tetto non e' dichiarato
}
/**
 * Lo stesso, sul lato basso. `ms` e' anch'esso una CATEGORIA, quindi il minimo vero e' l'INIZIO
 * della fascia che contiene kmMin: chiedendo 22.000 tornano annunci da 20.000 in su, cioe' fino
 * a 4.999 km sotto quello chiesto (49.999 sopra i 200.000). Finora non si notava perche' l'app
 * stampava il fondo-fascia; ora che i km sono quelli veri, quegli annunci si vedono e vanno
 * spiegati. Null quando il numero chiesto cade esattamente sull'inizio di una fascia — con i
 * numeri tondi (20.000, 25.000, 30.000) non c'e' niente da avvertire.
 */
function kmPavimentoFascia(kmMin) {
  const n = Number(kmMin);
  if (!Number.isFinite(n) || n <= 0) return null;
  let inizio = 0;
  for (const [limit] of KM_KEY_TABLE) {
    if (limit >= n) return inizio < n ? inizio : null;
    inizio = limit + 1;
  }
  return null;   // oltre 499.999 non c'e' una fascia superiore da dichiarare
}

/**
 * I nomi dei parametri NON sono gli stessi per auto e moto. Sbagliarli non da' errore:
 * da' zero risultati, che si legge come "questa fonte non ha niente".
 *   auto  cb = marca   cm = famiglia      moto  bb = marca   bm = modello
 */
const PARAM = {
  auto: { marca: 'cb', modello: 'cm', versione: 'cv' },
  moto: { marca: 'bb', modello: 'bm', versione: 'bv' },
};
/** Il segnaposto "Altro modello"/"Altro allestimento": il venditore non l'ha dichiarato. */
const NON_DICHIARATO = '000000';

/**
 * Il valore per il parametro-modello. Sulle auto la virgola unisce piu' voci (verificato:
 * `cm=001704,000000` → 1618 = 1250 + 368, la somma esatta). Sulle moto la stessa virgola
 * risponde 400 — il menu di Subito per le moto dichiara il solo filtro marca, e la lettura
 * multi-valore li' non l'hanno mai scritta. Quindi: auto tutte, moto la prima.
 */
function valoreModello(tipo, ids) {
  if (!ids || !ids.length) return null;
  return tipo === 'moto' ? String(ids[0]) : ids.map(String).join(',');
}

function buildPath(params, start) {
  const c = CAT[params.tipo] || CAT.auto;
  const qs = new URLSearchParams({ c, t: 's', lim: String(PAGE_SIZE), start: String(start) });
  // Ricerca per ID quando il nodo e' risolto; testo libero quando non lo e'. Di regola mai
  // i due insieme: `q` restringerebbe ancora sul titolo, e un venditore che scrive "Sv650"
  // nel titolo verrebbe escluso da una ricerca che per id lo trova.
  //
  // L'ECCEZIONE, e vale solo dove il nodo la porta scritta (backend/scrapers/ponte-buchi.js):
  // i modelli che stanno DENTRO una famiglia Subito invece di esserle pari. Chiedendo la
  // sola famiglia, le Golf sono 11.646 e le GTI nei primi cento erano UNA; con `q=gti`
  // l'insieme scende a 1.631 e la finestra si riempie di candidate. Verificato che i due
  // parametri lavorano insieme, e che il costo resta di una richiesta.
  const nodo = params.subitoNodo;
  const p = PARAM[params.tipo === 'moto' ? 'moto' : 'auto'];
  /**
   * IL PARCO DI UN VENDITORE. `uid` e' l'id UTENTE (advertiser.user_id), non l'id del
   * negozio che sta nell'URL della vetrina: su un negozio provato erano 1398723 e 7798,
   * due numeri diversi, e usare quello sbagliato non da' errore — da' il catalogo intero.
   * Verificato: uid=1398723 → 27 auto + 1 moto, tutte sue.
   *
   * Esce prima di tutto il resto: qui non si cerca un modello, si chiede una vetrina.
   */
  if (params.subitoUid) {
    qs.set('uid', String(params.subitoUid));
    if (params._sort && SORT_VALIDI.has(params._sort)) qs.set('sort', params._sort);
    return `/v1/search/items?${qs.toString()}`;
  }
  if (nodo && nodo.marcaId) {
    qs.set(p.marca, String(nodo.marcaId));
    const v = params.subitoSoloNonDichiarati
      ? NON_DICHIARATO                       // la passata di RECUPERO, vedi scrapeSubitoApi
      : valoreModello(params.tipo, nodo.famigliaIds);
    if (v) qs.set(p.modello, v);
    /**
     * DUE TESTI, UNO SOLO `q`. Sono cose diverse e vanno tenute distinte:
     *   `nodo.testo`             il MODELLO che vive dentro una famiglia ("Golf GTI"
     *                            dentro Golf) — vedi ponte-buchi.js. Ha anche un controllo
     *                            a valle in `riconosci`, senza il quale "Golf GTI"
     *                            tornerebbe a pescare tutte le Golf.
     *   `versioneTesto`          la VERSIONE scritta a mano nel campo. Restringe e basta:
     *                            nessun controllo nostro dopo, la fonte risponde e si mostra.
     * Insieme restringono di piu', ed e' corretto: sono due vincoli diversi.
     */
    const q = [nodo.testo, params.subitoVersioneTesto].filter(Boolean).join(' ').trim();
    if (q) qs.set('q', q);
    /**
     * LA VERSIONE NON SI CHIEDE PIU' PER ID. `cv`/`bv` accettano un id solo e filtrano
     * benissimo — verificato, 50 annunci su 50 dichiarano esattamente quella versione —
     * ma il campo versione ora e' testo libero: quello che scrivi va in `q` qui sopra,
     * e chi resta lo decide la fonte. Vedi il commento in cima a buildPath.
     * L'id resta nel catalogo e serve altrove (la versione dedotta lo legge); qui non
     * arriva piu' nessuno a passarlo, e un ramo che nessuno percorre e' un ramo che un
     * giorno qualcuno riaccende senza sapere perche' era spento.
     */
  } else {
    const q = [params.marca, params.modello].filter(Boolean).join(' ').trim();
    if (q) qs.set('q', q);
  }
  // Regione nativa (se mappabile; altrimenti resta il post-filtro client difensivo).
  const regKey = params.regione && SUBITO_REGION_KEY[String(params.regione).trim().toLowerCase()];
  if (regKey) qs.set('r', regKey);
  // Prezzo/anno nativi (i post-filtri client restano come doppia rete).
  if (params.prezzoMin != null) qs.set('ps', String(params.prezzoMin));
  if (params.prezzoMax != null) qs.set('pe', String(params.prezzoMax));
  if (params.annoMin   != null) qs.set('ys', String(params.annoMin));
  if (params.annoMax   != null) qs.set('ye', String(params.annoMax));
  // Km nativo (categoria): ms=bound inferiore (categoria di kmMin), me=tetto (categoria di kmMax).
  if (params.kmMin     != null) qs.set('ms', String(kmToKey(params.kmMin)));
  if (params.kmMax     != null) qs.set('me', String(kmToKey(params.kmMax)));
  // Ordinamento: solo se richiesto esplicitamente (on-search='priceasc'); il crawler
  // NON lo passa → ordine naturale invariato (vista profonda/truncated intatta).
  if (params._sort && SORT_VALIDI.has(params._sort)) qs.set('sort', params._sort);
  return `/v1/search/items?${qs.toString()}`;
}

// F50 — totale per-query = `count_all` della risposta hades (oggi ignorato).
// = quanti annunci Subito HA per la query (tetto copertura). null se assente.
function extractTotal(j) {
  const n = j && j.count_all;
  return Number.isFinite(n) ? n : null;
}

async function fetchPage(params, start) {
  const res = await httpGetJson(buildPath(params, start));
  if (res.status !== 200) throw fail(`Subito hades HTTP ${res.status}`, { status: res.status, kind: kindForStatus(res.status) });
  let j;
  try { j = JSON.parse(res.body); } catch (_) { throw fail('Subito hades: body non-JSON (blocco?)', { status: res.status, kind: 'blocked' }); }
  if (j.errors) throw fail('Subito hades errors: ' + JSON.stringify(j.errors).slice(0, 100), { kind: 'error' });
  return { ads: Array.isArray(j.ads) ? j.ads : [], total: extractTotal(j) };
}

/**
 * Annunci Subito via API. Throw su errore → fallback Playwright.
 * @param opts.maxPages  override profondità (crawler: 10-20; on-search: 2)
 * @param opts.attachRaw allega `_raw` (foto grezza) per il DB
 * @param opts.withMeta  ritorna {items, truncated} invece dell'array (back-compat).
 *                       truncated=true se fermato al cap con ultima pagina PIENA
 *                       (vista parziale → il crawler NON deve rilevare venduti).
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * La GENERAZIONE, che Subito non sa filtrare ma ogni annuncio dichiara.
 *
 * Non esiste un parametro per "Passat 5ª serie": il menu di Subito si ferma alla
 * famiglia. Ma il livello e' dentro l'annuncio, misurato su 400 annunci: 400 lo
 * dichiarano, il 100%. Quindi si filtra qui invece di chiederlo alla fonte —
 * precisione piena e zero richieste in piu'.
 *
 * Ritorna null se l'annuncio va scartato, altrimenti come si e' riconosciuto.
 */
function riconosci(ad, nodo, opts = {}) {
  if (!nodo || !nodo.marcaId) return 'testo-libero';
  const liv = livelliAnnuncio(ad);
  if (liv.marca && liv.marca.id !== String(nodo.marcaId)) return null;   // altra marca: mai
  /**
   * La VERSIONE, quando l'utente ne ha scelta una. Non si chiede alla fonte (`cv`
   * butterebbe il 23% di annunci che la versione non la dichiarano): si guarda quella
   * che l'annuncio dichiara di se'.
   *   la stessa versione   → esatto
   *   un'altra versione    → fuori, e' un altro allestimento
   *   nessuna dichiarata   → RESTA, marcato: e' spesso l'annuncio compilato male,
   *                          cioe' dove sta l'affare
   */
  const versione = liv => {
    const dichiarata = liv.versione && liv.versione.id !== NON_DICHIARATO;
    // Il modello che vive DENTRO la famiglia (Golf GTI dentro Golf): l'utente ha chiesto
    // le GTI, non le Golf. Qui la versione dichiarata E' il modello, quindi si guarda
    // quella. Chi non l'ha dichiarata resta marcato: `q` alla fonte gli ha gia' letto
    // il titolo. Vedi backend/scrapers/ponte-buchi.js.
    // IL TESTO DEL PONTE isola il modello dentro la famiglia (Golf GTI dentro Golf).
    // NON e' il campo versione: quello va in `q` e basta, e non filtra qui.
    if (nodo.testo) {
      if (!dichiarata) return 'senza-versione';
      return diceIlTesto(nodo.testo, liv.versione.nome) ? 'esatto' : null;
    }
    return dichiarata ? 'esatto' : 'senza-versione';
  };

  const ammessi = opts.generazioni;
  if (!ammessi || !ammessi.size) return versione(liv);
  if (liv.modello && ammessi.has(liv.modello.id)) return versione(liv);
  if (!liv.modello || liv.modello.id === NON_DICHIARATO) {
    // Il venditore non ha dichiarato il modello. E' la passata di recupero: si tiene solo
    // se il TITOLO nomina il modello, e resta marcato — non e' una corrispondenza certa.
    return opts.titoloCombacia && opts.titoloCombacia(ad) ? 'senza-modello' : null;
  }
  return null;                                                          // altro modello dichiarato
}

/**
 * La versione dichiarata dice il testo cercato? Parola intera e nell'ordine scritto —
 * "Cooper S" deve stare attaccato, altrimenti ogni "Cooper" con una S da qualche parte
 * passerebbe. Il confine serve perche' "One" non deve pescare "One-derful" ne' "Stone".
 */
const cacheTesto = new Map();
function diceIlTesto(testo, nome) {
  let re = cacheTesto.get(testo);
  if (!re) {
    const t = String(testo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    re = new RegExp('(^|[^a-z0-9])' + t.replace(/[^a-z0-9]+/g, '[^a-z0-9]+') + '([^a-z0-9]|$)', 'i');
    cacheTesto.set(testo, re);
  }
  return re.test(String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

/** Il titolo nomina il modello cercato? Parole intere, tutte presenti. */
function faTitolo(testo) {
  const parole = String(testo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1);
  if (!parole.length) return null;
  return ad => {
    const t = String((ad && ad.subject) || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return parole.every(w => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t));
  };
}

/** Recupero per marca: la stessa lista serve OGNI modello di quella marca → in cache. */
const RECUPERO_TTL = 10 * 60 * 1000;
const recuperoCache = new Map();   // `${tipo}|${marcaId}` → { ts, ads }

async function paginaRecupero(params) {
  /**
   * LA CHIAVE DEVE CONTENERE TUTTO QUELLO CHE ENTRA NELLA RICHIESTA. Con `tipo|marca` la
   * stessa lista veniva riusata per dieci minuti anche cambiando regione, prezzo, anno,
   * chilometri o testo: cerchi, stringi un filtro, ricerchi, e ti torna la lista di prima.
   * Sui chilometri, che a valle non si ricontrollano per scelta, entravano annunci fuori
   * dal filtro impostato.
   */
  const chiave = [params.tipo, params.subitoNodo.marcaId, params.regione, params.prezzoMin, params.prezzoMax,
    params.annoMin, params.annoMax, params.kmMin, params.kmMax, params.sort,
    params.subitoVersioneTesto, (params.subitoNodo && params.subitoNodo.testo) || ''].join('|');
  const hit = recuperoCache.get(chiave);
  if (hit && Date.now() - hit.ts < RECUPERO_TTL) return hit.ads;
  const page = await fetchPage({ ...params, subitoSoloNonDichiarati: true }, 0);
  recuperoCache.set(chiave, { ts: Date.now(), ads: page.ads });
  if (recuperoCache.size > 200) recuperoCache.delete(recuperoCache.keys().next().value);
  return page.ads;
}

async function scrapeSubitoApi(params, opts = {}) {
  const regione = params.regione ? String(params.regione).trim().toLowerCase() : null;
  const maxPages = opts.maxPages || MAX_PAGES;
  const pageDelay = opts.pageDelayMs || 0;   // pausa tra le pagine (anti-ban su crawl profondi)
  // Ordinamento esplicito (on-search passa 'priceasc' per le occasioni in cima).
  // Il crawler NON passa opts.sort → ordine naturale, vista profonda invariata.
  const reqParams = opts.sort ? { ...params, _sort: opts.sort } : params;
  const nodo = params.subitoNodo || null;
  // `tipo` qui serve solo alla versione dedotta, e le categorie accessori NON sono veicoli:
  // vanno lasciate fuori esplicitamente, altrimenti il ramo di default le farebbe passare
  // per auto e si cercherebbe un modello dentro un annuncio di pastiglie freno.
  const tipo = params.tipo === 'moto' ? 'moto' : (!params.tipo || params.tipo === 'auto') ? 'auto' : null;
  const gen = new Set((nodo && nodo.generazioni || []).map(g => String(g.id)));
  const titoloCombacia = faTitolo(params.modello);
  const rico = { generazioni: gen, titoloCombacia };
  const out = [];
  let truncated = false;
  let total = null;                          // F50 count_all (tetto), additivo
  let scartati = 0;
  // "Carica altri": si riparte da dove si era arrivati. Il tetto di hades sta fra
  // start 9.850 e 10.000 (misurato per bisezione), quindi c'e' spazio per ~200 fette.
  const salta = Math.max(0, opts.fetta || 0) * maxPages * PAGE_SIZE;
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && pageDelay) await sleep(pageDelay);   // mai raffica di pagine
    const page = await fetchPage(reqParams, salta + p * PAGE_SIZE);
    if (p === 0) total = page.total;         // count_all dalla 1ª pagina (uguale su tutte)
    for (const ad of page.ads) {
      // Doppia rete regione: `buildPath` filtra già nativo via `r=<key>` quando la
      // regione è mappabile; questo post-filtro client copre i casi non mappati.
      if (regione) {
        const r = ad.geo && ad.geo.region && ad.geo.region.friendly_name;
        if (r && r.toLowerCase() !== regione) continue;
      }
      const come = riconosci(ad, nodo, rico);
      if (!come) { scartati++; continue; }
      const m = conVersioneDedotta(mapAd(ad, opts), ad, tipo);
      if (m && m.prezzo != null) out.push(come === 'testo-libero' ? m : { ...m, dichiarazione: come });
    }
    if (page.ads.length < PAGE_SIZE) break;  // lista esaurita = vista completa
    if (p === maxPages - 1) truncated = true; // ultima pagina piena al cap → forse altro
  }

  // RECUPERO. Cercando per id, gli annunci che il venditore ha archiviato come "Altro
  // modello" diventano irraggiungibili: misurati sul 3,7% del totale, e sono spesso
  // quelli compilati male — cioe' dove sta l'affare. Una richiesta in piu', per MARCA
  // e in cache: la stessa lista serve ogni modello di quella marca.
  // Il recupero gira SOLO sulla prima fetta: non e' paginato, e sulle fette successive
  // rimandava indietro gli stessi annunci. Misurato: 9 doppioni su 109 a ogni "carica altri".
  if (nodo && nodo.marcaId && gen.size && titoloCombacia && !opts.senzaRecupero && !salta) {
    try {
      const visti = new Set(out.map(x => x.url));
      for (const ad of await paginaRecupero(reqParams)) {
        if (regione) {
          const r = ad.geo && ad.geo.region && ad.geo.region.friendly_name;
          if (r && r.toLowerCase() !== regione) continue;
        }
        if (riconosci(ad, nodo, rico) !== 'senza-modello') continue;
        const m = conVersioneDedotta(mapAd(ad, opts), ad, tipo);
        if (m && m.prezzo != null && !visti.has(m.url)) { visti.add(m.url); out.push({ ...m, dichiarazione: 'senza-modello' }); }
      }
    } catch (e) {
      // Il recupero e' un di piu': se cade, la ricerca vale lo stesso.
      console.warn('[subito] recupero non dichiarati KO: ' + e.message);
    }
  }
  if (nodo && scartati) console.log(`[subito] per id "${params.marca} ${params.modello || ''}": ${out.length} tenuti, ${scartati} scartati (altro modello)`);
  return opts.withMeta ? { items: out, truncated, total } : out;
}

// Ricerca ACCESSORI/RICAMBI per keyword libera (OEM o nome pezzo) nelle categorie
// Accessori Auto (c=5) + Accessori Moto (c=36). Riusa scrapeSubitoApi (path API, no CAPTCHA).
// La keyword viaggia su `marca` (buildPath fa q=marca+modello). Ritorna item mapAd (shape Subito).
// opts.cat = 'auto' | 'moto' → interroga SOLO quella categoria (un ricambio è per auto O per moto).
// Lancia solo se TUTTE le categorie interrogate falliscono (una KO → torna quel che c'è).
async function searchAccessori(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const { cat, ...rest } = opts;
  const cats = cat === 'auto' ? ['accessoriAuto'] : cat === 'moto' ? ['accessoriMoto'] : ['accessoriAuto', 'accessoriMoto'];
  const res = await Promise.allSettled(cats.map(tipo =>
    scrapeSubitoApi({ marca: kw, tipo }, { maxPages: 1, sort: 'priceasc', ...rest })));
  const items = res.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const rejected = res.find(r => r.status === 'rejected');
  // 0 item MA almeno una categoria bloccata → propaga (runSource → 'error', non cachato come 'empty').
  // both-fulfilled con 0 item = vuoto legittimo → return [].
  if (!items.length && rejected) throw rejected.reason;
  return items;
}

module.exports = scrapeSubitoApi;
module.exports.searchAccessori = searchAccessori;
module.exports._mapAd = mapAd;
module.exports._buildPath = buildPath;
module.exports._extractTotal = extractTotal;   // F50 copertura
module.exports._riconosci = riconosci;         // filtro sui livelli dichiarati dall'annuncio
module.exports._faTitolo = faTitolo;
// Quanto e' largo DAVVERO il filtro km chiesto, sui due lati: `ms` e `me` sono categorie.
module.exports.kmTettoFascia = kmTettoFascia;
module.exports.kmPavimentoFascia = kmPavimentoFascia;
