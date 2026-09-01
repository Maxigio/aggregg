'use strict';
/**
 * Scraper AS24 via API GraphQL ufficiale (listing-search.api.autoscout24.com).
 *
 * Path PRIMARIO per Autoscout24: single POST autenticato → dati strutturati,
 * niente browser/DataDome, paginazione vera (size 50), filtro Italia + prezzo
 * server-side. Se l'API fallisce (401 = credenziale ruotata, errori, blocco)
 * → throw, così server.js fa fallback allo scraper Playwright (autoscout-playwright).
 *
 * Credenziale: header Basic STATICO embeddato nel frontend AS24 (client pubblico
 * `as24-search-funnel`). Non è un nostro segreto; se smette (401) → fallback +
 * ri-catturare dal Network tab di autoscout24.it.
 */
const https = require('https');
const annullo = require('../annullo');

const { kindForStatus, fail } = require('./utils');   // classificazione salute crawler (F1.5)
const budget = require('../budget-richieste');  // conta le richieste, non le limita
const filtriAuto = require('../filtri-auto');   // filtri avanzati auto → campi Vehicle_
// L'UNICO risolutore di provincia del progetto: valida contro le 107 sigle vere e non
// sceglie fra due indizi che si contraddicono. Lo usano entrambi i rami AS24.
const { risolvi: risolviProvincia } = require('../province-sigla');
const provinciaSigla = (testo, cap) => { const r = risolviProvincia(testo, cap); return r ? r.sigla : null; };

const HOST = 'listing-search.api.autoscout24.com';
const AUTH = 'Basic YXMyNC1zZWFyY2gtZnVubmVsOnZucmZiYkJqSTMyT2wxV2thNnVOSFJwM0VZbjRkag==';
const PAGE_SIZE = 50;
const MAX_PAGES = 2;          // 2×50 = 100 (più del path Playwright: 3×~17)
const TIMEOUT_MS = 15000;

/**
 * Query ridotta ai soli campi mappati (+ media.images webp per lo slider; no leasing/360).
 *
 * LA SECONDA META' DEI CAMPI NON COSTA UNA RICHIESTA IN PIU'. E' la stessa POST di prima:
 * chiedere venti campi o quaranta cambia il peso della risposta, non il conto delle chiamate.
 * L'introspezione dello schema e' aperta, quindi non si tira a indovinare — e ogni campo qui
 * sotto e' stato MISURATO su 100 annunci italiani veri prima di essere aggiunto:
 *
 *   equipment.as24 58%   description 86%   evaluation 34%   leadsRange 100%
 *   interior 86%   emptyWeight 60%   taxDeductible 100%   accidentFree 100%
 *   manutenzione (revisione/cinghia/tagliandi) 2-8% — c'e', ma quasi nessuno la compila
 *
 * NON chiesti, perche' misurati VUOTI su tutti e 100: germanHsnTsn, modelYear,
 * suggestedRetail, superDeal, carpassMileageUrl, costModel, dpvStatistics (favorites e
 * interaction rispondono 0 sempre). Meglio non chiederli che mostrarli sempre vuoti.
 */
const QUERY = `query Search($v:Vehicle_,$loc:Location_,$pr:Price_,$m:Metadata_,$cu:Customer_){
  search{ listings(vehicle:$v, location:$loc, price:$pr, metadata:$m, customer:$cu, locale:it_IT){
    metadata{ totalItems }
    listings{ details(withFallbackAttributes:true){
      webPage
      description
      publication{ createdTimestampWithOffset }
      prices{ public{ amountInEUR{ raw } netAmountInEUR{ raw } vatRate negotiable taxDeductible onRequestOnly
                      evaluation{ category median equipmentCount } } }
      warranty{ warrantyExists generic{ durationInMonth{ raw } } }
      statistics{ leadsRange }
      location{ city zip }
      seller{ type id companyName }
      media{ images(with360Images:false, first:5){ __typename ... on StandardImage{ formats{ webp{ size420x315 size800x600 } } } } }
      vehicle{
        classification{ make{ formatted } model{ formatted } modelVersionInput
                        modelGeneration{ formatted } modelVariant{ formatted } motorType{ formatted } trimLine{ formatted } }
        condition{ mileageInKm{ raw } firstRegistrationDate{ formatted } numberOfPreviousOwnersExtended{ raw }
                   nonSmoking damage{ isCurrentlyDamaged accidentFree isRoadworthy } }
        maintenance{ nextVehicleSafetyInspection{ formatted } lastBeltServiceDate{ formatted }
                     hasFullServiceHistory{ formatted } lastTechnicalServiceDate{ formatted } }
        equipment{ as24{ id{ formatted } equipmentCategory{ formatted } } }
        interior{ numberOfSeats upholstery{ formatted } }
        engine{ transmissionType{ formatted } engineDisplacementInCCM{ raw } power{ hp{ raw } } numberOfCylinders }
        fuels{ primary{ type{ raw formatted } } fuelCategory{ formatted } }
        bodyColor{ formatted }
        bodyType{ formatted }
        emptyWeight{ raw }
        alloyWheelInches{ raw }
        originalMarket{ formatted }
        productionDate{ formatted }
        usageState
      }
    } }
  } }
}`.replace(/\s+/g, ' ');

