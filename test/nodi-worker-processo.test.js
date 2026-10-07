'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { avviaWorker } = require('../backend/nodi/worker-processo-prova');

test('worker collaudo: ambiente minimo, dati temporanei e arresto del solo figlio', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-worker-env-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const figlio = new EventEmitter(), segnali = []; let config;
  figlio.kill = s => { segnali.push(s); setImmediate(() => { figlio.emit('exit', 0); figlio.emit('close', 0); }); };
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
    const context = vm.createContext({module:modulo,process:processo,AbortSignal,AbortController,performance,URL,
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
  const context = vm.createContext({ module:modulo, process:processo, AbortSignal, AbortController, performance, URL,
    setTimeout, clearTimeout, setInterval:fn=>{timer=fn;return 1;}, clearInterval:()=>{},
    require:name=>name==='node:crypto'?require(name):name==='./operazioni'?{statoFonti:()=>({}),esegui:job=>{
      ordine.push('avvio-'+job.idLavoro);
      return new Promise(r=>{if(job.idLavoro==='A')terminaA=r;else terminaB=r;});
    }}:{dentro:(_s,fn)=>fn()},
    fetch:async(url,opt)=>{
      if(url.endsWith('/registrazione'))return {ok:true,json:async()=>({epoca:'centro',boot:null})};
      if(url.includes('/poll'))return {ok:true,status:200,json:async()=>({versioneProtocollo:1,idLavoro:++pollCount===1?'A':'B',tentativo:1,input:{}})};
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

test('worker solo stato: registra e invia heartbeat senza caricare scraper o chiedere lavori', async () => {
  const vm = require('node:vm'), processo = new EventEmitter(), chiamate = [], caricati = [];
  processo.env = { AMR_CENTRO_URL:'http://127.0.0.1:1234', AMR_NODO_ID:'osservatore',
    AMR_NODI_TOKEN:'sintetico', AMR_NODO_SOLO_STATO:'1' };
  const modulo = { exports:{} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8'), {
    module:modulo, process:processo, AbortSignal, AbortController, performance, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require:name=>{
      caricati.push(name);
      if(name==='node:crypto')return require(name);
      if(name==='../fonti-salute')return {fermo:f=>({fermo:false, fonte:f})};
      throw new Error('caricamento vietato: '+name);
    },
    fetch:async(url,opt)=>{
      chiamate.push({url, body:opt?.body&&JSON.parse(opt.body)});
      if(url.endsWith('/heartbeat'))processo.emit('SIGTERM');
      return {ok:true,json:async()=>({epoca:'centro',boot:null})};
    }
  });
  await modulo.exports.avvia();
  assert.deepEqual(chiamate.map(c=>new URL(c.url).pathname),[
    '/_nodo/registrazione','/_nodo/registrazione','/_nodo/heartbeat']);
  const hb=chiamate.at(-1).body;
  assert.equal(hb.soloStato,true);assert.equal(hb.simulato,false);assert.equal(hb.occupato,false);
  assert.equal(hb.sondeAutomatiche,undefined);
  assert.deepEqual(Object.keys(hb.fonti),['subito','autoscout','moto']);
  assert.ok(!caricati.includes('./operazioni'));assert.ok(!caricati.includes('../annullo'));
});

test('worker: sonda ha deadline e stop non consegna un esito tardivo', async () => {
  const vm = require('node:vm'), processo = new EventEmitter();
  processo.env = {AMR_CENTRO_URL:'http://127.0.0.1:1234',AMR_NODO_ID:'locale',AMR_NODI_TOKEN:'sintetico'};
  const modulo={exports:{}}, tempi=[]; let signal, termina, scadi, abilitate=0, esiti=0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8'), {
    module:modulo,process:processo,AbortSignal,AbortController,performance,URL,
    setTimeout:(fn,ms)=>{tempi.push(ms);scadi=fn;return 1;},clearTimeout:()=>{},setInterval:()=>2,clearInterval:()=>{},
    require:name=>name==='node:crypto'?require(name):name==='./operazioni'?{
      abilitaSonde:()=>{abilitate++;},statoFonti:()=>({}),esegui:()=>new Promise(r=>{termina=r;})
    }:{dentro:(s,fn)=>{signal=s;return fn();}},
    fetch:async(url,opt)=>{
      if(url.endsWith('/registrazione'))return{ok:true,json:async()=>({epoca:'centro',boot:null})};
      if(url.includes('/poll'))return{ok:true,status:200,json:async()=>({versioneProtocollo:1,
        idLavoro:'sonda',tentativo:1,operazione:'sonda',budgetMs:2500,input:{}})};
      if(url.endsWith('/heartbeat'))assert.equal(JSON.parse(opt.body).sondeAutomatiche,true);
      if(url.endsWith('/esito'))esiti++;
      return{ok:true};
    },
  });
  const p=modulo.exports.avvia();
  for(let i=0;i<30&&!termina;i++)await new Promise(r=>setImmediate(r));
  assert.ok(termina);assert.equal(abilitate,1);assert.deepEqual(tempi,[2500]);
  scadi();assert.equal(signal.aborted,true);processo.emit('SIGTERM');termina({status:200,body:{}});
  await p;assert.equal(esiti,0);
});

test('worker: credenziale rifiutata ferma heartbeat e poll; un 503 resta riprovabile', async () => {
  const vm = require('node:vm');
  const sorgente = fs.readFileSync(path.join(__dirname,'../backend/nodi/worker.js'),'utf8');
  for (const percorso of ['heartbeat','poll']) for (const status of [401,403,503]) {
    const processo = new EventEmitter(), modulo = {exports:{}};
    let errori = 0, eseguiti = 0;
    processo.env = {AMR_CENTRO_URL:'http://127.0.0.1:1234',AMR_NODO_ID:'locale',AMR_NODI_TOKEN:'sintetico'};
    vm.runInNewContext(sorgente, {
      module:modulo,process:processo,AbortSignal,AbortController,performance,URL,Headers,
      setTimeout:fn=>setImmediate(fn),clearTimeout:clearImmediate,setInterval,clearInterval,
      require:name=>name==='node:crypto'?require(name):name==='./operazioni'
        ? {statoFonti:()=>({}),esegui:async()=>{eseguiti++;return{status:200,body:{}};}}
        : {dentro:(_signal,fn)=>fn()},
      fetch:async url=>{
        if(url.endsWith('/registrazione'))return{ok:true,json:async()=>({epoca:'centro',boot:null})};
        if(url.includes('/'+percorso)) {
          errori++;
          // Guardia del test: sul vecchio codice termina dopo tre retry.
          if(errori===3)processo.emit('SIGTERM');
          return{ok:false,status,headers:new Headers()};
        }
        return{ok:true,status:204};
      },
    });
    await assert.rejects(modulo.exports.avvia(), e => e.uscita === (status === 503 ? 75 : 77));
    assert.equal(errori,1,`${percorso} ${status}`);
    assert.equal(eseguiti,0);
  }
});

test('worker con IPC: rifiuto della credenziale e arresto terminano il processo senza SIGKILL', async t => {
  const { fork } = require('node:child_process');
  const http = require('node:http');
  for (const caso of [401,403,'obsoleto','SIGTERM']) await t.test(String(caso), async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'amr-worker-uscita-'));
    let figlio, heartbeat = 0;
    const server = http.createServer((req,res) => {
      req.resume();
      if (req.url.endsWith('/registrazione')) {
        res.setHeader('content-type','application/json');
        res.end(JSON.stringify({epoca:'centro-fixture',boot:null})); return;
      }
      assert.equal(req.url,'/_nodo/heartbeat'); heartbeat++;
      res.statusCode = typeof caso === 'number' ? caso : caso === 'obsoleto' ? 409 : 200;
      if (caso === 'obsoleto') res.setHeader('x-amr-node-obsoleto','1');
      res.end();
      if (caso === 'SIGTERM') figlio.kill('SIGTERM');
    }).listen(0,'127.0.0.1');
    await new Promise(r=>server.once('listening',r));
    let timeout;
    t.after(async () => {
      clearTimeout(timeout);
      if(figlio && figlio.exitCode === null && figlio.signalCode === null) {
        figlio.kill('SIGKILL'); await new Promise(r=>figlio.once('exit',r));
      }
      server.closeAllConnections(); await new Promise(r=>server.close(r));
      fs.rmSync(dir,{recursive:true,force:true});
    });
    figlio = fork(path.join(__dirname,'../backend/nodi/worker.js'),[],{
      execArgv:[],env:{PATH:process.env.PATH,AMR_CENTRO_URL:'http://127.0.0.1:'+server.address().port,
        AMR_NODO_ID:'fixture',AMR_NODI_TOKEN:'credenziale-sintetica',AMR_NODO_SOLO_STATO:'1',
        USER_DATA_PATH:dir,AMR_LOG_DIR:path.join(dir,'log')},
      stdio:['ignore','ignore','ignore','ipc'],
    });
    const esito = await Promise.race([
      new Promise((resolve,reject)=>{figlio.once('error',reject);figlio.once('exit',(code,signal)=>resolve({code,signal}));}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('worker ancora vivo dopo la fine del ciclo')),4000);}),
    ]);
    assert.deepEqual(esito,{code:caso === 'SIGTERM' ? 0 : caso === 'obsoleto' ? 79 : 77,signal:null}); assert.equal(heartbeat,1);
  });
});

