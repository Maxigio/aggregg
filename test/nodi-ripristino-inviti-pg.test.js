'use strict';
// Gate opt-in: container PG16 dedicato, dati sintetici, dump/restore veri.
// Auth è una tabella minima: la verifica del provider resta nel gate separato.
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path'),test=require('node:test');
const root=path.resolve(__dirname,'..');
const {Pool}=require(root+'/node_modules/pg');
const {creaAziendePostgres}=require(root+'/backend/nodi/aziende-postgres-prova');
const {creaColleghiPostgres}=require(root+'/backend/nodi/colleghi-postgres-prova');
const {applicaJournal,applicaJournalOrdinati}=require(root+'/backend/nodi/ripristino-journal');
const host=process.env.AMR_TEST_RESTORE_DOCKER_HOST;
const name='amr-pending-proof-'+crypto.randomBytes(6).toString('hex');
let pools,started;
function cmd(args,input) {
 return new Promise((resolve,reject)=>{
  const p=spawn('docker',['--host',host,...args],{stdio:['pipe','pipe','pipe']});
  const out=[];let bytes=0;
  const timer=setTimeout(()=>p.kill('SIGKILL'),60000);
  p.stderr.resume();p.stdin.on('error',()=>{});p.stdin.end(input);
  p.stdout.on('data',b=>{
   bytes+=b.length;
   if(bytes>16*1024*1024)p.kill('SIGKILL');else out.push(b);
  });
  p.on('error',()=>{clearTimeout(timer);reject(new Error('Docker non disponibile'));});
  p.on('close',code=>{
   clearTimeout(timer);
   code===0?resolve(Buffer.concat(out)):reject(new Error('Comando Docker fallito'));
  });
 });
}
test('PG16: dump pending, accettazioni, replay ordinato e dipendenza mancante',
 {skip:!host&&'Impostare AMR_TEST_RESTORE_DOCKER_HOST',timeout:120000},async()=>{
 assert.match(host,/^unix:\/\/.*\/amr-auth\/docker\.sock$/);pools=[];started=false;try{
 await cmd(['run','-d','--name',name,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','postgres:16']);started=true;
 for(let i=0;i<60;i++){try{await cmd(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']);break;}catch{if(i===59)throw new Error('PG not ready');await new Promise(r=>setTimeout(r,250));}}
 const address=(await cmd(['port',name,'5432'])).toString().trim();assert.match(address,/^127\.0\.0\.1:\d+$/);
 const connect=database=>{const pool=new Pool({host:'127.0.0.1',port:Number(address.split(':')[1]),user:'postgres',database,max:2,statement_timeout:15000});pool.on('error',()=>{});pools.push(pool);return pool;};
 const source=connect('postgres');
 await source.query('CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY,email text NOT NULL UNIQUE,email_verified boolean NOT NULL DEFAULT true,disabled boolean NOT NULL DEFAULT false)');
 for(const part of ['accessi','aziende','rinnovi','colleghi','backup'])await source.query(fs.readFileSync(root+'/backend/nodi/schema-'+part+'-prova.sql','utf8'));
 const people={};for(const who of ['admin','first','reference','colleague']){people[who]=crypto.randomUUID();await source.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[people[who],who+'@amr.invalid']);}
 await source.query('INSERT INTO amr_accessi.persone(id,admin) VALUES($1,true)',[people.admin]);
 const session={persona:people.admin,epoca:0,mfa:true};const account=creaAziendePostgres({pool:source}),colleagues=creaColleghiPostgres({pool:source});
 const invite=async(id,email)=>account.invita(session,{id,nome:'Azienda sintetica',email,moduli:['moto'],operazione:crypto.randomUUID()});
 const first=await invite('first','first@amr.invalid'),reference=await invite('second','reference@amr.invalid');
 await account.accetta(people.reference,reference.token);await account.attiva(session,{id:'second',operazione:crypto.randomUUID()});
 const colleague=await colleagues.invita(session,{id:'second',email:'colleague@amr.invalid',operazione:crypto.randomUUID()});
 const unrelated=await colleagues.invita(session,{id:'second',email:'unrelated@amr.invalid',operazione:crypto.randomUUID()});
 const before=(await source.query('SELECT max(sequenza)::text n FROM amr_backup.outbox')).rows[0].n;
 const dump=await cmd(['exec',name,'pg_dump','-U','postgres','-Fc','postgres']);
 await account.accetta(people.first,first.token);await colleagues.accetta(people.colleague,{token:colleague.token,operazione:crypto.randomUUID()});
 await account.rinnova(session,{id:'second',operazione:crypto.randomUUID()});
 const journals=(await source.query('SELECT journal FROM amr_backup.outbox WHERE sequenza>$1 ORDER BY sequenza',[before])).rows.map(r=>r.journal);assert.equal(journals.length,3);
 await source.query('CREATE DATABASE recovery');await cmd(['exec','-i',name,'pg_restore','-U','postgres','--exit-on-error','-d','recovery'],dump);
 const recovery=connect('recovery');const client=await recovery.connect();
 try {
  await assert.rejects(applicaJournal({client,journal:journals.at(-1)}),{codice:'ripristino_accettazione_mancante'});
  assert.equal((await recovery.query('SELECT count(*)::int n FROM amr_accessi.membri')).rows[0].n,1);
  await recovery.query("UPDATE auth.users SET email='diversa@amr.invalid' WHERE id=$1",[people.first]);
  await assert.rejects(applicaJournal({client,journal:journals[0]}),{codice:'ripristino_invito_in_conflitto'});
  await recovery.query("UPDATE auth.users SET email='first@amr.invalid' WHERE id=$1",[people.first]);
  const esiti=await applicaJournalOrdinati({client,journals:[...journals].reverse()});
  assert.ok(esiti.every(e=>e.stato==='applicato'&&!e.giaEseguita));
  assert.ok((await applicaJournalOrdinati({client,journals})).every(e=>e.giaEseguita));
 }finally{client.release();}
 assert.equal((await recovery.query('SELECT count(*)::int n FROM amr_accessi.membri')).rows[0].n,3);
 assert.equal((await recovery.query("SELECT stato FROM amr_accessi.colleghi_inviti WHERE id=$1",[unrelated.invito])).rows[0]?.stato,'pending');
 const accepted=(await recovery.query("SELECT persona,accettata_il FROM amr_accessi.aziende_inviti WHERE azienda='first'")).rows[0];
 assert.equal(accepted.persona,people.first);assert.ok(accepted.accettata_il);
 assert.equal((await recovery.query("SELECT stato,persona FROM amr_accessi.colleghi_inviti WHERE id=$1",[colleague.invito])).rows[0].stato,'accettato');
 await colleagues.revocaInvito(session,{id:'second',operazione:crypto.randomUUID(),invito:unrelated.invito});
 const revoca=(await source.query('SELECT journal FROM amr_backup.outbox ORDER BY sequenza DESC LIMIT 1')).rows[0].journal;
 const c=await recovery.connect();try {await applicaJournalOrdinati({client:c,journals:[revoca]});}finally{c.release();}
 assert.equal((await recovery.query('SELECT stato FROM amr_accessi.colleghi_inviti WHERE id=$1',[unrelated.invito])).rows[0].stato,'revocato');
 assert.equal((await recovery.query('SELECT count(*)::int n FROM amr_accessi.membri')).rows[0].n,3);
 }finally{for(const p of pools)await p.end();if(started)await cmd(['rm','-f','-v',name]);}});