/**
 * Il modello che AS24 DICHIARA e' quello cercato?
 *
 * Confronto per INSIEME di parole, non per sottostringa: AS24 scrive "390 Duke" dove
 * l'utente scrive "Duke 390" — stessa moto, ordine diverso. E la sottostringa e' la
 * trappola di sempre: "r12" si trova dentro "gsr125".
 *
 * Un insieme contenuto nell'altro basta, perche' le due fonti hanno granularita'
 * diverse: AS24 tiene "Bonneville T100" dove Subito ha "Bonneville" + versione T100.
 * `Altro` e' il secchio catch-all di AS24: non dice niente, quindi non decide.
 */
const parole = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);
function combaciaModello(dichiarato, cercato) {
  if (/^(altro|other)$/i.test(String(dichiarato || '').trim())) return null;   // non si sa
  const A = new Set(parole(dichiarato)), B = new Set(parole(cercato));
  if (!A.size || !B.size) return null;
  if ([...B].every(w => A.has(w)) || [...A].every(w => B.has(w))) return true;
  // Chi scrive "sv650" attaccato intende "SV 650": le parole non combaciano ma la
  // scritta si'. UGUAGLIANZA senza separatori, mai contenimento — "gsr125" contiene
  // "r12" e sono due moto diverse.
  const senzaSpazi = s => parole(s).join('');
  return senzaSpazi(dichiarato) === senzaSpazi(cercato);
}

function httpPost(body, auth = AUTH) {
  budget.conta('as24');
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      // Ricerca abbandonata (timeout) → la presa si chiude, invece di restare aperta verso
      // Autoscout a scaricare una risposta che nessuno leggera'. Vedi backend/annullo.js.
      signal: annullo.segnale(),
      host: HOST, path: '/graphql', method: 'POST',
      headers: {
        'authorization': auth,
        'content-type': 'application/json',
        'accept': '*/*',
        'origin': 'https://www.autoscout24.it',
        'referer': 'https://www.autoscout24.it/',
        'x-culture': 'it-IT', 'culture': 'it-IT',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1',
        'content-length': data.length,
      },
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
      // Se la presa cade DOPO gli header, l'errore esce su `res`, non su `req`: senza questi due
      // la Promise resta appesa per sempre (e req.setTimeout non scatta a connessione chiusa).
      res.on('error', e => reject(fail(e.message, { kind: 'transient' })));
      res.on('aborted', () => reject(fail('risposta interrotta', { kind: 'transient' })));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
    req.write(data); req.end();
  });
}

// Variabili dalla nostra params. classification: make/model = ID numerici del
// catalogo (mmmvAutoscout = "makeId|modelId|...", brand-only = "makeId|||").
function buildVariables(params, page, opts = {}) {
  /**
   * IL PARCO DI UN CONCESSIONARIO. Qui non si cerca un modello: si chiede tutto quello
   * che un venditore ha in vetrina, e il filtro e' `customer.id` — verificato su quattro
   * concessionari veri, torna solo roba loro.
   *
   * Esce prima perche' senza marca `buildVariables` si fermerebbe: e' proprio il caso in
   * cui una marca non c'e' e non deve esserci.
   */
  if (params.as24Customer) {
    return finisci({ vehicleType: [params.tipo === 'moto' ? 'Bike' : 'Car'] }, params, page, opts);
  }

  const mmmv = String(params.autoscoutMmmv || params.mmmvAutoscout || '');
  const [makeStr, modelStr] = mmmv.split('|');
  const make = parseInt(makeStr, 10);
  const model = parseInt(modelStr, 10);
  if (!make) return null;   // senza makeId non interroghiamo l'API

  const classification = { make };
  if (model) classification.model = model;

  /**
   * PIU' MODELLI IN UNA QUERY SOLA — la traduzione di livello (vedi as24-modelli.js).
   * Su Subito "Serie 3" e' una voce, su Autoscout sono undici modelli perche' li' il
   * motore E' il modello. `classification` e' una lista, e AS24 la tratta in OR:
   * verificato live, 316+318+320 torna un misto dei tre. Una richiesta, non tre.
   * Il filtro testuale non si applica qui: con i codici non serve indovinare le grafie.
   */
  const multi = (params.autoscoutModelli || [])
    .map(m => { const p = String(m).split('|'); return { make: parseInt(p[0], 10), model: parseInt(p[1], 10) }; })
    .filter(x => x.make && x.model);
  if (multi.length > 1) {
    // Il testo-versione vale anche qui. Prima non ci arrivava: questo ramo usciva prima
    // della riga che lo imposta, quindi su "Serie 3" (undici modelli in una query) la
    // versione scelta spariva senza dirlo.
    const conTesto = params.autoscoutVersionText
      ? multi.map(c => ({ ...c, modelVersionInput: String(params.autoscoutVersionText) }))
      : multi;
    const v0 = { classification: conTesto, vehicleType: [params.tipo === 'moto' ? 'Bike' : 'Car'] };
    return finisci(v0, params, page, opts);
  }

  // Filtro testuale NATIVO AS24 (F50 fase 1): usato per i modelli senza codice-modello.
  // Verificato live: cerca sia in classification.model sia in modelVersionInput, per
  // parola intera, più token in AND, case-insensitive, senza wildcard.
  if (params.autoscoutVersionText) classification.modelVersionInput = String(params.autoscoutVersionText);

  return finisci({
    classification: [classification],
    vehicleType: [params.tipo === 'moto' ? 'Bike' : 'Car'],   // niente moto nelle ricerche auto e viceversa
  }, params, page, opts);
}

