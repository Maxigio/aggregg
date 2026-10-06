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

test('collaudo Nhost: accettazione usa un ID stabile e distingue input errato da email non verificata',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
  const start=source.indexOf('const signupInv='),end=source.indexOf('const {risposta:loginReferente',start);
  assert.ok(start>0&&end>start);
  const body=source.slice(start,end);
  async function prova(testo,guasto) {
    let verificata=false,operazione=null,accettazioni=0;
    const richieste=[];
    const risposta=(status,codice,extra={})=>({status,json:async()=>({codice,...extra})});
    const c={assert,crypto:require('node:crypto'),AbortSignal,setTimeout,encodeURIComponent,
      invToken:'a'.repeat(64),pwInvito:'password-sintetica',destinatario:'ref@amr.invalid',
      mailAddress:'127.0.0.1:1',base:'http://127.0.0.1:2',origineLogin:'http://127.0.0.1:3',
      corpoMailLocale:()=>'?ticket=fixture&codeChallenge='+'c'.repeat(43),
      aziendeReq:async(fase,_cookie,input)=>{
        if(fase!=='accetta')return risposta(200);
        richieste.push(input.operazione);
        if(!/^[a-f0-9-]{36}$/.test(input.operazione||''))return risposta(400,'input_non_valido');
        if(!verificata)return guasto==='email'?risposta(503,'identita_non_disponibile'):risposta(403,'identita_non_verificata');
        if(operazione&&operazione!==input.operazione)return guasto==='operazione'?risposta(503,'operazione_non_disponibile'):risposta(403,'invito_non_valido');
        const giaEseguita=Boolean(operazione);
        if(!giaEseguita){operazione=input.operazione;accettazioni++;}
        return risposta(200,undefined,{giaEseguita});
      },
      fetch:async url=>{
        if(url.includes('/api/v2/messages'))return {json:async()=>({items:[{Raw:{To:['ref@amr.invalid']}}]})};
        verificata=true;return {status:200,headers:{get:()=>null}};
      }};
    await vm.runInNewContext('(async()=>{'+testo+'})()',c);
    assert.equal(accettazioni,1);
    assert.equal(richieste.length,4);
    assert.equal(richieste[0],richieste[1]);assert.equal(richieste[1],richieste[2]);
    assert.notEqual(richieste[2],richieste[3]);
  }
  await prova(body);
  await assert.rejects(prova(body.replace('operazione:crypto.randomUUID()', 'operazione:undefined')), {code:'ERR_ASSERTION'});
  for(const guasto of ['email','operazione'])await assert.rejects(prova(body,guasto),{code:'ERR_ASSERTION'});
});

test('collaudo Nhost: quota aziende osserva i PID reali e rilascia i client anche dopo errore',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
  const start=source.indexOf('const held=await writerPool.connect();'),end=source.indexOf("assert.equal(await sql('SELECT count(*) FROM amr_accessi.aziende;'),'10');",start);
  assert.ok(start>0&&end>start);
  const body=source.slice(start,end);
  const adapter=require('../backend/nodi/aziende-postgres-prova');
  async function prova(testo=body,guasto) {
    const eventi=[];let connessi=0,attiva=false,pendente,tempo=0,poll=0;
    const libera=()=>{if(pendente){const reject=pendente;pendente=null;reject(Object.assign(new Error('quota_aziende'),{code:'P0001'}));}};
    const clients=[0,1,2].map(indice=>({
      async query(sql,params){
        if(sql==='BEGIN'){assert.equal(connessi,3);attiva=true;eventi.push('begin');}
        if(sql==='COMMIT'){eventi.push('commit');attiva=false;libera();}
        if(sql==='ROLLBACK'){
          eventi.push('rollback');
          if(guasto==='rollback')throw new Error('rollback_fixture');
          attiva=false;libera();
        }
        if(sql.includes('pg_backend_pid'))return {rows:[{pid:indice===0?101:202}]};
        if(sql.includes('pg_blocking_pids')){
          assert.equal(indice,2);assert.deepEqual(Array.from(params),[101,202]);
          poll++;return {rows:[{osservato:guasto!=='senza_lock'&&attiva&&Boolean(pendente)&&poll>1}]};
        }
        if(sql.includes('aziende_invita')){
          if(indice===0)return {rows:[{risultato:{giaCreata:false}}]};
          assert.equal(indice,1);assert.equal(attiva,true);
          return new Promise((_resolve,reject)=>{pendente=reject;}).finally(()=>eventi.push('contendente_finito'));
        }
        return {rows:[]};
      },
      release(error){eventi.push('release_'+indice);if(indice===0&&error){eventi.push('scarta_holder');libera();}},
    }));
    const c={assert,crypto:require('node:crypto'),
      adminFixture:{persona:require('node:crypto').randomUUID(),epoca:0,mfa:true},
      performance:{now:()=>{tempo+=25;return tempo;}},setTimeout:callback=>queueMicrotask(callback),
      writerPool:{connect:async()=>{connessi++;if(guasto==='connessione_'+connessi)throw new Error('connessione_fixture');return clients[connessi-1];}},
      require:()=>adapter,
      sql:()=>{throw new Error('monitor Docker non ammesso nella barriera');}};
    try{return await vm.runInNewContext('(async()=>{'+testo+'})()',c);}
    finally{
      assert.ok(!pendente,'contendente ancora pendente');
      assert.ok(eventi.includes('release_0'));
      for(let n=1;n<Math.min(connessi,3);n++)if(guasto!=='connessione_'+(n+1))assert.ok(eventi.includes('release_'+n));
      if(eventi.includes('contendente_finito')){
        assert.ok(eventi.indexOf('contendente_finito')<eventi.indexOf('release_1'));
        assert.ok(eventi.indexOf('contendente_finito')<eventi.indexOf('release_2'));
      }
      if(guasto==='rollback')assert.ok(eventi.includes('scarta_holder'));
      if(guasto?.startsWith('connessione_'))assert.ok(!eventi.includes('begin'));
    }
  }
  await prova();
  await assert.rejects(prova(body,'senza_lock'),{code:'ERR_ASSERTION'});
  await assert.rejects(prova(body.replace('[pid,altro]','[altro,pid]')),{code:'ERR_ASSERTION'});
  await assert.rejects(prova(body,'rollback'),/rollback_fixture/);
  for(const guasto of ['connessione_2','connessione_3'])await assert.rejects(prova(body,guasto),/connessione_fixture/);
});

