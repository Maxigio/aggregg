/**
 * LE ROTTE DI CHI CHIEDE DI ENTRARE — solo pubbliche, nessuna di gestione.
 *
 * Quattro porte, tutte raggiungibili senza sessione perche' chi le usa una sessione non ce l'ha
 * ancora, per definizione:
 *
 *   POST /api/registrazione     chiede un accesso (nome + email, nessuna password)
 *   GET  /invito                la pagina dove si sceglie la password
 *   POST /api/invito/chi        cosa c'e' dietro un link, senza consumarlo
 *   POST /api/invito            sceglie la password e nasce l'account
 *
 * Approvare, rifiutare e revocare NON stanno qui e non stanno sul web: `scripts/richieste.js`.
 * Il perche' e' scritto per esteso in fondo a questo file.
 *
 * IL TOKEN NON PASSA MAI DA UNA QUERY. La pagina lo prende dal FRAMMENTO dell'indirizzo
 * (`/invito#t=...`), che il browser non manda al server e non mette nell'header `Referer`; da
 * li' viaggia solo dentro il corpo di una POST. Un link incollato in una chat viene scaricato
 * dai server di quel servizio per fabbricare l'anteprima: con il token nel frammento, quello che
 * scaricano e' una pagina vuota.
 *
 * LA PAGINA DELL'INVITO STA FUORI DA `frontend/`. Quella cartella e' servita da `express.static`
 * e il filesystem di questa macchina non distingue le maiuscole: quello che ci si mette dentro si
 * scarica anche scritto in un altro modo. E' la stessa lezione gia' scritta per `/guida` e per il
 * gate del percorso in minuscolo.
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

  /**
   * QUI FINIVA IL PANNELLO DEL PROPRIETARIO, e non c'e' piu': elenco, approvazione, rifiuto e
   * revoca stanno in `scripts/richieste.js`, che gira sulla macchina.
   *
   * IL PERCHE', deciso dal proprietario dopo averlo misurato. Un cookie scade, un account no.
   * Approvare dal web voleva dire che una sessione presa in prestito per un minuto — un telefono
   * lasciato sul bancone, non un attacco da internet — bastava a fabbricare un accesso
   * PERMANENTE: l'approvazione restituisce un token che vale 48 ore e che si consuma senza piu'
   * nessuna sessione, e l'account che ne nasce sopravvive alla scadenza del cookie, alla revoca
   * della sessione e al cambio password del proprietario. Variante peggiore: approvando una
   * richiesta LEGITTIMA gia' in coda, l'account nasce col nome del richiedente vero e con la
   * password scelta da chi ha rubato il momento — e a schermo sembra tutto normale.
   *
   * Prima di questa funzione, la stessa sessione rubata poteva leggere e scrivere; non poteva
   * creare un accesso permanente. Quel potere e' l'unica cosa che il pannello aggiungeva, ed e'
   * la ragione per cui e' tornato dove non passa da un browser.
   *
   * Restano qui sopra solo le tre porte pubbliche, che pubbliche devono essere: chiedere un
   * accesso, e usarne uno gia' approvato per scegliersi la password.
   */
}

module.exports = { mount, PAGINE };
