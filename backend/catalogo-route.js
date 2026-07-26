'use strict';
/**
 * CATALOGO — listino del nuovo navigabile, indipendente dalla ricerca usato.
 *
 * Perche' e' una sezione a se': i dati di un veicolo (allestimenti, potenza, prezzo di
 * listino, dotazione di serie) esistono anche quando nessuno sta vendendo quell'auto. Legarli
 * a una ricerca di annunci significava non poterli guardare senza prima cercare qualcosa.
 *
 * Quattro passi, uno per livello: marche → modelli → allestimenti → scheda dell'allestimento.
 * Ogni passo e' una richiesta sola e passa dalla cache a 7 giorni di scrapers/motornet.js.
 *
 * La fonte e' Motornet (Eurotax Italia) ed e' SPENTA se non la si accende (AMR_MOTORNET=1):
 * in quel caso queste route rispondono ok:false con il motivo, e la UI lo dice invece di
 * mostrare una sezione vuota che sembra rotta. Vedi l'intestazione di scrapers/motornet.js
 * per lo stato legale di quella fonte.
 */
const motornet = require('./scrapers/motornet');
const autoit = require('./scrapers/autoit-rilevamenti');
const insella = require('./scrapers/insella-prove');

// Il catalogo aggrega TRE cataloghi distinti, e non li mescola: sono cose diverse e chi
// naviga deve sapere cosa sta guardando.
//  - 'nuovo' → listino del nuovo (Motornet): prezzi, kW, dotazione. Via rete, spento di default.
//  - 'auto'  → schede tecniche auto (auto-data.net): 392 marche, 3.909 modelli, TUTTO SU DISCO.
//  - 'moto'  → schede tecniche moto (ultimatespecs): 377 marche, 11.529 modelli, su disco.
// Le due su disco si navigano senza una richiesta di rete: marca e modello sono gia' qui, e
// i livelli piu' profondi (motorizzazioni, specifiche) riusano /api/scheda-veicolo, che
// accetta marca+modello da sola e non dipende da una ricerca.
const AUTODATA = require('../data/autodata-index.json');
const ULTIMATE = require('../data/ultimatespecs-moto-index.json');
// Loghi delle marche auto-data.net (scripts/build-autodata-loghi.js). Senza, la griglia
// mostrava 392 segnaposto identici: una parete di quadratini in cui non si trova niente.
let LOGHI_AUTO = {};
try { LOGHI_AUTO = require('../data/autodata-loghi.json').loghi || {}; } catch (_) {}

// auto-data.net scrive i modelli come "124 1966 -": gli anni in coda sono rumore in un elenco.
const senzaAnni = n => String(n || '').replace(/\s+(19|20)\d{2}\s*(-\s*((19|20)\d{2})?)?\s*$/, '').trim() || String(n || '');

// `spegnibile` = questa fonte dipende dall'interruttore AMR_MOTORNET. Sta qui e non sparso nei
// rami perche' e' una proprieta' DELLA FONTE: prima era ripetuto a mano in due punti come
// "!== 'rilevamenti'", e ogni fonte nuova aggiungeva un caso speciale a entrambi.
const FONTI = {
  nuovo: { nome: 'Listino del nuovo', dettaglio: 'prezzi, potenza e dotazione — Motornet (Eurotax)', tipo: 'auto', rete: true, spegnibile: true },
  auto: { nome: 'Schede tecniche auto', dettaglio: 'auto-data.net', tipo: 'auto', rete: false },
  moto: { nome: 'Schede tecniche moto', dettaglio: 'ultimatespecs.com', tipo: 'moto', rete: false },
  // La quarta e' diversa dalle altre tre: non dichiarazioni del costruttore ma MISURE della
  // redazione. Due soli livelli, perche' la prova E' la foglia: non c'e' niente sotto.
  rilevamenti: { nome: 'Rilevamenti', dettaglio: 'misure della redazione — Auto (auto.it)', tipo: 'auto', rete: true, livelli: 2 },
  // La quinta e' il gemello moto della quarta: misure invece di dichiarazioni. Tre livelli e non
  // due, perche' l'indice porta solo il titolo della prova e la scheda va chiesta a parte.
  prove: { nome: 'Prove moto', dettaglio: 'misure e voti della redazione — inSella', tipo: 'moto', rete: true, livelli: 3 },
};

// Da un indice su disco all'elenco marche/modelli, nella stessa forma della fonte di rete.
function marcheDaIndice(idx, loghi) {
  return Object.entries(idx.brands || {})
    .map(([k, b]) => ({ acronimo: k, nome: b.name || k, logo: (loghi && loghi[k]) || null }))
    .filter(m => m.nome)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}
