'use strict';
/**
 * COMPETITOR — il parco di un concessionario, il tuo e quello degli altri.
 *
 * Un concessionario e' una VETRINA su una fonte, e le fonti la sanno servire per intero:
 *
 *   Autoscout   /concessionari/<slug>  →  customerId nella pagina  →  customer:{id}
 *   Subito      annuncio               →  advertiser.user_id       →  uid=<id>
 *
 * Si incolla il link della vetrina e l'app ricava l'id da sola. Verificato su quattro
 * concessionari veri: Raineri Massimo 9345705, GTI Srls 3484947, Bonera 12806,
 * Rivoltella 13290.
 *
 * DUE TRAPPOLE, tutte e due gia' scattate durante la verifica:
 *
 *   L'id del NEGOZIO non e' l'id dell'UTENTE. Nell'URL di una vetrina Subito c'e'
 *   `shops/7798-...`, ma il filtro vuole `uid=1398723`. Sono due numeri diversi, e
 *   quello sbagliato NON da' errore: da' il catalogo intero di Subito. Per questo l'id
 *   utente si legge da un annuncio di quel negozio, non dall'URL.
 *
 *   Il tetto silenzioso. Chiedendo quattro pagine, Bonera rispondeva "200 veicoli" che
 *   erano il mio limite, non il suo parco. Qui si pagina fino in fondo e, se si tocca il
 *   tetto di sicurezza, la risposta lo DICE (`troncato`) invece di far sembrare completo
 *   un elenco che non lo e'.
 *
 * AGGIORNAMENTO SU RICHIESTA, mai all'apertura: un parco grosso costa una richiesta ogni
 * cinquanta veicoli, e nessuno vuole pagarle solo per aver aperto una scheda.
 */
const https = require('https');
const zlib = require('zlib');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const dbmod = require('./utenti-db');

const scrapeAs24 = require('./scrapers/autoscout-graphql');
const scrapeSubito = require('./scrapers/subito-api');
const vetrinaMoto = require('./scrapers/motoit-vetrina');
const { getDetail } = require('./scrapers/detail');
const fontiSalute = require('./fonti-salute');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;
const MAX_PAGINE = 40;            // 40 × 50 = 2000 veicoli: oltre, si dichiara troncato
/**
 * La pausa fra una pagina e l'altra. Gli scraper ce l'hanno gia' (`opts.pageDelayMs`) ma il
 * loro default e' 0, e qui non la passava nessuno: uno scarico di parco e' la richiesta piu'
 * profonda che facciamo — fino a 40 pagine per passata — e partiva a raffica. E' lo stesso
 * valore che subito-api impone gia' fra le famiglie moto: «mai raffica verso la stessa fonte».
 */
const PAUSA_PAGINE_MS = 400;

/* ─── dove si salva l'elenco ──────────────────────────────────────────────── */
function filePath() {
  const ud = process.env.USER_DATA_PATH;
  const dir = (ud && fs.existsSync(ud)) ? ud : path.join(__dirname, '..', 'data');
  return path.join(dir, 'competitor.json');
}
/**
 * Un file ILLEGGIBILE non e' un file ASSENTE, e dirlo cambia cosa succede dopo: rispondendo
 * `[]` a entrambi, il pannello scriveva "nessun concessionario" su un elenco che c'era, e il
 * gesto istintivo — reincollare un link — riscriveva il file con quella sola voce, rendendo
 * la perdita definitiva. Ora l'elenco resta vuoto (non si inventa niente) ma il guasto si
 * vede nel log, e `leggi.ultimoErrore` lo tiene per chi vuole mostrarlo.
 */
/**
 * IL PARCO E' DI CHI LO TIENE D'OCCHIO.
 *
 * `competitor.json` era UNO per macchina: due persone che seguivano concorrenti diversi si
 * sovrascrivevano l'elenco e i raggruppamenti a vicenda, e nessuno se ne accorgeva finche' non
 * spariva una vetrina. Adesso ogni persona ha la sua riga.
 *
 * Il file di prima entra una volta sola, a nome del proprietario — quelle vetrine le ha messe
 * lui — e resta dov'e' come archivio.
 */
