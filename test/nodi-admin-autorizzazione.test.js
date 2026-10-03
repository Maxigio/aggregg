'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const { test } = require('node:test');
const {creaCentro} = require('../backend/nodi/centro');
const {mount} = require(root + '/backend/nodi/login-nhost-prova');
const pause = ms => new Promise(r => setTimeout(r, ms));
const persona = '00000000-0000-4000-8000-000000000001';
const provider = {session:{user:{id:persona,emailVerified:true},accessToken:'sintetico-access',refreshToken:'sintetico-refresh'}};
function jar(r, old='') {
  const out = new Map(old.split(';').map(v=>v.trim().split('=')).filter(v=>v[0]));
  for(const h of r.headers['set-cookie'] || []) {const [k,v]=h.split(';')[0].split('=');v?out.set(k,v):out.delete(k);}
  return [...out].map(([k,v])=>k+'='+v).join('; ');
}
async function fixture({admin=false,pending=false}={}) {
 const directory=fs.mkdtempSync('/private/tmp/amr-account-review-');
 let now=Date.now(), resolveLogin, loginEntrato, ruoloLetture=0, rilasciProvider=0;
 const loginIniziato=new Promise(r=>loginEntrato=r);
 const origine='https://amr.invalid'; let accessi;
 const centro=creaCentro({directory,tokens:{fixture:'a'.repeat(64)},compatibilita:{protocollo:1,release:'b'.repeat(40),codice:'c'.repeat(64),cataloghi:'d'.repeat(64)},
  trasporto:{origine,proxyAttendibili:['127.0.0.1']},
  inizializzaAccessi:app=>{
   accessi=mount(app,{origine,trasporto:{origine,proxyAttendibili:['127.0.0.1']},cookiePath:'/',ora:()=>now,
    identita:async()=>{ruoloLetture++;return {attiva:true,admin,epoca:0};},
    client:{login:async()=>{
     if(pending) {loginEntrato();await new Promise(r=>resolveLogin=r);}
     return admin?{mfa:{ticket:'sintetico-ticket'}}:structuredClone(provider);
    },mfa:async()=>structuredClone(provider),logout:async()=>{rilasciProvider++;}}});return accessi;
  }});
 const server=http.createServer(centro.app);await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});
 function request(route,{body,cookie,method,headers={}}={}) {
  return new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:method||(body===undefined?'GET':'POST'),
    headers:{host:'amr.invalid','x-forwarded-proto':'https',...(cookie?{cookie}:{}),...(body===undefined?{}:{origin:origine,'content-type':'application/json'}),'x-amr-local-admin':'1',...headers}},res=>{
     let raw='';res.setEncoding('utf8');res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw}));
    });req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));
  });
 }
 async function login(cookie) {
  const bootstrap=await request('/api/auth/me',{cookie});
  cookie=jar(bootstrap,cookie);
  let r=await request('/api/auth/login',{body:{email:'fixture@amr.invalid',password:'password-sintetica'},cookie});
  assert.equal(r.status,200); cookie=jar(r,cookie);
  if(admin){r=await request('/api/auth/mfa',{body:{otp:'123456'},cookie});assert.equal(r.status,200);cookie=jar(r,cookie);}
  return cookie;
 }
 return{centro,accessi,request,login,server,origine,loginIniziato,release:()=>resolveLogin(),letture:()=>ruoloLetture,
  cleanup:()=>rilasciProvider,avanza:ms=>now+=ms,
  async close(){centro.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});}};
}
async function adminBody(route, body, table){
 const f=await fixture({admin:true});try{
  const cookie=await f.login();
  if(table==='sospensioni') {
    const headers={'x-amr-node-id':'fixture','x-amr-node-token':'a'.repeat(64)};
    const {epoca}=JSON.parse((await f.request('/_nodo/registrazione',{headers})).raw);
    const boot=require('node:crypto').randomUUID();
    const compatibilita={protocollo:1,release:'b'.repeat(40),codice:'c'.repeat(64),cataloghi:'d'.repeat(64)};
    assert.equal((await f.request('/_nodo/registrazione',{body:{epoca,boot,precedente:null,compatibilita},headers})).status,200);
    assert.equal((await f.request('/_nodo/heartbeat',{body:{id:'fixture',compatibilita,sequenza:1,fonti:{}},
      headers:{...headers,'x-amr-node-boot':boot,'x-amr-center-epoch':epoca}})).status,200);
  }
  const before=f.letture();
  const h={host:'amr.invalid','x-forwarded-proto':'https',origin:f.origine,cookie,'x-amr-local-admin':'1','content-type':'application/json','content-length':String(Buffer.byteLength(JSON.stringify(body)))};
  let stream;
  const pending=new Promise((resolve,reject)=>{
   stream=http.request({host:'127.0.0.1',port:f.server.address().port,path:route,method:'POST',headers:h},res=>{
    let raw='';res.setEncoding('utf8');res.on('data',v=>raw+=v);res.on('end',()=>resolve({status:res.statusCode,raw}));});
   stream.on('error',reject);stream.write('{');
  });
  for(let i=0;i<200&&f.letture()===before;i++)await pause(5);
  assert.equal(f.letture(),before+1);await pause(20);
  assert.equal(f.centro.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  assert.equal((await f.request('/api/auth/logout',{body:{},cookie})).status,200);
  const fresh=await f.request(route,{body,cookie});assert.equal(fresh.status,401);
  stream.end(JSON.stringify(body).slice(1));const late=await pending;
  assert.equal(late.status,401);assert.equal(f.centro.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
  const nuova=await f.login(); assert.equal((await f.request(route,{body,cookie:nuova})).status,200); assert.equal(f.centro.db.prepare(`SELECT count(*) n FROM ${table}`).get().n,1);
  console.log('ADMIN_BODY_COUNTER PASS lateAfterLogout=401 priorRevocations=0 freshAuthorized=200 persistedRevocations=1');
 }finally{await f.close();}
}

for(const [route,body,table] of [[
 '/api/admin/nodi/fixture/revoca-token',{},'token_revocati'],[
 '/api/admin/nodi/fixture',{sospeso:true},'sospensioni']]) {
 test('Admin ricontrollato dopo body tardivo: '+table,()=>adminBody(route,body,table));
}

test('sessioni: trenta richieste anonime o letture non impediscono la revoca',async()=>{
 const f=await fixture();try{
  const a=await f.login(), b=await f.login();
  const lista=await f.request('/api/auth/sessioni',{cookie:a});
  const id=JSON.parse(lista.raw).sessioni.find(s=>!s.corrente).id;
  f.avanza(60000);
  for(let i=0;i<30;i++) {
   assert.equal((await f.request('/api/auth/sessioni')).status,401);
   assert.equal((await f.request('/api/auth/sessioni',{cookie:a})).status,200);
  }
  assert.equal((await f.request('/api/auth/sessioni',{cookie:a})).status,429);
  assert.equal((await f.request('/api/auth/sessioni/revoca',{body:{id},cookie:a})).status,200);
  assert.equal((await f.request('/api/auth/me',{cookie:b})).status,401);
 }finally{await f.close();}
});