function modelliDaIndice(idx, chiaveMarca) {
  const b = (idx.brands || {})[chiaveMarca];
  if (!b) return null;
  const mods = b.models || {};
  return Object.entries(mods)
    .map(([k, m]) => ({ codiceModello: k, nome: senzaAnni(m.name || m.label || k), gamma: null, storico: null, inizio: null, fine: null }))
    .filter(m => m.nome)
    .sort((a, b2) => a.nome.localeCompare(b2.nome, 'it'));
}
const indiceDi = f => (f === 'auto' ? AUTODATA : f === 'moto' ? ULTIMATE : null);

// Stessa finestra del resto delle route pubbliche: 40 richieste al minuto per IP.
const hits = new Map();
function rateOk(ip) {
  const now = Date.now();
  if (hits.size > 5000) hits.clear();
  const a = (hits.get(ip) || []).filter(t => now - t < 60000);
  a.push(now); hits.set(ip, a); return a.length <= 40;
}

const SPENTO = { ok: false, motivo: 'catalogo non attivo su questa installazione', spento: true };

// Dopo un 403/429 lo scraper tace per mezz'ora. E' una scelta giusta verso la fonte, ma
// dall'interfaccia era indistinguibile da un guasto: si diceva "non disponibile" e basta.
// Qui si tira su l'istante di fine pausa, cosi' la UI puo' dire quanto manca.
const SCRAPER = { rilevamenti: autoit, prove: insella, nuovo: motornet };
const pausaDi = fonte => {
  const s = SCRAPER[fonte];
  return s && s.pausaFinoA ? s.pausaFinoA() : 0;
};
// Una fonte sconosciuta si comporta come il listino: si spegne. Cosi' un id sbagliato nella query
// non apre una porta di servizio.
const spegnibile = fonte => (FONTI[fonte] ? !!FONTI[fonte].spegnibile : true);

