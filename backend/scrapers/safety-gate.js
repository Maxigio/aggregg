'use strict';
/**
 * Safety Gate — l'archivio europeo dei RICHIAMI di sicurezza.
 *
 * PERCHE' ESISTE. E' l'unica cosa che l'app non aveva affatto: sapere se un modello ha un difetto
 * accertato. Safety Gate (l'ex RAPEX) e' il sistema di allerta rapida della Commissione Europea:
 * quando l'autorita' di vigilanza di uno Stato membro accerta un pericolo, la notifica finisce in
 * un archivio UNICO condiviso da tutti gli Stati. Per chi si ritrova in piazzale import tedeschi e
 * francesi conta: un richiamo su una Golf immatricolata in Germania sta qui come uno su una Panda.
 *
 * IL LIMITE, detto prima di tutto il resto. L'allerta individua i veicoli colpiti tramite il
 * NUMERO DI OMOLOGAZIONE europea (type_numberOfModel) oppure un intervallo di telaio dentro la
 * descrizione. Noi non abbiamo ne' l'uno ne' l'altro: un annuncio non porta l'omologazione e il
 * telaio nemmeno. Quello che resta e' marca + nome del modello + finestra di produzione, cioe' un
 * semaforo a livello di FAMIGLIA. Serve a dire "su questo modello, in questi anni, risulta un
 * richiamo": NON a dire "questa macchina e' richiamata". La differenza va scritta in interfaccia,
 * non lasciata intuire — su una serie da 300.000 esemplari un richiamo puo' riguardarne 4.000.
 *
 * COME SI ACCEDE. Il portale e' un'applicazione JavaScript, ma dietro ha due endpoint XML pubblici
 * che rispondono a una richiesta HTTP semplice: nessuna chiave, nessuna registrazione, nessun
 * CAPTCHA, niente da superare. Il parametro `language` accetta l'italiano, quindi i testi del
 * difetto e delle misure arrivano gia' tradotti.
 *
 * IL COSTO NASCOSTO: sull'endpoint ufficiale NON c'e' una ricerca per categoria o per marca. Per
 * avere l'archivio dei soli veicoli bisogna scaricare i report settimanali e filtrare in casa.
 * E' una tantum (lo fa scripts/build-safety-gate.js); dopo, il mantenimento e' UNA richiesta al
 * venerdi'.
 *
 * NOTA SULLA CATEGORIA: "Veicoli a motore" comprende anche i RICAMBI (nel primo report letto c'era
 * un giunto sferico NK). Non e' rumore: un pezzo richiamato non va montato, quindi serve al banco
 * officina quanto il richiamo sul veicolo.
 */
const https = require('https');
const zlib = require('zlib');
const path = require('path');

const { kindForStatus, fail } = require('./utils');

const HOST = 'ec.europa.eu';
const BASE = '/safety-gate-alerts/api/download/weeklyReport';
const cacheDisco = require('./cache-disco');
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'safety-gate-cache.json');
const TTL_MS = 24 * 60 * 60 * 1000;       // l'elenco cambia una volta a settimana: un giorno basta
const TIMEOUT_MS = 20000;
const PAUSA_MS = 1500;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

// La categoria si chiama diversamente secondo la lingua richiesta: si accettano entrambe, cosi'
// cambiare `language` non fa sparire in silenzio tutti i risultati.
const CATEGORIA = /^(veicoli a motore|motor vehicles)$/i;

