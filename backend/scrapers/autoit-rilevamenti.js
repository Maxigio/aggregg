'use strict';
/**
 * Rilevamenti di Auto (auto.it) — le MISURE, non le dichiarazioni del costruttore.
 *
 * PERCHE' ESISTE. Le altre tre fonti del catalogo danno il dato DICHIARATO: consumo WLTP,
 * velocita' e accelerazione da scheda tecnica. Questa da' quello che la redazione ha misurato
 * al banco e in pista: velocita' massima reale, 0-100 reale, ripresa 80-120, frenata 100-0 in
 * metri, consumi veri citta'/autostrada/medio. Sul consumo la differenza e' denaro: sul
 * riquadro carburante avevamo gia' misurato fino a 522 €/anno fra dichiarato e reale.
 * Ogni prova porta anche il link all'articolo pubblicato: si mostra il numero e si manda a
 * leggere la prova, invece di ricopiare un archivio.
 *
 * STATO DELLA FONTE, detto e non nascosto. auto.it NON ha robots.txt (404: nessun percorso
 * vietato) e le pagine sono indicizzabili — al contrario del webservice Motornet, che vieta
 * tutto esplicitamente e per questo ha un interruttore. Qui l'interruttore non c'e': la fonte
 * si tratta come auto-data.net e Moto.it, cioe' con garbo e con la fonte sempre citata.
 * L'editore e' Corriere dello Sport S.r.l., i contenuti sono suoi: si mostrano i valori
 * misurati con l'attribuzione e il rimando all'articolo, non si ridistribuisce l'archivio.
 *
 * Struttura verificata a mano il 2026-07-25:
 *   GET /rilevamenti                      → indice: 45 marche che hanno prove
 *   GET /marche/<slug>/rilevamenti[/<n>]  → 10 prove per pagina, JSON dentro il payload RSC
 * Il parsing e' stato provato offline su una pagina salvata: 10 record su 10, zero falliti.
 */
const https = require('https');
const zlib = require('zlib');
const path = require('path');

const { kindForStatus, fail } = require('./utils');

const HOST = 'www.auto.it';
const cacheDisco = require('./cache-disco');
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'autoit-rilevamenti-cache.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;   // sono prove d'archivio: cambiano di rado
const TIMEOUT_MS = 15000;
const PAUSA_MS = 1500;                    // minimo fra due richieste
const MAX_PAGINE = 12;                    // tetto di sicurezza: nessuna marca ne ha tante
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Host fisso e nessun redirect seguito: il percorso lo scegliamo noi.
async function getHtml(percorso) {
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
  // Lo slot si PRENOTA prima di dormire, non si segna dopo: due chiamate che entrano insieme
  // leggerebbero lo stesso `ultima`, dormirebbero uguale e partirebbero insieme, dividendo il
  // freno per il numero di chiamanti invece di rispettarlo.
  const ora = Date.now();
  const quando = Math.max(ora, ultima + PAUSA_MS);
  ultima = quando;
  if (quando > ora) await sleep(quando - ora);
  const { status, body } = await new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path: percorso,
      headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', 'Accept-Encoding': 'gzip', Accept: 'text/html' },
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
  if (status !== 200) throw fail('HTTP ' + status, { status, kind: kindForStatus(status) });
  return body;
}

// ─── Cache su disco: e' il freno principale ──────────────────────────────────
/**
 * LA STESSA CACHE DI TUTTE LE ALTRE. Qui c'era una copia scritta a mano, e le mancavano le
 * tre cose che il modulo comune fa da sempre:
 *  - il NUMERO DI SCHEMA: la cache tiene gli oggetti gia' interpretati, quindi cambiare il
 *    parser senza alzarlo significa servire il formato vecchio per sette giorni senza
 *    accorgersene. E' successo davvero coi telai del Safety Gate;
 *  - il TETTO: senza, il file cresce senza fine e ogni miss lo riscrive INTERO;
 *  - DOVE SI SCRIVE: qui si scriveva dentro la cartella dell'app, che nel pacchetto Electron
 *    e' di sola lettura. L'errore finiva in un `catch` vuoto, quindi la cache non
 *    sopravviveva a un riavvio e a ogni avvio si ricrawlava tutto — proprio la raffica che
 *    si becca il 403 che questa cache doveva evitare.
 *
 * Un risultato vuoto o dichiarato incompleto non e' un dato: e' un intoppo. Si serve lo
 * stesso, ma scade in 15 minuti invece che in 7 giorni, altrimenti un singolo 500 o un
 * cambio di markup congela una marca per una settimana.
 */
