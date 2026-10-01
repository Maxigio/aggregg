'use strict';

const { esegui, statoFonti } = require('./operazioni');
const annullo = require('../annullo');

const origine = process.env.AMR_CENTRO_URL;
const id = process.env.AMR_NODO_ID;
const token = process.env.AMR_NODI_TOKEN;

let attivo = true;
let inCorso = null;
let controllerAttivo = null;
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function post(percorso, body) {
  const r = await fetch(origine + percorso, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-amr-node-token': token, 'x-amr-node-id': id },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`centro ${r.status}`);
  return r;
}

async function heartbeat() {
  await post('/_nodo/heartbeat', { id, revisione: 'imac-1', occupato: !!inCorso,
    idLavoroAttivo: inCorso?.idLavoro || null,
    simulato: process.env.AMR_NODO_SIMULATO === '1', fonti: statoFonti() });
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
  while (attivo) {
    try {
      await heartbeat();
      const r = await fetch(`${origine}/_nodo/poll?id=${encodeURIComponent(id)}`, {
        headers: { 'x-amr-node-token': token, 'x-amr-node-id': id }, signal: AbortSignal.timeout(4000),
      });
      if (r.status === 204) { await pausa(250); continue; }
      if (!r.ok) throw new Error(`poll ${r.status}`);
      const lavoro = await r.json();
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

process.on('SIGTERM', () => { attivo = false; controllerAttivo?.abort(); });
process.on('SIGINT', () => { attivo = false; controllerAttivo?.abort(); });
if (require.main === module) avvia();
module.exports = { avvia };
