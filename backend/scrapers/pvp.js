'use strict';
/**
 * IL PORTALE DELLE VENDITE PUBBLICHE (pvp.giustizia.it) — la fonte dell'area Aste.
 *
 * Perche' UNA fonte sola basta: l'art. 490 c.p.c. impone che ogni avviso di vendita esecutiva
 * stia sul PVP, e l'art. 631-bis punisce l'omissione con l'ESTINZIONE del processo esecutivo.
 * L'art. 216 CCII dice lo stesso per le liquidazioni giudiziali. Nessuno se lo dimentica, quindi
 * il PVP e' esaustivo per il giudiziario e gli aggregatori privati (astegiudiziarie, gobid,
 * fallco...) ne sono ripubblicazioni. Restano fuori solo cose che non sono giudiziarie:
 * riscossione amministrativa, aste di enti pubblici, salvage assicurativo.
 *
 * ─── COSA HO MISURATO IL 2026-09-01, E CHE FORMA DA' A QUESTO FILE ──────────────────────────
 *
 * 1. NIENTE BROWSER. Il portale e' una app JavaScript, ma i suoi endpoint rispondono a una
 *    chiamata nuda: 200 in ~0,2 s, nessun cookie, nessun token, nessun anti-bot, e nessun
 *    robots.txt (404). Decisivo, perche' sull'M2 di casa Playwright non c'e'.
 *
 * 2. GLI HASH NEI PERCORSI NON SI SCRIVONO A MANO. Gli endpoint veri stanno sotto percorsi tipo
 *    `/ric-496b258c-986a1b71/ric-ms/...`, e quell'hash cambia a ogni rilascio del ministero.
 *    Scriverlo qui dentro significherebbe uno scraper che un giorno smette di funzionare in
 *    silenzio. La mappa completa la pubblica il portale stesso in `fe-config` (campo `msUrl`),
 *    e questo file la legge da li'. Del solo prefisso `bo-` serve un seme, e se anche quello
 *    cambia si ripesca dall'HTML della pagina pubblica (`riscopriBo`).
 *
 * 3. `dataVenditaDa` VIENE IGNORATO DALLA FONTE. Passandolo tornano gli stessi identici lotti,
 *    col piu' vecchio al 2024. Il filtro sulle date lo facciamo NOI, dopo: non e' pigrizia,
 *    e' che la fonte accetta il parametro e non lo applica — il modo peggiore di fallire.
 *
 * 4. IL 90% DELL'ARCHIVIO E' PASSATO. Su 5.758 lotti auto+moto solo 619 hanno una vendita
 *    futura. Chi chiama scarica tutto e tiene quel che gli serve: e' poca roba.
 *
 * 5. I DATI SONO SCRITTI A MANO DAI PROFESSIONISTI E NON VALIDATI. C'e' un lotto con data di
 *    vendita nel 2034 e "anno 2088" nella descrizione. Marca e modello non hanno un campo: si
 *    leggono da `descLotto`, testo libero di mediana 93 caratteri. Qui dentro NON si indovina
 *    niente: si restituisce quello che la fonte dice, e chi interpreta lo fa altrove.
 */
const https = require('https');
const { kindForStatus, fail } = require('./utils');
const budget = require('../budget-richieste');
const annullo = require('../annullo');

const HOST = 'pvp.giustizia.it';
/** Gli allegati non stanno sul portale ma sul suo deposito: host diverso, path dal campo `linkAllegato`. */
const HOST_ALLEGATI = 'resource-pvp.giustizia.it';
const TIMEOUT_MS = 15000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

/**
 * Il seme del prefisso di backoffice: e' l'UNICO pezzo che non si puo' scoprire senza gia'
 * sapere qualcosa, perche' e' l'endpoint che pubblica tutti gli altri. Se il ministero lo
 * cambia, `riscopriBo` lo ripesca dall'HTML della pagina pubblica.
 */
const BO_SEME = 'bo-5897bc47-986a1b71';

