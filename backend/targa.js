'use strict';
/**
 * VERIFICA PER TARGA — il CAPTCHA lo risolve una persona, noi lo trasportiamo.
 *
 * Il Portale dell'Automobilista espone la classe ambientale e l'ultima revisione di un
 * veicolo, gratis e senza registrazione, dietro un CAPTCHA. Il CAPTCHA NON si aggira:
 * l'immagine del portale finisce nella nostra pagina, la legge l'operatore, e la sua
 * risposta torna al portale dentro la STESSA sessione. E' lo stesso patto che l'app ha
 * gia' con Subito, dove il DataDome lo risolve l'utente in un browser vero.
 *
 * TRE REGOLE, e sono di sostanza:
 *  1. UNA TARGA PER GESTO UMANO. Non c'e' un modo per chiederne cento: ogni richiesta
 *     nasce da una sfida che qualcuno ha risolto guardando l'immagine.
 *  2. NIENTE ARCHIVIO. La targa non si scrive da nessuna parte — non nei log, non su
 *     disco, non in cache. Una targa e' un dato personale: serve a chi sta valutando
 *     quel veicolo, in quel momento, e poi non serve piu'.
 *  3. GLI ID NON SI INCHIODANO. Gli URL Liferay contengono l'id dell'istanza del portlet
 *     (`_118_INSTANCE_hoIzOCy6I6vu`) e cambiano a ogni rilascio del portale. Si rileggono
 *     dalla pagina a ogni sfida, cosi' un aggiornamento loro non ci rompe.
 *
 * QUELLO CHE PUO' FERMARCI, detto prima: davanti al CAPTCHA c'e' Radware Bot Manager
 * (cookie `__uzma`, `__uzmb`, `__uzmc`). Guarda il client, non solo la risposta, e puo'
 * marcare una richiesta che arriva da un server. Se succede si vede: la sfida non parte
 * o la verifica torna un errore, e va detto invece di far finta.
 */
const https = require('https');
const crypto = require('crypto');

const HOST = 'www.ilportaledellautomobilista.it';
const PAGINA = '/web/portale-automobilista/ext/verifica-classe-ambientale-veicolo';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const TIMEOUT = 20000;

// Le sfide aperte: id → { cookie, azione, quando }. In memoria e con una vita corta,
// perche' una sessione del portale non vale niente dopo pochi minuti e tenerla non serve.
const sfide = new Map();
const VITA = 5 * 60 * 1000;
const MAX_SFIDE = 40;

function pulisci() {
  const ora = Date.now();
  for (const [k, v] of sfide) if (ora - v.quando > VITA) sfide.delete(k);
  while (sfide.size > MAX_SFIDE) sfide.delete(sfide.keys().next().value);
}

/** Solo questo host, anche dopo un eventuale redirect. Un portale non deve poter deviare altrove. */
function controllaHost(u) {
  const url = new URL(u);
  if (url.protocol !== 'https:' || url.hostname !== HOST) throw new Error('host non consentito');
  return url;
}

function chiamata(u, { metodo = 'GET', cookie = '', corpo = null, referer = null } = {}) {
  const url = controllaHost(u);
  return new Promise((res, rej) => {
    const headers = {
      'user-agent': UA,
      'accept-language': 'it-IT,it;q=0.9',
      accept: metodo === 'POST' ? 'text/html,application/xhtml+xml' : '*/*',
    };
    if (cookie) headers.cookie = cookie;
    if (referer) headers.referer = referer;
    let dati = null;
    if (corpo) {
      dati = Buffer.from(corpo, 'utf8');
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = dati.length;
    }
    const req = https.request({ host: url.hostname, path: url.pathname + url.search, method: metodo, headers }, r => {
      const pezzi = [];
      r.on('data', c => pezzi.push(c));
      r.on('end', () => res({
        status: r.statusCode,
        headers: r.headers,
        cookie: (r.headers['set-cookie'] || []).map(c => c.split(';')[0]),
        buf: Buffer.concat(pezzi),
      }));
    });
    req.on('error', e => rej(new Error(e.message)));
    req.setTimeout(TIMEOUT, () => req.destroy(new Error('timeout')));
    if (dati) req.write(dati);
    req.end();
  });
}

