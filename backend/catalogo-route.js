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

// auto-data.net scrive i modelli come "124 1966 -": gli anni in coda sono rumore in un elenco.
const senzaAnni = n => String(n || '').replace(/\s+(19|20)\d{2}\s*(-\s*((19|20)\d{2})?)?\s*$/, '').trim() || String(n || '');

const FONTI = {
  nuovo: { nome: 'Listino del nuovo', dettaglio: 'prezzi, potenza e dotazione — Motornet (Eurotax)', tipo: 'auto', rete: true },
  auto: { nome: 'Schede tecniche auto', dettaglio: 'auto-data.net', tipo: 'auto', rete: false },
  moto: { nome: 'Schede tecniche moto', dettaglio: 'ultimatespecs.com', tipo: 'moto', rete: false },
};

// Da un indice su disco all'elenco marche/modelli, nella stessa forma della fonte di rete.
function marcheDaIndice(idx) {
  return Object.entries(idx.brands || {})
    .map(([k, b]) => ({ acronimo: k, nome: b.name || k, logo: null }))
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

function mount(app, deps = {}) {
  const clientIp = deps.clientIp || (req => req.ip || '');
  // Ogni risposta del catalogo passa di qui: limite, interruttore, errore in chiaro.
  const via = (percorso, lavoro) => app.get(percorso, async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ ok: false, motivo: 'Troppe richieste.' });
    // Lo spegnimento riguarda la SOLA fonte di rete: i due cataloghi su disco vanno comunque.
    const fonteQ = String((req.query || {}).fonte || 'nuovo');
    if (!motornet.ATTIVO && !indiceDi(fonteQ)) return res.json(SPENTO);
    try {
      const out = await lavoro(req.query || {});
      if (out == null) return res.json({ ok: false, motivo: 'non trovato' });
      res.set('Cache-Control', 'public, max-age=3600');
      res.json({ ok: true, ...out });
    } catch (e) {
      console.warn('[catalogo] ' + percorso + ' KO:', e.message);
      res.json({ ok: false, motivo: e.message, kind: e.kind || 'error' });
    }
  });

  // Elenco delle fonti navigabili, con quante voci hanno e se sono disponibili qui.
  app.get('/api/catalogo/fonti', (req, res) => {
    const conta = f => { const i = indiceDi(f); return i ? Object.keys(i.brands || {}).length : null; };
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, fonti: Object.entries(FONTI).map(([id, f]) => ({
      id, ...f,
      disponibile: f.rete ? motornet.ATTIVO : true,
      marche: f.rete ? null : conta(id),
    })) });
  });

  via('/api/catalogo/marche', async q => {
    const f = String(q.fonte || 'nuovo');
    const idx = indiceDi(f);
    if (idx) return { fonte: f, marche: marcheDaIndice(idx) };
    return { fonte: 'nuovo', marche: await motornet.marche() };
  });

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
    let acronimo = marca.toUpperCase();
    if (marca.length > 3) {
      const ms = await motornet.marche();
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
  });

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
  });
}

module.exports = { mount, _rateOk: rateOk };
