'use strict';
// Probe esplicita, due progetti Docker nuovi con soli dati sintetici. Non legge
// .env e non ferma progetti esistenti. Gli stack spariscono anche in caso di errore.
// AMR_TEST_BACKUP_DOCKER_HOST=unix:///.../amr-auth/docker.sock AMR_TEST_RESTIC=/.../restic node --test test/nodi-backup-postgres.test.js
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { configura } = require('../scripts/collauda-nhost-locale');
const { creaRestic } = require('../backend/nodi/backup-restic');
const { creaBackupPostgres, creaDumpPostgres, creaStatoBackup, collegaNotificheBackup } = require('../backend/nodi/backup-postgres-prova');
const { creaAziendePostgres } = require('../backend/nodi/aziende-postgres-prova');
const { creaColleghiPostgres } = require('../backend/nodi/colleghi-postgres-prova');
const { applicaJournal, applicaJournalOrdinati } = require('../backend/nodi/ripristino-journal');
const host = process.env.AMR_TEST_BACKUP_DOCKER_HOST;

function comando(args, input, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve,reject) => {
    const p = spawn('docker', ['--host',host,...args], { stdio:['pipe','pipe','pipe'] });
    let size = 0, troppo = false; const chunks = [];
    const timer = setTimeout(() => { troppo = true; p.kill('SIGKILL'); },120000);
    p.stderr.resume(); p.stdin.on('error',()=>{}); p.stdin.end(input);
    p.stdout.on('data', b => { size += b.length; if(size > maxBytes) { troppo = true; p.kill('SIGKILL'); } else chunks.push(b); });
    p.once('error', () => { clearTimeout(timer); reject(new Error('docker_test_non_disponibile')); });
    p.once('close', code => { clearTimeout(timer); code===0 && !troppo ? resolve(Buffer.concat(chunks))
      : reject(new Error('docker_test_fallito')); });
  });
}

