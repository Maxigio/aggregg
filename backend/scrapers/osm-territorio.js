'use strict';
/**
 * TERRITORIO — cosa c'e' intorno, da OpenStreetMap via Overpass.
 *
 * PERCHE'. Il proprietario aveva chiesto le colonnine di ricarica e poi ha detto di guardare oltre.
 * Guardando, dentro OSM c'e' molto di piu' e di piu' utile a un concessionario:
 *   - 4.872 CONCESSIONARI in Italia, di cui 887 dichiarano di vendere usato. Sono i concorrenti,
 *     con nome, marca trattata, indirizzo, sito e telefono;
 *   - 22.794 DISTRIBUTORI, di cui 20.030 con il codice ministeriale `ref:mise`. Quel codice e'
 *     l'idImpianto dei prezzi carburante MIMIT che gia' usiamo: incrociandoli, ai nostri prezzi si
 *     aggiungono carburanti disponibili, orari, self service e posizione verificata sul posto.
 *     Verificato in Emilia-Romagna: 892 impianti agganciati, distanza mediana fra il punto OSM e
 *     quello MIMIT di 5 METRI, il 98% sotto i 200;
 *   - officine, gommisti, ricambisti, centri revisione, autolavaggi, noleggi, negozi moto;
 *   - le zone a basse emissioni, che dicono dove un Euro 4 diesel non entra.
 *
 * LA TRAPPOLA DELLO USER-AGENT, ed e' il contrario di tutte le altre fonti: Overpass RESPINGE con
 * 406 chi si presenta come un browser. Verificato tre volte. Va mandata una stringa applicativa
 * che dica chi siamo, che e' anche quello che chiede la loro politica d'uso.
 *
 * COSTO: l'istanza pubblica e' un bene comune finanziato da donazioni. Si chiede per REGIONE e si
 * tiene in cache una settimana; i conteggi usano `out count`, che risponde in mezzo kilobyte
 * invece di scaricare gli oggetti.
 */
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const { fail, kindForStatus } = require('./utils');
const cacheDisco = require('./cache-disco');

const HOST = 'overpass-api.de';
const PERCORSO = '/api/interpreter';
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'osm-territorio-cache.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 180000;                 // le query per regione possono metterci
const PAUSA_MS = 4000;                     // istanza pubblica: si va piano
// Deve dire chi siamo. Una stringa da browser qui prende 406.
const UA = 'AutoMotoRadar/1.0 (strumento locale per concessionario; uso non commerciale)';

/**
 * Le categorie che interessano a chi compra e vende veicoli. `q` e' il filtro Overpass, `chiavi`
 * sono i tag che vale la pena mostrare — misurati sul campione, non presi dal wiki: OSM permette
 * migliaia di tag ma quelli davvero compilati sono pochi.
 */
