'use strict';

// Montato dal login: stessa policy esplicita di trasporto e parser JSON.
// Solo sessioni AMR in RAM di questo processo; nessun elenco sessioni Nhost.
function mount(app, { accessi, trasporto, ora = Date.now }) {
  const policy = require('./trasporto-prova').creaTrasporto(trasporto);
  app.use('/api/auth/sessioni', policy.middleware);
  const protetta = require('./limiti-gestione').creaLimitiGestione({ accessi, ora });
  app.get('/api/auth/sessioni', protetta(async (req, res) => {
    res.json({ sessioni: await accessi.sessioniPersona(accessi.sessione(req)) });
  }, { lettura: true }));
  app.post('/api/auth/sessioni/revoca', protetta(async (req, res) => {
    await accessi.revocaSessione(accessi.sessione(req), req.body?.id, req, res);
  }));
}

module.exports = { mount };