function chi(utente) {
  const u = String(utente == null ? '' : utente).trim();
  if (!u) throw new Error('competitor: manca l\'utente — ogni parco ha un padrone.');
  return u;
}

let migrazioneFatta = false;
function migraDalFile(d) {
  if (migrazioneFatta) return;
  migrazioneFatta = true;
  if (Number(d.prepare('SELECT COUNT(*) AS n FROM parco').get().n) > 0) return;
  const p = filePath();
  if (!fs.existsSync(p)) return;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const voci = Array.isArray(j.voci) ? j.voci : [];
    if (!voci.length) return;
    d.prepare('INSERT OR REPLACE INTO parco (utente, dati, aggiornato_il) VALUES (?,?,?)')
      .run('owner', JSON.stringify(voci), Date.now());
    console.log(`[competitor] ${voci.length} vetrine importate a nome del proprietario (${p} resta dov'e').`);
  } catch (e) {
    console.error(`[competitor] l'archivio ${p} non si legge (${e.message}): le vetrine di prima non sono state importate.`);
  }
}

/**
 * Un magazzino ILLEGGIBILE non e' un elenco ASSENTE, e dirlo cambia cosa succede dopo:
 * rispondendo `[]` a entrambi, il pannello scriveva "nessun concessionario" su un elenco che
 * c'era, e il gesto istintivo — reincollare un link — lo riscriveva con quella sola voce,
 * rendendo la perdita definitiva. Ora l'elenco resta vuoto (non si inventa niente) ma il
 * guasto si vede, e `leggi.ultimoErrore` lo tiene per chi vuole mostrarlo.
 */
function leggi(utente) {
  const u = chi(utente);
  const d = dbmod.apri();
  if (!d) {
    leggi.ultimoErrore = dbmod.guasto() || dbmod.stato();
    console.error(`[competitor] magazzino non disponibile (${leggi.ultimoErrore}) — NON si sovrascrive da solo.`);
    return [];
  }
  migraDalFile(d);
  const r = d.prepare('SELECT dati FROM parco WHERE utente=?').get(u);
  leggi.ultimoErrore = null;
  if (!r) return [];
  try {
    const a = JSON.parse(r.dati);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    leggi.ultimoErrore = e.message;
    console.error(`[competitor] l'elenco di ${u} non si rilegge (${e.message}).`);
    return [];
  }
}

/** Chi scrive su un magazzino che non si apre si ferma: non riscrive cio' che non ha letto. */
function scrivi(utente, voci) {
  const u = chi(utente);
  const d = dbmod.apri();
  if (!d) {
    const e = new Error(`elenco dei concorrenti non disponibile (${dbmod.guasto() || dbmod.stato()})`);
    e.code = 'ELENCO_ILLEGGIBILE';
    throw e;
  }
  migraDalFile(d);
  d.prepare('INSERT INTO parco (utente, dati, aggiornato_il) VALUES (?,?,?)'
    + ' ON CONFLICT(utente) DO UPDATE SET dati=excluded.dati, aggiornato_il=excluded.aggiornato_il')
    .run(u, JSON.stringify(voci), Date.now());
  return voci;
}

/* ─── dal link della vetrina all'id ───────────────────────────────────────── */
function getTesto(url, redirect = 0) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch (_) { return reject(new Error('link non valido')); }
    // Anti-SSRF: si parla solo con le due fonti, e vale anche dopo un redirect.
    if (!/(^|\.)(autoscout24\.it|subito\.it)$/i.test(u.hostname)) return reject(new Error('host non consentito'));
    const req = https.get(u.href, { headers: { 'user-agent': UA, 'accept-language': 'it-IT,it;q=0.9', 'accept-encoding': 'gzip, deflate' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirect < 4) {
        res.resume();
        return resolve(getTesto(new URL(res.headers.location, u).href, redirect + 1));
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error('la pagina risponde ' + res.statusCode)); }
      const ch = []; let s = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') s = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') s = res.pipe(zlib.createInflate());
      s.on('data', c => ch.push(c));
      s.on('end', () => resolve(Buffer.concat(ch).toString('utf8')));
      s.on('error', reject);
      // `pipe()` non propaga gli errori: se la connessione cade dopo gli header l'errore esce su
      // `res`, non sul gunzip, e la Promise restava appesa. Un gestore anche qui.
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('risposta interrotta')));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('la fonte non risponde')));
  });
}