test('worker: risultato scaduto viene scartato senza restart né replay', async () => {
  const vm = require('node:vm'), processo = new EventEmitter(), modulo = { exports: {} };
  processo.env = { AMR_CENTRO_URL: 'http://127.0.0.1:1234', AMR_NODO_ID: 'locale', AMR_NODI_TOKEN: 'sintetico' };
  let poll = 0, esiti = 0, eseguiti = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/nodi/worker.js'), 'utf8'), {
    module: modulo, process: processo, AbortSignal, AbortController, performance, URL,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: n => n === 'node:crypto' ? require(n) : n === './operazioni'
      ? { statoFonti: () => ({}), esegui: async () => { eseguiti++; return { status: 200, body: {} }; } }
      : { dentro: (_s, fn) => fn() },
    fetch: async url => {
      if (url.endsWith('/registrazione')) return { ok: true, json: async () => ({ epoca: 'centro', boot: null }) };
      if (url.endsWith('/esito')) { esiti++; return { ok: false, status: 409, headers: new Headers() }; }
      if (url.includes('/poll')) {
        if (++poll > 1) { processo.emit('SIGTERM'); return { ok: true, status: 204 }; }
        return { ok: true, json: async () => ({ versioneProtocollo: 1, idLavoro: 'scaduto', input: {} }) };
      }
      return { ok: true };
    },
  });
  await modulo.exports.avvia(); assert.equal(poll, 2); assert.equal(esiti, 1); assert.equal(eseguiti, 1);
});

