'use strict';
/**
 * bilstein group partsfinder — la CROSS-REFERENCE fra codice originale e ricambio aftermarket.
 *
 * PERCHE'. L'area ricambi sa trovare un pezzo (Autodoc, CMSNL, eBay, Subito) ma non sa dire che
 * il codice 1K0 615 301 AA della Golf e' lo stesso pezzo del 5Q0 615 301 F, e che monta anche su
 * Audi, Seat, Skoda, Cupra e perfino Ford. Questa e' l'unica fonte aperta che ce lo dice, ed e'
 * il catalogo tecnico di tre marchi veri (febi, SWAG, Blue Print), non un aggregatore.
 *
 * COSA PORTA, per articolo: la denominazione in ITALIANO, il lato di montaggio, il marchio, la
 * quantita' d'imballo, l'elenco dei codici ORIGINALI raggruppati per costruttore, e le MISURE
 * tecniche con l'unita' (diametro esterno, spessore, spessore minimo, diametro cerchio fori,
 * diametro di centraggio, numero di bulloni…). Su un disco freno sono nove misure: bastano per
 * capire se il pezzo che hai in magazzino e' quello giusto senza smontarlo.
 *
 * ACCESSO: API JSON:API pubblica, nessuna chiave, nessun anti-bot. Una sola trappola, ma secca:
 * il media type `application/vnd.api+json` e' OBBLIGATORIO nell'header Accept — con
 * `application/json` la risposta e' 406.
 *
 * NORMALIZZAZIONE, senza la quale non aggancia mai: i codici OE sono scritti con gli spazi
 * ("85E 819 439 B") mentre negli annunci e nei nostri dati arrivano attaccati. Il confronto va
 * fatto su stringa ripulita.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { fail, kindForStatus } = require('./utils');

const HOST = 'partsfinder.bilsteingroup.com';
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'bilstein-cache.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // un catalogo tecnico cambia di rado
const TIMEOUT_MS = 20000;
const PAUSA_MS = 1500;
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
        'User-Agent': UA,
        // Obbligatorio: con application/json la risposta e' 406.
        Accept: 'application/vnd.api+json',
        'Accept-Language': 'it-IT,it;q=0.9', 'Accept-Encoding': 'gzip',
        Referer: 'https://partsfinder.bilsteingroup.com/it/',
      },
    }, res => {
      const c = []; let s = res;
      if ((res.headers['content-encoding'] || '') === 'gzip') s = res.pipe(zlib.createGunzip());
      s.on('data', x => c.push(x));
      s.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      s.on('error', reject);
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
  if (status === 403 || status === 429) {
    bloccatoFino = Date.now() + 30 * 60 * 1000;
    throw fail('bloccati (HTTP ' + status + '), pausa 30 min', { status, kind: 'blocked' });
  }
  if (status === 406) throw fail('406: manca il media type application/vnd.api+json', { status, kind: 'error' });
  if (status !== 200) throw fail('HTTP ' + status, { status, kind: kindForStatus(status) });
  try { return JSON.parse(body); } catch (_) { throw fail('risposta non JSON', { kind: 'parse' }); }
}

// ─── Cache su disco ──────────────────────────────────────────────────────────
const SCHEMA = 1;
let memo = null;
const leggi = () => {
  if (!memo) {
    try { memo = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { memo = { schema: SCHEMA, voci: {} }; }
    if (memo.schema !== SCHEMA) memo = { schema: SCHEMA, voci: {} };
    if (!memo.voci) memo.voci = {};
  }
  return memo;
};
const scrivi = () => { try { fs.writeFileSync(CACHE_FILE, JSON.stringify(leggi())); } catch (_) {} };
const inVolo = new Map();
async function conCache(chiave, produci, sospettoSe) {
  const c = leggi();
  const v = c.voci[chiave];
  if (v && Date.now() - v.t < TTL_MS) return v.d;
  if (inVolo.has(chiave)) return inVolo.get(chiave);
  const p = (async () => {
    try {
      const d = await produci();
      const sospetto = sospettoSe ? !!sospettoSe(d) : false;
      c.voci[chiave] = { t: sospetto ? Date.now() - TTL_MS + 15 * 60 * 1000 : Date.now(), d };
      scrivi(); return d;
    } catch (e) {
      if (v) { console.warn('[bilstein] ' + chiave + ' KO (' + e.message + '): servo la cache vecchia'); return v.d; }
      throw e;
    } finally { inVolo.delete(chiave); }
  })();
  inVolo.set(chiave, p);
  return p;
}

/** Codice pulito per il confronto: la fonte scrive "85E 819 439 B", noi riceviamo "85E819439B". */
const normCodice = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Da un articolo JSON:API a quello che mostriamo. */
function mappa(a) {
  const A = (a && a.attributes) || {};
  const oe = (A.oeNumbers || []).map(g => ({
    costruttore: g.make || null,
    codici: (g.numbers || []).filter(Boolean),
  })).filter(g => g.codici.length);
  return {
    id: a.id != null ? String(a.id) : null,
    articolo: A.masterId != null ? String(A.masterId) : null,
    marchio: A.bgBrand || null,                    // FEBI | SWAG | BLUE_PRINT
    descrizione: A.articleDescription || null,     // in italiano: "disco freno"
    lato: A.fittingSide || null,                   // "assale anteriore"
    tipoVeicolo: A.vehicleType || null,
    imballo: A.packagingQty != null ? Number(A.packagingQty) : null,
    // ── la cross-reference: il motivo per cui questa fonte esiste ──
    originali: oe,
    // Tutti i codici in fila, gia' normalizzati: e' la forma su cui si confronta col nostro OE.
    codiciNormalizzati: [...new Set(oe.flatMap(g => g.codici.map(normCodice)))],
    costruttori: oe.map(g => g.costruttore).filter(Boolean),
    // ── le misure tecniche, con l'unita' dichiarata dalla fonte ──
    misure: (A.articleAttributes || []).map(x => ({
      nome: x.type || null,
      valore: x.value != null ? String(x.value) : null,
      unita: x.unit || null,
    })).filter(x => x.nome && x.valore),
    scheda: A.bgBrand && A.masterId
      ? 'https://partsfinder.bilsteingroup.com/it/article/' + String(A.bgBrand).toLowerCase().replace('_', '') + '/' + A.masterId
      : null,
  };
}