test('collaudo Nhost: ultima quota usa lock reale e ripulisce il pool sintetico',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
  const start=source.indexOf('const quotePool ='),end=source.indexOf("assert.equal(await sql('SELECT count(*) FROM amr_prova.inviti;')",start);
  assert.ok(start>0&&end>start);const body=source.slice(start,end);
  async function prova(testo=body,guasto) {
    const eventi=[];let acquisiti=0,pendente,attiva=false,tempo=0;
    const libera=()=>{if(pendente){const reject=pendente;pendente=null;
      reject(Object.assign(new Error(guasto==='seconda_errore'?'errore_fixture':'quota raggiunta'),
        {code:guasto==='seconda_errore'?'XX000':'P0001'}));}};
    const clients=[0,1,2].map(indice=>({
      async query(testo,params){
        if(testo==='BEGIN'){assert.equal(acquisiti,3);attiva=true;eventi.push('begin');}
        if(testo.includes('FOR UPDATE'))assert.equal(attiva,true);
        if(testo==='COMMIT'){eventi.push('commit');attiva=false;libera();}
        if(testo==='ROLLBACK'){
          eventi.push('rollback');if(guasto==='rollback')throw Error('rollback_fixture');
          attiva=false;libera();
        }
        if(testo.includes('pg_backend_pid'))return {rows:[{pid:indice===0?301:302}]};
        if(testo.includes('pg_blocking_pids')){
          assert.equal(indice,2);assert.deepEqual(Array.from(params),[301,302]);
          return {rows:[{osservato:guasto!=='senza_lock'&&attiva&&Boolean(pendente)}]};
        }
        if(testo.includes("prenota('primo')")){assert.equal(indice,0);eventi.push('prima');}
        if(testo.includes("prenota('secondo')")){
          assert.equal(indice,1);assert.equal(attiva,true);
          return new Promise((_resolve,reject)=>{pendente=reject;}).finally(()=>eventi.push('seconda_finita'));
        }
        return {rows:[]};
      },
      release(error){eventi.push('release_'+indice);if(indice===0&&error){eventi.push('scarta_holder');libera();}},
    }));
    class Pool {
      constructor(config){
        assert.equal(config.host,'127.0.0.1');assert.equal(config.port,1234);
        assert.equal(config.user,'postgres');assert.equal(config.password,'solo_sintetica');
        assert.equal(config.max,3);assert.equal(config.lock_timeout,1500);
      }
      on(){}
      async connect(){acquisiti++;if(guasto==='connessione_'+acquisiti)throw Error('connessione_fixture');return clients[acquisiti-1];}
      async end(){eventi.push('end');}
    }
    const c={assert,pgAddress:'127.0.0.1:1234',postgresPassword:'solo_sintetica',
      require:nome=>{assert.equal(nome,'pg');return{Pool};},
      performance:{now:()=>{tempo+=25;return tempo;}},setTimeout:callback=>queueMicrotask(callback)};
    try{await vm.runInNewContext('(async()=>{'+testo+'})()',c);}
    finally{
      assert.equal(Boolean(pendente),false);assert.equal(eventi.at(-1),'end');
      for(let n=0;n<Math.min(acquisiti,3);n++)if(guasto!=='connessione_'+(n+1))assert.ok(eventi.includes('release_'+n));
      if(eventi.includes('seconda_finita')){
        assert.ok(eventi.indexOf('seconda_finita')<eventi.indexOf('release_1'));
        assert.ok(eventi.indexOf('seconda_finita')<eventi.indexOf('release_2'));
      }
      if(guasto==='rollback')assert.ok(eventi.includes('scarta_holder'));
      if(guasto?.startsWith('connessione_'))assert.ok(!eventi.includes('begin'));
    }
  }
  await prova();
  for(const guasto of ['senza_lock','seconda_errore'])await assert.rejects(prova(body,guasto),{code:'ERR_ASSERTION'});
  await assert.rejects(prova(body.replace('[pid,altro]','[altro,pid]')),{code:'ERR_ASSERTION'});
  await assert.rejects(prova(body,'rollback'),/rollback_fixture/);
  for(const guasto of ['connessione_1','connessione_2','connessione_3'])await assert.rejects(prova(body,guasto),/connessione_fixture/);
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
        child.stdin = { on() {}, end(testo) { queueMicrotask(() => {
          if (testo.includes("current_setting('server_version')")) {
            child.stdout.emit('data', Buffer.from('{"versione":"16.15","directory":"/var/lib/postgresql/data"}\n'));
          }
          child.emit('close', 0);
        }); } };
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
      manifestAtteso:{},
      require:()=>({collaudaImmagine:async()=>{throw e;}})};
    await assert.rejects(vm.runInNewContext('(async()=>{'+source.slice(inizio,fine)+'})()',c),err=>err===e);
    assert.equal(c.conservaTemporanei,conserva);
    assert.equal(c.diagnosi,conserva?'fixture e immagine locale · collauda-centro-immagine-locale.js:99:7 · 42703 · ricevuto 403, atteso 200'
      :'ricevuto 403, atteso 200');
    assert.ok(!c.diagnosi.includes('segreto'));
  }
});