/** La macro-categoria e la categoria dei veicoli, nel vocabolario del PVP. */
const TIPO_LOTTO = 'MOBILI';
const CATEGORIA = 'AUTOVEICOLI_E_CICLI';
/**
 * Le due tipologie che ci interessano, decise dal proprietario. Le altre due della stessa
 * categoria sono state guardate e scartate: AUTOMEZZI_COMMERCIALI e VEICOLI contengono
 * autocarri, semirimorchi e trattori (in VEICOLI: 187 lotti vivi, di cui 6 moto).
 * Nota che le categorie del PVP seguono il libretto, non il buonsenso: la' dentro c'e' un
 * «Autocarro Fiat Punto». Qualche autovettura vera sta fuori da AUTOVETTURE, ed e' un limite
 * della fonte che non possiamo raddrizzare senza indovinare.
 */
const TIPOLOGIE = {
  auto: 'AUTOVETTURE',
  moto: 'MOTOVEICOLO_O_CICLOMOTORE',
};

/** Tetto per giro: oltre, e' successo qualcosa (o la fonte e' cambiata) e ci si ferma. */
const MAX_PAGINE = 40;
const PAGINA = 200;

// ─── La porta HTTP ───────────────────────────────────────────────────────────────────────────

function richiesta(percorso, { metodo = 'GET', corpo = null, host = HOST } = {}) {
  budget.conta('pvp');
  const dati = corpo == null ? null : JSON.stringify(corpo);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path: percorso, method: metodo,
      headers: {
        'user-agent': UA,
        accept: 'application/json',
        'accept-language': 'it-IT,it;q=0.9',
        ...(dati ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(dati) } : {}),
      },
      signal: annullo.segnale(),
    }, res => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
      // Se la presa cade DOPO gli header l'errore esce su `res`, non su `req`, e il timeout non
      // salva perche' vive sul socket ormai distrutto: senza questi due la Promise resta appesa
      // per sempre. Stessa guardia di subito-api.js:54.
      res.on('error', e => reject(fail(e.message, { kind: 'transient' })));
      res.on('aborted', () => reject(fail('risposta interrotta', { kind: 'transient' })));
    });
    req.on('error', e => reject(fail(e.message, { kind: 'transient' })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
    if (dati) req.write(dati);
    req.end();
  });
}

async function json(percorso, opzioni) {
  const r = await richiesta(percorso, opzioni);
  if (r.status !== 200) throw fail(`PVP ${percorso}: HTTP ${r.status}`, { status: r.status, kind: kindForStatus(r.status) });
  try { return JSON.parse(r.body); }
  // Un HTML al posto del JSON e' il modo in cui questo portale dice "endpoint spostato":
  // vale la pena distinguerlo da una fonte che risponde male.
  catch (_) { throw fail(`PVP ${percorso}: risposta non-JSON (endpoint cambiato?)`, { status: r.status, kind: 'error' }); }
}

// ─── Gli endpoint, scoperti a runtime ────────────────────────────────────────────────────────

/** Vive in memoria: cambia solo quando il ministero rilascia, e un riavvio lo ricompra a 1 chiamata. */
let cache = { al: 0, valore: null };
const TTL_ENDPOINT = 6 * 60 * 60 * 1000;
let bo = BO_SEME;

/**
 * Ripesca il prefisso di backoffice dall'HTML della pagina pubblica. Serve solo se il seme e'
 * scaduto: e' l'unico caso in cui questo file guarda dell'HTML invece che del JSON.
 */
async function riscopriBo() {
  const r = await richiesta('/pvp/it/lista_annunci.page');
  // Una pagina che non risponde 200 (manutenzione, 5xx di bordo, blocco) non ha cambiato forma:
  // senza questa riga il corpo di cortesia non contiene il pattern e il guasto vero esce come
  // «prefisso backoffice non trovato», cioe' come un rilascio del ministero che non c'e' stato.
  if (r.status !== 200) throw fail(`PVP lista_annunci: HTTP ${r.status}`, { status: r.status, kind: kindForStatus(r.status) });
  const m = String(r.body).match(/\bbo-[0-9a-f]{8}-[0-9a-f]{8}\b/);
  if (!m) throw fail('PVP: prefisso backoffice non trovato nella pagina', { kind: 'error' });
  return m[0];
}

