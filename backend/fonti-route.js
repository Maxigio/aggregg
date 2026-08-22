'use strict';
/**
 * FONTI — l'area che tiene insieme le banche dati aperte che non sono ne' catalogo ne' annunci.
 *
 * Sono quattro cose diverse, ognuna con la sua scheda, ma stanno insieme per un motivo pratico:
 * il proprietario ha chiesto di poterle "consultare e modificare insieme" mentre si capisce quanti
 * dati rendono. Ognuna dichiara da sola cosa sa e cosa non sa.
 *
 *  - territorio   OpenStreetMap: concessionari concorrenti, officine, gommisti, distributori,
 *                 colonnine, centri revisione, zone a basse emissioni. Per regione.
 *  - pneumatici   EPREL, la banca dati UE delle etichette: 293.999 pneumatici con efficienza,
 *                 aderenza sul bagnato, rumore, neve e ghiaccio. Per misura e marca.
 *  - ricambiOe    bilstein partsfinder: da un codice originale a tutti i suoi equivalenti, con
 *                 le misure tecniche del pezzo.
 *  - cerchi       Wheel-Size: calzate, offset e PRESSIONI di gonfiaggio per modello e anno.
 *  - costi        IVASS + MEF: quanto costa TENERE un veicolo in ogni provincia — premio r.c.
 *                 realmente pagato e aliquota dell'imposta provinciale. Unica del gruppo a stare
 *                 tutta su disco: nessuna rete, nessuna pausa.
 *
 * Ogni fonte va in rete solo quando la si interroga, con la sua cache e la sua pausa. La pausa
 * dopo un blocco si espone come per il catalogo, cosi' l'interfaccia dice quanto manca invece di
 * far sembrare rotta la sezione.
 */
const osm = require('./scrapers/osm-territorio');
const eprel = require('./scrapers/eprel-pneumatici');
const bilstein = require('./scrapers/bilstein-oe');
const wheelsize = require('./scrapers/wheelsize');
// La pulizia del nome-modello sta nella scheda veicolo perche' vale per ogni chiamante:
// qui si riusa quella invece di ricopiarne le regex. Nessun ciclo — scheda-veicolo-route
// non richiede fonti-route (verificato: l'unico che carica entrambi e' server.js).
const { senzaGenerazione } = require('./scheda-veicolo-route');
const carburanti = require('./carburanti');
const costi = require('./costi-possesso');
const PROVINCE = require('../data/province.json');

/**
 * IL JOIN che tiene insieme due fonti che gia' avevamo separate.
 *
 * OpenStreetMap mappa i distributori col tag `ref:mise`, che e' l'idImpianto dell'anagrafica
 * MIMIT — la stessa chiave dei prezzi che scarichiamo ogni dodici ore. Incrociandoli, alla
 * posizione verificata sul posto, agli orari, al self service e ai carburanti disponibili di OSM
 * si aggiunge il PREZZO REALE di oggi, self e servito, per ognuno dei quattro carburanti.
 *
 * Distanza fra il punto OSM e quello MIMIT, misurata: mediana 5 metri. Si calcola comunque e si
 * espone: se un giorno diventasse grande, vorrebbe dire che il tag punta all'impianto sbagliato.
 */
const RAGGIO_TERRA_M = 6371000;
function distanzaM(a, b) {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null;
  const r = x => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(RAGGIO_TERRA_M * 2 * Math.asin(Math.sqrt(s)));
}

