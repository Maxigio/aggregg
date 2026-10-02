'use strict';

// Montato dal login di prova, dopo i suoi controlli loopback/Origin e JSON.
// Solo sessioni AMR in RAM di questo processo; nessun elenco sessioni Nhost.
function mount(app, { accessi, ora = Date.now }) {
  let attive = 0, tentativi = 0, finestra = ora();
  const protetta = fn => async (req, res) => {
    if (ora() - finestra >= 60000) { finestra = ora(); tentativi = 0; }
    if (attive >= 4 || tentativi >= 30) {
      return res.status(429).set('Retry-After', '60').json({ codice: 'troppi_tentativi' });
    }
    attive++; tentativi++;
    try { await fn(req, res); }
    catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'identita_non_disponibile' }); }
    finally { attive--; }
  };
  app.get('/api/auth/sessioni', protetta(async (req, res) => {
    res.json({ sessioni: await accessi.sessioniPersona(accessi.sessione(req)) });
  }));
  app.post('/api/auth/sessioni/revoca', protetta(async (req, res) => {
    await accessi.revocaSessione(accessi.sessione(req), req.body?.id, req, res);
  }));
}

module.exports = { mount };
