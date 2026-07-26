'use strict';
/**
 * Prove di inSella — la quinta fonte del catalogo, e la prima che porta MISURE sulle MOTO.
 *
 * PERCHE' ESISTE. auto.it ci da' i rilevamenti strumentali delle auto; per le moto avevamo solo
 * dichiarazioni del costruttore (ultimatespecs, Moto.it). inSella misura al banco e in pista, e
 * pubblica il dato accanto a quello dichiarato: sulla Tuono 457 la casa dichiara 47,6 CV,
 * il banco ne legge 45,93 ALLA RUOTA. La differenza fra dichiarato e reale e' esattamente cio'
 * che un concessionario non trova da nessun'altra parte.
 *
 * COSA PRENDIAMO, e perche' tanto. Il proprietario ha chiesto di non lasciare indietro niente di
 * cio' che la pagina serve. Mappato a mano il 2026-07-26, una pagina prova contiene SEI blocchi
 * distinti, non uno:
 *   1. ld+json Vehicle  → prezzo di listino, voto medio e numero di voti, classe emissioni,
 *                         cambio e marce, carburante, serbatoio, peso, cilindrata, potenza;
 *   2. ld+json Article  → titolo, sommario, data, autore, immagine di copertina;
 *   3. tabella RILEVAMENTI → i valori MISURATI (vedi sotto);
 *   4. tabella DICHIARATI  → la scheda della casa;
 *   5. tabella DIMENSIONI  → passo, lunghezza, altezza sella misurati da loro;
 *   6. voti per dimensione → 11 voci (comfort, tenuta, consumo, cambio, vano sottosella,
 *                            posizione di guida, finiture, prestazioni, freni, sospensioni).
 * Piu' la METODOLOGIA di misura in coda ai rilevamenti (banco, satellitare, bilancia): e' cio'
 * che rende il numero credibile, e va mostrata insieme al numero.
 *
 * ATTENZIONE ALLE DISCREPANZE, che sono vere e non vanno appianate: sulla stessa moto il peso
 * risulta 159 kg nella tabella dichiarati, 165 nella scheda modello e 175 nel ld+json (a secco,
 * in ordine di marcia, e massa totale). Il serbatoio 12 contro 13 litri. Si espongono TUTTI con
 * l'etichetta della loro provenienza, invece di sceglierne uno e far finta che sia l'unico.
 *
 * STATO DELLA FONTE. Il robots.txt di insella.it vieta solo le ricerche sfaccettate a parametri
 * (?cilindrata=, ?cambio=, ...): le pagine /prova/ NON sono vietate. Si tratta la fonte come
 * auto.it e Moto.it, con garbo e con l'attribuzione sempre in vista.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const { kindForStatus, fail } = require('./utils');

const HOST = 'www.insella.it';
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'insella-prove-cache.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TTL_CORTO_MS = 15 * 60 * 1000;      // vita breve per un risultato sospetto (vuoto/parziale)
const TIMEOUT_MS = 15000;
const PAUSA_MS = 1500;
const MAX_PAGINE = 12;                    // per categoria: nessuna ne ha tante
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

// Le dieci categorie di prova, lette dal menu del sito il 2026-07-26.
const CATEGORIE = ['crossover', 'custom', 'enduro', 'motard', 'naked', 'scooter', 'scrambler', 'sportive', 'stradali', 'trial'];

let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getHtml(percorso) {
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
  // Lo slot si prenota PRIMA di dormire: due chiamate che entrano insieme leggerebbero lo stesso
  // `ultima` e partirebbero appaiate, dividendo il freno per il numero di chiamanti.
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

/** Istante (ms) fino al quale la fonte e' in pausa dopo un blocco; 0 se e' libera. */
const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

// ─── Cache su disco ──────────────────────────────────────────────────────────
let memo = null;
const leggi = () => { if (!memo) { try { memo = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { memo = { voci: {} }; } if (!memo.voci) memo.voci = {}; } return memo; };
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
      // Un risultato vuoto non e' un dato, e' un intoppo: si serve lo stesso ma scade in 15
      // minuti invece che in 7 giorni, cosi' un cambio di markup non congela la fonte.
      const sospetto = sospettoSe ? !!sospettoSe(d) : false;
      c.voci[chiave] = { t: sospetto ? Date.now() - TTL_MS + TTL_CORTO_MS : Date.now(), d };
      scrivi();
      return d;
    } catch (e) {
      if (v) { console.warn('[insella] ' + chiave + ' KO (' + e.message + '): servo la cache vecchia'); return v.d; }
      throw e;
    } finally { inVolo.delete(chiave); }
  })();
  inVolo.set(chiave, p);
  return p;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────
