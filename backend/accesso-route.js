'use strict';

const express = require('express');
const path = require('path');
const auth = require('./auth');
const utentiDb = require('./utenti-db');

function mount(app, { logger }) {
  // ─── Auth (attiva SOLO se è stata impostata una password) ────────────────────
  // Quando attiva, protegge TUTTE le rotte: niente scorciatoia loopback (Funnel
  // proxa a 127.0.0.1 → indistinguibile dal desktop). L'Electron locale fa login
  // una volta e tiene il cookie. Disattiva = comportamento locale di prima.
  const loginAttempts = new Map();   // ip → { fails, until, last }
  const LOCK_MAX = 8;
  const LOCK_MS  = 10 * 60 * 1000;
  // I fallimenti DECADONO: passata mezz'ora senza errori si riparte da zero. Senza, il contatore
  // lo azzerava solo un login riuscito, e otto errori sommati da piu' persone dietro lo stesso IP
  // pubblico (il Funnel) le bloccavano tutte a oltranza.
  const LOCK_DECAY_MS = 30 * 60 * 1000;
  // Le porte che si devono poter bussare SENZA una sessione. Le tre della registrazione ci stanno
  // per definizione: chi chiede un account, e chi apre un invito per scegliersi la password, una
  // sessione non ce l'ha ancora — e `/api/invito` e' l'unica rotta non autenticata di tutta l'app
  // che SCRIVE una credenziale, quindi ogni riga che ci si aggiunge dentro va pesata.
  const AUTH_FREE = new Set(['/login', '/logout', '/api/public-url', '/api/health',
    '/api/registrazione', '/invito', '/api/invito', '/api/invito/chi']);

  function parseCookies(req) {
    const out = {};
    const h = req.headers.cookie;
    if (!h) return out;
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const k = part.slice(0, i).trim();
      const v = part.slice(i + 1).trim();
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }   // cookie malformato → non crashare (500 a ogni richiesta)
    }
    return out;
  }

  const MSG_AUTH_ROTTA = 'Configurazione di accesso illeggibile: nessuno puo\' entrare finche\' auth.json non viene riparato.';

  /**
   * IL PERCORSO SU CUI SI DECIDE — minuscole e senza slash finale, calcolato UNA volta in cima.
   *
   * Express instrada senza distinguere le maiuscole (`case sensitive routing` non e' impostato),
   * mentre i confronti del gate sono esatti. Anche `AUTH_FREE.has(req.path)` e' esatto: `/invito/`
   * — lo slash
   * che il telefono aggiunge quando si incolla un indirizzo — non ci cadeva dentro, e l'invitato
   * finiva sulla pagina di accesso, dove una password non ce l'ha ancora.
   */
  function percorsoGate(p) {
    const s = String(p || '/').toLowerCase();
    const senzaCoda = s.length > 1 ? s.replace(/\/+$/, '') : s;
    return senzaCoda || '/';
  }

  /**
   * LE ZONE DELLA MACCHINA E DEL PROPRIETARIO.
   *
   * Non sono "cose da amministratore": sono cose che esistono in UNA sola copia per macchina, e
   * che quindi non possono essere di nessun altro — il registro degli accessi di tutti.
   *
   * La GESTIONE degli account non e' piu' in questo elenco perche' non e' piu' sul web: approvare
   * una richiesta creava una credenziale PERMANENTE, cioe' trasformava una sessione presa in
   * prestito per un minuto in un accesso che sopravvive alla scadenza del cookie. Vive in
   * `scripts/richieste.js`, sulla macchina.
   *
   * Ogni voce vale esatta E come prefisso. Scrivere solo `startsWith('/api/richieste/')`
   * lascerebbe scoperta `GET /api/richieste`, che e' proprio l'elenco delle persone.
   */
  const SOLO_OWNER = [
    '/api/logs',
  ];
  const soloOwner = p => SOLO_OWNER.some(x => p === x || p.startsWith(x + '/'));

  /** Il "no" nella lingua di chi ha bussato: JSON alle API, una pagina a chi naviga. */
  function nega(req, res, pn, codice, messaggio, dove) {
    if (pn.startsWith('/api/')) return res.status(codice).json({ error: messaggio });
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return res.redirect(302, dove);
    return res.status(codice).send(messaggio);
  }

  function gateAuth(req, res, next) {
    const pn = percorsoGate(req.path);
    const stato = auth.stato();
    if (stato === 'assente') return next();         // nessuna password → app locale aperta
    // Il file c'e' ma non si legge. Prima questo caso valeva "nessuna password" e apriva
    // tutto; ora chiude tutto, ma va DETTO: rispondere 401 a chi la password ce l'ha
    // giusta manda a cercare il guasto dalla parte sbagliata. /api/health resta viva,
    // altrimenti il probe di avvio di Electron aspetta per sempre.
    if (stato === 'illeggibile') {
      if (pn === '/api/health') return next();
      if (pn.startsWith('/api/')) return res.status(503).json({ error: MSG_AUTH_ROTTA });
      return res.status(503).send(MSG_AUTH_ROTTA);
    }
    if (AUTH_FREE.has(pn)) return next();           // /login, /logout, registrazione, invito
    // L'identita', non solo il ruolo: da qui in poi ogni limite e ogni riga di registro sanno
    // CHI ha fatto la richiesta, e non piu' soltanto da quale indirizzo e' arrivata.
    const ses = auth.checkSessione(parseCookies(req).amr_auth);   // { ruolo, id } | null
    const role = ses ? ses.ruolo : null;
    if (!role) return nega(req, res, pn, 401, 'non autorizzato', '/login');
    req.authRole = role;
    req.authId = ses.id;

    // IL PROPRIETARIO E' UN'IDENTITA' PIU' UN RUOLO, mai l'id da solo: `makeToken('demo')` produce
    // un cookie con ruolo 'demo' e id 'owner' (il valore predefinito del secondo argomento), ed e'
    // proprio il cookie che due prove della suite si costruiscono a mano. Guardare il solo id
    // aprirebbe tutta la macchina a quel cookie.
    const proprietario = ses.id === 'owner' && role === 'full';
    if (soloOwner(pn) && !proprietario) return nega(req, res, pn, 403, 'solo il proprietario', '/');

    // L'ospite anonimo resta in sola lettura. Le persone registrate possono scrivere solo i dati
    // ancora previsti dal prodotto (preferenze e parco), isolati per identita'.
    // Anonimo = qualunque sessione che non sia il proprietario e non abbia un nome proprio.
    // `checkSessione` lascia passare tre famiglie di id: 'owner', 'demo', e le persone vere (che
    // riconfronta con l'elenco vivo). Quindi "non proprietario e id d'ufficio" copre sia l'ospite
    // condiviso sia la combinazione che nessun login puo' produrre ma che una prova si costruisce
    // a mano — ruolo 'demo' con id 'owner', il valore predefinito di `makeToken`. Nel dubbio, la
    // porta piu' stretta.
    const anonimo = !proprietario && (ses.id === 'demo' || ses.id === 'owner');
    if (anonimo) {
      // Segnalare ed esportare in PDF restano concessi: il PDF si compone dalle righe che il suo
      // browser ha gia' in mano, quindi negarlo non proteggerebbe nessun dato.
      const isReport = pn === '/api/report' || pn === '/api/report-pdf';
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      if (isWrite && !isReport) {
        return nega(req, res, pn, 403, 'modalità demo: sola lettura', '/');
      }
    }
    return next();
  }
  app.use(gateAuth);

  /**
   * IL TETTO GIORNALIERO DEGLI OSPITI REGISTRATI.
   *
   * Ogni ricerca di questa app esce dall'IP di casa verso Subito, AutoScout e Moto.it — otto,
   * venti richieste alla volta. Dieci ospiti che cercano insieme sono dieci volte quel traffico
   * dallo stesso indirizzo, e le fonti bannano la MACCHINA, non la persona: il conto lo pagherebbe
   * il proprietario. Il limite al minuto che c'e' gia' protegge dalle raffiche, non dal totale di
   * una giornata.
   *
   * Vale per OGNI ospite, l'anonimo compreso. Esentare la password condivisa perche' "non scrive
   * e non ha un nome" e' una ragione da SCRITTURA, e qui non si difende un elenco: si difende il
   * traffico che esce dall'IP di casa. L'ospite senza nome e' anzi quello che ne fa di piu' —
   * quella password gira di mano in mano e non risale a nessuno. Non avendo un nome paga su un
   * secchio solo, condiviso fra tutti quelli che ce l'hanno: 'demo' e' un id riservato
   * (ID_RISERVATI in auth.js), quindi in quel conto non puo' finirci una persona vera.
   *
   * Il proprietario e i colleghi `full` non hanno tetto: quella e' la loro macchina.
   */
  const TETTO_GIORNALIERO = 50;
  function tettoGiornaliero(req, res, next) {
    if (!auth.isEnabled()) return next();                        // app locale aperta
    if (req.authRole !== 'demo' || !req.authId) return next();   // owner e full non hanno tetto
    try {
      const g = utentiDb.consumaRicerca(req.authId, TETTO_GIORNALIERO);
      if (!g.ok) {
        return res.status(429).json({
          error: `Hai fatto le ${g.max} ricerche di oggi. Il conto riparte domani.`,
          tetto: g.max, usate: g.usate, riprovaDomani: true,
        });
      }
      res.setHeader('X-AMR-Ricerche-Oggi', `${g.usate}/${g.max}`);
      return next();
    } catch (e) {
      // Il magazzino non si apre: non si lascia passare "perche' non si sa". Il proprietario non
      // passa di qui, quindi l'app non si blocca per lui.
      return res.status(503).json({ error: 'Il registro delle persone non e\' raggiungibile: riprova piu\' tardi.' });
    }
  }
  // NON piu' `app.use` davanti alla rotta: cosi' il tetto si addebitava PRIMA che l'handler
  // validasse i parametri e consultasse il limitatore al minuto, e una richiesta rifiutata con 400
  // o 429 bruciava comunque una delle 50 ricerche del giorno. Ora lo chiama l'handler, dopo i
  // controlli che non costano niente. /api/targa/verifica resta com'era: non ha una validazione
  // a monte che valga la pena di aspettare.
  app.use('/api/targa/verifica', tettoGiornaliero);

  app.get('/login', (req, res) => res.sendFile(path.join(__dirname, '../frontend/login.html')));

  async function postLogin(req, res) {
    // IP reale dietro Funnel (RIGHTMOST X-Forwarded-For, vedi clientIp). Senza,
    // dietro Funnel ogni utente è 127.0.0.1 → lockout globale.
    const ip = clientIp(req);
    const ora = Date.now();
    // La mappa si pota da se', come fa il limitatore comune: una voce il cui blocco e'
    // finito E i cui fallimenti sono decaduti non dice piu' niente, e tenerla e' solo
    // memoria che cresce a ogni indirizzo che sbaglia una password.
    if (loginAttempts.size > 500) {
      for (const [k, v] of loginAttempts) {
        if (v.until <= ora && ora - (v.last || 0) >= LOCK_DECAY_MS) loginAttempts.delete(k);
      }
    }
    const rec = loginAttempts.get(ip);
    if (rec && rec.until > ora) return res.redirect(302, '/login?err=locked');   // lockout

    const utente = auth.verifica(req.body && req.body.password);   // { id, nome, ruolo } | null
    const role = utente ? utente.ruolo : null;
    if (!role) {
      // SI CONTA PRIMA DI DORMIRE. Con l'attesa in mezzo, fra il `get` e il `set` c'era un await:
      // tutte le richieste arrivate nella stessa finestra leggevano lo stesso `rec` e scrivevano
      // tutte lo stesso valore, l'ultima vinceva. Misurato: 200 password provate in parallelo,
      // contatore finale 1, lockout mai scattato. Ora fra lettura e scrittura non c'e' nessun
      // await, quindi sul thread unico il conteggio torna atomico.
      const precedenti = (rec && ora - (rec.last || 0) < LOCK_DECAY_MS) ? rec.fails : 0;
      const fails = precedenti + 1;
      loginAttempts.set(ip, { fails, until: fails >= LOCK_MAX ? ora + LOCK_MS : 0, last: ora });
      await new Promise(r => setTimeout(r, 1000));   // delay anti-brute, DOPO aver contato
      return res.redirect(302, '/login?err=1');
    }

    loginAttempts.delete(ip);
    const token  = auth.makeToken(role, utente.id);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `amr_auth=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(auth.TTL_MS / 1000)}${secure}`);
    res.redirect(302, '/');
  }
  // Funzione nominata e poi registrata: e' l'unico modo di provare il conteggio dei tentativi
  // senza aprire una porta (supertest non e' fra le dipendenze). Stessi middleware di prima.
  app.post('/login', express.urlencoded({ extended: false }), postLogin);

  app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'amr_auth=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.redirect(302, '/login');
  });

  // Ruolo della sessione corrente (per la UI: nasconde i comandi mutabili in demo).
  // Auth disattivata (app locale) → 'full'. Sotto /api/ → già protetta dal middleware.
  app.get('/api/me', (req, res) => {
    if (!auth.isEnabled()) return res.json({ role: 'full', id: 'owner', proprietario: true, authDisabled: true });
    const ses = req.authId ? { ruolo: req.authRole, id: req.authId } : auth.checkSessione(parseCookies(req).amr_auth);
    if (!ses) return res.json({ role: null, id: null, proprietario: false });
    // Lo schermo deve poter nascondere quello che prenderebbe 403: senza l'identita', il pannello
    // del proprietario e il bottone che rinnova la sessione del portale comparivano a tutti, e
    // fallivano al clic. Chi ha un nome ma non e' il proprietario e' un ospite registrato.
    res.json({ role: ses.ruolo, id: ses.id, proprietario: ses.id === 'owner' && ses.ruolo === 'full' });
  });

  // Liveness per il probe di avvio Electron (waitForBackend). Auth-exempt: il
  // probe gira prima del login. Nessun dato sensibile.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Log applicativi — SOLO owner: le ultime righe del ring-buffer (segreti redatti dal logger).
  // ?n=200 righe, ?level=error filtra. Utile per diagnosticare errori-fonte (es. "Web error") senza SSH.
  // Il gate e' sull'IDENTITA', non sul ruolo: «solo owner» confrontato col ruolo faceva entrare
  // qualunque collega con l'accesso pieno — e qui dentro ci sono le ricerche, gli IP e le
  // tracce d'errore di tutti. req.authId ce l'ha solo questo handler fra i gate del backend.
  app.get('/api/logs', (req, res) => {
    if (auth.isEnabled() && req.authId !== 'owner') return res.status(403).json({ error: 'solo owner' });
    const n = Math.min(parseInt(req.query.n, 10) || 200, 500);
    let lines = logger.tail(n);
    if (req.query.level) { const L = String(req.query.level).toUpperCase(); lines = lines.filter(l => l.includes(' ' + L + ' ')); }
    res.type('text/plain').send(lines.join('\n'));
  });

  // IP reale del client: dietro il Funnel Tailscale, l'ULTIMO hop di X-Forwarded-For
  // (il leftmost è spoofabile). Senza proxy (Electron locale) → remoteAddress.
  function clientIp(req) {
    /**
     * L'HEADER LO SCRIVE IL CLIENT, e questo indirizzo regge il blocco dopo otto tentativi di
     * login e ogni limite di richieste. Prima ci si fidava sempre: bastava cambiare
     * `X-Forwarded-For` a ogni tentativo per non far scattare mai il lockout, e il server
     * ascolta su tutte le interfacce — quindi dalla rete dell'ufficio o dal tailnet lo si
     * raggiunge direttamente, saltando il Funnel.
     *
     * Il Funnel proxa a 127.0.0.1: l'header vale SOLO quando la connessione arriva da li'.
     * Da qualunque altro indirizzo si usa quello vero del socket, che nessuno puo' riscrivere.
     */
    const remoto = (req.socket && req.socket.remoteAddress) || '';
    const daFunnel = remoto === '127.0.0.1' || remoto === '::1' || remoto === '::ffff:127.0.0.1';
    if (daFunnel) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) { const p = String(xff).split(',').map(s => s.trim()).filter(Boolean); if (p.length) return p[p.length - 1]; }
    }
    return remoto || 'unknown';
  }

  /**
   * LA CHIAVE DEI LIMITI: la PERSONA se e' entrata, l'indirizzo se non lo e'.
   *
   * I diciotto limiti dell'app erano tutti per indirizzo, e dietro il Funnel l'ufficio ne ha
   * uno solo: il blocco di uno diventava il blocco di tutti. Con una password a testa ognuno
   * ha la sua quota, e chi non e' autenticato resta contato per indirizzo com'era.
   */
  function chiaveLimite(req) {
    return req.authId ? 'u:' + req.authId : 'ip:' + clientIp(req);
  }

  return { gateAuth, postLogin, loginAttempts, percorsoGate, soloOwner, SOLO_OWNER, AUTH_FREE,
    tettoGiornaliero, TETTO_GIORNALIERO, clientIp, chiaveLimite };
}

module.exports = { mount };
