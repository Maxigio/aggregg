'use strict';
const crypto = require('node:crypto');

// Sperimentazione loopback separata dal centro: nessun JWT del browser è accettato.
// Nhost verifica password/TOTP; questo modulo registra l'esito ricevuto dal server.
function mount(app, { client, identita, origine, ora = Date.now, durataMs = 15 * 60000, cookiePath = '/api/auth',
  cleanupMs = 10000 }) {
  const express = require('express');
  const url = new URL(origine);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origine) {
    throw new Error('Login di prova soltanto su origine loopback esplicita');
  }
  if (!['/', '/api/auth'].includes(cookiePath)) throw new Error('ambito cookie del collaudo non valido');
  if (!Number.isInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 10000) throw new Error('attesa cleanup non valida');
  const sessioni = new Map(), challenge = new Map(), revoche = new Map(), tentativiAccesso = new Map();
  const esitiLogout = new Map(), cleanup = new Set();
  let chiuso = false, logoutInVolo = 0;
  let sequenzaRevoche = 0;
  const impronta = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = (req, nome) => {
    const values = (req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(nome + '='));
    if (values.length !== 1) return null;
    const value = values[0].slice(nome.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? impronta(value) : null;
  };
  const eliminaScaduti = () => {
    for (const m of [sessioni, challenge, tentativiAccesso]) for (const [k, s] of m) if (s.scadenza <= ora()) m.delete(k);
    for (const [k, s] of esitiLogout) if (s.scadenza <= ora()) { clearTimeout(s.timer); esitiLogout.delete(k); }
  };
  const timer = setInterval(eliminaScaduti, 30000); timer.unref();
  const options = { httpOnly: true, sameSite: 'strict', path: cookiePath, secure: false };
  // Il cookie di contesto non autentica: collega logout e tentativi ancora pendenti.
  function browser(req, res) {
    const esistente = cookie(req, 'amr_accesso_prova');
    if (esistente) return esistente;
    const token = crypto.randomBytes(32).toString('hex');
    res.cookie('amr_accesso_prova', token, options);
    return impronta(token);
  }
  function valido(tentativo) {
    if (chiuso || tentativiAccesso.get(tentativo.browser) !== tentativo || tentativo.scadenza <= ora()) {
      throw errore(401, 'ripeti_login');
    }
  }
  async function revocaProvider(provider, separata = false, chiamante) {
    const s = provider?.session;
    if (!s) return true;
    // Non ritirare un token ancora usato da un'altra sessione locale.
    if ((chiuso && separata) || [...sessioni.values()].some(v => v.provider.refreshToken === s.refreshToken)
        || cleanup.size >= 8 || (separata && logoutInVolo >= 4)) return false;
    let termina;
    const esito = new Promise(resolve => { termina = resolve; });
    const job = { termina, timer: setTimeout(() => termina(false), cleanupMs) };
    job.timer.unref(); cleanup.add(job);
    if (separata) logoutInVolo++;
    // Il timeout limita l'attesa, non finge di cancellare un provider iniettato.
    // Lo slot resta occupato fino al vero settlement della chiamata.
    (async () => {
      try {
        await client.logout(s);
        if (chiamante) await verifica(chiamante);
        termina(true);
      } catch { termina(false); }
      finally {
        clearTimeout(job.timer); cleanup.delete(job);
        if (separata) logoutInVolo--;
      }
    })();
    return esito;
  }
  function statoLogout(contestoBrowser, quanti) {
    // Senza una sessione nota non abbiamo prova della revoca remota.
    if (!quanti) return { risposta: { stato: 'unconfirmed', id: null }, completa() {} };
    if (chiuso || esitiLogout.size >= 100) return { risposta: { stato: 'unconfirmed', id: null }, completa() {} };
    const id = crypto.randomBytes(32).toString('hex');
    const s = { browser: contestoBrowser, stato: 'pending', restanti: quanti, fallita: false,
      scadenza: ora() + 5 * 60000 };
    s.timer = setTimeout(() => { s.stato = 'unconfirmed'; }, cleanupMs); s.timer.unref();
    esitiLogout.set(impronta(id), s);
    return { risposta: { stato: 'pending', id }, completa(ok) {
      if (s.stato !== 'pending') return;
      s.fallita ||= !ok;
      if (--s.restanti === 0) { clearTimeout(s.timer); s.stato = s.fallita ? 'unconfirmed' : 'confirmed'; }
    } };
  }
  const errore = (status, codice) => Object.assign(new Error(codice), { status, codice });
  let attive = 0, inizioFinestra = ora(), tentativi = 0;
  app.use('/api/auth', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    // Origin atteso fisso, non ricavato da Host/Forwarded del richiedente.
    if (req.headers.host !== url.host || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      return res.sendStatus(403);
    }
    if (req.method !== 'GET' && req.headers.origin !== origine) return res.sendStatus(403);
    eliminaScaduti(); next();
  }, express.json({ limit: '4kb', strict: true }));
  const path = require('node:path');
  app.get('/api/auth/pagina', (req, res) => {
    browser(req, res); res.sendFile(path.join(__dirname, 'login-nhost-prova.html'));
  });
  app.get('/api/auth/pagina.js', (req, res) => res.sendFile(path.join(__dirname, '../../frontend/nodi-login-prova.js')));
  app.get('/api/auth/pagina.css', (req, res) => res.sendFile(path.join(__dirname, '../../frontend/nodi-login-prova.css')));
  const protetta = fn => async (req, res) => {
    if (ora() - inizioFinestra >= 60000) { inizioFinestra = ora(); tentativi = 0; }
    if (attive >= 4 || tentativi >= 20) {
      res.set('Retry-After', '60'); return res.status(429).json({ codice: 'troppi_tentativi', riprovaFra: 60 });
    }
    tentativi++; attive++;
    try { await fn(req, res); }
    catch (e) {
      if (e.status === 429 && e.riprovaFra) res.set('Retry-After', String(e.riprovaFra));
      res.status(e.status || 503).json({ codice: e.codice || 'identita_non_disponibile',
        ...(e.status === 429 && e.riprovaFra ? { riprovaFra: e.riprovaFra } : {}) });
    }
    finally { attive--; }
  };
  async function creaSessione(req, res, provider, mfa, tentativo) {
    valido(tentativo);
    const s = provider?.session;
    if (!s?.user?.id || !s.user.emailVerified || typeof s.accessToken !== 'string'
        || typeof s.refreshToken !== 'string') throw errore(401, 'accesso_negato');
    // Ruolo risolto dal server sullo UUID Nhost; metadata client non sono autorità.
    if ((revoche.get(s.user.id) || 0) > tentativo.revisione) throw errore(401, 'ripeti_login');
    const ruolo = await identita(s.user.id);
    valido(tentativo);
    if ((revoche.get(s.user.id) || 0) > tentativo.revisione) throw errore(401, 'ripeti_login');
    if (!ruolo?.attiva || (ruolo.admin && !mfa)) throw errore(403, 'accesso_non_autorizzato');
    eliminaScaduti();
    const vecchia = cookie(req, 'amr_sessione_prova');
    if (sessioni.size >= 100 && !sessioni.has(vecchia)) throw errore(503, 'sessioni_non_disponibili');
    const ritirata = sessioni.get(vecchia)?.provider;
    if (vecchia) sessioni.delete(vecchia);
    const token = crypto.randomBytes(32).toString('hex');
    sessioni.set(impronta(token), { chiave: impronta(token), persona: s.user.id, mfa, provider: s,
      id: crypto.randomBytes(32).toString('hex'), creata: ora(),
      epoca: ruolo.epoca ?? 0, azienda: ruolo.azienda, scadenza: ora() + durataMs });
    res.clearCookie('amr_mfa_prova', options);
    res.cookie('amr_sessione_prova', token, { ...options, maxAge: durataMs });
    tentativo.inVolo = false;
    res.json({ ok: true });
    // Cleanup mirato dopo l'esito locale: non revocare token ancora in uso,
    // né far dipendere la rotazione dalla disponibilità del provider.
    if (ritirata) await revocaProvider({ session: ritirata });
  }
  app.post('/api/auth/login', protetta(async (req, res) => {
    if (chiuso) throw errore(503, 'identita_non_disponibile');
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || email.length > 254 || !email.includes('@')
        || typeof password !== 'string' || !password.length || password.length > 50) {
      throw errore(400, 'input_non_valido');
    }
    const precedente = cookie(req, 'amr_mfa_prova');
    const vecchio = challenge.get(precedente);
    if (vecchio && tentativiAccesso.get(vecchio.tentativo.browser) === vecchio.tentativo) {
      tentativiAccesso.delete(vecchio.tentativo.browser);
    }
    if (precedente) challenge.delete(precedente);
    const key = browser(req, res);
    if (!tentativiAccesso.has(key) && tentativiAccesso.size >= 50) throw errore(503, 'challenge_non_disponibili');
    const tentativo = { browser: key, revisione: sequenzaRevoche, scadenza: ora() + 3 * 60000, inVolo: true };
    tentativiAccesso.set(key, tentativo);
    let result, accettato = false, attendeMfa = false;
    try {
      result = await client.login(email, password);
      valido(tentativo);
      if (typeof result?.mfa?.ticket === 'string' && !result.session) {
        eliminaScaduti();
        if (challenge.size >= 50) throw errore(503, 'challenge_non_disponibili');
        const token = crypto.randomBytes(32).toString('hex');
        challenge.set(impronta(token), { ticket: result.mfa.ticket, scadenza: tentativo.scadenza,
          tentativo, usato: false });
        res.cookie('amr_mfa_prova', token, { ...options, maxAge: 3 * 60000 });
        attendeMfa = true;
        return res.json({ mfa: true });
      }
      await creaSessione(req, res, result, false, tentativo); accettato = true;
    } finally {
      tentativo.inVolo = false;
      if (!attendeMfa && tentativiAccesso.get(key) === tentativo) tentativiAccesso.delete(key);
      if (!accettato) {
        const ok = await revocaProvider(result);
        tentativo.esitoLogout?.completa(Boolean(result?.session) && ok);
      }
    }
  }));
  app.post('/api/auth/mfa', protetta(async (req, res) => {
    if (typeof req.body?.otp !== 'string' || !/^\d{6}$/.test(req.body.otp)) throw errore(400, 'input_non_valido');
    const key = cookie(req, 'amr_mfa_prova'), pending = challenge.get(key);
    if (!pending || pending.usato) throw errore(401, 'ripeti_login');
    valido(pending.tentativo);
    // Restare registrato durante l'await rende il tentativo cancellabile dal logout.
    pending.usato = true;
    pending.tentativo.inVolo = true;
    let result, accettato = false;
    try {
      result = await client.mfa(pending.ticket, req.body.otp);
      await creaSessione(req, res, result, true, pending.tentativo); accettato = true;
    } finally {
      pending.tentativo.inVolo = false;
      if (challenge.get(key) === pending) challenge.delete(key);
      if (tentativiAccesso.get(pending.tentativo.browser) === pending.tentativo) {
        tentativiAccesso.delete(pending.tentativo.browser);
      }
      if (!accettato) {
        const ok = await revocaProvider(result);
        pending.tentativo.esitoLogout?.completa(Boolean(result?.session) && ok);
      }
    }
  }));
  function sessione(req) {
    eliminaScaduti(); return sessioni.get(cookie(req, 'amr_sessione_prova')) || null;
  }
  async function verifica(s, { admin = false, tipo } = {}) {
    const key = s?.chiave;
    if (!s || sessioni.get(key) !== s || s.scadenza <= ora()) throw errore(401, 'sessione_non_valida');
    const ruolo = await identita(s.persona);
    // Una revoca durante l'attesa deve prevalere sull'esito già calcolato.
    if (sessioni.get(key) !== s || s.scadenza <= ora()) throw errore(401, 'sessione_non_valida');
    if (!ruolo?.attiva || (ruolo.admin && !s.mfa)) throw errore(403, 'accesso_non_autorizzato');
    if ((ruolo.epoca ?? 0) !== s.epoca) throw errore(403, 'sessione_revocata');
    if (admin && (!ruolo.admin || !s.mfa)) throw errore(403, 'accesso_non_autorizzato');
    if (tipo !== undefined && (!ruolo.aziendaValida || !ruolo.moduli?.includes(tipo))) {
      throw errore(403, 'modulo_non_autorizzato');
    }
    return { persona: s.persona, admin: Boolean(ruolo.admin), mfa: s.mfa,
      ...(ruolo.azienda !== undefined ? { azienda: ruolo.azienda, aziendaValida: ruolo.aziendaValida,
        moduli: ruolo.moduli || [] } : {}) };
  }
  const contesto = req => verifica(sessione(req));
  app.get('/api/auth/me', async (req, res) => {
    browser(req, res);
    try { res.json(await contesto(req)); }
    catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'identita_non_disponibile' }); }
  });
  function logout(req, res) {
    const pending = cookie(req, 'amr_mfa_prova'), p = challenge.get(pending);
    const contestoBrowser = browser(req, res);
    const cancellati = new Set([p?.tentativo, tentativiAccesso.get(contestoBrowser)].filter(t => t?.inVolo));
    if (p && tentativiAccesso.get(p.tentativo.browser) === p.tentativo) tentativiAccesso.delete(p.tentativo.browser);
    if (pending) challenge.delete(pending);
    if (contestoBrowser) tentativiAccesso.delete(contestoBrowser);
    const key = cookie(req, 'amr_sessione_prova'), s = sessioni.get(key);
    if (key) sessioni.delete(key);
    res.clearCookie('amr_sessione_prova', options); res.clearCookie('amr_mfa_prova', options);
    const esito = statoLogout(contestoBrowser, cancellati.size + Number(Boolean(s)));
    for (const t of cancellati) t.esitoLogout = esito;
    // Risposta e clear-cookie definitivi prima del provider: nessun callback
    // remoto conserva res o può toccare i cookie di un successivo login.
    res.json({ ok: true, provider: esito.risposta });
    if (s) void revocaProvider({ session: s.provider }, true).then(esito.completa);
  }
  app.post('/api/auth/logout', logout);
  // Sessioni del solo processo di prova: l'handle gestionale non autentica.
  async function sessioniPersona(s) {
    await verifica(s);
    return [...sessioni.values()]
      .filter(v => v.persona === s.persona && v.epoca === s.epoca && v.scadenza > ora())
      .map(v => ({ id: v.id, creata: v.creata, scadenza: v.scadenza, corrente: v === s }));
  }
  async function revocaSessione(s, id, req, res) {
    if (sessione(req) !== s) throw errore(401, 'sessione_non_valida');
    await verifica(s);
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) throw errore(400, 'input_non_valido');
    const target = [...sessioni.values()].find(v => v.id === id && v.persona === s.persona
      && v.epoca === s.epoca && v.scadenza > ora());
    if (!target) throw errore(404, 'sessione_non_disponibile');
    if (target === s) return logout(req, res);
    sessioni.delete(target.chiave);
    const esito = statoLogout(browser(req, res), 1);
    res.json({ ok: true, provider: esito.risposta });
    // Nessun req/res nel callback: il chiamante è ricontrollato nel job bounded.
    void revocaProvider({ session: target.provider }, true, s).then(esito.completa);
  }
  app.post('/api/auth/logout/stato', (req, res) => {
    const id = req.body?.id;
    const s = typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) ? esitiLogout.get(impronta(id)) : null;
    if (!s || s.browser !== cookie(req, 'amr_accesso_prova')) {
      return res.status(404).json({ codice: 'esito_non_disponibile' });
    }
    res.json({ provider: { stato: s.stato, id } });
  });
  app.use('/api/auth', (err, req, res, next) => {
    res.status(err.status === 413 ? 413 : 400).json({ codice: 'input_non_valido' });
  });
  const accessi = { contesto, sessione, verifica, sessioniPersona, revocaSessione, revocaPersona: persona => {
    revoche.set(persona, ++sequenzaRevoche);
    for (const [k, s] of sessioni) if (s.persona === persona) sessioni.delete(k);
  }, close: () => {
    chiuso = true; clearInterval(timer);
    for (const s of esitiLogout.values()) clearTimeout(s.timer);
    esitiLogout.clear();
    for (const job of cleanup) { clearTimeout(job.timer); job.termina(false); }
    sessioni.clear(); challenge.clear(); revoche.clear(); tentativiAccesso.clear();
  } };
  require('./sessioni-prova-route').mount(app, { accessi, ora });
  return accessi;
}
module.exports = { mount };