/**
 * `{ ricerca, vendite, backoffice }` — i percorsi base dei microservizi, come li dichiara il
 * portale. Non memorizzare i valori altrove: e' esattamente l'errore che questa funzione evita.
 */
async function endpoints() {
  if (cache.valore && Date.now() - cache.al < TTL_ENDPOINT) return cache.valore;
  let cfg;
  try {
    cfg = await json(`/${bo}/bo-ms/fe-config/lista-annunci`);
  } catch (e) {
    // Il seme non vale piu': si ripesca e si riprova UNA volta. Se fallisce anche questa,
    // l'errore sale — una fonte che non risponde si dichiara, non si finge.
    let nuovo;
    // Ma la causa vera e' la PRIMA: quando il portale degrada i due percorsi cadono insieme, e
    // tenere solo il fallimento della riscoperta vuol dire scrivere in `giri.motivo` (e nel 502
    // delle rotte) che la pagina ha cambiato forma. Chi legge andrebbe a riscrivere lo scraper.
    try { nuovo = await riscopriBo(); }
    catch (e2) { throw fail(`${e.message} (riscoperta fallita: ${e2.message})`, { status: e.status, kind: e.kind }); }
    bo = nuovo;
    cfg = await json(`/${bo}/bo-ms/fe-config/lista-annunci`);
  }
  const ms = cfg && cfg.msUrl;
  if (!ms || !ms.ricerca || !ms.vendite) throw fail('PVP: fe-config senza msUrl utilizzabile', { kind: 'error' });
  cache = { al: Date.now(), valore: { ricerca: ms.ricerca, vendite: ms.vendite, backoffice: ms.backoffice || `${bo}/bo-ms` } };
  return cache.valore;
}

/**
 * Il gemello di `json` per i percorsi che arrivano dalla cache. Se la fonte risponde che quel
 * percorso non c'e' piu' — un 4xx, o l'HTML che qui sopra e' descritto come il modo in cui questo
 * portale dice «endpoint spostato» — la cache si butta SUBITO. Senza, la riscoperta del punto 2
 * dell'intestazione non parte mai quando serve davvero, cioe' appena dopo un rilascio del
 * ministero: il gate del TTL sta prima di tutto e per sei ore ogni giro ribatte lo stesso percorso
 * morto, con /api/aste/:id e /api/aste/portale a 502 e il controllo orario che ricasca sempre li'.
 * I 5xx e i timeout NO ('transient'): dicono che la fonte sta male, non che si e' spostata.
 * Una riscoperta di troppo (un 404 su un lotto che non c'e') costa UNA chiamata e riscrive gli
 * stessi identici valori: molto meno di sei ore di KO.
 */
async function jsonEp(percorso, opzioni) {
  try {
    return await json(percorso, opzioni);
  } catch (e) {
    if (e && e.kind === 'error') cache = { al: 0, valore: null };
    throw e;
  }
}

// ─── Lista ───────────────────────────────────────────────────────────────────────────────────

/**
 * Una pagina di lotti. `tipo` e' 'auto' o 'moto'; `testo` e' la ricerca libera della fonte, che
 * pesca dentro `descLotto` (provata: "honda" da' 118 lotti). `ordine` e' 'asc' o 'desc' sulla
 * data di vendita: serve a chi legge UNA pagina sola, perche' col punto 4 qui sopra (90%
 * dell'archivio passato) la prima pagina crescente e' fatta di vendite del 2024. Chi pagina
 * tutto puo' lasciare il crescente, tanto le prende comunque tutte.
 * @returns {{lotti: object[], totale: number, ultima: boolean}}
 */