const pulisci = s => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * CHI E' il concessionario, dalla stessa pagina che stiamo gia' leggendo per l'id.
 *
 * Autoscout pubblica la scheda in un blocco JSON-LD (`AutoDealer`): nome, indirizzo
 * completo, telefoni, email, valutazione con quante recensioni, orari giorno per giorno,
 * i servizi che dichiara (officina, gommista, finanziamenti…) e il logo. Prima di questo
 * ne leggevamo tre campi a colpi di espressione regolare, e il resto stava li' inutilizzato.
 *
 * Best-effort per costruzione: se un giorno quel blocco cambia forma, si torna a nome e
 * indirizzo — non si rompe l'aggiunta di una vetrina per un orario mancante.
 */
/**
 * Gli orari arrivano una riga per fascia: Subito scrive "Mo 08:30-12:00" e "Mo 14:00-19:00"
 * su due righe, e stampandole com'e' un negozio con la pausa pranzo occupa undici righe.
 * Si uniscono per giorno, tenendo l'ordine in cui la fonte li ha dati.
 */
const GIORNI_ORD = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
function orariUniti(arr) {
  const per = new Map();
  for (const riga of arr) {
    // "Mo 09:00-13:00" ma anche "Mo-Fr 09:00-19:00": la forma con l'intervallo e' quella
    // canonica dello standard, e prendendo solo la prima veniva buttata via — con un misto
    // "Mo-Fr" + "Sa" restava il solo sabato, e la scheda diceva che il concorrente apre un
    // giorno alla settimana. L'intervallo si apre nei giorni che contiene.
    const m = String(riga).match(/^\s*([A-Za-z]{2})(?:\s*[-–]\s*([A-Za-z]{2}))?\s+(.+?)\s*$/);
    if (!m) continue;
    const da = GIORNI_ORD.indexOf(m[1]), a = m[2] ? GIORNI_ORD.indexOf(m[2]) : da;
    if (da < 0) continue;
    const giorni = (a < 0 || a < da) ? [m[1]] : GIORNI_ORD.slice(da, a + 1);
    for (const g of giorni) per.set(g, (per.has(g) ? per.get(g) + ', ' : '') + m[3]);
  }
  // In ordine di settimana: aprendo gli intervalli, l'ordine di arrivo non e' piu' quello.
  return [...per.entries()]
    .sort((x, y) => GIORNI_ORD.indexOf(x[0]) - GIORNI_ORD.indexOf(y[0]))
    .map(([g, o]) => `${g} ${o}`);
}

