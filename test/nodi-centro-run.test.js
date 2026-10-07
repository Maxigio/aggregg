'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {configura}=require('../backend/nodi/config-centro-run');
const ambiente=()=>({AMR_CENTRO_ORIGINE:'https://amr.invalid',AMR_NHOST_AUTH_URL:'https://auth.amr.invalid/v1',
  AMR_NODI_TOKENS:JSON.stringify({locale:'a'.repeat(64)}),AMR_NODI_RELEASE_FILE:'/tmp/release.json',
  AMR_NODI_DATA_DIR:'/tmp/centro',AMR_CENTRO_REPLICHE:'1',AMR_CENTRO_PROXY_IP:'127.0.0.1',
  AMR_PG_HOST:'postgres',AMR_PG_DATABASE:'amr',AMR_PG_RETE_PRIVATA:'1',
  ...Object.fromEntries(['LETTURA','COMMERCIALE','BACKUP'].flatMap(r=>[
    ['AMR_PG_'+r+'_USER',r.toLowerCase()],['AMR_PG_'+r+'_PASSWORD','sintetico-non-usato']])),
});
const manifest={protocollo:1,release:'b'.repeat(40),codice:'c'.repeat(64),cataloghi:'d'.repeat(64)};
test('config centro: HTTPS, singolo processo, tre ruoli e limiti espliciti',()=>{
  const c=configura(ambiente());assert.equal(c.timeoutRicercaMs,60000);assert.equal(c.maxPersona,2);assert.equal(c.maxTotale,60);
  assert.equal(c.proprietarioId,null);
  assert.equal(configura({...ambiente(),AMR_CENTRO_PROPRIETARIO_ID:'00000000-0000-4000-8000-000000000001'}).proprietarioId,
    '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(Object.values(c.pools).map(p=>p.max),[4,4,2]);assert.equal(c.pools.backup.ssl,false);
  assert.deepEqual(configura({...ambiente(),AMR_PG_HOST:'db.amr.invalid',AMR_PG_RETE_PRIVATA:'0'}).pools.backup.ssl,{rejectUnauthorized:true});
  for(const patch of [{AMR_CENTRO_REPLICHE:'2'},{AMR_CENTRO_PROXY_IP:'0.0.0.0/0'},
    {AMR_CENTRO_ORIGINE:'http://amr.invalid'},{AMR_NHOST_AUTH_URL:'https://auth.invalid/v1?token=secret'},
    {AMR_PG_COMMERCIALE_USER:'lettura'},{AMR_PG_HOST:'cloud.invalid'},{AMR_NODI_RELEASE_FILE:'../release'},
    {AMR_NODI_TOKENS:'{}'},{AMR_NODI_TOKENS:JSON.stringify({a:'a'.repeat(64),b:'a'.repeat(64)})},
    {AMR_NODI_RICERCHE_MAX_PERSONA:'0'}, {AMR_CENTRO_PROPRIETARIO_ID:''},
    {AMR_CENTRO_PROPRIETARIO_ID:'admin'}, {AMR_CENTRO_PROPRIETARIO_ID:'mail@amr.invalid'}]) {
    assert.throws(()=>configura({...ambiente(),...patch}),/configurazione_centro_run_non_valida/);
  }
});
async function centro(t,{directory,tokens={locale:'a'.repeat(64)}}={}) {
  const dir=directory||fs.mkdtempSync(path.join(os.tmpdir(),'amr-centro-https-'));
  const servizio=require('../backend/nodi/centro').creaCentro({tokens,directory:dir,compatibilita:manifest,
    trasporto:{origine:'https://amr.invalid',proxyAttendibili:['127.0.0.1']},
    inizializzaAccessi:()=>({close(){},sessione:req=>req.get('cookie')==='admin=prova'?{persona:'admin',azienda:null}:null,
      verifica:async(s,{admin}={})=>{if(!s||!admin)throw Object.assign(new Error('negato'),{status:403});return{admin:true};}})});
  const server=http.createServer(servizio.app);await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
  let chiuso=false;const close=async()=>{if(chiuso)return;chiuso=true;servizio.close();server.closeAllConnections();await new Promise(r=>server.close(r));};
  t.after(async()=>{await close();if(!directory)fs.rmSync(dir,{recursive:true,force:true});});
  const call=(url,body,headers={},method=body===undefined?'GET':'POST')=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,
      headers:{host:'amr.invalid','x-forwarded-proto':'https',...(body===undefined?{}:{'content-type':'application/json'}),...headers}},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',v=>{raw+=v;});
      res.on('end',()=>resolve({status:res.statusCode,raw,headers:res.headers,json:async()=>JSON.parse(raw)}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
  return {servizio,call,close,dir};
}
const nodo={'x-amr-node-id':'locale','x-amr-node-token':'a'.repeat(64)};
const admin={origin:'https://amr.invalid',cookie:'admin=prova','x-amr-local-admin':'1'};
test('sonda: solo GET/HEAD esatti, nessun requisito Host/TLS e nessun bypass API',async t=>{
  const f=await centro(t);
  const interno={host:'interno.invalid','x-forwarded-proto':'http',origin:'https://evil.invalid'};
  const r=await f.call('/healthz',undefined,interno);
  assert.equal(r.status,200);assert.equal(r.raw,'ok');assert.equal(r.headers['cache-control'],'no-store');
  assert.equal((await f.call('/healthz',undefined,interno,'HEAD')).raw,'');
  for(const url of ['/healthz/','/healthz?x=1','//healthz','/%68ealthz','/api/admin','/_nodo/registrazione']) {
    assert.equal((await f.call(url,undefined,interno)).status,403);
  }
  assert.equal((await f.call('/healthz',{},interno)).status,403);
  f.servizio.close();assert.equal((await f.call('/healthz',undefined,interno)).status,503);
});
test('centro HTTPS: eccezione Origin solo nodo autenticato, Admin mai pubblico',async t=>{
  const f=await centro(t);
  assert.equal((await f.call('/api/admin')).status,403);
  assert.equal((await f.call('/api/admin',undefined,admin)).status,200);
  assert.equal((await f.call('/api/test/login',{azienda:'aziendaA'},nodo)).status,403);
  assert.equal((await f.call('/_nodo/registrazione',{}, {...nodo,'x-forwarded-proto':'http'})).status,403);
  assert.equal((await f.call('/_nodo/registrazione',{}, {...nodo,origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.call('/_nodo/registrazione',{}, {...nodo,'x-amr-node-token':'x'.repeat(64)})).status,403);
  const c=await(await f.call('/_nodo/registrazione',undefined,nodo)).json();
  const boot=require('node:crypto').randomUUID();
  const heartbeat={id:'locale',fonti:{subito:{fermo:false}},compatibilita:manifest,sequenza:1};
  assert.equal((await f.call('/_nodo/heartbeat',heartbeat,nodo)).status,409);
  assert.equal((await f.call('/_nodo/poll?id=locale',undefined,nodo)).status,409);
  assert.equal((await f.call('/_nodo/registrazione',{epoca:c.epoca,boot,precedente:null,compatibilita:manifest},nodo)).status,200);
  assert.equal((await f.call('/_nodo/heartbeat',heartbeat,nodo)).status,409);
  const registrato={...nodo,'x-amr-node-boot':boot,'x-amr-center-epoch':c.epoca};
  assert.equal((await f.call('/_nodo/heartbeat',heartbeat,registrato)).status,200);
  assert.equal((await f.call('/_nodo/poll?id=locale',undefined,registrato)).status,204);
  assert.equal((await f.call('/_nodo/poll?id=locale',undefined,{...registrato,'x-amr-center-epoch':'obsoleta'})).status,409);
  assert.equal((await f.call('/api/admin/nodi/locale',{sospeso:true}, {...admin,origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.call('/api/admin/nodi/locale',{sospeso:true},admin)).status,200);
  assert.equal((await f.call('/api/admin/nodi/locale/revoca-token',{}, {...admin,cookie:''})).status,403);
});
test('centro HTTPS: il vecchio GET non crea lavori; avvio POST e DELETE richiedono Origin',async t=>{
  const f=await centro(t), id=require('node:crypto').randomUUID();
  let r=await f.call('/api/search?tipo=moto&marca=Yamaha',undefined,admin);
  assert.equal(r.status,405);assert.equal(r.headers.allow,'POST');
  assert.equal(f.servizio.lavori.size,0);
  const input={id,input:{tipo:'moto',marca:'Yamaha'}};
  assert.equal((await f.call('/api/ricerche',input,{cookie:'admin=prova'})).status,403);
  assert.equal((await f.call('/api/ricerche/'+id,undefined,{cookie:'admin=prova'},'DELETE')).status,403);
  // L'Admin gestionale non può usare un modulo senza un'azienda valida.
  r=await f.call('/api/ricerche',input,admin);assert.equal(r.status,403);
  assert.equal(f.servizio.lavori.size,0);
});
test('centro HTTPS: riconciliazione incidenti richiede Admin, Origin e header esplicito',async t=>{
  const f=await centro(t);
  assert.equal((await f.call('/api/admin/manutenzione',{manutenzione:true},admin)).status,200);
  const stato=await(await f.call('/api/admin',undefined,admin)).json(),id=stato.incidenti.episodi[0].id;
  f.servizio.db.prepare("UPDATE incidenti SET avviso='incerto' WHERE id=?").run(id);
  for(const headers of [{...admin,cookie:''},{...admin,origin:'https://evil.invalid'},
    {...admin,'x-amr-local-admin':'0'},nodo]) {
    assert.equal((await f.call('/api/admin/incidenti/'+id,{azione:'presente'},headers)).status,403);
    assert.equal(f.servizio.db.prepare('SELECT avviso FROM incidenti WHERE id=?').get(id).avviso,'incerto');
  }
  assert.equal((await f.call('/api/admin/incidenti/'+id,{azione:'presente'},admin)).status,200);
  assert.equal((await f.call('/api/admin/incidenti/'+id,{azione:'presente'},admin)).status,409);
  assert.equal((await(await f.call('/api/admin',undefined,admin)).json()).incidenti.guasto,null);
});
test('credenziale nodo: revoca persistente e nuova chiave distinta',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-revoca-token-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const f=await centro(t,{directory:dir});
  assert.equal((await f.call('/api/admin/nodi/locale/revoca-token',{},admin)).status,200);
  assert.equal((await f.call('/_nodo/registrazione',undefined,nodo)).status,401);await f.close();
  const stesso=await centro(t,{directory:dir});assert.equal((await stesso.call('/_nodo/registrazione',undefined,nodo)).status,401);await stesso.close();
  const nuovo=await centro(t,{directory:dir,tokens:{locale:'e'.repeat(64)}});
  assert.equal((await nuovo.call('/_nodo/registrazione',undefined,{...nodo,'x-amr-node-token':'e'.repeat(64)})).status,200);
  assert.equal((await nuovo.call('/_nodo/registrazione',undefined,nodo)).status,401);
});
test('entrypoint: fallimento risorse e chiusura idempotente dei pool',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-run-pools-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'release.json'),JSON.stringify(manifest));
  const config={...configura(ambiente()),directory:dir,releaseFile:path.join(dir,'release.json')};
  const {EventEmitter}=require('node:events');let chiusi=0;
  class Pool extends EventEmitter {query=async()=>({rows:[{risultato:null}]});
    async connect(){const c=new EventEmitter();c.query=async()=>({rows:[]});c.release=()=>{};return c;}
    async end(){chiusi++;}}
  const verificaRelease=v=>{assert.deepEqual(v,manifest);return v;};
  const run=await require('../backend/nodi/centro-run').creaServizio(config,{Pool,verificaRelease});
  await Promise.all([run.close(),run.close()]);assert.equal(chiusi,3);
  let creati=0;
  class PoolGuasto extends Pool {constructor(){super();if(++creati===3)throw new Error('segreto sintetico non stampare');}}
  await assert.rejects(require('../backend/nodi/centro-run').creaServizio(config,{Pool:PoolGuasto,verificaRelease}),{message:'centro_run_non_avviato'});
  assert.equal(chiusi,5);
  creati=0;
  await assert.rejects(require('../backend/nodi/centro-run').creaServizio(config,{Pool:PoolGuasto,
    verificaRelease:()=>{throw new Error('codice_release_incompatibile');}}),{message:'codice_release_incompatibile'});
  assert.equal(creati,0);
});
