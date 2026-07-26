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
/**
 * I DUE timeout, e devono venire dallo stesso numero.
 * `[timeout:N]` e' quanto concediamo all'istanza; il nostro client deve mollare DOPO, mai prima.
 * Erano scollegati — 300 dichiarati nella query, 180 nel client — e il risultato era il peggio dei
 * due mondi: noi abbandonavamo la richiesta e loro continuavano a calcolarla per altri due minuti,
 * su una macchina donata, per un risultato che nessuno avrebbe mai letto.
 */
const TIMEOUT_S = 240;
const TIMEOUT_MS = (TIMEOUT_S + 30) * 1000;
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

/**
 * Lo stato del limitatore, che l'istanza pubblica DICHIARA su /api/status. Vale la pena leggerlo
 * invece di tirare a indovinare: risponde in mezzo kilobyte e la risposta e' questa,
 *
 *   Rate limit: 2
 *   1 slots available now.
 *   Slot available after: 2026-07-26T05:48:03Z, in 22 seconds.
 *
 * cioe' DUE query in parallelo per IP e un conto alla rovescia esatto quando sono occupate. E'
 * quel numero che va detto all'utente e usato per la pausa, non una mezz'ora inventata.
 */
const IGNOTO = { slotLiberi: null, fraSecondi: null, limite: null };

/** Il testo di /api/status letto. Separato dalla richiesta, cosi' si puo' provare senza rete. */
function leggiStato(testo) {
  const s = String(testo || '');
  const liberi = (s.match(/(\d+)\s+slots?\s+available\s+now/i) || [, null])[1];
  // Le attese sono una per slot occupato: interessa la PRIMA che si libera, cioe' la piu' vicina.
  const attese = [...s.matchAll(/in\s+(-?\d+)\s+seconds?/gi)].map(m => Number(m[1])).filter(n => n > 0);
  return {
    slotLiberi: liberi != null ? Number(liberi) : null,
    fraSecondi: attese.length ? Math.min(...attese) : (Number(liberi) > 0 ? 0 : null),
    limite: Number((s.match(/Rate limit:\s*(\d+)/i) || [, 0])[1]) || null,
  };
}

function stato() {
  return new Promise(resolve => {
    const req = https.get({ host: HOST, path: '/api/status', headers: { 'User-Agent': UA } }, res => {
      let s = '';
      res.on('data', c => { s += c; });
      res.on('end', () => resolve(leggiStato(s)));
    });
    // Se lo stato non risponde non si insiste: e' un aiuto, non un requisito.
    req.on('error', () => resolve(IGNOTO));
    req.setTimeout(8000, () => { req.destroy(); resolve(IGNOTO); });
  });
}

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
  // 429 e 504 sono i due modi in cui Overpass dice "troppo". Quanto aspettare NON lo si inventa:
  // lo dice l'istanza stessa su /api/status, e quasi sempre sono decine di secondi, non mezz'ora.
  if (status === 429 || status === 504) {
    const s = await stato();
    const attesa = Math.min(Math.max((s.fraSecondi != null ? s.fraSecondi : 300) + 5, 30), 30 * 60);
    bloccatoFino = Date.now() + attesa * 1000;
    throw fail('istanza Overpass satura (HTTP ' + status + '), si riprova fra ' + attesa + ' s', { status, kind: 'blocked' });
  }
  if (status === 406) throw fail('406: Overpass rifiuta le richieste che si fingono un browser', { status, kind: 'error' });
  if (status !== 200) throw fail('HTTP ' + status, { status, kind: kindForStatus(status) });
  try { return JSON.parse(body); } catch (_) { throw fail('risposta non JSON: la query e\' sbagliata o l\'istanza e\' in errore', { kind: 'parse' }); }
}

// ─── Cache su disco ──────────────────────────────────────────────────────────
// SCHEMA: da alzare a ogni cambio della FORMA dei record, o la cache serve il vecchio formato
// per tutto il TTL senza dirlo. Il resto (tetto, dato vecchio se la fonte cade, vita breve per
// un risultato sospetto) sta in cache-disco.js, uguale per tutti gli scraper.
// 2: oggetti() torna { totale, limite, oggetti } invece di un array, e conta() fa una query sola.
const conCache = cacheDisco.crea(CACHE_FILE, { tag: 'osm', schema: 2, ttl: TTL_MS, max: 400 });

// ─── Query ───────────────────────────────────────────────────────────────────
// La regione arriva da una query string: hasOwnProperty e non lettura diretta, o `?regione=
// constructor` risponde qualcosa di vero e finisce dentro la query come nome di area.
const nota = r => (r && Object.prototype.hasOwnProperty.call(REGIONI, r) ? REGIONI[r] : null);
const areaDi = regione => (nota(regione)
  ? `area["ISO3166-2"="${nota(regione)}"]->.a;`
  : 'area["ISO3166-1"="IT"][admin_level=2]->.a;');