/**
 * Il resto delle variabili — luogo, pagina, km, anno, prezzo. Separato perche' ci si
 * arriva da due strade (un modello solo o la lista tradotta) e i filtri devono essere
 * IDENTICI: un ramo che dimentica l'anno darebbe risultati fuori intervallo senza che
 * si veda.
 */
function finisci(v, params, page, opts) {
  const loc = { country: ['Italy'] };
  // Regione AS24 NATIVA = location + raggio (come il sito ufficiale: per "Lombardia"
  // manda zip="Lombardia (italy)" + zipr + lat/lon del capoluogo). `params.autoscoutGeo`
  // è risolto da server.js dai centroidi-regione. Sostituisce il vecchio post-filtro.
  if (params.autoscoutGeo && params.autoscoutGeo.lat != null) {
    loc.position = { latitude: params.autoscoutGeo.lat, longitude: params.autoscoutGeo.lng };
    if (params.autoscoutGeo.radius) loc.radius = params.autoscoutGeo.radius;
    if (params.autoscoutGeo.zip)    loc.zip = [params.autoscoutGeo.zip];
  }
  const m = { page, size: PAGE_SIZE };
  // Crawler: ordina per età crescente (Age Asc = più recenti prima) per non
  // sprecare le prime pagine sugli annunci-civetta a basso prezzo (sort default
  // = prezzo crescente). enum passati come stringhe via variabili.
  if (opts.sortByDate) m.sort = [{ field: 'Age', order: 'Asc' }];

  // Km + anno NATIVI (input Vehicle_, verificati via introspezione + query live):
  //  - mileageInKm: IntRange {from,to} in km raw.
  //  - firstRegistration: IntRange {from,to} in formato yyyymmdd (modelYear è vuoto
  //    per le auto → inutile). Cosi l'anno è filtrato alla fonte: pagina 1 già in-range,
  //    niente più hack sort-by-date + maxPages in server.js.
  if (params.kmMin != null || params.kmMax != null) {
    // `?? ` e non `||`: kmMax=0 ("solo km zero") e' un tetto valido, con `||` spariva.
    v.mileageInKm = { from: params.kmMin ?? 0, to: params.kmMax ?? 100000000 };
  }
  if (params.annoMin != null || params.annoMax != null) {
    v.firstRegistration = {
      from: (params.annoMin || 1900) * 10000 + 101,
      to:   (params.annoMax || 2100) * 10000 + 1231,
    };
  }

  /**
   * I FILTRI AVANZATI DELLE AUTO. La traduzione sta in backend/filtri-auto.js, dove sono
   * scritte anche le trappole di questa fonte: `power` e' in kW (non CV) ed `emissionClass`
   * vuole un valore SINGOLO e vale come "almeno".
   */
  Object.assign(v, filtriAuto.perAutoscout(params.filtriAuto));

  const vars = { v, loc, m };
  if (params.as24Customer) vars.cu = { id: parseInt(params.as24Customer, 10) };
  if (params.prezzoMin != null || params.prezzoMax != null) {
    vars.pr = { price: { from: params.prezzoMin || 1, to: params.prezzoMax || 100000000 } };
  }
  return vars;
}

const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) ? y : null; };

// Mezzo schema AS24 e' fatto di { formatted } — questa e' la scorciatoia per leggerli
// senza scrivere venti volte lo stesso `x && x.formatted || null`.
const fmt = x => (x && typeof x.formatted === 'string' && x.formatted.trim()) || null;

/**
 * Il peso a vuoto arriva IN DUE UNITA' DIVERSE, nello stesso campo e nella stessa
 * risposta. Misurato su 65 Golf: 34 valori sono tonnellate (1.441, 1.2, 1.081) e 31
 * sono chilogrammi (1322, 1413, 1760). Senza normalizzare, la scheda scriveva
 * "1,441 kg" accanto a "1.760 kg" e sembravano due auto di peso simile.
 *
 * Regola: si converte solo se c'e' una parte decimale E il numero sta sotto 10. Il
 * secondo pezzo serve per le moto — uno scooter da 90,5 kg ha la virgola ma non e'
 * mezza tonnellata, e moltiplicarlo darebbe 90 quintali.
 */
function pesoKg(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n < 10 && !Number.isInteger(n)) ? Math.round(n * 1000) : Math.round(n);
}

// Il testo dell'annuncio: <br> diventa una riga vera, il resto dei tag sparisce, le
// entita' tornano lettere. Poi chi lo mostra lo escapa: qui si toglie il markup, non
// si autorizza a stamparlo.
function testoPulito(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const t = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
  return t || null;
}

const DAMAGED = new Set(['HadAccident', 'Wreck']);

