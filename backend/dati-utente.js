/**
 * Preferenze personali che cambiano i numeri mostrati e stampati.
 *
 * Annunci, ricambi e ricerche provengono dai portali e non vengono conservati. Tema e vista
 * restano invece nel singolo browser; queste preferenze seguono l'account per evitare che due
 * dispositivi calcolino prezzi diversi per lo stesso veicolo.
 */
const dbmod = require('./utenti-db');

const PREFERENZE = new Set(['amr_price_v', 'amrCarbProvincia', 'amrCarbKm', 'amrPassProvincia']);
const MAX_VALORE = 4096;

function chi(utente) {
  const u = String(utente == null ? '' : utente).trim();
  if (!u) throw new Error('dati-utente: manca l\'utente — ogni riga ha un padrone.');
  return u;
}

function apriPerScrivere() {
  const d = dbmod.apri();
  if (!d) {
    const e = new Error(`i tuoi dati non sono raggiungibili (${dbmod.guasto() || dbmod.stato()})`);
    e.code = 'DATI_NON_DISPONIBILI';
    throw e;
  }
  return d;
}

function leggiPreferenze(utente) {
  const u = chi(utente);
  const d = dbmod.apri();
  if (!d) return {};
  const out = {};
  for (const r of d.prepare('SELECT chiave, valore FROM preferenze WHERE utente=?').all(u)) {
    if (PREFERENZE.has(r.chiave)) out[r.chiave] = r.valore;
  }
  return out;
}

function scriviPreferenza(utente, chiave, valore) {
  const u = chi(utente);
  if (!PREFERENZE.has(chiave)) {
    const e = new Error(`preferenza sconosciuta: ${chiave}`);
    e.code = 'PREFERENZA_SCONOSCIUTA';
    throw e;
  }
  const v = String(valore == null ? '' : valore);
  if (v.length > MAX_VALORE) {
    const e = new Error('valore troppo lungo');
    e.code = 'TROPPO_GRANDE';
    throw e;
  }
  apriPerScrivere().prepare(
    'INSERT INTO preferenze (utente, chiave, valore) VALUES (?,?,?)'
    + ' ON CONFLICT(utente, chiave) DO UPDATE SET valore=excluded.valore'
  ).run(u, chiave, v);
  return true;
}

function tutto(utente) {
  return {
    preferenze: leggiPreferenze(utente),
    guasto: dbmod.stato() === 'ok' ? null : (dbmod.guasto() || dbmod.stato()),
  };
}

const limite = require('./limite-richieste').crea({
  max: 120, finestra: 5 * 60 * 1000, cosa: 'richieste alle tue preferenze',
});

function mount(app, deps = {}) {
  const json = deps.json;
  const utenteDi = deps.utenteDi || (req => req.authId || 'owner');
  const chiaveLimite = deps.chiaveLimite || (req => req.ip || '');
  const male = (res, e) => res.status(e && e.code === 'DATI_NON_DISPONIBILI' ? 503 : 400)
    .json({ error: e.message, code: (e && e.code) || null });

  function freno(req, res, next) {
    const g = limite.consuma(chiaveLimite(req));
    if (g.ok) return next();
    res.status(429).set('Cache-Control', 'no-store')
      .json({ ok: false, error: limite.messaggio(g), riprovaFra: g.attesa, restanti: 0 });
  }

  app.get('/api/miei', freno, (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(tutto(utenteDi(req))); }
    catch (e) { male(res, e); }
  });

  app.put('/api/miei/preferenze/:chiave', freno, json, (req, res) => {
    try {
      scriviPreferenza(utenteDi(req), req.params.chiave, req.body && req.body.valore);
      res.json({ ok: true });
    } catch (e) { male(res, e); }
  });
}

module.exports = { mount, tutto, leggiPreferenze, scriviPreferenza, PREFERENZE };