test('backup PG16/Auth reale: transazioni, ruoli, lease/CAS, journal indipendente e restore in altro cluster',
  { skip: (!host || !process.env.AMR_TEST_RESTIC) && 'Impostare AMR_TEST_BACKUP_DOCKER_HOST e AMR_TEST_RESTIC', timeout:300000 }, async t => {
    assert.match(host, /^unix:\/\/.*\/amr-auth\/docker\.sock$/);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'amr-backup-pg-'));
    fs.chmodSync(dir,0o700);
    const pass = crypto.randomBytes(32).toString('hex'), encryption = crypto.randomBytes(32).toString('hex');
    const pools = [], stacks = [], clients = [], listeners = [];
    let fase = 'avvio';
    t.after(async () => {
      for (const l of listeners) await l.close();
      for (const c of clients) { try { c.release(true); } catch {} }
      for (const p of pools) await p.end();
      let ok = true;
      for (const s of stacks.reverse()) {
        try { await s.cmd('down','--volumes','--remove-orphans'); }
        catch { ok = false; }
      }
      if (ok) fs.rmSync(dir,{recursive:true,force:true});
      else throw new Error('backup_test_cleanup_fallito');
    });
    const stack = async nome => {
      const file = path.join(dir,nome+'.json');
      const config = configura({ password:pass,encryption,postgresDiretto:true,
        jwt:JSON.stringify({type:'HS256',key:crypto.randomBytes(32).toString('hex')}),admin:crypto.randomBytes(32).toString('hex') });
      const args = ['compose','--project-name','amr-backup-'+nome+'-'+crypto.randomBytes(5).toString('hex'),'-f',file];
      const s = { args, cmd: (...a) => comando([...args,...a]) }; stacks.push(s);
      fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});
      await s.cmd('up','-d','--pull','never','--wait','postgres','mail');
      const pg = (await s.cmd('port','postgres','5432')).toString().trim(); assert.match(pg,/^127\.0\.0\.1:\d+$/);
      const poolConfig = { host:'127.0.0.1',port:Number(pg.split(':')[1]),user:'postgres',password:pass,
        database:'postgres',max:3,statement_timeout:15000,lock_timeout:5000,connectionTimeoutMillis:5000 };
      const pool = new Pool(poolConfig); pool.on('error',()=>{}); pools.push(pool);
      const auth = (await s.cmd('port','mail','4000')).toString().trim(); assert.match(auth,/^127\.0\.0\.1:\d+$/);
      s.pool = pool; s.poolConfig = poolConfig; s.base = 'http://'+auth;
      config.services.auth.environment.AUTH_SERVER_URL = s.base+'/v1';
      fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});
      s.startAuth = async () => {
        await s.cmd('up','-d','--pull','never');
        for (let i=0;i<60;i++) {
          try { if ((await fetch(s.base+'/healthz',{signal:AbortSignal.timeout(1500)})).ok) return; } catch {}
          await new Promise(r=>setTimeout(r,500));
        }
        throw new Error('auth_test_non_pronto');
      };
      s.auth = async (endpoint,body) => {
        const r = await fetch(s.base+'/v1'+endpoint,{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
        let data; try { data=await r.json(); } catch {}
        return { status:r.status,data };
      };
      return s;
    };
    try {
      const source = await stack('origine');
      await source.pool.query('CREATE SCHEMA auth'); await source.startAuth();
      const creaPersona = async nome => {
        const email = nome+'-'+crypto.randomBytes(4).toString('hex')+'@amr.invalid';
        const password = crypto.randomBytes(20).toString('hex');
        assert.equal((await source.auth('/signup/email-password',{email,password})).status,200);
        await source.pool.query('UPDATE auth.users SET email_verified=true WHERE email=$1',[email]);
        const r = await source.auth('/signin/email-password',{email,password});
        assert.equal(r.status,200); assert.ok(r.data?.session?.user?.id);
        return { email,password,id:r.data.session.user.id,session:r.data.session };
      };
      const admin = await creaPersona('admin'), referente = await creaPersona('referente'), collega = await creaPersona('collega');
      fase = 'caricamento schema';
      for (const nome of ['accessi','aziende','rinnovi','colleghi','backup']) {
        await source.pool.query(fs.readFileSync(path.join(__dirname,'../backend/nodi/schema-'+nome+'-prova.sql'),'utf8'));
      }
      await source.pool.query('INSERT INTO amr_accessi.persone(id,admin) VALUES($1,true)',[admin.id]);
      const poolRuolo = ruolo => {
        const p = new Pool({...source.poolConfig,options:'-c role='+ruolo}); p.on('error',()=>{}); pools.push(p); return p;
      };
      const writer = poolRuolo('amr_aziende_scrittore'), workerPool = poolRuolo('amr_backup_esecutore');
      const account = creaAziendePostgres({pool:writer}), colleghi = creaColleghiPostgres({pool:writer});
      const stato = creaStatoBackup({pool:writer});
      const sessione = {persona:admin.id,epoca:0,mfa:true};
      const input = {id:'azienda_test',operazione:crypto.randomUUID(),nome:'Azienda sintetica',email:referente.email,moduli:['auto','moto']};
      fase = 'outbox transazionale';
      const permessi = await writer.query("SELECT has_function_privilege(current_user,'amr_accessi.colleghi_scrivi(uuid,integer,boolean,uuid,text,text,uuid,text,text)','EXECUTE') ok");
      assert.equal(permessi.rows[0].ok,true,'Il writer commerciale deve avere EXECUTE colleghi');
      const listener = await source.pool.connect();
      clients.push(listener);
      let notifiche=0; listener.on('notification', n => { assert.equal(n.payload,'');notifiche++; });
      await listener.query('LISTEN amr_backup_operazione');
      const invito = await account.invita(sessione,input); await account.invita(sessione,input);
      assert.equal((await source.pool.query('SELECT count(*)::int n FROM amr_backup.outbox')).rows[0].n,1);
      await account.accetta(referente.id,invito.token);
      await account.attiva(sessione,{id:input.id,operazione:crypto.randomUUID()});
      const ci = await colleghi.invita(sessione,{id:input.id,operazione:crypto.randomUUID(),email:collega.email});
      await colleghi.accetta(collega.id,{operazione:crypto.randomUUID(),token:ci.token});
      const pending = await colleghi.invita(sessione,{id:input.id,operazione:crypto.randomUUID(),email:'pending@amr.invalid'});
      const improntaPending = crypto.createHash('sha256').update(pending.token).digest('hex');
      const rollbackId = crypto.randomUUID();
      const c = await writer.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT amr_accessi.aziende_invita($1,0,true,$2,$3,$4,$5,$6,$7)',
          [admin.id,rollbackId,'annullata','Annullata','rollback@amr.invalid',['auto'],'b'.repeat(64)]);
        await c.query('ROLLBACK');
      } finally { c.release(); }
      assert.equal((await source.pool.query('SELECT count(*)::int n FROM amr_backup.outbox WHERE id=$1',['journal:aziende:'+rollbackId])).rows[0].n,0);
      assert.equal((await source.pool.query('SELECT count(*)::int n FROM amr_backup.aziende_sequenza WHERE azienda=$1',['annullata'])).rows[0].n,0);
      await listener.query('UNLISTEN *'); listener.release(); clients.splice(clients.indexOf(listener),1); assert.ok(notifiche>=1);
      const ordine = (await source.pool.query('SELECT sequenza::text,journal FROM amr_backup.outbox ORDER BY sequenza')).rows;
      assert.ok(ordine.every((r,i)=>r.journal.sequenza===r.sequenza && (i===0 || BigInt(r.sequenza)>BigInt(ordine[i-1].sequenza))));
      assert.equal((await source.pool.query('SELECT sequenza::text FROM amr_backup.aziende_sequenza WHERE azienda=$1',[input.id])).rows[0].sequenza,ordine.at(-1).sequenza);
      // Timestamp volutamente invertiti: la priorità di claim resta la sequenza.
      await source.pool.query("UPDATE amr_backup.outbox SET creata_il=clock_timestamp()-sequenza*interval '1 day'");
      fase = 'privilegi minimi';
      for (const q of ['SELECT * FROM auth.users','SELECT * FROM amr_backup.outbox','SELECT amr_backup.claim(600)',
        'SELECT amr_backup.invalida_accessi_ripristinati()']) await assert.rejects(writer.query(q));
      await assert.rejects(workerPool.query('SELECT * FROM amr_backup.outbox'));
      await assert.rejects(workerPool.query('SELECT * FROM amr_backup.aziende_sequenza'));
      await assert.rejects(writer.query('SELECT * FROM amr_backup.aziende_sequenza'));
      await assert.rejects(workerPool.query('SELECT * FROM auth.users'));
      await assert.rejects(stato.stato({...sessione,mfa:false}));
      await assert.rejects(stato.stato({...sessione,persona:referente.id}));
      fase = 'lease e CAS';
      const claim = () => workerPool.query('SELECT amr_backup.claim(600) AS j').then(r=>r.rows[0].j);
      const [a,b] = await Promise.all([claim(),claim()]); assert.notEqual(a.id,b.id);
      assert.deepEqual([a.journal.sequenza,b.journal.sequenza].map(BigInt).sort((a,b)=>a<b?-1:1),ordine.slice(0,2).map(r=>BigInt(r.sequenza)));
      await source.pool.query('UPDATE amr_backup.outbox SET lease_fino=clock_timestamp()-interval \'1 second\' WHERE id=$1',[a.id]);
      const reclaimed = await claim(); assert.equal(reclaimed.id,a.id); assert.notEqual(reclaimed.lease,a.lease);
      assert.equal((await workerPool.query('SELECT amr_backup.completa($1,$2,$3) ok',[a.id,a.lease,'f'.repeat(64)])).rows[0].ok,false);
      assert.equal((await workerPool.query('SELECT amr_backup.fallisce($1,$2,$3) ok',[a.id,a.lease,'backup_non_disponibile'])).rows[0].ok,false);
      await source.pool.query('UPDATE amr_backup.outbox SET lease_fino=clock_timestamp()-interval \'1 second\' WHERE lease IS NOT NULL');
      const nonConfigurato = creaBackupPostgres({pool:workerPool,batch:32});
      await nonConfigurato.drain(); const warning = await stato.stato(sessione);
      assert.equal(warning.configurato,false);assert.equal(warning.avviso,true);assert.ok(warning.journal.failed>0);
      fase = 'repository locali e dump custom';
      const passwordFile = path.join(dir,'restic-password');fs.writeFileSync(passwordFile,crypto.randomBytes(32).toString('hex'),{mode:0o600});
      const repos = {};
      for (const cat of ['journal','database']) {
        repos[cat] = creaRestic({binario:process.env.AMR_TEST_RESTIC,ambiente:{
          RESTIC_REPOSITORY:path.join(dir,cat),RESTIC_PASSWORD_FILE:passwordFile}});
        await repos[cat].inizializza();
      }
      const dumpDatabase = creaDumpPostgres({binario:'/usr/bin/pg_dump',ambiente:{PGDATABASE:'postgres'},
        spawnProcesso: (_,args,opts) => spawn('docker',['--host',host,...source.args,'exec','-T','postgres','pg_dump','-U','postgres',...args],opts) });
      const backup = creaBackupPostgres({pool:workerPool,repositoryJournal:repos.journal,repositoryDatabase:repos.database,
        dumpDatabase,batch:32,applicaRetention:true});
      await stato.riprova(sessione); assert.equal((await backup.drain()).fallite,0);
      const protetto = await stato.stato(sessione);assert.equal(protetto.avviso,false); assert.equal(protetto.journal.confirmed,6);
      assert.equal(protetto.retentionApplicata,true);
      // Disattivare la retention non fa sparire copie confermate, ma mantiene
      // l'avviso; riattivarla riprogramma manutenzione anche senza nuove copie.
      const dryRunWorker=creaBackupPostgres({pool:workerPool,repositoryJournal:repos.journal,repositoryDatabase:repos.database,dumpDatabase,batch:32});
      await dryRunWorker.drain();const senzaRetention=await stato.stato(sessione);
      assert.equal(senzaRetention.retentionApplicata,false);assert.equal(senzaRetention.avviso,true);
      assert.equal(senzaRetention.journal.confirmed,6);
      await backup.drain();assert.equal((await stato.stato(sessione)).avviso,false);
      await t.test('watermark del dump resta dopo prune di tutti i journal confermati',async()=>{
        const c=await source.pool.connect();
        try {
          await c.query('BEGIN');
          const prima=(await c.query('SELECT azienda,sequenza::text FROM amr_backup.aziende_sequenza ORDER BY azienda')).rows;
          assert.ok(prima.length>0);
          await c.query("UPDATE amr_backup.outbox SET creata_il=clock_timestamp()-interval '91 days',completata_il=clock_timestamp()-interval '91 days' WHERE categoria='journal'");
          await c.query('SELECT amr_backup.pulisci()');
          assert.equal((await c.query("SELECT count(*)::int n FROM amr_backup.outbox WHERE categoria='journal'")).rows[0].n,0);
          assert.deepEqual((await c.query('SELECT azienda,sequenza::text FROM amr_backup.aziende_sequenza ORDER BY azienda')).rows,prima);
        } finally { await c.query('ROLLBACK');c.release(); }
      });
      await t.test('claim equa: DB pending servito entro due claim con dieci journal continui',async()=>{
        const c=await source.pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('DELETE FROM amr_backup.outbox');
          await c.query('UPDATE amr_backup.configurazione SET ultima_categoria=NULL');
          await c.query("INSERT INTO amr_backup.outbox(id,categoria) VALUES('database:fair-sintetico','database')");
          const assegnati=[];
          for(let i=1;i<=10;i++) {
            // Clock vecchio: non consentire che la fairness dipenda dal timestamp.
            await c.query("INSERT INTO amr_backup.outbox(id,categoria,journal,sequenza,creata_il) VALUES($1,'journal',$2::jsonb,$3,'2000-01-01T00:00:00Z')",
              ['journal:fair:'+i,JSON.stringify({sequenza:String(i)}),i]);
            const job=(await c.query('SELECT amr_backup.claim(600) j')).rows[0].j;
            assert.ok(job);assegnati.push(job);
            assert.equal((await c.query('SELECT amr_backup.completa($1,$2,$3) ok',[job.id,job.lease,'f'.repeat(64)])).rows[0].ok,true);
          }
          assert.deepEqual(assegnati.slice(0,2).map(j=>j.categoria),['journal','database']);
          assert.equal(assegnati.filter(j=>j.categoria==='database').length,1);
          assert.deepEqual(assegnati.filter(j=>j.categoria==='journal').map(j=>j.journal.sequenza),Array.from({length:9},(_,i)=>String(i+1)));
          assert.equal((await c.query('SELECT count(*)::int n FROM amr_backup.outbox WHERE completata_il IS NULL')).rows[0].n,1);
        } finally { await c.query('ROLLBACK');c.release(); }
      });
      const dbCopia = (await source.pool.query('SELECT snapshot FROM amr_backup.outbox WHERE categoria=\'database\'')).rows[0].snapshot;
      backup.start();
      const notificheBackup = await collegaNotificheBackup({pool:workerPool,worker:backup});listeners.push(notificheBackup);
      fase = 'journal dopo copia DB';
      await account.rinnova(sessione,{id:input.id,operazione:crypto.randomUUID(),scadenza:new Date(Date.now()+800*86400000).toISOString()});
      const revocaId = crypto.randomUUID();await colleghi.revoca(sessione,{id:input.id,operazione:revocaId,persona:collega.id});
      // Copia provocata dal vero NOTIFY al commit, senza chiamare drain manuale.
      for (let i=0;i<200;i++) {
        const n=(await source.pool.query('SELECT count(*)::int n FROM amr_backup.outbox WHERE completata_il IS NULL')).rows[0].n;
        if(n===0)break;
        await new Promise(r=>setTimeout(r,50));
      }
      await notificheBackup.close();
      const rj = (await source.pool.query('SELECT journal,snapshot FROM amr_backup.outbox WHERE id=$1',['journal:colleghi:'+revocaId])).rows[0];
      assert.equal(rj.journal.destinatario,collega.id);
      assert.ok(rj.journal.persone.some(p=>p.id===collega.id && p.membro===false && p.epoca===2));
      assert.ok(!/@|email|password|token|impronta|annuncio/i.test(JSON.stringify(rj.journal)));
      const jr = await repos.journal.ripristina(rj.snapshot,dir);
      const journal = JSON.parse(fs.readFileSync(path.join(jr,'operazioni.json'),'utf8'));
      assert.deepEqual(journal,rj.journal);
      assert.equal((await source.pool.query('SELECT snapshot FROM amr_backup.outbox WHERE categoria=\'database\'')).rows[0].snapshot,dbCopia);
      fase = 'restore cluster separato e ruoli';
      const target = await stack('restore');
      // Manifest di ruoli noto e controllato: nessun pg_dumpall con hash password.
      for (const ruolo of ['amr_accessi_lettore','amr_aziende_definitore','amr_aziende_scrittore',
        'amr_colleghi_definitore','amr_colleghi_scrittore','amr_backup_definitore','amr_backup_esecutore']) {
        await target.pool.query('CREATE ROLE '+ruolo+' NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
      }
      await target.pool.query('GRANT amr_colleghi_scrittore TO amr_aziende_scrittore WITH INHERIT TRUE');
      const restoreDir = await repos.database.ripristina(dbCopia,dir);
      const dump = fs.readFileSync(path.join(restoreDir,'database.dump'));
      try { await comando([...target.args,'exec','-T','postgres','pg_restore','--exit-on-error','--single-transaction','-U','postgres','--dbname','postgres'],dump); }
      finally { dump.fill(0); }
      const checkpoint=(await target.pool.query('SELECT sequenza::text FROM amr_backup.aziende_sequenza WHERE azienda=$1',[input.id])).rows[0].sequenza;
      assert.ok(BigInt(checkpoint)<BigInt(journal.sequenza));
      assert.equal((await target.pool.query('SELECT count(*)::int n FROM auth.refresh_tokens')).rows[0].n>0,true);
      assert.equal((await target.pool.query('SELECT count(*)::int n FROM amr_accessi.membri WHERE persona=$1',[collega.id])).rows[0].n,1);
      // Il restore esercita l'helper effettivo, compresi checkpoint e audit.
      const replay = await target.pool.connect();
      try {
        assert.equal((await applicaJournalOrdinati({client:replay,journals:[journal]}))[0].stato,'applicato');
        assert.equal((await applicaJournalOrdinati({client:replay,journals:[journal]}))[0].giaEseguita,true);
      }
      finally { replay.release(); }
      assert.equal((await target.pool.query('SELECT count(*)::int n FROM amr_accessi.membri WHERE persona=$1',[collega.id])).rows[0].n,0);
      assert.equal((await target.pool.query('SELECT scadenza::text FROM amr_accessi.aziende WHERE id=$1',[journal.azienda.id])).rows[0].scadenza,
        (await source.pool.query('SELECT scadenza::text FROM amr_accessi.aziende WHERE id=$1',[journal.azienda.id])).rows[0].scadenza);
      fase = 'invalidazione Auth prima del daemon';
      assert.equal((await target.pool.query('SELECT count(*)::int n FROM amr_accessi.colleghi_inviti WHERE id=$1 AND impronta=$2',[pending.invito,improntaPending])).rows[0].n,1);
      const epochs = (await target.pool.query('SELECT id,epoca FROM amr_accessi.persone ORDER BY id')).rows;
      await target.pool.query('SELECT amr_backup.invalida_accessi_ripristinati()');
      const after = (await target.pool.query('SELECT id,epoca FROM amr_accessi.persone ORDER BY id')).rows;
      assert.ok(after.every((p,i)=>p.id===epochs[i].id && p.epoca===epochs[i].epoca+1));
      assert.equal((await target.pool.query('SELECT count(*)::int n FROM auth.refresh_tokens')).rows[0].n,0);
      assert.equal((await target.pool.query('SELECT count(*)::int n FROM amr_accessi.colleghi_inviti WHERE id=$1 AND impronta=$2',[pending.invito,improntaPending])).rows[0].n,0);
      const restoredWriter = new Pool({...target.poolConfig,options:'-c role=amr_aziende_scrittore'});pools.push(restoredWriter);
      await assert.rejects(creaStatoBackup({pool:restoredWriter}).stato(sessione),e=>e.codice==='sessione_revocata');
      await assert.rejects(restoredWriter.query('SELECT * FROM auth.users'));
      fase = 'secondo restore dopo riapertura';
      await t.test('restore, replay e riapertura: nuovo rinnovo recuperabile da un secondo dump precedente',async()=>{
        const dump = await comando([...target.args,'exec','-T','postgres','pg_dump','-U','postgres','--format=custom']);
        try {
          const scadenza = new Date(Date.now()+1000*86400000).toISOString(), operazione = crypto.randomUUID();
          await creaAziendePostgres({pool:restoredWriter}).rinnova({...sessione,epoca:1},
            {id:input.id,operazione,scadenza});
          const nuovo = (await target.pool.query('SELECT journal FROM amr_backup.outbox WHERE id=$1',
            ['journal:aziende:'+operazione])).rows[0].journal;
          assert.ok(BigInt(nuovo.sequenza)>BigInt(journal.sequenza),
            'Le nuove operazioni devono seguire la massima sequenza recuperata');
          await target.pool.query('CREATE DATABASE restore_successivo');
          await comando([...target.args,'exec','-T','postgres','pg_restore','--exit-on-error','--single-transaction',
            '-U','postgres','--dbname','restore_successivo'],dump);
          const successivo = new Pool({...target.poolConfig,database:'restore_successivo'});pools.push(successivo);
          const c = await successivo.connect();
          try {
            assert.equal((await applicaJournal({client:c,journal:nuovo})).stato,'applicato');
            assert.equal((await applicaJournal({client:c,journal:nuovo})).giaEseguita,true);
            assert.equal((await applicaJournal({client:c,journal})).giaEseguita,true);
            assert.equal((await c.query('SELECT scadenza FROM amr_accessi.aziende WHERE id=$1',
              [input.id])).rows[0].scadenza.toISOString(),scadenza);
          } finally { c.release(); }
        } finally { dump.fill(0); }
      });
      await t.test('finalizzazione: massimo globale fra aziende, rollback e patch riapplicabile senza privilegi web',async()=>{
        const c = await target.pool.connect();
        try {
          const prima = (await c.query('SELECT azienda,sequenza::text FROM amr_backup.aziende_sequenza ORDER BY azienda')).rows;
          const altra = {...journal,dominio:'aziende',tipo:'invita',operazione:crypto.randomUUID(),
            sequenza:'500',destinatario:null,invito:null,persone:[],
            azienda:{...journal.azienda,id:'recuperata_dopo_dump',nome:'Seconda sintetica',attiva:false,
              referente:null,accettata_il:null,attivata_il:null}};
          assert.equal((await applicaJournal({client:c,journal:altra})).stato,'applicato');
          // Anche un dump storico deve ricevere la definizione dal manifest fidato.
          // Questa variante legacy non riallinea la sequenza e non offre accessi.
          await c.query(`CREATE OR REPLACE FUNCTION amr_backup.invalida_accessi_ripristinati() RETURNS void
            LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$`);
          const patch = fs.readFileSync(path.join(__dirname,'../backend/nodi/schema-ripristino-sequenza.sql'),'utf8');
          await c.query(patch);await c.query(patch);
          await c.query('SELECT amr_backup.invalida_accessi_ripristinati()');
          assert.equal((await c.query('SELECT last_value::text FROM amr_backup.sequenza')).rows[0].last_value,'500');
          assert.deepEqual((await c.query('SELECT azienda,sequenza::text FROM amr_backup.aziende_sequenza ORDER BY azienda')).rows,prima);
          await c.query('BEGIN');await c.query("SELECT nextval('amr_backup.sequenza')");await c.query('ROLLBACK');
          await c.query('SELECT amr_backup.invalida_accessi_ripristinati()');
          assert.equal((await c.query('SELECT last_value::text FROM amr_backup.sequenza')).rows[0].last_value,'501');
          assert.equal((await c.query("SELECT nextval('amr_backup.sequenza')::text n")).rows[0].n,'502');
          await assert.rejects(restoredWriter.query('SELECT amr_backup.invalida_accessi_ripristinati()'),{code:'42501'});
          await c.query('BEGIN');
          try {
            const epoche = (await c.query('SELECT id,epoca FROM amr_accessi.persone ORDER BY id')).rows;
            await c.query('DROP TABLE amr_ripristino.operazioni');
            await assert.rejects(c.query('SELECT amr_backup.invalida_accessi_ripristinati()'),
              e=>e.message==='backup_restore_audit_non_verificato');
            await c.query('ROLLBACK');
            assert.deepEqual((await c.query('SELECT id,epoca FROM amr_accessi.persone ORDER BY id')).rows,epoche);
            assert.equal((await c.query('SELECT last_value::text FROM amr_backup.sequenza')).rows[0].last_value,'502');
          } finally { await c.query('ROLLBACK'); }
        } finally { c.release(); }
      });
      await t.test('finalizzazione di un dump vuoto conserva il primo valore non ancora usato',async()=>{
        const c = await target.pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('DROP SCHEMA amr_ripristino CASCADE');
          await c.query('DELETE FROM amr_backup.outbox');
          await c.query('DELETE FROM amr_backup.aziende_sequenza');
          await c.query('ALTER SEQUENCE amr_backup.sequenza RESTART WITH 1');
          await c.query('SELECT amr_backup.invalida_accessi_ripristinati()');
          assert.deepEqual((await c.query('SELECT last_value::text,is_called FROM amr_backup.sequenza')).rows[0],
            {last_value:'1',is_called:false});
          assert.equal((await c.query("SELECT nextval('amr_backup.sequenza')::text n")).rows[0].n,'1');
        } finally { await c.query('ROLLBACK');c.release(); }
      });
      await target.startAuth();
      assert.ok((await target.auth('/token',{refreshToken:admin.session.refreshToken})).status>=400);
      const nuovo = await target.auth('/signin/email-password',{email:admin.email,password:admin.password});
      assert.equal(nuovo.status,200);assert.equal(nuovo.data?.session?.user?.id,admin.id);
      const oldJwt = await target.auth('/token/verify',{token:admin.session.accessToken});assert.ok(oldJwt.status>=400);
      await repos.journal.verifica();await repos.database.verifica();
      t.diagnostic('PG16/Auth: outbox + lease/CAS + privilegi + dump/restore in cluster nuovo + revoca da journal + refresh invalidati + epoca Admin incrementata; nuovo JWT nel test.');
    } catch (e) {
      // Nessun errore raw SQL/Docker/Auth: può includere credenziali sintetiche.
      const posizione = e.stack?.split('\n').find(r=>r.includes(__filename));
      if (posizione) t.diagnostic('Posizione della prova: '+posizione.trim());
      throw new Error('backup PG/Auth fallito: '+fase+' ['+(typeof e.code==='string' && /^[a-z0-9_]+$/i.test(e.code)?e.code:'test')+']');
    }
  });
