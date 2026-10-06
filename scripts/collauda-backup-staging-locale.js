'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { creaRestic } = require('../backend/nodi/backup-restic');
const { sha, MAX } = require('./nhost/esporta-backup-staging');
const PG = 'postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';

// Il bootstrap conserva l'identità usata dai GRANTED BY. Si omette soltanto
// il CREATE del ruolo già creato da initdb; attributi e GRANT restano invariati.
function globalsPerRestore(bytes,bootstrap) {
  if(!/^[a-z_][a-z0-9_]{0,62}$/.test(bootstrap||''))throw new Error('bootstrap_non_atteso');
  const righe=bytes.toString().split('\n'),crea='CREATE ROLE '+bootstrap+';';
  if(righe.filter(r=>r===crea).length!==1)throw new Error('bootstrap_non_atteso');
  return Buffer.from(righe.filter(r=>r!==crea).join('\n'));
}

// Soltanto fixture nuove: nessun .env, Auth, app, porta pubblicata o dato cloud.
async function collauda({ host, image, restic }) {
  if (host !== 'unix://' + path.join(os.homedir(),'.colima/amr-auth/docker.sock')
      || image !== 'amr-backup:staging-locale' || !path.isAbsolute(restic || '')) throw new Error('collaudo_non_locale');
  const id = 'amr-backup-test-' + crypto.randomBytes(5).toString('hex');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),id+'-')); fs.chmodSync(directory,0o700);
  const nomi = { pg:id+'-pg', restore:id+'-restore', export:id+'-export', init:id+'-init', volume:id+'-volume', rete:id+'-rete' };
  const database = 'b'.repeat(20), pgPassword = crypto.randomBytes(32).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  let fase='fixture', cleanup=true;
  const esegui = (bin,args,input) => new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{env:{PATH:process.env.PATH,LANG:'C'},stdio:['pipe','pipe','pipe']});
    const chunks=[],errors=[];let byte=0,troppo=false,errorByte=0;
    child.stdout.on('data',b=>{ byte+=b.length;if(byte>MAX){troppo=true;child.kill('SIGKILL');}else chunks.push(b); });
    child.stderr.on('data',b=>{if((errorByte+=b.length)<=16384)errors.push(b);});
    child.stdin.on('error',()=>{});child.stdin.end(input);
    const timer=setTimeout(()=>{troppo=true;child.kill('SIGKILL');},120000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('comando_non_avviato'));});
    child.once('close',code=>{clearTimeout(timer);const b=Buffer.concat(chunks);chunks.forEach(x=>x.fill(0));
      const stderr=Buffer.concat(errors);const testo=stderr.toString();stderr.fill(0);errors.forEach(x=>x.fill(0));
      const stato=/ERROR:\s+([A-Z0-9]{5})(?:\s|:)/.exec(testo)?.[1];
      const numeroRiga=Number(/psql:<stdin>:(\d+): ERROR:/.exec(testo)?.[1])||undefined;
      const motivo=['already exists','permission denied','syntax error','must be owner','invalid snapshot','connection refused']
        .find(x=>testo.includes(x));
      if(code!==0||troppo){b.fill(0);reject(Object.assign(new Error('comando_non_confermato'),{stato,motivo,numeroRiga}));}else resolve(b);});
  });
  const docker=(args,input)=>esegui('docker',['--host',host,...args],input);
  const sql=(name,user,db,statement)=>docker(['exec','-i',name,'psql','-X','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-U',user,'-d',db,'-At','-f','-'],Buffer.from(statement));
  const attendi=async name=>{
    for(let i=0;i<30;i++) {
      // Il server temporaneo di initdb accetta il socket Unix ma non TCP.
      try { await docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','fixture_bootstrap']);return; }
      catch { await new Promise(r=>setTimeout(r,300)); }
    }
    throw new Error('postgres_non_pronto');
  };
  try {
    await docker(['network','create','--internal',nomi.rete]);
    await docker(['volume','create',nomi.volume]);
    fase='avvio_postgres_fixture';
    await docker(['run','-d','--name',nomi.pg,'--network',nomi.rete,'--network-alias','postgres-service',
      '--tmpfs','/var/lib/postgresql:rw,noexec,nosuid,size=256m','-e','POSTGRES_USER=fixture_bootstrap',
      '-e','POSTGRES_PASSWORD='+pgPassword,PG]);await attendi(nomi.pg);
    fase='ruoli_database_fixture';
    await sql(nomi.pg,'fixture_bootstrap','postgres',"CREATE ROLE postgres LOGIN SUPERUSER PASSWORD '"+pgPassword+"';");
    await sql(nomi.pg,'fixture_bootstrap','postgres','CREATE DATABASE '+database+' OWNER postgres;');
    fase='schema_fixture';
    await sql(nomi.pg,'fixture_bootstrap',database,
      'CREATE EXTENSION citext;CREATE EXTENSION pgcrypto;CREATE SCHEMA auth;CREATE SCHEMA amr_accessi;'
      + 'CREATE TABLE auth.users(id integer PRIMARY KEY);INSERT INTO auth.users VALUES(1),(2);'
      + 'CREATE TABLE amr_accessi.aziende(id integer PRIMARY KEY,attiva boolean);INSERT INTO amr_accessi.aziende VALUES(1,true);'
      + 'CREATE ROLE nhost_admin LOGIN;GRANT postgres TO nhost_admin WITH SET TRUE;'
      + 'CREATE ROLE amr_gateway NOLOGIN;GRANT USAGE ON SCHEMA amr_accessi TO amr_gateway;'
      + 'GRANT SELECT ON amr_accessi.aziende TO amr_gateway;');
    // Solo questa fixture di rete interna: riproduce la regola trust del provider.
    await docker(['exec','--user','postgres',nomi.pg,'sh','-c',
      'sed -i "1ihost all nhost_admin all trust" "$PGDATA/pg_hba.conf"']);
    await sql(nomi.pg,'fixture_bootstrap',database,'SELECT pg_reload_conf();');
    fase='volume_fixture';
    const inizializza="const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');"
      + "fs.chownSync('/var/lib/amr',1000,1000);fs.chmodSync('/var/lib/amr',0o700);"
      + "const p='/var/lib/amr/lavori-prototipo.db',db=new DatabaseSync(p);"
      + "for(const n of ['lavori','eventi','sospensioni','token_revocati'])db.exec('CREATE TABLE '+n+'(id INTEGER)');"
      + "db.exec('INSERT INTO sospensioni VALUES(11);INSERT INTO token_revocati VALUES(22)');db.close();"
      + "fs.chownSync(p,1000,1000);fs.chmodSync(p,0o600);";
    await docker(['run','--name',nomi.init,'--user','0:0','--network','none','--mount',
      'type=volume,source='+nomi.volume+',target=/var/lib/amr','--entrypoint','node',image,'-e',inizializza]);
    fase='esportazione';
    const env={AMR_BACKUP_ORIGINE:'https://fixture.example.invalid',AMR_BACKUP_PROXY:'127.0.0.1, 192.0.2.1',AMR_BACKUP_DATABASE:database,
      AMR_BACKUP_TOKEN_SHA256:sha(token),
      AMR_BACKUP_SCADENZA:String(Date.now()+10*60000),AMR_BACKUP_RELEASE:'f'.repeat(40)};
    await docker(['run','-d','--name',nomi.export,'--network',nomi.rete,'--mount',
      'type=volume,source='+nomi.volume+',target=/var/lib/amr',...Object.entries(env).flatMap(([k,v])=>['-e',k+'='+v]),image]);
    const leggi="let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',async()=>{try{"
      + "const {categoria,token}=JSON.parse(input);const {r,b}=await new Promise((resolve,reject)=>{"
      + "const q=require('node:http').get('http://127.0.0.1:3000/backup/'+categoria,{headers:{Authorization:'Bearer '+token,Host:'fixture.example.invalid','X-Forwarded-Proto':'https'}},r=>{"
      + "const chunks=[];let bytes=0;r.on('data',chunk=>{bytes+=chunk.length;if(bytes>64*1024*1024)r.destroy(new Error('body_grande'));else chunks.push(chunk);});"
      + "r.once('error',reject);r.once('end',()=>resolve({r,b:Buffer.concat(chunks)}));});q.once('error',reject);q.setTimeout(100000,()=>q.destroy(new Error('timeout')));});"
      + "if(r.statusCode!==200||b.length!==Number(r.headers['content-length'])||require('node:crypto').createHash('sha256').update(b).digest('hex')!==r.headers['x-amr-backup-sha256'])throw 0;"
      + "process.stdout.write(b);}catch{process.exitCode=1;}});";
    let pgBytes;
    for(let i=0;i<20;i++) {
      try { pgBytes=await docker(['exec','-i',nomi.export,'node','-e',leggi],Buffer.from(JSON.stringify({categoria:'postgres',token})));break; }
      catch { await new Promise(r=>setTimeout(r,300)); }
    }
    assert.ok(pgBytes);
    const sqliteBytes=await docker(['exec','-i',nomi.export,'node','-e',leggi],Buffer.from(JSON.stringify({categoria:'volume',token})));
    const dimensioni={postgres:pgBytes.length,volume:sqliteBytes.length};
    fase='restic';
    const password=path.join(directory,'chiave');fs.writeFileSync(password,crypto.randomBytes(32).toString('hex'),{mode:0o600,flag:'wx'});
    const repos=Object.fromEntries(['postgres','volume'].map(n=>[n,creaRestic({binario:restic,
      ambiente:{RESTIC_REPOSITORY:path.join(directory,'repo-'+n),RESTIC_PASSWORD_FILE:password}})]));
    const buffers={postgres:pgBytes,volume:sqliteBytes},snapshot={},impronte={};
    for(const n of Object.keys(repos)) {
      impronte[n]=sha(buffers[n]);await repos[n].inizializza();snapshot[n]=(await repos[n].copia(buffers[n],'database')).snapshot;
      buffers[n].fill(0);await repos[n].verifica();
    }
    const restored={};
    for(const n of Object.keys(repos)) {
      restored[n]=path.join(await repos[n].ripristina(snapshot[n],directory),'database.dump');
      const b=fs.readFileSync(restored[n]);assert.equal(sha(b),impronte[n]);b.fill(0);
    }
    const estrai=async nome=>(await esegui('/usr/bin/tar',['-xOf',restored.postgres,nome]));
    const members=(await esegui('/usr/bin/tar',['-tf',restored.postgres])).toString().trim().split('\n');
    assert.deepEqual(members,['database.dump','globals.sql','manifest.json']);
    const manifest=JSON.parse((await estrai('manifest.json')).toString());
    const dump=await estrai('database.dump'),globals=await estrai('globals.sql');
    assert.equal(sha(dump),manifest.file['database.dump'].sha256);
    assert.equal(sha(globals),manifest.file['globals.sql'].sha256);
    assert.equal(impronte.volume,manifest.file['lavori-prototipo.db'].sha256);
    fase='restore_isolato';
    await docker(['run','-d','--name',nomi.restore,'--network','none','--tmpfs',
      '/var/lib/postgresql:rw,noexec,nosuid,size=256m','-e','POSTGRES_USER=fixture_bootstrap',
      '-e','POSTGRES_PASSWORD='+crypto.randomBytes(32).toString('hex'),PG]);await attendi(nomi.restore);
    fase='restore_globals';
    assert.equal(manifest.postgres.bootstrap,'fixture_bootstrap');
    const globalsRestore=globalsPerRestore(globals,manifest.postgres.bootstrap);
    try {await sql(nomi.restore,'fixture_bootstrap','postgres',globalsRestore);}
    catch(e){
      const riga=globalsRestore.toString().split('\n')[(e.numeroRiga||0)-1]||'';
      e.tipoSQL=/^(CREATE ROLE|ALTER ROLE|GRANT|SET|SELECT|\\connect)\b/.exec(riga)?.[1];throw e;
    } finally {globals.fill(0);globalsRestore.fill(0);}
    // --create conserva anche owner, ACL e impostazioni del database sorgente.
    // Non è combinabile con --single-transaction: il target è nuovo e usa rete none.
    fase='restore_dump';
    await docker(['exec','-i',nomi.restore,'pg_restore','-U','fixture_bootstrap','-d','postgres',
      '--create','--exit-on-error'],dump);dump.fill(0);
    fase='restore_conti';
    const counts=(await sql(nomi.restore,'fixture_bootstrap',database,
      'SELECT count(*) FROM auth.users;SELECT count(*) FROM amr_accessi.aziende;'
      + "SELECT has_table_privilege('amr_gateway','amr_accessi.aziende','SELECT');")).toString().trim();
    assert.equal(counts,'2\n1\nt');
    const numeri=counts.split('\n');
    assert.equal(Number(numeri[0]),manifest.postgres.utenti_auth);
    assert.equal(Number(numeri[1]),manifest.postgres.aziende);
    fase='restore_sqlite';
    const db=new DatabaseSync(restored.volume,{readOnly:true});
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
      assert.equal(db.prepare('SELECT id FROM sospensioni').get().id,11);
      assert.equal(db.prepare('SELECT id FROM token_revocati').get().id,22);
      for (const nome of ['lavori','eventi','sospensioni','token_revocati']) {
        assert.equal(db.prepare('SELECT count(*) AS n FROM '+nome).get().n,manifest.sqlite[nome]);
      }
    } finally { db.close(); }
    return { ok:true,dimensioni,postgres:'18.6',repoSeparati:true,restore:true,networkRestore:'none' };
  } catch (e) {
    let faseNodo;
    if(fase==='esportazione') try {
      const logs=(await docker(['logs',nomi.export])).toString();
      faseNodo=/Backup non confermato: (metadati_iniziali|sqlite|dump|globals|metadati_finali|archivio)/.exec(logs)?.[1];
    } catch {}
    throw Object.assign(new Error('collaudo_backup_non_confermato'),{fase,faseNodo,stato:e.stato,motivo:e.motivo,numeroRiga:e.numeroRiga,tipoSQL:e.tipoSQL});
  }
  finally {
    const owned=[nomi.export,nomi.restore,nomi.pg,nomi.init];
    try {
      const nomiEsistenti=()=>docker(['ps','-a','--format','{{.Names}}']).then(b=>b.toString().trim().split('\n'));
      const esistenti=await nomiEsistenti();
      for(const n of owned.filter(n=>esistenti.includes(n)))try{await docker(['rm','-f',n]);}catch{cleanup=false;}
      if((await nomiEsistenti()).some(n=>owned.includes(n))) cleanup=false;
    } catch { cleanup=false; }
      for(const [tipo,n] of [['volume',nomi.volume],['network',nomi.rete]])try {
        const elenco=await docker([tipo,'ls','--format','{{.Name}}']);
        if(elenco.toString().trim().split('\n').includes(n)) await docker([tipo,'rm',n]);
        const dopo=await docker([tipo,'ls','--format','{{.Name}}']);
        if(dopo.toString().trim().split('\n').includes(n)) cleanup=false;
      } catch { cleanup=false; }
    try { fs.rmSync(directory,{recursive:true,force:true}); } catch { cleanup=false; }
    if(!cleanup) throw new Error('collaudo_backup_cleanup_non_confermato');
  }
}
if(require.main===module) {
  collauda({host:process.env.AMR_TEST_DOCKER_HOST,image:'amr-backup:staging-locale',restic:process.env.AMR_TEST_RESTIC})
    .then(r=>console.log(JSON.stringify(r)),e=>{console.error(JSON.stringify({ok:false,codice:e.message,fase:e.fase,faseNodo:e.faseNodo,stato:e.stato,motivo:e.motivo,numeroRiga:e.numeroRiga,tipoSQL:e.tipoSQL}));process.exitCode=1;});
}
module.exports={collauda,globalsPerRestore};
