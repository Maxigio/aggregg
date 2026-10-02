'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { collegaNotificheBackup } = require('../backend/nodi/backup-postgres-prova');
const pausa = ms => new Promise(r=>setTimeout(r,ms));
function client() {
  const c = new EventEmitter(); c.queryCalls=[];c.releases=[];
  c.query = async q=>{c.queryCalls.push(q);}; c.release = distruggi=>c.releases.push(distruggi);
  return c;
}
function worker() {
  return {segnali:0,stopCalls:0,segnalaOperazione(){this.segnali++;},async stop(){this.stopCalls++;}};
}
test('backup LISTEN: solo canale previsto, catch-up iniziale, close idempotente e nessun listener residuo', async () => {
  const c = client(), w = worker();let connects=0;
  const h = await collegaNotificheBackup({pool:{connect:async()=>{connects++;return c;}},worker:w});
  assert.equal(connects,1);assert.deepEqual(c.queryCalls,['LISTEN amr_backup_operazione']);assert.equal(w.segnali,1);
  c.emit('notification',{channel:'altro',payload:'non-usare'});assert.equal(w.segnali,1);
  c.emit('notification',{channel:'amr_backup_operazione',payload:''});assert.equal(w.segnali,2);
  const a=h.close(),b=h.close();assert.equal(a,b);await a;
  assert.equal(w.stopCalls,1);assert.deepEqual(c.queryCalls,['LISTEN amr_backup_operazione','UNLISTEN amr_backup_operazione']);
  assert.deepEqual(c.releases,[false]);assert.equal(c.listenerCount('notification'),0);assert.equal(c.listenerCount('error'),0);
  c.emit('notification',{channel:'amr_backup_operazione'});assert.equal(w.segnali,2);
});
test('backup LISTEN: errore pool iniziale, retry singolo e rilascio distruttivo dopo perdita del socket', async () => {
  const c=client(),w=worker();let connects=0;
  const h=await collegaNotificheBackup({pool:{async connect(){connects++;if(connects===1)throw new Error('credenziale-sintetica');return c;}},worker:w});
  assert.equal(w.segnali,0);await pausa(300);assert.equal(connects,2);assert.equal(w.segnali,1);
  c.emit('error',new Error('errore-sintetico'));c.emit('end');
  assert.deepEqual(c.releases,[true]);await h.close();await pausa(300);assert.equal(connects,2);
});
test('backup LISTEN: close durante riconnessione rilascia anche il client acquisito in ritardo', async () => {
  const c=client(),late=client(),w=worker();let connects=0,resolveLate;
  const h=await collegaNotificheBackup({pool:{connect(){connects++;return connects===1?Promise.resolve(c):new Promise(r=>{resolveLate=r;});}},worker:w});
  c.emit('end');await pausa(300);assert.equal(connects,2);
  const close=h.close();resolveLate(late);await close;
  assert.deepEqual(late.releases,[true]);assert.equal(late.queryCalls.length,0);assert.equal(w.stopCalls,1);
});
test('backup LISTEN: fallimento UNLISTEN distrugge il client, senza bloccare stop', async () => {
  const c=client(),w=worker();c.query=async q=>{if(q.startsWith('UNLISTEN'))throw new Error('segreto-sintetico');};
  const h=await collegaNotificheBackup({pool:{connect:async()=>c},worker:w});await h.close();
  assert.deepEqual(c.releases,[true]);assert.equal(w.stopCalls,1);
});