const CATEGORIE = {
  concessionari: { nome: 'Concessionari', q: '["shop"="car"]', chiavi: ['name', 'brand', 'second_hand', 'website', 'phone', 'opening_hours', 'addr:street', 'addr:housenumber', 'addr:city', 'addr:postcode'] },
  officine: { nome: 'Officine', q: '["shop"="car_repair"]', chiavi: ['name', 'brand', 'service:vehicle:car_repair', 'website', 'phone', 'opening_hours', 'addr:street', 'addr:city'] },
  gommisti: { nome: 'Gommisti', q: '["shop"="tyres"]', chiavi: ['name', 'brand', 'website', 'phone', 'opening_hours', 'addr:street', 'addr:city'] },
  ricambisti: { nome: 'Ricambisti', q: '["shop"="car_parts"]', chiavi: ['name', 'brand', 'website', 'phone', 'addr:street', 'addr:city'] },
  distributori: { nome: 'Distributori', q: '["amenity"="fuel"]', chiavi: ['name', 'brand', 'operator', 'ref:mise', 'self_service', 'opening_hours', 'fuel:diesel', 'fuel:octane_95', 'fuel:octane_98', 'fuel:lpg', 'fuel:cng', 'fuel:HGV_diesel', 'compressed_air', 'addr:street', 'addr:city'] },
  colonnine: { nome: 'Colonnine di ricarica', q: '["amenity"="charging_station"]', chiavi: ['name', 'operator', 'brand', 'capacity', 'socket:type2', 'socket:type2_combo', 'socket:chademo', 'socket:type2:output', 'socket:type2_combo:output', 'fee', 'authentication:none', 'opening_hours'] },
  revisioni: { nome: 'Centri revisione', q: '["amenity"="vehicle_inspection"]', chiavi: ['name', 'operator', 'website', 'phone', 'opening_hours', 'addr:street', 'addr:city'] },
  autolavaggi: { nome: 'Autolavaggi', q: '["amenity"="car_wash"]', chiavi: ['name', 'brand', 'self_service', 'opening_hours', 'addr:street', 'addr:city'] },
  noleggi: { nome: 'Noleggi', q: '["amenity"="car_rental"]', chiavi: ['name', 'brand', 'operator', 'website', 'phone', 'addr:street', 'addr:city'] },
  moto: { nome: 'Negozi moto', q: '["shop"="motorcycle"]', chiavi: ['name', 'brand', 'second_hand', 'website', 'phone', 'addr:street', 'addr:city'] },
  officineMoto: { nome: 'Officine moto', q: '["shop"="motorcycle_repair"]', chiavi: ['name', 'brand', 'website', 'phone', 'addr:street', 'addr:city'] },
  autoscuole: { nome: 'Autoscuole', q: '["amenity"="driving_school"]', chiavi: ['name', 'website', 'phone', 'addr:street', 'addr:city'] },
  zoneBasseEmissioni: { nome: 'Zone a basse emissioni', q: '["boundary"="low_emission_zone"]', chiavi: ['name', 'operator', 'website', 'start_date'] },
};

// Le venti regioni, col codice ISO che Overpass riconosce. La chiave e' lo slug che usiamo gia'
// in data/province.json, cosi' da una provincia si arriva alla sua regione senza tabelle nuove.
const REGIONI = {
  piemonte: 'IT-21', "valle-d-aosta": 'IT-23', lombardia: 'IT-25', 'trentino-alto-adige': 'IT-32',
  veneto: 'IT-34', 'friuli-venezia-giulia': 'IT-36', liguria: 'IT-42', 'emilia-romagna': 'IT-45',
  toscana: 'IT-52', umbria: 'IT-55', marche: 'IT-57', lazio: 'IT-62', abruzzo: 'IT-65',
  molise: 'IT-67', campania: 'IT-72', puglia: 'IT-75', basilicata: 'IT-77', calabria: 'IT-78',
  sicilia: 'IT-82', sardegna: 'IT-88',
};

let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

async function overpass(query) {
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
  const ora = Date.now();
  const quando = Math.max(ora, ultima + PAUSA_MS);
  ultima = quando;
  if (quando > ora) await sleep(quando - ora);

  const corpo = 'data=' + encodeURIComponent(query);
  const { status, body } = await new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path: PERCORSO, method: 'POST',
      // Solo questi due header: aggiungere Accept o Content-Type: application/json fa rispondere 406.
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo), 'Accept-Encoding': 'gzip' },
    }, res => {
      const c = []; let s = res;
      if ((res.headers['content-encoding'] || '') === 'gzip') s = res.pipe(zlib.createGunzip());
      s.on('data', x => c.push(x));
      s.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      s.on('error', reject);
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
    req.end(corpo);
  });
  // 429 e 504 sono i due modi in cui Overpass dice "troppo": si tace mezz'ora invece di insistere.
  if (status === 429 || status === 504) {
    bloccatoFino = Date.now() + 30 * 60 * 1000;
    throw fail('istanza Overpass satura (HTTP ' + status + '), pausa 30 min', { status, kind: 'blocked' });
  }
  if (status === 406) throw fail('406: Overpass rifiuta le richieste che si fingono un browser', { status, kind: 'error' });
  if (status !== 200) throw fail('HTTP ' + status, { status, kind: kindForStatus(status) });
  try { return JSON.parse(body); } catch (_) { throw fail('risposta non JSON: la query e\' sbagliata o l\'istanza e\' in errore', { kind: 'parse' }); }
}