async function pagina(tipo, { page = 0, size = PAGINA, testo = null, ordine = 'asc' } = {}) {
  const tipologia = TIPOLOGIE[tipo];
  if (!tipologia) throw fail(`PVP: tipo sconosciuto "${tipo}"`, { kind: 'error' });
  const ep = await endpoints();
  const corpo = {
    tipoLotto: TIPO_LOTTO,
    categoriaLotto: CATEGORIA,
    categoriaBene: [tipologia],
    flagRicerca: 0,
  };
  if (testo) corpo.ricercaLibera = String(testo);
  // A differenza di `dataVenditaDa` (punto 3) il `sort` la fonte lo ONORA, misurato: stessa
  // query, tre ordinamenti, tre primi id diversi e l'ordine rispettato riga per riga.
  const qs = `language=it&page=${page}&size=${size}&sort=dataOraVendita,${ordine === 'desc' ? 'desc' : 'asc'}`;
  const j = await jsonEp(`/${ep.ricerca}/ricerca/vendite?${qs}`, { metodo: 'POST', corpo });
  const b = (j && j.body) || {};
  // Il punto 3 dell'intestazione applicato a noi stessi: un involucro che non si riconosce NON si
  // degrada in una pagina vuota ma plausibile. Chi pagina la prenderebbe per inventario completo,
  // e il giro marcherebbe sparito tutto il magazzino scrivendo «ok».
  if (!Array.isArray(b.content)) throw fail('PVP ricerca/vendite: risposta senza content (involucro cambiato?)', { kind: 'error' });
  // Tollerante sulla forma come bilstein-oe.js:145 ("1000" e' un totale), ma un totale ILLEGGIBILE
  // resta null: non e' zero, e chi pagina deve saperlo invece di credersi arrivato in fondo.
  const totale = Number(b.totalElements);
  return {
    lotti: b.content,
    totale: Number.isFinite(totale) ? totale : null,
    ultima: b.last === true || !b.content.length,
  };
}

/**
 * Tutti i lotti di un tipo, seguendo la paginazione. `pausaMs` e' il freno verso un sito
 * pubblico del ministero: nessuno ci obbliga, ma una raffica su un servizio dello Stato non si
 * fa. Un giro intero e' una trentina di chiamate, una volta al giorno.
 */
async function tutti(tipo, { testo = null, pausaMs = 400, aPagina = PAGINA } = {}) {
  const out = [];
  let p = 0, totale = null, troncato = false;
  for (;;) {
    const r = await pagina(tipo, { page: p, size: aPagina, testo });
    if (totale === null) totale = r.totale;
    out.push(...r.lotti);
    // Totale null = la fonte non l'ha detto in modo leggibile: allora l'unico segnale di fine che
    // resta e' `ultima` (o il tetto, che almeno si dichiara con `troncato`).
    if (r.ultima || (totale !== null && out.length >= totale)) {
      // UNA PAGINA VUOTA A META' NON E' LA FINE, E' UN'USCITA ANTICIPATA. `pagina()` la traduce in
      // `ultima` perche' e' anche cosi' che finisce una paginazione normale, ma il totale che la
      // fonte ha dichiarato — e che abbiamo gia' in mano — dice se ne mancano. Tacere qui consegna
      // meta' inventario timbrato completo (`troncato` copre SOLO il tetto), e a valle
      // `sostituisci` marca sparito tutto il resto mentre il giro si scrive 'ok': stessa dottrina
      // dell'involucro in `pagina()`, quel che non si e' letto si dichiara invece di degradarlo in
      // un inventario plausibile. Sulla fine vera non scatta, perche' li' `out.length` e' gia'
      // pari a `totale`; e si guarda SOLO la pagina vuota, perche' qualche lotto tolto dal portale
      // durante i ~15 s del giro lascia un ammanco legittimo su una pagina piena.
      if (!r.lotti.length && totale !== null && out.length < totale) {
        throw fail(`PVP ${tipo}: paginazione interrotta, pagina ${p} vuota con ${out.length} lotti su ${totale} dichiarati`, { kind: 'transient' });
      }
      break;
    }
    if (++p >= MAX_PAGINE) { troncato = true; break; }
    if (pausaMs) await new Promise(r2 => setTimeout(r2, pausaMs));
  }
  return { lotti: out, totale, troncato };
}

// ─── Dettaglio ───────────────────────────────────────────────────────────────────────────────