function mapListing(node, opts = {}) {
  const dt = node && node.details;
  if (!dt) return null;
  const pub = dt.prices && dt.prices.public;
  /**
   * "PREZZO SU RICHIESTA" NON E' UN ANNUNCIO DA BUTTARE. Scartandolo qui spariva anche
   * dall'elenco degli annunci VISTI che il crawler passa a `markGone`: un annuncio ancora
   * in vetrina che toglieva il cartellino risultava non visto per due passate e finiva
   * archiviato come venduto, con tanto di data di uscita. Ora esce con il prezzo a `null` e
   * lo dichiara — il DB lo salta da solo (`listings-repo.js`: `it.prezzo == null` → skip),
   * ma resta fra i visti e nessuno lo dichiara venduto.
   */
  const suRichiesta = !!(pub && pub.onRequestOnly);
  const prezzo = pub && pub.amountInEUR ? pub.amountInEUR.raw : null;
  if (prezzo == null && !suRichiesta) return null;

  const v = dt.vehicle || {};
  const c = v.classification || {};
  const make = (c.make && c.make.formatted) || '';
  const variante = c.modelVersionInput || null;
  // Il nome-modello AS24 c'è SEMPRE; l'allestimento è vuoto nel ~74% degli annunci moto (misurato).
  // Prima il titolo restava la sola marca ("Yamaha") e il post-filter di server.js lo scartava:
  // Ducati "Monster" sopravviveva su 1 annuncio su 50. Il vecchio `|| model.formatted` era codice
  // morto (`make` è sempre presente, quindi il join non è mai vuoto).
  // Saltato quando: bucket catch-all "Altro" (rumore, ~12% annunci) o già contenuto nell'allestimento.
  const modelName = (c.model && c.model.formatted) || '';
  const nkey = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const modelPart = !modelName || /^(altro|other)$/i.test(modelName.trim())
                 || (variante && nkey(modelName) && nkey(variante).includes(nkey(modelName)))
    ? '' : modelName;
  const titolo = [make, modelPart, variante].filter(Boolean).join(' ') || 'Annuncio senza titolo';
  const ccm = v.engine && v.engine.engineDisplacementInCCM ? v.engine.engineDisplacementInCCM.raw : null;
  const usage = v.usageState || null;   // New | Used | HadAccident | Wreck

  // Specs ricche NATIVE (una sola query, zero richieste extra). null se assenti.
  const eng = v.engine || {};
  const cond = v.condition || {};
  const hp = eng.power && eng.power.hp ? eng.power.hp.raw : null;
  const dmg = cond.damage;                                  // { isCurrentlyDamaged } | null
  const sellerType = (dt.seller && dt.seller.type) || '';   // 'PrivateSeller' | 'Dealer'
  // Chi vende, non solo che tipo e': serve alla sezione Competitor per sapere di chi e'
  // il parco che si sta guardando, e per accorgersi se la fonte ci mescola qualcun altro.
  const venditoreId = (dt.seller && dt.seller.id) || null;
  const venditoreNome = (dt.seller && dt.seller.companyName) || null;
  const venditore = /dealer/i.test(sellerType) ? 'concessionario'
                  : /private/i.test(sellerType) ? 'privato' : null;
  // danni: nativo `damage.isCurrentlyDamaged` (più affidabile), fallback al vecchio usageState.
  const danni = dmg && typeof dmg.isCurrentlyDamaged === 'boolean'
    ? dmg.isCurrentlyDamaged
    : (usage ? DAMAGED.has(usage) : null);

  // Immagini NATIVE (stessa query, zero costo extra). Solo StandardImage con webp;
  // entry senza webp (video/360/altro) scartate.
  const immagini = ((dt.media && dt.media.images) || []).reduce((acc, im) => {
    const w = im && im.formats && im.formats.webp;
    if (w && w.size420x315) acc.push({ thumb: w.size420x315, full: w.size800x600 || w.size420x315 });
    return acc;
  }, []);

  const out = {
    fonte: 'autoscout',
    titolo,
    prezzo,
    prezzoSuRichiesta: suRichiesta || null,   // il cartellino c'e', il numero no: si dice
    km: v.condition && v.condition.mileageInKm ? v.condition.mileageInKm.raw : null,
    anno: yearOf(v.condition && v.condition.firstRegistrationDate && v.condition.firstRegistrationDate.formatted),
    carburante: (() => {
      const f = v.fuels || {};
      const t = f.primary && f.primary.type;
      return (t && (t.formatted || t.raw)) || (f.fuelCategory && f.fuelCategory.formatted) || null;
    })(),
    // city AS24 spesso è "Comune - Provincia - PV" → tieni il comune (1° segmento)
    /**
     * LA PROVINCIA E' UNA SIGLA, e la ricava il risolutore condiviso.
     *
     * Qui si teneva il PRIMO segmento di `location.city` — che AS24 manda come
     * "Gussago - Brescia - BS" — cioe' il comune; il gemello a browser teneva la CODA, cioe'
     * la sigla. Stesso campo, stessa fonte, due significati: la colonna "Provincia" mescolava
     * "Gussago" e "BS", il raggruppamento faceva un gruppo per comune, e nel CSV finivano
     * perfino i CAP (misurato dal vivo: fra le "province" tornate c'erano `Agrigento`,
     * `AciCatena – Catania – Ct` e `97100`).
     *
     * `province-sigla.risolvi` esisteva gia' ed e' piu' forte di entrambe: valida contro le
     * 107 sigle vere, sa leggere sigla, parentesi, coda, nome di provincia, comune e CAP, e
     * torna null quando gli indizi si contraddicono invece di sceglierne uno a caso.
     */
    provincia: (provinciaSigla(dt.location && dt.location.city, dt.location && dt.location.zip) || null),
    cambio: (v.engine && v.engine.transmissionType && v.engine.transmissionType.formatted) || null,
    cilindrata: ccm ? (parseInt(String(ccm).replace(/[^\d]/g, ''), 10) || null) : null,
    variante,
    // Il MODELLO come lo dichiara AS24, separato dal titolo. Il titolo e' un
    // concatenato (marca + modello + allestimento) e chi filtra su quello non puo'
    // distinguere i tre pezzi: "r12" si trova dentro "gsr125". Qui il pezzo resta
    // intero e confrontabile. Additivo: nessuno lo usa ancora.
    modelloDichiarato: modelName || null,
    // Specs ricche NATIVE; null se assenti (gap onesto, niente fabbricazione).
    potenzaCv: hp,
    cilindri: eng.numberOfCylinders ?? null,
    proprietari: cond.numberOfPreviousOwnersExtended ? cond.numberOfPreviousOwnersExtended.raw : null,
    colore: (v.bodyColor && v.bodyColor.formatted) || null,
    carrozzeria: (v.bodyType && v.bodyType.formatted) || null,
    venditoreId, venditoreNome,
    marca: make || null,          // dichiarata dalla fonte: "Alfa Romeo", non "Alfa"
    venditore,
    immagini,
    zip: (dt.location && dt.location.zip) || null,   // per il post-filtro regione (fallback CAP→regione)
    url: dt.webPage || null,
    // Campi per il DB (usati dal crawler; ignorati dal path on-search legacy):
    nuovo: usage ? usage === 'New' : null,
    danni,   // nativo damage.isCurrentlyDamaged, fallback usageState
    posted_at: (dt.publication && dt.publication.createdTimestampWithOffset) || null,

    /**
     * QUELLO CHE ERA GIA' NELLA RISPOSTA E NON LEGGEVAMO. Stessa richiesta, campi in piu'.
     */
    // Il testo arriva con dentro l'HTML del venditore: misurato, 52 descrizioni su 83
    // contengono <br />. A schermo va escapato, quindi senza questo si leggerebbe
    // "<br />" scritto per esteso in mezzo alle frasi.
    descrizione: testoPulito(dt.description),
    // IVA: `taxDeductible` dice se chi la detrae paga davvero meno. `netAmountInEUR` e
    // `vatRate` ci sono solo quando il venditore li espone (12% degli annunci).
    ivaEsposta: pub && typeof pub.taxDeductible === 'boolean' ? pub.taxDeductible : null,
    prezzoNetto: pub && pub.netAmountInEUR ? pub.netAmountInEUR.raw : null,
    ivaAliquota: pub && pub.vatRate != null ? Number(pub.vatRate) : null,
    trattabile: pub && typeof pub.negotiable === 'boolean' ? pub.negotiable : null,
    /**
     * LA VALUTAZIONE DI AUTOSCOUT, che e' un giudizio LORO e va detto che e' loro.
     * `median` e' la mediana di mercato che calcolano per veicoli confrontabili;
     * `category` e' il voto 1-6 che ne esce; `equipmentCount` quanti optional hanno
     * contato. C'e' su un annuncio su tre — sugli altri e' assente, non e' "nella media".
     */
    valutazione: (() => {
      const e = pub && pub.evaluation;
      if (!e || e.median == null) return null;
      return { mediana: e.median, categoria: e.category ?? null, optionalContati: e.equipmentCount ?? null };
    })(),
    /**
     * DOMANDA. `leadsRange` e' quanti contatti sta ricevendo l'annuncio, a fasce
     * (Zero / Some / Many). Non e' un numero e non va spacciato per tale; misurato su
     * 100 annunci: Zero 59, Some 39, Many 2.
     */
    contatti: (dt.statistics && dt.statistics.leadsRange) || null,
    garanziaMesi: (() => {
      const w = dt.warranty;
      if (!w) return null;
      const g = w.generic && w.generic.durationInMonth;
      if (g && g.raw != null) return g.raw;
      return w.warrantyExists ? 0 : null;   // 0 = c'e' garanzia ma senza durata dichiarata
    })(),
    // Stato dichiarato: `accidentFree` sta su tutti gli annunci, gli altri due quasi mai.
    // `hasRepairedDamages` non si chiede: misurato vuoto su 200 annunci su 200, e un
    // campo che non risponde mai e' peso nella richiesta e una riga vuota a schermo.
    senzaIncidenti: cond.damage && typeof cond.damage.accidentFree === 'boolean' ? cond.damage.accidentFree : null,
    marciante: cond.damage && typeof cond.damage.isRoadworthy === 'boolean' ? cond.damage.isRoadworthy : null,
    nonFumatore: typeof cond.nonSmoking === 'boolean' ? cond.nonSmoking : null,
    // Manutenzione: pochi la compilano (2-8%), ma quando c'e' vale soldi — la cinghia
    // e la revisione in scadenza sono due voci di costo che si vedono solo qui.
    revisioneScadenza: fmt(v.maintenance && v.maintenance.nextVehicleSafetyInspection),
    cinghiaData: fmt(v.maintenance && v.maintenance.lastBeltServiceDate),
    tagliandi: fmt(v.maintenance && v.maintenance.hasFullServiceHistory),
    ultimoTagliando: fmt(v.maintenance && v.maintenance.lastTechnicalServiceDate),
    // Gli optional, in italiano e con la categoria. E' la lista che il venditore ha
    // spuntato inserendo l'annuncio: 42 voci su un'auto ben compilata.
    optional: ((v.equipment && v.equipment.as24) || [])
      .map(e => ({ nome: fmt(e && e.id), categoria: fmt(e && e.equipmentCategory) }))
      .filter(e => e.nome),
    posti: (v.interior && v.interior.numberOfSeats) ?? null,
    tappezzeria: fmt(v.interior && v.interior.upholstery),
    pesoVuoto: pesoKg(v.emptyWeight && v.emptyWeight.raw),
    cerchiPollici: v.alloyWheelInches && v.alloyWheelInches.raw != null ? v.alloyWheelInches.raw : null,
    mercatoOrigine: fmt(v.originalMarket),          // dice se e' un import
    dataProduzione: fmt(v.productionDate),
    generazione: fmt(c.modelGeneration),
    variante2: fmt(c.modelVariant),
    motore: fmt(c.motorType),
    allestimento: fmt(c.trimLine),
  };
  // raw_json (keep-last) senza `media`: gli URL immagine non vanno persistiti
  // (servono solo al display on-search) → evita di gonfiare raw_json sui crawl profondi.
  if (opts.attachRaw) { const { media, ...rawNoMedia } = dt; out._raw = rawNoMedia; }
  return out;
}

