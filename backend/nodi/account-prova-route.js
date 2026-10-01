'use strict';

// Rotte esclusivamente del collaudo loopback; non costituiscono il login commerciale.
function mount(app, { account, sessione, listaSessioni, revocaSessione }) {
  const express = require('express');
  app.use('/api/test/account', express.json({ limit: '4kb' }), (req, res, next) => {
    const s = sessione(req);
    if (!s?.identita) return res.sendStatus(401);
    req.identitaProva = s.identita;
    req.sessioneAccountProva = s;
    next();
  });
  app.get('/api/test/account/sessioni', (req, res) => {
    try {
      account.verificaIdentita(req.identitaProva);
      res.json({ sessioni: listaSessioni(req.identitaProva.persona) });
    } catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' }); }
  });
  app.post('/api/test/account/revocaSessione', (req, res) => {
    try {
      account.verificaIdentita(req.identitaProva);
      if (typeof req.body?.id !== 'string') return res.sendStatus(400);
      const ok = revocaSessione(req.identitaProva.persona, req.body.id);
      res.status(ok ? 200 : 404).json({ ok });
    } catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' }); }
  });
  for (const metodo of ['creaAzienda', 'configuraAzienda', 'invita', 'accetta', 'revoca',
    'revocaInvito', 'cambiaReferente']) {
    app.post('/api/test/account/' + metodo, (req, res) => {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
          return res.status(400).json({ codice: 'input_non_valido' });
        }
        const risultato = account[metodo](req.identitaProva, req.body);
        if (metodo === 'accetta') {
          req.sessioneAccountProva.azienda = risultato.azienda;
          req.sessioneAccountProva.annunci.clear();
        }
        res.json(risultato);
      } catch (e) {
        res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' });
      }
    });
  }
}

module.exports = { mount };