let ultima = 0;
let bloccatoFino = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getXml(percorso) {
  if (Date.now() < bloccatoFino) throw fail('in pausa dopo un blocco', { kind: 'blocked' });
  const ora = Date.now();
  const quando = Math.max(ora, ultima + PAUSA_MS);
  ultima = quando;                          // slot prenotato prima di dormire, non dopo
  if (quando > ora) await sleep(quando - ora);

  const { status, body } = await new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path: percorso,
      headers: { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', 'Accept-Encoding': 'gzip', Accept: 'application/xml,text/xml' },
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

const pausaFinoA = () => (Date.now() < bloccatoFino ? bloccatoFino : 0);

// ─── Cache su disco ──────────────────────────────────────────────────────────
// La cache conserva gli oggetti GIA' INTERPRETATI, non l'XML: cambiare il parser senza dirlo
// significa continuare a servire il vecchio formato per un giorno intero senza accorgersene —
// e' successo aggiungendo i telai, che risultavano zero su 1.041 mentre erano nei dati.
// Questo numero va alzato a ogni cambio della forma dei record.
const SCHEMA = 3;   // 3: date di produzione separate anche quando la fonte le incolla
/**
 * LA STESSA CACHE DI TUTTE LE ALTRE (vedi cache-disco.js). Il numero di schema qui c'era gia'
 * — l'aveva insegnato proprio questo file, coi telai che risultavano zero su 1.041 mentre
 * erano nei dati — ma mancavano il TETTO (le chiavi sono `r|<id campagna>`, e le campagne non
 * finiscono mai) e la scrittura accanto ai dati utente, senza la quale nel pacchetto Electron
 * la cache non sopravvive a un riavvio.
 */
const _cache = cacheDisco.crea(CACHE_FILE, { tag: 'safety-gate', schema: SCHEMA, ttl: TTL_MS, max: 800 });
const conCache = (chiave, produci, sospettoSe) => _cache(chiave, produci, sospettoSe);

// ─── Parsing XML ─────────────────────────────────────────────────────────────
// Quasi tutti i valori arrivano dentro CDATA, perche' contengono HTML e caratteri speciali.
const cdata = s => String(s == null ? '' : s)
  .replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

const tag = (xml, nome) => {
  const m = String(xml).match(new RegExp('<' + nome + '>([\\s\\S]*?)</' + nome + '>'));
  return m ? cdata(m[1]) || null : null;
};
const tagTutti = (xml, nome) =>
  [...String(xml).matchAll(new RegExp('<' + nome + '>([\\s\\S]*?)</' + nome + '>', 'g'))].map(m => cdata(m[1])).filter(Boolean);

/** L'elenco dei report settimanali: reference, data e URL di dettaglio. */
function elencoDaXml(xml) {
  return [...String(xml).matchAll(/<weeklyReport>([\s\S]*?)<\/weeklyReport>/g)].map(m => {
    const b = m[1];
    const url = tag(b, 'URL') || '';
    return {
      reference: tag(b, 'reference'),
      data: tag(b, 'publicationDate'),
      anno: Number(tag(b, 'year')) || null,
      settimana: Number(tag(b, 'week')) || null,
      // La lista chiude l'URL con una virgola di troppo: se non si toglie, la richiesta fallisce.
      id: (url.match(/detail\/xml\/(\d+)/) || [, null])[1],
    };
  }).filter(x => x.id);
}

/**
 * Le date, una per una, dal campo di produzione.
 *
 * NIENTE `\b` ai bordi, ed e' il punto di tutta la funzione: la fonte incolla gli intervalli senza
 * separatore, e la seconda data comincia attaccata all'anno della prima —
 * "08.12.2020 - 09.01.20268.12.2020" e' "09.01.2026" seguito da "8.12.2020". Fra `6` e `8` non
 * c'e' nessun confine di parola, quindi `\b` scartava proprio le due date che questa funzione
 * esiste per separare, e le due superstiti finivano appaiate in un periodo inventato di cinque
 * anni. Misurato sull'archivio: 7 allerte su 962 con date di produzione.
 *
 * Al posto del confine si controllano giorno (1-31) e mese (1-12): serve a non leggere come data
 * un numero di lotto tipo "123.45.2020", e basta perche' una data vera deve comunque avere i
 * separatori al posto giusto — infatti i numeri di modello incollati all'anno ("...2025308 V3")
 * non agganciano, non essendo seguiti da un punto.
 */
function dateDa(testo) {
  // Lo spazio dopo il punto e' un refuso della fonte, non una separazione: "01.07. 2010" e' una
  // data sola. Senza tollerarlo si perdeva l'inizio del periodo e restava solo l'anno di fine.
  return [...String(testo || '')
    .matchAll(/(?:0?[1-9]|[12]\d|3[01])\s*[./]\s*(?:0?[1-9]|1[0-2])\s*[./]\s*(?:19|20)\d{2}/g)]
    .map(m => m[0].replace(/\s+/g, ''));
}

/**
 * Gli anni di produzione: sono l'unico aggancio possibile all'anno di un annuncio, il giorno
 * esatto non ci serve e fingere di usarlo darebbe una precisione che non abbiamo.
 *
 * Si prendono dalle DATE — stessa funzione dei periodi, cosi' i due campi non possono raccontare
 * due storie diverse. Il numero scritto da solo si guarda SOLO se di date non ce n'e' nessuna,
 * perche' in questo campo un numero di quattro cifre e' quasi sempre un modello e non un anno:
 * su un richiamo Peugeot "// 2008 V2" e "// 2088.3.2017" (cioe' la 208 seguita da una data)
 * davano da:2008 a:2088, e con quella finestra il filtro per anno non escludeva piu' niente.
 */
function anniDa(produzione) {
  const s = String(produzione || '');
  let a = dateDa(s).map(d => Number(d.slice(-4)));
  if (!a.length) a = [...s.matchAll(/\b((?:19|20)\d{2})\b/g)].map(m => Number(m[1]));
  if (!a.length) return null;
  return { da: Math.min(...a), a: Math.max(...a) };
}

/**
 * Il campo delle date arriva spesso con PIU' intervalli incollati senza separatore — e' la fonte a
 * scriverli cosi': "08.12.2020 - 09.01.20268.12.2020 - 21.08.2025" sono due periodi in cui il
 * giorno del secondo si e' fuso con l'anno del primo. Mostrarlo com'e' fa leggere "09.01.20268".
 * Si estraggono le date una per una e si ricompongono a coppie.
 */
function periodiDa(produzione) {
  const d = dateDa(produzione);
  const fuori = [];
  for (let i = 0; i < d.length; i += 2) fuori.push(d[i + 1] ? d[i] + ' – ' + d[i + 1] : d[i]);
  return fuori;
}

/**
 * Intervalli di NUMERO DI TELAIO, quando la fonte li dichiara. E' l'unica cosa in tutto l'archivio
 * che permette di scendere dal modello al SINGOLO esemplare: misurato, li porta il 12% delle
 * allerte, dentro il campo delle date di produzione o la descrizione, nella forma
 * "// VIN: VXKKAHPY8R6015952 - VXKKBDGH1T6000111".
 * Un telaio e' di 17 caratteri e non usa I, O, Q per non confonderle con 1 e 0.
 */
function telaiDa(testo) {
  const v = [...new Set([...String(testo || '').matchAll(/\b[A-HJ-NPR-Z0-9]{17}\b/g)].map(m => m[0]))];
  const fuori = [];
  for (let i = 0; i < v.length; i += 2) fuori.push(v[i + 1] ? { da: v[i], a: v[i + 1] } : { da: v[i], a: null });
  return fuori;
}

/**
 * Il campo `name` e' testo libero e spesso porta PIU' modelli in una riga sola. Esempi reali:
 * "Beetle, New Beetle, EOS + EOS GP, Fox, Golf A6 + Cabrio + Plus, Passat B6 + B7 + CC".
 * Si spezza su virgole e "+", si ripulisce, e si tengono i pezzi con almeno due caratteri.
 * NON si prova a indovinare quale sia "il" modello: si tengono tutti, e sara' la ricerca a dire
 * quale combacia.
 */
function modelliDa(nome) {
  return [...new Set(String(nome || '')
    .split(/[,;/]|\s\+\s/)
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(s => s.length >= 2 && s.length <= 60))];
}

/**
 * Forma di un numero di omologazione europea: "e1*2018/858*00039*00*10", "e13*168/2013*02205*".
 * La prima parte e' il codice del paese che l'ha rilasciata, poi la direttiva, poi il progressivo.
 */
const OMOLOGAZIONE = /\be\d{1,2}\*\d{2,4}\/\d{1,4}\*/i;

/**
 * `type_numberOfModel` e' un campo LIBERO, e non contiene affatto sempre un'omologazione: misurato
 * sul report della settimana 29 del 2026, su 34 valori ce ne sono di veri ("e1*2018/858*00039*00*10")
 * accanto a nomi commerciali ("K4", "MG S5 EV (2025)") e a codici interni ("QQ0619-black").
 * Si separano i valori multipli e si dice QUALI sono omologazioni vere: cosi' l'interfaccia puo'
 * proporre il confronto con la carta di circolazione solo quando ha senso, invece di suggerire di
 * cercare "K4" sul libretto.
 */
function omologazioniDa(campo) {
  const pezzi = String(campo || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const vere = pezzi.filter(s => OMOLOGAZIONE.test(s));
  return { tutte: pezzi, omologazioni: vere, haOmologazione: vere.length > 0 };
}

/**
 * Anche il campo `brand` e' testo libero, non un elenco chiuso. Misurato sulle 1.041 allerte
 * veicolo del triennio: 18 marche contengono un separatore, e ci sono voci come "Opel/Vauxhall",
 * "MAN/Neoplan, Man", "VW - Volkswagen AG" e una allerta con DIECI marche in fila (i camperisti
 * del gruppo Trigano). Si spezza come i modelli invece di inventare una canonicalizzazione.
 */
const marcheDa = nome => modelliDa(nome);

/** Da una notifica XML a quello che mostriamo. Null se non riguarda i veicoli. */
function mappaNotifica(xml, meta = {}) {
  const categoria = tag(xml, 'category');
  if (!categoria || !CATEGORIA.test(categoria)) return null;
  const nome = tag(xml, 'name');
  const produzione = tag(xml, 'productionDates');
  const om = omologazioniDa(tag(xml, 'type_numberOfModel'));
  return {
    caso: tag(xml, 'caseNumber'),
    categoria,
    prodotto: tag(xml, 'product'),          // "Autovettura", "Motocicletta elettrica", "Parte del veicolo / …"
    marca: tag(xml, 'brand'),
    marche: marcheDa(tag(xml, 'brand')),
    nome,
    modelli: modelliDa(nome),
    // L'identificativo VERO dei veicoli colpiti — quando c'e'. Noi non ce l'abbiamo negli annunci,
    // ma il concessionario ce l'ha sulla carta di circolazione: si espone perche' possa verificare.
    tipoOModello: om.tutte,               // il campo grezzo, spezzato sui valori multipli
    omologazioni: om.omologazioni,        // solo quelli che sono davvero omologazioni europee
    haOmologazione: om.haOmologazione,    // se false, il confronto col libretto non e' proponibile
    lotto: tag(xml, 'batchNumber'),
    barcode: tag(xml, 'barcode'),
    rischio: tag(xml, 'riskType'),
    livello: tag(xml, 'level'),             // "Rischio grave" e simili
    difetto: tag(xml, 'danger'),
    misure: tag(xml, 'measures'),
    descrizione: tag(xml, 'description'),   // qui dentro stanno gli intervalli di telaio
    codiceCampagna: tag(xml, 'companyRecallCode'),   // da citare in officina
    produzione,
    periodi: periodiDa(produzione),          // gli intervalli separati, leggibili
    anni: anniDa(produzione),
    // I telai, quando ci sono: e' l'unico modo di scendere dal modello al singolo esemplare.
    telai: telaiDa(produzione + ' ' + (tag(xml, 'description') || '')),
    paeseNotifica: tag(xml, 'notifyingCountry'),
    paeseOrigine: tag(xml, 'countryOfOrigin'),
    tipoUtente: tag(xml, 'type'),
    urlCampagna: tag(xml, 'URLrecall'),
    scheda: tag(xml, 'reference'),
    foto: tagTutti(xml, 'picture'),
    ...meta,
  };
}

/** Le notifiche di veicolo di un report settimanale. */
function veicoliDaReport(xml, meta = {}) {
  return [...String(xml).matchAll(/<notifications\b[^>]*>([\s\S]*?)<\/notifications>/g)]
    .map(m => mappaNotifica(m[1], meta))
    .filter(Boolean);
}

// ─── Superficie pubblica ─────────────────────────────────────────────────────
/** Tutti i report settimanali pubblicati, dal piu' recente. */
const elenco = () => conCache('elenco', async () =>
  elencoDaXml(await getXml(BASE + '/list/xml/it')), d => !Array.isArray(d) || d.length < 100);

/** Le allerte veicolo di un singolo report. */
const report = id => conCache('r|' + id, async () => {
  const n = String(id).replace(/\D/g, '');
  if (!n) throw fail('id report mancante', { kind: 'error' });
  const xml = await getXml(`${BASE}/detail/xml/${n}?language=it&search=WEB_REPORT%7C:%7C${n}`);
  return veicoliDaReport(xml, { report: n, dataReport: tag(xml, 'report_date') });
});

module.exports = {
  elenco, report, pausaFinoA,
  _elencoDaXml: elencoDaXml, _veicoliDaReport: veicoliDaReport, _mappaNotifica: mappaNotifica,
  _modelliDa: modelliDa, _marcheDa: marcheDa, _anniDa: anniDa, _periodiDa: periodiDa, _dateDa: dateDa, _telaiDa: telaiDa, _cdata: cdata, _omologazioniDa: omologazioniDa, _CACHE_FILE: CACHE_FILE,
};