async function fetchPage(params, page, opts = {}) {
  const variables = buildVariables(params, page, opts);
  if (!variables) return { items: [], raw: 0 };
  const res = await httpPost(JSON.stringify({ query: QUERY, variables }));
  if (res.status === 401) throw fail('AS24 GraphQL 401 (credenziale)', { status: 401, kind: 'auth' });   // → fallback
  if (res.status !== 200) throw fail(`AS24 GraphQL HTTP ${res.status}`, { status: res.status, kind: kindForStatus(res.status) });
  let j;
  try { j = JSON.parse(res.body); } catch (_) { throw fail('AS24 GraphQL: body non-JSON', { status: res.status, kind: 'blocked' }); }
  if (j.errors) throw fail('AS24 GraphQL errors: ' + JSON.stringify(j.errors).slice(0, 120), { kind: 'error' });
  const arr = ((j.data || {}).search || {}).listings;
  const list = (arr && arr.listings) || [];
  // `raw` = annunci grezzi della pagina (per decidere se c'è una pagina dopo);
  // `items` è filtrato (onRequestOnly/prezzo-null) → non usarlo per la paginazione.
  // `totale` = quanti ne ha AS24 per QUESTA ricerca, non quanti ne mostriamo noi.
  // Arriva dentro la stessa risposta: nessuna richiesta in piu'.
  const tot = arr && arr.metadata && arr.metadata.totalItems;
  return { items: list.map(n => mapListing(n, opts)).filter(Boolean), raw: list.length,
           total: Number.isFinite(tot) ? tot : null };
}

