'use strict';

// Il mount non avvia worker né accede allo storage.
function mount(app, { backup, accessi, origine, proxyAttendibili, trasporto, segnalaOperazione = () => {} }) {
  const express = require('express');
  const policy = require('./trasporto-prova').trasportoPerRotta({ origine, proxyAttendibili, trasporto });
  origine = policy.origine;
  let attive = 0;
  app.use('/api/auth/backup', policy.middleware, express.json({ limit: '1kb', strict: true }));
  const protetta = fn => async (req, res) => {
    if (attive >= 4) return res.status(429).json({ codice: 'troppi_tentativi' });
    attive++;
    try {
      const s = accessi.sessione(req);
      await accessi.verifica(s, { admin: true });
      const out = await fn({ persona: s.persona, epoca: s.epoca, mfa: s.mfa },req);
      // Rivalida dopo la lettura: revoca/logout mentre il DB risponde.
      await accessi.verifica(s, { admin: true });
      res.json(out);
    } catch (e) {
      const codice = ['input_non_valido','sessione_non_valida','accesso_non_autorizzato','sessione_revocata'].includes(e?.codice)
        ? e.codice : 'backup_non_disponibile';
      res.status(codice === 'input_non_valido' ? 400 : codice === 'sessione_non_valida' ? 401 : codice === 'backup_non_disponibile' ? 503 : 403)
        .json({ codice, avviso: true });
    } finally { attive--; }
  };
  app.get('/api/auth/backup/stato', protetta(s => backup.stato(s)));
  app.post('/api/auth/backup/riprova', protetta(async (s,req) => {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) {
      throw Object.assign(new Error('input_non_valido'),{codice:'input_non_valido'});
    }
    const out = await backup.riprova(s);
    segnalaOperazione();
    return out;
  }));
  app.use('/api/auth/backup', (err,req,res,next) => res.status(err.status === 413 ? 413 : 400).json({ codice:'input_non_valido' }));
}
module.exports = { mount };
