'use strict';
/**
 * L'AREA ASTE — le rotte.
 *
 * Il grosso e' lettura dal magazzino locale: non costa niente a nessuno, quindi non ha ne'
 * limitatore ne' addebito. Le uniche due rotte che escono davvero verso il portale del ministero
 * sono l'aggiornamento a mano e la ricerca libera, e quelle sono frenate.
 *
 * LA DOTTRINA DEI TRE STATI vale anche qui: se il magazzino non c'e' o non si apre, l'elenco
 * torna vuoto ma lo STATO viaggia accanto al dato (`magazzino: 'assente'|'illeggibile'`), cosi'
 * a schermo si legge «non ho ancora scaricato niente» invece di «nessuna asta trovata», che
 * sono due frasi molto diverse.
 */
const db = require('./aste-db');
const asteReal = require('./aste');
const pvpReal = require('./scrapers/pvp');
const { leggi, aIso, descrizionePulita } = require('./aste-lotto');

/**
 * L'aggiornamento a mano costa un giro intero: una trentina di chiamate a un servizio pubblico.
 * Il giro automatico ne fa gia' uno al giorno, quindi questo serve solo a chi ha fretta.
 */
const AGGIORNA_MAX = 3;
const AGGIORNA_FINESTRA = 60 * 60 * 1000;
const MSG_AGGIORNA = `Troppi aggiornamenti a mano: sono ${AGGIORNA_MAX} ogni ora. Un aggiornamento e' un giro intero sul portale del ministero, e l'area si aggiorna gia' da sola una volta al giorno.`;
const limiteAggiorna = require('./limite-richieste').crea({
  max: AGGIORNA_MAX, finestra: AGGIORNA_FINESTRA, cosa: 'aggiornamenti', maxChiavi: 500,
});

/**
 * E UN SECONDO TETTO, QUESTO DELLA MACCHINA. `chiaveLimite` e' la PERSONA (server.js:518),
 * quindi i tre giri qui sopra sono tre A TESTA: otto ospiti registrati che premono la pastiglia
 * «da aggiornare» fanno fino a ventiquattro passate intere sul portale del ministero in un'ora —
 * centinaia di richieste dallo stesso indirizzo — per un inventario che cambia una volta al
 * giorno. `inVolo` (aste.js:56) non salva il caso: fonde solo i giri che partono INSIEME, mentre
 * sparpagliati nell'ora sono giri veri uno dietro l'altro. E' la stessa ragione scritta in testa
 * per le ricerche normali: le fonti bandiscono la MACCHINA, non la persona.
 *
 * Sei l'ora e non tre: cosi' il tetto personale di chi ha fretta non se lo puo' mangiare
 * qualcun altro, e per una persona sola — il caso di oggi — non cambia niente.
 */
const AGGIORNA_MAX_MACCHINA = 6;
const CHIAVE_MACCHINA = 'macchina';
const MSG_MACCHINA = `Il portale del ministero e' uno solo per tutta la macchina: i giri a mano sono ${AGGIORNA_MAX_MACCHINA} ogni ora in tutto, e sono gia' stati spesi. L'area si aggiorna comunque da sola una volta al giorno.`;
const limiteMacchina = require('./limite-richieste').crea({
  max: AGGIORNA_MAX_MACCHINA, finestra: AGGIORNA_FINESTRA, cosa: 'aggiornamenti',
});

/** Il dettaglio e la ricerca libera vanno in rete a ogni clic: freno piu' largo, ma c'e'. */
const PORTALE_MAX = 30;
const PORTALE_FINESTRA = 60 * 1000;
const limitePortale = require('./limite-richieste').crea({
  max: PORTALE_MAX, finestra: PORTALE_FINESTRA, cosa: 'richieste al portale', maxChiavi: 500,
});