const unisci = (vecchi, nuovi) => {
  const m = new Map();
  for (const c of [...vecchi, ...nuovi]) { const i = c.indexOf('='); if (i > 0) m.set(c.slice(0, i), c); }
  return [...m.values()].join('; ');
};
const deAmp = s => String(s || '').replace(/&amp;/g, '&');

/**
 * Apre una sfida: prende la pagina, ne ricava gli URL veri e scarica l'immagine.
 * Ritorna l'immagine come data URI, cosi' la pagina non deve chiedere niente al portale
 * per conto suo (e i cookie del portale restano dalla nostra parte, non nel browser).
 */
async function sfida() {
  pulisci();
  const pag = await chiamata(`https://${HOST}${PAGINA}`);
  /**
   * DUE GUASTI DIVERSI, DUE MESSAGGI DIVERSI. Distinguerli conta: il 29 luglio 2026 il
   * Ministero ha mandato in 404 TUTTO il ramo /web/portale-automobilista/, home e
   * favicon comprese, mentre il resto del dominio rispondeva. Con un messaggio generico
   * si va a cercare il difetto nell'app, e non c'e'.
   *  - il portale non serve la pagina  → e' giu' lui, si riprova piu' tardi;
   *  - la pagina c'e' ma senza modulo  → l'hanno cambiata, tocca a noi rimetterci mano.
   */
  if (pag.status !== 200) {
    throw new Error(`il Portale dell'Automobilista non risponde (HTTP ${pag.status}). `
      + 'E\' il loro sito a non funzionare, non l\'app: riprova piu\' tardi.');
  }
  const html = pag.buf.toString('utf8');

  const azione = deAmp((html.match(/<form[^>]*action="([^"]*)"/i) || [])[1] || '');
  const imgUrl = deAmp((html.match(/<img[^>]*src="([^"]*captcha[^"]*)"/i) || [])[1] || '');
  if (!azione || !imgUrl) throw new Error('la pagina del portale e\' cambiata: modulo o immagine non trovati');

  const cookie = unisci([], pag.cookie);
  const img = await chiamata(imgUrl, { cookie, referer: `https://${HOST}${PAGINA}` });
  // Il portale dichiara text/html anche quando manda un PNG: si guardano i BYTE, non
  // l'etichetta. Se non e' un'immagine, e' una pagina di blocco travestita.
  const png = img.buf.length > 8 && img.buf[0] === 0x89 && img.buf.toString('latin1', 1, 4) === 'PNG';
  if (!png) throw new Error('il portale non ha mandato l\'immagine (probabile blocco anti-bot)');

  const id = crypto.randomBytes(12).toString('hex');
  // La pagina VUOTA si tiene: al ritorno serve per capire cosa il portlet ha aggiunto.
  // E' il solo modo di leggere una risposta di cui non conosciamo ancora il markup.
  sfide.set(id, { cookie: unisci(cookie.split('; '), img.cookie), azione, vuoto: html, quando: Date.now() });
  return {
    id,
    immagine: 'data:image/png;base64,' + img.buf.toString('base64'),
    tipi: [{ v: 'A', t: 'Autoveicolo' }, { v: 'M', t: 'Motoveicolo' }, { v: 'C', t: 'Ciclomotore' }],
    scade: VITA / 1000,
  };
}

/**
 * IL PEZZO DI PAGINA CHE CONTA. La risposta del portale sono 97 KB di sito; il portlet
 * della verifica ne occupa 5. Leggere fuori da li' vuol dire pescare menu e piè di pagina.
 */
function contenitore(html) {
  const m = String(html).match(/<div[^>]*class="[^"]*portlet-boundary[^"]*VerificaClasseAmbientale[\s\S]*?(?=<div[^>]*class="[^"]*portlet-boundary)/i);
  return m ? m[0] : String(html);
}

// Le accentate arrivano come entita' (`Propriet&agrave;`): senza scioglierle a schermo
// si legge il codice al posto della lettera. Stesso elenco gia' usato in detail.js.
const ENT = [[/&nbsp;/g, ' '], [/&#0?39;|&apos;/g, "'"], [/&quot;/g, '"'],
  [/&agrave;/g, 'à'], [/&egrave;/g, 'è'], [/&eacute;/g, 'é'], [/&igrave;/g, 'ì'],
  [/&ograve;/g, 'ò'], [/&ugrave;/g, 'ù'], [/&lt;/g, '<'], [/&gt;/g, '>'], [/&amp;/g, '&']];
const testo = h => ENT.reduce((a, [re, ch]) => a.replace(re, ch),
  String(h).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Le righe di testo del portlet, una per elemento: servono a confrontare prima e dopo. */
function righe(html) {
  return contenitore(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .split(/<[^>]+>/).map(x => testo(x)).filter(x => x.length > 2);
}

/**
 * Dal risultato del portale a qualcosa di leggibile.
 *
 * TRE VIE, e servono tutte e tre perche' il portlet non risponde in un modo solo:
 *
 *  1. I MESSAGGI stanno in `<span class="errore-desc">`. NON nelle classi standard di
 *     Liferay: cercando `portlet-msg-error` non si trovava niente, e il "Codice Captcha
 *     non valido" spariva — la verifica sembrava non rispondere quando invece aveva
 *     risposto benissimo. E' il difetto che ha fatto sembrare rotta tutta la funzione.
 *  2. Le COPPIE etichetta/valore da tabelle e liste di definizione.
 *  3. Quello che il portlet ha AGGIUNTO rispetto alla pagina vuota. E' la rete di
 *     sicurezza: la pagina vuota l'abbiamo gia' in mano (si scarica per aprire la sfida),
 *     quindi qualunque forma abbia la risposta, cio' che prima non c'era si vede. Senza,
 *     bisognerebbe indovinare il markup del caso "trovato" senza averlo mai visto.
 */
function leggiRisultato(html, htmlVuoto) {
  const cont = contenitore(html);

  const avvisi = [];
  for (const m of cont.matchAll(/<span[^>]*(?:class="[^"]*errore-desc[^"]*"|id="[^"]*errors")[^>]*>([\s\S]{0,300}?)<\/span>/gi)) {
    const t = testo(m[1]);
    if (t && t.length > 2 && !avvisi.includes(t)) avvisi.push(t.slice(0, 200));
  }

  const coppie = [];
  const aggiungi = (k, v) => {
    k = testo(k).replace(/[:：]\s*$/, ''); v = testo(v);
    if (k && v && k.length < 60 && v.length < 120 && k !== v) coppie.push([k, v]);
  };

  /**
   * LE TABELLE DEL PORTALE NON SONO A DUE COLONNE.
   *
   * La risposta vera e' fatta di una riga di INTESTAZIONI e una di VALORI, su quattro
   * colonne ("Tipo Veicolo · Targa · Compatibilita' Ambientale · Emissione CO2" e sotto
   * "AUTOVEICOLO · … · EURO6 · 110"). Leggendo solo le righe da due celle non si
   * accoppiava niente e i dati finivano nella rete di sicurezza, che li stampa in fila:
   * prima tutte le etichette, poi tutti i valori. Corretti ma illeggibili.
   *
   * Qui una tabella diventa: intestazioni + una o piu' righe di valori. Piu' righe
   * capitano quando il portale elenca piu' revisioni, e allora restano righe distinte
   * invece di appiattirsi in un elenco unico dove non si sa piu' quale valore va con quale.
   */
  const tabelle = [];
  for (const tab of cont.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const grezze = (tab.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(tr => tr.match(/<(?:td|th)[\s\S]*?<\/(?:td|th)>/gi) || []);
    const piene = grezze.filter(r => r.length && r.some(c => testo(c)));
    if (!piene.length) continue;
    const val = r => r.map(c => testo(c).replace(/[:：]\s*$/, ''));
    const n = piene[0].length;
    const allineate = piene.every(r => r.length === n);
    // La prima riga e' di intestazioni? Il segnale certo sono i <th>. Senza, lo si deduce
    // solo da TRE o piu' colonne: a due colonne una tabella e' quasi sempre fatta di
    // coppie etichetta/valore, e leggerla come intestazioni+valori le rovinerebbe.
    const primaTh = piene[0].every(c => /^<th/i.test(c));
    const aIntestazione = piene.length >= 2 && allineate && (primaTh ? n >= 2 : n >= 3);
    if (aIntestazione) {
      const [cap, ...resto] = piene.map(val);
      const dati = resto.filter(r => r.some(x => x && x !== '-'));
      if (dati.length) tabelle.push({ intestazioni: cap, righe: dati });
      continue;
    }
    for (const r of piene) if (r.length === 2) { const v = val(r); aggiungi(v[0], v[1]); }
  }
  for (const d of cont.match(/<dt[\s\S]*?<\/dt>\s*<dd[\s\S]*?<\/dd>/gi) || []) {
    const k = (d.match(/<dt[\s\S]*?<\/dt>/i) || [])[0];
    const v = (d.match(/<dd[\s\S]*?<\/dd>/i) || [])[0];
    if (k && v) aggiungi(k, v);
  }

  // Cio' che la risposta ha in piu' della pagina vuota, tolto quello che sappiamo gia'.
  let nuove = [];
  if (htmlVuoto) {
    const prima = new Set(righe(htmlVuoto));
    // Quello che e' gia' finito in una tabella o in una coppia non si ripete sotto.
    const noti = new Set(avvisi.concat(coppie.flat(),
      tabelle.flatMap(t => t.intestazioni.concat(t.righe.flat()))));
    nuove = righe(html).filter(x => !prima.has(x) && !noti.has(x)).slice(0, 20);
  }

  return { coppie, tabelle, avvisi, nuove };
}

/** Manda targa e caratteri del CAPTCHA nella sessione della sfida. */
async function verifica(id, { tipo, targa, captcha }) {
  pulisci();
  const s = sfide.get(id);
  if (!s) throw new Error('sfida scaduta: ricarica l\'immagine');
  const t = String(targa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (t.length < 5 || t.length > 8) throw new Error('targa non valida');
  const c = String(captcha || '').trim();
  if (!c) throw new Error('scrivi i caratteri dell\'immagine');
  const v = ['A', 'M', 'C'].includes(String(tipo)) ? String(tipo) : 'A';

  const corpo = new URLSearchParams({
    tipoVeicolo: v, targa: t, captcha: c, ricercaUltimaRevisioneEffettuata: 'Ricerca',
  }).toString();

  let r = await chiamata(s.azione, { metodo: 'POST', cookie: s.cookie, corpo, referer: `https://${HOST}${PAGINA}` });
  // La sfida vale una volta sola: il portale rigenera il CAPTCHA a ogni invio, e tenerla
  // aperta darebbe l'illusione di poter ritentare con gli stessi caratteri.
  sfide.delete(id);
  // IL 302 VA SEGUITO. Il portale risponde spesso con un redirect alla pagina-risultato:
  // accettarlo come esito e leggere il corpo del 302 (vuoto, o "Redirecting...") faceva
  // uscire "non c'era niente da leggere" DOPO aver bruciato il CAPTCHA che l'utente aveva
  // appena scritto a mano. Si segue una volta sola, sullo stesso host (`chiamata` lo
  // verifica da se'), e portandosi dietro i cookie di sessione.
  if (r.status === 302 && r.headers && r.headers.location) {
    const dopo = new URL(r.headers.location, s.azione).href;
    const cookieDopo = [s.cookie, ...(r.cookie || [])].filter(Boolean).join('; ');
    try { r = await chiamata(dopo, { cookie: cookieDopo, referer: s.azione }); }
    catch (e) { throw new Error(`il portale rimanda a una pagina che non risponde (${e.message})`); }
  }
  if (r.status !== 200) throw new Error(`il portale risponde ${r.status}`);
  const html = r.buf.toString('utf8');
  const { coppie, tabelle, avvisi, nuove } = leggiRisultato(html, s.vuoto);
  return { coppie, tabelle, avvisi, nuove,
           vuoto: !coppie.length && !tabelle.length && !avvisi.length && !nuove.length };
}

function mount(app, deps = {}) {
  const json = deps.json || ((req, res, next) => next());

  app.get('/api/targa/sfida', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ ok: true, ...(await sfida()) }); }
    catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  app.post('/api/targa/verifica', json, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    try { res.json({ ok: true, ...(await verifica(String(b.id || ''), b)) }); }
    // La targa NON entra nel messaggio d'errore: i messaggi finiscono nei log.
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
}

module.exports = { mount, sfida, verifica, _leggiRisultato: leggiRisultato };
