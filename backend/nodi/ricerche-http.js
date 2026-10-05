'use strict';

const express = require('express');
const { creaLimitiRicerca } = require('./limiti-ricerca');

// Gli ID rappresentano operazioni del singolo destinatario, non job del nodo.
// Conservare una chiave non autorizza a leggere l'esito senza la sessione originale.
function creaRicercheHttp({ sessione, verifica, valida, ricerca, limiti, consegna,
  ora = Date.now, ttlRisultatoMs = 60000, ttlIdMs = 600000,
  maxRegistri = 1000, maxByte = 64 * 1024 * 1024 } = {}) {
  for (const n of [ttlRisultatoMs, ttlIdMs, maxRegistri, maxByte]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('limiti esiti non validi');
  }
  if (ttlIdMs < ttlRisultatoMs) throw new Error('scadenza ID precedente al risultato');
  const registri = new Map();
  const letture = creaLimitiRicerca({ timeoutMs: 10000, maxPersona: 2, maxTotale: 60 });
  let byte = 0, chiuso = false;
  const idValido = id => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);
  const errore = (codice, status = 400) => Object.assign(new Error(codice), { codice, status });
  const metadati = r => ({ id: r.id, stato: r.stato });
  function libera(r) {
    if (r.json !== null) { byte -= r.byte; r.json = null; r.byte = 0; }
    r.affinita = null;
  }
  function pulisci() {
    const adesso = ora();
    for (const [id, r] of registri) {
      if (r.stato === 'in_corso') continue;
      if (r.fine + ttlRisultatoMs <= adesso) { libera(r); r.stato = 'scaduta'; }
      if (r.fine + ttlIdMs <= adesso) registri.delete(id);
    }
  }
  const timer = setInterval(pulisci, Math.min(ttlRisultatoMs, ttlIdMs, 10000)); timer.unref();
  function esitoErrore(e, richiesta) {
    const incerto = !!e.incerto || (e.codice === 'ricerca_scaduta' && !!richiesta.operazione?.avviati.size);
    const codice = ['ricerca_scaduta', 'ricerca_abbandonata', 'accesso_interrotto'].includes(e.codice)
      ? e.codice : [401, 403].includes(e.status) ? 'accesso_interrotto' : 'ricerca_non_disponibile';
    return { status: [400, 401, 403, 429, 504].includes(e.status) ? e.status : incerto ? 504 : 503,
      body: { codice, interrotto: !incerto, incerto } };
  }
  function terminale(r, esito, affinita = null) {
    if (chiuso || r.stato !== 'in_corso') return;
    const json = JSON.stringify(esito), peso = Buffer.byteLength(json);
    if (peso > maxByte - byte) {
      r.json = JSON.stringify({ status: 503, body: { codice: 'risultato_non_disponibile', incerto: false } });
      // Il piccolo errore non trattiene risultati e non entra nel budget dei body.
      r.byte = 0; r.stato = 'errore';
    } else {
      r.json = json; r.byte = peso; byte += peso;
      r.stato = esito.status === 200 ? 'conclusa' : 'errore'; r.affinita = affinita;
    }
    r.fine = ora();
  }
  const posseduto = (req, id) => {
    if (!idValido(id)) throw errore('ricerca_non_trovata', 404);
    const r = registri.get(id), s = sessione(req);
    if (!r || r.sessione !== s || r.azienda !== s?.azienda) throw errore('ricerca_non_trovata', 404);
    return r;
  };
  function rispostaErrore(res, e) {
    if (res.destroyed || res.writableEnded) return;
    const codice = ['ricerca_non_trovata', 'ricerca_non_valida', 'chiave_ricerca_riutilizzata',
      'troppe_ricerche_pendenti', 'esiti_non_disponibili', 'ricerca_scaduta', 'accesso_interrotto'].includes(e.codice)
      ? e.codice : [401, 403].includes(e.status) ? 'accesso_interrotto' : 'ricerca_non_disponibile';
    res.status([400, 401, 403, 404, 409, 429, 504].includes(e.status) ? e.status : 503).json({ codice });
  }
  async function autorizza(req, fn) {
    const s = sessione(req);
    if (!s) throw errore('accesso_interrotto', 401);
    const posto = letture.ammetti(s);
    try { return await posto.verifica(() => fn(s)); }
    finally { posto.termina(); }
  }
  function mount(app) {
    app.post('/api/ricerche', express.json({ limit: '8kb' }), async (req, res) => {
      let richiesta, staccata = false;
      const abbandona = () => { if (!staccata && !res.writableEnded) richiesta?.budget.interrompi(); };
      res.once('close', abbandona);
      try {
        pulisci();
        if (chiuso) throw errore('ricerca_non_disponibile', 503);
        const { id, input } = req.body || {};
        if (!idValido(id) || !input || typeof input !== 'object' || Array.isArray(input)) throw errore('ricerca_non_valida');
        const query = valida(input);
        const impronta = JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
        const s = sessione(req); if (!s) throw errore('accesso_interrotto', 401);
        let r = registri.get(id);
        if (r) {
          r = posseduto(req, id);
          await autorizza(req, () => verifica(s, r.tipo));
          pulisci();
          if (registri.get(id) !== r) throw errore('ricerca_non_trovata', 404);
          if (r.impronta !== impronta) throw errore('chiave_ricerca_riutilizzata', 409);
          return res.status(202).set('Retry-After', '1').set('Location', '/api/ricerche/' + id).json(metadati(r));
        }
        if (registri.size >= maxRegistri) throw errore('esiti_non_disponibili', 503);
        richiesta = limiti.ammetti(s);
        // Anche l'avvio deve rispondere brevemente se i permessi non si leggono.
        const c = await autorizza(req, () => richiesta.verifica(() => verifica(s, query.tipo)));
        richiesta.budget.controlla();
        if (res.destroyed || chiuso) throw errore('ricerca_abbandonata', 503);
        // Nessun await fra secondo controllo e inserimento: due POST concorrenti
        // con la stessa chiave non possono creare due esecuzioni.
        if (registri.has(id)) {
          r = posseduto(req, id);
          if (r.impronta !== impronta) throw errore('chiave_ricerca_riutilizzata', 409);
          return res.status(202).set('Retry-After', '1').set('Location', '/api/ricerche/' + id).json(metadati(r));
        }
        if (registri.size >= maxRegistri) throw errore('esiti_non_disponibili', 503);
        r = { id, sessione: s, azienda: c.azienda, tipo: query.tipo, impronta,
          stato: 'in_corso', json: null, byte: 0, affinita: null, richiesta };
        registri.set(id, r); staccata = true;
        richiesta = null;
        const ammessa = r.richiesta;
        Promise.resolve().then(() => ricerca(c.azienda, query, () => verifica(s, query.tipo), ammessa))
          .then(out => terminale(r, { status: out.status, body: out.body }, out.registraAffinita),
            e => terminale(r, esitoErrore(e, ammessa)))
          .catch(() => terminale(r, { status: 503, body: { codice: 'ricerca_non_disponibile' } }))
          .finally(() => {
            ammessa.termina();
            // L'operazione contiene anche la Promise del coordinatore: dopo il
            // completamento non deve trattenere i risultati oltre il TTL.
            r.richiesta = null;
          });
        res.status(202).set('Retry-After', '1').set('Location', '/api/ricerche/' + id).json(metadati(r));
      } catch (e) { rispostaErrore(res, e); }
      finally { richiesta?.termina(); res.removeListener('close', abbandona); }
    });
    app.get('/api/ricerche/:id', async (req, res) => {
      try {
        pulisci(); const r = posseduto(req, req.params.id);
        const c = await autorizza(req, s => verifica(s, r.tipo));
        if (res.destroyed || chiuso) return;
        pulisci();
        if (registri.get(r.id) !== r) throw errore('ricerca_non_trovata', 404);
        if (r.stato === 'in_corso') return res.set('Retry-After', '1').json(metadati(r));
        if (r.json === null) return res.status(410).json({ ...metadati(r), codice: 'esito_non_disponibile' });
        const esito = JSON.parse(r.json);
        const body = esito.status === 200 ? consegna(esito.body, r.sessione, r.tipo) : esito.body;
        r.affinita?.(c.azienda);
        r.affinita = null;
        res.json({ ...metadati(r), esito: { status: esito.status, body } });
      } catch (e) { rispostaErrore(res, e); }
    });
    app.delete('/api/ricerche/:id', async (req, res) => {
      try {
        pulisci(); const r = posseduto(req, req.params.id);
        await autorizza(req, s => verifica(s, r.tipo));
        pulisci();
        if (registri.get(r.id) !== r) throw errore('ricerca_non_trovata', 404);
        r.richiesta?.budget.interrompi(); libera(r);
        if (r.stato === 'in_corso') r.fine = ora();
        r.stato = 'abbandonata';
        res.json(metadati(r));
      } catch (e) { rispostaErrore(res, e); }
    });
  }
  return { mount, close() {
    chiuso = true; clearInterval(timer); letture.close();
    for (const r of registri.values()) { r.richiesta?.budget.interrompi(); libera(r); }
    registri.clear();
  } };
}

module.exports = { creaRicercheHttp };
