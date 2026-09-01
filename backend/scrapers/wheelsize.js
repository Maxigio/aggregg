'use strict';
/**
 * Wheel-Size — cerchi, gomme e pressioni omologate per modello e anno.
 *
 * COSA SI OTTIENE DAVVERO, detto prima di tutto il resto perche' e' meno di quanto il sito
 * promette. Misurato sulla pagina della Fiat Panda 2020:
 *  - SI: offset ET nominale e intervallo, backspace, peso pneumatico, PRESSIONE anteriore e
 *    posteriore in bar e psi, indice di carico, codice velocita', flag primo equipaggiamento,
 *    flag invernale, tipo di fissaggio, potenza, cilindrata, alimentazione, allestimenti, anni;
 *  - NO: distanza fori (PCD), diametro di centraggio, filettatura e COPPIA DI SERRAGGIO. Non sono
 *    nell'HTML: sono riempiti dal JavaScript chiamando endpoint che il loro robots.txt vieta.
 *    Qui non li si prende, e l'interfaccia lo deve dire invece di mostrare campi vuoti;
 *  - PARZIALE: la misura di pneumatico e cerchio e' in chiaro solo sul PRIMO allestimento di ogni
 *    generazione — 8 righe su 56 sulla Panda, il 14%. Sulle altre resta uno spinner.
 *
 * Anche cosi' resta l'unica fonte aperta che da' le PRESSIONI di gonfiaggio per allestimento, che
 * al banco gomme e' la domanda di tutti i giorni.
 *
 * TRAPPOLA DEL DOM: metrico e imperiale convivono nella stessa cella e vengono nascosti solo via
 * CSS. Leggendo il testo del `td` si ottengono i due valori appiccicati ("2.2 bar32 psi"): va
 * preso `span.metric`.
 */
const https = require('https');
const zlib = require('zlib');
const path = require('path');
const { fail, kindForStatus } = require('./utils');
const cacheDisco = require('./cache-disco');

const HOST = 'www.wheel-size.com';
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'wheelsize-cache.json');
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 25000;
const PAUSA_MS = 2000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

async function getHtml(percorso) {
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
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
  return body;
}

// ─── Cache su disco ──────────────────────────────────────────────────────────
// SCHEMA: da alzare a ogni cambio della FORMA dei record, o la cache serve il vecchio formato
// per tutto il TTL senza dirlo. Il resto (tetto, dato vecchio se la fonte cade, vita breve per
// un risultato sospetto) sta in cache-disco.js, uguale per tutti gli scraper.
// schema 2: la `nota` sulla copertura e' stata tolta (ora vale null), e senza alzare il
// numero le 17 voci gia' in cache continuavano a portarla — a schermo compariva una frase
// che il codice non scrive piu', e che dichiarava indisponibili dati che nel frattempo
// arrivano. E' esattamente il difetto per cui questo numero esiste.
const conCache = cacheDisco.crea(CACHE_FILE, { tag: 'wheelsize', schema: 2, ttl: TTL_MS, max: 800 });

// ─── Parsing ─────────────────────────────────────────────────────────────────
const testo = s => String(s == null ? '' : s)
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Il valore metrico di una cella. Metrico e imperiale convivono nel DOM: leggendo il td si
 * otterrebbe "2.2 bar32 psi". Si prende span.metric quando c'e', altrimenti tutto il td.
 */
function metrico(td) {
  const m = String(td).match(/<span[^>]*class="[^"]*\bmetric\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  return testo(m ? m[1] : td) || null;
}