test('collaudo immagine: il manifest deve coincidere con il candidato atteso',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-centro-immagine-locale.js'),'utf8');
  const start=source.indexOf('const wire ='),end=source.indexOf("await attendi(async()=>{const r=await request('/api/test/config')",start);
  assert.ok(start>0&&end>start);
  const expected={protocollo:1,release:'a'.repeat(40),codice:'b'.repeat(64),cataloghi:'c'.repeat(64)};
  const run=manifest=>vm.runInNewContext(source.slice(start,end),{
    manifest,atteso:expected,assert,require});
  assert.doesNotThrow(()=>run({...expected}));
  for(const campo of ['release','codice','cataloghi'])assert.throws(()=>run({...expected,
    [campo]:'d'.repeat(campo==='release'?40:64)}));
});

test('collaudo Nhost: cleanup fallito rifiuta il gate e conserva i temporanei',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
  const start=source.indexOf('for (const chiudi of [');
  const fineFinally=source.indexOf('\n  }\n  if (!manuale) console.log',start);
  const end=fineFinally>=0?fineFinally:source.indexOf('\n}\n\nif (require.main',start);
  assert.ok(start>0&&end>start);
  for(const guasto of ['nessuno','down','risorsa']){
    const calls=[],processo=new EventEmitter(),controller=new AbortController();
    const c={workerManuale:undefined,centro:undefined,loginProva:guasto==='risorsa'?{close(){throw Error('dato privato');}}:undefined,
      aziendeRoute:undefined,colleghiRoute:undefined,backupNotifiche:undefined,backupWorker:undefined,
      backupPool:undefined,writerPool:undefined,pool:undefined,serverLogin:undefined,
      docker:async()=>{calls.push('down');if(guasto==='down')throw Error('dato privato');},
      fs:{rmSync(){calls.push('rm');}},directory:'/synthetic',conservaTemporanei:false,
      puliziaIncompleta:false,manuale:false,process:processo,interrompi:()=>controller.abort(),
      console:{log(){},error(){}},Error};
    // Rimuove soltanto la graffa che chiude il finally; esegue il vero cleanup.
    const body=source.slice(start,end).replace(/\n  }\s*$/,'');
    const pending=vm.runInNewContext('(async()=>{'+body+'})()',c);
    if(guasto==='nessuno'){await pending;assert.deepEqual(calls,['down','rm']);}
    else{await assert.rejects(pending,e=>/pulizia incompleta/i.test(e.message)&&!e.message.includes('dato privato'));
      assert.deepEqual(calls,['down']);}
  }
});