const testo = s => String(s == null ? '' : s)
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&deg;/g, '°')
  .replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Numero da una stringa, con la trappola dei due formati che convivono nella STESSA pagina:
 * le tabelle scrivono all'italiana ("176,6" decimale, "9.200" migliaia), il ld+json scrive
 * all'inglese ("4.6" decimale). Trattare il punto sempre da separatore di migliaia trasformava
 * il voto 4.6 in 46; trattarlo sempre da decimale avrebbe reso 9.200 giri in 9,2.
 * Regola: se c'e' una virgola, comanda lei ed i punti sono migliaia; se non c'e', il punto e'
 * migliaia solo quando raggruppa a tre cifre esatte, altrimenti e' decimale.
 */
const num = v => {
  let s = String(v == null ? '' : v).trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return /^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(n) ? n : null;
};
// I consumi di inSella sono in km/l, come auto.it; il resto dell'app ragiona in l/100 km.
const per100 = kml => (kml > 0 ? Math.round(100 / kml * 100) / 100 : null);

function ldJson(html) {
  const out = {};
  for (const m of String(html).matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch (_) { continue; }
    for (const o of (Array.isArray(j) ? j : [j])) if (o && o['@type']) out[o['@type']] = o;
  }
  return out;
}

/** Coppie etichetta→valore di una tabella HTML. Le righe-intestazione (senza valore) si tengono
 *  come "sezione": nella tabella rilevamenti servono a dire l'unita' ("Accelerazione | secondi"). */
function coppieTabella(htmlTabella) {
  const fuori = [];
  for (const r of String(htmlTabella).matchAll(/<tr[\s\S]*?<\/tr>/g)) {
    const celle = [...r[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/g)].map(x => testo(x[0]));
    if (!celle.length || !celle[0]) continue;
    fuori.push({ etichetta: celle[0], valore: celle.length > 1 ? celle[1] : null });
  }
  return fuori;
}

/**
 * Rilevamenti misurati. La tabella e' a due colonne con righe-titolo che introducono l'unita'
 * ("Consumi | km/l"), quindi le etichette figlie ("Autostrada") vanno lette sotto il titolo
 * corrente, altrimenti "A 120 km/h" del blocco consumi si confonde con quello dell'autonomia.
 */
const SEZIONI = [
  { re: /^accelerazione/, k: 'acc' },
  { re: /^ripresa/, k: 'ripresa' },
  { re: /^frenata/, k: 'frenata' },
  { re: /^consumi/, k: 'consumi' },
  { re: /^autonomia/, k: 'autonomia' },
  { re: /^potenza/, k: 'potenza' },
];

function misureDa(coppie) {
  const m = { velocitaMax: null, acc: {}, ripresa: {}, potenzaRuota: null, frenata: {}, consumi: {}, autonomia: {} };
  let sezione = null;
  for (const { etichetta, valore } of coppie) {
    const e = etichetta.toLowerCase();
    // Il titolo di sezione si riconosce dall'ETICHETTA, non dal valore mancante. Prima bastava una
    // cella vuota per far cambiare sezione, e sulle prove vecchie succede davvero: nella tabella
    // della Adiva AR 200 la riga "A 120 km/h" dei consumi non ha valore, e da li' in poi il
    // consumo "Al massimo" finiva in una sezione inesistente e spariva.
    const s = SEZIONI.find(x => x.re.test(e));
    if (s) { sezione = s.k; continue; }
    if (/^velocit.*massima/.test(e)) { m.velocitaMax = num(valore); sezione = null; continue; }
    if (/^cv\/kw$/.test(e)) {
      // Le prove vecchie scrivono solo i CV ("12,4"), le nuove entrambi ("45,93/34,25").
      const p = String(valore == null ? '' : valore).split('/');
      m.potenzaRuota = { cv: num(p[0]), kw: p.length > 1 ? num(p[1]) : null, giri: null };
      continue;
    }
    if (/^giri al minuto$/.test(e)) { if (m.potenzaRuota) m.potenzaRuota.giri = num(valore); continue; }
    const n = num(valore);
    if (n == null) continue;                       // dato mancante: si salta, la sezione resta
    if (sezione === 'acc') m.acc[etichetta] = n;
    else if (sezione === 'ripresa') m.ripresa[etichetta] = n;
    else if (sezione === 'frenata') m.frenata[etichetta] = n;
    else if (sezione === 'consumi') m.consumi[etichetta] = n;
    else if (sezione === 'autonomia') m.autonomia[etichetta] = n;
  }
  // I consumi arrivano in km/l: si affianca la conversione, che e' cio' che rende il dato usabile
  // dal nostro calcolo del costo carburante.
  m.consumiL100 = {};
  for (const [k, v] of Object.entries(m.consumi)) m.consumiL100[k] = per100(v);
  return m;
}

