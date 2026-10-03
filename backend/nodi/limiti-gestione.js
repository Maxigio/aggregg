'use strict';

// Il cookie viene risolto dal provider locale; body, email e IP non sono chiavi.
// Un posto dei quattro resta disponibile alle mutazioni anche sotto polling pubblico.
function creaLimitiGestione({ accessi, ora = Date.now, codiceErrore = 'operazione_non_disponibile' }) {
  const conti = new Map();
  let attive = 0, lettureAttive = 0;
  return (fn, { pubblica = false, lettura = false } = {}) => async (req, res) => {
    const s = pubblica ? null : accessi.sessione(req);
    if (!pubblica && !s) return res.status(401).json({ codice: 'sessione_non_valida' });
    const adesso = ora();
    for (const [k, v] of conti) if (adesso - v.inizio >= 60000) conti.delete(k);
    const chiave = pubblica ? 'pubblica' : JSON.stringify([s.persona, lettura ? 'lettura' : 'mutazione']);
    const conto = conti.get(chiave);
    const nonMutazione = pubblica || lettura;
    if (attive >= 4 || (nonMutazione && lettureAttive >= 3) || conto?.n >= 30
        || (!conto && conti.size >= 201)) {
      return res.status(429).set('Retry-After', '60').json({ codice: 'troppi_tentativi' });
    }
    conti.set(chiave, { inizio: conto?.inizio ?? adesso, n: (conto?.n ?? 0) + 1 });
    attive++; if (nonMutazione) lettureAttive++;
    try { await fn(req, res); }
    catch (e) {
      res.status(Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 503)
        .json({ codice: typeof e.codice === 'string' ? e.codice : codiceErrore });
    } finally { attive--; if (nonMutazione) lettureAttive--; }
  };
}
module.exports = { creaLimitiGestione };
