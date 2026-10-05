'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { parseSearchParams, FONTI_PAGINA } = require('../ricerca-parametri');
const { porzioneCompleta, componiRicerca } = require('./componi-ricerca');
const { NOMI: FILTRI_AUTO } = require('../filtri-auto');
const filtriAuto = require('../filtri-auto');
const province = require('../../data/province.json');
const { creaAutorizzazioniDettagli } = require('./autorizzazioni-dettagli');
const { creaBudgetRicerca, creaLimitiRicerca, TEMPO_RICERCA_MS } = require('./limiti-ricerca');
const compat = require('./compatibilita-nodo');
const { creaRicercheHttp } = require('./ricerche-http');

const MODULI = { aziendaA: ['auto', 'moto'], aziendaB: ['moto'] };
const SETTE_GIORNI = 7 * 86400000;
const REVISIONE = 'imac-1';
const FINO_AL = 150000;
const CAMPI_RICERCA = new Set(['tipo','marca','modello','versione','prezzoMin','prezzoMax',
  'annoMin','annoMax','kmMin','kmMax','regione','raggio','mmmvAutoscout','motoitBrandSlug',
  'motoitModelSlug','motoitBikeCode','fetta','fonti','subitoMainStart','subitoRecuperoStart',
  'cvMin','cvMax', ...FILTRI_AUTO]);

function filtriAmmessi(query) {
  const out = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (!CAMPI_RICERCA.has(k)) continue;
    if (typeof v !== 'string' || v.length > 120) {
      throw Object.assign(new Error('filtro non valido'), { status: 400 });
    }
    out[k] = v;
  }
  return out;
}

