'use strict';
/**
 * Rotte della sezione Competitor.
 *
 *   GET    /api/competitor            l'elenco salvato (nessuna rete)
 *   POST   /api/competitor            { url } → risolve la vetrina e la salva
 *   DELETE /api/competitor/:id        toglie una voce
 *   GET    /api/competitor/:id/parco  scarica il parco e lo aggrega — SU RICHIESTA
 *
 * `:id` nelle rotte e' SEMPRE la chiave composta `fonte:id` (es. `subito:105412305`), in un
 * segmento solo: gli id numerici delle fonti non sono univoci fra loro, e spezzare la chiave
 * in due segmenti oscurerebbe la rotta /gruppo/:g/parco registrata dopo.
 *
 * Il parco NON si scarica all'apertura della sezione: un concessionario grosso costa una
 * richiesta ogni cinquanta veicoli, e aprire una scheda non e' chiedere un aggiornamento.
 * In cache dieci minuti, cosi' riaprire la stessa scheda non ripaga il conto.
 */
const comp = require('./competitor');

const TTL = 10 * 60 * 1000;
const cache = new Map();   // `${fonte}:${id}` → { ts, dati }

/**
 * IL LIMITATORE, che qui mancava mentre ogni altra rotta ce l'ha (ricambi-route:44,
 * fonti-route:134, richiami-route:130, prove-route:29). Uno scarico di parco puo' costare
 * fino a ottanta pagine di richieste alle fonti: senza freno, un doppio clic sul bottone —
 * che un umano fa senza cattiveria quando l'attesa e' lunga — ne fa partire due in parallelo.
 * Il rischio non e' un dato sbagliato: e' che la fonte ci blocchi, e con lei si ferma la
 * ricerca, che e' il cuore dell'app.
 */
const PARCO_MAX = 6;               // scarichi per finestra
const PARCO_FINESTRA = 10 * 60 * 1000;
const MSG_LIMITE = `Troppi scarichi di parco: sono ${PARCO_MAX} ogni ${PARCO_FINESTRA / 60000} minuti. Uno scarico costa fino a ottanta richieste alla fonte, e superare il limite significa farsi bloccare.`;
const parcoHits = new Map();       // ip → [ts]
function parcoOk(ip) {
  const ora = Date.now();
  if (parcoHits.size > 500) parcoHits.clear();
  const a = (parcoHits.get(ip) || []).filter(t => ora - t < PARCO_FINESTRA);
  a.push(ora); parcoHits.set(ip, a);
  return a.length <= PARCO_MAX;
}
/** Quanti scarichi restano, per dirlo invece di far sembrare rotta la sezione. */
function parcoRestanti(ip) {
  const ora = Date.now();
  const a = (parcoHits.get(ip) || []).filter(t => ora - t < PARCO_FINESTRA);
  return Math.max(0, PARCO_MAX - a.length);
}

