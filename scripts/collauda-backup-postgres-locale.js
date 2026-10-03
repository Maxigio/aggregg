'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

// Solo fixture del launcher: stessa istanza Docker isolata, secondo cluster vuoto.
// Il restore non apre Auth né AMR e non conosce il database di produzione.
async function collaudaBackup({ args, directory, fileCompose, docker, sql, backupPool,
  writerPool, admin, azienda, backupWorker, immagini }) {
  const binario = process.env.AMR_TEST_RESTIC;
  if (!binario || !path.isAbsolute(binario) || !fs.existsSync(binario)) {
    throw new Error('Impostare AMR_TEST_RESTIC per il collaudo effettivo del restore');
  }
  const { creaRestic } = require('../backend/nodi/backup-restic');
  const { creaBackupPostgres, creaStatoBackup } = require('../backend/nodi/backup-postgres-prova');
  await backupWorker.stop();
  const segreto = path.join(directory, 'restic-password');
  fs.writeFileSync(segreto, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const repos = Object.fromEntries(['journal','database'].map(c => [c, creaRestic({ binario,
    ambiente: { RESTIC_REPOSITORY:path.join(directory,'repo-'+c), RESTIC_PASSWORD_FILE:segreto } })]));
  for (const r of Object.values(repos)) await r.inizializza();
  const dump = async () => {
    const { stdout } = await run('docker',[...args,'exec','-T','postgres','pg_dump','-U','postgres','--format=custom'],
      { encoding:null,maxBuffer:64*1024*1024,timeout:60000 });
    assert.equal(stdout.subarray(0,5).toString(),'PGDMP'); return stdout;
  };
  const baseline = await dump();
  let copia;
  try { copia = await repos.database.copia(baseline,'database'); }
  finally { baseline.fill(0); }
  const scadenza = new Date(Date.now()+400*86400000).toISOString();
  const operazione = crypto.randomUUID();
  await require('../backend/nodi/aziende-postgres-prova').creaAziendePostgres({pool:writerPool})
    .rinnova(admin,{id:azienda,operazione,scadenza});
  const worker = creaBackupPostgres({ pool:backupPool,repositoryJournal:repos.journal,
    repositoryDatabase:repos.database,dumpDatabase:dump,batch:32 });
  let client, clientRevoca;
  try {
    // Il guasto simulato precedente aveva rinviato i job: ripresa esplicita dell'Admin.
    const statoApi=creaStatoBackup({pool:writerPool}); await statoApi.riprova(admin);
    for(let i=0;i<4;i++) {
      const esito=await worker.drain();assert.equal(esito.ok,true);assert.equal(esito.fallite,0);
      const stato=await statoApi.stato(admin);if(!stato.journal.pending)break;
    }
    const stato=await statoApi.stato(admin);
    assert.equal(stato.configurato,true);assert.equal(stato.journal.stato,'confermato');
    assert.equal(stato.database.stato,'confermato');
    await Promise.all(Object.values(repos).map(r=>r.verifica()));
    const snapshot=await sql(`SELECT snapshot FROM amr_backup.outbox WHERE id='journal:aziende:${operazione}';`);
    assert.match(snapshot,/^[a-f0-9]{64}$/);
    const journalDir=await repos.journal.ripristina(snapshot,directory);
    const journalBuffer=fs.readFileSync(path.join(journalDir,'operazioni.json'));
    let journal;
    try { journal=JSON.parse(journalBuffer.toString()); } finally { journalBuffer.fill(0); }
    assert.equal(journal.operazione,operazione);
    assert.equal(JSON.stringify(journal).includes('refreshToken'),false);
    const dbDir=await repos.database.ripristina(copia.snapshot,directory);
    const restorePass=crypto.randomBytes(32).toString('hex');
    const compose=JSON.parse(fs.readFileSync(fileCompose,'utf8'));
    compose.services.ripristino={image:immagini.postgres,ports:['127.0.0.1:0:5432'],
      environment:{POSTGRES_PASSWORD:restorePass},tmpfs:['/var/lib/postgresql/data'],
      healthcheck:{test:['CMD-SHELL','pg_isready -U postgres'],interval:'2s',timeout:'2s',retries:30}};
    fs.writeFileSync(fileCompose,JSON.stringify(compose),{mode:0o600});
    await docker('up','-d','--wait','ripristino');
    const address=await docker('port','ripristino','5432');assert.match(address,/^127\.0\.0\.1:\d+$/);
    client=new (require('pg').Client)({host:'127.0.0.1',port:Number(address.split(':')[1]),
      user:'postgres',password:restorePass,database:'postgres',query_timeout:10000});
    await client.connect();
    // Ruoli globali dal manifest fidato, nessuna copia di password/login del cluster.
    for(const ruolo of ['amr_accessi_lettore','amr_aziende_definitore','amr_aziende_scrittore',
      'amr_colleghi_definitore','amr_colleghi_scrittore','amr_backup_definitore','amr_backup_esecutore',
      'amr_collaudo_senza_permessi']) {
      await client.query('CREATE ROLE '+ruolo+' NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    }
    await client.query('GRANT amr_colleghi_scrittore TO amr_aziende_scrittore WITH INHERIT TRUE');
    const ripristinaDump=async(file,database)=>{
      const input=fs.readFileSync(file);
      try {
        await new Promise((resolve,reject)=>{
          const child=spawn('docker',[...args,'exec','-T','ripristino','pg_restore','-U','postgres','-d',database,
            '--exit-on-error','--single-transaction'],{stdio:['pipe','ignore','pipe']});
          child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(input);
          const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
          child.once('error',()=>{clearTimeout(timer);reject(new Error('restore non avviato'));});
          child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('restore PostgreSQL fallito'));});
        });
      } finally { input.fill(0); }
    };
    await ripristinaDump(path.join(dbDir,'database.dump'),'postgres');
    await client.query(fs.readFileSync(path.join(__dirname,'../backend/nodi/schema-ripristino-sequenza.sql'),'utf8'));
    const prima=(await client.query('SELECT scadenza FROM amr_accessi.aziende WHERE id=$1',[azienda])).rows[0].scadenza;
    assert.notEqual(prima.toISOString(),scadenza);
    const { applicaJournalOrdinati }=require('../backend/nodi/ripristino-journal');
    await applicaJournalOrdinati({client,journals:[journal]});
    await applicaJournalOrdinati({client,journals:[journal]});
    const dopo=(await client.query('SELECT scadenza FROM amr_accessi.aziende WHERE id=$1',[azienda])).rows[0].scadenza;
    assert.equal(dopo.toISOString(),scadenza);
    const vecchiaEpoca=(await client.query('SELECT epoca FROM amr_accessi.persone WHERE id=$1',[admin.persona])).rows[0].epoca;
    await client.query('SELECT amr_backup.invalida_accessi_ripristinati()');
    assert.equal((await client.query('SELECT count(*)::integer n FROM auth.refresh_tokens')).rows[0].n,0);
    assert.equal((await client.query('SELECT epoca FROM amr_accessi.persone WHERE id=$1',[admin.persona])).rows[0].epoca,vecchiaEpoca+1);
    assert.equal((await client.query('SELECT amr_accessi.aziende_elenco($1,$2,true) AS risultato',
      [admin.persona,vecchiaEpoca+1])).rows.length,1);
    await assert.rejects(client.query('SELECT amr_accessi.aziende_elenco($1,$2,true)',
      [admin.persona,vecchiaEpoca]),e=>e.code==='P0001'&&e.message==='sessione_revocata');
    const privilegi=(await client.query("SELECT count(*)::integer n FROM pg_roles WHERE rolname LIKE 'amr_%' AND (rolcanlogin OR rolsuper OR rolbypassrls)")).rows[0].n;
    assert.equal(privilegi,0);
    await client.query('SET ROLE amr_aziende_scrittore');
    assert.equal((await client.query("SELECT has_function_privilege(current_user,'amr_accessi.colleghi_scrivi(uuid,integer,boolean,uuid,text,text,uuid,text,text)','EXECUTE') AS ok")).rows[0].ok,true);
    await assert.rejects(client.query('SELECT * FROM auth.users'),{code:'42501'});
    assert.equal((await client.query('SELECT amr_accessi.aziende_elenco($1,$2,true) AS risultato',
      [admin.persona,vecchiaEpoca+1])).rows.length,1);
    await assert.rejects(client.query('SELECT amr_accessi.aziende_elenco($1,$2,true)',
      [admin.persona,vecchiaEpoca]),e=>e.code==='P0001'&&e.message==='sessione_revocata');
    await client.query('RESET ROLE');

    // Identità solo sintetica, creata prima del dump: il replay non crea Auth.
    // Accettazione e revoca vere producono journal e watermark nei loro commit.
    const personaRevocata=crypto.randomUUID(), email='journal-'+crypto.randomBytes(8).toString('hex')+'@amr.invalid';
    await client.query('INSERT INTO auth.users(id,email,email_verified,disabled,locale) VALUES($1,$2,true,false,$3)',
      [personaRevocata,email,'en']);
    await client.query('INSERT INTO amr_accessi.persone(id,attiva,epoca) VALUES($1,true,0)',[personaRevocata]);
    const colleghi=require('../backend/nodi/colleghi-postgres-prova').creaColleghiPostgres({pool:client});
    const adminCorrente={...admin,epoca:vecchiaEpoca+1};
    const invito=await colleghi.invita(adminCorrente,{id:azienda,operazione:crypto.randomUUID(),email});
    const accettazione=crypto.randomUUID();
    await colleghi.accetta(personaRevocata,{operazione:accettazione,token:invito.token});
    const vecchio=(await client.query('SELECT journal FROM amr_backup.outbox WHERE id=$1',
      ['journal:colleghi:'+accettazione])).rows[0].journal;
    assert.ok(vecchio.persone.some(p=>p.id===personaRevocata&&p.membro));
    const contenutoJournal=Buffer.from(JSON.stringify(vecchio));let copiaVecchio;
    try { copiaVecchio=await repos.journal.copia(contenutoJournal,'journal'); }
    finally { contenutoJournal.fill(0); }
    const revoca=crypto.randomUUID();
    await colleghi.revoca(adminCorrente,{id:azienda,operazione:revoca,persona:personaRevocata});
    const nuova=(await client.query('SELECT journal FROM amr_backup.outbox WHERE id=$1',
      ['journal:colleghi:'+revoca])).rows[0].journal;
    assert.ok(BigInt(vecchio.sequenza)<BigInt(nuova.sequenza));
    assert.ok(nuova.persone.some(p=>p.id===personaRevocata&&!p.membro));
    assert.equal((await client.query('SELECT sequenza::text FROM amr_backup.aziende_sequenza WHERE azienda=$1',
      [azienda])).rows[0].sequenza,nuova.sequenza);
    // Stesso cluster isolato del launcher; audit escluso per simulare il primo replay.
    const {stdout:dumpRevoca}=await run('docker',[...args,'exec','-T','ripristino','pg_dump','-U','postgres',
      '--dbname=postgres','--format=custom','--exclude-schema=amr_ripristino'],
    {encoding:null,maxBuffer:64*1024*1024,timeout:60000});
    assert.equal(dumpRevoca.subarray(0,5).toString(),'PGDMP');let copiaRevoca;
    try { copiaRevoca=await repos.database.copia(dumpRevoca,'database'); }
    finally { dumpRevoca.fill(0); }
    const dirRevoca=await repos.database.ripristina(copiaRevoca.snapshot,directory);
    const dirVecchio=await repos.journal.ripristina(copiaVecchio.snapshot,directory);
    const vecchioBuffer=fs.readFileSync(path.join(dirVecchio,'operazioni.json'));let journalVecchio;
    try { journalVecchio=JSON.parse(vecchioBuffer.toString()); }
    finally { vecchioBuffer.fill(0); }
    assert.deepEqual(journalVecchio,vecchio);
    await client.query('CREATE DATABASE restore_revoca');
    await ripristinaDump(path.join(dirRevoca,'database.dump'),'restore_revoca');
    clientRevoca=new (require('pg').Client)({host:'127.0.0.1',port:Number(address.split(':')[1]),
      user:'postgres',password:restorePass,database:'restore_revoca',query_timeout:10000});
    await clientRevoca.connect();
    const prova=await require('../test/nodi-ripristino-journal.test').provaJournalAntecedenteDump({
      client:clientRevoca,journal:journalVecchio,personaRevocata});
    return 'restic reale: repository separati, journal e dump; restore in secondo cluster, ruoli NOLOGIN ricreati, replay idempotente e accessi invalidati; '+prova;
  } finally { await worker.stop(); await clientRevoca?.end(); await client?.end(); }
}
module.exports={collaudaBackup};
