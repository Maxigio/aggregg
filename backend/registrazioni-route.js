/**
 * LE ROTTE DI CHI CHIEDE DI ENTRARE.
 *
 * Tre porte pubbliche (chi le usa una sessione non ce l'ha, per definizione) e un pannello che
 * vede solo il proprietario:
 *
 *   pubbliche    POST /api/registrazione     chiede un account (nome + email, nessuna password)
 *                POST /api/invito/chi        cosa c'e' dietro un link, senza consumarlo
 *                POST /api/invito            sceglie la password e nasce l'account
 *                GET  /invito                la pagina dove si sceglie la password
 *   proprietario GET  /richieste             il pannello
 *                GET  /api/richieste         le richieste vive + le persone che ci sono
 *                POST /api/richieste/:id/approva|rifiuta
 *                POST /api/persone/:id/revoca
 *
 * IL TOKEN NON PASSA MAI DA UNA QUERY. La pagina lo prende dal FRAMMENTO dell'indirizzo
 * (`/invito#t=...`), che il browser non manda al server e non mette nell'header `Referer`; da
 * li' viaggia solo dentro il corpo di una POST. Un link incollato in una chat viene scaricato
 * dai server di quel servizio per fabbricare l'anteprima: con il token nel frammento, quello che
 * scaricano e' una pagina vuota.
 *
 * LE PAGINE STANNO FUORI DA `frontend/`. Quella cartella e' servita da `express.static`, il
 * filesystem di questa macchina non distingue le maiuscole, e un pannello protetto da un solo
 * handler si scaricherebbe con `GET /richieste.html` o `/RICHIESTE.HTML`. E' la stessa lezione
 * gia' scritta per `/guida` e per il gate del percorso in minuscolo.
 */
const path = require('path');
const auth = require('./auth');
const reg = require('./registrazioni');
const dbmod = require('./utenti-db');
const { crea } = require('./limite-richieste');

const PAGINE = path.join(__dirname, '..', 'pagine');

// Freni con la loro mappa, separata da quella del login: un ospite che sbaglia a registrarsi non
// deve poter bloccare i login dello stesso indirizzo. La finestra e' di dieci minuti, non di
// un'ora: e' il regime per cui `limite-richieste` e' scritto e provato — con finestre lunghe la
// sua potatura non elimina piu' niente e la scansione riparte a ogni richiesta.
const FINESTRA = 10 * 60 * 1000;

function messaggioDb() {
  const s = dbmod.stato();
  if (s === 'ok') return null;
  return s === 'assente'
    ? 'Il registro delle persone non e\' raggiungibile: riprova piu\' tardi.'
    : 'Il registro delle persone non si legge: va riparato prima di poter registrare qualcuno.';
}