/**
 * Ritorna gli annunci AS24 via API. Throw su errore → fallback Playwright.
 * @param opts.maxPages   override profondità (crawler: 10-20; on-search: 2)
 * @param opts.attachRaw  allega `_raw` (foto grezza) per il DB
 * @param opts.sortByDate ordina per età crescente (più recenti prima)
 * @param opts.withMeta   ritorna {items, truncated} invece dell'array (back-compat).
 *                        truncated=true se fermato al cap con ultima pagina PIENA
 *                        (vista parziale → il crawler NON deve rilevare venduti).
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function scrapeAutoscoutGraphql(params, opts = {}) {
  const maxPages = opts.maxPages || MAX_PAGES;
  const pageDelay = opts.pageDelayMs || 0;   // pausa tra le pagine (anti-ban su crawl profondi)
  const out = [];
  let truncated = false;
  let total = null;                 // quanti ne ha AS24 per questa ricerca (dalla 1a pagina)
  // "Carica altri": la fetta successiva parte da dove si era arrivati. Le pagine profonde
  // portano annunci DIVERSI — provato sulle pagine 1, 2, 33, 34 e 60 di una ricerca vera:
  // 250 annunci, 250 url distinti, nessuna sovrapposizione. Il tetto di ~1.629 scritto
  // piu' sotto vale per altro: qui la pagina 60 risponde ancora roba nuova.
  // `fetta` e' UN concetto per tutte e tre le fonti: la 0 e' la prima schermata, la 1 la
  // successiva. Ogni fonte la traduce nella SUA paginazione, perche' le pagine hanno
  // dimensioni diverse — qui 50 per pagina, due pagine per fetta.
  const salta = Math.max(0, opts.fetta || 0) * maxPages;
  let rawTot = 0;                   // annunci grezzi visti: se mappati 0, e' il parser
  for (let p = 1 + salta; p <= salta + maxPages; p++) {
    if (p > 1 + salta && pageDelay) await sleep(pageDelay);   // mai raffica di pagine
    const { items, raw, total: tot } = await fetchPage(params, p, opts);
    if (p === 1 + salta) total = tot;   // uguale su tutte le pagine: si prende la prima
    rawTot += raw;
    out.push(...items);
    if (raw < PAGE_SIZE) break;       // lista esaurita (conteggio GREZZO) = vista completa
    if (p === salta + maxPages) truncated = true;   // ultima pagina piena al cap → forse altro
  }
  /**
   * SE NON MAPPA PIU' NIENTE, E' IL PARSER, NON IL MERCATO — la regola di subito-api:745,
   * che qui mancava del tutto. mapListing scarta il nodo senza prezzo ne' onRequestOnly:
   * se `prices.public.amountInEUR` cambia nome, OGNI nodo esce null e la ricerca usciva
   * come «Autoscout 0 di 6.485» — pastiglia grigia, mercato dichiarato vuoto, e in cache.
   * Il throw e non un campo: il ramo union chiama senza withMeta e un campo si perderebbe,
   * mentre l'errore finisce in `errori[]` e diventa un `parziale` dichiarato.
   */
  if (rawTot > 0 && out.length === 0) {
    throw new Error(`Autoscout: ${rawTot} annunci grezzi e nessuno leggibile — lo schema del payload puo' essere cambiato`);
  }
  return opts.withMeta ? { items: out, truncated, total } : out;
}