const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Le righe della tabella calzate di una pagina anno. */
function calzateDa(html) {
  const fuori = [];
  for (const r of String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const celle = {};
    for (const td of r[1].matchAll(/<td[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g)) {
      const classi = td[1];
      const k = (classi.match(/data-(tire|rim|offset-range|backspacing|weight|pressure)/) || [, null])[1];
      if (k) celle[k] = metrico(td[2]);
    }
    if (!Object.keys(celle).length) continue;
    // Le celle riempite via JavaScript restano vuote o con lo spinner: si registra il buco invece
    // di far credere che la misura non esista.
    const vuota = v => !v || /loading|^\s*$/i.test(v);
    const grezzo = vuota(celle.tire) ? null : celle.tire;
    // Dentro la cella della misura finisce anche il testo del popover che spiega indice di carico
    // e codice di velocita' ("88 560 kg 1235 lbs T 190 km/h 118 mph"). Si estraggono i pezzi che
    // servono invece di mostrare quella riga com'e'.
    const mis = grezzo && grezzo.match(/(\d{3})\/(\d{2})\s?([ZR]?R)\s?(\d{2})/);
    const carico = grezzo && grezzo.match(/\b(\d{2,3})\s+(\d{3,4})\s*kg\b/);
    const velocita = grezzo && grezzo.match(/\b([A-Z])\s+(\d{2,3})\s*km\/h/);
    // La pressione arriva come "2.2 2.0": anteriore e posteriore in bar.
    const pres = (vuota(celle.pressure) ? '' : celle.pressure).match(/([\d.,]+)\s+([\d.,]+)/);
    const n = v => (v == null ? null : Number(String(v).replace(',', '.')) || null);
    fuori.push({
      misura: mis ? `${mis[1]}/${mis[2]}${mis[3]}${mis[4]}` : null,
      indiceCarico: carico ? Number(carico[1]) : null,
      caricoKg: carico ? Number(carico[2]) : null,
      simboloVelocita: velocita ? velocita[1] : null,
      velocitaMaxKmh: velocita ? Number(velocita[2]) : null,
      primoEquipaggiamento: /\bOE\b/.test(grezzo || ''),
      cerchio: vuota(celle.rim) ? null : celle.rim,
      offset: vuota(celle['offset-range']) ? null : celle['offset-range'],
      backspace: vuota(celle.backspacing) ? null : celle.backspacing,
      pesoKg: n(vuota(celle.weight) ? null : celle.weight),
      pressioneAntBar: pres ? n(pres[1]) : null,
      pressionePostBar: pres ? n(pres[2]) : null,
    });
  }
  return fuori;
}

/** Le schede di generazione: etichetta → valore, dal pannello in cima. */
function generazioniDa(html) {
  const fuori = [];
  for (const p of String(html).matchAll(/<div[^>]*class="[^"]*\bpanel\b[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*\bpanel\b|$)/g)) {
    const blocco = p[1];
    const dati = {};
    for (const li of blocco.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      const t = testo(li[1]);
      const m = t.match(/^([A-Za-zÀ-ù /()]+?)\s*:?\s{1,3}(.+)$/);
      if (m && m[2] && m[2].length < 120) dati[m[1].trim()] = m[2].trim();
    }
    if (Object.keys(dati).length) fuori.push(dati);
  }
  return fuori;
}

/**
 * Le calzate di un modello per un anno.
 * NOTA: `pneumatico` e `cerchio` sono null sulla maggior parte delle righe — li riempie il
 * JavaScript da endpoint che il robots.txt della fonte vieta, e non li chiamiamo. Offset,
 * backspace, peso e pressione invece ci sono su tutte.
 */
const calzate = (marca, modello, anno) => {
  // Chiave e URL si costruiscono dagli STESSI pezzi gia' ripuliti: con l'anno grezzo, "2020" e
  // "2020 " (o "MY2020") erano tre voci di cache per una richiesta sola.
  const ma = slug(marca), mo = slug(modello), an = String(anno).replace(/\D/g, '');
  return conCache(['c', ma, mo, an].join('|'), async () => {
    const p = `/size/${ma}/${mo}/${an}/`;
    const html = await getHtml(p);
    const righe = calzateDa(html);
    const conMisura = righe.filter(r => r.misura).length;
    const gen = generazioniDa(html);
    return {
      marca, modello, anno: Number(anno) || null,
      url: 'https://' + HOST + p,
      generazioni: gen,
      calzate: righe,
      totale: righe.length,
      conMisura,
      // PAGINA 200 CON I PANNELLI E ZERO RIGHE = il markup e' cambiato, non il veicolo che
      // non ha calzate. Un modello che Wheel-Size non ha risponde 404 (e getHtml lancia):
      // qui il vuoto e' quasi sempre il parser, e senza questo campo usciva identico a
      // «nessuna calzata a catalogo». Le classi lette sono `data-(tire|rim|...)`.
      sospetto: (!righe.length && gen.length)
        ? 'la pagina ha le generazioni ma nessuna riga leggibile: le colonne di Wheel-Size possono essere cambiate'
        : null,
      // La nota che spiegava la copertura ("in chiaro su N righe su M... distanza fori,
      // centraggio e coppia di serraggio non disponibili") e' stata tolta: raccontava i
      // limiti della fonte a chi voleva solo le misure. `conMisura` e `totale` restano nel
      // dato per chi li vuole leggere.
      nota: null,
    };
  }, d => !d || !d.totale);
};

module.exports = {
  calzate, pausaFinoA,
  _calzateDa: calzateDa, _generazioniDa: generazioniDa, _metrico: metrico, _slug: slug, _CACHE_FILE: CACHE_FILE,
};
