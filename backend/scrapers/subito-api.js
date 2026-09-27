'use strict';
/**
 * Scraper Subito via API di prima parte (hades.subito.it).
 *
 * Ricerca Auto/Moto su Subito: GET JSON diretto. Un errore viene dichiarato al
 * chiamante; non cambia metodo o filtri passando a una ricerca a parole.
 *
 * Schema verificato:
 *  GET /v1/search/items?c=<cat>&t=s&q=<marca modello>&lim=<n>&start=<off>
 *  c=2 Auto, c=3 Moto e Scooter (macrocategoria Motori).
 *  ad.subject (titolo), ad.urls.default (URL), ad.geo.region.friendly_name +
 *  ad.geo.city.value, ad.features[] (label→values[0].value): Prezzo, Km,
 *  Immatricolazione, Carburante, Cambio, Potenza, …
 *
 *  ATTENZIONE alle etichette DOPPIE. 'Km' non e' una: sono due feature con la stessa label,
 *  `/mileage` (fascia) e `/mileage_scalar` (valore esatto), e la fascia viene prima. Chi
 *  aggiunge un campo qui controlli l'`uri` prima di fidarsi della label, come fa il ramo km.
 */
const https = require('https');

const { kindForStatus, fail } = require('./utils');   // classificazione salute crawler (F1.5)
const budget = require('../budget-richieste');
const salute = require('../fonti-salute');
const annullo = require('../annullo');        // il segnale che chiude le richieste abbandonate
const { livelliAnnuncio, dichiarato } = require('./subito-nodo'); // cosa l'annuncio dichiara di se'
const dedotta = require('./versione-dedotta');        // la versione che il venditore non ha scelto dal menu
const { _perMarca } = require('./versioni-unificate');// il catalogo versioni, gia' in cache per marca
const filtriAuto = require('../filtri-auto');         // filtri avanzati auto → parametri nativi hades
const { risolvi: risolviProvincia } = require('../province-sigla'); // il risolutore unico: la provincia e' una sigla

const HOST = 'hades.subito.it';
// Categorie hades (macro Motori=1). accessoriAuto/Moto scoperti live 2026-07-07 per la sezione Ricambi.
const CAT = { auto: '2', moto: '3', accessoriAuto: '5', accessoriMoto: '36' };
const PAGE_SIZE = 50;
const MAX_PAGES = 1;            // una pagina Hades per ricerca; la successiva si chiede con "Carica altri annunci"
const TIMEOUT_MS = 12000;
// Una pagina reale da 50 annunci (Auto, 2026-09-24) pesava 269.430 byte.
// Triplo concordato: oltre si interrompe la presa, senza interpretare il body troncato come zero annunci.
const MAX_BODY_BYTES = 808290;
const AVVISO_BODY = 'Subito ha inviato una risposta oltre il limite di dimensione. La richiesta è stata interrotta e i suoi annunci non sono stati letti.';
const AVVISO_429 = 'Subito ha limitato temporaneamente le richieste (429). La ricerca potrebbe essere incompleta; riprova più tardi.';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

function httpGetJson(path) {
  budget.conta('subito');
  return new Promise((resolve, reject) => {
    const req = https.get({
      host: HOST, path,
      headers: { 'user-agent': UA, 'referer': 'https://www.subito.it/', 'accept': 'application/json' },
      // Se la ricerca e' stata abbandonata (timeout), Node chiude la presa invece di
      // scaricare una risposta che nessuno leggera'. Vedi backend/annullo.js.
      signal: annullo.segnale(),
    }, res => {
      // Anche un body rifiutato può interrompersi dopo gli header.
      res.on('error', e => reject(fail(e.message, { kind: 'transient' })));
      res.on('aborted', () => reject(fail('risposta interrotta', { kind: 'transient' })));
      // Lo status basta a classificare un rifiuto: un body enorme o troncato non deve
      // trasformare un 403 in errore di lettura. Rigetta PRIMA di chiudere la presa,
      // cosi' gli eventi error/aborted della chiusura non sostituiscono il motivo HTTP.
      // resume() scaricherebbe ancora il body del 429 anche dopo il rifiuto.
      if (res.statusCode !== 200) {
        reject(salute.erroreHttp('subito', res.statusCode, res.headers));
        req.destroy();
        return;
      }
      let d = '', bytes = 0, interrotta = false; res.setEncoding('utf8');
      res.on('data', c => {
        if (interrotta) return;
        bytes += Buffer.byteLength(c, 'utf8');
        if (bytes > MAX_BODY_BYTES) {
          interrotta = true;
          d = '';
          reject(Object.assign(fail(AVVISO_BODY, { kind: 'error' }), { code: 'SUBITO_BODY_TOO_LARGE' }));
          req.destroy();
          return;
        }
        d += c;
      });
      res.on('end', () => { if (!interrotta) resolve({ status: res.statusCode, body: d }); });
      // Se la presa cade DOPO gli header, l'errore esce su `res`, non su `req`: senza questi due
      // la Promise restava appesa per sempre e la ricerca aspettava il timeout esterno ogni volta.
    });
    req.on('error', e => reject(Object.assign(fail(e.message, { kind: 'transient' }), { code: e.code })));
    req.setTimeout(TIMEOUT_MS, () => req.destroy(fail('timeout', { kind: 'transient' })));
  });
}

// La porta HTTP e' sostituibile nei test: nessuna richiesta reale per verificare Hades.
let _http = httpGetJson;

// feature per label → primo value
function feat(ad, label) {
  const f = (ad.features || []).find(x => x.label === label);
  if (!f) return null;
  const v = f.values && f.values[0];
  return (v && (v.value != null ? v.value : v.key)) || null;
}

// L'URI resta utilizzabile anche se la fonte cambia la scritta «Prezzo».
function featurePrezzo(ad) {
  const features = ad.features || [];
  return features.find(f => f && f.uri === '/price') || features.find(f => f && f.label === 'Prezzo') || null;
}

// Sub-valore per label dentro una feature multi-livello (es. feature 'Auto'/'Moto'
// → values con label Marca/Modello/Versione). Solo nativo: null se assente.
function subFeat(ad, parentLabel, subLabel) {
  const f = (ad.features || []).find(x => x.label === parentLabel);
  if (!f || !Array.isArray(f.values)) return null;
  const v = f.values.find(x => x && x.label === subLabel);
  return (v && (v.value != null ? v.value : v.key)) || null;
}

// CV dal valore nativo Potenza ("60 kW / 82 Cv" → 82). null se assente/solo-kW.
const cvFrom = s => { const m = String(s == null ? '' : s).match(/(\d+)\s*Cv/i); return m ? parseInt(m[1], 10) : null; };
// kW dallo stesso valore. Non e' un di piu': l'IPT del passaggio di proprieta' gira sui kW,
// che oggi vengono STIMATI dai CV, e sulla soglia dei 53 kW cambia la categoria di tariffa.
// Subito i kW ce li dice (chiave nativa "51/69" = kW/CV), quindi smettiamo di stimarli.
const kwFrom = s => { const m = String(s == null ? '' : s).match(/(\d+)\s*kW/i); return m ? parseInt(m[1], 10) : null; };

// La chiave grezza di una feature, quando vale piu' del testo: 'Garanzia' ha
// key="12" e value="12 mesi", e il numero e' quello che serve per fare i conti.
function featKey(ad, label) {
  const f = (ad.features || []).find(x => x.label === label);
  const v = f && f.values && f.values[0];
  return v && v.key != null ? String(v.key) : null;
}
// Le feature booleane native rispondono "Sì"/"No" (key "1"/"0"). Assente → null, che
// e' diverso da "No": un annuncio che non dichiara l'IVA non e' un annuncio senza IVA.
function featBool(ad, label) {
  const k = featKey(ad, label);
  return k == null ? null : k === '1';
}