function mount(app, deps = {}) {
  const clientIp = deps.clientIp || (req => req.ip || '');
  // Ogni risposta del catalogo passa di qui: limite, interruttore, errore in chiaro.
  // `fonteFissa` = la route serve sempre quella fonte, qualunque cosa dica la query. Senza,
  // /api/catalogo/rilevamenti (che non manda `fonte`) ricadeva sul listino e rispondeva spento.
  const via = (percorso, lavoro, fonteFissa) => app.get(percorso, async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ ok: false, motivo: 'Troppe richieste.' });
    // Lo spegnimento riguarda solo le fonti marcate `spegnibile` in FONTI: oggi il listino
    // Motornet. I cataloghi su disco, i rilevamenti e le prove moto vanno comunque.
    const fonteQ = fonteFissa || String((req.query || {}).fonte || 'nuovo');
    if (spegnibile(fonteQ) && !motornet.ATTIVO) return res.json(SPENTO);
    try {
      const out = await lavoro(req.query || {});
      if (out == null) return res.json({ ok: false, motivo: 'non trovato' });
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ ok: true, ...out });
    } catch (e) {
      console.warn('[catalogo] ' + percorso + ' KO:', e.message);
      // Su un blocco si dice ANCHE fino a quando dura: senza, la sezione sembra rotta per
      // mezz'ora e non c'e' modo di sapere che basta aspettare.
      const fino = pausaDi(fonteQ);
      res.json({ ok: false, motivo: e.message, kind: e.kind || 'error', ...(fino ? { bloccataFino: fino } : {}) });
    }
  });

  // Elenco delle fonti navigabili, con quante voci hanno e se sono disponibili qui.
  app.get('/api/catalogo/fonti', (req, res) => {
    const conta = f => { const i = indiceDi(f); return i ? Object.keys(i.brands || {}).length : null; };
    // NIENTE cache: questa risposta porta lo stato di pausa, che cambia da un minuto all'altro.
    // Con max-age=3600 il conto alla rovescia sarebbe rimasto congelato per un'ora.
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, adesso: Date.now(), fonti: Object.entries(FONTI).map(([id, f]) => {
      const fino = pausaDi(id);
      return {
        id, ...f,
        disponibile: f.spegnibile ? motornet.ATTIVO : true,
        marche: f.rete ? null : conta(id),
        ...(fino ? { bloccataFino: fino } : {}),
      };
    }) });
  });

  via('/api/catalogo/marche', async q => {
    const f = String(q.fonte || 'nuovo');
    if (f === 'rilevamenti') return { fonte: f, marche: await autoit.marche() };
    if (f === 'prove') return { fonte: f, marche: await insella.marche() };
    const idx = indiceDi(f);
    if (idx) return { fonte: f, marche: marcheDaIndice(idx, f === 'auto' ? LOGHI_AUTO : null) };
    return { fonte: 'nuovo', marche: await motornet.marche() };
  });

  // ─── Prove moto (inSella): marca → elenco prove → scheda della prova ───────
  // Secondo livello: solo titolo e categoria. La scheda costa una richiesta a parte, quindi non
  // si scarica per tutte quelle di una marca solo per mostrarne l'elenco.
  via('/api/catalogo/prove', async q => {
    const marca = String(q.marca || '').trim();
    if (!marca) return { prove: [], motivo: 'marca mancante' };
    const prove = await insella.proveDi(marca);
    return { marca, prove, fonte: 'inSella — prove e rilevamenti della redazione' };
  }, 'prove');

  // Terzo e ultimo livello: tutto quello che la pagina porta — misure, dichiarati, dimensioni
  // rilevate, voti, metodologia, testi e galleria.
  via('/api/catalogo/prova', async q => {
    const slug = String(q.slug || '').trim();
    if (!slug) return { motivo: 'prova mancante' };
    return { prova: await insella.prova(slug) };
  }, 'prove');

  // Secondo e ULTIMO livello dei rilevamenti: le prove di una marca. Ognuna e' gia' la foglia,
  // con i valori misurati e il rimando all'articolo pubblicato.
  via('/api/catalogo/rilevamenti', async q => {
    const marca = String(q.marca || '').trim();
    if (!marca) return { rilevamenti: [], motivo: 'marca mancante' };
    return await autoit.rilevamenti(marca);
  }, 'rilevamenti');

  via('/api/catalogo/modelli', async q => {
    const marca = String(q.marca || '').trim();
    if (!marca) return { modelli: [], motivo: 'marca mancante' };
    const f = String(q.fonte || 'nuovo');
    const idx = indiceDi(f);
    if (idx) {
      const mods = modelliDaIndice(idx, marca);
      if (!mods) return { modelli: [], motivo: 'marca non in questo catalogo' };
      const b = idx.brands[marca];
      return { fonte: f, acronimo: marca, marcaNome: b.name || marca, modelli: mods };
    }
    // Si accetta sia la sigla ("ALF") sia il nome esteso ("Alfa Romeo"): chi arriva da un
    // link della ricerca usato ha il nome, chi naviga il catalogo ha la sigla.
    // Si distingue sigla da nome guardando gli acronimi VERI, non la lunghezza: "DS" e "MG"
    // sono nomi di due caratteri con acronimo diverso ("DSA", "MGG"), e con l'euristica sulla
    // lunghezza finivano spediti a Motornet come codice_marca, che rispondeva elenco vuoto.
    // marche() e' in cache 7 giorni: non aggiunge richieste.
    let acronimo = marca.toUpperCase();
    const ms = await motornet.marche();
    if (!ms.some(x => x.acronimo === acronimo)) {
      const n = motornet._norm(marca);
      const m = ms.find(x => motornet._norm(x.nome) === n) || ms.find(x => motornet._norm(x.nome).startsWith(n));
      if (!m) return { modelli: [], motivo: 'marca non nel listino del nuovo' };
      acronimo = m.acronimo;
    }
    return { acronimo, modelli: await motornet.modelli(acronimo) };
  });

  via('/api/catalogo/versioni', async q => {
    const cod = String(q.modello || '').trim();
    if (!cod) return { versioni: [], motivo: 'modello mancante' };
    return await motornet.versioni(cod);
  }, 'nuovo');

  // La scheda completa di un allestimento. Accessori a parte e in parallelo: sono due
  // richieste diverse alla fonte, e se una fallisce l'altra deve arrivare lo stesso.
  via('/api/catalogo/allestimento', async q => {
    const cod = String(q.codice || '').trim();
    if (!cod) return { motivo: 'codice allestimento mancante' };
    const d = await motornet.dettaglio(cod);
    let acc = null;
    if (d && d.codiceEurotax) {
      try { acc = await motornet.accessori(d.codiceEurotax); }
      catch (e) { console.warn('[catalogo] accessori KO:', e.message); }
    }
    return { dettaglio: d, accessori: acc };
  }, 'nuovo');
}

module.exports = { mount, _rateOk: rateOk };
