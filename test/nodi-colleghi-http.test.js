'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const http=require('node:http'), express=require('express');
const {mount}=require('../backend/nodi/colleghi-prova-route');
const persona=crypto.randomUUID(), provider=crypto.randomUUID(), invito=crypto.randomUUID(), token='a'.repeat(64);
async function setup(t) {
  const app=express();
  const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',err=>err?reject(err):resolve(s));s.on('error',reject);});
  const origine='http://127.0.0.1:'+server.address().port;
  let tempo=Date.now(), providerResult={session:{user:{id:provider,emailVerified:true}}}, logout=0, invitoValido=true;
  const chiamate=[], operazione=crypto.randomUUID();
  const accessi={sessione:req=>req.headers.cookie ? {persona,epoca:2,mfa:req.headers.cookie==='admin'} : null,
    verifica:async(s,op)=>{if (!s) throw Object.assign(new Error(),{status:401,codice:'sessione_non_valida'});
      if(op?.admin&&!s.mfa) throw Object.assign(new Error(),{status:403,codice:'accesso_non_autorizzato'});
      return{admin:s.mfa,azienda:'prova'};}};
  const registra=(tipo,s,b)=>{chiamate.push({tipo,s,b});return{ok:true,invito};};
  const account={elenco:async(s,b)=>registra('elenco',s,b),statoOperazione:async()=>({confermata:true}),
    invita:async(s,b)=>{chiamate.push({tipo:'invita',s,b});return{ok:true,id:'prova',invito,operazione,
      giaEseguita:b.retry===true,tokenDisponibile:invitoValido,...(chiamate.filter(c=>c.tipo==='invita').length===1?{token}:{})};},
    revoca:async(s,b)=>registra('revoca',s,b),revocaInvito:async(s,b)=>{invitoValido=false;return registra('revocaInvito',s,b);},
    cambiaReferente:async(s,b)=>registra('referente',s,b),
    invito:async tok=>{if(tok!==token||!invitoValido)throw Object.assign(new Error(),{status:403,codice:'invito_non_valido'});return{email:'collega@amr.invalid',stato:'pending'};},
    accetta:async(id,b)=>registra('accetta',id,b)};
  const api=mount(app,{origine,accessi,account,ora:()=>tempo,client:{
    registra:async(...args)=>chiamate.push({tipo:'registra',args}),reinviaVerifica:async(...args)=>chiamate.push({tipo:'verifica',args}),
    login:async(...args)=>{chiamate.push({tipo:'login',args});return providerResult;},logout:async()=>{logout++;}}});
  t.after(async()=>{api.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const req=(verbo,body,cookie='ref',origin=origine)=>fetch(origine+'/api/auth/colleghi/'+verbo,{method:body?'POST':'GET',
    headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{req,chiamate,operazione,origine,scadi:()=>{tempo+=7*86400000+1;},providerResult:r=>{providerResult=r;},logout:()=>logout};
}
test('colleghi HTTP: loopback, Host, Origin e sessione obbligatori',async t=>{
  const f=await setup(t);
  assert.equal((await f.req('invita',{id:'prova'},'ref','https://altro.invalid')).status,403);
  assert.equal((await f.req('invita',{id:'prova'},null)).status,401);
  const status=await new Promise((resolve,reject)=>{http.get(f.origine+'/api/auth/colleghi/pagina',
    {headers:{host:'estraneo.invalid'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
  assert.equal(status,403); assert.equal(f.chiamate.length,0);
  assert.throws(()=>mount(express(),{origine:'http://amr.invalid'}),/origine trasporto/);
});
test('colleghi HTTP: tenant del referente, identità body ignorata, trasferimento solo Admin',async t=>{
  const f=await setup(t), input={id:'prova',operazione:f.operazione,persona:provider,mfa:true,epoca:999,admin:true};
  assert.equal((await f.req('revoca',{...input,id:'altra'})).status,403);
  assert.equal((await f.req('referente',input)).status,403);
  assert.equal((await f.req('revoca',input)).status,200);
  assert.deepEqual(f.chiamate[0].s,{persona,epoca:2,mfa:false});
  assert.deepEqual(f.chiamate[0].b,{id:'prova',operazione:f.operazione,persona:provider});
  assert.equal((await f.req('referente',input,'admin')).status,200);
});
test('colleghi HTTP: consegna soltanto RAM, retry, revoca e scadenza rimuovono il link',async t=>{
  const f=await setup(t), input={id:'prova',operazione:f.operazione,email:'collega@amr.invalid'};
  const primo=await(await f.req('invita',input)).json();
  assert.equal(primo.link,f.origine+'/api/auth/colleghi/pagina#'+token);assert.equal('token' in primo,false);
  assert.equal(primo.consegna,'locale_non_inviata');
  assert.equal((await(await f.req('invita',input)).json()).link,primo.link);
  await f.req('revoca-invito',{id:'prova',operazione:crypto.randomUUID(),invito});
  assert.equal('link' in await(await f.req('invita',input)).json(),false);
  const g=await setup(t); await g.req('invita',input);g.scadi();
  assert.equal('link' in await(await g.req('invita',input)).json(),false);
});
test('colleghi HTTP: riuso signup, login verificato provider e UUID accettazione',async t=>{
  const f=await setup(t), body={token,password:'password-sintetica',operazione:crypto.randomUUID(),persona,mfa:true,email:'intruso@amr.invalid'};
  assert.equal((await f.req('registra',body,null)).status,200);
  assert.deepEqual(f.chiamate.at(-1).args,['collega@amr.invalid','password-sintetica',f.origine+'/api/auth/colleghi/pagina']);
  assert.equal((await f.req('accetta',body,null)).status,200);
  assert.deepEqual(f.chiamate.at(-1),{tipo:'accetta',s:provider,b:{token,operazione:body.operazione}});
  assert.equal(f.logout(),1);
  f.providerResult({session:{user:{id:provider,emailVerified:false}}});
  assert.equal((await f.req('accetta',body,null)).status,403);assert.equal(f.logout(),2);
  f.providerResult({mfa:{ticket:'sintetico'}});
  assert.equal((await f.req('accetta',body,null)).status,409);
});
test('colleghi HTTP: limiti body, credenziali e rate; GET non consuma inviti',async t=>{
  const f=await setup(t);
  const pagina=await f.req('pagina',null,null);assert.equal(pagina.status,200);
  assert.equal(pagina.headers.get('cache-control'),'no-store');assert.match(pagina.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal((await f.req('registra',{token,password:'x'.repeat(51)},null)).status,400);
  assert.equal((await f.req('accetta',{token,password:'password-sintetica'},null)).status,400);
  assert.equal((await f.req('invita',{id:'prova',email:'a'.repeat(5000)})).status,413);
  assert.equal(f.chiamate.length,0);
  for(let i=0;i<30;i++) await f.req('elenco',{id:'prova'});
  assert.equal((await f.req('elenco',{id:'prova'})).status,429);
});