function schedaLd(html, tipoAtteso = /Dealer/i) {
  const blocchi = String(html).match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocchi) {
    let j; try { j = JSON.parse(b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '')); } catch (_) { continue; }
    const tipi = [].concat(j['@type'] || []);
    if (!tipi.some(t => tipoAtteso.test(t))) continue;
    const tel = [].concat(j.telephone || [], ...[].concat(j.contactPoint || []).map(c => c.telephone || []))
      .map(pulisci).filter(Boolean);
    const rating = j.aggregateRating || {};
    return {
      cap: (j.address && j.address.postalCode) || null,
      // I telefoni sono due (fisso e cellulare) e non sono lo stesso numero scritto due volte.
      telefoni: [...new Set(tel)].slice(0, 3),
      email: ([].concat(j.contactPoint || []).map(c => c.email).filter(Boolean)[0]) || null,
      logo: typeof j.logo === 'string' ? j.logo : null,
      foto: typeof j.image === 'string' ? j.image : null,
      valutazione: rating.ratingValue ? { media: Number(rating.ratingValue), n: Number(rating.ratingCount || rating.reviewCount || 0) } : null,
      orari: Array.isArray(j.openingHours) ? orariUniti(j.openingHours.map(pulisci).filter(Boolean)) : [],
      // Lo slogan e' quello che il concessionario ha scelto di dire di se' in una riga.
      slogan: pulisci(j.slogan || '') || null,
      // `url` qui e' il sito del negozio, non la pagina della vetrina (quella la sappiamo).
      // LO SCHEMA SI CONTROLLA: questa stringa finisce in un `href`, ed `escapeHtml` sostituisce
      // `& < > "` — caratteri che il parser ri-decodifica dentro l'attributo — quindi non
      // neutralizza `javascript:`. Le righe annuncio lo verificano gia' (app.js:2205); qui no,
      // e sarebbe stato l'unico punto in cui una stringa scritta da un terzo diventa un link
      // cliccabile nell'origine dell'app. Solo http/https, il resto vale null.
      sito: (typeof j.url === 'string' && /^https?:\/\//i.test(j.url.trim())
             && !/autoscout24\.it|subito\.it/i.test(j.url)) ? j.url.trim() : null,
      indirizzo: typeof j.address === 'string' ? pulisci(j.address) : null,
      // Cosa fa oltre a vendere: officina, gommista, perizie. E' il pezzo che dice se e' un
      // concorrente sullo stesso mestiere o un rivenditore e basta.
      servizi: [].concat((j.hasOfferCatalog && j.hasOfferCatalog.itemListElement) || [])
        .map(o => o && o.itemOffered && o.itemOffered.name).filter(Boolean).slice(0, 12),
      descrizione: pulisci(j.description || '') || null,
    };
  }
  return {};
}

/**
 * Da un URL di vetrina a { fonte, id, nome, dove }.
 * I parametri di tracciamento (gclid, srsltid, utm_*) si ignorano: conta lo slug.
 */
