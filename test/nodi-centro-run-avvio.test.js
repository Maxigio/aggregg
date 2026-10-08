'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Esegue il sorgente entrypoint senza sostituzioni, con processo, pool e HTTP
// simulati. Non legge process.env reale, non apre socket né usa PostgreSQL.
function avvio({ erroreCleanup = false } = {}) {
  const conteggi = {}, conta = k => { conteggi[k] = (conteggi[k] || 0) + 1; };
  const errori = [];
  let risolviInit, rifiutaInit, listening;
  const init = new Promise((resolve, reject) => { risolviInit = resolve; rifiutaInit = reject; });
  const processo = new EventEmitter(); processo.versions = { node: '24.0.0' }; processo.env = {};
  const server = new EventEmitter();
  server.listen = (port, host, cb) => { assert.equal(port, 3000); assert.equal(host, '0.0.0.0'); conta('listen'); listening = cb; };
  server.close = () => conta('server.close'); server.closeAllConnections = () => conta('server.closeAllConnections');
  const close = nome => () => conta(nome + '.close');
  class Pool extends EventEmitter { constructor() { super(); conta('pool'); } async end() { conta('pool.end'); } }
  const accessi = { close: close('accessi') }, aziende = { close: close('aziende') }, colleghi = { close: close('colleghi') };
  const worker = { start: () => conta('worker.start'), stop: async () => conta('worker.stop') };
  const notifiche = { close: async () => conta('notifiche.close') };
  const config = { releaseFile: '/sintetico/release.json', origine: 'https://amr.invalid', auth: 'https://auth.amr.invalid/v1',
    proxy: ['127.0.0.1'], pools: { lettura: {}, commerciale: {}, backup: {} }, port: 3000 };
  const moduli = {
    'node:fs': { readFileSync: () => '{}' },
    'node:path': path,
    'pg': { Pool },
    './compatibilita-nodo': { verificaArtefatto: m => m },
    './config-centro-run': { configura: env => { assert.equal(env, processo.env); return config; } },
    './backup-segreti-run': { preparaSegreti: env => ({ ambiente: env, chiudi: () => {
      conta('segreti.close'); if (erroreCleanup) throw new Error('/sentinella/privata: segreto sintetico');
    } }) },
    './betterstack': { creaInvio: opzioni => { assert.equal(opzioni.url, undefined); return null; } },
    './centro': { creaCentro: opzioni => { opzioni.inizializzaAccessi({}); return { app: {}, close: close('centro') }; } },
    './nhost-auth-client': { creaClient: opzioni => { assert.equal(opzioni.origineAuth, 'https://auth.amr.invalid'); return {}; } },
    './accessi-postgres-prova': { creaAccessiPostgres: () => ({}) },
    './aziende-postgres-prova': { creaAziendePostgres: () => ({}) },
    './colleghi-postgres-prova': { creaColleghiPostgres: () => ({}) },
    './login-nhost-prova': { mount: () => accessi },
    './aziende-prova-route': { mount: () => aziende },
    './colleghi-prova-route': { mount: () => colleghi },
    './backup-prova-route': { mount: () => {} },
    './backup-centro-run': { preparaCopie: () => ({}) },
    './backup-postgres-prova': { creaBackupPostgres: () => worker, creaStatoBackup: () => ({}),
      collegaNotificheBackup: () => init },
    'node:http': { createServer: () => { conta('server'); return server; } },
  };
  const modulo = { exports: {} };
  const requireSimulato = nome => { assert.ok(Object.hasOwn(moduli, nome), 'modulo previsto: ' + nome); return moduli[nome]; };
  requireSimulato.main = modulo;
  const sorgente = fs.readFileSync(path.join(__dirname, '../backend/nodi/centro-run.js'), 'utf8');
  vm.runInNewContext(sorgente, { require: requireSimulato, module: modulo, process: processo, URL,
    __dirname: path.join(__dirname,'../backend/nodi'),
    console: { log: () => conta('log'), error: testo => { conta('error'); errori.push(testo); } } }, { filename: 'centro-run.js' });
  return { conteggi, errori, processo, server, terminaInit: () => risolviInit(notifiche),
    fallisciInit: () => rifiutaInit(new Error('errore sintetico')), listening: () => listening?.() };
}
const assesta = () => new Promise(resolve => setImmediate(resolve));
function risorseChiuse(f, notifiche = 1) {
  for (const nome of ['centro.close', 'accessi.close', 'aziende.close', 'colleghi.close', 'worker.stop']) {
    assert.equal(f.conteggi[nome], 1, nome);
  }
  assert.equal(f.conteggi['pool.end'], 3);
  assert.equal(f.conteggi['notifiche.close'] || 0, notifiche);
}

test('avvio: SIGTERM durante init chiude risorse appena disponibili senza listen', async () => {
  const f = avvio(); assert.equal(f.processo.listenerCount('SIGTERM'), 1);
  f.processo.emit('SIGTERM'); assert.equal(f.conteggi.listen, undefined);
  f.terminaInit(); await assesta();
  risorseChiuse(f); assert.equal(f.conteggi.server, undefined); assert.equal(f.conteggi.log, undefined);
  f.processo.emit('SIGINT'); await assesta(); risorseChiuse(f);
});
test('avvio: SIGTERM durante listen, callback tardivo non annuncia startup', async () => {
  const f = avvio(); f.terminaInit(); await assesta(); assert.equal(f.conteggi.listen, 1);
  f.processo.emit('SIGTERM'); await assesta(); f.listening(); await assesta();
  risorseChiuse(f); assert.equal(f.conteggi['server.close'], 1); assert.equal(f.conteggi['server.closeAllConnections'], 1);
  assert.equal(f.conteggi.log, undefined);
});
test('avvio: dopo listen SIGTERM e SIGINT condividono una sola chiusura', async () => {
  const f = avvio(); f.terminaInit(); await assesta(); f.listening(); await assesta();
  assert.equal(f.conteggi.log, 1); f.processo.emit('SIGTERM'); f.processo.emit('SIGINT'); await assesta();
  risorseChiuse(f); assert.equal(f.conteggi['server.close'], 1);
});
test('avvio: init respinta dopo SIGTERM ripulisce e mantiene errore generico', async () => {
  const f = avvio(); f.processo.emit('SIGTERM'); f.fallisciInit(); await assesta();
  risorseChiuse(f, 0); assert.equal(f.conteggi.server, undefined); assert.equal(f.conteggi.error, 1);
  assert.equal(f.processo.exitCode, 1);
});
test('avvio: cleanup fallito dopo SIGTERM resta gestito senza percorsi o segreti nei log', async () => {
  const f = avvio({ erroreCleanup: true }); f.terminaInit(); await assesta(); f.listening(); await assesta();
  f.processo.emit('SIGTERM'); await assesta();
  risorseChiuse(f); assert.equal(f.conteggi['segreti.close'], 1); assert.equal(f.processo.exitCode, 1);
  assert.deepEqual(f.errori, ['Centro AMR: chiusura non confermata.']);
});
test('avvio: init e cleanup falliti mantengono la diagnostica controllata', async () => {
  const f = avvio({ erroreCleanup: true }); f.fallisciInit(); await assesta();
  risorseChiuse(f, 0); assert.equal(f.processo.exitCode, 1); assert.equal(f.conteggi['segreti.close'], 1);
  assert.deepEqual(f.errori, ['Centro AMR: chiusura non confermata.',
    'Centro AMR non avviato: verificare configurazione e runtime.']);
});