const SOSPETTO = d => (Array.isArray(d) ? !d.length : !!(d && (d.completo === false || !(d.rilevamenti || []).length)));
const _cache = cacheDisco.crea(CACHE_FILE, { tag: 'autoit', schema: 1, ttl: TTL_MS, max: 200 });
const conCache = (chiave, produci) => _cache(chiave, produci, SOSPETTO);

// ─── Parsing ─────────────────────────────────────────────────────────────────
// Il sito e' un Next.js con App Router: i dati non stanno nell'HTML ma nel payload RSC,
// spezzato in tanti self.__next_f.push([1,"…"]) da ricucire e de-escapare.
function payloadRsc(html) {
  const ch = [...String(html).matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)].map(m => m[1]).join('');
  try { return JSON.parse('"' + ch + '"'); } catch (_) { return ch; }
}

// Dall'interno di un oggetto JSON alle sue graffe: si risale al '{' che lo apre e si scende
// al '}' che lo chiude. Serve perche' i record sono annegati in un payload che non e' JSON.
function oggettoAttorno(s, pos) {
  let apri = -1, prof = 0;
  for (let i = pos; i >= 0; i--) {
    if (s[i] === '}') prof++;
    else if (s[i] === '{') { if (prof === 0) { apri = i; break; } prof--; }
  }
  if (apri < 0) return null;
  prof = 0;
  for (let i = apri; i < s.length; i++) {
    if (s[i] === '{') prof++;
    else if (s[i] === '}') { prof--; if (prof === 0) return s.slice(apri, i + 1); }
  }
  return null;
}

const num = v => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
const testo = v => { const t = String(v == null ? '' : v).trim(); return t && t !== '-' && t !== 'n.r.' ? t : null; };
// I consumi della fonte sono in km/l; il resto dell'app ragiona in l/100 km. Sulle elettriche
// pure la fonte da' km/kWh: il conto e' identico, cambia solo l'unita' — vedi unitaConsumo.
const per100 = kml => (kml > 0 ? Math.round(100 / kml * 100) / 100 : null);

/** Da un record grezzo del payload a quello che mostriamo. */
function mappaRecord(r) {
  const nome = String(r.Modello || '').trim();
  if (!nome) return null;
  const m = nome.match(/\s-\s(\d{4})\s*$/);
  const medio = num(r.ConsumoMedio), citta = num(r.ConsumoCitta), extra = num(r.ConsumoAutostrada);
  // L'unita' la dichiara la fonte, non il flag AutoElettrica: la F-Pace P400e ha
  // AutoElettrica:true ed e' una plug-in, i suoi 10,42 l/100 km sono carburante vero.
  const kwh = /kwh/i.test([r.ConsumoMedio, r.ConsumoCitta, r.ConsumoAutostrada].join(' '));
  return {
    id: r.id != null ? r.id : null,
    nome: m ? nome.slice(0, m.index).trim() : nome,
    anno: m ? Number(m[1]) : null,
    velocitaMax: num(r.VelocitaMassima),
    acc0_100: testo(r.Accelerazione0_100),
    acc0_400: testo(r.Accelerazione0_400),
    acc0_1000: testo(r.Accelerazione0_1000),
    ripresa80_120: testo(r.Ripresa_80_120_km_h),
    frenata100_0: num(r.Frenata100km_h_metri),
    pista: testo(r.TestHandling),
    consumoMedio: medio, consumoCitta: citta, consumoAutostrada: extra,
    // La conversione e' cio' che rende il dato usabile dal nostro calcolo carburante.
    l100Medio: per100(medio), l100Citta: per100(citta), l100Autostrada: per100(extra),
    unitaConsumo: kwh ? 'kWh/100km' : 'l/100km',
    autonomiaBatteria: testo(r.AutonomiaBatteria),
    elettrica: r.AutoElettrica === true,
    cambioAutomatico: r.CambioAutomatico === true,
    autoDellAnno: r.AutoDellAnno === true,
    prova: testo(r.NumeroProva),
    link: /^https?:\/\//.test(String(r.LinkProva || '')) ? r.LinkProva : null,
    copertina: /^https?:\/\//.test(String(r.Copertina || '')) ? r.Copertina : null,
  };
}

function estraiRecord(html) {
  const flat = payloadRsc(html);
  const out = [];
  const visti = new Set();
  for (const m of flat.matchAll(/"VelocitaMassima"/g)) {
    const t = oggettoAttorno(flat, m.index);
    if (!t) continue;
    let r; try { r = JSON.parse(t); } catch (_) { continue; }
    const v = mappaRecord(r);
    if (!v) continue;
    const k = v.id != null ? 'id' + v.id : v.nome + '|' + v.anno;
    if (visti.has(k)) continue;
    visti.add(k); out.push(v);
  }
  return out;
}

