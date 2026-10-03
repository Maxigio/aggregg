'use strict';
const path = require('node:path');
const BASE = '/api/auth/colleghi';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const errore = (codice, status = 400) => Object.assign(new Error(codice), { codice, status });

// Da montare nel processo esistente dopo login e prima dell'error handler globale.
// Non apre listener, non sostituisce login o gestione delle proprie sessioni.
function mount(app, { account, accessi, client, origine, proxyAttendibili, trasporto, ora = Date.now }) {
  const express = require('express');
  const policy = require('./trasporto-prova').trasportoPerRotta({ origine, proxyAttendibili, trasporto });
  origine = policy.origine;
  const consegne = new Map();
  let chiuso = false;
  const pulisci = () => { for (const [k,v] of consegne) if (v.fino <= ora()) consegne.delete(k); };
  const timer = setInterval(pulisci, 30000); timer.unref();
  app.use(BASE, policy.middleware, (req,res,next) => {
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    if (chiuso) return res.status(503).json({ codice:'operazione_non_disponibile' });

    next();
  }, express.json({ limit:'4kb', strict:true }));
  const protetta = require('./limiti-gestione').creaLimitiGestione({ accessi, ora });
  async function gestore(req, soloAdmin = false) {
    const s = accessi.sessione(req);
    const c = await accessi.verifica(s, soloAdmin ? {admin:true} : {});
    // Tenant del referente derivato dal contesto corrente verificato server-side.
    // Admin può scegliere azienda; SQL verifica sempre anche referente/epoca/MFA.
    if (!c.admin && req.body?.id !== c.azienda) throw errore('accesso_non_autorizzato',403);
    return {persona:s.persona,epoca:s.epoca,mfa:s.mfa};
  }
  const password = body => {
    if (typeof body?.password !== 'string' || body.password.length < 15 || body.password.length > 50
      || Buffer.byteLength(body.password) > 72 || /[\r\n\0]/.test(body.password)) throw errore('input_non_valido');
  };
  const richiesta = body => ({id:body?.id,operazione:body?.operazione});
  const datiInvito = async body => {
    const i = await account.invito(body?.token);
    if (i.stato !== 'pending') throw errore('invito_non_valido',403);
    return i;
  };
  app.get(BASE+'/pagina', (req,res) => res.sendFile(path.join(__dirname,'colleghi-prova.html')));
  app.get(BASE+'/pagina.js', (req,res) => res.sendFile(path.join(__dirname,'../../frontend/nodi-colleghi-prova.js')));
  app.post(BASE+'/elenco', protetta(async(req,res) => {
    const s = await gestore(req);
    res.json(await account.elenco(s,{id:req.body?.id}));
  }, { lettura: true }));
  app.post(BASE+'/operazione', protetta(async(req,res) => {
    res.json(await account.statoOperazione(await gestore(req),richiesta(req.body)));
  }, { lettura: true }));
  app.post(BASE+'/invita', protetta(async(req,res) => {
    const s = await gestore(req); pulisci();
    const out = await account.invita(s,{...richiesta(req.body),email:req.body?.email});
    if (!chiuso && out.token) consegne.set(out.operazione, {token:out.token,invito:out.invito,
      azienda:out.id,attore:s.persona,fino:ora()+7*86400000});
    const copia = consegne.get(out.operazione);
    // La RAM non autorizza: il DB ricontrolla il pending anche sul retry.
    const link = !chiuso && out.tokenDisponibile && copia?.attore === s.persona
      && copia.azienda === out.id ? origine+BASE+'/pagina#'+copia.token : undefined;
    res.json({...out,token:undefined,consegna:'locale_non_inviata',...(link ? {link} : {})});
  }));
  app.post(BASE+'/revoca', protetta(async(req,res) => {
    const out = await account.revoca(await gestore(req),{...richiesta(req.body),persona:req.body?.persona});
    // La revoca persistente via epoca è già confermata; non riscrivere sessioni qui.
    res.json(out);
  }));
  app.post(BASE+'/revoca-invito', protetta(async(req,res) => {
    const out = await account.revocaInvito(await gestore(req),{...richiesta(req.body),invito:req.body?.invito});
    for (const [k,v] of consegne) if (v.invito === out.invito) consegne.delete(k);
    res.json(out);
  }));
  app.post(BASE+'/referente', protetta(async(req,res) => {
    res.json(await account.cambiaReferente(await gestore(req,true),{...richiesta(req.body),persona:req.body?.persona}));
  }));
  app.post(BASE+'/invito', protetta(async(req,res) => { res.json(await datiInvito(req.body)); }, { pubblica: true }));
  app.post(BASE+'/registra', protetta(async(req,res) => {
    password(req.body);
    const i = await datiInvito(req.body);
    await client.registra(i.email,req.body.password,origine+BASE+'/pagina');
    res.json({ok:true,verificaEmail:true});
  }, { pubblica: true }));
  app.post(BASE+'/verifica', protetta(async(req,res) => {
    const i = await datiInvito(req.body);
    await client.reinviaVerifica(i.email,origine+BASE+'/pagina');
    res.json({ok:true});
  }, { pubblica: true }));
  app.post(BASE+'/accetta', protetta(async(req,res) => {
    password(req.body);
    if (typeof req.body.operazione !== 'string' || !UUID.test(req.body.operazione)) throw errore('input_non_valido');
    const i = await account.invito(req.body.token);
    const p = await client.login(i.email,req.body.password);
    try {
      if (p?.mfa) throw errore('accettazione_mfa_non_disponibile',409);
      if (!p?.session?.user?.emailVerified || !UUID.test(p.session.user.id || '')) throw errore('identita_non_verificata',403);
      res.json(await account.accetta(p.session.user.id,{token:req.body.token,operazione:req.body.operazione}));
    } finally { if (p?.session) await client.logout(p.session).catch(()=>{}); }
  }, { pubblica: true }));
  app.use(BASE,(err,req,res,next) => res.status(err.status===413 ? 413 : 400).json({codice:'input_non_valido'}));
  return {close() { chiuso=true; clearInterval(timer); consegne.clear(); }};
}
module.exports = { mount };
