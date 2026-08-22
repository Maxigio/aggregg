/**
 * LE COSE DI CIASCUNO: annunci salvati, ricambi salvati, codici preferiti, impostazioni prezzo.
 *
 * Fin qui vivevano nel `localStorage` del browser, cioe' PER DISPOSITIVO: papa' salvava un
 * annuncio dall'iMac e dal telefono non c'era, e chi cambiava computer ripartiva da zero. Con le
 * persone che si registrano il posto giusto e' il magazzino, dove ogni riga porta scritto di chi
 * e' — e da qualsiasi dispositivo si ritrova la stessa roba.
 *
 * IL BROWSER RESTA LA COPIA VELOCE. Non si toglie il localStorage: resta come cache e come rete
 * di sicurezza mentre il server non risponde. Il server e' la verita', il browser e' comodo.
 *
 * PERCHE' L'ELENCO INTERO E NON LA SINGOLA VOCE. Lo schermo tiene questi dati come array in
 * memoria e li riscrive interi a ogni gesto (era gia' cosi' col localStorage): mandare l'elenco
 * intero e' la stessa cosa che fa gia', e l'ordine — che conta, i preferiti si mettono in cima —
 * arriva senza doverlo ricostruire. Gli elenchi hanno un tetto, quindi il pacchetto ha un tetto.
 */
const dbmod = require('./utenti-db');

// I generi e quanto ne entra. Sono gli stessi tetti che ha lo schermo: se li' ne stanno 200 e
// qui 1000, la differenza si scopre il giorno che qualcuno perde qualcosa.
const GENERI = {
  annuncio: { cap: 200 },
  ricambio: { cap: 200 },
  oem:      { cap: 30 },
};

/**
 * Le impostazioni che seguono la PERSONA, non il dispositivo: sono quelle che cambiano i NUMERI
 * (il prezzo che il cliente vede stampato sul PDF), e ritrovarne di diverse su un altro computer
 * vuol dire mostrare due preventivi diversi per lo stesso mezzo. Tema, vista ed elenco aperto
 * restano dove sono: sono di quel browser, e va bene cosi'.
 */
const PREFERENZE = new Set(['amr_price_v', 'amr_price_r', 'amrCarbProvincia', 'amrCarbKm', 'amrPassProvincia']);

const MAX_VALORE = 4096;         // una preferenza e' una manciata di numeri, non un documento
const MAX_ELENCO = 1024 * 1024;  // un elenco al massimo del suo tetto, con margine

function chi(utente) {
  const u = String(utente == null ? '' : utente).trim();
  if (!u) throw new Error('dati-utente: manca l\'utente — ogni riga ha un padrone.');
  return u;
}

/** Come in saved.js: leggere non lancia (si torna il vuoto), scrivere si'. */
function apriPerScrivere() {
  const d = dbmod.apri();
  if (!d) {
    const e = new Error(`i tuoi dati non sono raggiungibili (${dbmod.guasto() || dbmod.stato()})`);
    e.code = 'DATI_NON_DISPONIBILI';
    throw e;
  }
  return d;
}

/**
 * L'elenco di un genere. Sta in UNA riga (chiave vuota) perche' e' un elenco ORDINATO e lo
 * schermo lo tratta come tale: spezzarlo in una riga per voce vorrebbe dire inventare una
 * colonna d'ordine e ricomporlo a ogni lettura, per un dato che non si interroga mai per pezzi.
 */
function leggiElenco(utente, genere) {
  const u = chi(utente);
  if (!GENERI[genere]) throw new Error(`genere sconosciuto: ${genere}`);
  const d = dbmod.apri();
  if (!d) return [];
  const r = d.prepare('SELECT dati FROM salvataggi WHERE utente=? AND genere=? AND chiave=?').get(u, genere, '');
  if (!r) return [];
  try {
    const a = JSON.parse(r.dati);
    return Array.isArray(a) ? a : [];
  } catch (e) {
    console.error(`[miei] l'elenco "${genere}" di ${u} non si rilegge (${e.message}).`);
    return [];
  }
}

function scriviElenco(utente, genere, elenco) {
  const u = chi(utente);
  const g = GENERI[genere];
  if (!g) throw new Error(`genere sconosciuto: ${genere}`);
  if (!Array.isArray(elenco)) throw new Error('serve un elenco');
  const tagliato = elenco.slice(0, g.cap);
  const dati = JSON.stringify(tagliato);
  if (dati.length > MAX_ELENCO) {
    const e = new Error('elenco troppo grande');
    e.code = 'TROPPO_GRANDE';
    throw e;
  }
  apriPerScrivere().prepare(
    'INSERT INTO salvataggi (utente, genere, chiave, dati, creato_il) VALUES (?,?,?,?,?)'
    + ' ON CONFLICT(utente, genere, chiave) DO UPDATE SET dati=excluded.dati'
  ).run(u, genere, '', dati, Date.now());
  return tagliato.length;
}

function leggiPreferenze(utente) {
  const u = chi(utente);
  const d = dbmod.apri();
  if (!d) return {};
  const out = {};
  for (const r of d.prepare('SELECT chiave, valore FROM preferenze WHERE utente=?').all(u)) {
    if (!PREFERENZE.has(r.chiave)) continue;   // una chiave tolta dall'elenco non torna in vita
    out[r.chiave] = r.valore;
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

/** Tutto quello che e' suo, in un colpo solo: e' cio' che lo schermo chiede all'apertura. */
function tutto(utente) {
  const salvataggi = {};
  for (const g of Object.keys(GENERI)) salvataggi[g] = leggiElenco(utente, g);
  return {
    salvataggi,
    preferenze: leggiPreferenze(utente),
    // Se il magazzino non si apre, l'elenco vuoto NON e' una notizia sui dati: e' un guasto, e
    // va detto — senno' lo schermo scrive "non hai niente salvato" a chi ha salvato tutto.
    guasto: dbmod.stato() === 'ok' ? null : (dbmod.guasto() || dbmod.stato()),
  };
}

function mount(app, deps = {}) {
  const json = deps.json;
  const utenteDi = deps.utenteDi || (req => req.authId || 'owner');
  const male = (res, e) => res.status(e && e.code === 'DATI_NON_DISPONIBILI' ? 503 : 400)
    .json({ error: e.message, code: (e && e.code) || null });

  app.get('/api/miei', (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(tutto(utenteDi(req))); }
    catch (e) { male(res, e); }
  });

  app.put('/api/miei/elenco/:genere', json, (req, res) => {
    try {
      // Niente `|| []`: trasformava un campo MANCANTE in un elenco vuoto volontario, e un corpo
      // senza `elenco` azzerava i salvataggi rispondendo 200. La guardia Array.isArray di
      // scriviElenco esiste apposta: si lascia parlare. Chi vuole svuotare manda {"elenco": []}.
      const n = scriviElenco(utenteDi(req), req.params.genere, req.body && req.body.elenco);
      res.json({ ok: true, tenuti: n });
    } catch (e) { male(res, e); }
  });

  app.put('/api/miei/preferenze/:chiave', json, (req, res) => {
    try {
      scriviPreferenza(utenteDi(req), req.params.chiave, req.body && req.body.valore);
      res.json({ ok: true });
    } catch (e) { male(res, e); }
  });
}

module.exports = {
  mount, tutto, leggiElenco, scriviElenco, leggiPreferenze, scriviPreferenza,
  GENERI, PREFERENZE,
};
