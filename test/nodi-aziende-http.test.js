'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const express=require('express');
const {mount}=require('../backend/nodi/aziende-prova-route');
const crypto=require('node:crypto'), referente=crypto.randomUUID();
async function setup(t, {invita,invito,accetta,login}={}){const app=express();const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const origine='http://127.0.0.1:'+server.address().port;
const chiamate=[];const errore=()=>Object.assign(new Error('sessione_non_valida'),{status:401,codice:'sessione_non_valida'});
const accessi={sessione:req=>req.headers.cookie==='admin=1'?{persona:'owner',epoca:2,mfa:true}:null,verifica:async s=>{if(!s)throw errore();}};
const token='a'.repeat(64);let logout=0;
const api=mount(app,{origine,accessi,account:{invita:invita || (async(s,b)=>{chiamate.push(['invita',s,b]);return b.operazione==='retry'?{ok:true,id:'azienda',operazione:'op',giaCreata:true,tokenDisponibile:true}:{ok:true,id:'azienda',operazione:b.operazione,tokenDisponibile:true,token};}),elenco:async()=>({aziende:[]}),attiva:async()=>({ok:true}),invito:invito || (async tok=>{if(tok!==token)throw Object.assign(new Error('invito_non_valido'),{status:403,codice:'invito_non_valido'});return{email:'ref@amr.invalid'};}),accetta:accetta || (async(id,tok,op)=>{chiamate.push(['accetta',id,tok,op]);return{ok:true};})},client:{registra:async(...args)=>chiamate.push(['registra',...args]),login:login || (async()=>({session:{user:{id:referente,emailVerified:true},accessToken:'segreto-provider'}})),logout:async()=>{logout++;}}});
t.after(async()=>{api.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
const req=(v,body,cookie,origin=origine)=>fetch(origine+'/api/auth/aziende/'+v,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin}:{})},...(body?{body:JSON.stringify(body)}:{})});return{req,chiamate,token,origine,logout:()=>logout};}
test('aziende: Origin errato e Admin assente non creano inviti',async t=>{const f=await setup(t);assert.equal((await f.req('invita',{},'admin=1','https://altro.invalid')).status,403);assert.equal((await f.req('invita',{})).status,401);assert.equal(f.chiamate.length,0);});
test('aziende: token solo nel link locale, registrazione usa email dell’invito e redirect fisso',async t=>{const f=await setup(t);const r=await f.req('invita',{operazione:'op'},'admin=1');const d=await r.json();assert.ok(!('token' in d));assert.equal(d.consegna,'locale_non_inviata');assert.equal(d.link,f.origine+'/api/auth/aziende/pagina#'+f.token);assert.equal((await f.req('registra',{token:f.token,email:'attaccante@amr.invalid',password:'password-sintetica'})).status,200);assert.deepEqual(f.chiamate.at(-1),['registra','ref@amr.invalid','password-sintetica',f.origine+'/api/auth/aziende/pagina']);});
test('aziende: accettazione usa UUID provider, non ruolo/identità del browser, nessun token restituito',async t=>{const f=await setup(t);const op=crypto.randomUUID();const r=await f.req('accetta',{token:f.token,password:'password-sintetica',persona:'owner',admin:true,operazione:op});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true});assert.deepEqual(f.chiamate.at(-1),['accetta',referente,f.token,op]);for(let n=0;n<10&&!f.logout();n++)await new Promise(r=>setTimeout(r,5));assert.equal(f.logout(),1);});
test('aziende: invito invalido e password troppo lunga non chiamano il provider',async t=>{const f=await setup(t);assert.equal((await f.req('registra',{token:'invalido',password:'password-sintetica'})).status,403);assert.equal((await f.req('registra',{token:f.token,password:'x'.repeat(51)})).status,400);assert.equal(f.chiamate.length,0);});
test('aziende: recupero autorizzato usa la consegna dell’operazione originale',async t=>{const f=await setup(t);const primo=await(await f.req('invita',{operazione:'op'},'admin=1')).json();const retry=await(await f.req('invita',{operazione:'retry'},'admin=1')).json();assert.equal(retry.link,primo.link);assert.equal(retry.operazione,'op');assert.equal(retry.giaCreata,true);assert.equal(Object.hasOwn(retry,'token'),false);});
test('aziende: signup Nhost usa PKCE senza ruoli o metadata client',async()=>{let payload;const client=require('../backend/nodi/nhost-auth-client').creaClient({base:'http://127.0.0.1:1234/v1',richiesta:async(url,opts)=>{assert.equal(url,'http://127.0.0.1:1234/v1/signup/email-password');payload=JSON.parse(opts.body);return{ok:true,json:async()=>({session:null})};}});await client.registra('prova@amr.invalid','password-sintetica','http://127.0.0.1:5555/api/auth/aziende/pagina');assert.match(payload.codeChallenge,/^[A-Za-z0-9_-]{43}$/);assert.deepEqual(payload.options,{redirectTo:'http://127.0.0.1:5555/api/auth/aziende/pagina'});assert.ok(!('allowedRoles' in payload));});
test('aziende: anonimi e letture non esauriscono il budget delle mutazioni',async t=>{
 const f=await setup(t);
 for(let i=0;i<30;i++) {
  assert.equal((await f.req('elenco')).status,401);
  assert.equal((await f.req('elenco',null,'admin=1')).status,200);
 }
 assert.equal((await f.req('elenco',null,'admin=1')).status,429);
 assert.equal((await f.req('attiva',{},'admin=1')).status,200);
});

