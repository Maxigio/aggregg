'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('collaudo Nhost: diagnostica SQLSTATE preservata tra chunk senza log raw',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
  const start=source.indexOf('let sqlState ='),end=source.indexOf("child.stdin.on('error'",start);
  assert.ok(start>0&&end>start);
  for(const [chunks,atteso] of [
    [['ERROR: 427','03\n'],'42703'],
    [['ER','ROR: ','P0','001\n'],'P0001'],
    [['dettaglio sintetico\nERROR: 42501\n','ERROR: 42703\n'],'42501'],
    [['ERROR: dato riservato non riconoscibile\n'],''],
  ]) {
    const stderr=new EventEmitter();
    const leggi=vm.runInNewContext('(()=>{'+source.slice(start,end)
      +';return ()=>({sqlState,sqlTail});})()',{child:{stderr}});
    for(const chunk of chunks)stderr.emit('data',Buffer.from(chunk));
    assert.equal(leggi().sqlState,atteso);assert.ok(leggi().sqlTail.length<=64);
  }
});

test('collaudo Nhost: listen fallito raggiunge il cleanup dei soli container di prova', async () => {
  for (const [asincrono,conserva] of [[false,false],[true,false],[false,true]]) {
    const processo = new EventEmitter();
    processo.env = { AMR_NHOST_DOCKER_HOST: 'unix:///synthetic/amr-auth/docker.sock' };
    const chiamate = [], modulo = { exports: {} };
    let ascoltatoriErrore;
    let source = fs.readFileSync(path.join(__dirname, '../scripts/collauda-nhost-locale.js'), 'utf8')
      .replace(/module.exports = \{[^\n]+\};/, 'module.exports = { collauda };');
    if(conserva) source=source.replace("await docker('up', '-d', '--wait', 'postgres', 'mail');",
      "conservaTemporanei=true; throw new Error('cleanup incompleto del gate figlio');");
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
        child.stderr = new EventEmitter(); child.stderr.resume = () => {}; child.kill = () => {};
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
    assert.deepEqual(chiamate, conserva ? ['down'] : ['down', 'rm']);
    assert.equal(processo.listenerCount('SIGINT'), 0);
    assert.equal(processo.listenerCount('SIGTERM'), 0);
  }
});

test('collaudo immagine: errore di cleanup preserva il flag nel chiamante',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
  const inizio=source.indexOf("if (!manuale && process.env.AMR_TEST_CENTRO_IMAGE)");
  const fine=source.indexOf('await sql(`UPDATE amr_accessi.aziende SET accettata_il',inizio);
  assert.ok(inizio>0&&fine>inizio);
  for(const conserva of [false,true]) {
    const e=Object.assign(new Error('messaggio con segreto da non riportare'),{conservaTemporanei:conserva,
      faseGate:conserva?'fixture e immagine locale':'segreto da non riportare',
      puntoGate:conserva?'collauda-centro-immagine-locale.js:99:7':'/percorso/privato',
      codeGate:conserva?'42703':'segreto-da-non-riportare',confrontoGate:{actual:403,expected:200}});
    const c={process:{env:{AMR_TEST_CENTRO_IMAGE:'amr-centro:fixture'}},manuale:false,risultati:[],
      host:'sintetico',docker(){},directory:'/synthetic',readerPassword:'sintetico',writerPassword:'sintetico',
      backupPassword:'sintetico',email:'fixture@amr.invalid',password:'sintetico',generated:{data:{totpSecret:'SYNTHETIC'}},
      preMfa:{user:{id:'sintetico'}},sql(){},fermata:{signal:new AbortController().signal},
      destinatario:'ref@amr.invalid',pwInvito:'sintetico',conservaTemporanei:false,diagnosi:'',
      require:()=>({collaudaImmagine:async()=>{throw e;}})};
    await assert.rejects(vm.runInNewContext('(async()=>{'+source.slice(inizio,fine)+'})()',c),err=>err===e);
    assert.equal(c.conservaTemporanei,conserva);
    assert.equal(c.diagnosi,conserva?'fixture e immagine locale · collauda-centro-immagine-locale.js:99:7 · 42703 · ricevuto 403, atteso 200'
      :'ricevuto 403, atteso 200');
    assert.ok(!c.diagnosi.includes('segreto'));
  }
});