/**
 * Conteggi per categoria. `out count` risponde in mezzo kilobyte invece di scaricare gli oggetti,
 * e tutte e tredici le categorie stanno in UNA query sola: una query, uno slot, un giro.
 *
 * Prima erano tredici richieste in fila, ed e' esattamente questo che faceva arrivare i 504.
 * L'istanza pubblica concede DUE slot per IP (lo dichiara su /api/status) e su tutta Italia una
 * sola categoria costa 42 secondi misurati: alla seconda o alla terza il dispatcher rifiutava, e
 * l'area andava in pausa dopo aver gia' consumato un minuto e mezzo di una macchina donata.
 * Misurato in Molise: 13 query separate contro 5,8 secondi per la query unica.
 *
 * L'ordine e' quello della query: `out count` non ha etichetta, quindi l'unico aggancio fra
 * conteggio e categoria e' la posizione. Se i numeri tornati non fossero tredici l'accoppiamento
 * sarebbe sfasato — si preferisce dirlo che mostrare i gommisti al posto delle colonnine.
 */
const conta = (regione) => {
  // Su TUTTA ITALIA non si fa, e non e' pigrizia: misurato, una sola categoria costa 31 secondi
  // (42 con l'area cercata per tag), quindi tredici sono circa sei minuti — oltre il nostro
  // timeout e oltre quello che e' decente chiedere a una macchina pagata con le donazioni.
  // Per regione la stessa domanda costa 5,8 secondi. Meglio dirlo che far girare a vuoto.
  if (!regione) {
    return Promise.reject(fail('contare tutte e tredici le categorie su tutta Italia sono circa '
      + 'sei minuti di calcolo: scegli una regione. Una categoria sola invece si puo\' chiedere '
      + 'anche su tutta Italia.', { kind: 'error' }));
  }
  if (!nota(regione)) return Promise.reject(fail('regione sconosciuta: ' + regione, { kind: 'error' }));
  return conCache('conta|' + regione, async () => {
    const ids = Object.keys(CATEGORIE);
    const q = `[out:json][timeout:${TIMEOUT_S}];${areaDi(regione)}`
      + ids.map(id => `nwr${CATEGORIE[id].q}(area.a);out count;`).join('');
    const el = (await overpass(q)).elements || [];
    if (el.length !== ids.length) {
      throw fail(`conteggi fuori posto: ${el.length} risposte per ${ids.length} categorie`, { kind: 'parse' });
    }
    return Object.fromEntries(ids.map((id, i) => [id, Number((el[i].tags || {}).total) || 0]));
  }, d => !d || !Object.values(d).some(Boolean));
};

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

// Quanti oggetti si portano a casa. Oltre, una tabella non si legge comunque — ma il taglio va
// fatto DALL'ISTANZA e non da noi: i distributori di tutta Italia sono 22.794 con tutti i tag,
// e scaricarli interi per tenerne 3.000 e' banda e tempo di macchina buttati, sul loro server.
const LIMITE = 3000;

/**
 * Gli oggetti di una categoria in una regione, piu' QUANTI SONO davvero.
 *
 * Conteggio e oggetti in una query sola: `out count` sullo stesso insieme risponde per primo con
 * il totale vero, poi arrivano gli oggetti gia' limitati. Cosi' l'interfaccia puo' dire "mostrati
 * i primi 3.000 di 22.794" senza che nessuno dei due numeri sia una bugia, e senza una seconda
 * richiesta per sapere il totale.
 */
const oggetti = (categoria, regione) => {
  const c = Object.prototype.hasOwnProperty.call(CATEGORIE, categoria) ? CATEGORIE[categoria] : null;
  if (!c) return Promise.reject(fail('categoria sconosciuta: ' + categoria, { kind: 'error' }));
  if (regione && !nota(regione)) return Promise.reject(fail('regione sconosciuta: ' + regione, { kind: 'error' }));
  return conCache('og|' + categoria + '|' + (regione || 'IT'), async () => {
    const q = `[out:json][timeout:${TIMEOUT_S}];${areaDi(regione)}nwr${c.q}(area.a)->.r;.r out count;.r out center tags ${LIMITE};`;
    const el = (await overpass(q)).elements || [];
    const conta1 = el[0] && el[0].type === 'count' ? Number((el[0].tags || {}).total) : null;
    const v = el.filter(e => e.type !== 'count').map(e => mappaOggetto(e, c.chiavi));
    return { totale: Number.isFinite(conta1) ? conta1 : v.length, limite: LIMITE, oggetti: v };
  }, d => !d || !d.oggetti || !d.oggetti.length);
};

module.exports = {
  conta, oggetti, pausaFinoA, stato, LIMITE,
  CATEGORIE, REGIONI,
  _overpass: overpass, _mappaOggetto: mappaOggetto, _areaDi: areaDi, _leggiStato: leggiStato, _CACHE_FILE: CACHE_FILE,
};
