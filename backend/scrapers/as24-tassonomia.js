'use strict';
/**
 * LE VERSIONI SECONDO AUTOSCOUT — il terzo catalogo, che credevamo non esistesse.
 *
 * Su Autoscout la versione dell'annuncio e' testo libero, e da li' avevamo concluso che
 * un catalogo di versioni non ci fosse. C'e': e' la tendina che il venditore usa quando
 * inserisce l'annuncio, e sta sulla stessa API della ricerca — `getFreeTextTaxonomyV2`.
 *
 *   "BMW 320"          → 320i · 320d · 320e
 *   "Volkswagen Golf"  → GTI (1501) · GTD (479) · R · GTE · Plus · Variant · E-Golf
 *   "Fiat Panda"       → Cross · 0.9 TwinAir · 1.2 · 1.2 Natural Power
 *
 * PERCHE' SERVE, e non e' un di piu'. Il campo versione della ricerca Autoscout e'
 * `modelVersionInput`, testo. Quel testo prima glielo costruivamo noi traducendo il nome
 * di Subito — "Golf 1.6 16V cat 3 porte Comfortline" tolto `cat`, tolto `porte`, tolto il
 * numero sciolto — una regola scritta guardando UN caso, che su un altro taglia troppo o
 * troppo poco. Il testo giusto Autoscout ce l'ha gia' scritto, nel campo `subtitle`.
 *
 * Misurato, marca + codice modello + il testo di qui:
 *   "320d"              50 annunci su 50
 *   "Gran Turismo 320d" 50 su 50
 *   "Touring 320i"      34 su 34
 *
 * DUE LIMITI, misurati e non aggirati:
 *
 *   SOLO AUTO. Cercando "Yamaha MT-07" la tassonomia risponde Changan Deepal e BMW X7,
 *   con qualunque vehicleTypeId: e' un catalogo di automobili e al resto risponde per
 *   somiglianza, cioe' spazzatura che sembra un risultato. Per questo c'e' il controllo
 *   sulla marca piu' sotto, e per questo le moto qui non passano — le loro versioni le
 *   da' Moto.it, che le filtra pure alla fonte.
 *
 *   LIVELLO 2, NON 3. Il livello 3 aggiunge la carrozzeria, ma con le parole inglesi:
 *   "Sedan 320d" trova UN annuncio perche' in Italia si scrive "Berlina". Il livello 2
 *   sono le motorizzazioni, che si scrivono uguali in tutte le lingue.
 *
 * Una richiesta per modello, in cache: la stessa lista serve ogni ricerca di quel modello.
 */
const https = require('https');
const budget = require('../budget-richieste');

const HOST = 'listing-search.api.autoscout24.com';
// Credenziale pubblica del funnel di ricerca AS24, la stessa di autoscout-graphql.js:
// non e' un nostro segreto. Se smette (401) smette anche la ricerca, e si ri-cattura li'.
const AUTH = 'Basic YXMyNC1zZWFyY2gtZnVubmVsOnZucmZiYkJqSTMyT2wxV2thNnVOSFJwM0VZbjRkag==';
const TIMEOUT_MS = 12000;
const TTL = 12 * 60 * 60 * 1000;
const MAX_CACHE = 400;

const QUERY = `query T($s:String,$l:Int,$d:Int,$v:String){
  getFreeTextTaxonomyV2(searchTerm:$s,limit:$l,filterDepth:$d,vehicleTypeId:$v){
    items{ displayName subtitle listingsCount cat }
  }
}`.replace(/\s+/g, ' ');

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const cache = new Map();   // `${tipo}|${termine}` → { ts, voci }

function post(body) {
  budget.conta('as24', 'tassonomia');
  return new Promise((resolve, reject) => {
    const d = Buffer.from(body, 'utf8');
    const req = https.request({
      host: HOST, path: '/graphql', method: 'POST',
      headers: {
        authorization: AUTH, 'content-type': 'application/json', accept: '*/*',
        origin: 'https://www.autoscout24.it', referer: 'https://www.autoscout24.it/',
        'x-culture': 'it-IT', culture: 'it-IT',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/604.1',
        'content-length': d.length,
      },
    }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error('timeout')); });
    req.write(d); req.end();
  });
}

/** Un intervallo di anni non e' una versione: "(2012 - attuale)" e' la generazione. */
const soloAnni = s => /^\(?\s*\d{4}\s*[-–]/.test(String(s).trim());

/**
 * Le versioni Autoscout per un modello auto.
 *
 * @param {string} tipo     'auto' | 'moto' — le moto tornano sempre vuoto, vedi sopra
 * @param {string} marca    serve al controllo: la risposta deve parlare di questa marca
 * @param {string} modello  il nome del modello come lo cerca l'utente
 * @returns {Promise<Array>} [{ testo, nome, annunci }] — vuoto se la fonte non risponde
 */
async function versioniAs24(tipo, marca, modello) {
  if (tipo === 'moto') return [];
  const m = String(marca || '').trim();
  const mo = String(modello || '').trim();
  if (!m || !mo) return [];
  const termine = `${m} ${mo}`;
  const chiave = `${tipo}|${norm(termine)}`;
  const hit = cache.get(chiave);
  if (hit && Date.now() - hit.ts < TTL) return hit.voci;

  let voci = [];
  try {
    const r = await post(JSON.stringify({ query: QUERY, variables: { s: termine, l: 60, d: 2, v: 'C' } }));
    if (r.status !== 200) return [];
    let j; try { j = JSON.parse(r.body); } catch (_) { return []; }
    if (j.errors) return [];
    const items = (j.data && j.data.getFreeTextTaxonomyV2 && j.data.getFreeTextTaxonomyV2.items) || [];
    const marcaNorm = norm(m);
    voci = items
      // IL CONTROLLO CHE EVITA LA SPAZZATURA: la tassonomia risponde per somiglianza e
      // a un termine che non conosce restituisce le auto di un'altra marca. Se il nome
      // completo non comincia con la marca chiesta, non e' una risposta: e' un ripiego.
      .filter(i => norm(i.displayName).startsWith(marcaNorm))
      .filter(i => i.subtitle && !soloAnni(i.subtitle))
      .map(i => ({ testo: String(i.subtitle).trim(), nome: String(i.displayName).trim(), annunci: i.listingsCount || 0, cat: i.cat || null }));
  } catch (e) {
    console.warn('[as24-tassonomia] "' + termine + '": ' + e.message);
    return [];                                   // la fonte non risponde: nessuna voce, nessun danno
  }
  cache.set(chiave, { ts: Date.now(), voci });
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return voci;
}

module.exports = { versioniAs24, _soloAnni: soloAnni };