/**
 * Gli status con cui il portale parla di QUESTO lotto e non di se stesso, e sono solo i due
 * MISURATI: un lotto ritirato dopo il nostro giro risponde 403 («Operazione non consentita»), un
 * id che non esiste risponde 400. Gli altri 4xx restano fuori apposta: il 404 e' il modo in cui
 * risponde un PERCORSO MORTO dopo un rilascio del ministero — leggerlo come «lotto sparito»
 * cancellerebbe la riscoperta descritta al punto 2 dell'intestazione — mentre 401 e 429 sono il
 * portale che dice «non entri» e «rallenta», e valgono per tutte le richieste, non per un lotto.
 */
const LOTTO_SPARITO = new Set([400, 403]);

/**
 * Il dettaglio di una vendita. `restricted` e' nel nome dell'endpoint ma la risposta e'
 * pubblica: nessuna autenticazione, verificato.
 *
 * ATTENZIONE ai dati personali: dentro `soggetti[]` ci sono nome, cognome, cellulare, email e
 * CODICE FISCALE del referente della procedura. Sono pubblicati dal ministero, ma non e' roba
 * da ricopiare nel nostro magazzino ne' da mostrare a schermo. Chi normalizza li lascia fuori.
 */
async function dettaglio(idVendita) {
  const ep = await endpoints();
  let j;
  try {
    j = await jsonEp(`/${ep.vendite}/vendite/${encodeURIComponent(idVendita)}/restricted`);
  } catch (e) {
    // `json` lancia su QUALUNQUE status diverso da 200, quindi senza questa riga il lotto che non
    // c'e' piu' esce da /api/aste/:id come «il portale non risponde» — diagnosi sbagliata (il
    // portale sta benissimo) e chi la legge ripreme, ripagando gettone e chiamata al ministero.
    // `null` e' il «non trovato» che il chiamante distingue gia'.
    if (LOTTO_SPARITO.has(e.status)) return null;
    throw e;
  }
  return (j && j.body) || null;
}

/**
 * I tentativi di vendita gia' andati a vuoto per lo stesso lotto. Un lotto andato deserto due
 * volte e' un lotto che scendera' ancora, quindi vale la pena chiederlo — ma sui mobili spesso
 * torna vuoto, e vuoto NON vuol dire "mai tentato": vuol dire che la fonte non lo dice.
 */
async function venditePrecedenti(idLotto) {
  const ep = await endpoints();
  const j = await jsonEp(`/${ep.vendite}/vendite/lotti/${encodeURIComponent(idLotto)}/vendite-precedenti`);
  const b = (j && j.body) || [];
  return Array.isArray(b) ? b : (Array.isArray(b.content) ? b.content : []);
}

// ─── Indirizzi pubblici ──────────────────────────────────────────────────────────────────────

/** La pagina dell'annuncio sul portale, quella da dare all'utente. */
const urlAnnuncio = id => `https://${HOST}/pvp/it/detail_annuncio.page?idAnnuncio=${encodeURIComponent(id)}`;

/**
 * L'indirizzo di scarico di un allegato. `linkAllegato` arriva dalla fonte come percorso GREZZO,
 * con gli spazi dentro il nome del file ("/allegati/2092470/Avv vendita con offerta Vespa.pdf?
 * versionId=..."): va codificato pezzo per pezzo, lasciando stare gli `/` e la query, se no il
 * deposito risponde 404. Verificato: cosi' torna 200 e il PDF vero.
 */
function urlAllegato(linkAllegato) {
  const raw = String(linkAllegato || '');
  if (!raw) return null;
  const taglio = raw.indexOf('?');
  const percorso = taglio === -1 ? raw : raw.slice(0, taglio);
  const query = taglio === -1 ? '' : raw.slice(taglio);
  const sicuro = percorso.split('/').map(encodeURIComponent).join('/');
  return `https://${HOST_ALLEGATI}${sicuro}${query}`;
}

module.exports = {
  pagina, tutti, dettaglio, venditePrecedenti, endpoints,
  urlAnnuncio, urlAllegato,
  TIPOLOGIE, TIPO_LOTTO, CATEGORIA,
  _test: { riscopriBo, richiesta, resetCache: () => { cache = { al: 0, valore: null }; bo = BO_SEME; } },
};