function creaCentro({ tokens, directory, ora = () => Date.now(), timeoutMs = FINO_AL,
  timeoutRicercaMs = TEMPO_RICERCA_MS, oraMono = () => performance.now(),
  maxPersona = 2, maxTotale = 60,
  adminLocale = false, accountProva = null, inizializzaAccessi = null, compatibilita = null, trasporto = null }) {
  // Validare prima di aprire il registro o inizializzare altri provider.
  const limitiRicerca = creaLimitiRicerca({ timeoutMs: timeoutRicercaMs, maxPersona, maxTotale, oraMono });
  const releaseAttesa = compatibilita === null ? null : compat.valida(compatibilita);
  const revisioneRicerca = releaseAttesa ? JSON.stringify(releaseAttesa) : REVISIONE;
  if (accountProva && inizializzaAccessi) throw new Error('due provider di accesso non ammessi');
  if (trasporto && (!inizializzaAccessi || !releaseAttesa || accountProva)) {
    throw new Error('centro remoto richiede accessi verificati e release esplicita');
  }
  const sicurezza = trasporto ? require('./trasporto-prova').creaTrasporto(trasporto) : null;
  if (!tokens || !Object.keys(tokens).length || !directory
      || Object.values(tokens).some(t => typeof t !== 'string' || t.length < 32)) {
    throw new Error('token per nodo e directory necessari');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'lavori-prototipo.db'));
  db.exec('CREATE TABLE IF NOT EXISTS lavori (id TEXT PRIMARY KEY, azienda TEXT NOT NULL, operazione TEXT NOT NULL, filtri TEXT NOT NULL, stato TEXT NOT NULL, creato INTEGER NOT NULL, aggiornato INTEGER NOT NULL, nodo TEXT)');
  if (!db.prepare('PRAGMA table_info(lavori)').all().some(col => col.name === 'nodo')) {
    db.exec('ALTER TABLE lavori ADD COLUMN nodo TEXT');
  }
  for (const colonna of ['assegnazione_ms', 'coda_ms', 'nodo_ms', 'trasporto_ms', 'byte_risposta', 'http']) {
    if (!db.prepare('PRAGMA table_info(lavori)').all().some(col => col.name === colonna)) {
      db.exec(`ALTER TABLE lavori ADD COLUMN ${colonna} INTEGER`);
    }
  }
  db.exec('CREATE TABLE IF NOT EXISTS sospensioni (nodo TEXT NOT NULL, fonte TEXT NOT NULL, PRIMARY KEY (nodo, fonte))');
  db.exec('CREATE TABLE IF NOT EXISTS token_revocati (nodo TEXT NOT NULL, impronta TEXT NOT NULL, PRIMARY KEY(nodo,impronta))');
  const tokenRevocati = new Set(db.prepare('SELECT nodo,impronta FROM token_revocati').all()
    .map(r => r.nodo+':'+r.impronta));
  const improntaToken = id => crypto.createHash('sha256').update(tokens[id]).digest('hex');
  const tokenRevocato = id => typeof id !== 'string' || !Object.hasOwn(tokens,id)
    || tokenRevocati.has(id+':'+improntaToken(id));
  const stessoToken = (ricevuto, id) => {
    if (typeof ricevuto !== 'string' || tokenRevocato(id)) return false;
    const a = Buffer.from(ricevuto), b = Buffer.from(tokens[id]);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  db.exec('CREATE TABLE IF NOT EXISTS eventi (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, livello TEXT NOT NULL, codice TEXT NOT NULL, lavoro TEXT, nodo TEXT, fonte TEXT, azienda TEXT, http INTEGER)');
  db.exec('CREATE INDEX IF NOT EXISTS eventi_ts ON eventi(ts)');
  function evento(codice, { lavoro = null, nodo = null, fonte = null, azienda = null, http = null } = {}) {
    // Soltanto codici interni e identificativi controllati: mai body, annunci o messaggi della fonte.
    if (!/^[a-z_]{1,40}$/.test(codice)) throw new Error('codice evento non valido');
    try {
      db.prepare('INSERT INTO eventi(ts,livello,codice,lavoro,nodo,fonte,azienda,http) VALUES(?,?,?,?,?,?,?,?)')
        .run(ora(), ['sospensione_aggiunta','sospensione_rimossa','lavori_cancellati'].includes(codice)
          ? 'info' : codice === 'fonte_parziale' ? 'avviso' : 'errore', codice,
          lavoro, nodo, fonte, azienda, Number.isInteger(http) && http >= 100 && http <= 599 ? http : null);
    } catch { console.error('[nodi] registro eventi non disponibile'); }
  }
  const recuperati = db.prepare("UPDATE lavori SET stato=CASE WHEN stato='attesa' THEN 'interrotto' ELSE 'incerto' END, aggiornato=? WHERE stato IN ('attesa','in_corso')").run(ora()).changes;
  if (recuperati) evento('riavvio_lavori');
  const pulisci = () => {
    db.prepare('DELETE FROM lavori WHERE creato < ?').run(ora() - SETTE_GIORNI);
    db.prepare('DELETE FROM eventi WHERE ts < ?').run(ora() - SETTE_GIORNI);
    db.exec('DELETE FROM lavori WHERE rowid NOT IN (SELECT rowid FROM lavori ORDER BY creato DESC LIMIT 10000) AND stato NOT IN (\'attesa\',\'in_corso\')');
    db.exec('DELETE FROM eventi WHERE id NOT IN (SELECT id FROM eventi ORDER BY id DESC LIMIT 10000)');
  };
  pulisci();
  const pulizia = setInterval(pulisci, 3600000);
  pulizia.unref();
  let chiuso = false;
  const app = express();
  app.disable('x-powered-by');
  if (sicurezza) {
    // Nhost interroga HTTP interno senza Host pubblico o credenziali. Solo
    // questa URL esatta risponde prima dei guard; non attesta Auth/DB/fonti.
    app.use((req,res,next) => {
      if (req.url !== '/healthz' || !['GET','HEAD'].includes(req.method)) return next();
      res.set('Cache-Control','no-store');
      res.set('X-Content-Type-Options','nosniff');
      res.status(chiuso ? 503 : 200).type('text/plain').send(chiuso ? 'unavailable' : 'ok');
    });
    app.set('trust proxy',sicurezza.trustProxy);
    app.use(sicurezza.verificaTrasporto);
    app.use((req,res,next) => {
      if (req.path.startsWith('/_nodo/') && req.headers.origin === undefined
          && stessoToken(req.get('x-amr-node-token'),req.get('x-amr-node-id'))) return next();
      sicurezza.verificaOrigine(req,res,next);
    });
  }
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (!sicurezza && !/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return res.sendStatus(403);
    if (!sicurezza && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin
        && req.headers.origin !== `http://${req.headers.host}`) return res.sendStatus(403);
    next();
  });
  const nodi = new Map(), lavori = new Map(), sessioni = new Map(), condivise = new Map(), affinita = new Map();
  let sequenzaAffinita = 0;
  const epocaCentro = crypto.randomUUID();
  const autorizzazioniDettagli = creaAutorizzazioniDettagli({ ora });
  let accessi;
  try { accessi = inizializzaAccessi ? inizializzaAccessi(app) : null; }
  catch(e) { clearInterval(pulizia);db.close();throw e; }
  const nodoAutorizzato = (req, res, next) => stessoToken(req.get('x-amr-node-token'),
    req.get('x-amr-node-id'))
    ? next() : res.sendStatus(401);
  const sessione = req => {
    if (accessi) return accessi.sessione(req);
    const s = sessioni.get(/(?:^|; )amr_prova=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1]);
    return s && ora() - s.ts < 3600000 ? s : null;
  };
  async function verificaSessione(s, tipo) {
    if (accessi) {
      let c;
      try { c = await accessi.verifica(s, { tipo }); }
      catch (e) {
        if ([401, 403].includes(e.status)) throw Object.assign(new Error('accesso_interrotto'), {
          status: 403, codice: 'accesso_interrotto' });
        throw e;
      }
      if (!c.azienda || !c.aziendaValida || c.azienda !== s.azienda) {
        throw Object.assign(new Error('accesso_interrotto'), { status: 403, codice: 'accesso_interrotto' });
      }
      return c;
    }
    if (!s || s.revocata || ora() - s.ts >= 3600000) {
      throw Object.assign(new Error('accesso_interrotto'), { status: 403, codice: 'accesso_interrotto' });
    }
    if (accountProva) {
      let c;
      try { c = accountProva.contesto(s.identita, { tipo }); }
      catch (e) {
        if (e.status === 403 || e.status === 401) throw e;
        throw Object.assign(new Error('autorizzazione_non_disponibile'), { status: 503 });
      }
      if (c.azienda !== s.azienda) throw Object.assign(new Error('accesso_interrotto'), { status: 403 });
      return c;
    }
    if (tipo !== undefined && !MODULI[s.azienda]?.includes(tipo)) {
      throw Object.assign(new Error('modulo_non_autorizzato'), { status: 403 });
    }
    return { azienda: s.azienda, moduli: MODULI[s.azienda] };
  }
  async function verificaDestinatari(destinatari, budget = null) {
    budget?.controlla();
    if (!destinatari) return;
    let indisponibile = null;
    for (const verifica of destinatari) {
      budget?.controlla();
      try {
        if (budget) await budget.attendi(verifica); else await verifica();
        budget?.controlla();
        if (destinatari.has(verifica)) return;
      } catch (e) {
        budget?.controlla();
        if ([401, 403].includes(e.status)) destinatari.delete(verifica);
        else indisponibile = e;
      }
    }
    if (indisponibile) throw Object.assign(new Error('autorizzazione_non_disponibile'), { status: 503 });
    throw Object.assign(new Error('accesso_interrotto'), { status: 403, codice: 'accesso_interrotto' });
  }
  const impronta = s => crypto.createHash('sha256').update(s).digest('hex');
  const paginaDi = req => Math.min(500, Math.max(1, Number.parseInt(req.query.pagina, 10) || 1));
  function paginaLavori(req, conFiltri) {
    const pagina = paginaDi(req), nodo = typeof req.query.nodo === 'string' &&
      /^[a-zA-Z0-9_-]{1,40}$/.test(req.query.nodo) ? req.query.nodo : null;
    const dove = nodo ? ' WHERE nodo=?' : '';
    const argomenti = nodo ? [nodo] : [];
    const totale = db.prepare(`SELECT count(*) AS n FROM lavori${dove}`).get(...argomenti).n;
    const colonne = 'id,azienda,operazione,stato,creato,aggiornato,nodo,assegnazione_ms,coda_ms,nodo_ms,trasporto_ms,byte_risposta,http'
      + (conFiltri ? ',filtri' : '');
    const righe = db.prepare(`SELECT ${colonne} FROM lavori${dove} ORDER BY creato DESC, rowid DESC LIMIT 20 OFFSET ?`)
      .all(...argomenti, (pagina - 1) * 20);
    return { lavori: conFiltri ? righe.map(r => ({ ...r, filtri: JSON.parse(r.filtri) })) : righe,
      pagina, pagine: Math.max(1, Math.ceil(totale / 20)), totale };
  }
  function registra(lavoro, stato) {
    db.prepare(`INSERT INTO lavori(id,azienda,operazione,filtri,stato,creato,aggiornato,nodo,
      assegnazione_ms,coda_ms,nodo_ms,trasporto_ms,byte_risposta,http)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      stato=excluded.stato, aggiornato=excluded.aggiornato, nodo=excluded.nodo,
      assegnazione_ms=excluded.assegnazione_ms, coda_ms=excluded.coda_ms,
      nodo_ms=excluded.nodo_ms, trasporto_ms=excluded.trasporto_ms,
      byte_risposta=excluded.byte_risposta, http=excluded.http`)
      .run(lavoro.idLavoro, lavoro.azienda, lavoro.operazione,
        JSON.stringify(lavoro.operazione === 'dettaglio'
          ? { urlHash: impronta(lavoro.input.url) }
          : lavoro.operazione === 'componi'
            ? { fonti: Object.keys(lavoro.input.sostituzioni || {}) } : lavoro.input),
        stato, lavoro.creato, ora(), lavoro.nodoAssegnato || null,
        lavoro.assegnazioneMs ?? null, lavoro.codaMs ?? null, lavoro.nodoMs ?? null,
        lavoro.trasportoMs ?? null, lavoro.byteRisposta ?? null, lavoro.http ?? null);
    if (['incerto', 'interrotto', 'errore'].includes(stato)) evento('lavoro_' + stato,
      { lavoro: lavoro.idLavoro, nodo: lavoro.nodoAssegnato, fonte: lavoro.fonte,
        azienda: lavoro.azienda, http: lavoro.http });
  }
  function segnalaFonti(job, esito) {
    if (job.operazione === 'componi' || esito.status !== 200 || !esito.body?.sources) return;
    for (const [fonte, s] of Object.entries(esito.body.sources)) {
      if (!FONTI_PAGINA.includes(fonte) || !s) continue;
      const codice = s.erroreHttp === 429 ? 'fonte_limitata'
        : ['error', 'timeout'].includes(s.status) ? 'fonte_errore'
          : s.parzialeRete || s.parziale ? 'fonte_parziale' : null;
      if (codice) evento(codice, { lavoro: job.idLavoro, nodo: job.nodoAssegnato,
        fonte, azienda: job.azienda, http: s.erroreHttp });
    }
  }
  function disponibile(n, fonte = null, consideraCoda = true) {
    if (!n || tokenRevocato(n.id) || ora() - n.visto > 6000 || !releaseValida(n) || n.sospeso || n.soloStato
        || (consideraCoda && n.coda.length >= 10)) return false;
    return !fonte || (!n.sospese.has(fonte) && !n.fonti[fonte]?.fermo);
  }
  function releaseValida(n) {
    return releaseAttesa ? compat.compatibile(releaseAttesa, n?.compatibilita) : n?.revisione === REVISIONE;
  }
  function assegna(selezione, lavoro, limite = timeoutMs) {
    const avvia = () => {
      const budget = lavoro.ricerca?.budget;
      budget?.controlla();
      if (budget) limite = Math.min(limite, budget.restante());
      // Scelta e accodamento sono sincroni dopo la verifica dei permessi.
      const n = typeof selezione === 'function' ? selezione() : selezione;
      // Dopo l'attesa dei permessi, sospensione/scadenza del nodo possono essere cambiate.
      if (chiuso || !disponibile(n) || n.id === lavoro.nodoEscluso
          || fontiDelLavoro(lavoro).some(f => !disponibile(n, f))) {
        throw Object.assign(new Error('nodo non disponibile'), { status: 503 });
      }
      return new Promise((resolve, reject) => {
        const record = { ...lavoro, nodoAssegnato: n.id, tentativo: 1, creato: ora(),
          accodatoMono: performance.now(), iniziato: false, resolve, reject };
        const timer = setTimeout(() => {
          if (!lavori.has(record.idLavoro)) return;
          lavori.delete(record.idLavoro);
          const attuale = nodi.get(record.nodoAssegnato);
          if (attuale) {
            attuale.coda = attuale.coda.filter(x => x !== record);
            if (record.iniziato) attuale.occupato = false;
          }
          registra(record, record.iniziato ? 'incerto' : 'interrotto');
          reject(Object.assign(new Error(record.iniziato ? 'esito incerto: nodo senza risposta' : 'nodo non disponibile'),
            { incerto: record.iniziato, interrotto: !record.iniziato }));
        }, limite);
        record.timer = timer;
        lavori.set(record.idLavoro, record);
        n.coda.push(record);
        registra(record, 'attesa');
      });
    };
    return lavoro.destinatari ? verificaDestinatari(lavoro.destinatari, lavoro.ricerca?.budget).then(avvia) : avvia();
  }
  const carico = n => n.coda.length + Number(!!n.occupato);
  function sceglie(fonti, escluso = null, idoneo = () => true) {
    return [...nodi.values()].filter(n => n.id !== escluso && !n.simulato && disponibile(n) && idoneo(n))
      .sort((a, b) => fonti.filter(f => disponibile(b, f)).length
        - fonti.filter(f => disponibile(a, f)).length || carico(a) - carico(b))[0] || null;
  }
  function nodoPerFonte(fonte) {
    return sceglie([fonte], null, n => disponibile(n, fonte));
  }
  function fontiDelLavoro(job) {
    if (job.operazione === 'fonte' || job.operazione === 'dettaglio') return [job.fonte];
    if (job.operazione !== 'ricerca') return [];
    return job.input.fonti?.split(',')
      || (job.input.tipo === 'auto' ? ['subito', 'autoscout'] : FONTI_PAGINA);
  }
  function interrompiAccodati(n, fonte = null, bloccato = null) {
    n.coda = n.coda.filter(job => {
      const esito = bloccato ? bloccato(job) : !fonte || fontiDelLavoro(job).includes(fonte);
      if (!esito) return true;
      lavori.delete(job.idLavoro);
      clearTimeout(job.timer);
      registra(job, 'interrotto');
      job.reject(esito instanceof Error ? esito : Object.assign(new Error('lavoro non avviato: nodo o fonte sospesa'),
        { interrotto: true }));
      return false;
    });
  }
  function destinatarioHttp(req, res, tipo) {
    const destinatari = new Set();
    const verifica = async () => {
      if (res.destroyed) throw Object.assign(new Error('richiesta interrotta'), { interrotto: true });
      await verificaSessione(req.sessioneProva, tipo);
      if (res.destroyed) throw Object.assign(new Error('richiesta interrotta'), { interrotto: true });
    };
    destinatari.add(verifica);
    const abbandona = () => {
      if (res.writableEnded) return;
      destinatari.delete(verifica);
      // Il browser non attende più: ritirare solo i lavori non ancora consegnati.
      for (const n of nodi.values()) interrompiAccodati(n, null, job =>
        job.destinatari === destinatari ? Object.assign(new Error('richiesta interrotta'), { interrotto: true }) : false);
    };
    res.once('close', abbandona);
    if (res.destroyed) abbandona();
    return { destinatari, termina: () => res.removeListener('close', abbandona) };
  }
  const controlloNodi = setInterval(() => {
    for (const job of lavori.values()) {
      if (job.ricerca && (!job.ricerca.destinatari.size || job.ricerca.budget.signal.aborted)) continue;
      const n = nodi.get(job.nodoAssegnato);
      if (n && ora() - n.visto <= 6000) continue;
      if (!job.iniziato) {
        const richieste = fontiDelLavoro(job);
        const alternativo = sceglie(richieste, job.nodoAssegnato,
          x => x.id !== job.nodoEscluso && richieste.every(f => disponibile(x, f)));
        if (alternativo && alternativo.id !== job.nodoAssegnato) {
          if (n) n.coda = n.coda.filter(x => x !== job);
          job.nodoAssegnato = alternativo.id;
          alternativo.coda.push(job);
          continue;
        }
      }
      lavori.delete(job.idLavoro);
      clearTimeout(job.timer);
      if (n) { n.coda = n.coda.filter(x => x !== job); if (job.iniziato) n.occupato = false; }
      registra(job, job.iniziato ? 'incerto' : 'interrotto');
      job.reject(Object.assign(new Error(job.iniziato ? 'esito incerto: nodo disconnesso'
        : 'nodo non disponibile'), { incerto: job.iniziato, interrotto: !job.iniziato }));
    }
  }, 1000);
  controlloNodi.unref();
  function chiaveAffinita(azienda, input) {
    return azienda + ':' + revisioneRicerca + ':' + JSON.stringify(Object.entries(input)
      .filter(([k]) => !['fetta','fonti','subitoMainStart','subitoRecuperoStart'].includes(k))
      .sort(([a], [b]) => a.localeCompare(b)));
  }
  async function ricercaSenzaCondivisione(azienda, input, ricerca) {
    const { budget } = ricerca;
    const destinatari = ricerca.verifica ? ricerca.destinatari : null;
    budget.controlla();
    const parsed = parseSearchParams(input);
    if (parsed.errors) return { status: 400, body: { error: parsed.errors.join(', ') } };
    const fonti = parsed.params.tipo === 'auto' ? ['subito', 'autoscout'] : FONTI_PAGINA;
    const richieste = input.fonti ? input.fonti.split(',') : fonti;
    const chiave = chiaveAffinita(azienda, input);
    const precedente = affinita.get(chiave);
    const ancoraValida = precedente && ora() - precedente.ts < 30 * 60000;
    const vincoloPagina = ancoraValida && (Number(input.fetta || 0) > 0
      || Number(input.fetta) === 0 && !!input.fonti);
    const preferito = vincoloPagina ? nodi.get(precedente.fonti[richieste[0]]) : null;
    const assegnazioneDa = performance.now();
    const assegnabili = n => richieste.filter(f => disponibile(n, f)
      && (!vincoloPagina || !precedente.fonti[f] || precedente.fonti[f] === n.id
        || !disponibile(nodi.get(precedente.fonti[f]), f)));
    let suPrimario;
    const lavoroBase = { idLavoro: crypto.randomUUID(), azienda,
      operazione: 'ricerca', destinatari, ricerca,
      assegnazioneMs: Math.round(performance.now() - assegnazioneDa) };
    const selezionaPrimario = () => {
      // Nodo, fonti e query devono fotografare lo stesso stato dopo i permessi.
      const primario = preferito && !preferito.simulato && assegnabili(preferito).length
        ? preferito : sceglie(richieste, null, n => assegnabili(n).length > 0);
      if (!primario) return null;
      suPrimario = assegnabili(primario);
      const query = { ...input };
      if (suPrimario.length !== richieste.length) {
        query.fonti = suPrimario.join(','); query.fetta = String(query.fetta ?? 0);
      }
      if (!suPrimario.includes('subito')) {
        delete query.subitoMainStart;
        delete query.subitoRecuperoStart;
      }
      lavoroBase.input = query;
      return primario;
    };
    const base = await budget.attendi(() => assegna(selezionaPrimario, lavoroBase));
    if (base.status !== 200) return base;
    if (!base.body || !Array.isArray(base.body.risultati) || !base.body.sources
        || richieste.some(f => typeof base.body.sources[f]?.status !== 'string')) {
      return { status: 502, body: { error: 'risposta di ricerca non valida dal nodo' } };
    }
    const sostituzioni = {}, avvisi = [], assegnate = {}, fallite = {};
    function fallimentoOmessa(fonte, reason, stato = {}) {
      if (suPrimario.includes(fonte)) return;
      // Nessuna riga delegata consegnata: non avanzare con i cursori di una porzione scartata.
      fallite[fonte] = { status: stato.status === 'timeout' ? 'timeout' : 'error',
        reason: (stato.status !== 'skipped' && stato.reason) || stato.parziale || reason,
        count: 0, totale: null, hasMore: null,
        ...Object.fromEntries(['erroreTipo', 'erroreHttp', 'erroreCodice', 'pausa', 'incerto', 'interrotto']
          .filter(k => stato[k] !== undefined).map(k => [k, stato[k]])) };
    }
    const esecutoreBase = base.nodoEsecutore;
    for (const f of suPrimario) assegnate[f] = esecutoreBase;
    if (ancoraValida) for (const f of suPrimario) {
      if (precedente.fonti[f] && precedente.fonti[f] !== esecutoreBase) {
        avvisi.push(`${f}: pagina richiesta su un altro nodo; la copertura può cambiare`);
      }
    }
    for (const fonte of richieste) {
      const s = base.body.sources?.[fonte];
      const daAlternativo = !suPrimario.includes(fonte) || s?.erroreHttp === 429;
      if (!daAlternativo) continue;
      await verificaDestinatari(destinatari, budget);
      const assegnazioneFonteDa = performance.now();
      const selezionaAlternativo = () => {
        const primaScelta = ancoraValida ? nodi.get(precedente.fonti[fonte]) : null;
        return primaScelta && primaScelta.id !== esecutoreBase && !primaScelta.simulato
          && disponibile(primaScelta, fonte) ? primaScelta
          : sceglie([fonte], esecutoreBase, n => disponibile(n, fonte))
            || [...nodi.values()].find(n => n.id !== esecutoreBase && n.simulato && disponibile(n, fonte));
      };
      const alternativo = selezionaAlternativo();
      if (!alternativo) {
        avvisi.push(`${fonte}: nessun nodo alternativo disponibile`);
        fallimentoOmessa(fonte, 'nessun nodo alternativo disponibile', s);
        continue;
      }
      let alternativa;
      try {
        alternativa = await budget.attendi(() => assegna(selezionaAlternativo, { idLavoro: crypto.randomUUID(), azienda,
          operazione: 'fonte', fonte, input, destinatari, ricerca, nodoEscluso: esecutoreBase,
          assegnazioneMs: Math.round(performance.now() - assegnazioneFonteDa) }, Math.min(timeoutMs, 50000)));
      } catch (e) {
        budget.controlla();
        avvisi.push(`${fonte}: secondo nodo senza conferma; esito ${e.incerto ? 'incerto' : 'non disponibile'}`);
        fallimentoOmessa(fonte, `secondo nodo senza conferma; esito ${e.incerto ? 'incerto' : 'non disponibile'}`,
          { ...s, ...(e.incerto !== undefined ? { incerto: e.incerto } : {}),
            ...(e.interrotto !== undefined ? { interrotto: e.interrotto } : {}) });
        continue;
      }
      if (alternativa.status === 200 && porzioneCompleta(alternativa.body, fonte)) {
        sostituzioni[fonte] = alternativa.body;
        assegnate[fonte] = alternativa.nodoEsecutore;
        if (ancoraValida && precedente.fonti[fonte] && precedente.fonti[fonte] !== alternativa.nodoEsecutore) {
          avvisi.push(`${fonte}: pagina richiesta su un altro nodo; la copertura può cambiare`);
        }
      } else {
        avvisi.push(nodi.get(alternativa.nodoEsecutore)?.simulato
          ? `${fonte}: nodo simulato, nessun portale interrogato` : `${fonte}: nodo alternativo senza risultato completo`);
        fallimentoOmessa(fonte, 'nodo alternativo senza risultato completo', {
          ...s, ...Object.fromEntries(['incerto', 'interrotto'].filter(k => alternativa.body[k] !== undefined)
            .map(k => [k, alternativa.body[k]])),
          ...(alternativa.status >= 400 ? { erroreHttp: alternativa.status } : {}),
          ...alternativa.body.sources?.[fonte] });
      }
    }
    function termina(body) {
      budget.controlla();
      const datoAffinita = { ts: ora(), sequenza: ++sequenzaAffinita,
        fonti: { ...(ancoraValida ? precedente.fonti : {}), ...assegnate } };
      function registraAffinita(aziendaDestinataria) {
        const key = chiaveAffinita(aziendaDestinataria, input);
        // Un esito vecchio può essere consultato dopo una ricerca più recente.
        if (affinita.get(key)?.sequenza > datoAffinita.sequenza) return;
        affinita.set(key, datoAffinita);
        while (affinita.size > 100) affinita.delete(affinita.keys().next().value);
      }
      if (!destinatari) registraAffinita(azienda);
      // La rotta registra solo dopo il controllo finale del singolo destinatario.
      // Un controllo lento/revocato non trattiene la risposta degli altri.
      return { status: 200, body: { ...body, sources: { ...body.sources, ...fallite },
        ...(fallite.subito ? { subitoStatus: fallite.subito.status, subitoReason: fallite.subito.reason } : {}),
        avvisiNodi: avvisi }, registraAffinita };
    }
    if (!Object.keys(sostituzioni).length) return termina(base.body);
    return termina(componiRicerca(base.body, sostituzioni));
  }

  function ricerca(azienda, query, verifica = null, richiesta = null) {
    if ((accountProva || accessi) && !verifica) throw Object.assign(new Error('identita_richiesta'), { status: 401 });
    const budgetRichiesta = richiesta?.budget || creaBudgetRicerca({ timeoutMs: timeoutRicercaMs, oraMono });
    const verificaAttiva = richiesta ? () => richiesta.verifica(verifica)
      : verifica || (() => ({ azienda }));
    const avvia = () => {
      budgetRichiesta.controlla();
      if (chiuso) throw Object.assign(new Error('centro interrotto'), { status: 503 });
      const input = filtriAmmessi(query);
      const prima = Number(input.fetta || 0) === 0 && !input.fonti
        && input.subitoMainStart == null && input.subitoRecuperoStart == null;
      const chiave = prima ? revisioneRicerca + ':' + JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))) : null;
      let voce = prima ? condivise.get(chiave) : null;
      const esistente = voce && !voce.budget.signal.aborted;
      let meta;
      if (esistente) {
        meta = { idLavoro: crypto.randomUUID(), azienda, operazione: 'condivisa', input,
          creato: ora() };
        registra(meta, 'in_corso');
      } else {
        voce = { budget: creaBudgetRicerca({ scadeAl: budgetRichiesta.scadeAl, oraMono }),
          destinatari: new Set([verificaAttiva]), avviati: new Set(), verifica: !!verifica };
        const operazione = voce;
        operazione.budget.signal.addEventListener('abort', () => {
          if (prima && condivise.get(chiave) === operazione) condivise.delete(chiave);
          for (const n of nodi.values()) interrompiAccodati(n, null,
            job => job.ricerca === operazione ? operazione.budget.signal.reason : false);
        }, { once: true });
        voce.promessa = voce.budget.attendi(() => ricercaSenzaCondivisione(azienda, input, operazione));
        if (prima) condivise.set(chiave, voce);
        voce.promessa.finally(() => {
          operazione.budget.chiudi();
          if (prima && condivise.get(chiave) === operazione) condivise.delete(chiave);
        }).catch(() => {});
      }
      voce.destinatari.add(verificaAttiva);
      if (richiesta) richiesta.operazione = voce;
      const rimuovi = () => {
        voce.destinatari.delete(verificaAttiva);
        if (!voce.destinatari.size) voce.budget.interrompi();
      };
      budgetRichiesta.signal.addEventListener('abort', rimuovi, { once: true });
      return budgetRichiesta.attendi(() => voce.promessa).then(r => {
        if (meta && !chiuso) registra(meta, r.status === 200 ? 'concluso' : 'errore');
        return r;
      }, e => {
        if (meta && !chiuso) registra(meta, e.incerto || voce.avviati.size ? 'incerto'
          : ['ricerca_scaduta', 'ricerca_abbandonata'].includes(e.codice) ? 'interrotto' : 'errore');
        throw e;
      }).finally(() => {
        budgetRichiesta.signal.removeEventListener('abort', rimuovi); rimuovi();
      });
    };
    let promessa;
    try { promessa = verifica ? budgetRichiesta.attendi(verificaAttiva).then(avvia) : avvia(); }
    catch (e) { if (!richiesta) budgetRichiesta.chiudi(); throw e; }
    const out = promessa.finally(() => { if (!richiesta) budgetRichiesta.chiudi(); });
    // Il chiamante locale può osservare l'esito soltanto dopo il prossimo heartbeat.
    out.catch(() => {});
    return out;
  }

  app.use('/_nodo', nodoAutorizzato, express.json({ limit: '8mb' }));
  app.get('/_nodo/registrazione', (req, res) => res.json({ epoca: epocaCentro,
    boot: nodi.get(req.get('x-amr-node-id'))?.boot || null,
    ...(releaseAttesa ? { compatibilita: releaseAttesa } : {}) }));
  app.post('/_nodo/registrazione', (req, res) => {
    const id = req.get('x-amr-node-id'), { epoca, boot, precedente } = req.body || {};
    if (releaseAttesa && !compat.compatibile(releaseAttesa, req.body?.compatibilita)) {
      const precedente = nodi.get(id);
      if (precedente) precedente.compatibilita = null;
      return res.sendStatus(409);
    }
    if (epoca !== epocaCentro || !/^[a-f0-9-]{36}$/.test(boot || '')) return res.sendStatus(409);
    let n = nodi.get(id);
    if (n?.boot === boot) return res.json({ ok: true });
    if ((n?.boot || null) !== precedente) return res.sendStatus(409);
    if (!n) {
      const sospensioni = db.prepare('SELECT fonte FROM sospensioni WHERE nodo=?').all(id).map(r => r.fonte);
      n = { id, coda: [], sospese: new Set(sospensioni.filter(Boolean)), sospeso: sospensioni.includes('') };
      nodi.set(id, n);
    }
    n.boot = boot; n.sequenza = 0; n.visto = 0;
    n.compatibilita = releaseAttesa ? compat.valida(req.body.compatibilita) : null;
    res.json({ ok: true });
  });
  function bootValido(req) {
    const n = nodi.get(req.get('x-amr-node-id'));
    if (releaseAttesa && (!n?.boot || req.get('x-amr-node-boot') !== n.boot
        || req.get('x-amr-center-epoch') !== epocaCentro)) return false;
    if ((n?.boot || req.get('x-amr-node-boot') || req.get('x-amr-center-epoch'))
        && (!n?.boot || req.get('x-amr-node-boot') !== n.boot || req.get('x-amr-center-epoch') !== epocaCentro)) {
      return false;
    }
    return true;
  }
  const bootObsoleto = res => res.set('x-amr-node-obsoleto', '1').sendStatus(409);
  app.use('/_nodo', (req, res, next) => {
    if (!bootValido(req)) return bootObsoleto(res);
    next();
  });
  app.post('/_nodo/heartbeat', (req, res) => {
    const { id, revisione, fonti, occupato, idLavoroAttivo, simulato, soloStato } = req.body || {};
    if (id !== req.get('x-amr-node-id')) return res.sendStatus(403);
    if (releaseAttesa && !compat.compatibile(releaseAttesa, req.body?.compatibilita)) {
      const precedente = nodi.get(id);
      if (precedente) precedente.compatibilita = null;
      return res.sendStatus(409);
    }
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id || '') || !fonti || typeof fonti !== 'object'
        || (soloStato !== undefined && typeof soloStato !== 'boolean')) return res.sendStatus(400);
    let n = nodi.get(id);
    if (n?.boot) {
      const seq = req.body.sequenza;
      if (!Number.isSafeInteger(seq) || seq < 1) return res.sendStatus(400);
      if (seq <= n.sequenza) return res.json({ ok: true, accepted: false });
      n.sequenza = seq;
    }
    if (!n) {
      const sospensioni = db.prepare('SELECT fonte FROM sospensioni WHERE nodo=?').all(id).map(r => r.fonte);
      n = { id, coda: [], sospese: new Set(sospensioni.filter(Boolean)),
        sospeso: sospensioni.includes('') };
      nodi.set(id, n);
    }
    const avviato = [...lavori.values()].find(j => j.nodoAssegnato === id && j.iniziato);
    if (avviato && avviato.idLavoro !== idLavoroAttivo) {
      lavori.delete(avviato.idLavoro);
      clearTimeout(avviato.timer);
      registra(avviato, 'incerto');
      avviato.reject(Object.assign(new Error('esito incerto: worker riavviato'), { incerto: true }));
    }
    n.visto = ora(); n.revisione = revisione; n.fonti = fonti; n.simulato = !!simulato;
    n.soloStato = !!soloStato;
    n.compatibilita = releaseAttesa ? compat.valida(req.body.compatibilita) : null;
    n.occupato = !!occupato;
    if (n.soloStato) interrompiAccodati(n);
    res.json({ ok: true });
  });
  app.get('/_nodo/poll', async (req, res) => {
    if (req.query.id !== req.get('x-amr-node-id')) return res.sendStatus(403);
    const n = nodi.get(req.query.id);
    if (chiuso) return res.sendStatus(503);
    if (!n || ora() - n.visto > 6000 || !releaseValida(n)) return res.sendStatus(409);
    if (n.occupato || n.sospeso || n.soloStato || n.pollInCorso) return res.sendStatus(204);
    n.pollInCorso = true;
    try {
      interrompiAccodati(n, null, job => fontiDelLavoro(job)
        .some(f => n.sospese.has(f) || n.fonti[f]?.fermo));
      let job;
      while ((job = n.coda[0])) {
        if (res.destroyed || res.writableEnded) return;
        try {
          await verificaDestinatari(job.destinatari, job.ricerca?.budget);
          job.ricerca?.budget.controlla();
        }
        catch (e) {
          if (!bootValido(req)) return bootObsoleto(res);
          if (chiuso) return res.sendStatus(503);
          if (lavori.get(job.idLavoro) === job) interrompiAccodati(n, null, x => x === job ? e : false);
          continue;
        }
        if (!bootValido(req)) return bootObsoleto(res);
        if (chiuso) return res.sendStatus(503);
        // Una verifica può durare più del poll del worker: nessuna consegna
        // al socket chiuso e nessun avvio presunto. Il job resta in coda.
        if (res.destroyed || res.writableEnded) return;
        // Il timer, una sospensione o una disconnessione possono rimuovere il record durante l'await.
        if (lavori.get(job.idLavoro) !== job || n.coda[0] !== job) continue;
        if (n.occupato || !disponibile(n, null, false) || fontiDelLavoro(job).some(f => !disponibile(n, f, false))) {
          return res.sendStatus(204);
        }
        n.coda.shift(); break;
      }
      if (!job) return res.sendStatus(204);
      n.occupato = true; job.iniziato = true;
      job.ricerca?.avviati.add(job.idLavoro);
      job.iniziatoMono = performance.now();
      job.codaMs = Math.round(job.iniziatoMono - job.accodatoMono);
      registra(job, 'in_corso');
      res.json({ versioneProtocollo: 1, idLavoro: job.idLavoro, tentativo: job.tentativo,
        azienda: job.azienda, operazione: job.operazione, fonte: job.fonte, input: job.input,
        ...(job.operazione === 'modelli' ? { fontiSospese: [...n.sospese] } : {}) });
    } finally { n.pollInCorso = false; }
  });
  app.post('/_nodo/esito', (req, res) => {
    const { id, idLavoro, tentativo, esito, durataMs } = req.body || {};
    if (id !== req.get('x-amr-node-id')) return res.sendStatus(403);
    const job = lavori.get(idLavoro);
    if (!job || job.nodoAssegnato !== id || job.tentativo !== tentativo || !job.iniziato) return res.sendStatus(409);
    if (!esito || !Number.isInteger(esito.status) || !esito.body
        || typeof esito.body !== 'object' || Array.isArray(esito.body)) return res.sendStatus(400);
    const dalPoll = performance.now() - job.iniziatoMono;
    if (Number.isInteger(durataMs) && durataMs >= 0 && durataMs <= dalPoll + 2) {
      job.nodoMs = durataMs;
      job.trasportoMs = Math.max(0, Math.round(dalPoll - durataMs));
    }
    const lunghezza = req.get('content-length');
    const byte = lunghezza == null ? NaN : Number(lunghezza);
    job.byteRisposta = Number.isSafeInteger(byte) && byte >= 0 ? byte : null;
    job.http = esito.status;
    lavori.delete(idLavoro); clearTimeout(job.timer);
    nodi.get(id).occupato = false;
    job.ricerca?.avviati.delete(idLavoro);
    registra(job, esito.status === 200 ? 'concluso' : 'errore');
    segnalaFonti(job, esito);
    // Metadato interno autorevole, dopo token/boot/epoch e CAS del job.
    job.resolve({ status: esito.status, body: esito.body, nodoEsecutore: job.nodoAssegnato });
    res.json({ ok: true });
  });

  app.get('/api/test/config', (req, res) => res.json({ accesso: accessi ? 'nhost' : 'sintetico' }));
  app.post('/api/test/login', express.json({ limit: '1kb' }), (req, res) => {
    if (accessi) return res.sendStatus(404);
    const azienda = req.body?.azienda;
    let identita = null, contesto = null;
    if (accountProva) {
      try {
        identita = accountProva.sessione(req.body?.persona);
        try { contesto = accountProva.contesto(identita); }
        catch (e) { if (e.codice !== 'azienda_non_autorizzata') throw e; }
      } catch (e) { return res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' }); }
    } else if (typeof azienda !== 'string' || !Object.hasOwn(MODULI, azienda)) return res.sendStatus(400);
    const cookie = crypto.randomBytes(24).toString('hex');
    sessioni.set(cookie, { azienda: accountProva ? contesto?.azienda : azienda,
      identita, ts: ora() });
    if (sessioni.size > 50) {
      const prima = sessioni.keys().next().value;
      sessioni.get(prima).revocata = true;
      sessioni.delete(prima);
    }
    res.cookie('amr_prova', cookie, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json(accountProva ? { azienda: contesto?.azienda, moduli: contesto?.moduli || [] }
      : { azienda, moduli: MODULI[azienda] });
  });
  if (accountProva) require('./account-prova-route').mount(app, { account: accountProva, sessione,
    listaSessioni: persona => [...sessioni].filter(([, s]) => {
      if (s.identita?.persona !== persona || s.revocata || ora() - s.ts >= 3600000) return false;
      try { accountProva.verificaIdentita(s.identita); return true; }
      catch (e) { if (e.status === 403) return false; throw e; }
    }).map(([cookie, s]) => ({ id: impronta(cookie), creato: s.ts })),
    revocaSessione: (persona, id) => {
      for (const [cookie, s] of sessioni) {
        if (s.identita?.persona !== persona || impronta(cookie) !== id) continue;
        s.revocata = true;
        sessioni.delete(cookie);
        return true;
      }
      return false;
    } });
  async function adminDiProva(req, res, next) {
    if (accessi) {
      try { await accessi.verifica(sessione(req), { admin: true }); return next(); }
      catch (e) { return res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' }); }
    }
    if (!accountProva) return next();
    try {
      accountProva.contesto(sessione(req)?.identita, { admin: true });
      next();
    } catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' }); }
  }
  app.use('/api/stato', adminDiProva);
  const statoNodo = n => ({ id:n.id, online:!tokenRevocato(n.id) && ora()-n.visto<6000,
    autorizzato:!tokenRevocato(n.id), compatibile:releaseValida(n), occupato:n.occupato,
    simulato:n.simulato,...(n.soloStato ? { soloStato: true } : {}),
    sospeso:n.sospeso,sospese:[...n.sospese],fonti:n.fonti });
  app.get('/api/stato', (req, res) => {
    pulisci();
    const nodo = typeof req.query.nodo === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(req.query.nodo)
      ? req.query.nodo : null;
    res.json({ nodi: [...nodi.values()].filter(n => !nodo || n.id === nodo).map(statoNodo),
    ...paginaLavori(req, false), lavoriAttivi: nodo
      ? db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso') AND nodo=?").get(nodo).n
      : db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso')").get().n });
  });
  app.use('/api/admin', adminDiProva, (req, res, next) => {
    if (!adminLocale && !(sicurezza && accessi)) return res.sendStatus(404);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        && req.get('x-amr-local-admin') !== '1') return res.sendStatus(403);
    next();
  });
  app.get('/api/admin', (req, res) => {
    pulisci();
    const nodo = typeof req.query.nodo === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(req.query.nodo)
      ? req.query.nodo : null;
    res.json({ nodi: [...nodi.values()].filter(n => !nodo || n.id === nodo).map(statoNodo),
      ...paginaLavori(req, true),
      lavoriAttivi: nodo
        ? db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso') AND nodo=?").get(nodo).n
        : db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso')").get().n,
      eventi: nodo
        ? db.prepare('SELECT ts,livello,codice,lavoro,nodo,fonte,azienda,http FROM eventi WHERE nodo=? ORDER BY id DESC LIMIT 30').all(nodo)
        : db.prepare('SELECT ts,livello,codice,lavoro,nodo,fonte,azienda,http FROM eventi ORDER BY id DESC LIMIT 30').all() });
  });
  app.get('/api/admin/esporta', (req, res) => {
    pulisci();
    res.set('Content-Disposition', 'attachment; filename="amr-nodi-log.json"');
    res.json({ generato: new Date(ora()).toISOString(),
      lavori: db.prepare('SELECT id,azienda,operazione,filtri,stato,creato,aggiornato,nodo,assegnazione_ms,coda_ms,nodo_ms,trasporto_ms,byte_risposta,http FROM lavori ORDER BY creato DESC').all()
        .map(r => ({ ...r, filtri: JSON.parse(r.filtri) })),
      eventi: db.prepare('SELECT ts,livello,codice,lavoro,nodo,fonte,azienda,http FROM eventi ORDER BY id DESC').all() });
  });
  app.delete('/api/admin/lavori', (req, res) => {
    const rimossi = db.prepare("DELETE FROM lavori WHERE stato NOT IN ('attesa','in_corso')").run().changes;
    evento('lavori_cancellati');
    res.json({ ok: true, rimossi });
  });
  app.post('/api/admin/nodi/:id', express.json({ limit: '1kb' }), adminDiProva, (req, res) => {
    const n = nodi.get(req.params.id);
    if (!n) return res.sendStatus(404);
    const { sospeso, fonte } = req.body || {};
    if (fonte && !FONTI_PAGINA.includes(fonte)) return res.sendStatus(400);
    if (typeof sospeso !== 'boolean') return res.sendStatus(400);
    if (fonte) sospeso ? n.sospese.add(fonte) : n.sospese.delete(fonte);
    else n.sospeso = sospeso;
    if (sospeso) db.prepare('INSERT OR IGNORE INTO sospensioni(nodo,fonte) VALUES(?,?)').run(n.id, fonte || '');
    else db.prepare('DELETE FROM sospensioni WHERE nodo=? AND fonte=?').run(n.id, fonte || '');
    if (sospeso) interrompiAccodati(n, fonte || null);
    evento(sospeso ? 'sospensione_aggiunta' : 'sospensione_rimossa', { nodo: n.id, fonte: fonte || null });
    res.json({ ok: true });
  });
  app.post('/api/admin/nodi/:id/revoca-token', express.json({limit:'1kb'}), adminDiProva, (req,res) => {
    const id=req.params.id;
    if (!Object.hasOwn(tokens,id)) return res.sendStatus(404);
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length) return res.sendStatus(400);
    db.prepare('INSERT OR IGNORE INTO token_revocati(nodo,impronta) VALUES(?,?)').run(id,improntaToken(id));
    tokenRevocati.add(id+':'+improntaToken(id));
    const n=nodi.get(id);
    if(n) interrompiAccodati(n);
    for(const job of lavori.values()) if(job.nodoAssegnato===id) {
      lavori.delete(job.idLavoro);clearTimeout(job.timer);registra(job,'incerto');
      job.reject(Object.assign(new Error('credenziale nodo revocata: esito incerto'),{incerto:true}));
    }
    evento('credenziale_revocata',{nodo:id});
    res.json({ok:true});
  });
  const ricercheHttp = creaRicercheHttp({ sessione, verifica: async (s, tipo) => {
    const c = await verificaSessione(s, tipo);
    if (!c.moduli.includes(tipo)) throw Object.assign(new Error('accesso_interrotto'), { status: 403 });
    return c;
  },
    limiti: limitiRicerca, ricerca, ora,
    valida: input => {
      const query = filtriAmmessi(input), parsed = parseSearchParams(query);
      if (parsed.errors) throw Object.assign(new Error('ricerca_non_valida'), { status: 400, codice: 'ricerca_non_valida' });
      return query;
    },
    consegna: (body, s, tipo) => ({ ...body, risultati: (body.risultati || [])
      .map(r => ({ ...r, accessoDettagli: autorizzazioniDettagli.emetti(s, r.url, tipo) })) }),
  });
  ricercheHttp.mount(app);
  function erroreRicerca(req, res, e) {
    if (res.destroyed || res.writableEnded) return;
    const incerto = !!e.incerto || (e.codice === 'ricerca_scaduta' && !!req.limiteRicerca?.operazione?.avviati.size);
    res.status([400, 403, 429, 504].includes(e.status) ? e.status : incerto ? 504 : 503)
      .json({ error: e.status === 403 ? 'accesso_interrotto' : e.message,
        ...(e.codice ? { codice: e.codice } : {}),
        interrotto: !incerto && (!!e.interrotto || e.status === 403 || ['ricerca_scaduta', 'ricerca_abbandonata'].includes(e.codice)), incerto });
  }
  // Anche chi attende i permessi occupa un posto, prima di qualunque await.
  app.get('/api/search', (req, res, next) => {
    // Il GET lungo resta disponibile solo per i collaudi locali precedenti.
    // L'ingresso HTTPS non deve poter creare lavori con un replay del proxy.
    if (sicurezza) return res.status(405).set('Allow', 'POST').json({ codice: 'usa_avvio_ricerca' });
    const s = sessione(req);
    if (!s) return res.sendStatus(401);
    try {
      const richiesta = limitiRicerca.ammetti(s);
      req.limiteRicerca = richiesta;
      res.once('close', () => {
        if (!res.writableEnded) richiesta.budget.interrompi();
        richiesta.termina();
      });
      next();
    } catch (e) { erroreRicerca(req, res, e); }
  });
  app.use('/api', async (req, res, next) => {
    const s = sessione(req);
    if (!s) return res.sendStatus(401);
    try {
      const c = req.limiteRicerca ? await req.limiteRicerca.verifica(() => verificaSessione(s))
        : await verificaSessione(s);
      req.sessioneProva = s; req.azienda = c.azienda; req.moduli = c.moduli; next();
    } catch (e) {
      if (req.limiteRicerca) erroreRicerca(req, res, e);
      else res.status(e.status || 503).json({ codice: e.codice || 'accesso_interrotto', interrotto: true });
    }
  });
  app.get('/api/test/me', (req, res) => res.json({ azienda: req.azienda, moduli: req.moduli }));
  app.get('/api/filtri', (req, res) => res.json({
    regioni: [...new Set(Object.values(province).map(p => p.regione))].sort((a, b) => a.localeCompare(b, 'it')),
    filtriAuto: filtriAuto.NOMI.map(nome => ({ nome,
      etichetta: filtriAuto.TAB.filtri[nome].etichetta, voci: filtriAuto.voci(nome) })),
  }));
  app.get('/api/search', async (req, res) => {
    if (!req.moduli.includes(req.query.tipo)) return res.sendStatus(403);
    const richiesta = req.limiteRicerca;
    try {
      const out = await ricerca(req.azienda, req.query, () => verificaSessione(req.sessioneProva, req.query.tipo), richiesta);
      if (!res.destroyed) {
        const destinatario = await richiesta.verifica(() => verificaSessione(req.sessioneProva, req.query.tipo));
        // Non mutare porzioni condivise/cache: ogni sessione riceve firme proprie.
        const body = out.status === 200 ? { ...out.body, risultati: (out.body.risultati || [])
          .map(r => ({ ...r, accessoDettagli: autorizzazioniDettagli.emetti(req.sessioneProva,r.url,req.query.tipo) })) } : out.body;
        richiesta.budget.controlla();
        out.registraAffinita?.(destinatario.azienda);
        res.status(out.status).json(body);
      }
    } catch (e) { erroreRicerca(req, res, e); }
    finally { richiesta.termina(); }
  });
  for (const [percorso, operazione] of [['brands','marche'],['models','modelli'],['versioni','versioni']]) {
    app.get('/api/' + percorso, async (req, res) => {
      if (!req.moduli.includes(req.query.tipo)) return res.sendStatus(403);
      const input = Object.fromEntries(Object.entries(req.query).filter(([k, v]) =>
        ['tipo','marca','modello'].includes(k) && typeof v === 'string' && v.length <= 120));
      const destinatario = destinatarioHttp(req, res, req.query.tipo);
      try {
        // Il catalogo locale resta utilizzabile anche quando Moto.it è in pausa.
        const assegnazioneDa = performance.now();
        const n = sceglie([]);
        if (!n) return res.status(503).json({ error: 'nodo non disponibile' });
        const out = await assegna(() => sceglie([]), { idLavoro: crypto.randomUUID(), azienda: req.azienda,
          operazione, input, destinatari: destinatario.destinatari,
          assegnazioneMs: Math.round(performance.now() - assegnazioneDa) });
        await verificaSessione(req.sessioneProva, req.query.tipo);
        res.status(out.status).json(out.body);
      } catch (e) { if (!res.destroyed) res.status(e.status === 403 ? 403 : e.incerto ? 504 : 503)
        .json({ error: e.message, interrotto: e.status === 403 || !!e.interrotto, incerto: !!e.incerto }); }
      finally { destinatario.termina(); }
    });
  }
  app.get('/api/detail', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || url.length > 2048) return res.sendStatus(400);
    const tipo = autorizzazioniDettagli.verifica(req.sessioneProva,url,req.query.accessoDettagli);
    if (!tipo || !req.moduli.includes(tipo)) return res.sendStatus(403);
    const destinatario = destinatarioHttp(req, res, tipo);
    try {
      let fonte;
      try {
        const host = new URL(url).hostname;
        fonte = /^(?:www\.)?subito\.it$/.test(host) ? 'subito'
          : /^(?:www\.)?autoscout24\.it$/.test(host) ? 'autoscout'
          : /^(?:www\.)?moto\.it$/.test(host) ? 'moto' : null;
      } catch { fonte = null; }
      if (!fonte) return res.sendStatus(400);
      const assegnazioneDa = performance.now();
      const n = nodoPerFonte(fonte);
      if (!n) return res.status(503).json({ error: 'nodo non disponibile' });
      const out = await assegna(() => nodoPerFonte(fonte), { idLavoro: crypto.randomUUID(), azienda: req.azienda,
        operazione: 'dettaglio', fonte, input: { url },
        destinatari: destinatario.destinatari,
        assegnazioneMs: Math.round(performance.now() - assegnazioneDa) });
      await verificaSessione(req.sessioneProva, tipo);
      res.status(out.status).json(out.body);
    } catch (e) { if (!res.destroyed) res.status(e.status === 403 ? 403 : e.incerto ? 504 : 503)
      .json({ error: e.message, interrotto: e.status === 403 || !!e.interrotto, incerto: !!e.incerto }); }
    finally { destinatario.termina(); }
  });
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'prototipo.html')));
  app.get('/prototipo.css', (req, res) => res.type('css').sendFile(path.join(__dirname, '../../frontend/nodi-prototipo.css')));
  app.get('/prototipo.js', (req, res) => res.type('js').sendFile(path.join(__dirname, '../../frontend/nodi-prototipo.js')));
  app.get('/prototipo-backup.js', (req, res) => res.type('js').sendFile(path.join(__dirname, '../../frontend/nodi-backup-prova.js')));
  // I parser possono includere un estratto del body nello stack: non inviarlo
  // al logger predefinito Express, nemmeno in production.
  app.use((err, req, res, next) => {
    const status = {
      'entity.parse.failed': 400, 'entity.too.large': 413,
      'charset.unsupported': 415, 'encoding.unsupported': 415,
      'request.aborted': 400, 'request.size.invalid': 400,
    };
    if (!Object.hasOwn(status, err.type)) return next(err);
    evento('richiesta_non_valida', { http: status[err.type] });
    if (!res.destroyed && !res.headersSent) {
      res.status(status[err.type]).json({ codice: 'richiesta_non_valida' });
    }
  });
  return { app, db, nodi, lavori, ricerca, close: () => {
    if (chiuso) return;
    chiuso = true;
    ricercheHttp.close();
    limitiRicerca.close();
    accessi?.close();
    for (const job of lavori.values()) {
      clearTimeout(job.timer);
      registra(job, job.iniziato ? 'incerto' : 'interrotto');
      job.reject(Object.assign(new Error('centro interrotto'), { incerto: job.iniziato }));
    }
    lavori.clear(); for (const n of nodi.values()) n.coda.length = 0;
    clearInterval(controlloNodi); clearInterval(pulizia); db.close();
  } };
}

if (require.main === module) {
  const { app } = creaCentro({ tokens: JSON.parse(process.env.AMR_NODI_TOKENS || '{}'),
    directory: process.env.AMR_NODI_DATA_DIR, adminLocale: process.env.AMR_NODI_ADMIN_LOCALE === '1',
    timeoutRicercaMs: Number(process.env.AMR_NODI_RICERCA_TIMEOUT_MS ?? TEMPO_RICERCA_MS),
    maxPersona: Number(process.env.AMR_NODI_RICERCHE_MAX_PERSONA ?? 2),
    maxTotale: Number(process.env.AMR_NODI_RICERCHE_MAX_TOTALE ?? 60) });
  app.listen(Number(process.env.AMR_CENTRO_PORT || 47360), '127.0.0.1', () =>
    console.log('Prototipo centro su http://127.0.0.1:' + (process.env.AMR_CENTRO_PORT || 47360)));
}

module.exports = { creaCentro };
