'use strict';

const { esegui, statoFonti } = require('./operazioni');
const annullo = require('../annullo');

const origine = process.env.AMR_CENTRO_URL;
const id = process.env.AMR_NODO_ID;
const token = process.env.AMR_NODI_TOKEN;

let attivo = true;
let inCorso = null;
let controllerAttivo = null;
let heartbeatInVolo = null;
const boot = require('node:crypto').randomUUID();
let epocaCentro, sequenza = 0;
const headers = () => ({ 'x-amr-node-token': token, 'x-amr-node-id': id,
  ...(epocaCentro ? { 'x-amr-node-boot': boot, 'x-amr-center-epoch': epocaCentro } : {}) });
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function post(percorso, body) {
  const r = await fetch(origine + percorso, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  if (!r.ok) {
    if (r.headers?.get('x-amr-node-obsoleto') === '1') { attivo = false; controllerAttivo?.abort(); }
    throw new Error(`centro ${r.status}`);
  }
  return r;
}

async function heartbeat() {
  if (heartbeatInVolo) return heartbeatInVolo;
  const richiesta = post('/_nodo/heartbeat', { id, revisione: 'imac-1', occupato: !!inCorso,
    sequenza: ++sequenza,
    idLavoroAttivo: inCorso?.idLavoro || null,
    simulato: process.env.AMR_NODO_SIMULATO === '1', fonti: statoFonti() });
  heartbeatInVolo = richiesta;
  try { await richiesta; }
  finally { if (heartbeatInVolo === richiesta) heartbeatInVolo = null; }
}

function esitoSimulato(lavoro) {
  const fonte = lavoro.fonte;
  if (lavoro.operazione !== 'fonte' || !['subito', 'autoscout', 'moto'].includes(fonte)) {
    return { status: 400, body: { error: 'il nodo simulato accetta solo una fonte' } };
  }
  const vuota = { status: 'skipped', reason: 'risposta simulata: nessun portale interrogato',
    count: 0, totale: null, hasMore: null, pausa: { fermo: false, fino: null, motivo: null } };
  const skipped = { status: 'skipped', reason: 'fonte non richiesta', count: 0, totale: null, hasMore: null };
  const sources = Object.fromEntries(['subito', 'autoscout', 'moto'].map(f => [f, f === fonte ? vuota : skipped]));
  return { status: 200, body: { risultati: [], totale: 0, sources,
    versioneConto: null, versionePerFonte: null } };
}

async function avvia() {
  if (!origine || !id || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origine)) {
    throw new Error('Il nodo di prova richiede centro loopback, ID e token');
  }
  const registro = await fetch(origine + '/_nodo/registrazione', {
    headers: headers(), signal: AbortSignal.timeout(4000) });
  if (!registro.ok) throw new Error('registrazione nodo non disponibile');
  const contesto = await registro.json();
  epocaCentro = contesto.epoca;
  if (!attivo) return;
  await post('/_nodo/registrazione', { epoca: epocaCentro, boot, precedente: contesto.boot });
  while (attivo) {
    try {
      await heartbeat();
      if (!attivo) break;
      const r = await fetch(`${origine}/_nodo/poll?id=${encodeURIComponent(id)}`, {
        headers: headers(), signal: AbortSignal.timeout(4000),
      });
      if (!attivo) { await r.body?.cancel(); break; }
      if (r.status === 204) { await pausa(250); continue; }
      if (!r.ok) {
        if (r.headers?.get('x-amr-node-obsoleto') === '1') attivo = false;
        throw new Error(`poll ${r.status}`);
      }
      const lavoro = await r.json();
      if (!attivo) break;
      inCorso = lavoro;
      const ctrl = new AbortController();
      controllerAttivo = ctrl;
      const controllo = setInterval(() => heartbeat().catch(() => ctrl.abort()), 2000);
      let esito;
      const inizioLavoro = performance.now();
      try { esito = process.env.AMR_NODO_SIMULATO === '1' ? esitoSimulato(lavoro)
        : await annullo.dentro(ctrl.signal, () => esegui(lavoro)); }
      catch (e) { esito = { status: 502, body: { error: e.message || 'errore nodo' } }; }
      const durataMs = Math.round(performance.now() - inizioLavoro);
      clearInterval(controllo);
      // clearInterval non annulla un invio già partito: finirlo prima di cambiare job.
      await heartbeatInVolo?.catch(() => ctrl.abort());
      try { if (!ctrl.signal.aborted) await post('/_nodo/esito', { id, idLavoro: lavoro.idLavoro,
        tentativo: lavoro.tentativo, esito, durataMs }); }
      finally { inCorso = null; controllerAttivo = null; }
    } catch (e) {
      // La caduta del centro rende incerto il lavoro già avviato: nessun replay automatico.
      inCorso = null;
      if (attivo) await pausa(1000);
    }
  }
}

// Se il launcher del collaudo cade, non lasciare un worker orfano che continua a fare polling.
process.on('disconnect', () => { attivo = false; controllerAttivo?.abort(); });
process.on('SIGTERM', () => { attivo = false; controllerAttivo?.abort(); });
process.on('SIGINT', () => { attivo = false; controllerAttivo?.abort(); });
if (require.main === module) avvia();
module.exports = { avvia };
