'use strict';

const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { parseSearchParams, FONTI_PAGINA } = require('../ricerca-parametri');
const { porzioneCompleta } = require('./componi-ricerca');
const { NOMI: FILTRI_AUTO } = require('../filtri-auto');

const MODULI = { aziendaA: ['auto', 'moto'], aziendaB: ['moto'], operatore: [] };
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

function creaCentro({ tokens, directory, ora = () => Date.now(), timeoutMs = FINO_AL }) {
  if (!tokens || !Object.keys(tokens).length || !directory
      || Object.values(tokens).some(t => typeof t !== 'string' || t.length < 32)) {
    throw new Error('token per nodo e directory necessari');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, 'lavori-prototipo.db'));
  db.exec('CREATE TABLE IF NOT EXISTS lavori (id TEXT PRIMARY KEY, azienda TEXT NOT NULL, operazione TEXT NOT NULL, filtri TEXT NOT NULL, stato TEXT NOT NULL, creato INTEGER NOT NULL, aggiornato INTEGER NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS sospensioni (nodo TEXT NOT NULL, fonte TEXT NOT NULL, PRIMARY KEY (nodo, fonte))');
  db.prepare("UPDATE lavori SET stato=CASE WHEN stato='attesa' THEN 'interrotto' ELSE 'incerto' END, aggiornato=? WHERE stato IN ('attesa','in_corso')").run(ora());
  const pulisci = () => db.prepare('DELETE FROM lavori WHERE creato < ?').run(ora() - SETTE_GIORNI);
  pulisci();
  const pulizia = setInterval(pulisci, 3600000);
  pulizia.unref();
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return res.sendStatus(403);
    if (req.method === 'POST' && req.headers.origin
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
  const impronta = s => crypto.createHash('sha256').update(s).digest('hex');
  function registra(lavoro, stato) {
    db.prepare('INSERT INTO lavori(id,azienda,operazione,filtri,stato,creato,aggiornato) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET stato=excluded.stato, aggiornato=excluded.aggiornato')
      .run(lavoro.idLavoro, lavoro.azienda, lavoro.operazione,
        JSON.stringify(lavoro.operazione === 'dettaglio'
          ? { urlHash: impronta(lavoro.input.url) }
          : lavoro.operazione === 'componi'
            ? { fonti: Object.keys(lavoro.input.sostituzioni || {}) } : lavoro.input),
        stato, lavoro.creato, ora());
  }
  function disponibile(n, fonte = null) {
    if (!n || ora() - n.visto > 6000 || n.revisione !== REVISIONE || n.sospeso || n.coda.length >= 10) return false;
    return !fonte || (!n.sospese.has(fonte) && !n.fonti[fonte]?.fermo);
  }
  function assegna(n, lavoro, limite = timeoutMs) {
    return new Promise((resolve, reject) => {
      const record = { ...lavoro, nodoAssegnato: n.id, tentativo: 1, creato: ora(),
        iniziato: false, resolve, reject };
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
  const controlloNodi = setInterval(() => {
    for (const job of lavori.values()) {
      const n = nodi.get(job.nodoAssegnato);
      if (n && ora() - n.visto <= 6000) continue;
      if (!job.iniziato) {
        const richieste = job.operazione === 'fonte' ? [job.fonte]
          : job.operazione === 'ricerca' ? (job.input.fonti?.split(',')
            || (job.input.tipo === 'auto' ? ['subito','autoscout'] : FONTI_PAGINA)) : [];
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
  async function ricercaSenzaCondivisione(azienda, input) {
    const parsed = parseSearchParams(input);
    if (parsed.errors) return { status: 400, body: { error: parsed.errors.join(', ') } };
    const fonti = parsed.params.tipo === 'auto' ? ['subito', 'autoscout'] : FONTI_PAGINA;
    const richieste = input.fonti ? input.fonti.split(',') : fonti;
    const chiave = azienda + ':' + REVISIONE + ':' + JSON.stringify(Object.entries(input)
      .filter(([k]) => !['fetta','fonti','subitoMainStart','subitoRecuperoStart'].includes(k))
      .sort(([a], [b]) => a.localeCompare(b)));
    const precedente = affinita.get(chiave);
    const ancoraValida = precedente && ora() - precedente.ts < 30 * 60000;
    const vincoloPagina = Number(input.fetta || 0) > 0 && ancoraValida;
    const preferito = vincoloPagina ? nodi.get(precedente.fonti[richieste[0]]) : null;
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
      operazione: 'ricerca', input: query });
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
      const primaScelta = ancoraValida ? nodi.get(precedente.fonti[fonte]) : null;
      const alternativo = primaScelta && primaScelta.id !== primario.id && disponibile(primaScelta, fonte)
        ? primaScelta : [...nodi.values()].find(n => n.id !== primario.id && disponibile(n, fonte));
      if (!alternativo) { avvisi.push(`${fonte}: nessun nodo alternativo disponibile`); continue; }
      let alternativa;
      try {
        alternativa = await assegna(alternativo, { idLavoro: crypto.randomUUID(), azienda,
          operazione: 'fonte', fonte, input }, Math.min(timeoutMs, 50000));
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
    affinita.set(chiave, { ts: ora(), fonti: { ...(ancoraValida ? precedente.fonti : {}), ...assegnate } });
    if (affinita.size > 100) affinita.delete(affinita.keys().next().value);
    if (!Object.keys(sostituzioni).length) return { status: 200, body: { ...base.body, avvisiNodi: avvisi } };
    try {
      const finale = await assegna(primario, { idLavoro: crypto.randomUUID(), azienda,
        operazione: 'componi', input: { principale: base.body, sostituzioni } });
      if (finale.status === 200) return { status: 200, body: { ...finale.body, avvisiNodi: avvisi } };
    } catch (e) { avvisi.push(`composizione sul nodo principale senza conferma: ${e.incerto ? 'esito incerto' : 'nodo non disponibile'}`); }
    return { status: 200, body: { ...base.body, avvisiNodi: avvisi } };
  }

  function ricerca(azienda, query) {
    const input = filtriAmmessi(query);
    const prima = Number(input.fetta || 0) === 0 && !input.fonti
      && input.subitoMainStart == null && input.subitoRecuperoStart == null;
    if (!prima) return ricercaSenzaCondivisione(azienda, input);
    const chiave = REVISIONE + ':' + JSON.stringify(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
    const esistente = condivise.get(chiave);
    if (esistente) {
      const meta = { idLavoro: crypto.randomUUID(), azienda, operazione: 'condivisa', input,
        creato: ora() };
      registra(meta, 'in_corso');
      return esistente.then(r => { registra(meta, r.status === 200 ? 'concluso' : 'errore'); return r; },
        e => { registra(meta, e.incerto ? 'incerto' : 'errore'); throw e; });
    }
    const promessa = ricercaSenzaCondivisione(azienda, input);
    condivise.set(chiave, promessa);
    promessa.finally(() => { if (condivise.get(chiave) === promessa) condivise.delete(chiave); }).catch(() => {});
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
    if (n.occupato) return res.sendStatus(204);
    const job = n.coda.shift();
    if (!job) return res.sendStatus(204);
    n.occupato = true; job.iniziato = true; registra(job, 'in_corso');
    res.json({ versioneProtocollo: 1, idLavoro: job.idLavoro, tentativo: job.tentativo,
      azienda: job.azienda, operazione: job.operazione, fonte: job.fonte, input: job.input });
  });
  app.post('/_nodo/esito', (req, res) => {
    const { id, idLavoro, tentativo, esito } = req.body || {};
    if (id !== req.get('x-amr-node-id')) return res.sendStatus(403);
    const job = lavori.get(idLavoro);
    if (!job || job.nodoAssegnato !== id || job.tentativo !== tentativo || !job.iniziato) return res.sendStatus(409);
    if (!esito || !Number.isInteger(esito.status) || !esito.body
        || typeof esito.body !== 'object' || Array.isArray(esito.body)) return res.sendStatus(400);
    lavori.delete(idLavoro); clearTimeout(job.timer);
    nodi.get(id).occupato = false;
    registra(job, esito.status === 200 ? 'concluso' : 'errore');
    job.resolve(esito);
    res.json({ ok: true });
  });

  app.post('/api/test/login', express.json({ limit: '1kb' }), (req, res) => {
    const azienda = req.body?.azienda;
    if (typeof azienda !== 'string' || !Object.hasOwn(MODULI, azienda)) return res.sendStatus(400);
    const cookie = crypto.randomBytes(24).toString('hex');
    sessioni.set(cookie, { azienda, ts: ora(), annunci: new Map() });
    if (sessioni.size > 50) sessioni.delete(sessioni.keys().next().value);
    res.cookie('amr_prova', cookie, { httpOnly: true, sameSite: 'strict', path: '/' });
    res.json({ azienda, moduli: MODULI[azienda] });
  });
  app.use('/api', (req, res, next) => {
    const s = sessione(req);
    if (!s) return res.sendStatus(401);
    req.sessioneProva = s; req.azienda = s.azienda; next();
  });
  app.get('/api/search', async (req, res) => {
    if (!MODULI[req.azienda].includes(req.query.tipo)) return res.sendStatus(403);
    let abbandonata = false;
    res.on('close', () => { if (!res.writableEnded) abbandonata = true; });
    try {
      const out = await ricerca(req.azienda, req.query);
      if (!abbandonata) {
        if (out.status === 200) for (const r of out.body.risultati || []) {
          if (typeof r.url !== 'string') continue;
          req.sessioneProva.annunci.set(impronta(r.url), req.query.tipo);
          if (req.sessioneProva.annunci.size > 300) req.sessioneProva.annunci.delete(req.sessioneProva.annunci.keys().next().value);
        }
        res.status(out.status).json(out.body);
      }
    } catch (e) { if (!abbandonata) res.status(e.status === 400 ? 400 : e.incerto ? 504 : 503)
      .json({ error: e.message, incerto: !!e.incerto }); }
  });
  for (const [percorso, operazione] of [['brands','marche'],['models','modelli'],['versioni','versioni']]) {
    app.get('/api/' + percorso, async (req, res) => {
      if (!MODULI[req.azienda].includes(req.query.tipo)) return res.sendStatus(403);
      const input = Object.fromEntries(Object.entries(req.query).filter(([k, v]) =>
        ['tipo','marca','modello'].includes(k) && typeof v === 'string' && v.length <= 120));
      try {
        const n = operazione === 'modelli' && input.tipo === 'moto'
          ? nodoPerFonte('moto') : [...nodi.values()].find(n => !n.simulato && disponibile(n));
        if (!n) return res.status(503).json({ error: 'nodo non disponibile' });
        const out = await assegna(n, { idLavoro: crypto.randomUUID(), azienda: req.azienda,
          operazione, input });
        res.status(out.status).json(out.body);
      } catch (e) { res.status(e.incerto ? 504 : 503).json({ error: e.message, incerto: !!e.incerto }); }
    });
  }
  app.get('/api/detail', async (req, res) => {
    const url = req.query.url;
    if (typeof url !== 'string' || url.length > 2048) return res.sendStatus(400);
    const tipo = req.sessioneProva.annunci.get(impronta(url));
    if (!tipo || !MODULI[req.azienda].includes(tipo)) return res.sendStatus(403);
    try {
      let fonte;
      try {
        const host = new URL(url).hostname;
        fonte = /^(?:www\.)?subito\.it$/.test(host) ? 'subito'
          : /^(?:www\.)?autoscout24\.it$/.test(host) ? 'autoscout'
          : /^(?:www\.)?moto\.it$/.test(host) ? 'moto' : null;
      } catch { fonte = null; }
      if (!fonte) return res.sendStatus(400);
      const n = nodoPerFonte(fonte);
      if (!n) return res.status(503).json({ error: 'nodo non disponibile' });
      const out = await assegna(n, { idLavoro: crypto.randomUUID(), azienda: req.azienda,
        operazione: 'dettaglio', input: { url } });
      res.status(out.status).json(out.body);
    } catch (e) { res.status(e.incerto ? 504 : 503).json({ error: e.message, incerto: !!e.incerto }); }
  });
  app.get('/api/admin', (req, res) => {
    if (req.azienda !== 'operatore') return res.sendStatus(403);
    pulisci();
    res.json({ nodi: [...nodi.values()].map(n => ({ id: n.id, online: ora() - n.visto < 6000,
      occupato: n.occupato, simulato: n.simulato, sospeso: n.sospeso, sospese: [...n.sospese], fonti: n.fonti })),
      lavori: db.prepare('SELECT id,azienda,operazione,filtri,stato,creato,aggiornato FROM lavori ORDER BY creato DESC LIMIT 100').all()
        .map(r => ({ ...r, filtri: JSON.parse(r.filtri) })) });
  });
  app.post('/api/admin/nodi/:id', express.json({ limit: '1kb' }), (req, res) => {
    if (req.azienda !== 'operatore') return res.sendStatus(403);
    const n = nodi.get(req.params.id);
    if (!n) return res.sendStatus(404);
    const { sospeso, fonte } = req.body || {};
    if (fonte && !FONTI_PAGINA.includes(fonte)) return res.sendStatus(400);
    if (typeof sospeso !== 'boolean') return res.sendStatus(400);
    if (fonte) sospeso ? n.sospese.add(fonte) : n.sospese.delete(fonte);
    else n.sospeso = sospeso;
    if (sospeso) db.prepare('INSERT OR IGNORE INTO sospensioni(nodo,fonte) VALUES(?,?)').run(n.id, fonte || '');
    else db.prepare('DELETE FROM sospensioni WHERE nodo=? AND fonte=?').run(n.id, fonte || '');
    res.json({ ok: true });
  });
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'prototipo.html')));
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
    directory: process.env.AMR_NODI_DATA_DIR });
  app.listen(Number(process.env.AMR_CENTRO_PORT || 47360), '127.0.0.1', () =>
    console.log('Prototipo centro su http://127.0.0.1:' + (process.env.AMR_CENTRO_PORT || 47360)));
}

module.exports = { creaCentro };
