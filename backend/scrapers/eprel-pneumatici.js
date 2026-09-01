'use strict';
/**
 * EPREL — banca dati UE delle etichette energetiche, sezione PNEUMATICI.
 *
 * PERCHE'. E' la fonte ISTITUZIONALE dell'etichetta europea: efficienza (che vale consumo),
 * aderenza sul bagnato (che vale spazio di frenata), rumore in decibel, e i simboli neve e
 * ghiaccio. Sono i quattro numeri che un cliente chiede al banco gomme e che oggi il
 * concessionario deve andare a cercare sul volantino del fornitore. 293.999 pneumatici registrati.
 *
 * COSA NON E', detto subito per non dare l'impressione sbagliata: EPREL pneumatici NON contiene
 * dati di veicolo. Non c'e' una marca auto, non c'e' un modello, non c'e' l'anno. E' un archivio
 * di PNEUMATICI, e si interroga per misura, marca del pneumatico o numero di registrazione.
 * L'aggancio a un annuncio passa dalla MISURA, che sta nella scheda tecnica del veicolo.
 *
 * ACCESSO: API JSON pubblica, nessuna chiave, nessuna registrazione, nessun CAPTCHA. La pagina del
 * portale e' solo una SPA che chiama questi stessi endpoint.
 *
 * DUE TRAPPOLE MISURATE, entrambe chiuse qui dentro:
 *  1. `_page` e' 1-BASED: con `_page=0` la risposta e' HTTP 500;
 *  2. `_limit` oltre il tetto (fra 101 e 199) NON da' errore: risponde 200 e ricade in silenzio sul
 *     default di 25 risultati. Un crawler con `_limit=500` crederebbe di avere tutto e ne
 *     prenderebbe 25. Qui il limite e' fissato a 100, che e' onorato.
 */
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const { fail, kindForStatus } = require('./utils');
const cacheDisco = require('./cache-disco');

const HOST = 'eprel.ec.europa.eu';
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'eprel-cache.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000;
const PAUSA_MS = 1200;
const LIMITE = 100;                        // oltre il tetto il server ricade in silenzio su 25
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

async function getJson(percorso) {
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
  const ora = Date.now();
  const quando = Math.max(ora, ultima + PAUSA_MS);
  ultima = quando;
  if (quando > ora) await sleep(quando - ora);

  const { status, body } = await new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path: percorso,
      headers: {
        'User-Agent': UA, Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'it-IT,it;q=0.9', 'Accept-Encoding': 'gzip',
        Referer: 'https://eprel.ec.europa.eu/screen/product/tyres',
      },
    }, res => {
      const c = []; let s = res;
      if ((res.headers['content-encoding'] || '') === 'gzip') s = res.pipe(zlib.createGunzip());
      s.on('data', x => c.push(x));
      s.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      s.on('error', reject);
      // `pipe()` non propaga gli errori: se la connessione cade dopo gli header l'errore esce su
      // `res`, non sul gunzip, e la Promise restava appesa. Un gestore anche qui.
      res.on('error', e => reject(fail(e.message, { kind: 'transient' })));
      res.on('aborted', () => reject(fail('risposta interrotta', { kind: 'transient' })));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
  if (status === 403 || status === 429) {
    bloccatoFino = Date.now() + 30 * 60 * 1000;
    throw fail('bloccati (HTTP ' + status + '), pausa 30 min', { status, kind: 'blocked' });
  }
  if (status !== 200) throw fail('HTTP ' + status, { status, kind: kindForStatus(status) });
  try { return JSON.parse(body); } catch (_) { throw fail('risposta non JSON', { kind: 'parse' }); }
}

// ─── Cache su disco ──────────────────────────────────────────────────────────
// SCHEMA: da alzare a ogni cambio della FORMA dei record, o la cache serve il vecchio formato
// per tutto il TTL senza dirlo. Il resto (tetto, dato vecchio se la fonte cade, vita breve per
// un risultato sospetto) sta in cache-disco.js, uguale per tutti gli scraper.
const conCache = cacheDisco.crea(CACHE_FILE, { tag: 'eprel', schema: 1, ttl: TTL_MS, max: 800 });

/**
 * Da un record EPREL a quello che mostriamo. Si tengono anche i campi che nel campione sono
 * risultati sempre vuoti (marcatura primo equipaggiamento, M+S, runflat, EAN): non sono rumore,
 * sono campi che i fornitori possono compilare e che quando arriveranno serviranno — e mostrarli
 * vuoti dice al proprietario che la fonte li prevede ma nessuno li riempie.
 */