const digits = s => { const m = String(s == null ? '' : s).replace(/\./g, '').match(/\d+/); return m ? parseInt(m[0], 10) : null; };
const yearOf = s => { const y = parseInt(String(s || '').split('/').pop(), 10); return Number.isFinite(y) && y > 1900 ? y : null; };

/** urn ("id:ad:<uuid>:list:651863039") → "subito:651863039". Ripiego sulla coda dell'URL. */
function idSubito(ad) {
  const m = String((ad && ad.urn) || '').match(/:list:(\d+)\b/);
  if (m) return 'subito:' + m[1];
  const u = (ad && ad.urls && (ad.urls.default || ad.urls.mobile)) || '';
  const t = String(u).match(/-(\d+)\.htm(?:$|[?#])/);
  return t ? 'subito:' + t[1] : null;
}

function mapAd(ad) {
  const url = ad.urls && (ad.urls.default || ad.urls.mobile);
  if (!url) return null;
  const concessionario = ad.advertiser?.company === true;
  // KM: il VALORE ESATTO, non la fascia. Nel payload di hades l'etichetta 'Km' compare DUE
  // volte — `/mileage` (la fascia: "95.000 - 99.999") e `/mileage_scalar` (il valore vero:
  // "98000 Km") — e la fascia viene prima. Cercando per label si prendeva sempre quella e se
  // ne teneva l'estremo inferiore: sul fixture del repo un'auto con "Km 98.000 certificati"
  // scritto dal venditore usciva come 95.000, e sopra i 200.000 l'errore arriva a -49.999.
  // Si sceglie per `uri`: la label 'Km' compare su fascia e valore esatto.
  // La fascia resta il RIPIEGO dichiarato: quando lo scalare non c'e', meglio l'estremo
  // inferiore che nessun chilometraggio.
  // La fascia si prende per `uri` e, se l'uri non c'e', per label ESCLUDENDO lo scalare —
  // altrimenti quando la fascia manca si ripescava lo scalare stesso e il guard sul
  // segnaposto 9999999 non serviva a niente.
  const feats = ad.features || [];
  const primoValore = f => { const v = f && f.values && f.values[0]; return v ? (v.value != null ? v.value : v.key) : null; };
  const fScal = feats.find(x => x.uri === '/mileage_scalar');
  const fFascia = feats.find(x => x.uri === '/mileage') || feats.find(x => x.label === 'Km' && x !== fScal);
  const kmEsatto = digits(primoValore(fScal));
  const fascia = primoValore(fFascia);
  const kmFascia = fascia ? digits(String(fascia).split('-')[0]) : null;
  // 9999999 e' il segnaposto di "non dichiarato":
  // stamparlo come chilometraggio sarebbe peggio che non stampare niente.
  const km = (kmEsatto != null && kmEsatto < 9999999) ? kmEsatto : kmFascia;
  // DATA DI PUBBLICAZIONE. Il commento di prima dichiarava `ad.date`, che nel payload vero
  // NON esiste (verificato sul fixture di cattura: ne' `date` ne' `dates.created`), quindi
  // la catena ripiegava sempre su `dates.display` — "2026-06-24 11:17:20", cioe' una data
  // SENZA fuso, che `new Date()` interpreta col fuso della macchina che la legge: la stessa
  // stringa slitta di due ore su un host UTC. Il campo giusto sta nello stesso oggetto ed
  // e' gia' pronto: `display_iso8601` ("2026-06-24T11:17:20.26+0200").
  const posted = (ad.dates && ad.dates.display_iso8601) || null;
  // Condizione nativa 'Condizioni del veicolo': Nuovo/Km 0 → nuovo=true, Usato → false.
  const cond = feat(ad, 'Condizioni del veicolo');
  const nuovo = cond == null ? null : (cond === 'Nuovo' || cond === 'Km 0');
  // Neopatentati: 'Sì'/'No' nativo → bool; assente → null.
  const neo = feat(ad, 'Per neopatentati');
  const fPrezzo = featurePrezzo(ad);
  const prezzoRaw = primoValore(fPrezzo);
  const prezzoSuRichiesta = typeof prezzoRaw === 'string' && /\bsu richiesta\b/i.test(prezzoRaw);
  const prezzo = prezzoSuRichiesta ? null : digits(prezzoRaw);
  // I tre livelli che l'annuncio dichiara di se'. Letti UNA volta: servono sia alla marca
  // sia alla versione, e prima si leggevano due volte in due modi diversi.
  const liv = livelliAnnuncio(ad);
  const out = {
    fonte: 'subito',
    /**
     * L'IDENTITA' DELL'ANNUNCIO, che non e' il suo indirizzo.
     *
     * L'URL di Subito contiene il TITOLO scritto dal venditore e la citta':
     * ".../ford-kuga-2-0-tdci-150-cv-s-s-4wd-powershift-titan-cagliari-651863039.htm".
     * Se il venditore ritocca il titolo — abbassa il prezzo e lo scrive, aggiunge
     * "VENDUTA", corregge un dettaglio — l'URL cambia, e per chi lo usava come identita'
     * quello diventava un ALTRO annuncio: falso "nuovo" negli avvisi, storico del prezzo
     * perso, annuncio salvato che sparisce dai salvati.
     *
     * `urn` e' l'identita' che la fonte stessa dichiara: "id:ad:<uuid>:list:651863039".
     * Si tiene il progressivo finale, che e' anche la coda del vecchio URL — ed e' cio' che
     * permette di convertire i dati gia' su disco senza perderli (vedi backend/saved.js).
     */
    id: idSubito(ad),
    titolo: ad.subject || 'Annuncio senza titolo',
    prezzo,
    prezzoSuRichiesta: prezzoSuRichiesta || null,
    // Solo lo stato di lettura: il testo grezzo non deve raggiungere UI/export/cache.
    prezzoIlleggibile: !!fPrezzo && !prezzoSuRichiesta && prezzo === null,
    km,
    anno: yearOf(feat(ad, 'Immatricolazione') || feat(ad, 'Anno di immatricolazione')),
    carburante: feat(ad, 'Carburante'),
    // LA PROVINCIA E' UNA SIGLA, su tutte e tre le fonti: e' una chiave di raggruppamento,
    // e «Cagliari» contro «CA» faceva due gruppi per la stessa provincia (anche nel CSV e
    // nel PDF). La sigla sta NELLO STESSO oggetto (geo.city.short_name); se un giorno
    // mancasse, il risolutore unico del progetto traduce il nome esteso.
    provincia: (ad.geo && ad.geo.city && (ad.geo.city.short_name || (risolviProvincia(ad.geo.city.value) || {}).sigla)) || null,
    regione: (ad.geo && ad.geo.region && ad.geo.region.friendly_name) || null,   // nativa (slug già giusto)
    cambio: feat(ad, 'Cambio'),
    cilindrata: digits(feat(ad, 'Cilindrata')),
    /**
     * Versione/allestimento NATIVA. `null` quando il venditore non l'ha dichiarata — e
     * questo NON e' il caso in cui il campo manca.
     *
     * Subito non lascia il campo vuoto: ci mette il proprio segnaposto, "Altro
     * allestimento", con id 000000. Leggendolo alla lettera finiva nella scheda come se
     * fosse una versione, e sono 874 annunci su 959 senza versione (misurato su 7.431).
     * Un segnaposto stampato accanto alla potenza e ai chilometri si legge come un dato.
     */
    variante: dichiarato(liv.versione) ? liv.versione.nome : null,
    // Venditore dal boolean nativo advertiser.company (true=conce, false=privato).
    venditore: (ad.advertiser && typeof ad.advertiser.company === 'boolean')
      ? (ad.advertiser.company ? 'concessionario' : 'privato') : null,
    // CHI vende, non solo che tipo e': serve alla sezione Competitor per sapere di chi e'
    // il parco, e per accorgersi se la fonte ci mescola dentro qualcun altro.
    // La marca che l'ANNUNCIO dichiara, non la prima parola del titolo: li' "Alfa Romeo"
    // diventava "Alfa" e "Land Rover" diventava "Land".
    marca: (liv.marca || {}).nome || null,
    // Il MODELLO che l'annuncio dichiara. Lo leggevamo gia' insieme a marca e versione e lo
    // buttavamo: senza, la scheda tecnica di un annuncio doveva pescare il modello dai
    // filtri di ricerca, e in Competitor una ricerca non c'e' mai stata.
    modello: dichiarato(liv.modello) ? liv.modello.nome : null,
    venditoreId: concessionario && ad.advertiser.user_id ? String(ad.advertiser.user_id) : null,
    venditoreNome: concessionario ? (ad.advertiser.shop_name || ad.advertiser.name || null) : null,
    potenzaCv: cvFrom(feat(ad, 'Potenza')),
    potenzaKw: kwFrom(feat(ad, 'Potenza')),
    // Specs ricche NATIVE (già nel payload, zero richieste extra); null se assenti.
    colore: feat(ad, 'Colore'),
    carrozzeria: feat(ad, 'Carrozzeria') || feat(ad, 'Tipologia'),   // auto / moto
    porte: feat(ad, 'Numero di porte'),       // stringa nativa "4/5"
    posti: digits(feat(ad, 'Posti')),
    classeEmissioni: feat(ad, 'Classe emissioni'),
    neopatentati: neo == null ? null : neo === 'Sì',
    /**
     * ROBA CHE ERA GIA' NELLA RISPOSTA E BUTTAVAMO. Nessuna richiesta in piu': stesso
     * payload di prima, mappato fino in fondo. Misurato su 100 annunci auto veri:
     *   Garanzia 38%, Iva esposta 24%, Mese di immatricolazione 100%, spedizione 71%,
     *   Ref. ~50% (solo concessionari), testo 86%, comune 100%.
     */
    // Per un operatore l'IVA esposta e' il prezzo vero: a parita' di cartellino, con l'IVA
    // esposta il costo per chi la detrae e' un altro numero. Assente = non dichiarato.
    ivaEsposta: featBool(ad, 'Iva esposta'),
    garanziaMesi: (() => { const k = featKey(ad, 'Garanzia'); const n = k == null ? NaN : parseInt(k, 10); return Number.isFinite(n) ? n : null; })(),
    // Il MESE di immatricolazione, non solo l'anno: fra gennaio e dicembre dello stesso
    // anno ballano dodici mesi di eta' e di garanzia residua.
    mese: (() => { const k = featKey(ad, 'Mese di immatricolazione'); const n = k == null ? NaN : parseInt(k, 10); return n >= 1 && n <= 12 ? n : null; })(),
    spedizione: featBool(ad, 'Disponibile alla spedizione'),
    // Il codice di magazzino del venditore: e' come lui chiama quel veicolo nel suo
    // gestionale, e permette di riconoscere lo stesso mezzo riesposto.
    refVenditore: concessionario ? feat(ad, 'Ref.') : null,
    descrizione: concessionario && typeof ad.body === 'string' && ad.body.trim() ? ad.body.trim() : null,
    // Il COMUNE, non la provincia — con il codice ISTAT, che e' la chiave con cui si
    // aggancia qualunque dato pubblico territoriale.
    comune: concessionario ? ((ad.geo && ad.geo.town && ad.geo.town.value) || null) : null,
    istat: concessionario ? ((ad.geo && ad.geo.town && ad.geo.town.istat) || null) : null,
    // Immagini NATIVE (già nel payload, zero richieste extra): URL webp dalla CDN
    // costruiti dal cdn_base_url + rule (thumb mobile per la lista, fullscreen per lo slider).
    immagini: (Array.isArray(ad.images) ? ad.images : [])
      .filter(i => i && i.cdn_base_url)
      .slice(0, 10)
      .map(i => ({
        thumb: `${i.cdn_base_url}?rule=gallery-mobile-1x-auto`,
        full:  `${i.cdn_base_url}?rule=fullscreen-1x-auto`,
      })),
    url,
    // Campi per il DB (crawler). nuovo ora nativo da 'Condizioni'; danni non esposto.
    nuovo,
    danni: null,
    posted_at: posted,
  };
  return out;
}

/**
 * LA VERSIONE CHE MANCA, letta dal testo dell'annuncio. Vedi versione-dedotta.js per il
 * come e per i numeri; qui c'e' solo l'aggancio.
 *
 * NESSUNA RICHIESTA IN PIU': il catalogo delle versioni e' gia' su disco e
 * versioni-unificate lo tiene in cache per marca. Si paga un parsing per modello, tenuto
 * qui: i nomi di un modello si parsano una volta e servono tutti i suoi annunci.
 *
 * SOLO AUTO. Sulle moto il buco non e' stato misurato e il vocabolario e' un altro
 * (li' la cilindrata e' un campo nativo, e la versione la risolve gia' risolvi-versione.js
 * contro Moto.it). Meglio niente che una deduzione mai provata.
 */
const memoVersioni = new Map();     // `tipo/marcaId/modelloId` → versioni preparate
const MEMO_MAX = 40;
function versioniPreparate(tipo, marcaId, modelloId, modelloNome) {
  const k = tipo + '/' + marcaId + '/' + modelloId;
  if (memoVersioni.has(k)) { const v = memoVersioni.get(k); memoVersioni.delete(k); memoVersioni.set(k, v); return v; }
  const dati = _perMarca(tipo, marcaId);
  const l = dati && dati[String(modelloId)];
  const out = Array.isArray(l) ? dedotta.preparaVersioni(l.map(v => v.subito && v.subito.nome), modelloNome) : null;
  memoVersioni.set(k, out);
  while (memoVersioni.size > MEMO_MAX) memoVersioni.delete(memoVersioni.keys().next().value);
  return out;
}

/**
 * Marca e modello contro cui dedurre la versione di questo annuncio. `null` quando la
 * versione c'e' gia' (dichiarata dal venditore) o quando non c'e' abbastanza per cercarla.
 */
function chiaveVersione(m, ad, tipo) {
  if (!m || m.variante || tipo !== 'auto') return null;
  const liv = livelliAnnuncio(ad);
  const marcaId = liv.marca && liv.marca.id;
  const mod = liv.modello;
  if (!marcaId || !mod || !mod.id || mod.id === NON_DICHIARATO) return null;
  return { k: marcaId + '/' + mod.id, marcaId, modId: mod.id, modNome: mod.nome || '' };
}

/**
 * LA DEDUZIONE SI FA IN BLOCCO, MARCA PER MARCA — non annuncio per annuncio.
 *
 * Le due cache qui sopra sono tarate sulla ricerca di UN modello: 40 modelli qui, 8 marche
 * in versioni-unificate. La vetrina di un concessionario (`subitoUid`, fino a 2.000 annunci)
 * di marche ne mescola decine, e nell'ordine in cui la fonte le manda — mescolato, perche'
 * un piazzale si carica mano a mano — le due LRU vanno in thrashing: ogni miss e' un
 * readFileSync + JSON.parse SINCRONO del file della marca, e i piu' grossi sono 800 KB.
 * Misurato su 900 auto di 20 marche alternate: 900 letture, 353 MB riletti dal disco, 25 s
 * di event loop fermo con punte di 5 s (la stessa passata con una marca sola: 1 lettura).
 * Il processo e' uno solo e node:sqlite e' sincrono, quindi per tutto quel tempo ogni altra
 * ricerca e ogni pagina servita restano in coda.
 *
 * Ordinati per marca e modello gli stessi annunci costano 20 letture: ogni file si legge una
 * volta, e i tetti restano dove sono — in memoria non ci finiscono piu' marche di prima.
 *
 * Ridurre il lavoro non basta pero' a non bloccare: raggruppato e tutto di fila diventava un
 * blocco UNICO di 2,5 s (misurato al tetto della vetrina, 2.000 annunci di 40 marche), cioe'
 * la stessa punta di prima. L'event loop si restituisce a ogni cambio di marca — e' li' che
 * sta la lettura del file — e la punta scende a un fetta di marca. Si cede PRIMA di caricare
 * la marca nuova, mai in mezzo alla stessa: durante la pausa un'altra ricerca potrebbe
 * sfrattarla dalle 8 della LRU e si tornerebbe a rileggere lo stesso file.
 */
async function deduciInBlocco(attesa) {
  attesa.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  let marcaInCorso = null;
  for (const x of attesa) {
    if (x.marcaId !== marcaInCorso) { marcaInCorso = x.marcaId; await sleep(0); }
    const versioni = versioniPreparate('auto', x.marcaId, x.modId, x.modNome);
    if (!versioni || !versioni.length) continue;
    // Il testo di un privato serve solo qui, per riconoscere la versione: non entra nella riga API.
    const r = dedotta.deduci(versioni, dedotta.datiAnnuncio({ ...x.riga, descrizione: x.descrizione }));
    if (r) x.riga.versioneDedotta = r;
  }
}

// Filtri NATIVI hades (verificati live): regione `r`, prezzo `ps`/`pe`, anno
// `ys`/`ye`, ordinamento `sort`. Mappa friendly_name→key (== `province.json.regione`,
// derivata iterando r=1..20 sull'API). Senza nativo, il filtro veniva applicato
// client-side su 2 pagine NAZIONALI → economici/regione persi (vedi piano F17).
const SUBITO_REGION_KEY = {
  'valle-d-aosta': '1', 'piemonte': '2', 'liguria': '3', 'lombardia': '4',
  'trentino-alto-adige': '5', 'veneto': '6', 'friuli-venezia-giulia': '7',
  'emilia-romagna': '8', 'toscana': '9', 'umbria': '10', 'lazio': '11',
  'marche': '12', 'abruzzo': '13', 'molise': '14', 'campania': '15',
  'puglia': '16', 'basilicata': '17', 'calabria': '18', 'sardegna': '19',
  'sicilia': '20',
};
const SORT_VALIDI = new Set(['priceasc', 'pricedesc', 'datedesc', 'relevance']);

// Km NATIVO hades: param `ms`/`me` (mileage start/end) come CHIAVE CATEGORIA 1..36,
// NON km raw (verificato live: ms/me operano sull'indice categoria, inclusivi).
// Fonte tabella: https://hades.subito.it/v1/values/mileage/max (key→soglia).
// `kmToKey(x)` = prima categoria il cui tetto ≥ x = la categoria che CONTIENE x →
// usata sia per `me` (tetto km max) sia per `ms` (bound inferiore: la categoria di kmMin).
const KM_KEY_TABLE = [
  [4999, 1], [9999, 2], [14999, 3], [19999, 4], [24999, 5], [29999, 6], [34999, 7],
  [39999, 8], [44999, 9], [49999, 10], [54999, 11], [59999, 12], [64999, 13], [69999, 14],
  [74999, 15], [79999, 16], [84999, 17], [89999, 18], [94999, 19], [99999, 20], [109999, 21],
  [119999, 22], [129999, 23], [139999, 24], [149999, 25], [159999, 26], [169999, 27],
  [179999, 28], [189999, 29], [199999, 30], [249999, 31], [299999, 32], [349999, 33],
  [399999, 34], [449999, 35], [499999, 36],
];
function kmToKey(km) {
  for (const [limit, key] of KM_KEY_TABLE) if (limit >= km) return key;
  return 36; // oltre 499.999 km
}
/**
 * Il TETTO VERO che si ottiene chiedendo `kmMax`. `me` e' una categoria, non un numero: la
 * categoria che contiene kmMax arriva fino al suo estremo superiore, quindi chiedendo 200.000
 * tornano annunci fino a 249.999. Prima non si vedeva perche' l'app stampava il fondo-fascia
 * (95.000 al posto di 98.000); ora che i km sono quelli veri, va detto invece che nascosto.
 * Null quando il tetto coincide con quello chiesto: non c'e' niente da avvertire.
 */
function kmTettoFascia(kmMax) {
  const n = Number(kmMax);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const [limit] of KM_KEY_TABLE) if (limit >= n) return limit > n ? limit : null;
  return null;   // oltre 499.999 il tetto non e' dichiarato
}
/**
 * Lo stesso, sul lato basso. `ms` e' anch'esso una CATEGORIA, quindi il minimo vero e' l'INIZIO
 * della fascia che contiene kmMin: chiedendo 22.000 tornano annunci da 20.000 in su, cioe' fino
 * a 4.999 km sotto quello chiesto (49.999 sopra i 200.000). Finora non si notava perche' l'app
 * stampava il fondo-fascia; ora che i km sono quelli veri, quegli annunci si vedono e vanno
 * spiegati. Null quando il numero chiesto cade esattamente sull'inizio di una fascia — con i
 * numeri tondi (20.000, 25.000, 30.000) non c'e' niente da avvertire.
 */
function kmPavimentoFascia(kmMin) {
  const n = Number(kmMin);
  if (!Number.isFinite(n) || n <= 0) return null;
  let inizio = 0;
  for (const [limit] of KM_KEY_TABLE) {
    if (limit >= n) return inizio < n ? inizio : null;
    inizio = limit + 1;
  }
  return null;   // oltre 499.999 non c'e' una fascia superiore da dichiarare
}

/**
 * I nomi dei parametri NON sono gli stessi per auto e moto. Sbagliarli non da' errore:
 * da' zero risultati, che si legge come "questa fonte non ha niente".
 *   auto  cb = marca   cm = famiglia      moto  bb = marca   bm = modello
 */
const PARAM = {
  auto: { marca: 'cb', modello: 'cm', versione: 'cv' },
  moto: { marca: 'bb', modello: 'bm', versione: 'bv' },
};
/** Il segnaposto "Altro modello"/"Altro allestimento": il venditore non l'ha dichiarato. */
const NON_DICHIARATO = '000000';

/**
 * Un ID nativo solo quando la voce AMR identifica una famiglia sola. Le voci ambigue
 * usano q=marca+modello, sia per Auto sia per Moto.
 */
function valoreModello(ids) {
  return ids?.length === 1 ? String(ids[0]) : null;
}

function buildPath(params, start) {
  const c = CAT[params.tipo] || CAT.auto;
  const qs = new URLSearchParams({ c, t: 's', lim: String(PAGE_SIZE), start: String(start) });
  // Ricerca per ID quando il nodo e' risolto; testo libero quando non lo e'. Di regola mai
  // i due insieme: `q` restringerebbe ancora sul titolo, e un venditore che scrive "Sv650"
  // nel titolo verrebbe escluso da una ricerca che per id lo trova.
  //
  // L'ECCEZIONE, e vale solo dove il nodo la porta scritta (backend/scrapers/ponte-buchi.js):
  // i modelli che stanno DENTRO una famiglia Subito invece di esserle pari. Chiedendo la
  // sola famiglia, le Golf sono 11.646 e le GTI nei primi cento erano UNA; con `q=gti`
  // l'insieme scende a 1.631 e la finestra si riempie di candidate. Verificato che i due
  // parametri lavorano insieme, e che il costo resta di una richiesta.
  const nodo = params.subitoNodo?.famigliaIds?.length > 1 ? null : params.subitoNodo;
  const p = PARAM[params.tipo === 'moto' ? 'moto' : 'auto'];
  /**
   * IL PARCO DI UN VENDITORE. `uid` e' l'id UTENTE (advertiser.user_id), non l'id del
   * negozio che sta nell'URL della vetrina: su un negozio provato erano 1398723 e 7798,
   * due numeri diversi, e usare quello sbagliato non da' errore — da' il catalogo intero.
   * Verificato: uid=1398723 → 27 auto + 1 moto, tutte sue.
   *
   * Esce prima di tutto il resto: qui non si cerca un modello, si chiede una vetrina.
   */
  if (params.subitoUid) {
    qs.set('uid', String(params.subitoUid));
    if (params._sort && SORT_VALIDI.has(params._sort)) qs.set('sort', params._sort);
    return `/v1/search/items?${qs.toString()}`;
  }
  if (nodo && nodo.marcaId) {
    qs.set(p.marca, String(nodo.marcaId));
    const v = params.subitoSoloNonDichiarati
      ? NON_DICHIARATO                       // la passata di RECUPERO, vedi scrapeSubitoApi
      : valoreModello(nodo.famigliaIds);
    if (v) qs.set(p.modello, v);
    /**
     * DUE TESTI, UNO SOLO `q`. Sono cose diverse e vanno tenute distinte:
     *   `nodo.testo`             il MODELLO che vive dentro una famiglia ("Golf GTI"
     *                            dentro Golf) — vedi ponte-buchi.js. Ha anche un controllo
     *                            a valle in `riconosci`, senza il quale "Golf GTI"
     *                            tornerebbe a pescare tutte le Golf.
     *   `nodo.testoDedotto`      quello che resta del nome tolta la famiglia ("200" da
     *                            "CLA 200"), dedotto dal catalogo invece che scritto a
     *                            mano. Restringe e basta: non marca e non scarta.
     *   `versioneTesto`          la VERSIONE scritta a mano nel campo. Restringe e basta:
     *                            nessun controllo nostro dopo, la fonte risponde e si mostra.
     * Insieme restringono di piu', ed e' corretto: sono vincoli diversi.
     */
    const q = [nodo.testo, nodo.testoDedotto, params.subitoVersioneTesto].filter(Boolean).join(' ').trim();
    if (q) qs.set('q', q);
    /**
     * LA VERSIONE NON SI CHIEDE PIU' PER ID. `cv`/`bv` accettano un id solo e filtrano
     * benissimo — verificato, 50 annunci su 50 dichiarano esattamente quella versione —
     * ma il campo versione ora e' testo libero: quello che scrivi va in `q` qui sopra,
     * e chi resta lo decide la fonte. Vedi il commento in cima a buildPath.
     * L'id resta nel catalogo e serve altrove (la versione dedotta lo legge); qui non
     * arriva piu' nessuno a passarlo, e un ramo che nessuno percorre e' un ramo che un
     * giorno qualcuno riaccende senza sapere perche' era spento.
     */
  } else {
    // Anche qui la versione viaggia: il ramo senza nodo E' il testo libero, e la versione
    // scritta e' testo come il resto — buttarla faceva rispondere a una domanda piu'
    // larga di quella fatta, senza dirlo (56,9% del menu, misurato in campagna E).
    const q = [params.marca, params.modello, params.subitoVersioneTesto].filter(Boolean).join(' ').trim();
    if (q) qs.set('q', q);
  }
  // Regione nativa (se mappabile; altrimenti resta il post-filtro client difensivo).
  const regKey = params.regione && SUBITO_REGION_KEY[String(params.regione).trim().toLowerCase()];
  if (regKey) qs.set('r', regKey);
  // Prezzo/anno nativi (i post-filtri client restano come doppia rete).
  if (params.prezzoMin != null) qs.set('ps', String(params.prezzoMin));
  if (params.prezzoMax != null) qs.set('pe', String(params.prezzoMax));
  if (params.annoMin   != null) qs.set('ys', String(params.annoMin));
  if (params.annoMax   != null) qs.set('ye', String(params.annoMax));
  // Km nativo (categoria): ms=bound inferiore (categoria di kmMin), me=tetto (categoria di kmMax).
  if (params.kmMin     != null) qs.set('ms', String(kmToKey(params.kmMin)));
  if (params.kmMax     != null) qs.set('me', String(kmToKey(params.kmMax)));
  // Ordinamento: solo se richiesto esplicitamente (on-search='priceasc'); il crawler
  // NON lo passa → ordine naturale invariato (vista profonda/truncated intatta).
  if (params._sort && SORT_VALIDI.has(params._sort)) qs.set('sort', params._sort);

  /**
   * I FILTRI AVANZATI DELLE AUTO, nativi. La traduzione (carrozzeria → `ct`, cambio → `gr`,
   * …) sta in backend/filtri-auto.js, che porta anche i due tranelli di questa fonte: i CV
   * sono CV davvero (`hps`/`hpe`), ma `ss`/`se` sono la CHIAVE del menu posti, non il numero.
   * Piu' codici sullo stesso filtro viaggiano separati da virgola, in OR esatto.
   */
  for (const [k, v] of Object.entries(filtriAuto.perSubito(params.filtriAuto))) qs.set(k, v);

  return `/v1/search/items?${qs.toString()}`;
}

// F50 — totale per-query = `count_all` della risposta hades (oggi ignorato).
// = quanti annunci Subito HA per la query (tetto copertura). null se assente.
function extractTotal(j) {
  const n = j && j.count_all;
  return Number.isFinite(n) ? n : null;
}

async function fetchPage(params, start) {
  try {
    const page = await salute.richiesta('subito', async () => {
      const res = await _http(buildPath(params, start));
      if (res.status === 429) throw salute.erroreHttp('subito', 429, res.headers);
      if (res.status !== 200) throw fail(`Subito hades HTTP ${res.status}`, { status: res.status, kind: kindForStatus(res.status) });
      let j;
      try { j = JSON.parse(res.body); } catch (_) { throw fail('Subito hades: body non-JSON (blocco?)', { status: res.status, kind: 'blocked' }); }
      if (j.errors) throw fail('Subito hades errors: ' + JSON.stringify(j.errors).slice(0, 100), { kind: 'error' });
      return { ads: Array.isArray(j.ads) ? j.ads : [], total: extractTotal(j) };
    });
    // Il riepilogo registra gia' il vuoto; qui conta solo il successo che azzera
    // i 403 precedenti prima che parta un'altra famiglia.
    if (page.ads.length) salute.registra('subito', { conteggio: page.ads.length });
    return page;
  } catch (e) {
    // Un 429 e' gia' registrato da richiesta(); lo stesso oggetto non conta due volte.
    // Anche FONTE_IN_PAUSA e' ignorato: non e' una nuova risposta Hades.
    salute.registra('subito', { errore: e });
    throw e;
  }
}

// Solo metadati della chiamata: nessun body Hades o annuncio entra negli avvisi.
function erroreRichiesta(e, fase, pagina = null) {
  if (e.code === 'FONTE_IN_PAUSA') return null; // rifiuto locale, non risposta del portale
  return { fase, pagina, http: Number.isInteger(e.status) && e.status !== 200 ? e.status : null,
    tipo: ['blocked', 'auth', 'transient', 'error'].includes(e.kind) ? e.kind : 'error',
    codice: e.code === 'SUBITO_BODY_TOO_LARGE' ? e.code : null };
}

/**
 * Annunci Subito via API. Throw su errore: la fonte resta dichiarata non letta.
 * @param opts.maxPages  override profondità (ricerca standard: 1 pagina da 50)
 * @param opts.withMeta  ritorna {items, truncated} invece dell'array (back-compat).
 *                       truncated=true se fermato al cap con ultima pagina PIENA
 *                       (vista parziale → il crawler NON deve rilevare venduti).
 */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * La GENERAZIONE, che Subito non sa filtrare ma ogni annuncio dichiara.
 *
 * Non esiste un parametro per "Passat 5ª serie": il menu di Subito si ferma alla
 * famiglia. Ma il livello e' dentro l'annuncio, misurato su 400 annunci: 400 lo
 * dichiarano, il 100%. Quindi si filtra qui invece di chiederlo alla fonte —
 * precisione piena e zero richieste in piu'.
 *
 * Ritorna null se l'annuncio va scartato, altrimenti come si e' riconosciuto.
 */
function riconosci(ad, nodo, opts = {}) {
  if (!nodo || !nodo.marcaId) return 'testo-libero';
  const liv = livelliAnnuncio(ad);
  if (liv.marca && liv.marca.id !== String(nodo.marcaId)) return null;   // altra marca: mai
  /**
   * La VERSIONE, quando l'utente ne ha scelta una. Non si chiede alla fonte (`cv`
   * butterebbe il 23% di annunci che la versione non la dichiarano): si guarda quella
   * che l'annuncio dichiara di se'.
   *   la stessa versione   → esatto
   *   un'altra versione    → fuori, e' un altro allestimento
   *   nessuna dichiarata   → RESTA, marcato: e' spesso l'annuncio compilato male,
   *                          cioe' dove sta l'affare
   */
  const versione = liv => {
    const dichiarata = liv.versione && liv.versione.id !== NON_DICHIARATO;
    /**
     * IL TESTO DEL PONTE isola il modello dentro la famiglia (Golf GTD dentro Golf), e va
     * alla FONTE dentro `q`. Qui NON si scarta piu' niente.
     *
     * Prima, se la versione dichiarata non diceva il testo, l'annuncio spariva. Due danni
     * misurati sullo stesso caso: cercando "Golf GTD" una GTD Variant che dichiara
     * "Variant" come versione veniva buttata via — era esattamente quella cercata — e chi
     * guardava non poteva accorgersene, perche' un annuncio tolto non lascia traccia.
     * Il progetto la regola ce l'ha gia' scritta per il campo versione due funzioni piu'
     * su ("la fonte risponde, e quello che risponde si mostra") e per Autoscout e Moto.it,
     * dove le righe che non combaciano restano in lista MARCATE. Qui si fa lo stesso:
     * marcare e' informazione, nascondere e' una decisione presa al posto di chi guarda.
     */
    if (nodo.testo) {
      if (!dichiarata) return 'senza-versione';
      return diceIlTesto(nodo.testo, liv.versione.nome) ? 'esatto' : 'altro-modello';
    }
    return dichiarata ? 'esatto' : 'senza-versione';
  };

  const ammessi = opts.generazioni;
  if (!ammessi || !ammessi.size) return versione(liv);
  if (liv.modello && ammessi.has(liv.modello.id)) return versione(liv);
  if (!liv.modello || liv.modello.id === NON_DICHIARATO) {
    // Il venditore non ha dichiarato il modello. E' la passata di recupero: si tiene solo
    // se il TITOLO nomina il modello, e resta marcato — non e' una corrispondenza certa.
    return opts.titoloCombacia && opts.titoloCombacia(ad) ? 'senza-modello' : null;
  }
  return null;                                                          // altro modello dichiarato
}

/**
 * La versione dichiarata dice il testo cercato? Parola intera e nell'ordine scritto —
 * "Cooper S" deve stare attaccato, altrimenti ogni "Cooper" con una S da qualche parte
 * passerebbe. Il confine serve perche' "One" non deve pescare "One-derful" ne' "Stone".
 */
const cacheTesto = new Map();
function diceIlTesto(testo, nome) {
  let re = cacheTesto.get(testo);
  if (!re) {
    const t = String(testo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    re = new RegExp('(^|[^a-z0-9])' + t.replace(/[^a-z0-9]+/g, '[^a-z0-9]+') + '([^a-z0-9]|$)', 'i');
    cacheTesto.set(testo, re);
  }
  return re.test(String(nome || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

/** Il titolo nomina il modello cercato? Parole intere, tutte presenti. */
function faTitolo(testo) {
  const parole = String(testo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter(w => w.length > 1);
  if (!parole.length) return null;
  return ad => {
    const t = String((ad && ad.subject) || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return parole.every(w => new RegExp('(^|[^a-z0-9])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(t));
  };
}

/** Recupero per marca: la stessa lista serve OGNI modello di quella marca → in cache. */
const RECUPERO_TTL = 10 * 60 * 1000;
const recuperoCache = new Map();   // prima pagina della query → { ts, page, timer }
const recuperoInVolo = new Map();  // stessa query → { promessa, segnale della ricerca che l'ha avviata }
let recuperoId = 0;

async function paginaRecupero(params, start = 0) {
  /**
   * LA CHIAVE DEVE CONTENERE TUTTO QUELLO CHE ENTRA NELLA RICHIESTA. Con `tipo|marca` la
   * stessa lista veniva riusata per dieci minuti anche cambiando regione, prezzo, anno,
   * chilometri o testo: cerchi, stringi un filtro, ricerchi, e ti torna la lista di prima.
   * Sui chilometri, che a valle non si ricontrollano per scelta, entravano annunci fuori
   * dal filtro impostato.
   */
  const chiave = [params.tipo, params.subitoNodo.marcaId, start, params.regione, params.prezzoMin, params.prezzoMax,
    // `_sort`, non `sort`: l'ordinamento arriva in `opts.sort` e viene copiato in `_sort`
    // (vedi scrapeSubitoApi), ed e' `_sort` che buildPath spedisce a hades. Leggendo un
    // campo che nessun chiamante imposta, due recuperi che differivano SOLO per
    // ordinamento condividevano la stessa entry per dieci minuti.
    params.annoMin, params.annoMax, params.kmMin, params.kmMax, params._sort,
    params.subitoVersioneTesto, (params.subitoNodo && params.subitoNodo.testo) || '',
    (params.subitoNodo && params.subitoNodo.testoDedotto) || '',
    // I filtri avanzati entrano nella richiesta, quindi entrano nella chiave. Senza,
    // il recupero fatto senza filtri veniva riusato con i filtri: la fonte dichiarava
    // 2 annunci e ne consegnava 13, berline col cambio manuale comprese.
    filtriAuto.chiaveCache(params.filtriAuto)].join('|');
  const hit = recuperoCache.get(chiave);
  if (hit && Date.now() - hit.ts < RECUPERO_TTL) return hit.page;
  if (hit) { clearTimeout(hit.timer); recuperoCache.delete(chiave); }
  const inVolo = recuperoInVolo.get(chiave);
  if (inVolo) {
    try { return await inVolo.promessa; }
    catch (e) {
      // Solo l'annullamento della ricerca che ha aperto la presa consente a una seconda
      // ricerca ancora viva di riprovare. Un 429 resta condiviso anche se runSubito,
      // dopo averlo ricevuto, annulla il suo controller nel catch.
      if (e.code !== 'ABORT_ERR' || !inVolo.segnale?.aborted || annullo.annullata()) throw e;
      if (recuperoInVolo.get(chiave)?.promessa === inVolo.promessa) recuperoInVolo.delete(chiave);
      return paginaRecupero(params, start);
    }
  }
  const segnale = annullo.segnale();
  const promessa = (async () => {
    const page = await fetchPage({ ...params, subitoSoloNonDichiarati: true }, start);
    // Le pagine profonde non restano in memoria: il cursore le chiede solo al clic.
    if (start !== 0) return page;
    const id = ++recuperoId;
    // Il callback conserva solo chiave e id: nessun annuncio grezzo sopravvive nel timer.
    const timer = setTimeout(() => {
      if (recuperoCache.get(chiave)?.id === id) recuperoCache.delete(chiave);
    }, RECUPERO_TTL);
    timer.unref?.();
    recuperoCache.set(chiave, { id, ts: Date.now(), page, timer });
    if (recuperoCache.size > 200) {
      const prima = recuperoCache.keys().next().value;
      clearTimeout(recuperoCache.get(prima).timer);
      recuperoCache.delete(prima);
    }
    return page;
  })();
  recuperoInVolo.set(chiave, { promessa, segnale });
  try { return await promessa; }
  finally {
    if (recuperoInVolo.get(chiave)?.promessa === promessa) recuperoInVolo.delete(chiave);
  }
}

async function scrapeSubitoApi(params, opts = {}) {
  // Anche i chiamanti diretti non devono scegliere la prima famiglia moto o unire
  // famiglie auto: una voce ambigua usa la stessa ricerca testuale delle altre.
  if (params.subitoNodo?.famigliaIds?.length > 1) params = { ...params, subitoNodo: null };
  const regione = params.regione ? String(params.regione).trim().toLowerCase() : null;
  const maxPages = opts.maxPages || MAX_PAGES;
  const pageDelay = opts.pageDelayMs || 0;   // pausa tra le pagine (anti-ban su crawl profondi)
  // Ordinamento esplicito (on-search passa 'priceasc' per le occasioni in cima).
  // Il crawler NON passa opts.sort → ordine naturale, vista profonda invariata.
  const reqParams = opts.sort ? { ...params, _sort: opts.sort } : params;
  const nodo = params.subitoNodo || null;
  // `tipo` qui serve solo alla versione dedotta, e le categorie accessori NON sono veicoli:
  // vanno lasciate fuori esplicitamente, altrimenti il ramo di default le farebbe passare
  // per auto e si cercherebbe un modello dentro un annuncio di pastiglie freno.
  const tipo = params.tipo === 'moto' ? 'moto' : (!params.tipo || params.tipo === 'auto') ? 'auto' : null;
  const gen = new Set((nodo && nodo.generazioni || []).map(g => String(g.id)));
  const titoloCombacia = faTitolo(params.modello);
  const rico = { generazioni: gen, titoloCombacia };
  const out = [];
  const attesa = [];                         // righe in attesa della versione dedotta, vedi deduciInBlocco
  let truncated = false;
  let total = null;                          // count_all dalla prima pagina
  let scartati = 0;
  let prezziIlleggibili = 0; // campo prezzo presente, ma senza cifra interpretabile
  let parziale = null, parzialeRete = false, bloccoParziale = null;
  let hasMore = false, erroreTipo = null, erroreHttp = null, erroreCodice = null;
  let mainNextStart = null, recuperoNextStart = null;
  const erroriSubito = [];
  // "Carica altri": si riparte da dove si era arrivati. Il tetto di hades sta fra
  // start 9.850 e 10.000 (misurato per bisezione), quindi c'e' spazio per ~200 fette.
  const salta = opts.mainStart === null ? null : Number.isInteger(opts.mainStart)
    ? opts.mainStart : Math.max(0, opts.fetta || 0) * maxPages * PAGE_SIZE;
  const recuperoStart = opts.recuperoStart === null ? null : Number.isInteger(opts.recuperoStart)
    ? opts.recuperoStart : (opts.fetta || 0) === 0 ? 0 : null;
  for (let p = 0; salta !== null && p < maxPages; p++) {
    if (p > 0 && pageDelay) await sleep(pageDelay);   // mai raffica di pagine
    let page;
    try { page = await fetchPage(reqParams, salta + p * PAGE_SIZE); }
    catch (e) {
      const dettaglio = erroreRichiesta(e, 'pagina', Math.floor(salta / PAGE_SIZE) + p + 1);
      if (dettaglio) erroriSubito.push(dettaglio);
      if (p === 0) { e.erroriSubito = erroriSubito; throw e; } // nessuna pagina letta: non inventare risultati
      parzialeRete = true;
      erroreTipo = e.kind || 'transient'; erroreHttp = e.status || null;
      bloccoParziale = e.kind === 'blocked' ? e : null;
      parziale = e.status === 429 ? AVVISO_429 : 'Subito non ha restituito tutte le pagine della ricerca.';
      break;
    }
    if (p === 0) total = page.total;         // count_all dalla 1ª pagina (uguale su tutte)
    for (const ad of page.ads) {
      // Doppia rete regione: `buildPath` filtra già nativo via `r=<key>` quando la
      // regione è mappabile; questo post-filtro client copre i casi non mappati.
      if (regione) {
        const r = ad.geo && ad.geo.region && ad.geo.region.friendly_name;
        if (r && r.toLowerCase() !== regione) continue;
      }
      const come = riconosci(ad, nodo, rico);
      if (!come) { scartati++; continue; }
      const m = mapAd(ad, opts);
      if (!m) continue;
      // Senza feature Prezzo sappiamo solo che il dato manca; «su richiesta» richiederebbe
      // una dichiarazione della fonte. Se la feature c'e' ma non e' leggibile, lo segnaliamo.
      if (m.prezzoIlleggibile) prezziIlleggibili++;
      const riga = come === 'testo-libero' ? m : { ...m, dichiarazione: come };
      out.push(riga);
      const kv = chiaveVersione(riga, ad, tipo);
      if (kv) attesa.push({ riga, descrizione: ad.body, ...kv });
    }
    // `count_all` conta la risposta GREZZA della fonte, non le righe che i nostri filtri
    // tengono. Se la pagina arriva esattamente al totale, un'altra chiamata puo' solo
    // creare un falso parziale (o un 429) su una ricerca gia' completa. Un totale assente
    // o inferiore agli annunci effettivamente ricevuti non e' affidabile: resta il
    // comportamento prudente della pagina piena, senza scartare annunci.
    const fine = salta + p * PAGE_SIZE + page.ads.length;
    const totaleCoerente = total != null && total >= fine;
    hasMore = page.ads.length === PAGE_SIZE && (!totaleCoerente || fine < total);
    if (!hasMore) break;
    if (p === maxPages - 1) truncated = true;
  }
  if (salta !== null && hasMore) mainNextStart = salta + maxPages * PAGE_SIZE;

  // RECUPERO. Cercando per id, gli annunci che il venditore ha archiviato come "Altro
  // modello" diventano irraggiungibili: misurati sul 3,7% del totale, e sono spesso
  // quelli compilati male — cioe' dove sta l'affare. Una richiesta in piu', per MARCA
  // e in cache: la stessa lista serve ogni modello di quella marca.
  // Ha un cursore proprio: una pagina vuota DOPO il filtro sul titolo non significa
  // che la fonte abbia esaurito le pagine grezze.
  if (nodo && nodo.marcaId && gen.size && titoloCombacia && !opts.senzaRecupero
      && recuperoStart !== null && bloccoParziale?.status !== 429) {
    try {
      const visti = new Set(out.map(x => x.url));
      const page = await paginaRecupero(reqParams, recuperoStart);
      const fine = recuperoStart + page.ads.length;
      const totaleCoerente = page.total != null && page.total >= fine;
      recuperoNextStart = page.ads.length === PAGE_SIZE && (!totaleCoerente || fine < page.total)
        ? recuperoStart + PAGE_SIZE : null;
      for (const ad of page.ads) {
        if (regione) {
          const r = ad.geo && ad.geo.region && ad.geo.region.friendly_name;
          if (r && r.toLowerCase() !== regione) continue;
        }
        if (riconosci(ad, nodo, rico) !== 'senza-modello') continue;
        const m = mapAd(ad, opts);
        if (!m || visti.has(m.url)) continue;
        if (m.prezzoIlleggibile) prezziIlleggibili++; // vedi sopra
        const riga = { ...m, dichiarazione: 'senza-modello' };
        visti.add(m.url); out.push(riga);
        const kv = chiaveVersione(riga, ad, tipo);
        if (kv) attesa.push({ riga, descrizione: ad.body, ...kv });
      }
    } catch (e) {
      // Il recupero e' un di piu': se cade, la ricerca vale lo stesso.
      const dettaglio = erroreRichiesta(e, 'recupero');
      if (dettaglio) erroriSubito.push(dettaglio);
      console.warn('[subito] recupero non dichiarati KO: ' + e.message);
      parzialeRete = true;
      erroreTipo = e.kind || 'transient'; erroreHttp = e.status || null;
      if (e.code === 'SUBITO_BODY_TOO_LARGE') erroreCodice = e.code;
      if (e.kind === 'blocked') bloccoParziale = e;
      parziale = [parziale, e.status === 429 ? AVVISO_429
        : e.code === 'SUBITO_BODY_TOO_LARGE' ? AVVISO_BODY
          : 'Subito non ha completato la ricerca degli annunci senza modello dichiarato.'].filter(Boolean).join(' · ');
      recuperoNextStart = recuperoStart; // il tentativo non ha consumato questa pagina
    }
  }
  if (attesa.length) await deduciInBlocco(attesa);
  if (nodo && scartati) console.log(`[subito] per id "${params.marca} ${params.modello || ''}": ${out.length} tenuti, ${scartati} scartati (altro modello)`);
  // La sola ASSENZA del campo prezzo non dimostra un parser guasto. Un campo prezzo
  // presente e illeggibile invece e' un problema reale di lettura: lo dichiariamo senza
  // scartare l'annuncio. Se almeno un prezzo e' leggibile, la fonte nel complesso funziona.
  const sospetto = prezziIlleggibili && !out.some(x => x.prezzo != null)
    ? `${prezziIlleggibili} annunci hanno un campo prezzo che non riesco a leggere`
    : null;
  if (prezziIlleggibili && !sospetto) {
    parziale = [parziale, `${prezziIlleggibili} annunci hanno un campo prezzo non leggibile`].filter(Boolean).join(' · ');
  }
  hasMore = mainNextStart !== null || recuperoNextStart !== null;
  return opts.withMeta ? { items: out, truncated, total, hasMore, mainNextStart, recuperoNextStart,
    sospetto, parziale, parzialeRete,
    erroreTipo, erroreHttp, erroreCodice, bloccoParziale, erroriSubito } : out;
}

// Ricerca ACCESSORI/RICAMBI per keyword libera (OEM o nome pezzo) nelle categorie
// Accessori Auto (c=5) + Accessori Moto (c=36). Riusa scrapeSubitoApi (path API, no CAPTCHA).
// La keyword viaggia su `marca` (buildPath fa q=marca+modello). Ritorna item mapAd (shape Subito).
// opts.cat = 'auto' | 'moto' → interroga SOLO quella categoria (un ricambio è per auto O per moto).
// opts.withMeta conserva totale grezzo, copertura e avvisi; senza, resta l'array storico.
// Lancia solo se TUTTE le categorie interrogate falliscono (una KO → torna quel che c'è).
async function searchAccessori(keyword, opts = {}) {
  const kw = String(keyword || '').trim();
  if (!kw) return opts.withMeta ? { items: [], total: null, truncated: false, hasMore: false,
    sospetto: null, parziale: null, parzialeRete: false, erroriSubito: [] } : [];
  const { cat, withMeta = false, ...rest } = opts;
  const cats = cat === 'auto' ? ['accessoriAuto'] : cat === 'moto' ? ['accessoriMoto'] : ['accessoriAuto', 'accessoriMoto'];
  const res = await Promise.allSettled(cats.map(tipo =>
    scrapeSubitoApi({ marca: kw, tipo }, { maxPages: 1, sort: 'priceasc', ...rest, withMeta: true })));
  const lette = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  const items = lette.flatMap(r => r.items);
  const rejected = res.find(r => r.status === 'rejected');
  // 0 item MA almeno una categoria bloccata → propaga (runSource → 'error', non cachato come 'empty').
  // both-fulfilled con 0 item = vuoto legittimo → return [].
  if (!items.length && rejected) throw rejected.reason;
  if (!withMeta) return items;
  if (cats.length === 1) return lette[0];
  // Il chiamante senza categoria puo' ancora chiedere entrambi i cataloghi. Il
  // totale con un ramo ignoto/fallito non e' la sola somma del ramo riuscito.
  return {
    items,
    total: rejected || lette.some(r => r.total == null) ? null : lette.reduce((n, r) => n + r.total, 0),
    truncated: lette.some(r => r.truncated), hasMore: lette.some(r => r.hasMore),
    sospetto: lette.map(r => r.sospetto).filter(Boolean).join(' · ') || null,
    parziale: [...lette.map(r => r.parziale), rejected && 'Subito non ha restituito tutte le categorie richieste.']
      .filter(Boolean).join(' · ') || null,
    parzialeRete: !!rejected || lette.some(r => r.parzialeRete),
    erroriSubito: [...lette.flatMap(r => r.erroriSubito),
      ...res.filter(r => r.status === 'rejected').flatMap(r => r.reason.erroriSubito || [])],
  };
}

module.exports = scrapeSubitoApi;
module.exports.searchAccessori = searchAccessori;
module.exports._mapAd = mapAd;
module.exports._buildPath = buildPath;
module.exports._extractTotal = extractTotal;   // F50 copertura
module.exports.AVVISO_429 = AVVISO_429;
module.exports._riconosci = riconosci;         // filtro sui livelli dichiarati dall'annuncio
module.exports._faTitolo = faTitolo;
// Quanto e' largo DAVVERO il filtro km chiesto, sui due lati: `ms` e `me` sono categorie.
module.exports.kmTettoFascia = kmTettoFascia;
module.exports.kmPavimentoFascia = kmPavimentoFascia;
module.exports._setHttpGetJson = fn => { _http = fn || httpGetJson; };
