'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {creaLimitiGestione} = require('../backend/nodi/limiti-gestione');
function fixture() {
  let now=0;
  const protetta=creaLimitiGestione({accessi:{sessione:req=>req.s},ora:()=>now});
  const run=async(fn,s)=>{const r={status(n){this.code=n;return this;},set(){return this;},json(v){this.body=v;return this;}};
    await fn({s},r);return r;};
  return{protetta,run,avanza:()=>now+=60000};
}
test('gestione: anonimi e polling non consumano revoche; conti per persona e scadenza',async()=>{
  const f=fixture(), ok=async(req,res)=>res.status(200).json({ok:true});
  const leggi=f.protetta(ok,{lettura:true}), scrivi=f.protetta(ok), pubblica=f.protetta(ok,{pubblica:true});
  const a={persona:'a'},b={persona:'b'};
  for(let i=0;i<30;i++) {
    assert.equal((await f.run(leggi)).code,401);
    assert.equal((await f.run(leggi,a)).code,200);
    assert.equal((await f.run(pubblica)).code,200);
  }
  assert.equal((await f.run(leggi,a)).code,429);
  assert.equal((await f.run(pubblica)).code,429);
  assert.equal((await f.run(scrivi,a)).code,200);
  assert.equal((await f.run(leggi,b)).code,200);
  for(let i=1;i<30;i++) assert.equal((await f.run(scrivi,a)).code,200);
  assert.equal((await f.run(scrivi,a)).code,429);
  assert.equal((await f.run(scrivi,b)).code,200);
  f.avanza();assert.equal((await f.run(scrivi,a)).code,200);
});
test('gestione: tre letture pendenti lasciano un posto alle mutazioni, sempre max quattro',async()=>{
  const f=fixture(), completamenti=[];
  const wait=async(req,res)=>{await new Promise(r=>completamenti.push(r));res.status(200).json({ok:true});};
  const leggi=f.protetta(wait,{lettura:true}), scrivi=f.protetta(wait);
  const attese=[f.run(leggi,{persona:'a'}),f.run(leggi,{persona:'b'}),f.run(leggi,{persona:'c'})];
  assert.equal((await f.run(leggi,{persona:'d'})).code,429);
  attese.push(f.run(scrivi,{persona:'a'}));
  assert.equal((await f.run(scrivi,{persona:'b'})).code,429);
  completamenti.forEach(r=>r());assert.deepEqual((await Promise.all(attese)).map(r=>r.code),[200,200,200,200]);
  assert.equal((await f.run(f.protetta(async()=>{throw new Error('non esporre');}),{persona:'a'})).code,503);
});