// ─── F50 copertura: conteggio totale per-query (count-query LEGGERA, separata) ───
// NB: la query di RICERCA ADESSO espone `metadata.totalItems` — provato live il
// 2026-07-28 sulla query di produzione, variabili comprese: 6.485 Golf in Italia, e
// funziona anche col filtro venditore. Il commento di prima diceva il contrario. Per la
// RICERCA il totale arriva quindi gratis, dentro la risposta che gia' leggiamo.
// Questa resta per il CRAWLER, che conta per range di anno/prezzo senza scaricare gli
// annunci: li' serve un conteggio SENZA la pagina, e questa query e' piu' leggera.
const COUNT_AUTH = 'Basic aG9tZS1mZWVkLWpzOnAzNVBLeUZCNG5VREtFTllKNG9HUTVJYjFTM0NieQ==';
const COUNT_QUERY = `query GET_TOTAL_LISTING_COUNT_BY_QUERY_STRING($queryString:String!,$locale:Locale_){ search{ listingsByQueryString(queryString:$queryString, locale:$locale){ metadata{ totalItems } } } }`;

// PURO: mmmv "make|model|..." → queryString. atype=C auto / B moto (entrambi provati).
// ustate=U: il tetto deve combaciare con lo SCOPE che ingeriamo. `listings()` ci dà il
// "non-nuovo" (usato + km0/demo; 0 `nuovo=true` su 87k AS24 in DB), ed `ustate=U` conta
// lo stesso insieme (escludendo solo le Neu). Verificato live (Audi A3): ustate=U=5553 ≈
// listings() per-fetta. NB: il GROSSO buco sui best-seller (Audi A3: ~5300 usate vere vs
// 1629 ingerite = 31%) NON sono auto nuove — è il TETTO DI PAGINAZIONE di `listings()`
// (~1629/query): si recupera spezzando la query per anno/prezzo (vedi M-K), non qui.
function countQueryString(mmmv, tipo, range = {}) {
  const [make, model] = String(mmmv || '').split('|');
  if (!make) return null;
  const atype = tipo === 'moto' ? 'B' : 'C';
  let qs = `sort=standard&desc=0&ustate=U&atype=${atype}&cy=I&mmm=${make}|${model || ''}|`;
  // M-K split: range opzionali per stare sotto il tetto di paginazione AS24 (~1629/query).
  // anno = fregfrom/fregto (PROVATO live: fregto=2015→1417 + fregfrom=2016→3887 = totale 5304).
  // prezzo = pricefrom/priceto (usato solo se un singolo anno sfora; da verificare live).
  const { annoMin, annoMax, prezzoMin, prezzoMax } = range || {};
  if (annoMin != null) qs += `&fregfrom=${annoMin}`;
  if (annoMax != null) qs += `&fregto=${annoMax}`;
  if (prezzoMin != null) qs += `&pricefrom=${prezzoMin}`;
  if (prezzoMax != null) qs += `&priceto=${prezzoMax}`;
  return qs;
}

// PURO: estrae totalItems dalla risposta GraphQL (o null). Testabile senza rete.
function parseTotalCount(j) {
  const n = j && j.data && j.data.search && j.data.search.listingsByQueryString
    && j.data.search.listingsByQueryString.metadata && j.data.search.listingsByQueryString.metadata.totalItems;
  return Number.isFinite(n) ? n : null;
}

// Questa query viaggia su una credenziale DIVERSA da quella della ricerca (client
// `home-feed-js`). Se quella sola credenziale viene ruotata, o risponde 403, il conteggio
// torna null mentre le ricerche continuano a funzionare: nessun badge diventa rosso e
// nessuno si accorge che lo split M-K e la misura di copertura si sono spenti. Il null
// resta — i chiamanti lo trattano gia' come "tetto ignoto", che e' il comportamento
// prudente — ma smette di essere muto. Una riga al minuto, non una per chiamata: dentro
// planBuckets questa funzione viene invocata decine di volte di seguito.
let ultimoAvvisoConteggio = 0;
function avvisaConteggio(motivo) {
  const ora = Date.now();
  if (ora - ultimoAvvisoConteggio < 60 * 1000) return;
  ultimoAvvisoConteggio = ora;
  console.warn(`[AS24-count] conteggio non disponibile (${motivo}): niente split per fette e niente misura di copertura finche' dura`);
}