/** Gli 11 voti per dimensione. Il blocco compare due volte (desktop e mobile): si deduplica. */
function votiDa(html) {
  const fuori = {};
  for (const r of String(html).matchAll(/<div class="node__ratings__row">([\s\S]{0,2000}?)<\/div>\s*<\/div>\s*<\/div>/g)) {
    const eti = testo((r[1].match(/<div>([^<]{2,40})<\/div>/) || [, ''])[1]);
    const val = (r[1].match(/<span class="on">\s*([\d.,]+)\s*<\/span>/) || [, ''])[1];
    const n = num(val);
    if (eti && n != null && fuori[eti] == null) fuori[eti] = n;
  }
  return fuori;
}

/** Il testo di una sezione ancorata (in_sintesi, come_va, rilevamenti, dati_tecnici). */
function sezione(html, id) {
  const i = String(html).indexOf('id="' + id + '"');
  if (i < 0) return null;
  const ids = ['in_sintesi', 'come_va', 'rilevamenti', 'dati_tecnici', 'sidebar'];
  let fine = html.length;
  for (const x of ids) { const j = html.indexOf('id="' + x + '"', i + 5); if (j > 0 && j < fine) fine = j; }
  return html.slice(i, fine);
}

const QV = o => (o && o.value != null ? num(o.value) : null);

