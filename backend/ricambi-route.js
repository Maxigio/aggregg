'use strict';
// Rotta GET /api/ricambi?oen=... — codice OEM → articoli MULTI-FONTE (Autodoc + Web).
// Estratta da server.js per testabilità in isolamento (deps iniettabili) senza avviare
// l'intero server né toccare le fonti. Montata da server.js con mount(app).
//
// Dietro auth, demo-allowed (GET, non nei prefissi privati del demo-gate). Le fonti sono
// costose (browser stealth + chiamata Anthropic) → cache per OEN + rate-limit dedicato.
// Ritorna SEMPRE 200 con l'envelope multi-fonte (lo status per-fonte è dentro `sources`),
// come la ricerca auto: un fallimento parziale non è un errore della rotta.
const realCore = require('./ricambi-core');
const realOem = require('./oem-lookup');

const RICAMBI_TTL = 60 * 60 * 1000;        // 1h per lookup con risultati
const RICAMBI_EMPTY_TTL = 5 * 60 * 1000;   // 5min per 0-item (codice ignoto): non ri-cercare subito
const RICAMBI_CACHE_MAX = 200;
const RATE_WINDOW = 60 * 1000;
const RATE_CAP = 10;

const defaultClientIp = req =>
  (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket?.remoteAddress || 'local';

// Non cachare se una fonte è in errore transitorio (blocked/error/timeout) → così un OEN
// degradato viene ritentato invece di restare congelato in cache.
function cacheable(env) {
  const bad = s => s === 'error' || s === 'blocked' || s === 'timeout';
  return !Object.values(env.sources || {}).some(s => bad(s.status));
}

// deps iniettabili: { searchRicambi, normOen, clientIp } — default = reali. I test passano stub.
function mount(app, deps = {}) {
  const searchRicambi = deps.searchRicambi || realCore.searchRicambi;
  const normOen = deps.normOen || realOem.normOen;
  const clientIp = deps.clientIp || defaultClientIp;

  const hits = new Map();                    // ip → { windowStart, count }
  const cache = new Map();                   // normOen → { ts, ttl, data }
  const rateOk = (ip) => {
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.windowStart >= RATE_WINDOW) { hits.set(ip, { windowStart: now, count: 1 }); return true; }
    rec.count++; return rec.count <= RATE_CAP;
  };

  app.get('/api/ricambi', async (req, res) => {
    if (!rateOk(clientIp(req))) return res.status(429).json({ error: 'Troppe richieste, attendi un momento.' });
    const q = String(req.query.q || req.query.oen || '').trim();   // ?q= (nuovo) o ?oen= (retro-compat)
    const mode = ['nome', 'prodotto'].includes(req.query.mode) ? req.query.mode : 'oem';
    const veicolo = req.query.veicolo === 'moto' ? 'moto' : 'auto';
    if (!q) return res.status(400).json({ error: 'codice/nome ricambio mancante' });
    const key = mode + ':' + veicolo + ':' + (mode === 'oem' ? normOen(q) : q.toLowerCase());
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < hit.ttl) {
      cache.delete(key); cache.set(key, hit);   // LRU touch
      return res.json(hit.data);
    }
    try {
      const data = await searchRicambi(q, { mode, veicolo });
      if (cacheable(data)) {
        const ttl = data.count > 0 ? RICAMBI_TTL : RICAMBI_EMPTY_TTL;
        cache.set(key, { ts: Date.now(), ttl, data });
        if (cache.size > RICAMBI_CACHE_MAX) cache.delete(cache.keys().next().value);
      }
      res.json(data);
    } catch (e) {
      console.error('[ricambi]', e.message);
      res.status(500).json({ error: 'Errore interno durante il lookup.' });
    }
  });
}

module.exports = { mount };