function mappa(r) {
  const d = r.additionalDetails || {};
  const note = (r.additionalInfos || []).map(x => x && x.text).filter(Boolean);
  const n = v => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  return {
    registrazione: r.eprelRegistrationNumber != null ? String(r.eprelRegistrationNumber) : null,
    marca: r.supplierOrTrademark || null,
    // `modelIdentifier` e' liberissimo (dal nome commerciale a codici interni tipo
    // "1KE-3220007827"): il nome che un cliente riconosce e' `commercialName`.
    modello: d.commercialName || r.modelIdentifier || null,
    modelloDichiarato: r.modelIdentifier || null,
    // ── LA MISURA: e' la chiave con cui si aggancia a un veicolo, e sta in cinque campi ──
    misura: r.sizeDesignation || null,                 // "205/55R16"
    misuraCompleta: r.tyreDesignation || null,         // "205/55R16 94 H XL", quella stampata sul fianco
    sezione: n(r.tyreSection),                         // larghezza in mm
    rapporto: n(r.aspectRatio),                        // serie
    diametroCerchio: n(r.rimDiameter),                 // pollici
    indiceCarico: n(r.loadCapacityIndex),
    indiciCaricoExtra: [r.loadCapacityIndex2, r.loadCapacityIndex3, r.loadCapacityIndex4].map(n).filter(x => x != null),
    simboloVelocita: r.speedCategorySymbol || null,
    simboloVelocita2: r.speedCategorySymbol2 || null,
    rinforzato: r.loadCapacityIndicator || null,       // "XL" = carico maggiorato
    // ── l'etichetta europea, i quattro numeri che contano ──
    classeEfficienza: r.energyClass || null,
    scalaEfficienza: r.energyClassRange || null,
    classeBagnato: r.wetGripClass || null,
    scalaBagnato: r.wetGripClassRange || null,
    rumoreDb: r.externalRollingNoiseValue != null ? Number(r.externalRollingNoiseValue) : null,
    classeRumore: r.externalRollingNoiseClass || null,
    scalaRumore: r.externalRollingNoiseClassRange || null,
    neve: r.severeSnowTyre === true,          // simbolo alpino 3PMSF
    ghiaccio: r.iceTyre === true,
    classe: r.tyreClass || null,              // C1 auto, C2 furgoni, C3 pesanti
    // ── identificazione e stato ──
    regolamento: r.implementingAct || null,
    stato: r.status || null,
    bloccato: r.blocked === true,             // scheda sospesa dalla vigilanza: va detto
    versione: r.versionNumber != null ? Number(r.versionNumber) : null,
    // ── campi che la fonte prevede e che i fornitori quasi mai compilano ──
    ean: d.gtinIdentifier || null,
    marcaturaPrimoEquipaggiamento: d.originalEquipmentMarking || null,
    fangoNeve: d.mudSnow != null ? d.mudSnow : null,
    usoSpeciale: d.specialUse != null ? d.specialUse : null,
    runflat: d.unrestrictedMobility != null ? d.unrestrictedMobility : null,
    // ── periodo di produzione e di commercializzazione: dicono se il pneumatico e' ancora in
    //    listino o e' fuori produzione, che al banco gomme e' la prima domanda ──
    produzioneDa: r.dateStartProductionYear ? [r.dateStartProductionWeek, r.dateStartProductionYear].filter(Boolean).join('/') : null,
    produzioneA: r.dateEndProductionYear ? [r.dateEndProductionWeek, r.dateEndProductionYear].filter(Boolean).join('/') : null,
    inCommercioDa: r.onMarketStartDate || r.onMarketFirstStartDate || null,
    inCommercioFinoA: r.onMarketEndDate || null,
    paesi: r.modelAvailabilityInEUEEACountries || r.availabilityInEUEEACountries || null,
    // ── l'etichetta europea come immagine, generata dalla Commissione ──
    etichetta: r.energyClassImage || null,
    etichettaConScala: r.energyClassImageWithScale || null,
    // ── le note del fornitore: testo libero, spesso la descrizione a listino ──
    note,
    scheda: r.eprelRegistrationNumber != null
      ? 'https://eprel.ec.europa.eu/screen/product/tyres/' + r.eprelRegistrationNumber : null,
  };
}

/**
 * Cerca pneumatici. I filtri sono quelli VERI dell'API, verificati: `_search` non esiste e viene
 * ignorato in silenzio — chi lo usa riceve l'archivio intero credendo di aver filtrato.
 *   misura  → sizeDesignation, senza spazi: "205/55R16" (non "205/55 R16")
 *   marca   → supplierOrTrademark
 *   classe  → tyreClass (C1 auto, C2 furgoni, C3 pesanti)
 * Torna { totale, pneumatici } — `totale` e' quanti ne esistono, non quanti se ne sono presi.
 */
const cerca = ({ misura, marca, classe, pagina = 1 } = {}) => {
  // Si normalizza PRIMA, e la chiave si costruisce sui valori normalizzati. Prima la chiave
  // portava quelli grezzi mentre la richiesta partiva ripulita: "205/55 R16" e "205/55R16" — la
  // stessa identica chiamata — occupavano due voci, e cosi' pagina=0 e pagina=1.
  const mis = misura ? String(misura).toUpperCase().replace(/\s+/g, '') : '';
  const mar = marca ? String(marca).trim() : '';
  const cls = classe ? String(classe).toUpperCase().trim() : '';
  const p = Math.max(1, Number(pagina) || 1);          // `_page=0` risponde 500
  return conCache(['c', mis, mar, cls, p].join('|'), async () => {
    const par = new URLSearchParams({ _page: String(p), _limit: String(LIMITE) });
    // La fonte vuole la misura attaccata: "205/55 R16" non aggancia niente, "205/55R16" si'.
    if (mis) par.set('sizeDesignation', mis);
    if (mar) par.set('supplierOrTrademark', mar);
    if (cls) par.set('tyreClass', cls);
    const j = await getJson('/api/products/tyres?' + par.toString());
    const hits = j.hits || [];
    // Se il server ricadesse sul default (25) invece di onorare il limite, il chiamante deve poterlo
    // vedere: `presi` accanto a `limite` lo rende evidente invece di far credere di avere tutto.
    return { totale: Number(j.size) || 0, offset: Number(j.offset) || 0, limite: LIMITE, presi: hits.length, pneumatici: hits.map(mappa) };
  }, d => !d || (d.totale > 0 && !d.presi));
};

/** Il conteggio totale, senza scaricare niente: serve a dire quanto grande e' l'archivio. */
const totale = () => conCache('totale', async () => {
  const j = await getJson('/api/products/tyres?_page=1&_limit=1');
  return Number(j.size) || 0;
}, d => !d);

module.exports = { cerca, totale, pausaFinoA, _mappa: mappa, _LIMITE: LIMITE, _CACHE_FILE: CACHE_FILE };
