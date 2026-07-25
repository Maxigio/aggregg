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
    if (!motornet.ATTIVO) return res.json(SPENTO);
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

  via('/api/catalogo/marche', async () => ({ marche: await motornet.marche() }));

  via('/api/catalogo/modelli', async q => {
    const marca = String(q.marca || '').trim();
    if (!marca) return { modelli: [], motivo: 'marca mancante' };
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