function mount(app, deps = {}) {
  const C = deps.competitor || comp;
  const clientIp = deps.clientIp || (req => req.ip || '');
  // Il body JSON si monta per-rotta in questa app, non globalmente: arriva da server.js.
  const json = deps.json || ((req, res, next) => next());

  // La CHIAVE di una voce e' `fonte:id`, non il solo id: Subito e Autoscout numerano
  // ognuno per conto suo (osservati AS24 a 4-7 cifre, Subito a 6-9), e i POST deduplicano
  // gia' su questa coppia. Indirizzare per solo id significava che, con una collisione,
  // si serviva il parco del venditore sbagliato e DELETE toglieva due voci.
  const chiaveDi = v => v.fonte + ':' + v.id;

  // La voce e' in cache fresca? La cache e' gia' indicizzata per `fonte:id`.
  const inCacheFresca = chiave => {
    const hit = cache.get(chiave);
    return !!(hit && Date.now() - hit.ts < TTL);
  };

  /**
   * L'elenco quando si sta per SCRIVERE. Se il file su disco e' illeggibile, leggi()
   * risponde [] — e riscrivere il file partendo da quel vuoto renderebbe la perdita
   * definitiva, che e' esattamente lo scenario che il docstring di leggi() dichiara
   * chiuso. Qui si chiude davvero: a file corrotto si risponde 503 e non si scrive.
   * Il controllo va fatto SUBITO dopo leggi(), nello stesso tick, mai dopo un await.
   */
  function vociPerScrivere(res) {
    const voci = C.leggi();
    if (C.leggi.ultimoErrore) {
      res.status(503).json({
        ok: false, corrotto: true,
        error: `l'elenco su disco e' illeggibile (${C.leggi.ultimoErrore}): non lo sovrascrivo — ripristina o togli competitor.json, poi riprova`,
      });
      return null;
    }
    return voci;
  }

  app.get('/api/competitor', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const voci = C.leggi();
    // Elenco vuoto per file corrotto ed elenco davvero vuoto sono due cose diverse, e chi
    // guarda deve saperlo PRIMA di incollare un link convinto di ripartire da zero.
    res.json({ ok: true, voci, erroreElenco: C.leggi.ultimoErrore || null });
  });

  /**
   * IL VENDITORE DI UN ANNUNCIO, senza incollare nessun link.
   *
   * L'id del venditore sta gia' dentro l'annuncio, ed e' lo STESSO che il parco usa come
   * porta d'ingresso — verificato sulle due fonti: Subito `venditoreId` 105412305 → `uid=`
   * torna 100 annunci di quel solo venditore; Autoscout `venditoreId` 7008 → `as24Customer=`
   * ne torna 44, sempre suoi. Quindi qui non si risolve niente: si prende l'id e lo si mette
   * in elenco.
   *
   * L'ANAGRAFICA (indirizzo, telefoni, orari) sta sulla pagina della vetrina, che da un
   * annuncio non conosciamo: si legge quando il parco lo si scarica davvero, ed e' esattamente
   * a cosa serve `schedaLetta`. Il parco NON parte da qui: e' una richiesta lunga e la decide
   * chi guarda.
   */
  app.post('/api/competitor/da-annuncio', json, (req, res) => {
    const b = req.body || {};
    const fonte = String(b.fonte || '');
    const id = String(b.id || '');
    // Solo le due fonti che l'id ce l'hanno nell'annuncio: Moto.it passa dal link della
    // vetrina, che la porta di sempre sa gia' risolvere.
    if (fonte !== 'subito' && fonte !== 'autoscout') return res.status(400).json({ ok: false, error: 'fonte non valida' });
    if (!/^\d{1,15}$/.test(id)) return res.status(400).json({ ok: false, error: 'id venditore non valido' });
    const voci = vociPerScrivere(res); if (!voci) return;
    const gia = voci.find(v => v.fonte + ':' + v.id === fonte + ':' + id);
    if (gia) return res.status(409).json({ ok: false, error: `${gia.nome || 'Questo venditore'} e' gia' nell'elenco`, voce: gia });
    const nome = String(b.nome || '').trim().slice(0, 80) || `${fonte === 'subito' ? 'Venditore Subito' : 'Venditore Autoscout'} ${id}`;
    const voce = {
      fonte, id, nome,
      dove: null, via: null,
      url: null,                 // la vetrina non la conosciamo: l'annuncio non la porta
      mio: !!b.mio,
      schedaLetta: true,         // non c'e' niente da rileggere finche' non c'e' un url
      daAnnuncio: true,          // com'e' entrato in elenco: si vede, non si indovina
      aggiunto: new Date().toISOString(),
    };
    voci.push(voce);
    C.scrivi(voci);
    res.json({ ok: true, voce });
  });

  app.post('/api/competitor', json, async (req, res) => {
    const url = (req.body && req.body.url) || (req.query && req.query.url);
    if (!url) return res.status(400).json({ ok: false, error: 'serve il link della vetrina' });
    let voce;
    try { voce = await C.risolviVetrina(String(url)); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const voci = vociPerScrivere(res); if (!voci) return;
    const chiave = voce.fonte + ':' + voce.id;
    // Chi reincolla lo stesso link non sta sbagliando: sta chiedendo QUEL parco. Si dice
    // che c'era gia' e si rimanda la voce salvata, cosi' chi chiama puo' aprirla invece di
    // lasciare l'utente davanti a un errore che non gli fa fare niente.
    const gia = voci.find(v => v.fonte + ':' + v.id === chiave);
    if (gia) return res.status(409).json({ ok: false, error: `${voce.nome} e' gia' nell'elenco`, voce: gia });
    // `mio` lo decide chi aggiunge: il proprio parco e' una voce come le altre, ma va
    // distinta, altrimenti nel confronto ci si perde fra i concorrenti.
    voce.mio = !!(req.body && req.body.mio);
    voce.schedaLetta = true;                 // appena letta: non si rilegge al primo parco
    voce.aggiunto = new Date().toISOString();
    voci.push(voce);
    C.scrivi(voci);
    res.json({ ok: true, voce });
  });

  app.delete('/api/competitor/:id', (req, res) => {
    const chiave = String(req.params.id);   // `fonte:id`, in un solo segmento
    const voci = vociPerScrivere(res); if (!voci) return;
    const restanti = voci.filter(v => chiaveDi(v) !== chiave);
    if (restanti.length === voci.length) return res.status(404).json({ ok: false, error: 'non e\' nell\'elenco' });
    C.scrivi(restanti);
    res.json({ ok: true, tolti: voci.length - restanti.length });
  });

  /** Il parco di UNA vetrina: cache, rilettura della scheda, annuncio intero. */
  async function scaricaParco(chiave, forza) {
    let voce = C.leggi().find(v => chiaveDi(v) === String(chiave));
    if (!voce) { const e = new Error('non e\' nell\'elenco'); e.stato = 404; throw e; }
    // Le vetrine salvate prima avevano tre campi: nome, dove, via. Ora la pagina ne da'
    // molti di piu' (telefoni, orari, valutazione, servizi, logo) e chi ce l'ha gia' in
    // elenco non deve toglierla e rimetterla per vederli: si rilegge una volta sola,
    // quando quel parco lo si scarica comunque.
    // `voce.url` puo' mancare: le vetrine aggiunte da un annuncio hanno l'id ma non il link
    // della pagina. Senza questa guardia si tentava una risoluzione destinata a fallire a
    // ogni singolo scarico del parco.
    if (!voce.schedaLetta && voce.url) {
      try {
        const fresca = await C.risolviVetrina(voce.url);
        voce = { ...voce, ...fresca, id: voce.id, mio: voce.mio, aggiunto: voce.aggiunto, gruppo: voce.gruppo, schedaLetta: true };
        // Rilettura: si rimappa per chiave composta, e MAI sopra un elenco illeggibile —
        // a file corrotto leggi() torna [] e la map scriverebbe un elenco di una voce sola.
        const tutte = C.leggi();
        if (!C.leggi.ultimoErrore) C.scrivi(tutte.map(v => (chiaveDi(v) === String(chiave) ? voce : v)));
      } catch (_) { /* la vetrina non risponde: si va avanti con quello che c'e' */ }
    }
    const k = chiaveDi(voce);
    const hit = cache.get(k);
    if (!forza && hit && Date.now() - hit.ts < TTL) {
      return { ...hit.dati, daCache: true, quando: new Date(hit.ts).toISOString() };
    }
    let p;
    try { p = await C.parco(voce); }
    catch (e) { e.stato = 502; throw e; }
    const dati = {
      voce,
      numeri: C.aggrega(p.veicoli),
      troncato: p.troncato,
      // Le passate cadute viaggiano separate dal tetto: sono due avvisi diversi e finora
      // uscivano con la stessa frase, quella sbagliata delle due.
      passateKo: (p.passateKo && p.passateKo.length) ? p.passateKo : null,
      // Le card presenti che non si sono lasciate leggere: dirle e' l'unico modo perche' chi
      // guarda sappia che i numeri sono calcolati su meno mezzi di quelli in vetrina.
      illeggibili: p.illeggibili || 0,
      // Quanti ne dichiara la FONTE: "presi 180 di 240" dice una cosa che "presi 180" non dice.
      totaleFonte: p.totaleFonte != null ? p.totaleFonte : null,
      storico: p.storico || null,      // Moto.it: quanti ne ha pubblicati in tutto, e da quando
      /**
       * L'ANNUNCIO INTERO. Qui c'era una rimappatura a otto campi che buttava via tutto il
       * resto — foto, descrizione, versione, potenza, colore, garanzia, IVA esposta,
       * codice di magazzino — roba che le fonti mandano nella stessa risposta e che
       * avevamo gia' in mano. Il parco di un concessionario si guarda annuncio per
       * annuncio, e con otto campi non si guarda niente.
       */
      veicoli: p.veicoli.map(v => { const { _raw, ...pulito } = v; return pulito; }),
    };
    cache.set(k, { ts: Date.now(), dati });
    // Un annuncio pesa ~3 KB (misurato su Autoscout: 16 annunci, 50 KB, meta' sono gli URL
    // delle foto). Un parco al tetto sono 6 MB: sessanta in cache erano 370 MB di roba che
    // nessuno riguarda. Otto vetrine sono piu' di quante se ne aprano in dieci minuti.
    if (cache.size > 8) cache.delete(cache.keys().next().value);
    return { ...dati, daCache: false, quando: new Date().toISOString() };
  }

  app.get('/api/competitor/:id/parco', async (req, res) => {
    const forza = String(req.query.forza || '') === '1';
    const ip = clientIp(req);
    // La cache non conta come scarico: riaprire una scheda gia' letta non costa niente alle
    // fonti, e non deve consumare il budget. Il limite morde solo quando si va davvero in rete.
    const chiave = String(req.params.id);   // `fonte:id`
    const daCache = !forza && inCacheFresca(chiave);
    if (!daCache && !parcoOk(ip)) {
      return res.status(429).json({ ok: false, error: MSG_LIMITE, riprovaFra: PARCO_FINESTRA / 60000 });
    }
    try {
      const d = await scaricaParco(chiave, forza);
      res.json({ ok: true, ...d, scarichiRestanti: parcoRestanti(ip) });
    } catch (e) { res.status(e.stato || 500).json({ ok: false, error: e.message }); }
  });

  /**
   * UNIRE DUE VETRINE nello stesso concessionario. Lo decide chi guarda, non l'app: due
   * nomi simili non sono una prova, e un accostamento sbagliato racconterebbe il parco di
   * qualcun altro. `con: null` separa.
   */
  app.post('/api/competitor/:id/gruppo', json, (req, res) => {
    const chiave = String(req.params.id);   // `fonte:id`, come `con` nel body
    const con = req.body && req.body.con != null ? String(req.body.con) : null;
    const voci = vociPerScrivere(res); if (!voci) return;
    const a = voci.find(v => chiaveDi(v) === chiave);
    if (!a) return res.status(404).json({ ok: false, error: 'non e\' nell\'elenco' });
    if (con == null) {
      a.gruppo = null;
      C.scrivi(voci);
      return res.json({ ok: true, voci });
    }
    const b = voci.find(v => chiaveDi(v) === con);
    if (!b) return res.status(404).json({ ok: false, error: 'l\'altra vetrina non e\' nell\'elenco' });
    const g = a.gruppo || b.gruppo || ('g' + Date.now().toString(36));
    // Chi era gia' in uno dei due gruppi ci resta: unendo A a B si uniscono anche i loro.
    const vecchi = new Set([a.gruppo, b.gruppo].filter(Boolean));
    for (const v of voci) if (v === a || v === b || (v.gruppo && vecchi.has(v.gruppo))) v.gruppo = g;
    C.scrivi(voci);
    res.json({ ok: true, gruppo: g, voci });
  });

  /**
   * Il parco di un GRUPPO di vetrine: i suoi elenchi, uno dietro l'altro.
   *
   * Qui c'era anche l'accostamento dello stesso mezzo fra vetrine diverse ("40 annunci, 16
   * veicoli"). E' stato tolto: senza un identificativo in comune fra le fonti quel giudizio
   * si regge su marca, anno, titolo, chilometri e prezzo, e su un parco vero di scooter due
   * mezzi diversi con la stessa cilindrata finivano nello stesso veicolo. Meglio nessun
   * numero che un numero che sembra buono.
   */
  app.get('/api/competitor/gruppo/:g/parco', async (req, res) => {
    const g = String(req.params.g);
    const voci = C.leggi().filter(v => v.gruppo === g);
    if (!voci.length) return res.status(404).json({ ok: false, error: 'gruppo vuoto' });
    const forza = String(req.query.forza || '') === '1';
    const ip = clientIp(req);
    const parti = [], errori = [];
    // IL LIMITATORE VALE ANCHE QUI. Questa rotta scaricava N parchi reali senza mai passare
    // dal budget: un gruppo di 10 vetrine con un doppio clic (il secondo parte gia' con
    // forza=1, il frontend valorizza lo stato PRIMA della fetch) erano fino a 1.600 pagine
    // di richieste alle fonti, e il contatore della rotta singola restava vergine. Le voci
    // servite da cache non si addebitano, come sulla rotta singola. `esaurito` evita di
    // richiamare parcoOk in loop: addebita un timestamp anche quando rifiuta, e su un
    // gruppo grosso gonfierebbe la finestra piu' di quanto faccia la rotta singola.
    let esaurito = false;
    for (const v of voci) {
      const chiave = chiaveDi(v);
      const daCache = !forza && inCacheFresca(chiave);
      if (!daCache && (esaurito || !parcoOk(ip))) {
        esaurito = true;
        errori.push({ id: v.id, nome: v.nome, error: MSG_LIMITE });
        continue;
      }
      try { parti.push(await scaricaParco(chiave, forza)); }
      catch (e) { errori.push({ id: v.id, nome: v.nome, error: e.message }); }
    }
    // Tutto rifiutato per budget e niente da mostrare: un "ok con zero veicoli" sembrerebbe
    // un gruppo vuoto. Si risponde come la rotta singola, cosi' la UI dice il perche'.
    if (!parti.length && esaurito) {
      return res.status(429).json({ ok: false, error: MSG_LIMITE, riprovaFra: PARCO_FINESTRA / 60000 });
    }
    const veicoli = parti.flatMap(p => p.veicoli);
    res.json({
      ok: true, gruppo: g, errori,
      // `troncato`, le passate cadute e le card illeggibili viaggiano per PARTE: il pannello
      // del gruppo scriveva una riga sola — "N annunci sulle X vetrine" — come se coprisse
      // tutto, mentre queste tre cose il backend le sapeva gia' e non le spediva nemmeno.
      parti: parti.map(p => ({
        voce: p.voce, numeri: p.numeri, storico: p.storico, troncato: p.troncato,
        passateKo: (p.passateKo && p.passateKo.length) ? p.passateKo : null,
        illeggibili: p.illeggibili || 0,
        quando: p.quando, daCache: p.daCache,
      })),
      numeri: C.aggrega(veicoli),
      veicoli,
      scarichiRestanti: parcoRestanti(ip),
    });
  });
}

module.exports = { mount };