/** Da una pagina prova a tutto quello che ci sta dentro. */
function mappaProva(html, slug) {
  const ld = ldJson(html);
  const V = ld.Vehicle || {}, A = ld.Article || {};
  const tabelle = [...String(html).matchAll(/<table[\s\S]*?<\/table>/g)].map(t => coppieTabella(t[0]));
  const bloccoRil = sezione(html, 'rilevamenti') || '';

  // Le tre tabelle si riconoscono dal CONTENUTO, non dalla posizione: se un giorno la redazione
  // ne aggiunge una in mezzo, l'ordine cambia ma il contenuto no.
  const eDiMisure = t => t.some(x => /velocit.*massima/i.test(x.etichetta)) && t.some(x => /frenata|accelerazione/i.test(x.etichetta));
  const eDichiarati = t => t.some(x => /^motore$/i.test(x.etichetta)) || t.some(x => /capacit.*serbatoio/i.test(x.etichetta));
  const eDimensioni = t => t.some(x => /^passo$/i.test(x.etichetta)) && t.some(x => /^lunghezza$/i.test(x.etichetta));

  const tMis = tabelle.find(eDiMisure) || [];
  const tDic = tabelle.find(eDichiarati) || [];
  const tDim = tabelle.find(eDimensioni) || [];

  const dichiarati = {};
  for (const { etichetta, valore } of tDic) if (valore) dichiarati[etichetta] = valore;
  const dimensioni = {};
  for (const { etichetta, valore } of tDim) if (valore) dimensioni[etichetta] = num(valore);

  // La metodologia: la frase in coda alla tabella rilevamenti. Senza, il numero e' un numero;
  // con, e' una misura.
  const metodo = (testo(bloccoRil).match(/(Acquisizione dati[^.]*\.(?:[^.]*\.){0,2})/) || [, null])[1];

  const foto = [...new Set([...String(html).matchAll(/(?:https?:)?\/\/immagini\.insella\.it\/[^"'\s)]+\.(?:jpg|jpeg|png|webp)/g)]
    .map(m => 'https:' + m[0].replace(/^https?:/, '')))]
    .filter(u => !/\/(field|redazione)\//.test(u));           // via le foto degli autori
  const grandi = foto.filter(u => /\/styles\/(1240w|2480w)/.test(u));

  return {
    slug,
    url: 'https://' + HOST + '/prova/' + slug,
    // ── anagrafica, dal ld+json Vehicle: sono i campi che le tabelle NON hanno ──
    nome: V.name || A.headline || null,
    marca: (V.brand && V.brand.name) || null,
    modello: V.model || null,
    anno: (String(V.name || slug).match(/\b(19|20)\d{2}\b/) || [null])[0],
    prezzoListino: V.offers && V.offers.price != null ? num(V.offers.price) : null,
    valutazione: V.aggregateRating ? { voto: num(V.aggregateRating.ratingValue), voti: num(V.aggregateRating.ratingCount) } : null,
    classeEmissioni: V.meetsEmissionStandard || null,
    cambio: V.vehicleTransmission || null,
    marce: num(V.numberOfForwardGears),
    carburante: V.fuelType || null,
    serbatoioLd: QV(V.fuelCapacity),
    // Il peso arriva da tre posti diversi con tre significati diversi: si tengono separati.
    pesoTotaleLd: V.weightTotal && V.weightTotal.maxValue != null ? num(V.weightTotal.maxValue) : null,
    cilindrata: QV(V.vehicleEngine && V.vehicleEngine.engineDisplacement),
    potenzaDichiarataCv: V.vehicleEngine && V.vehicleEngine.enginePower
      ? Math.round(num(V.vehicleEngine.enginePower.value) / 100 * 100) / 100 : null,   // il ld porta i CV x100
    // La coppia arriva con un codice unita' UN/CEFACT che non interpreto a naso: si espone il
    // valore grezzo con il suo codice, e sara' l'interfaccia a decidere se mostrarlo.
    coppia: V.torque ? { valore: num(V.torque.value), unita: V.torque.unitCode || null } : null,
    // ── i valori MISURATI: il motivo per cui questa fonte esiste ──
    misure: misureDa(tMis),
    metodoDiMisura: metodo || null,
    // ── la scheda della casa e le dimensioni rilevate dalla redazione ──
    dichiarati,
    dimensioniRilevate: dimensioni,
    // ── giudizio della redazione, voce per voce ──
    voti: votiDa(html),
    // ── testi ──
    titolo: A.headline || null,
    sommario: A.description || null,
    autore: (A.author && A.author.name) || null,
    dataProva: A.datePublished || null,
    inSintesi: testo(sezione(html, 'in_sintesi')).replace(/^In sintesi\s*/, '') || null,
    comeVa: testo(sezione(html, 'come_va')).replace(/^Come va\s*/, '') || null,
    // ── foto ──
    copertina: A.thumbnailUrl || (grandi[0] || null),
    foto: grandi.slice(0, 30),
    fonte: 'inSella — prove e rilevamenti della redazione',
  };
}

/** Dall'indice di categoria: le prove linkate, con titolo. */
function proveDaIndice(html, categoria) {
  const fuori = new Map();
  for (const m of String(html).matchAll(/<a[^>]+href="\/prova\/([a-z0-9-]{8,})"[^>]*>([\s\S]{0,200}?)<\/a>/g)) {
    const slug = m[1];
    if (!/\d{4}/.test(slug)) continue;                       // le categorie non hanno l'anno nello slug
    const t = testo(m[2]);
    if (!fuori.has(slug) || (t && !fuori.get(slug).titolo)) fuori.set(slug, { slug, titolo: t || null, categoria });
  }
  return [...fuori.values()];
}

/** Marche dall'indice /marca: 246 voci, slug pulito. */
function marcheDaIndice(html) {
  const fuori = new Map();
  for (const m of String(html).matchAll(/<a[^>]+href="\/marca\/([a-z0-9-]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g)) {
    const slug = m[1];
    const nome = testo(m[2]);
    if (!nome || nome.length > 40) continue;
    if (!fuori.has(slug)) fuori.set(slug, { acronimo: slug, nome, logo: null });
  }
  return [...fuori.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}

/** Marca di una prova: prefisso piu' LUNGO che combacia, altrimenti "moto-guzzi-v7" finirebbe
 *  sotto "moto" e "royal-enfield-hntr" sotto una marca inesistente. */
function marcaDiSlug(slug, slugMarche) {
  let vinta = null;
  for (const m of slugMarche) {
    if (slug === m || slug.startsWith(m + '-')) { if (!vinta || m.length > vinta.length) vinta = m; }
  }
  return vinta;
}

// ─── Superficie pubblica ─────────────────────────────────────────────────────
// L'indice sta su DISCO, come per auto-data.net e ultimatespecs: scorrere le dieci categorie e la
// loro paginazione sono una quarantina di richieste, e farle a runtime lasciava l'utente davanti a
// "Carico…" per oltre un minuto al primo click. Lo costruisce scripts/build-insella-index.js.
let INDICE = null;
try { INDICE = require('../../data/insella-index.json'); } catch (_) { INDICE = null; }

/** Scorre le categorie e torna tutte le prove. `forza` salta l'indice su disco (lo usa lo script). */
const crawlIndice = () => conCache('indice', async () => {
  const tutte = new Map();
  for (const cat of CATEGORIE) {
    for (let p = 0; p < MAX_PAGINE; p++) {
      let html;
      try { html = await getHtml('/prova/' + cat + (p ? '?page=' + p : '')); }
      catch (e) { if (e.kind === 'blocked') throw e; break; }
      const trovate = proveDaIndice(html, cat);
      if (!trovate.length) break;                            // categoria finita
      let nuove = 0;
      for (const v of trovate) if (!tutte.has(v.slug)) { tutte.set(v.slug, v); nuove++; }
      if (!nuove) break;                                     // pagina senza novita'
    }
  }
  return [...tutte.values()];
}, d => !Array.isArray(d) || !d.length);

const crawlMarche = () => conCache('marche', async () => {
  const [html, prove] = [await getHtml('/marca'), await crawlIndice()];
  const tutte = marcheDaIndice(html);
  const slugs = tutte.map(m => m.acronimo);
  const conta = {};
  for (const p of prove) { const m = marcaDiSlug(p.slug, slugs); if (m) conta[m] = (conta[m] || 0) + 1; }
  return tutte.filter(m => conta[m.acronimo]).map(m => ({ ...m, prove: conta[m.acronimo] }));
}, d => !Array.isArray(d) || !d.length);

/** Tutte le prove. Dall'indice su disco se c'e', altrimenti scorrendo le categorie. */
const indice = (opt = {}) => (!opt.forza && INDICE ? Promise.resolve(INDICE.prove) : crawlIndice());
/** Le marche che hanno almeno una prova, col conteggio. */
const marche = (opt = {}) => (!opt.forza && INDICE ? Promise.resolve(INDICE.marche) : crawlMarche());

/** Le prove di una marca (solo l'elenco: il dettaglio si chiede a parte). */
async function proveDi(marcaSlug) {
  const [prove, mrc] = [await indice(), await marche()];
  const slugs = mrc.map(m => m.acronimo);
  const chi = String(marcaSlug || '').toLowerCase();
  return prove.filter(p => marcaDiSlug(p.slug, slugs) === chi)
    .sort((a, b) => String(b.slug).localeCompare(String(a.slug)));
}

/** Il dettaglio completo di una prova. */
const prova = slug => conCache('prova|' + slug, async () => {
  const s = String(slug || '').replace(/[^a-z0-9-]/gi, '');
  if (!s) throw fail('slug prova mancante', { kind: 'error' });
  const v = mappaProva(await getHtml('/prova/' + s), s);
  // Se la pagina risponde ma non porta ne' misure ne' dichiarati, il markup e' cambiato: meglio
  // dirlo che archiviare per 7 giorni una scheda vuota.
  if (!v.misure.velocitaMax && !Object.keys(v.dichiarati).length) {
    throw fail('prova ' + s + ' senza dati: la pagina della fonte e\' cambiata', { kind: 'parse' });
  }
  return v;
}, d => !d || (!d.misure.velocitaMax && !Object.keys(d.dichiarati).length));

module.exports = {
  marche, proveDi, prova, indice, pausaFinoA,
  _mappaProva: mappaProva, _misureDa: misureDa, _votiDa: votiDa, _coppieTabella: coppieTabella,
  _proveDaIndice: proveDaIndice, _marcheDaIndice: marcheDaIndice, _marcaDiSlug: marcaDiSlug,
  _per100: per100, _num: num, _sezione: sezione, _CATEGORIE: CATEGORIE, _CACHE_FILE: CACHE_FILE,
};