/** Aggiunge i prezzi MIMIT ai distributori OSM che portano `ref:mise`. */
async function conPrezzi(oggetti) {
  let mimit = null;
  try { mimit = await carburanti.impianti(); } catch (_) { mimit = null; }
  if (!mimit) return { oggetti, agganciati: 0, motivo: 'prezzi MIMIT non disponibili adesso' };
  let agganciati = 0, senzaCodice = 0, senzaPrezziOggi = 0, codiceScaduto = 0;
  const fuori = oggetti.map(o => {
    // Il tag puo' portare piu' codici separati da ";" quando un punto mappa piu' impianti.
    const rif = (o.dati && o.dati['ref:mise']) || (o.altriTag && o.altriTag['ref:mise']);
    const id = String(rif || '').split(/[;,]/)[0].trim();
    if (!id) { senzaCodice++; return { ...o, aggancio: 'senzaCodice' }; }
    const m = Object.prototype.hasOwnProperty.call(mimit, id) ? mimit[id] : null;
    // Tre esiti diversi, e vanno detti diversi. Misurato in Emilia-Romagna su 1.860 distributori:
    // 239 senza codice, 820 col prezzo di oggi, 67 attivi che oggi non hanno comunicato, e 734
    // con un codice che nell'anagrafica ministeriale degli impianti ATTIVI non c'e' piu' — OSM
    // tiene il tag anche dopo che l'impianto ha chiuso. Chiamarli tutti "codice assente" era
    // falso su 801 righe su 1.860.
    if (!m) { codiceScaduto++; return { ...o, aggancio: 'codiceScaduto', codiceMise: id }; }
    // Quanto distano i due punti: e' il controllo che il tag non punti altrove. Misurato in
    // Emilia-Romagna su 820 agganci: mediana 5 metri, p90 17, e SOLO 3 oltre il chilometro —
    // errori veri di OSM (un ref:mise digitato male porta il prezzo di un impianto a 30 km).
    // Si marcano invece di mostrarli come se fossero giusti.
    const scartoM = distanzaM(o, m);
    const scheda = {
      id: m.id, bandiera: m.bandiera, tipo: m.tipo, gestore: m.gestore,
      comune: m.comune, provincia: m.provincia, indirizzo: m.indirizzo,
      prezzi: m.prezzi, scartoM, sospetto: scartoM != null && scartoM > 1000,
    };
    if (!m.prezzi) { senzaPrezziOggi++; return { ...o, aggancio: 'senzaPrezziOggi', codiceMise: id, mimit: scheda }; }
    agganciati++;
    return { ...o, aggancio: 'prezzi', codiceMise: id, mimit: scheda };
  });
  const sospetti = fuori.filter(o => o.mimit && o.mimit.sospetto).length;
  return { oggetti: fuori, agganciati, sospetti, senzaCodice, senzaPrezziOggi, codiceScaduto };
}

const FONTI = {
  territorio: {
    nascosta: true,   // fuori dall'elenco; endpoint intatti
    nome: 'Territorio', dettaglio: 'concorrenti, officine, distributori e colonnine — OpenStreetMap',
    scraper: osm,
    sa: 'Dove sono i concessionari che vendono usato nella tua zona, le officine, i gommisti, i distributori e le colonnine. Sui distributori aggiunge il PREZZO di oggi incrociando il codice ministeriale con i dati MIMIT.',
    nonSa: 'OSM e\' compilato da volontari: la copertura e\' ottima nelle citta\' e piu\' rada altrove, e un negozio chiuso puo\' restare mappato.',
  },
  pneumatici: {
    nome: 'Pneumatici', dettaglio: 'etichetta europea ufficiale — EPREL, Commissione UE',
    scraper: eprel,
    sa: 'Efficienza, aderenza sul bagnato, rumore in decibel, neve e ghiaccio di ogni pneumatico registrato in Europa.',
    nonSa: 'Non contiene dati di veicolo: nessuna marca auto, nessun modello. Si cerca per misura o per marca del pneumatico.',
  },
  ricambiOe: {
    // NASCOSTA DALL'ELENCO, non spenta: la sezione Ricambi la usa a ogni ricerca per
    // codice (`/cerca`), dove i dati del pezzo e i codici equivalenti stanno accanto
    // alle offerte. Come voce a se' stante non serve piu' a nessuno.
    nascosta: true,
    nome: 'Ricambi OE', dettaglio: 'da un codice originale a tutti i suoi equivalenti — bilstein group',
    scraper: bilstein,
    sa: 'Dato un codice originale, quali altri codici sono lo stesso pezzo, su quali marche monta e che misure ha.',
    nonSa: 'Copre il catalogo di febi, SWAG e Blue Print: un pezzo che nessuno dei tre produce non c\'e\'.',
  },
  cerchi: {
    nome: 'Cerchi e gomme', dettaglio: 'calzate, offset e pressioni per modello — Wheel-Size',
    scraper: wheelsize,
    sa: 'Le calzate omologate con offset, backspace, peso e soprattutto le PRESSIONI di gonfiaggio anteriore e posteriore.',
    nonSa: 'Distanza fori, diametro di centraggio e coppie di serraggio non sono nella pagina, e la misura del pneumatico e\' in chiaro solo su una riga su sette.',
  },
  costi: {
    nascosta: true,   // fuori dall'elenco; endpoint intatti
    nome: 'Costi di possesso', dettaglio: 'premio r.c. e imposta provinciale — IVASS e MEF',
    // Nessuno scraper: e' l'unica fonte gia' tutta su disco. Da qui in giu' `scraper` va trattato
    // come facoltativo, e non come "c'e' sempre".
    sa: 'Quanto si paga davvero di r.c. auto in ogni provincia — mediana, media e percentili dei contratti STIPULATI, divisi per classe bonus-malus — e l\'aliquota dell\'imposta provinciale deliberata sul posto.',
    nonSa: 'Non e\' un preventivo: sono statistiche su tutte le polizze della provincia, senza potenza del veicolo ne\' eta\' del conducente. Sette province non hanno l\'aliquota e una non ha i premi, per come pubblicano le fonti: li\' si risponde vuoto invece di stimare.',
  },
};