function mount(app, deps = {}) {
  const json = deps.json;                       // express.json(...) — lo passa server.js
  const clientIp = deps.clientIp || (req => req.ip || '');
  const chiaveLimite = deps.chiaveLimite || (req => 'ip:' + clientIp(req));

  const limiteRichieste = crea({ max: 1, finestra: FINESTRA, cosa: 'richieste di registrazione' });
  const limiteInviti = crea({ max: 10, finestra: FINESTRA, cosa: 'tentativi sul link di invito' });

  /** Il proprietario e non "chi ha un cookie": senza identita' non si e' il proprietario. */
  function soloProprietario(req, res) {
    if (req.authId === 'owner' && req.authRole === 'full') return true;
    res.status(403).json({ error: 'solo il proprietario' });
    return false;
  }

  // Il magazzino rotto non deve diventare "nessun conflitto": chi scrive credenziali si ferma.
  function magazzinoPronto(res) {
    const m = messaggioDb();
    if (!m) return true;
    res.status(503).json({ error: m });
    return false;
  }

  // ── Pubbliche ──────────────────────────────────────────────────────────────

  app.post('/api/registrazione', json, (req, res) => {
    const stato = limiteRichieste.consuma(chiaveLimite(req));
    // La `testa` e' una frase chiusa: `messaggio()` ci attacca in coda "Riprova fra …".
    if (!stato.ok) return res.status(429).json({ error: limiteRichieste.messaggio(stato, 'Hai gia\' mandato una richiesta.') });
    if (!magazzinoPronto(res)) return;
    try {
      const r = reg.chiedi({ nome: req.body && req.body.nome, email: req.body && req.body.email, ip: clientIp(req) });
      // Non si torna l'id della richiesta: a chi ha chiesto non serve, e sarebbe un numero da
      // provare a indovinare sulle rotte del pannello.
      res.json({ ok: true, nome: r.nome });
    } catch (e) {
      const stato = e.code === 'CODA_PIENA' ? 503 : 400;
      res.status(stato).json({ error: e.message, code: e.code || null });
    }
  });

  app.get('/invito', (req, res) => res.sendFile(path.join(PAGINE, 'invito.html'), {
    // Il token sta nel frammento e non viaggia, ma la pagina non deve nemmeno perdere
    // l'indirizzo da cui si arriva verso i siti esterni.
    headers: { 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' },
  }));

  app.post('/api/invito/chi', json, (req, res) => {
    const stato = limiteInviti.consuma(chiaveLimite(req));
    if (!stato.ok) return res.status(429).json({ error: limiteInviti.messaggio(stato, 'Troppi tentativi su questo link.') });
    if (!magazzinoPronto(res)) return;
    const g = reg.guarda(req.body && req.body.token);
    res.set('Cache-Control', 'no-store');
    res.json(g.valido ? { valido: true, nome: g.nome, minimo: auth.MIN_LEN } : { valido: false, motivo: g.motivo });
  });

  app.post('/api/invito', json, (req, res) => {
    const stato = limiteInviti.consuma(chiaveLimite(req));
    if (!stato.ok) return res.status(429).json({ error: limiteInviti.messaggio(stato, 'Troppi tentativi su questo link.') });
    if (!magazzinoPronto(res)) return;
    try {
      const nata = reg.consuma(req.body && req.body.token, req.body && req.body.password);
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, nome: nata.nome });
    } catch (e) {
      res.status(400).json({ error: e.message, code: e.code || null });
    }
  });

  // ── Pannello del proprietario ──────────────────────────────────────────────

  app.get('/richieste', (req, res) => {
    if (req.authId !== 'owner' || req.authRole !== 'full') return res.redirect(302, '/');
    res.sendFile(path.join(PAGINE, 'richieste.html'), { headers: { 'Cache-Control': 'no-store' } });
  });

  app.get('/api/richieste', (req, res) => {
    if (!soloProprietario(req, res)) return;
    if (!magazzinoPronto(res)) return;
    res.set('Cache-Control', 'no-store');
    res.json({
      richieste: reg.elenco(),
      // Le persone servono a due cose: revocarle, e far vedere accanto a ogni richiesta se il
      // nome cadrebbe su una di loro.
      persone: auth.persone().map(p => ({ id: p.id, nome: p.nome, ruolo: p.ruolo, origine: p.origine })),
      scadenzaInvitoOre: Math.round(reg.INVITO_TTL / 3600000),
    });
  });

  app.post('/api/richieste/:id/approva', json, (req, res) => {
    if (!soloProprietario(req, res)) return;
    if (!magazzinoPronto(res)) return;
    try {
      const inv = reg.approva(req.params.id);
      // Il token in chiaro esce di qui UNA volta sola: nel database c'e' solo l'impronta.
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, nome: inv.nome, token: inv.token, scadeIl: inv.scadeIl });
    } catch (e) {
      res.status(400).json({ error: e.message, code: e.code || null });
    }
  });

  app.post('/api/richieste/:id/rifiuta', json, (req, res) => {
    if (!soloProprietario(req, res)) return;
    if (!magazzinoPronto(res)) return;
    try { reg.rifiuta(req.params.id, req.body && req.body.motivo); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message, code: e.code || null }); }
  });

  app.post('/api/persone/:id/revoca', json, (req, res) => {
    if (!soloProprietario(req, res)) return;
    const id = String(req.params.id || '');
    if (auth.ID_RISERVATI.has(id)) return res.status(400).json({ error: 'questa voce non si revoca' });
    // Revocare toglie l'ACCESSO, non i dati: il cookie cade al primo controllo (la sessione si
    // riconfronta con l'elenco vivo a ogni richiesta) e le sue righe restano dove sono. Il nome
    // resta riservato finche' qualcuno non decide di cancellare anche quelle: e' un gesto a
    // parte, e va fatto sapendo cosa si butta.
    const tolta = auth.togliPersona(id);
    if (!tolta) return res.status(404).json({ error: 'nessuna persona con questo id' });
    res.json({ ok: true });
  });
}

module.exports = { mount, PAGINE };