/**
 * Cerca per CODICE (originale o aftermarket). `searchType=n` e' la ricerca per numeri: con `a`
 * cerca ovunque e restituisce rumore.
 */
const perCodice = (codice, tipo = 'CAR') => conCache('n|' + normCodice(codice) + '|' + tipo, async () => {
  const c = String(codice || '').trim();
  if (!c) throw fail('codice mancante', { kind: 'error' });
  const par = new URLSearchParams();
  par.set('filter[phrase]', c);
  par.set('filter[searchType]', 'n');
  par.set('filter[vehicleType]', tipo === 'MOTO' ? 'MOTORCYCLE' : 'CAR');
  par.set('filter[country]', 'IT');
  const j = await getJson('/api/articles?' + par.toString());
  const meta = (j.meta && j.meta.page) || {};
  return {
    cercato: c,
    totale: Number(meta.totalElements) || (Array.isArray(j.data) ? j.data.length : 0),
    articoli: (Array.isArray(j.data) ? j.data : [j.data]).filter(Boolean).map(mappa),
  };
}, d => !d || (d.totale > 0 && !d.articoli.length));

/**
 * Da un codice a TUTTI gli equivalenti, appiattiti. E' la domanda che si fa davvero in officina:
 * "questo pezzo che altri codici ha?".
 */
async function equivalenti(codice, tipo) {
  const r = await perCodice(codice, tipo);
  const q = normCodice(codice);
  const fuori = new Map();
  for (const a of r.articoli) {
    for (const g of a.originali) {
      for (const c of g.codici) {
        const k = normCodice(c);
        if (k === q) continue;                       // il codice cercato non e' un suo equivalente
        if (!fuori.has(k)) fuori.set(k, { codice: c, costruttori: new Set() });
        fuori.get(k).costruttori.add(g.costruttore);
      }
    }
  }
  return {
    cercato: codice,
    trovatoIn: r.articoli.length,
    equivalenti: [...fuori.values()].map(v => ({ codice: v.codice, costruttori: [...v.costruttori] })),
  };
}

module.exports = { perCodice, equivalenti, pausaFinoA, _mappa: mappa, _normCodice: normCodice, _CACHE_FILE: CACHE_FILE };
