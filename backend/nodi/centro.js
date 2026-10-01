'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { parseSearchParams, FONTI_PAGINA } = require('../ricerca-parametri');
const { porzioneCompleta } = require('./componi-ricerca');
const { NOMI: FILTRI_AUTO } = require('../filtri-auto');
const filtriAuto = require('../filtri-auto');
const province = require('../../data/province.json');

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
  adminLocale = false, accountProva = null }) {
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
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return res.sendStatus(403);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers.origin
        && req.headers.origin !== `http://${req.headers.host}`) return res.sendStatus(403);
    next();
  });
  const nodi = new Map(), lavori = new Map(), sessioni = new Map(), condivise = new Map(), affinita = new Map();
  const stessoToken = (ricevuto, id) => {
    if (typeof ricevuto !== 'string' || typeof id !== 'string' || !Object.hasOwn(tokens, id)) return false;
    const a = Buffer.from(ricevuto), b = Buffer.from(tokens[id] || '');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const nodoAutorizzato = (req, res, next) => stessoToken(req.get('x-amr-node-token'),
    req.get('x-amr-node-id'))
    ? next() : res.sendStatus(401);
  const sessione = req => {
    const s = sessioni.get(/(?:^|; )amr_prova=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1]);
    return s && ora() - s.ts < 3600000 ? s : null;
  };
  function verificaSessione(s, tipo) {
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
  function verificaDestinatari(destinatari) {
    if (!destinatari) return;
    let indisponibile = null;
    for (const verifica of destinatari) {
      try { verifica(); return; }
      catch (e) { if (![401, 403].includes(e.status)) indisponibile = e; }
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
  function disponibile(n, fonte = null) {
    if (!n || ora() - n.visto > 6000 || n.revisione !== REVISIONE || n.sospeso || n.coda.length >= 10) return false;
    return !fonte || (!n.sospese.has(fonte) && !n.fonti[fonte]?.fermo);
  }
  function assegna(n, lavoro, limite = timeoutMs) {
    return new Promise((resolve, reject) => {
      verificaDestinatari(lavoro.destinatari);
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
          { incerto: record.iniziato }));
      }, limite);
      record.timer = timer;
      lavori.set(record.idLavoro, record);
      n.coda.push(record);
      registra(record, 'attesa');
    });
  }
  function sceglie(fonti, escluso = null) {
    return [...nodi.values()].filter(n => n.id !== escluso && !n.simulato && disponibile(n))
      .sort((a, b) => fonti.filter(f => disponibile(b, f)).length
        - fonti.filter(f => disponibile(a, f)).length || a.coda.length - b.coda.length)[0] || null;
  }
  function nodoPerFonte(fonte) {
    const candidati = [...nodi.values()].filter(n => disponibile(n, fonte));
    return candidati.find(n => !n.simulato) || null;
  }
  function fontiDelLavoro(job) {
    if (job.operazione === 'fonte') return [job.fonte];
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
      job.reject(esito instanceof Error ? esito : new Error('lavoro non avviato: nodo o fonte sospesa'));
      return false;
    });
  }
  const controlloNodi = setInterval(() => {
    for (const job of lavori.values()) {
      const n = nodi.get(job.nodoAssegnato);
      if (n && ora() - n.visto <= 6000) continue;
      if (!job.iniziato) {
        const richieste = fontiDelLavoro(job);
        const alternativo = [...nodi.values()].find(x => x.id !== job.nodoAssegnato
          && !x.simulato && richieste.every(f => disponibile(x, f)) && disponibile(x));
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
        : 'nodo non disponibile'), { incerto: job.iniziato }));
    }
  }, 1000);
  controlloNodi.unref();
  function chiaveAffinita(azienda, input) {
    return azienda + ':' + REVISIONE + ':' + JSON.stringify(Object.entries(input)
      .filter(([k]) => !['fetta','fonti','subitoMainStart','subitoRecuperoStart'].includes(k))
      .sort(([a], [b]) => a.localeCompare(b)));
  }
  async function ricercaSenzaCondivisione(azienda, input, destinatari) {
    const parsed = parseSearchParams(input);
    if (parsed.errors) return { status: 400, body: { error: parsed.errors.join(', ') } };
    const fonti = parsed.params.tipo === 'auto' ? ['subito', 'autoscout'] : FONTI_PAGINA;
    const richieste = input.fonti ? input.fonti.split(',') : fonti;
    const chiave = chiaveAffinita(azienda, input);
    const precedente = affinita.get(chiave);
    const ancoraValida = precedente && ora() - precedente.ts < 30 * 60000;
    const vincoloPagina = Number(input.fetta || 0) > 0 && ancoraValida;
    const preferito = vincoloPagina ? nodi.get(precedente.fonti[richieste[0]]) : null;
    const assegnazioneDa = performance.now();
    const primario = preferito && !preferito.simulato && disponibile(preferito)
      ? preferito : sceglie(richieste);
    if (!primario) return { status: 503, body: { error: 'nessun nodo disponibile' } };
    const suPrimario = richieste.filter(f => disponibile(primario, f)
      && (!vincoloPagina || !precedente.fonti[f] || precedente.fonti[f] === primario.id
        || !disponibile(nodi.get(precedente.fonti[f]), f)));
    if (!suPrimario.length) return { status: 503, body: { error: 'nessuna fonte disponibile' } };
    const query = { ...input };
    if (suPrimario.length !== richieste.length) {
      query.fonti = suPrimario.join(','); query.fetta = String(query.fetta ?? 0);
    }
    const base = await assegna(primario, { idLavoro: crypto.randomUUID(), azienda,
      operazione: 'ricerca', input: query, destinatari,
      assegnazioneMs: Math.round(performance.now() - assegnazioneDa) });
    if (base.status !== 200) return base;
    if (!base.body || !Array.isArray(base.body.risultati) || !base.body.sources
        || richieste.some(f => typeof base.body.sources[f]?.status !== 'string')) {
      return { status: 502, body: { error: 'risposta di ricerca non valida dal nodo' } };
    }
    const sostituzioni = {}, avvisi = [], assegnate = {};
    for (const f of suPrimario) assegnate[f] = primario.id;
    if (ancoraValida) for (const f of suPrimario) {
      if (precedente.fonti[f] && precedente.fonti[f] !== primario.id) {
        avvisi.push(`${f}: pagina richiesta su un altro nodo; la copertura può cambiare`);
      }
    }
    for (const fonte of richieste) {
      const s = base.body.sources?.[fonte];
      const daAlternativo = !suPrimario.includes(fonte) || s?.erroreHttp === 429;
      if (!daAlternativo) continue;
      verificaDestinatari(destinatari);
      const assegnazioneFonteDa = performance.now();
      const primaScelta = ancoraValida ? nodi.get(precedente.fonti[fonte]) : null;
      const alternativo = primaScelta && primaScelta.id !== primario.id && !primaScelta.simulato
        && disponibile(primaScelta, fonte) ? primaScelta
        : [...nodi.values()].find(n => n.id !== primario.id && !n.simulato && disponibile(n, fonte))
          || [...nodi.values()].find(n => n.id !== primario.id && n.simulato && disponibile(n, fonte));
      if (!alternativo) { avvisi.push(`${fonte}: nessun nodo alternativo disponibile`); continue; }
      let alternativa;
      try {
        alternativa = await assegna(alternativo, { idLavoro: crypto.randomUUID(), azienda,
          operazione: 'fonte', fonte, input, destinatari,
          assegnazioneMs: Math.round(performance.now() - assegnazioneFonteDa) }, Math.min(timeoutMs, 50000));
      } catch (e) {
        avvisi.push(`${fonte}: secondo nodo senza conferma; esito ${e.incerto ? 'incerto' : 'non disponibile'}`);
        continue;
      }
      if (alternativa.status === 200 && porzioneCompleta(alternativa.body, fonte)) {
        sostituzioni[fonte] = alternativa.body;
        assegnate[fonte] = alternativo.id;
        if (ancoraValida && precedente.fonti[fonte] && precedente.fonti[fonte] !== alternativo.id) {
          avvisi.push(`${fonte}: pagina richiesta su un altro nodo; la copertura può cambiare`);
        }
      } else avvisi.push(alternativo.simulato
        ? `${fonte}: nodo simulato, nessun portale interrogato` : `${fonte}: nodo alternativo senza risultato completo`);
    }
    function termina(body) {
      const datoAffinita = { ts: ora(), fonti: { ...(ancoraValida ? precedente.fonti : {}), ...assegnate } };
      affinita.set(chiave, datoAffinita);
      // Il Set può ricevere altri destinatari anche durante la composizione sul nodo.
      for (const verifica of destinatari || []) {
        try {
          const destinatario = verifica();
          affinita.set(chiaveAffinita(destinatario.azienda, input), datoAffinita);
        } catch { /* Non autorizzare nuove pagine per un destinatario revocato. */ }
      }
      while (affinita.size > 100) affinita.delete(affinita.keys().next().value);
      return { status: 200, body: { ...body, avvisiNodi: avvisi } };
    }
    if (!Object.keys(sostituzioni).length) return termina(base.body);
    try {
      const finale = await assegna(primario, { idLavoro: crypto.randomUUID(), azienda,
        operazione: 'componi', input: { principale: base.body, sostituzioni }, destinatari });
      if (finale.status === 200) return termina(finale.body);
    } catch (e) { avvisi.push(`composizione sul nodo principale senza conferma: ${e.incerto ? 'esito incerto' : 'nodo non disponibile'}`); }
    return termina(base.body);
  }

  function ricerca(azienda, query, verifica = null) {
    if (accountProva && !verifica) throw Object.assign(new Error('identita_richiesta'), { status: 401 });
    if (verifica) verifica();
    const input = filtriAmmessi(query);
    const prima = Number(input.fetta || 0) === 0 && !input.fonti
      && input.subitoMainStart == null && input.subitoRecuperoStart == null;
    const destinatari = verifica ? new Set([verifica]) : null;
    if (!prima) return ricercaSenzaCondivisione(azienda, input, destinatari);
    const chiave = REVISIONE + ':' + JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
    const esistente = condivise.get(chiave);
    if (esistente) {
      if (verifica) esistente.destinatari?.add(verifica);
      const meta = { idLavoro: crypto.randomUUID(), azienda, operazione: 'condivisa', input,
        creato: ora() };
      registra(meta, 'in_corso');
      return esistente.promessa.then(r => { registra(meta, r.status === 200 ? 'concluso' : 'errore'); return r; },
        e => { registra(meta, e.incerto ? 'incerto' : 'errore'); throw e; });
    }
    const promessa = ricercaSenzaCondivisione(azienda, input, destinatari);
    const voce = { promessa, destinatari };
    condivise.set(chiave, voce);
    promessa.finally(() => { if (condivise.get(chiave) === voce) condivise.delete(chiave); }).catch(() => {});
    return promessa;
  }

  app.use('/_nodo', nodoAutorizzato, express.json({ limit: '8mb' }));
  app.post('/_nodo/heartbeat', (req, res) => {
    const { id, revisione, fonti, occupato, idLavoroAttivo, simulato } = req.body || {};
    if (id !== req.get('x-amr-node-id')) return res.sendStatus(403);
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id || '') || !fonti || typeof fonti !== 'object') return res.sendStatus(400);
    let n = nodi.get(id);
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
    n.occupato = !!occupato;
    res.json({ ok: true });
  });
  app.get('/_nodo/poll', (req, res) => {
    if (req.query.id !== req.get('x-amr-node-id')) return res.sendStatus(403);
    const n = nodi.get(req.query.id);
    if (!n || ora() - n.visto > 6000 || n.revisione !== REVISIONE) return res.sendStatus(409);
    if (n.occupato || n.sospeso) return res.sendStatus(204);
    interrompiAccodati(n, null, job => fontiDelLavoro(job)
      .some(f => n.sospese.has(f) || n.fonti[f]?.fermo));
    interrompiAccodati(n, null, job => {
      try { verificaDestinatari(job.destinatari); return false; } catch (e) { return e; }
    });
    const job = n.coda.shift();
    if (!job) return res.sendStatus(204);
    n.occupato = true; job.iniziato = true;
    job.iniziatoMono = performance.now();
    job.codaMs = Math.round(job.iniziatoMono - job.accodatoMono);
    registra(job, 'in_corso');
    res.json({ versioneProtocollo: 1, idLavoro: job.idLavoro, tentativo: job.tentativo,
      azienda: job.azienda, operazione: job.operazione, fonte: job.fonte, input: job.input });
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
    registra(job, esito.status === 200 ? 'concluso' : 'errore');
    segnalaFonti(job, esito);
    job.resolve(esito);
    res.json({ ok: true });
  });

  app.post('/api/test/login', express.json({ limit: '1kb' }), (req, res) => {
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
      identita, ts: ora(), annunci: new Map() });
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
  function adminDiProva(req, res, next) {
    if (!accountProva) return next();
    try {
      accountProva.contesto(sessione(req)?.identita, { admin: true });
      next();
    } catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'autorizzazione_non_disponibile' }); }
  }
  app.use('/api/stato', adminDiProva);
  app.get('/api/stato', (req, res) => {
    pulisci();
    const nodo = typeof req.query.nodo === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(req.query.nodo)
      ? req.query.nodo : null;
    res.json({ nodi: [...nodi.values()].filter(n => !nodo || n.id === nodo).map(n => ({ id: n.id, online: ora() - n.visto < 6000,
      occupato: n.occupato, simulato: n.simulato, sospeso: n.sospeso,
      sospese: [...n.sospese], fonti: n.fonti })),
    ...paginaLavori(req, false), lavoriAttivi: nodo
      ? db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso') AND nodo=?").get(nodo).n
      : db.prepare("SELECT count(*) AS n FROM lavori WHERE stato IN ('attesa','in_corso')").get().n });
  });
  app.use('/api/admin', adminDiProva, (req, res, next) => {
    if (!adminLocale) return res.sendStatus(404);
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
        && req.get('x-amr-local-admin') !== '1') return res.sendStatus(403);
    next();
  });
  app.get('/api/admin', (req, res) => {
    pulisci();
    const nodo = typeof req.query.nodo === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(req.query.nodo)
      ? req.query.nodo : null;
    res.json({ nodi: [...nodi.values()].filter(n => !nodo || n.id === nodo).map(n => ({ id: n.id, online: ora() - n.visto < 6000,
      occupato: n.occupato, simulato: n.simulato, sospeso: n.sospeso, sospese: [...n.sospese], fonti: n.fonti })),
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
  app.post('/api/admin/nodi/:id', express.json({ limit: '1kb' }), (req, res) => {
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
  app.use('/api', (req, res, next) => {
    const s = sessione(req);
    if (!s) return res.sendStatus(401);
    try {
      const c = verificaSessione(s);
      req.sessioneProva = s; req.azienda = c.azienda; req.moduli = c.moduli; next();
    } catch (e) { res.status(e.status || 503).json({ codice: e.codice || 'accesso_interrotto', interrotto: true }); }
  });
  app.get('/api/test/me', (req, res) => res.json({ azienda: req.azienda, moduli: req.moduli }));
  app.get('/api/filtri', (req, res) => res.json({
    regioni: [...new Set(Object.values(province).map(p => p.regione))].sort((a, b) => a.localeCompare(b, 'it')),
    filtriAuto: filtriAuto.NOMI.map(nome => ({ nome,
      etichetta: filtriAuto.TAB.filtri[nome].etichetta, voci: filtriAuto.voci(nome) })),
  }));
  app.get('/api/search', async (req, res) => {
    if (!req.moduli.includes(req.query.tipo)) return res.sendStatus(403);
    let abbandonata = false;
    res.on('close', () => { if (!res.writableEnded) abbandonata = true; });
    try {
      const out = await ricerca(req.azienda, req.query, () => verificaSessione(req.sessioneProva, req.query.tipo));
      if (!abbandonata) {
        verificaSessione(req.sessioneProva, req.query.tipo);
        if (out.status === 200) for (const r of out.body.risultati || []) {
          if (typeof r.url !== 'string') continue;
          req.sessioneProva.annunci.set(impronta(r.url), req.query.tipo);
          if (req.sessioneProva.annunci.size > 300) req.sessioneProva.annunci.delete(req.sessioneProva.annunci.keys().next().value);
        }
        res.status(out.status).json(out.body);
      }
    } catch (e) { if (!abbandonata) res.status(e.status === 400 ? 400 : e.status === 403 ? 403 : e.incerto ? 504 : 503)
      .json({ error: e.status === 403 ? 'accesso_interrotto' : e.message,
        interrotto: e.status === 403, incerto: !!e.incerto }); }
  });
  for (const [percorso, operazione] of [['brands','marche'],['models','modelli'],['versioni','versioni']]) {
    app.get('/api/' + percorso, async (req, res) => {
      if (!req.moduli.includes(req.query.tipo)) return res.sendStatus(403);
      const input = Object.fromEntries(Object.entries(req.query).filter(([k, v]) =>
        ['tipo','marca','modello'].includes(k) && typeof v === 'string' && v.length <= 120));
      try {
        // Il catalogo locale resta utilizzabile anche quando Moto.it è in pausa.
        const assegnazioneDa = performance.now();
        const n = [...nodi.values()].find(n => !n.simulato && disponibile(n));
        if (!n) return res.status(503).json({ error: 'nodo non disponibile' });
        const out = await assegna(n, { idLavoro: crypto.randomUUID(), azienda: req.azienda,
          operazione, input, destinatari: new Set([() => verificaSessione(req.sessioneProva, req.query.tipo)]),
          assegnazioneMs: Math.round(performance.now() - assegnazioneDa) });
        verificaSessione(req.sessioneProva, req.query.tipo);
        res.status(out.status).json(out.body);
      } catch (e) { res.status(e.status === 403 ? 403 : e.incerto ? 504 : 503)
        .json({ error: e.message, interrotto: e.status === 403, incerto: !!e.incerto }); }
    });
  }
  app.get('/api/detail', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || url.length > 2048) return res.sendStatus(400);
    const tipo = req.sessioneProva.annunci.get(impronta(url));
    if (!tipo || !req.moduli.includes(tipo)) return res.sendStatus(403);
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
      const out = await assegna(n, { idLavoro: crypto.randomUUID(), azienda: req.azienda,
        operazione: 'dettaglio', input: { url },
        destinatari: new Set([() => verificaSessione(req.sessioneProva, tipo)]),
        assegnazioneMs: Math.round(performance.now() - assegnazioneDa) });
      verificaSessione(req.sessioneProva, tipo);
      res.status(out.status).json(out.body);
    } catch (e) { res.status(e.status === 403 ? 403 : e.incerto ? 504 : 503)
      .json({ error: e.message, interrotto: e.status === 403, incerto: !!e.incerto }); }
  });
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'prototipo.html')));
  app.get('/prototipo.css', (req, res) => res.type('css').sendFile(path.join(__dirname, '../../frontend/nodi-prototipo.css')));
  app.get('/prototipo.js', (req, res) => res.type('js').sendFile(path.join(__dirname, '../../frontend/nodi-prototipo.js')));
  return { app, db, nodi, lavori, ricerca, close: () => {
    for (const job of lavori.values()) {
      clearTimeout(job.timer);
      registra(job, job.iniziato ? 'incerto' : 'interrotto');
      job.reject(Object.assign(new Error('centro interrotto'), { incerto: job.iniziato }));
    }
    lavori.clear(); clearInterval(controlloNodi); clearInterval(pulizia); db.close();
  } };
}

if (require.main === module) {
  const { app } = creaCentro({ tokens: JSON.parse(process.env.AMR_NODI_TOKENS || '{}'),
    directory: process.env.AMR_NODI_DATA_DIR, adminLocale: process.env.AMR_NODI_ADMIN_LOCALE === '1' });
  app.listen(Number(process.env.AMR_CENTRO_PORT || 47360), '127.0.0.1', () =>
    console.log('Prototipo centro su http://127.0.0.1:' + (process.env.AMR_CENTRO_PORT || 47360)));
}

module.exports = { creaCentro };