test('worker: nuova epoca centrale consente restart, sostituzione nella stessa epoca richiede intervento', async () => {
  const vm = require('node:vm');
  for (const epoca of ['prima','nuova']) {
    const processo = new EventEmitter(), modulo = { exports: {} }; let registrazioni = 0, lavori = 0;
    processo.env = { AMR_CENTRO_URL: 'http://127.0.0.1:1234', AMR_NODO_ID: 'locale', AMR_NODI_TOKEN: 'sintetico' };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../backend/nodi/worker.js'), 'utf8'), {
      module: modulo, process: processo, AbortSignal, AbortController, performance, URL,
      setTimeout, clearTimeout, setInterval, clearInterval,
      require: n => n === 'node:crypto' ? require(n) : n === './operazioni'
        ? { statoFonti: () => ({}), esegui: async () => { lavori++; } } : {},
      fetch: async (url, opts) => {
        if (url.endsWith('/registrazione')) {
          if (opts.method === 'POST') return { ok: true };
          return { ok: true, json: async () => ({ epoca: ++registrazioni === 1 ? 'prima' : epoca, boot: null }) };
        }
        return { ok: false, status: 409, headers: new Headers({ 'x-amr-node-obsoleto': '1' }) };
      },
    });
    await assert.rejects(modulo.exports.avvia(), e => e.uscita === (epoca === 'nuova' ? 75 : 79));
    assert.equal(registrazioni, 2); assert.equal(lavori, 0);
  }
});
