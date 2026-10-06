'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Il mount non attiva invio SMTP o storage esterno.
function mount(app, { account, accessi, client, origine, proxyAttendibili, trasporto, ora = () => Date.now() }) {
  const express = require('express');
  const policy = require('./trasporto-prova').trasportoPerRotta({ origine, proxyAttendibili, trasporto });
  origine = policy.origine;
  const consegne = new Map();
  app.use('/api/auth/aziende', policy.middleware, express.json({ limit: '4kb', strict: true }));
  const protetta = require('./limiti-gestione').creaLimitiGestione({ accessi, ora });
  const errore = () => Object.assign(new Error('input_non_valido'),{status:400,codice:'input_non_valido'});
  const credenziali = body => {
    if (typeof body?.password !== 'string' || body.password.length < 15 || body.password.length > 50
        || Buffer.byteLength(body.password) > 72 || /[\r\n\0]/.test(body.password)) throw errore();
  };
  const pending = async token => {
    const i = await account.invito(token);
    if (i.stato === 'accettato') throw Object.assign(new Error('invito_non_valido'),{status:403,codice:'invito_non_valido'});
    return i;
  };
  const admin = async req => {
    const s = accessi.sessione(req);
    await accessi.verifica(s, {admin:true});
    return { persona:s.persona, epoca:s.epoca, mfa:s.mfa };
  };
  app.get('/api/auth/aziende/pagina', (req,res) => res.sendFile(path.join(__dirname,'aziende-prova.html')));
  app.get('/api/auth/aziende/pagina.js', (req,res) => res.sendFile(path.join(__dirname,'../../frontend/nodi-aziende-prova.js')));
  app.get('/api/auth/aziende/elenco', protetta(async(req,res) => { res.json(await account.elenco(await admin(req))); }, { lettura: true }));
  app.post('/api/auth/aziende/invita', protetta(async(req,res) => {
    const s = await admin(req);
    // Le copie di consegna sono solo RAM e hanno la medesima scadenza dell'invito.
    for(const [k,v] of consegne) if(v.fino <= ora()) consegne.delete(k);
    const out = await account.invita(s,req.body);
    if(out.token) consegne.set(out.operazione,{token:out.token,azienda:out.id,attore:s.persona,fino:ora()+7*86400000});
    if (!out.tokenDisponibile) consegne.delete(out.operazione);
    const copia = consegne.get(out.operazione);
    res.json({ ...out, token:undefined, consegna:'locale_non_inviata',
      ...(out.tokenDisponibile && copia?.azienda === out.id && copia.attore === s.persona
        ? { link:origine+'/api/auth/aziende/pagina#'+copia.token } : {}) });
  }));
  app.post('/api/auth/aziende/attiva', protetta(async(req,res) => res.json(await account.attiva(await admin(req),req.body))));
  app.post('/api/auth/aziende/rinnova', protetta(async(req,res) => res.json(await account.rinnova(await admin(req),req.body))));
  app.post('/api/auth/aziende/revoca', protetta(async(req,res) => res.json(await account.revocaAzienda(await admin(req),req.body))));
  app.post('/api/auth/aziende/operazione', protetta(async(req,res) => { res.json(await account.statoOperazione(await admin(req),req.body)); }, { lettura: true }));
  app.post('/api/auth/aziende/invito', protetta(async(req,res) => {
    const i = await account.invito(req.body?.token);
    res.json(i);
  }, { pubblica: true }));
  app.post('/api/auth/aziende/registra', protetta(async(req,res) => {
    credenziali(req.body);
    const i = await pending(req.body?.token);
    await client.registra(i.email,req.body.password,origine+'/api/auth/aziende/pagina');
    res.json({ok:true,verificaEmail:true});
  }, { pubblica: true }));
  app.post('/api/auth/aziende/accetta', protetta(async(req,res) => {
    credenziali(req.body);
    if (typeof req.body.operazione !== 'string' || !UUID.test(req.body.operazione)) throw errore();
    const i = await account.invito(req.body?.token);
    const p = await client.login(i.email,req.body.password);
    try {
      if (p?.mfa) throw Object.assign(new Error('accettazione_mfa_non_disponibile'),{
        status:409,codice:'accettazione_mfa_non_disponibile'});
      if (!p?.session?.user?.emailVerified || !UUID.test(p.session.user.id || '')) {
        throw Object.assign(new Error('identita_non_verificata'),{status:403,codice:'identita_non_verificata'});
      }
      res.json(await account.accetta(p.session.user.id,req.body.token,req.body.operazione));
    } finally { if(p?.session) await client.logout(p.session).catch(()=>{}); }
  }, { pubblica: true }));
  app.post('/api/auth/aziende/verifica', protetta(async(req,res) => {
    const i = await pending(req.body?.token);
    await client.reinviaVerifica(i.email,origine+'/api/auth/aziende/pagina');
    res.json({ok:true});
  }, { pubblica: true }));
  app.use('/api/auth/aziende',(err,req,res,next)=>res.status(err.status===413?413:400).json({codice:'input_non_valido'}));
  return { close:()=>consegne.clear() };
}
module.exports={mount};
