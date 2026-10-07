'use strict';

let esegui, statoFonti, annullo;

const origine = process.env.AMR_CENTRO_URL;
const id = process.env.AMR_NODO_ID;
const token = process.env.AMR_NODI_TOKEN;
const soloStato = process.env.AMR_NODO_SOLO_STATO === '1';

let attivo = true;
let stopManuale = false;
let inCorso = null;
let controllerAttivo = null;
let heartbeatInVolo = null;
const boot = require('node:crypto').randomUUID();
let epocaCentro, sequenza = 0;
let release = null;
let sondeAutomatiche = false;
const guasto = (codice, uscita) => Object.assign(new Error(codice), { uscita });
function notifica(body) {
  if (process.connected) process.send(body, () => {});
}
async function controllaHttp(r) {
  if (r.ok) return;
  if ([401, 403].includes(r.status)) throw guasto('credenziale_revocata', 77);
  if (r.headers?.get('x-amr-node-obsoleto') === '1') {
    // Centro riavviato: nuovo handshake. Un altro worker con la stessa
    // identità nella medesima epoca invece richiede intervento, non contesa.
    const registro = await fetch(origine + '/_nodo/registrazione', {
      headers: headers(), redirect: 'error', signal: AbortSignal.timeout(4000) });
    if ([401,403].includes(registro.status)) throw guasto('credenziale_revocata', 77);
    if (!registro.ok) throw guasto('centro_non_disponibile', 75);
    const c = await registro.json();
    if (c.epoca !== epocaCentro) {
      notifica({ tipo: 'worker_contesto', epoca: c.epoca, boot: c.boot });
      throw guasto('centro_non_disponibile', 75);
    }
    throw guasto('worker_sostituito', 79);
  }
  if (r.status < 500) throw guasto('configurazione_incompatibile', 78);
  throw guasto('centro_non_disponibile', 75);
}
const headers = () => ({ 'x-amr-node-token': token, 'x-amr-node-id': id,
  ...(epocaCentro ? { 'x-amr-node-boot': boot, 'x-amr-center-epoch': epocaCentro } : {}) });
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function post(percorso, body) {
  const r = await fetch(origine + percorso, { method: 'POST',
    redirect: 'error',
    headers: { 'content-type': 'application/json', ...headers() },
    body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  // Un risultato già scaduto è scartato dal centro: non è un'incompatibilità
  // del worker e non autorizza a ripetere il lavoro o a riavviare il processo.
  if (percorso === '/_nodo/esito' && r.status === 409 && r.headers?.get('x-amr-node-obsoleto') !== '1') return r;
  try { await controllaHttp(r); }
  catch (e) { attivo = false; controllerAttivo?.abort(); throw e; }
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
  try { await richiesta; notifica({ tipo: 'worker_attivo' }); }
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
  try { url = new URL(origine); } catch { throw guasto('configurazione_incompatibile', 78); }
  if (!id || !token || url.origin !== origine || url.username || url.password
      || (url.protocol !== 'https:' && !/^http:\/\/127\.0\.0\.1:\d+$/.test(origine))) {
    throw guasto('configurazione_incompatibile', 78);
  }
  const compat = process.env.AMR_NODI_RELEASE_FILE ? require('./compatibilita-nodo') : null;
  if (compat) {
    let artefatto;
    try {
      const fs = require('node:fs'), file = process.env.AMR_NODI_RELEASE_FILE, stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error();
      artefatto = JSON.parse(fs.readFileSync(file, 'utf8'));
      release = compat.verificaArtefatto(artefatto, require('node:path').resolve(__dirname, '../..'));
    } catch (e) {
      // Conservare i codici del validatore per i chiamanti, mai messaggi fs o percorsi.
      throw guasto(['codice_non_leggibile','cataloghi_non_leggibili','codice_release_incompatibile',
        'cataloghi_release_incompatibili','inventario_release_non_valido','inventario_release_incompleto',
        'file_release_non_valido','compatibilita_nodo_non_valida'].includes(e.message)
        ? e.message : 'configurazione_incompatibile', 78);
    }
  }
  if (url.protocol === 'https:' && !release) throw guasto('configurazione_incompatibile', 78);
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
  await controllaHttp(registro);
  const contesto = await registro.json();
  epocaCentro = contesto.epoca;
  notifica({ tipo: 'worker_contesto', epoca: epocaCentro, boot: contesto.boot });
  if (compat && !compat.compatibile(release, contesto.compatibilita)) throw guasto('configurazione_incompatibile', 78);
  if (!attivo) return;
  await post('/_nodo/registrazione', { epoca: epocaCentro, boot, precedente: contesto.boot,
    ...(release ? { compatibilita: release } : {}) });
  notifica({ tipo: 'worker_contesto', epoca: epocaCentro, boot });
  let guastoHeartbeat = null;
  // Anche durante un poll lento il centro deve poter osservare il nodo.
  const controllo = setInterval(() => {
    if (attivo) void heartbeat().catch(e => {
      guastoHeartbeat = e; attivo = false; controllerAttivo?.abort();
    });
  }, 2000);
  try {
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
        await controllaHttp(r);
      }
      const lavoro = await r.json();
      if (!attivo) break;
      inCorso = lavoro;
      const ctrl = new AbortController();
      controllerAttivo = ctrl;
      const scadenzaSonda = lavoro.operazione === 'sonda'
        ? setTimeout(() => ctrl.abort(), Math.min(29000, Math.max(1, lavoro.budgetMs || 29000))) : null;
      let esito;
      const inizioLavoro = performance.now();
      try { esito = lavoro.versioneProtocollo !== 1
        ? { status: 409, body: { error: 'protocollo del lavoro incompatibile' } }
        : process.env.AMR_NODO_SIMULATO === '1' ? esitoSimulato(lavoro)
        : await annullo.dentro(ctrl.signal, () => esegui(lavoro)); }
      catch (e) { esito = { status: 502, body: { error: e.message || 'errore nodo' } }; }
      const durataMs = Math.round(performance.now() - inizioLavoro);
      if (scadenzaSonda) clearTimeout(scadenzaSonda);
      // Un invio già partito conserva l'identità del job: finirlo prima di cambiarla.
      await heartbeatInVolo?.catch(e => { guastoHeartbeat = e; ctrl.abort(); });
      if (guastoHeartbeat) throw guastoHeartbeat;
      try { if (!ctrl.signal.aborted) await post('/_nodo/esito', { id, idLavoro: lavoro.idLavoro,
        tentativo: lavoro.tentativo, esito, durataMs }); }
      finally { inCorso = null; controllerAttivo = null; }
    } catch (e) {
      // La caduta del centro rende incerto il lavoro già avviato: nessun replay automatico.
      inCorso = null;
      controllerAttivo?.abort(); controllerAttivo = null;
      if (attivo || e.uscita) throw e;
    }
  }
  } finally {
    clearInterval(controllo);
    await heartbeatInVolo?.catch(e => { guastoHeartbeat = e; });
  }
  if (guastoHeartbeat) throw guastoHeartbeat;
}

// Se il launcher del collaudo cade, non lasciare un worker orfano che continua a fare polling.
const arresta = () => { stopManuale = true; attivo = false; controllerAttivo?.abort(); };
process.on('disconnect', arresta);
process.on('SIGTERM', arresta);
process.on('SIGINT', arresta);
// Il canale del launcher tiene vivo il figlio anche dopo la fine del ciclo.
// Chiuderlo solo a lavoro terminato permette un arresto naturale, senza SIGKILL.
if (require.main === module) avvia().catch(e => {
  process.exitCode = stopManuale ? 0 : e.uscita || 75;
  if (!stopManuale) console.error('[nodi] worker fermato: ' + (e.uscita ? e.message : 'centro_non_disponibile'));
}).finally(() => {
  if (process.connected) process.disconnect();
});
module.exports = { avvia };