const intero = (v, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};
const testo = (v, max = 80) => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Il messaggio della fonte finisce TALE E QUALE nella card (frontend/app.js, `asDettaglio`), e i
 * messaggi di `pvp.js` cominciano col percorso interno del microservizio del ministero —
 * `/ve-xxxxxxxx-yyyyyyyy/ve-ms/vendite/2092470/restricted`, hash del rilascio compreso: roba
 * nostra, che a chi legge non dice niente. Il resto del messaggio resta, perche' «HTTP 503» e
 * «risposta non-JSON (endpoint cambiato?)» sono due guasti diversi e chi telefona li legge da li'.
 */
const senzaPercorso = m => String(m || '').replace(/PVP \/\S*: /g, '');

function mount(app, deps = {}) {
  const aste = deps.aste || asteReal;
  const pvp = deps.pvp || pvpReal;
  const magazzino = deps.db || db;
  const chiaveLimite = deps.chiaveLimite || (req => req.ip || '');

  /**
   * NIENTE CACHE DEL BROWSER, su nessuna di queste risposte.
   *
   * Express non manda `Cache-Control`, e senza quell'intestazione il browser applica una
   * freschezza a naso e puo' riservire una risposta vecchia senza nemmeno chiedere. Su un'asta
   * e' pericoloso: la data entro cui si presenta l'offerta e il prezzo base sono esattamente le
   * cose su cui non ci si puo' sbagliare, e un lotto puo' sparire dal portale da un giorno
   * all'altro. Visto succedere davvero durante lo sviluppo: la scheda mostrava un dettaglio di
   * qualche minuto prima mentre il server serviva gia' quello nuovo.
   */
  const noCache = res => res.set('Cache-Control', 'no-store');

  /** Lo stato del magazzino e dell'ultimo giro, uguale in ogni risposta d'elenco. */
  const contorno = () => {
    const g = magazzino.ultimoGiro();
    return {
      magazzino: magazzino.stato(),
      guasto: magazzino.guasto(),
      ultimoGiro: g ? { finitoIl: g.finitoIl, visti: g.visti, nuovi: g.nuovi, spariti: g.spariti } : null,
      daAggiornare: magazzino.stantio(),
    };
  };

  // ─── L'elenco, dal magazzino locale ────────────────────────────────────────────────────────
  app.get('/api/aste', (req, res) => {
    noCache(res);
    const { tipo, marca, provincia, q } = req.query;
    if (tipo != null && !['auto', 'moto'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'tipo deve essere "auto" o "moto"' });
    }
    try {
      const lotti = magazzino.cerca({
        tipo: tipo || null,
        marca: testo(marca, 60),
        provincia: testo(provincia, 60),
        testo: testo(q, 60),
        prezzoMax: intero(req.query.prezzoMax, 0, 100000000),
        soloSingoli: req.query.soloSingoli === '1',
        limite: intero(req.query.limite, 1, 2000) || 500,
      });
      res.json({ ok: true, lotti, quanti: lotti.length, ...contorno() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ─── Di cosa riempire le tendine ───────────────────────────────────────────────────────────
  // Marche e province si leggono dal magazzino, non da un elenco fisso: mostrare una marca che
  // non ha nemmeno un lotto e' un filtro che non filtra niente.
  app.get('/api/aste/filtri', (req, res) => {
    noCache(res);
    const { tipo } = req.query;
    if (tipo != null && !['auto', 'moto'].includes(tipo)) {
      return res.status(400).json({ ok: false, error: 'tipo deve essere "auto" o "moto"' });
    }
    const perMarca = magazzino.perMarca(tipo || null);
    res.json({
      ok: true,
      // La marca non riconosciuta viaggia come `null` e si conta a parte: a schermo diventa
      // «marca non riconosciuta», che e' un'informazione, non un buco da nascondere.
      marche: perMarca.filter(m => m.marca).map(m => ({ nome: m.marca, quanti: m.quanti })),
      senzaMarca: (perMarca.find(m => !m.marca) || { quanti: 0 }).quanti,
      province: magazzino.province(tipo || null),
      ...contorno(),
    });
  });

  // ─── La ricerca libera girata al portale ───────────────────────────────────────────────────
  // Il filtro locale copre l'uso normale; questa serve a scavare oltre, perche' pesca anche nei
  // lotti che noi non abbiamo classificato e in quelli con vendita gia' passata.
  app.get('/api/aste/portale', async (req, res) => {
    noCache(res);
    const q = testo(req.query.q, 60);
    const tipo = req.query.tipo === 'auto' ? 'auto' : 'moto';
    if (!q) return res.status(400).json({ ok: false, error: 'serve un testo da cercare' });
    const g = limitePortale.consuma(chiaveLimite(req));
    if (!g.ok) return res.status(429).json({ ok: false, error: limitePortale.messaggio(g), riprovaFra: g.attesa });
    try {
      // ORDINE DECRESCENTE, e non e' un dettaglio: la fonte ordina per data di vendita e il 90%
      // del suo archivio e' passato, quindi la prima pagina crescente e' fatta tutta di vendite
      // vecchie — cioe' esattamente quelle che la riga qui sotto scarta. Misurato il 2026-09-14
      // su "honda"/moto: 117 corrispondenze, pagina 0 crescente 0 vivi, pagina 0 decrescente 14.
      // Qui si legge UNA pagina sola, quindi o si chiede il decrescente o non si trova mai niente.
      const r = await pvp.pagina(tipo, { page: 0, size: 50, testo: q, ordine: 'desc' });
      const idx = aste.indiceMarche();
      const oggi = new Date().toISOString().slice(0, 10);
      const lotti = r.lotti.map(l => leggi(l, idx, tipo));
      res.json({
        ok: true,
        // Il portale non filtra per data (il suo `dataVenditaDa` viene ignorato: misurato), e il
        // 90% del suo archivio e' passato. Si divide qui, e si dice quanti sono i passati invece
        // di buttarli in silenzio: chi cerca a mano spesso vuole sapere che esistevano.
        lotti: lotti.filter(l => l.dataVendita && l.dataVendita >= oggi),
        passati: lotti.filter(l => !l.dataVendita || l.dataVendita < oggi).length,
        totalePortale: r.totale,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: `il portale non risponde: ${senzaPercorso(e.message)}` });
    }
  });

  // ─── Il dettaglio: qui si esce verso il portale ────────────────────────────────────────────
  // REGISTRATA DOPO `/filtri` e `/portale` apposta: Express 5 non accetta piu' il vincolo
  // `:id(\d+)` nel percorso (path-to-regexp v8 l'ha tolto, e nessuna rotta del repo lo usa),
  // quindi `:id` prenderebbe anche «filtri» e «portale». L'ordine e' il vincolo, e il controllo
  // sul numero si fa qui dentro.
  app.get('/api/aste/:id', async (req, res) => {
    noCache(res);
    const id = intero(req.params.id, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return res.status(400).json({ ok: false, error: 'id non valido' });
    const nostro = magazzino.unLotto(id, testo(req.query.tipo, 8));
    const g = limitePortale.consuma(chiaveLimite(req));
    if (!g.ok) {
      return res.status(429).json({ ok: false, error: limitePortale.messaggio(g), riprovaFra: g.attesa, lotto: nostro });
    }
    try {
      const d = await pvp.dettaglio(id);
      if (!d) return res.status(404).json({ ok: false, error: 'lotto non trovato sul portale', lotto: nostro });
      res.json({ ok: true, lotto: nostro, dettaglio: dettaglioPubblico(d, pvp), url: pvp.urlAnnuncio(id) });
    } catch (e) {
      // La fonte che non risponde non e' un errore NOSTRO: 502, e intanto si serve quel che
      // abbiamo gia' in magazzino invece di lasciare la scheda vuota. Il lotto ritirato NON passa
      // di qui: `pvp.dettaglio` traduce in `null` i 4xx che parlano del lotto, e la riga qui sopra
      // lo dice per quello che e' — quello che arriva qui e' il portale davvero muto.
      res.status(502).json({ ok: false, error: `il portale non risponde: ${senzaPercorso(e.message)}`, lotto: nostro, url: pvp.urlAnnuncio(id) });
    }
  });

  // ─── Aggiornare a mano ─────────────────────────────────────────────────────────────────────
  app.post('/api/aste/aggiorna', async (req, res) => {
    noCache(res);
    // LA MACCHINA SI GUARDA PRIMA E SI ADDEBITA DOPO, e l'ordine e' il vincolo: addebitandola
    // per prima, chi ha finito i suoi tre giri e continua a premere brucerebbe il budget di
    // tutti senza far partire niente. Fra il controllo e l'addebito non c'e' nessun await,
    // quindi sul thread unico quello che si e' guardato e' quello che si paga.
    const m = limiteMacchina.stato(CHIAVE_MACCHINA);
    if (!m.ok) {
      return res.status(429).json({
        ok: false, error: limiteMacchina.messaggio(m, MSG_MACCHINA), riprovaFra: m.attesa,
        // I suoi tre giri non li ha spesi lui: dirgli «restanti: 0» sarebbe una bugia.
        restanti: limiteAggiorna.stato(chiaveLimite(req)).restanti,
      });
    }
    const g = limiteAggiorna.consuma(chiaveLimite(req));
    if (!g.ok) {
      return res.status(429).json({ ok: false, error: limiteAggiorna.messaggio(g, MSG_AGGIORNA), riprovaFra: g.attesa, restanti: 0 });
    }
    limiteMacchina.consuma(CHIAVE_MACCHINA);
    try {
      const r = await aste.giro();
      // Un giro che fallisce sulla FONTE resta un 200 con ok:false: la rotta ha funzionato,
      // e' il portale che non ha risposto. Stessa regola delle altre aree.
      res.json({ ...r, ...contorno(), restanti: limiteAggiorna.stato(chiaveLimite(req)).restanti });
    } catch (e) {
      res.status(e.code === 'ASTE_DB_KO' ? 503 : 500).json({ ok: false, error: e.message });
    }
  });
}

/**
 * Il dettaglio ripulito. Due cose vanno via prima di uscire da qui:
 *  - `soggetti`: nome, cognome, cellulare, email e CODICE FISCALE del referente. Il ministero li
 *    pubblica, noi non li ridistribuiamo — chi li vuole apre l'annuncio sul portale.
 *  - tutto il resto che non serve a decidere se andare a vedere un veicolo.
 * Gli allegati restano, con nome/tipo/peso e il link diretto: elenco e link, nessuna copia.
 */
function dettaglioPubblico(d, pvp) {
  const p = d.procedura || {};
  return {
    baseAsta: d.impoBaseAsta ?? null,
    offertaMinima: d.impoOffertaMinima ?? null,
    rialzoMinimo: d.impoOffertaAumento ?? null,
    dataVendita: aIso(d.dataVendita),
    oraVendita: d.oraVendita || null,
    // La scadenza che taglia fuori davvero: si presenta l'offerta PRIMA della vendita.
    termineOfferte: aIso(d.dataTermPresOff),
    oraTermineOfferte: d.oraTermPresOff || null,
    modalita: d.descModVendita || null,
    tipoVendita: d.descTipoVendita || null,
    procedura: p.numeRg && p.numeAnnoRg ? `${p.numeRg}/${p.numeAnnoRg}` : null,
    ufficio: p.descUfficio || null,
    // Anche qui il rito va tolto: il portale lo incolla senza spazio pure alla descrizione del
    // bene, e a schermo si leggeva «Motociclo Piaggio MedleyPer visionare la documentazione…».
    beni: (d.beni || []).map(b => ({
      descrizione: descrizionePulita(b.descrizione) || null,
      tipologia: b.descTipologiaBene || null,
      luogoRitiro: b.luogoRitiro || null,
    })),
    allegati: (d.allegati || []).map(a => ({
      nome: a.nomeFile || null,
      tipo: a.codiceTipoAllegato || null,
      descrizione: (a.descrizione || '').trim() || null,
      byte: a.dimensioneAllegato ?? null,
      url: pvp.urlAllegato(a.linkAllegato),
    })),
  };
}

module.exports = { mount, _test: { dettaglioPubblico } };