// ─── Cache su disco ──────────────────────────────────────────────────────────
// SCHEMA: da alzare a ogni cambio della FORMA dei record, o la cache serve il vecchio formato
// per tutto il TTL senza dirlo. Il resto (tetto, dato vecchio se la fonte cade, vita breve per
// un risultato sospetto) sta in cache-disco.js, uguale per tutti gli scraper.
const conCache = cacheDisco.crea(CACHE_FILE, { tag: 'osm', schema: 1, ttl: TTL_MS, max: 400 });

// ─── Query ───────────────────────────────────────────────────────────────────
const areaDi = regione => (regione && REGIONI[regione]
  ? `area["ISO3166-2"="${REGIONI[regione]}"]->.a;`
  : 'area["ISO3166-1"="IT"][admin_level=2]->.a;');

/** Conteggi per categoria, senza scaricare gli oggetti: `out count` risponde in mezzo kilobyte. */
const conta = (regione) => conCache('conta|' + (regione || 'IT'), async () => {
  const fuori = {};
  for (const [id, c] of Object.entries(CATEGORIE)) {
    const j = await overpass(`[out:json][timeout:180];${areaDi(regione)}(nwr${c.q}(area.a););out count;`);
    const t = (j.elements && j.elements[0] && j.elements[0].tags) || {};
    fuori[id] = Number(t.total) || 0;
  }
  return fuori;
}, d => !d || !Object.values(d).some(Boolean));

/** Da un elemento Overpass a quello che mostriamo: solo i tag che servono, piu' la posizione. */
function mappaOggetto(el, chiavi) {
  const t = el.tags || {};
  const dati = {};
  for (const k of chiavi) if (t[k] != null) dati[k] = t[k];
  // I `way` e le `relation` non hanno lat/lon proprie: Overpass le fornisce in `center` con
  // `out center`. Senza, meta' degli oggetti finirebbe senza posizione.
  const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
  const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
  return {
    id: el.type + '/' + el.id,
    nome: t.name || t.operator || t.brand || null,
    lat: lat != null ? lat : null,
    lon: lon != null ? lon : null,
    indirizzo: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ') || null,
    comune: t['addr:city'] || null,
    dati,
    // Tutti gli altri tag restano disponibili: sono il "quanti più dati possibile" del caso.
    altriTag: Object.fromEntries(Object.entries(t).filter(([k]) => !chiavi.includes(k))),
  };
}

/** Gli oggetti di una categoria in una regione. */
const oggetti = (categoria, regione) => {
  const c = CATEGORIE[categoria];
  if (!c) return Promise.reject(fail('categoria sconosciuta: ' + categoria, { kind: 'error' }));
  if (regione && !REGIONI[regione]) return Promise.reject(fail('regione sconosciuta: ' + regione, { kind: 'error' }));
  return conCache('og|' + categoria + '|' + (regione || 'IT'), async () => {
    const j = await overpass(`[out:json][timeout:180];${areaDi(regione)}(nwr${c.q}(area.a););out center tags;`);
    return (j.elements || []).map(e => mappaOggetto(e, c.chiavi));
  }, d => !Array.isArray(d) || !d.length);
};

module.exports = {
  conta, oggetti, pausaFinoA,
  CATEGORIE, REGIONI,
  _overpass: overpass, _mappaOggetto: mappaOggetto, _areaDi: areaDi, _CACHE_FILE: CACHE_FILE,
};
