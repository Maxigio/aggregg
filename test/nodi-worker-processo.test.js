'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { avviaWorker } = require('../backend/nodi/worker-processo-prova');

test('worker collaudo: ambiente minimo, dati temporanei e arresto del solo figlio', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-worker-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const figlio = new EventEmitter(), segnali = []; let config;
  figlio.kill = s => { segnali.push(s); setImmediate(() => figlio.emit('exit', 0)); };
  const w = avviaWorker({ origine: 'http://127.0.0.1:1234', token: 't'.repeat(64), directory,
    spawn: (exe, args, opts) => { config = opts; assert.equal(exe, process.execPath); assert.match(args[0], /worker\.js$/); return figlio; } });
  assert.equal(config.env.USER_DATA_PATH, directory);
  assert.equal(config.env.AMR_NODO_ID, 'locale');
  assert.equal(config.env.AMR_NODO_SIMULATO, undefined);
  assert.ok(!Object.keys(config.env).some(k => /PASSWORD|SMTP|JWT|AUTH/.test(k)));
  assert.deepEqual(config.stdio, ['ignore','ignore','ignore','ipc']);
  await w.close(); await w.close(); assert.deepEqual(segnali, ['SIGTERM']); assert.equal(w.terminato, true);
});

test('worker reale collaudo: heartbeat senza lavori e nessuna chiamata ai portali', async t => {
  const { creaCentro } = require('../backend/nodi/centro');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-worker-heartbeat-'));
  const token = 't'.repeat(64), centro = creaCentro({ tokens: {locale:token}, directory:path.join(dir,'centro') });
  const server = require('node:http').createServer(centro.app).listen(0,'127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let w;
  t.after(async () => { await w?.close(); centro.close(); server.closeAllConnections();
    await new Promise(r => server.close(r)); fs.rmSync(dir,{recursive:true,force:true}); });
  w = avviaWorker({origine:'http://127.0.0.1:'+server.address().port,token,directory:path.join(dir,'worker')});
  for (let i=0;i<150&&centro.nodi.get('locale')?.simulato===undefined&&!w.terminato;i++) await new Promise(r=>setTimeout(r,100));
  assert.equal(w.terminato,false); assert.equal(centro.nodi.get('locale')?.simulato,false);
  assert.equal(centro.lavori.size,0);
  assert.equal(centro.db.prepare('SELECT count(*) n FROM lavori').get().n,0);
  // Il figlio esce anche se perde il launcher, senza restare in polling.
  w.processo.disconnect();
  for(let i=0;i<100&&!w.terminato;i++) await new Promise(r=>setTimeout(r,50));
  assert.equal(w.terminato,true);
});

test('worker: stop durante il poll non avvia il lavoro ricevuto dopo', async () => {
  const vm = require('node:vm');
  const sorgente = fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8');
  for (const evento of ['disconnect','SIGTERM']) {
    let completaPoll, eseguiti = 0, letture = 0;
    const processo = new EventEmitter();
    processo.env = { AMR_CENTRO_URL:'http://127.0.0.1:1234',AMR_NODO_ID:'locale',AMR_NODI_TOKEN:'sintetico' };
    const modulo = {exports:{}};
    const context = vm.createContext({module:modulo,process:processo,AbortSignal,AbortController,performance,
      setTimeout,clearTimeout,setInterval,clearInterval,
      require: name => name === 'node:crypto' ? require(name) : name === './operazioni' ? {statoFonti:()=>({}),esegui:async()=>{eseguiti++;return {status:200,body:{}};}}
        : {dentro:async(signal,fn)=>fn()},
      fetch:async url=>url.endsWith('/registrazione')?{ok:true,json:async()=>({epoca:'centro',boot:null})}:url.includes('/poll')?new Promise(r=>{completaPoll=r;}):{ok:true}
    });
    vm.runInContext(sorgente,context);
    const p = modulo.exports.avvia();
    for(let i=0;i<10&&!completaPoll;i++)await new Promise(r=>setImmediate(r));
    assert.ok(completaPoll); processo.emit(evento);
    completaPoll({status:200,ok:true,body:{cancel:async()=>{}},json:async()=>{letture++;return{operazione:'fonte',input:{}};}});
    await p;assert.equal(eseguiti,0);assert.equal(letture,0);
  }
});

test('worker: heartbeat pendente termina prima dell’esito e del lavoro successivo', async () => {
  const vm = require('node:vm'), processo = new EventEmitter();
  processo.env = { AMR_CENTRO_URL:'http://127.0.0.1:1234', AMR_NODO_ID:'locale', AMR_NODI_TOKEN:'sintetico' };
  const modulo = { exports:{} }, ordine = [];
  let timer, terminaA, terminaB, terminaHeartbeat, pollCount = 0;
  const tick = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
  const context = vm.createContext({ module:modulo, process:processo, AbortSignal, AbortController, performance,
    setTimeout, clearTimeout, setInterval:fn=>{timer=fn;return 1;}, clearInterval:()=>{},
    require:name=>name==='node:crypto'?require(name):name==='./operazioni'?{statoFonti:()=>({}),esegui:job=>{
      ordine.push('avvio-'+job.idLavoro);
      return new Promise(r=>{if(job.idLavoro==='A')terminaA=r;else terminaB=r;});
    }}:{dentro:(_s,fn)=>fn()},
    fetch:async(url,opt)=>{
      if(url.endsWith('/registrazione'))return {ok:true,json:async()=>({epoca:'centro',boot:null})};
      if(url.includes('/poll'))return {ok:true,status:200,json:async()=>({idLavoro:++pollCount===1?'A':'B',tentativo:1,input:{}})};
      const body=JSON.parse(opt.body);
      if(url.endsWith('/heartbeat')&&body.idLavoroAttivo==='A')return new Promise(r=>{terminaHeartbeat=()=>{ordine.push('heartbeat-A');r({ok:true});};});
      if(url.endsWith('/esito'))ordine.push('esito-'+body.idLavoro);
      return {ok:true};
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8'),context);
  const running=modulo.exports.avvia(); await tick(); assert.ok(terminaA);
  timer(); await tick(); assert.ok(terminaHeartbeat);
  timer(); await tick(); // Non aprire un secondo heartbeat durante il primo.
  terminaA({status:200,body:{}}); await tick();
  assert.deepEqual(ordine,['avvio-A']); assert.equal(pollCount,1);
  terminaHeartbeat(); await tick();
  assert.deepEqual(ordine,['avvio-A','heartbeat-A','esito-A','avvio-B']);
  processo.emit('SIGTERM'); terminaB({status:200,body:{}}); await running;
});