test('aziende: consegna RAM non ripubblica invito accettato o scaduto',async t=>{
 let prima=true,pending=true;
 const f=await setup(t,{invita:async()=>{const out={ok:true,id:'azienda',operazione:'op',tokenDisponibile:pending,
  ...(prima?{token:'a'.repeat(64)}:{})};prima=false;return out;}});
 assert.ok((await(await f.req('invita',{},'admin=1')).json()).link);
 assert.ok((await(await f.req('invita',{},'admin=1')).json()).link);
 pending=false;
 assert.equal('link' in await(await f.req('invita',{},'admin=1')).json(),false);
 pending=true; // Una copia ritirata non ricompare se il DB viene cambiato dopo.
 assert.equal('link' in await(await f.req('invita',{},'admin=1')).json(),false);
});

test('aziende: accettazione con esito perso ripete stesso ID dopo Auth, senza riaprire invito',async t=>{
 let usato=false,idConfermato,login=0,sql=0;
 const errore=codice=>Object.assign(new Error(codice),{codice,status:codice==='operazione_non_disponibile'?503:403});
 const f=await setup(t,{invito:async()=>({email:'ref@amr.invalid',stato:usato?'accettato':'pending'}),
   login:async()=>{login++;return{session:{user:{id:referente,emailVerified:true}}};},
   accetta:async(id,token,op)=>{
     assert.equal(id,referente);assert.equal(token,'a'.repeat(64));sql++;
     if(usato){if(op!==idConfermato)throw errore('invito_non_valido');return{ok:true,giaEseguita:true};}
     usato=true;idConfermato=op;throw errore('operazione_non_disponibile');
   }});
 const body={token:f.token,password:'password-sintetica',operazione:crypto.randomUUID()};
 assert.equal((await f.req('accetta',{...body,operazione:undefined})).status,400);
 assert.equal(login,0);assert.equal(sql,0);
 assert.equal((await f.req('accetta',body)).status,503);
 assert.equal((await f.req('accetta',body)).status,200);
 assert.equal((await f.req('accetta',{...body,operazione:crypto.randomUUID()})).status,403);
 assert.equal(login,3);assert.equal(sql,3);assert.equal(f.logout(),3);
 assert.equal((await f.req('registra',body)).status,403);
 assert.equal((await f.req('verifica',{token:f.token})).status,403);
});
