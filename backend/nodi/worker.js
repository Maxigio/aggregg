'use strict';

let esegui, statoFonti, annullo;

const origine = process.env.AMR_CENTRO_URL;
const id = process.env.AMR_NODO_ID;
const token = process.env.AMR_NODI_TOKEN;
const soloStato = process.env.AMR_NODO_SOLO_STATO === '1';

let attivo = true;
let inCorso = null;
let controllerAttivo = null;
let heartbeatInVolo = null;
const boot = require('node:crypto').randomUUID();
let epocaCentro, sequenza = 0;
let release = null;
let sondeAutomatiche = false;
const headers = () => ({ 'x-amr-node-token': token, 'x-amr-node-id': id,
  ...(epocaCentro ? { 'x-amr-node-boot': boot, 'x-amr-center-epoch': epocaCentro } : {}) });
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function post(percorso, body) {
  const r = await fetch(origine + percorso, { method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...headers() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  if (!r.ok) {
    if ([401,403].includes(r.status) || r.headers?.get('x-amr-node-obsoleto') === '1') {
      attivo = false; controllerAttivo?.abort();
    }
    throw new Error(`centro ${r.status}`);
  }
  return r;
}

async function heartbeat() {
  if (heartbeatInVolo) return heartbeatInVolo;
  const richiesta = post('/_nodo/heartbeat', { id, revisione: 'imac-1', occupato: !!inCorso,
    ...(release ? { compatibilita: release } : {}),
    sequenza: ++sequenza,
    idLavoroAttivo: inCorso?.idLavoro || null,
    ...(soloStato ? { soloStato: true } : {}),
    ...(sondeAutomatiche ? { sondeAutomatiche: true } : {}),
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
  let url;
  try { url = new URL(origine); } catch { throw new Error('Configurazione del centro non valida'); }
  if (!id || !token || url.origin !== origine || url.username || url.password
      || (url.protocol !== 'https:' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origine))) {
    throw new Error('Il nodo richiede un centro HTTPS o loopback, ID e token');
  }
  const compat = process.env.AMR_NODI_RELEASE_FILE ? require('./compatibilita-nodo') : null;
  if (compat) {
    let artefatto;
    try {
      const fs = require('node:fs'), file = process.env.AMR_NODI_RELEASE_FILE, stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error();
      artefatto = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { throw new Error('manifest_release_non_valido'); }
    release = compat.verificaArtefatto(artefatto, require('node:path').resolve(__dirname, '../..'));
  }
  if (url.protocol === 'https:' && !release) throw new Error('Il nodo remoto richiede i metadati della release');
  if (!attivo) return;
  // Il gate precede il caricamento degli scraper e qualunque chiamata al centro.
  if (soloStato) {
    const salute = require('../fonti-salute');
    statoFonti = () => Object.fromEntries(['subito', 'autoscout', 'moto'].map(f => [f, salute.fermo(f)]));
  } else {
    const operazioni = require('./operazioni');
    ({ esegui, statoFonti } = operazioni);
    sondeAutomatiche = process.env.AMR_NODO_SIMULATO !== '1' && typeof operazioni.abilitaSonde === 'function';
    if (sondeAutomatiche) operazioni.abilitaSonde();
    annullo = require('../annullo');
  }
  const registro = await fetch(origine + '/_nodo/registrazione', {
    headers: headers(), redirect: 'error', signal: AbortSignal.timeout(4000) });
  if (!registro.ok) throw new Error('registrazione nodo non disponibile');
  const contesto = await registro.json();
  if (compat && !compat.compatibile(release, contesto.compatibilita)) throw new Error('Release del centro incompatibile');
  epocaCentro = contesto.epoca;
  if (!attivo) return;
  await post('/_nodo/registrazione', { epoca: epocaCentro, boot, precedente: contesto.boot,
    ...(release ? { compatibilita: release } : {}) });
  while (attivo) {
    try {
      await heartbeat();
      if (!attivo) break;
      // Il primo collegamento remoto prova il trasporto, senza caricare gli
      // scraper o chiedere lavori; lo stato non attesta la salute dei portali.
      if (soloStato) { await pausa(2000); continue; }
      const r = await fetch(`${origine}/_nodo/poll?id=${encodeURIComponent(id)}`, {
        headers: headers(), redirect: 'error', signal: AbortSignal.timeout(4000),
      });
      if (!attivo) { await r.body?.cancel(); break; }
      if (r.status === 204) { await pausa(250); continue; }
      if (!r.ok) {
        if ([401,403].includes(r.status) || r.headers?.get('x-amr-node-obsoleto') === '1') attivo = false;
        throw new Error(`poll ${r.status}`);
      }
      const lavoro = await r.json();
      if (!attivo) break;
      inCorso = lavoro;
      const ctrl = new AbortController();
      controllerAttivo = ctrl;
      const scadenzaSonda = lavoro.operazione === 'sonda'
        ? setTimeout(() => ctrl.abort(), Math.min(29000, Math.max(1, lavoro.budgetMs || 29000))) : null;
      const controllo = setInterval(() => heartbeat().catch(() => ctrl.abort()), 2000);
      let esito;
      const inizioLavoro = performance.now();
      try { esito = lavoro.versioneProtocollo !== 1
        ? { status: 409, body: { error: 'protocollo del lavoro incompatibile' } }
        : process.env.AMR_NODO_SIMULATO === '1' ? esitoSimulato(lavoro)
        : await annullo.dentro(ctrl.signal, () => esegui(lavoro)); }
      catch (e) { esito = { status: 502, body: { error: e.message || 'errore nodo' } }; }
      const durataMs = Math.round(performance.now() - inizioLavoro);
      if (scadenzaSonda) clearTimeout(scadenzaSonda);
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
// Il canale del launcher tiene vivo il figlio anche dopo la fine del ciclo.
// Chiuderlo solo a lavoro terminato permette un arresto naturale, senza SIGKILL.
if (require.main === module) avvia().finally(() => {
  if (process.connected) process.disconnect();
});
module.exports = { avvia };