async function risolviVetrina(urlRaw) {
  const url = String(urlRaw || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('serve il link della vetrina, che comincia con https://');

  // Moto.it: la vetrina non e' su moto.it ma su dealer.moto.it, e l'id e' il suo slug
  // (non un numero). Ha una porta HTTP sua, che parla solo con quell'host.
  const slugMoto = vetrinaMoto.slugVetrina(url);
  if (slugMoto) return await vetrinaMoto.scheda(slugMoto);

  if (/autoscout24\.it\/concessionari\//i.test(url)) {
    const html = await getTesto(url);
    const id = (html.match(/"customerId"\s*:\s*"?(\d{3,})"?/) || [])[1];
    if (!id) throw new Error('in questa pagina Autoscout non c\'e\' l\'id del concessionario');
    // Il nome sta in tre posti e non tutti reggono: il <title> ha attributi (il mio primo
    // `<title>` senza `[^>]*` non agganciava niente e il nome usciva vuoto), l'<h1> e'
    // pulito, e il titolo serve solo come rete. Si prende il primo che risponde.
    const h1 = pulisci((html.match(/<h1[^>]*>([\s\S]{2,90}?)<\/h1>/i) || [])[1] || '');
    const tit = pulisci((html.match(/<title[^>]*>([\s\S]{3,140}?)<\/title>/i) || [])[1] || '');
    const daTitolo = tit.replace(/^Veicoli di\s*/i, '').split('|')[0].replace(/\s+in\s+[^|]*$/i, '').trim();
    const nome = h1 || daTitolo || 'Concessionario';
    const dove = pulisci((html.match(/"addressLocality"\s*:\s*"([^"]{2,60})"/) || [])[1]
      || (tit.match(/\bin\s+([^|]+?)\s*\|/i) || [])[1] || '');
    const via = pulisci((html.match(/"streetAddress"\s*:\s*"([^"]{3,80})"/) || [])[1] || '');
    return { fonte: 'autoscout', id, nome, dove: dove || null, via: via || null, url, ...schedaLd(html) };
  }

  if (/subito\.it\/shops\//i.test(url) || /subito\.it\/.*\/shops\//i.test(url)) {
    // L'URL porta l'id NEGOZIO; il filtro vuole l'id UTENTE. Si prende da un suo annuncio.
    const shop = (url.match(/\/shops\/(\d+)/) || [])[1];
    if (!shop) throw new Error('non riesco a leggere l\'id del negozio da questo link');
    const html = await getTesto(url);
    /**
     * L'id UTENTE c'e', ma non si chiama `user_id`. Sta nel data layer che la pagina
     * riempie per le statistiche, dentro ogni annuncio:
     *
     *     advertiser: { type: '1', subscription: 'pro', id: '955583', shop_id: '24697' }
     *
     * Cercando `user_id` non lo si trovava e la vetrina rispondeva "apri un suo annuncio":
     * l'id era nella pagina da sempre, in un'altra forma.
     */
    const uid = (html.match(/advertiser\s*:\s*\{[^}]*?\bid\s*:\s*'(\d{3,})'/) || [])[1]
             || (html.match(/"user_id"\s*:\s*"?(\d{3,})"?/) || [])[1]
             || (html.match(/[?&]uid=(\d{3,})/) || [])[1];
    if (!uid) throw new Error('la vetrina non espone l\'id utente: apri un suo annuncio e incolla quello');
    const ld = schedaLd(html, /LocalBusiness|Dealer/i);
    const $ = cheerio.load(html);
    const nome = pulisci($('.shop_main_info_wrapper_name h1').first().text())
      || pulisci((html.match(/<title>([^<|]{3,90})/i) || [])[1] || '')
      || ('Negozio ' + shop);
    // Roba che sta nella pagina e che Autoscout non ha: chi risponde al telefono e con che
    // ruolo, e quanti annunci il negozio dichiara di avere.
    const referente = pulisci($('.referent .ref_name').first().text()) || null;
    return {
      fonte: 'subito', id: uid, shopId: shop, url,
      nome,
      dove: pulisci((String(ld.indirizzo || '').match(/,\s*\d{5}\s+([^,]+)/) || [])[1] || '') || null,
      via: ld.indirizzo || null,
      ...ld,
      // Il telefono sta nel riquadro "Mostra Numeri", che e' gia' nell'HTML: non e' un dato
      // protetto, e' solo nascosto alla vista.
      telefoni: [...new Set($('#dialog_shop_phones .phone_row .cell span').map((_, e) => pulisci($(e).text())).get().filter(Boolean))].slice(0, 3),
      referente: referente ? { nome: referente, ruolo: pulisci($('.referent .ref_jobdesc').first().text()) || null } : null,
      // Nel JSON-LD di Subito `image` E' il logo: la copertina sta solo nell'HTML.
      logo: ld.logo || $('#shop_logo img').attr('src') || ld.foto || null,
      foto: $('#shop_cover img').attr('src') || null,
      descrizione: pulisci($('.shop_description').first().text()) || ld.descrizione || null,
      annunciDichiarati: (() => { const n = parseInt(pulisci($('#result_numb').first().text()).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; })(),
    };
  }

  throw new Error('per ora riconosco le vetrine di Autoscout (/concessionari/...), di Subito (/shops/...) e di Moto.it (dealer.moto.it/...)');
}

/* ─── il parco ────────────────────────────────────────────────────────────── */
/**
 * Tutti i veicoli di una vetrina, auto e moto insieme.
 * @returns {Promise<{veicoli:Array, troncato:boolean}>}
 */
async function parco(voce, dip = {}) {
  // Gli scraper si possono iniettare: senza, la regola "una passata caduta non e' il tetto"
  // si potrebbe verificare solo uscendo in rete verso la fonte vera.
  const as24 = dip.scrapeAs24 || scrapeAs24;
  const subito = dip.scrapeSubito || scrapeSubito;
  // Anche il freno si inietta, e per lo stesso motivo degli scraper: senza, una prova che
  // simula un 403 metterebbe in pausa una fonte VERA nell'archivio di chi sviluppa.
  const salute = dip.salute || fontiSalute;
  /**
   * LA FONTE CHE CI STA BLOCCANDO NON SI INTERROGA, nemmeno da qui. Le fonti bannano la
   * MACCHINA, non l'utente: questa strada restava fuori da `fonti-salute` in tutte e due i
   * versi — una pausa decisa dalle ricerche non la fermava, e un 403 preso qui non contava
   * un colpo, quindi la pausa non si allungava mai. Stessa chiave delle ricerche (`voce.fonte`
   * vale 'subito' | 'autoscout' | 'moto'), cosi' i due lati vedono lo stesso stato.
   */
  if (salute.fermo(voce.fonte).fermo) throw new Error(`${voce.fonte}: ${salute.MOTIVO_PAUSA}`);
  const veicoli = [];
  let troncato = false;        // il TETTO nostro (40 pagine): il parco e' piu' grande
  const passateKo = [];        // passate cadute: non si sa quanto manca, e non e' un tetto
  let totaleFonte = null;      // quanti ne dichiara la FONTE, contro quanti ne abbiamo presi
  // Il totale dichiarato descrive TUTTE le passate che hanno portato veicoli? Se una
  // passata fallisce, o riesce con veicoli ma senza dichiarare il suo totale, la somma
  // diventa parziale: un "presi 300 di 200" o un "di 200" che copre meta' parco. In quel
  // caso si tace (null), come per Moto.it che il totale non lo dichiara mai.
  let totaleCopreTutto = true;

  // Moto.it non passa dagli scraper di ricerca: quel motore non filtra per venditore, e il
  // parco si legge dalla vetrina. Solo moto, e solo l'usato — il nuovo la fonte lo tiene
  // in una sezione a parte, e mescolarlo qui falserebbe ogni mediana.
  if (voce.fonte === 'moto') {
    const r = await vetrinaMoto.parco(voce.id, { ctx: { venditoreNome: voce.nome, provincia: voce.provincia || null } });
    /**
     * QUANTO HA VENDUTO IN DIECI ANNI, non solo cosa ha in piazzale adesso. Moto.it e' la
     * sola fonte che pubblica lo storico di un venditore — "Annunci pubblicati 1.018,
     * online 164, utente dal 2015" — ma lo scrive sulla pagina di un ANNUNCIO, non sulla
     * vetrina. Costa una richiesta, e si spende una volta per parco, sul primo annuncio.
     */
    let storico = null;
    if (r.items.length) {
      try {
        const d = await getDetail(r.items[0].url);
        if (d && (d.venditoreAnnunciPubblicati || d.venditoreAnnunciOnline || d.venditoreDal)) {
          storico = { pubblicati: d.venditoreAnnunciPubblicati || null, online: d.venditoreAnnunciOnline || null, dal: d.venditoreDal || null };
        }
      } catch (_) { /* lo storico e' un di piu': se non arriva, il parco resta */ }
    }
    // Moto.it la vetrina non dichiara un totale: si conta finche' le pagine finiscono.
    return { veicoli: r.items.map(v => ({ ...v, tipo: 'moto' })), troncato: r.troncato, passateKo: [], illeggibili: r.illeggibili || 0, totaleFonte: null, storico };
  }

  for (const tipo of ['auto', 'moto']) {
    const params = voce.fonte === 'autoscout'
      ? { tipo, as24Customer: voce.id }
      : { tipo, subitoUid: voce.id };
    const scr = voce.fonte === 'autoscout' ? as24 : subito;
    let r;
    // La seconda passata che fallisce non deve buttare via la prima: un venditore di auto ha
    // zero moto, e un 429 su quella passata cancellava tutte le auto gia' scaricate e mostrava
    // "Non riuscito" su un parco che c'era tutto. Se almeno una passata ha portato veicoli,
    // si tiene quello che c'e' e si dichiara il parco incompleto.
    try { r = await scr(params, { maxPages: MAX_PAGINE, pageDelayMs: PAUSA_PAGINE_MS, withMeta: true }); }
    catch (e) {
      // L'esito va al freno PRIMA di qualunque uscita: e' qui che `e` porta ancora `kind` e
      // `status` messi da `fail()`, mentre il rilancio piu' sotto li perde nel messaggio.
      salute.registra(voce.fonte, { errore: e });
      if (!veicoli.length) throw new Error(`${voce.fonte}: ${e.message}`);
      // NON e' `troncato`. Le due cause finivano sotto la stessa bandiera e il pannello
      // raccontava sempre la prima: "elenco troncato al tetto di sicurezza, questo parco e'
      // piu' grande di quello mostrato". Con una passata caduta quella frase e' falsa due
      // volte — nessun tetto e' stato toccato, e non si sa affatto se il parco sia piu'
      // grande: si sa solo che la fonte non ha risposto.
      passateKo.push({ tipo, motivo: e.message });
      totaleCopreTutto = false;   // una passata fallita rende qualunque somma parziale
      console.warn(`[competitor] passata ${tipo} fallita (${e.message}) → parco parziale`);
      continue;
    }
    const items = Array.isArray(r) ? r : (r.items || []);
    // Una passata VUOTA non si registra: qui zero non e' un silenzio sospetto ma il caso
    // quotidiano (il concessionario di sole auto, passata moto), e contarlo fra i vuoti
    // renderebbe la fonte "sospetta" nel pannello per un fatto sul venditore, non su di lei.
    if (items.length) salute.registra(voce.fonte, { errore: null, conteggio: items.length });
    if (!Array.isArray(r) && r.truncated) troncato = true;
    // QUANTI NE HA LA FONTE. Lo dichiara lei nella stessa risposta e finora lo buttavamo:
    // senza, "veicoli presi 180" non si sa se sono tutti o la punta di un piazzale da 400.
    // Si somma sulle due passate (auto + moto), e resta null non solo quando nessuna lo
    // dichiara, ma anche quando una passata fallisce o porta veicoli SENZA dichiarare il
    // suo totale: un totale che non descrive tutto il parco e' peggio di nessun totale.
    // Una passata vuota senza totale invece non invalida niente: zero presi e zero
    // dichiarati coincidono (il caso quotidiano: concessionario solo-auto, passata moto).
    if (!Array.isArray(r) && Number.isFinite(r.total)) totaleFonte = (totaleFonte || 0) + r.total;
    else if (items.length) totaleCopreTutto = false;
    for (const v of items) veicoli.push({ ...v, tipo });
  }
  return { veicoli, troncato, passateKo, illeggibili: 0, totaleFonte: totaleCopreTutto ? totaleFonte : null };
}

/* ─── i numeri ────────────────────────────────────────────────────────────── */
const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const conta = (arr, f) => {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (k == null || k === '') continue; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const marcaDi = v => {
  // LA DICE LA FONTE. Prendendo la prima parola del titolo, "Alfa Romeo Giulia" diventava
  // "Alfa" e "Land Rover Defender" diventava "Land": due marche spezzate a meta' che poi
  // nel conteggio sembravano marche vere. Il titolo resta solo come rete.
  if (v.marca) return pulisci(v.marca);
  const t = pulisci(v.titolo);
  return t ? t.split(/\s+/)[0] : null;
};

/**
 * Sotto questa cifra non c'e' un veicolo: c'e' un cartello. Misurato su una vetrina vera,
 * una Tricity 125 del 2020 esposta a "1 euro" per farla comparire in cima all'ordinamento
 * per prezzo. Con quello dentro, il "prezzo minimo" del parco e' quello del cartello.
 * Non si butta: si toglie dal minimo e si CONTA, perche' anche sapere quanti ne usa e'
 * un'informazione su come lavora quel concessionario.
 */
const PREZZO_CIVETTA = 300;

/** Quanti su quanti, come frazione — chi rende decide se scriverlo in percentuale. */
const quanti = (arr, f) => {
  const su = arr.filter(v => f(v) != null).length;
  return su ? { si: arr.filter(v => f(v) === true).length, su } : null;
};

/**
 * I numeri del parco. LE MEDIANE DESCRIVONO L'USATO: un parco con dentro il nuovo da
 * concessionario ha un prezzo mediano che non e' di nessuno dei due mercati. Il nuovo
 * resta contato a parte, non nascosto.
 */
function aggrega(veicoli) {
  const nuovi = veicoli.filter(v => v.nuovo === true);
  // `nuovo` e' `null` quando la fonte non lo dichiara: nel dubbio sta con l'usato, che e'
  // quello che i parchi contengono quasi sempre — non si inventa un nuovo che nessuno ha detto.
  const usati = veicoli.filter(v => v.nuovo !== true);
  const prezziTutti = usati.map(v => v.prezzo).filter(n => n > 0);
  const civetta = prezziTutti.filter(n => n < PREZZO_CIVETTA).length;
  const prezzi = prezziTutti.filter(n => n >= PREZZO_CIVETTA);
  const anni = usati.map(v => v.anno).filter(n => n > 1950);
  const km = usati.map(v => v.km).filter(n => n > 0);
  const oggi = Date.now();
  /**
   * GIACENZA. Solo Autoscout: li' `posted_at` e' la prima pubblicazione (misurato su un
   * parco vero: da 11 a 41 giorni, mediana 36). Su Subito la stessa data si azzera a ogni
   * rilancio — 27 auto tutte "pubblicate oggi" — quindi da li' non si calcola, e non si
   * mette insieme alle altre facendo finta di niente.
   */
  const gg = usati.filter(v => v.fonte === 'autoscout' && v.posted_at)
    .map(v => Math.round((oggi - new Date(v.posted_at)) / 86400000))
    .filter(n => Number.isFinite(n) && n >= 0);
  /**
   * I FERMI E I NUOVI ARRIVI, dallo stesso campo della giacenza ma senza mediane.
   * Un mezzo in vendita da oltre sei mesi e' quello su cui, prima o poi, taglia il prezzo;
   * quanti ne ha pubblicati nell'ultimo mese dice se sta comprando o se e' fermo. Sono
   * conteggi, non medie: descrivono i casi, non un veicolo medio che non esiste.
   */
  const fermi = gg.length ? { oltre180: gg.filter(n => n > 180).length, max: Math.max(...gg), su: gg.length } : null;
  const arrivi = gg.length ? { g30: gg.filter(n => n <= 30).length, g90: gg.filter(n => n <= 90).length, su: gg.length } : null;
  return {
    veicoli: veicoli.length,
    usato: usati.length,
    nuovo: nuovi.length,
    auto: veicoli.filter(v => v.tipo === 'auto').length,
    moto: veicoli.filter(v => v.tipo === 'moto').length,
    prezzo: prezzi.length ? { min: Math.min(...prezzi), mediana: mediana(prezzi), max: Math.max(...prezzi), civetta } : null,
    anno: anni.length ? { mediana: mediana(anni), min: Math.min(...anni), max: Math.max(...anni) } : null,
    km: km.length ? { mediana: mediana(km) } : null,
    giacenza: gg.length ? { mediana: mediana(gg), max: Math.max(...gg), su: gg.length, suTotale: usati.length } : null,
    fermi, nuoviArrivi: arrivi,
    marche: conta(usati, marcaDi).slice(0, 12).map(([k, n]) => ({ nome: k, n })),
    alimentazione: conta(usati, v => v.carburante).slice(0, 8).map(([k, n]) => ({ nome: k, n })),
    // COME LAVORA, non solo cosa tiene in piazzale: la carrozzeria dice se fa SUV o
    // utilitarie, la garanzia e l'IVA esposta dicono a chi vende — l'IVA esposta e' il
    // prezzo vero per chi la detrae, ed e' una scelta commerciale, non un dato tecnico.
    carrozzeria: conta(usati, v => v.carrozzeria).slice(0, 8).map(([k, n]) => ({ nome: k, n })),
    cambio: conta(usati, v => v.cambio).slice(0, 4).map(([k, n]) => ({ nome: k, n })),
    garanzia: (() => { const su = usati.filter(v => v.garanziaMesi != null).length; return su ? { si: usati.filter(v => v.garanziaMesi > 0).length, su } : null; })(),
    ivaEsposta: quanti(usati, v => v.ivaEsposta),
    venditori: conta(veicoli, v => v.venditoreNome).map(([k, n]) => ({ nome: k, n })),
  };
}

module.exports = { leggi, scrivi, risolviVetrina, parco, aggrega, _filePath: filePath };
