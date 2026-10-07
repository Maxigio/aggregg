'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');

test('launcher: stop o uscita del centro impedisce avvii tardivi dei worker',()=>{
  for(const evento of ['SIGTERM','exit']) {
    const processo=new EventEmitter();processo.env={};processo.execPath='node';
    const children=[],timers=[];
    const context={process:processo,__dirname:path.join(__dirname,'../scripts'),console:{log(){}},
      setTimeout(fn,ms){const t={fn,ms,cleared:false,unref(){}};timers.push(t);return t;},
      clearTimeout:t=>{t.cleared=true;},
      require:n=>n==='node:fs'?{mkdirSync(){}}:n==='node:child_process'?{spawn(){const p=new EventEmitter();
        p.segnali=[];p.kill=s=>p.segnali.push(s);children.push(p);return p;}}:require(n)};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/avvia-nodi-prototipo.js'),'utf8'),context);
    if(evento==='exit')children[0].emit('exit',1);else processo.emit(evento);
    const avvii=timers.filter(t=>t.ms<1000);assert.ok(avvii.every(t=>t.cleared));
    avvii.forEach(t=>t.fn()); // Anche un callback già pronto non deve creare processi.
    assert.equal(children.length,1);assert.deepEqual(children[0].segnali,['SIGTERM']);
    processo.emit('SIGTERM');assert.deepEqual(children[0].segnali,['SIGTERM']);
    children[0].emit('exit',0);assert.ok(timers.find(t=>t.ms===5000).cleared);
  }
});

test('launcher: worker in intervento non ferma il centro; stop del launcher chiude entrambi',()=>{
  const processo=new EventEmitter();processo.env={};processo.execPath='node';
  const centro=new EventEmitter(),segnali=[],workers=[],timers=[];centro.kill=s=>segnali.push(s);
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../scripts/avvia-nodi-prototipo.js'),'utf8'),{
    process:processo,__dirname:path.join(__dirname,'../scripts'),console:{log(){}},
    setTimeout(fn,ms){const t={fn,ms,unref(){}};timers.push(t);return t;},clearTimeout(){},
    require:n=>n==='node:fs'?{mkdirSync(){}}:n==='node:child_process'?{spawn:()=>centro}
      :n==='../backend/nodi/worker-supervisore'?{supervisiona:()=>{
        const w={eventi:new EventEmitter(),close:()=>{w.chiusure++;},chiusure:0};workers.push(w);return w;
      }}:require(n),
  });
  for(const t of timers.filter(t=>t.ms<1000))t.fn();
  assert.equal(workers.length,2);
  workers[0].eventi.emit('fine',{code:1,stato:'intervento'});
  assert.deepEqual(segnali,[]);assert.equal(workers[1].chiusure,0);assert.equal(processo.exitCode,undefined);
  processo.emit('SIGTERM');assert.deepEqual(segnali,['SIGTERM']);
  assert.ok(workers.every(w=>w.chiusure===1));
});