// Ritorna il totale AS24 per (mmmv,tipo[,range anno/prezzo]) o null. Best-effort: mai throw.
async function fetchTotalCount({ mmmv, tipo, annoMin, annoMax, prezzoMin, prezzoMax } = {}) {
  const qs = countQueryString(mmmv, tipo, { annoMin, annoMax, prezzoMin, prezzoMax });
  if (!qs) return null;
  try {
    const res = await httpPost(JSON.stringify({ query: COUNT_QUERY, variables: { queryString: qs, locale: 'it_IT' } }), COUNT_AUTH);
    if (res.status !== 200) { avvisaConteggio('HTTP ' + res.status); return null; }
    const n = parseTotalCount(JSON.parse(res.body));
    if (n == null) avvisaConteggio('risposta senza totalItems — forma della risposta cambiata');
    return n;
  } catch (e) {
    avvisaConteggio(e && e.message ? e.message : 'errore di rete');
    return null;
  }
}

// ─── M-K: pianifica i bucket per superare il tetto di paginazione AS24 ───────────
// `listings()` serve ~1629 risultati/query poi si ferma. Per i best-seller (Audi A3
// ~5300 usate) spezziamo per ANNO (poi per PREZZO se un singolo anno sfora), così ogni
// sotto-query sta sotto il tetto ed è paginabile per intero. PURO rispetto alla rete:
// `countFn(range)->Promise<number|null>` è INIETTATA → testabile senza HTTP. Ritorna una
// lista di range-foglia {annoMin,annoMax[,prezzoMin,prezzoMax]}; `[{}]` = una sola sweep
// piena (totale ≤ soglia o count KO → comportamento attuale).
const SPLIT_OVER = 1500;            // margine sotto il ceiling ~1629
const SPLIT_PRICE_MAX = 1000000;    // bound della bisezione prezzo; il bucket TOP è APERTO
                                    // (prezzoMax=null) → le auto > MAX (supercar) NON si perdono

async function planBuckets(countFn, opts = {}) {
  const splitOver = opts.splitOver || SPLIT_OVER;
  // F1 (review): yMin BASSO (1900) + yMax con buffer (+2) → la bisezione copre TUTTI gli anni
  // reali (epoca inclusa) e i futuri-datati; niente cade fuori dai bucket (countFn({}) = Σ foglie,
  // partizione esatta). yMin=1985 droppava silenziosamente l'usato pre-1985 dei modelli d'epoca.
  const yMin = opts.yearMin || 1900;
  const yMax = opts.yearMax || (new Date().getFullYear() + 2);
  const maxLeaves = opts.maxLeaves || 24;   // anti-runaway (best-seller ≈ 6-10 foglie)
  const leaves = [];

  async function recurPrice(year, lo, hi) {
    // bordi APERTI agli estremi: prezzoMin=0→null (nessun pricefrom), prezzoMax=MAX→null
    // (nessun priceto → cattura > MAX). Così la partizione prezzo copre [0, +∞) senza buchi.
    const range = { annoMin: year, annoMax: year,
                    prezzoMin: lo <= 0 ? null : lo,
                    prezzoMax: hi >= SPLIT_PRICE_MAX ? null : hi };
    const n = await countFn(range);
    if (n == null || n <= splitOver || hi - lo <= 1000 || leaves.length >= maxLeaves) {
      leaves.push(range); return;
    }
    const mid = Math.floor((lo + hi) / 2);
    await recurPrice(year, lo, mid);
    await recurPrice(year, mid + 1, hi);
  }

  async function recurYear(a, b) {
    const n = await countFn({ annoMin: a, annoMax: b });
    if (n == null || n <= splitOver) { leaves.push({ annoMin: a, annoMax: b }); return; }
    if (a >= b) { await recurPrice(a, 0, SPLIT_PRICE_MAX); return; }   // singolo anno troppo grande → prezzo
    if (leaves.length >= maxLeaves) { leaves.push({ annoMin: a, annoMax: b }); return; }
    const mid = (a + b) >> 1;
    await recurYear(a, mid);
    await recurYear(mid + 1, b);
  }

  const total = await countFn({});                       // {} = nessun range = query piena
  if (total == null || total <= splitOver) return [{}];  // sweep singola (comportamento attuale)
  await recurYear(yMin, yMax);
  return leaves.length ? leaves : [{}];
}

module.exports = scrapeAutoscoutGraphql;
module.exports._mapListing = mapListing;
module.exports._buildVariables = buildVariables;
module.exports.fetchTotalCount = fetchTotalCount;       // F50 copertura (chiamato dal crawler)
module.exports.planBuckets = planBuckets;               // M-K split (crawler + test; countFn iniettata = puro)
module.exports.SPLIT_OVER = SPLIT_OVER;
module.exports._countQueryString = countQueryString;    // PURO, testabile senza rete
module.exports._parseTotalCount = parseTotalCount;      // PURO, testabile senza rete
module.exports.combaciaModello = combaciaModello;       // PURO: modello dichiarato vs cercato
module.exports._testoPulito = testoPulito;              // PURO: testo annuncio senza markup
module.exports._mapListing = mapListing;                // PURO: nodo GraphQL → risultato
