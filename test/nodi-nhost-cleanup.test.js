'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('collaudo Nhost: listen fallito raggiunge il cleanup dei soli container di prova', async () => {
  for (const asincrono of [false, true]) {
    const processo = new EventEmitter();
    processo.env = { AMR_NHOST_DOCKER_HOST: 'unix:///synthetic/amr-auth/docker.sock' };
    const chiamate = [], modulo = { exports: {} };
    let ascoltatoriErrore;
    const source = fs.readFileSync(path.join(__dirname, '../scripts/collauda-nhost-locale.js'), 'utf8')
      .replace('module.exports = { configura, IMMAGINI, totp, credenzialiLocali };', 'module.exports = { collauda };');
    vm.runInNewContext(source, {
      module: modulo, process: processo, __dirname: path.join(__dirname, '../scripts'),
      AbortController, AbortSignal, Buffer, URL, setTimeout, clearTimeout,
      console: { log() {}, error() {} },
      require: nome => nome === 'node:fs' ? {
        mkdtempSync: () => '/synthetic', chmodSync() {}, writeFileSync() {},
        rmSync() { chiamate.push('rm'); },
      } : nome === 'node:http' ? { createServer() {
        const server = new EventEmitter();
        server.listen = () => {
          const errore = Object.assign(new Error('listen sintetico'), { code: 'EACCES' });
          if (!asincrono) throw errore;
          ascoltatoriErrore = server.listenerCount('error');
          if (ascoltatoriErrore) queueMicrotask(() => server.emit('error', errore));
        };
        server.closeAllConnections = () => {};
        server.close = callback => callback();
        return server;
      } } : nome === 'node:child_process' ? { spawn() {
        const child = new EventEmitter(); child.stdout = new EventEmitter();
        child.stderr = { resume() {} }; child.kill = () => {};
        child.stdin = { on() {}, end() { queueMicrotask(() => child.emit('close', 0)); } };
        return child;
      } } : nome === 'node:util' ? { promisify: () => async (_bin, args) => {
        if (args.includes('down')) chiamate.push('down');
        return { stdout: args.includes('port') ? '127.0.0.1:55555' : '' };
      } } : require(nome),
    });
    let timer;
    try {
      await assert.rejects(Promise.race([modulo.exports.collauda(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup non raggiunto')), 200); }),
      ]), /Collaudo interrotto nella fase: avvio/);
    } finally { clearTimeout(timer); }
    if (asincrono) assert.equal(ascoltatoriErrore, 1);
    assert.deepEqual(chiamate, ['down', 'rm']);
    assert.equal(processo.listenerCount('SIGINT'), 0);
    assert.equal(processo.listenerCount('SIGTERM'), 0);
  }
});
