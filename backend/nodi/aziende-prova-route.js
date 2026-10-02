'use strict';
const crypto = require('node:crypto');
const path = require('node:path');

// Solo il collaudo loopback: nessun invio SMTP esterno o backup dichiarato riuscito.
function mount(app, { account, accessi, client, origine, ora = () => Date.now() }) {
  const express = require('express');
  const url = new URL(origine);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origine) {
    throw new Error('aziende del collaudo solo su loopback');
  }
  const consegne = new Map();
  let attive = 0, tentativi = 0, finestra = ora();
  app.use('/api/auth/aziende', (req, res, next) => {
    res.set('Referrer-Policy', 'no-referrer');
    if (req.headers.host !== url.host || !['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.sendStatus(403);
    if (req.method !== 'GET' && req.headers.origin !== origine) return res.sendStatus(403);
    next();
  }, express.json({ limit: '4kb', strict: true }));
  const protetta = fn => async (req, res) => {
    if (ora() - finestra >= 60000) { finestra = ora(); tentativi = 0; }
    if (attive >= 4 || tentativi >= 30) return res.status(429).set('Retry-After','60').json({ codice:'troppi_tentativi' });
    attive++; tentativi++;
    try { await fn(req,res); }
    catch(e) { res.status(e.status || 503).json({ codice: e.codice || 'operazione_non_disponibile' }); }
    finally { attive--; }
  };
  const errore = () => Object.assign(new Error('input_non_valido'),{status:400,codice:'input_non_valido'});
  const credenziali = body => {
    if (typeof body?.password !== 'string' || body.password.length < 15 || body.password.length > 50
        || Buffer.byteLength(body.password) > 72 || /[\r\n\0]/.test(body.password)) throw errore();
  };
  const admin = async req => {
    const s = accessi.sessione(req);
    await accessi.verifica(s, {admin:true});
    return { persona:s.persona, epoca:s.epoca, mfa:s.mfa };
  };
  app.get('/api/auth/aziende/pagina', (req,res) => res.sendFile(path.join(__dirname,'aziende-prova.html')));
  app.get('/api/auth/aziende/pagina.js', (req,res) => res.sendFile(path.join(__dirname,'../../frontend/nodi-aziende-prova.js')));
  app.get('/api/auth/aziende/elenco', protetta(async(req,res) => res.json(await account.elenco(await admin(req)))));
  app.post('/api/auth/aziende/invita', protetta(async(req,res) => {
    const s = await admin(req);
    // Le copie di consegna sono solo RAM e hanno la medesima scadenza dell'invito.
    for(const [k,v] of consegne) if(v.fino <= Date.now()) consegne.delete(k);
    const out = await account.invita(s,req.body);
    if(out.token) consegne.set(req.body.operazione,{token:out.token,fino:Date.now()+7*86400000});
    const copia = consegne.get(req.body.operazione);
    res.json({ ...out, token:undefined, consegna:'locale_non_inviata',
      ...(copia ? { link:origine+'/api/auth/aziende/pagina#'+copia.token } : {}) });
  }));
  app.post('/api/auth/aziende/attiva', protetta(async(req,res) => res.json(await account.attiva(await admin(req),req.body))));
  app.post('/api/auth/aziende/rinnova', protetta(async(req,res) => res.json(await account.rinnova(await admin(req),req.body))));
  app.post('/api/auth/aziende/revoca', protetta(async(req,res) => res.json(await account.revocaAzienda(await admin(req),req.body))));
  app.post('/api/auth/aziende/operazione', protetta(async(req,res) => res.json(await account.statoOperazione(await admin(req),req.body))));
  app.post('/api/auth/aziende/invito', protetta(async(req,res) => {
    const i = await account.invito(req.body?.token);
    res.json(i);
  }));
  app.post('/api/auth/aziende/registra', protetta(async(req,res) => {
    credenziali(req.body);
    const i = await account.invito(req.body?.token);
    await client.registra(i.email,req.body.password,origine+'/api/auth/aziende/pagina');
    res.json({ok:true,verificaEmail:true});
  }));
  app.post('/api/auth/aziende/accetta', protetta(async(req,res) => {
    credenziali(req.body);
    const i = await account.invito(req.body?.token);
    const p = await client.login(i.email,req.body.password);
    try {
      if (p?.mfa) throw Object.assign(new Error('accettazione_mfa_non_disponibile'),{
        status:409,codice:'accettazione_mfa_non_disponibile'});
      if (!p?.session?.user?.emailVerified || !p.session.user.id) {
        throw Object.assign(new Error('identita_non_verificata'),{status:403,codice:'identita_non_verificata'});
      }
      res.json(await account.accetta(p.session.user.id,req.body.token));
    } finally { if(p?.session) await client.logout(p.session).catch(()=>{}); }
  }));
  app.post('/api/auth/aziende/verifica', protetta(async(req,res) => {
    const i = await account.invito(req.body?.token);
    await client.reinviaVerifica(i.email,origine+'/api/auth/aziende/pagina');
    res.json({ok:true});
  }));
  app.use('/api/auth/aziende',(err,req,res,next)=>res.status(err.status===413?413:400).json({codice:'input_non_valido'}));
  return { close:()=>consegne.clear() };
}
module.exports={mount};
