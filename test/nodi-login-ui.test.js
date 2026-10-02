'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

test('pagina login: una lettura iniziale tardiva non riapre la sessione dopo logout',async()=>{
  let completa;
  const nodes=Object.fromEntries(['login','mfa','stato','logout','prototipo'].map(id=>[id,{hidden:['mfa','logout','prototipo'].includes(id),
    elements:{password:{value:''},otp:{value:''},email:{value:''}},addEventListener:()=>{}}]));
  const script=fs.readFileSync(path.join(__dirname,'../frontend/nodi-login-prova.js'),'utf8');
  const navigazioni=[];
  const ctx=vm.createContext({location:{replace:url=>navigazioni.push(url)},document:{querySelector:s=>nodes[s.slice(1)],querySelectorAll:()=>[]},AbortSignal,
    fetch:async url=>url.endsWith('/me')?new Promise(r=>{completa=r;}):{ok:true,json:async()=>({ok:true,providerRevocato:true})}});
  vm.runInContext(script,ctx);
  await vm.runInContext("manda('login', {})",ctx);assert.equal(nodes.prototipo.hidden,false);assert.deepEqual(navigazioni,['/']);
  await vm.runInContext("manda('logout', {})",ctx);assert.equal(nodes.prototipo.hidden,true);
  assert.deepEqual(navigazioni,['/']);
  completa({ok:true});await new Promise(r=>setImmediate(r));
  assert.equal(nodes.login.hidden,false);assert.equal(nodes.logout.hidden,true);assert.equal(nodes.prototipo.hidden,true);assert.deepEqual(navigazioni,['/']);
});
