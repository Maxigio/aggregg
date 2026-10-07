'use strict';

const fs = require('node:fs'), path = require('node:path');
const { EventEmitter } = require('node:events');
const CODICI = { 77: 'credenziale_revocata', 78: 'configurazione_incompatibile', 79: 'worker_sostituito' };

// Una sola autorità di restart, esterna al worker. Non ripete i lavori del centro.
function supervisiona({ file, cwd, env, stdio = ['ignore', 'ignore', 'ignore', 'ipc'],
  spawn = require('node:child_process').spawn,
  attese = [1000, 2000, 4000, 8000, 16000], stabilitaMs = 300000,
  ora = () => Date.now(), mono = () => performance.now(), random = Math.random,
  timer = setTimeout, cancella = clearTimeout, invia = fetch }) {
  if (!path.isAbsolute(file) || !path.isAbsolute(cwd) || !path.isAbsolute(env.USER_DATA_PATH)
      || attese.length !== 5 || attese.some(ms => !Number.isFinite(ms) || ms <= 0)
      || !Number.isFinite(stabilitaMs) || stabilitaMs <= 0) throw new Error('supervisione_non_valida');
  const eventi = new EventEmitter();
  const registro = path.join(env.USER_DATA_PATH, 'worker-supervisione.json');
  fs.mkdirSync(env.USER_DATA_PATH, { recursive: true, mode: 0o700 });
  let child, restartTimer, killTimer, invioTimer, contesto, stabileDa, ultimoHeartbeat;
  let restart = 0, sequenza = 0, chiuso = false, finito = false, chiusura, fineChiusura;
  let childChiuso = true;
  let fineEmessa = false;
  let richiestaInVolo = false, daInviare = false;
  let invioAttuale = null, invioFinale = null, ricevuta = null, generazione = 0, precedentiNonConfermati = [];
  if (fs.existsSync(registro)) {
    if (fs.lstatSync(registro).isSymbolicLink() || fs.statSync(registro).size > 3 * 1024 * 1024) throw new Error('registro_supervisione_non_valido');
    const precedente = JSON.parse(fs.readFileSync(registro, { encoding: 'utf8', flag: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }));
    precedentiNonConfermati = precedente.precedentiNonConfermati ||
      (precedente.precedenteNonConfermato ? [precedente.precedenteNonConfermato] : []);
    if (!Array.isArray(precedentiNonConfermati) || precedentiNonConfermati.length >= 10000) throw new Error('registro_supervisione_non_valido');
    if (['fermato', 'intervento'].includes(precedente.stato) && precedente.comunicazione?.stato !== 'accettato') {
      precedentiNonConfermati.push({ stato: precedente.stato, motivo: precedente.motivo,
        aggiornato: precedente.aggiornato, comunicazione: precedente.comunicazione || { stato: 'non_confermato' } });
    }
  }
  let stato = { stato: 'avvio', motivo: null, restart: 0, prossimo: null, aggiornato: ora() };

  function salva() {
    // Il file contiene solo stato tecnico; nessun token, ambiente o messaggio remoto.
    const tmp = registro + '.tmp-' + require('node:crypto').randomUUID();
    let creato = false;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...stato, comunicazione: ricevuta,
        precedentiNonConfermati }), { mode: 0o600, flag: 'wx' });
      creato = true;
      fs.renameSync(tmp, registro);
    } finally {
      if (creato) { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    }
  }
  function comunica() {
    if (richiestaInVolo) return invioAttuale;
    if (!contesto || !daInviare) return Promise.resolve();
    richiestaInVolo = true; daInviare = false;
    const versione = sequenza, c = { ...contesto }, invioGenerazione = generazione;
    invioAttuale = (async () => {
    let timeout;
    try {
      const r = await Promise.race([invia(env.AMR_CENTRO_URL + '/_nodo/supervisione', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
        headers: { 'content-type': 'application/json', 'x-amr-node-id': env.AMR_NODO_ID,
          'x-amr-node-token': env.AMR_NODI_TOKEN },
        body: JSON.stringify({ ...stato, epoca: c.epoca, boot: c.boot, sequenza: versione }) }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('invio_scaduto')), 4500); })]);
      const confermata = r.ok && (!r.json || (await r.json()).accepted !== false);
      await r.body?.cancel();
      if (invioGenerazione === generazione) {
        ricevuta = { stato: confermata ? 'accettato' : r.ok || r.status >= 500 ? 'incerto' : 'rifiutato',
          epoca: c.epoca, boot: c.boot, sequenza: versione };
        salva();
      }
      if (!r.ok && ![401, 403, 409].includes(r.status)) daInviare = true;
    } catch {
      daInviare = true;
      if (invioGenerazione === generazione) {
        ricevuta = { stato: 'incerto', epoca: c.epoca, boot: c.boot, sequenza: versione };
        try { salva(); } catch {}
      }
    }
    finally {
      clearTimeout(timeout);
      richiestaInVolo = false;
      if (daInviare && !chiuso) {
        invioTimer = timer(() => { invioTimer = null; void comunica(); }, 5000);
        invioTimer.unref?.();
      }
    }
    })();
    return invioAttuale;
  }
  function comunicaFinale() {
    return invioFinale ||= (async () => {
      await comunica();
      // Uno stato precedente in volo non deve impedire il tentativo finale dello stop.
      if (daInviare && contesto) { cancella(invioTimer); invioTimer = null; await comunica(); }
    })();
  }
  function aggiorna(nome, motivo = null, prossimo = null) {
    stato = { stato: nome, motivo, restart, prossimo, aggiornato: ora() }; sequenza++; generazione++;
    ricevuta = { stato: 'pendente', epoca: contesto?.epoca ?? null, boot: contesto?.boot ?? null, sequenza };
    try { salva(); }
    catch {
      // Senza ricevuta locale non perdere silenziosamente l'avviso di stop.
      stato = { ...stato, stato: 'intervento', motivo: 'registro_non_disponibile', prossimo: null };
      finito = true;
      if (child && !childChiuso) {
        child.kill('SIGTERM');
        killTimer ||= timer(() => child.kill('SIGKILL'), 5000);
      }
    }
    daInviare = true; void comunica(); eventi.emit('stato', { ...stato });
    return !finito;
  }
  function avvia() {
    if (chiuso || finito) return;
    stabileDa = ultimoHeartbeat = null;
    if (!aggiorna('avvio')) { emettiFine(78, null); return; }
    let erroreSpawn = null;
    try { child = spawn(process.execPath, [file], { cwd, env, stdio }); }
    catch { termina(78, null); return; }
    const corrente = child;
    childChiuso = false;
    corrente.on('error', e => { erroreSpawn = e.code || 'spawn'; });
    corrente.on('message', m => {
      if (corrente !== child || chiuso || finito || !m || typeof m !== 'object') return;
      if (m.tipo === 'worker_contesto' && typeof m.epoca === 'string' && m.epoca.length <= 80
          && (m.boot === null || /^[a-f0-9-]{36}$/.test(m.boot || ''))) {
        contesto = { epoca: m.epoca, boot: m.boot }; sequenza = 0;
        aggiorna(stato.stato, stato.motivo, stato.prossimo);
      } else if (m.tipo === 'worker_attivo') {
        const adesso = mono();
        if (ultimoHeartbeat === null || adesso - ultimoHeartbeat > 10000) stabileDa = adesso;
        ultimoHeartbeat = adesso;
        if (restart && adesso - stabileDa >= stabilitaMs) restart = 0;
        if (stato.stato !== 'attivo' || stato.restart !== restart) aggiorna('attivo');
      }
    });
    // 'exit' prova la morte del processo, anche se l'IPC non emette ancora
    // 'close'. Un fallimento di spawn può invece emettere soltanto 'close'.
    let concluso = false;
    const conclusione = (code, signal) => {
      if (concluso) return;
      concluso = true; termina(code, signal, erroreSpawn);
    };
    corrente.once('exit', conclusione);
    corrente.once('close', conclusione);
    eventi.emit('processo', corrente);
  }
  function termina(code, signal, erroreSpawn) {
    childChiuso = true;
    cancella(killTimer); killTimer = null;
    if (chiuso) {
      finito = true;
      if (stato.stato !== 'intervento') aggiorna('fermato', 'stop_manuale');
      emettiFine(code, signal); void comunicaFinale().finally(() => fineChiusura?.()); return;
    }
    if (finito) { emettiFine(code, signal); return; }
    const manuale = code === 0 || ['SIGTERM', 'SIGINT'].includes(signal);
    const motivo = CODICI[code] || (['ENOENT', 'EACCES'].includes(erroreSpawn) ? 'configurazione_incompatibile' : null);
    if (manuale || motivo || restart >= attese.length) {
      finito = true;
      aggiorna(manuale ? 'fermato' : 'intervento', manuale ? 'stop_manuale' : motivo || 'restart_esauriti');
      emettiFine(code, signal); return;
    }
    // Jitter positivo: nodi che perdono insieme il centro non ripartono in massa.
    const attesa = Math.round(attese[restart] * (1 + random() / 4)); restart++;
    if (!aggiorna('attesa_restart', code === 75 ? 'centro_non_disponibile' : 'crash', ora() + attesa)) {
      emettiFine(code, signal); return;
    }
    restartTimer = timer(() => { restartTimer = null; avvia(); }, attesa);
  }
  function emettiFine(code, signal) {
    if (fineEmessa) return;
    void comunicaFinale();
    fineEmessa = true; eventi.emit('fine', { code, signal, ...stato });
  }
  const close = () => chiusura ||= new Promise(resolve => {
    chiuso = true; fineChiusura = resolve;
    cancella(restartTimer); cancella(invioTimer);
    if (!child || childChiuso) {
      if (!finito) { finito = true; aggiorna('fermato', 'stop_manuale'); }
      void comunicaFinale().finally(resolve); return;
    }
    killTimer ||= timer(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
  });
  avvia();
  return { eventi, get processo() { return child; }, get child() { return child; },
    get terminato() { return finito; }, get stato() { return { ...stato }; }, close };
}
module.exports = { supervisiona, CODICI };