// Il totale dichiarato dall'intestazione ("13 rilevamenti"): serve a sapere quando fermarsi
// senza chiedere una pagina di troppo.
const totaleDichiarato = html => { const m = String(html).match(/(\d+)\s*rilevament/i); return m ? Number(m[1]) : null; };

// Ripiego, se il payload non desse i nomi: "alfa-romeo-alf" → "Alfa Romeo" (l'ultimo pezzo e'
// la sigla). Le sigle brevi restano MAIUSCOLE, altrimenti BMW diventa "Bmw" e DS "Ds".
function nomeDaSlug(slug) {
  const p = String(slug || '').split('-').filter(Boolean);
  if (p.length > 1 && p[p.length - 1].length <= 3) p.pop();
  return p.map(x => (x.length <= 3 ? x.toUpperCase() : x.charAt(0).toUpperCase() + x.slice(1))).join(' ');
}

// L'indice porta nel payload l'elenco completo, gia' strutturato:
//   {"name":"Porsche","logo":"…/POR.png","link":"/marche/porsche-por/rilevamenti"}
// Meglio leggere quello che dedurre i nomi dagli slug: la fonte sa come si chiama.
function marcheDaIndice(html) {
  const flat = payloadRsc(html);
  const out = new Map();
  for (const m of flat.matchAll(/\/marche\/([a-z0-9-]+)\/rilevamenti/g)) {
    const slug = m[1];
    const t = oggettoAttorno(flat, m.index);
    let nome = null, logo = null;
    if (t) {
      try { const o = JSON.parse(t); nome = o.name || null; logo = /^https?:\/\//.test(String(o.logo || '')) ? o.logo : null; }
      catch (_) { /* oggetto non parsabile: si ripiega sullo slug */ }
    }
    if (!out.has(slug) || (nome && !out.get(slug).daPayload)) {
      out.set(slug, { acronimo: slug, nome: nome || nomeDaSlug(slug), logo, daPayload: !!nome });
    }
  }
  return [...out.values()].map(({ daPayload, ...v }) => v).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

// ─── Superficie pubblica ─────────────────────────────────────────────────────
/** Le marche che hanno prove: [{slug, nome}]. */
const marche = () => conCache('marche', async () => marcheDaIndice(await getHtml('/rilevamenti')));

/** Tutte le prove di una marca, seguendo la paginazione. */
const rilevamenti = slug => conCache('riv|' + slug, async () => {
  const base = `/marche/${encodeURIComponent(slug)}/rilevamenti`;
  const primo = await getHtml(base);
  const atteso = totaleDichiarato(primo);
  const out = estraiRecord(primo);
  const visti = new Set(out.map(r => (r.id != null ? 'id' + r.id : r.nome + '|' + r.anno)));
  for (let p = 2; p <= MAX_PAGINE; p++) {
    if (atteso != null && out.length >= atteso) break;
    let html;
    try { html = await getHtml(`${base}/${p}`); } catch (e) { if (e.kind === 'blocked') throw e; break; }
    const nuovi = estraiRecord(html).filter(r => {
      const k = r.id != null ? 'id' + r.id : r.nome + '|' + r.anno;
      if (visti.has(k)) return false; visti.add(k); return true;
    });
    if (!nuovi.length) break;                 // pagina senza novita': l'elenco e' finito
    out.push(...nuovi);
  }
  // L'intestazione dice quante prove ci sono e non ne abbiamo estratta nessuna: non e' una
  // marca senza prove, e' il parsing che non aggancia piu'. Meglio un errore dichiarato che un
  // "Nessuna prova con questo nome" archiviato per 7 giorni.
  if (atteso && !out.length) throw fail('rilevamenti non estratti per ' + slug + ': la pagina della fonte e\' cambiata', { kind: 'parse' });
  return {
    marca: nomeDaSlug(slug), slug,
    dichiarati: atteso, rilevamenti: out,
    // Se il conto non torna lo si dice, invece di far credere che sia tutto.
    completo: atteso == null ? null : out.length >= atteso,
    fonte: 'Auto (auto.it) — rilevamenti della redazione',
  };
});

/** Istante (ms) fino al quale la fonte e' in pausa dopo un blocco; 0 se e' libera. */
const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

module.exports = {
  marche, rilevamenti, pausaFinoA,
  _estraiRecord: estraiRecord, _mappaRecord: mappaRecord, _nomeDaSlug: nomeDaSlug, _marcheDaIndice: marcheDaIndice,
  _payloadRsc: payloadRsc, _oggettoAttorno: oggettoAttorno, _per100: per100, _CACHE_FILE: CACHE_FILE,
};