/** L'istante di fine pausa di una fonte, 0 se non ne ha o se non e' bloccata. */
const pausaDi = f => (f && f.scraper && f.scraper.pausaFinoA ? f.scraper.pausaFinoA() : 0);

function mount(app, deps = {}) {
  // La chiave dei limiti: la PERSONA quando e' entrata, l'indirizzo quando no.
  const chiaveLimite = deps.chiaveLimite || deps.clientIp || (req => req.ip || '');
  const limite = require('./limite-richieste').crea({ max: 40, cosa: 'richieste alle fonti' });

  const via = (percorso, fonte, lavoro) => app.get(percorso, async (req, res) => {
    const g = limite.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ ok: false, motivo: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
    try {
      const out = await lavoro(req.query || {});
      // L'ora di cache solo se c'e' un dato dentro: "prezzi non disponibili adesso" e' un "non
      // lo so", e congelarlo un'ora fa sembrare guasta una fonte che e' tornata dopo un minuto.
      // I campi che le rotte di questo file emettono DAVVERO quando non hanno il dato: `notaPrezzi`
      // (territorio senza MIMIT) e `motivo` (categoria mancante, misura mancante, fonte vuota).
      // Una risposta con uno di questi e' un "non lo so" e non si congela un'ora.
      const vuoto = out && (out.notaPrezzi != null || out.motivo != null);
      res.set('Cache-Control', vuoto ? 'no-store' : 'public, max-age=3600');
      res.json({ ok: true, ...out });
    } catch (e) {
      console.warn('[fonti] ' + percorso + ' KO:', e.message);
      const fino = pausaDi(FONTI[fonte]);
      res.json({ ok: false, motivo: e.message, kind: e.kind || 'error', ...(fino ? { bloccataFino: fino } : {}) });
    }
  });

  // L'elenco delle fonti, con quello che ognuna sa e non sa. Niente cache: porta lo stato di pausa.
  app.get('/api/fonti', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true, adesso: Date.now(),
      // `nascosta` toglie la voce dall'elenco e basta: le rotte restano in piedi, perche'
      // una fonte puo' servire da dentro un'altra parte dell'app (ricambiOe lo fa).
      fonti: Object.entries(FONTI).filter(([, f]) => !f.nascosta).map(([id, f]) => {
        const fino = pausaDi(f);
        return { id, nome: f.nome, dettaglio: f.dettaglio, sa: f.sa, nonSa: f.nonSa, ...(fino ? { bloccataFino: fino } : {}) };
      }),
    });
  });

  // ─── Territorio ────────────────────────────────────────────────────────────
  app.get('/api/fonti/territorio/categorie', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.json({
      ok: true,
      categorie: Object.entries(osm.CATEGORIE).map(([id, c]) => ({ id, nome: c.nome })),
      regioni: Object.keys(osm.REGIONI),
    });
  });
  via('/api/fonti/territorio/conta', 'territorio', q => osm.conta(q.regione || null).then(c => ({ regione: q.regione || null, conteggi: c })));
  via('/api/fonti/territorio/oggetti', 'territorio', async q => {
    if (!q.categoria) return { oggetti: [], motivo: 'categoria mancante' };
    const cat = String(q.categoria);
    // `totale` e' quanti ne esistono, `oggetti` quanti se ne sono presi: il taglio lo fa gia'
    // l'istanza, qui non si ritaglia niente e non si spaccia il tagliato per il totale.
    const v = await osm.oggetti(cat, q.regione ? String(q.regione) : null);
    const base = { categoria: cat, regione: q.regione || null, totale: v.totale, limite: v.limite };
    // Solo i distributori hanno un gemello nei prezzi MIMIT: sulle altre categorie il join
    // non esiste e non si finge che ci sia.
    if (cat !== 'distributori') return { ...base, oggetti: v.oggetti };
    const { oggetti: conP, motivo, ...conti } = await conPrezzi(v.oggetti);
    return { ...base, oggetti: conP, ...conti, ...(motivo ? { notaPrezzi: motivo } : {}) };
  });

  // ─── Pneumatici ────────────────────────────────────────────────────────────
  via('/api/fonti/pneumatici/totale', 'pneumatici', () => eprel.totale().then(t => ({ totale: t })));
  via('/api/fonti/pneumatici/cerca', 'pneumatici', q => {
    if (!q.misura && !q.marca) return Promise.resolve({ pneumatici: [], motivo: 'serve almeno una misura o una marca' });
    return eprel.cerca({ misura: q.misura, marca: q.marca, classe: q.classe, pagina: q.pagina });
  });

  // ─── Ricambi OE ────────────────────────────────────────────────────────────
  via('/api/fonti/ricambi-oe/cerca', 'ricambiOe', q => {
    if (!q.codice) return Promise.resolve({ articoli: [], motivo: 'codice mancante' });
    return bilstein.perCodice(String(q.codice), q.tipo);
  });
  via('/api/fonti/ricambi-oe/equivalenti', 'ricambiOe', q => {
    if (!q.codice) return Promise.resolve({ equivalenti: [], motivo: 'codice mancante' });
    return bilstein.equivalenti(String(q.codice), q.tipo);
  });

  // ─── Cerchi e gomme ────────────────────────────────────────────────────────
  via('/api/fonti/cerchi/calzate', 'cerchi', q => {
    if (!q.marca || !q.modello || !q.anno) return Promise.resolve({ calzate: [], motivo: 'servono marca, modello e anno' });
    // Il nome che arriva dall'annuncio porta il suffisso di generazione di Subito
    // ("Panda 3ª serie", "Serie 3 (E90/91)"): Wheel-Size non lo conosce e risponde vuoto.
    // Si ripulisce QUI, non nel frontend, per la stessa ragione scritta in
    // scheda-veicolo-route.js:244 — vale per ogni chiamante, non per uno solo.
    const modello = senzaGenerazione(String(q.modello)) || String(q.modello);
    return wheelsize.calzate(String(q.marca), modello, String(q.anno));
  });

  // ─── Costi di possesso ─────────────────────────────────────────────────────
  // Sta su disco: nessuna rete, quindi nessuna pausa e nessun caso di errore da gestire.
  const D = costi.dati;
  const conNome = sg => ({ sigla: sg, nome: (PROVINCE[sg] || {}).nome || sg, regione: (PROVINCE[sg] || {}).regione || null });

  /** La classifica nazionale del premio mediano: e' anche l'elenco da cui si sceglie. */
  const classifica = tipo => {
    const t = ['auto', 'moto', 'ciclomotore'].includes(tipo) ? tipo : 'auto';
    const v = Object.entries(D.province)
      .map(([sg, p]) => ({ ...conNome(sg), ...(p[t] || {}), aliquotaRc: p.aliquotaRc }))
      .filter(x => x.mediana != null)
      .sort((a, b) => a.mediana - b.mediana)
      .map((x, i) => ({ ...x, posto: i + 1 }));
    return { tipo: t, province: v, totale: v.length };
  };

  via('/api/fonti/costi/classifica', 'costi', q => Promise.resolve({
    ...classifica(q.tipo),
    periodo: D.periodo, fonti: D.fonti, nota: D.nota, assenti: D.assenti, generatedAt: D.generatedAt,
    // Le province SENZA premio non spariscono dall'elenco: sparire farebbe pensare che non
    // esistano, mentre e' la fonte che non le pubblica. Si dicono, col perche'.
    senzaDato: Object.keys(D.province).filter(sg => !(D.province[sg][['auto', 'moto', 'ciclomotore'].includes(q.tipo) ? q.tipo : 'auto'] || {}).mediana).map(conNome),
  }));

  via('/api/fonti/costi/provincia', 'costi', q => {
    const sg = String(q.provincia || '').toUpperCase().trim();
    if (!sg) return Promise.resolve({ motivo: 'serve la sigla della provincia, es. MI' });
    const c = costi.cerca(sg, q.tipo);
    if (!c) return Promise.resolve({ motivo: 'provincia sconosciuta: ' + sg });
    // Tutti e tre i tipi in una risposta sola: la domanda vera e' "quanto mi costa qui", e
    // saperlo per l'auto ma non per la moto vuol dire rifare la stessa richiesta.
    const perTipo = {};
    for (const t of ['auto', 'moto', 'ciclomotore']) {
      const x = costi.cerca(sg, t);
      perTipo[t] = { rc: x.rc, rcMotivo: x.rcMotivo, posizione: costi.posizione(sg, t) };
    }
    return Promise.resolve({ ...c, ...conNome(sg), perTipo, posizione: costi.posizione(sg, q.tipo) });
  });
}

module.exports = { mount, FONTI };
