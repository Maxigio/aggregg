'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const {execFileSync}=require('node:child_process');
const {creaColleghiPostgres}=require('../backend/nodi/colleghi-postgres-prova');
const {creaAziendePostgres}=require('../backend/nodi/aziende-postgres-prova');

// MAIN: dopo le tre migration e schema-colleghi-prova.sql, prima/dopo cleanup
// delle proprie fixture, su DB TEMPORANEO SENZA AZIENDE (mai quello manuale).
// await provaColleghiPostgres({sql, pool:writerPool, identita});
// sql è la funzione dell'installatore: SQL string -> Promise. Non servono env,
// password o credenziali reali. identita è l'adapter lettore reale; se presente
// prova anche ingresso/coda/consegna del centro con sessioni e worker sintetici.
async function provaColleghiPostgres({sql,pool,identita}) {
  await sql(`DO $$ BEGIN IF EXISTS(SELECT 1 FROM amr_accessi.aziende) THEN
    RAISE EXCEPTION 'prova colleghi richiede DB temporaneo senza aziende'; END IF; END $$;`);
  const prefix='colleghi_'+crypto.randomBytes(6).toString('hex'), persone=[];
  const account=creaColleghiPostgres({pool}), aziende=creaAziendePostgres({pool});
  const persona=async(nome,verificata=true,admin=false)=>{
    const p={id:crypto.randomUUID(),email:nome+'-'+prefix+'@amr.invalid'}; persone.push(p.id);
    // Nhost Auth 0.49.1: locale è NOT NULL senza default; gli altri campi
    // obbligatori omessi usano i default dello schema del provider.
    await sql(`INSERT INTO auth.users(id,email,email_verified,disabled,locale) VALUES('${p.id}','${p.email}',${verificata},false,'en');
      ${admin?`INSERT INTO amr_accessi.persone(id,admin) VALUES('${p.id}',true);`:''}`);
    return p;
  };
  const input=(id,extra={})=>({id,operazione:crypto.randomUUID(),...extra});
  const assertSQL=condition=>sql(`DO $$ BEGIN IF NOT (${condition}) THEN RAISE EXCEPTION 'controprova colleghi fallita'; END IF; END $$;`);
  const risultati=[];
  let owner, admin;
  const creaAzienda=async(id,ref)=>{
    const i=await aziende.invita(admin,{...input(id),nome:'Prova colleghi',email:ref.email,moduli:['auto']});
    await aziende.accetta(ref.id,i.token); await aziende.attiva(admin,input(id));
  };
  const accetta=async(s,id,p)=>{
    const i=await account.invita(s,input(id,{email:p.email}));
    const op=crypto.randomUUID(); await account.accetta(p.id,{token:i.token,operazione:op});
    return{i,op};
  };
  try {
    owner=await persona('admin',true,true);admin={persona:owner.id,epoca:0,mfa:true};
    const refA=await persona('ref-a'), refB=await persona('ref-b');
    const c1=await persona('collega-1',false), c2=await persona('collega-2'), c3=await persona('collega-3');
    const a=prefix+'_a', b=prefix+'_b';
    const aziendaInvito=prefix+'_pending', datiInvito=input(aziendaInvito,{nome:'Stato invito',email:refA.email,moduli:['moto']});
    const primaConsegna=await aziende.invita(admin,datiInvito);
    assert.equal(primaConsegna.tokenDisponibile,true);
    assert.equal((await aziende.invita(admin,datiInvito)).tokenDisponibile,true);
    const dopoReload=await aziende.invita(admin,{...datiInvito,id:prefix+'_nuovo',operazione:crypto.randomUUID()});
    assert.equal(dopoReload.id,aziendaInvito);assert.equal(dopoReload.tokenDisponibile,true);
    await sql(`UPDATE amr_accessi.aziende_inviti SET creata_il=clock_timestamp()-interval '8 days',scadenza=clock_timestamp()-interval '1 second' WHERE azienda='${aziendaInvito}';`);
    assert.equal((await aziende.invita(admin,datiInvito)).tokenDisponibile,false);
    await sql(`UPDATE amr_accessi.aziende_inviti SET scadenza=clock_timestamp()+interval '1 day' WHERE azienda='${aziendaInvito}';`);
    await aziende.accetta(refA.id,primaConsegna.token);
    assert.equal((await aziende.invita(admin,datiInvito)).tokenDisponibile,false);
    // Fixture esaurita, eliminata prima dei test commerciali già presenti.
    await sql(`BEGIN; DELETE FROM amr_accessi.membri WHERE azienda='${aziendaInvito}';
      DELETE FROM amr_accessi.aziende_operazioni WHERE azienda='${aziendaInvito}';
      DELETE FROM amr_accessi.aziende_inviti WHERE azienda='${aziendaInvito}';
      DELETE FROM amr_accessi.aziende WHERE id='${aziendaInvito}'; COMMIT;`);
    risultati.push('invito azienda: pending recuperabile, scadenza e accettazione ritirano disponibilità SQL');
    await creaAzienda(a,refA); await creaAzienda(b,refB);
    const epocaRefA=identita?(await identita(refA.id)).epoca:0;
    const epocaRefB=identita?(await identita(refB.id)).epoca:0;
    await assertSQL(`(SELECT epoca FROM amr_accessi.persone WHERE id='${refA.id}')=${epocaRefA} AND
      (SELECT epoca FROM amr_accessi.persone WHERE id='${refB.id}')=${epocaRefB}`);
    const sa={persona:refA.id,epoca:epocaRefA,mfa:false}, sb={persona:refB.id,epoca:epocaRefB,mfa:false};
    for(const q of ['SELECT * FROM auth.users','SELECT * FROM amr_accessi.persone',
      'SELECT * FROM amr_accessi.colleghi_inviti','SELECT amr_accessi.colleghi_quota()',
      'SET ROLE amr_colleghi_definitore','CREATE TABLE amr_accessi.vietata(id int)']) {
      await assert.rejects(pool.query(q),{code:'42501'});
    }
    await assertSQL(`NOT has_column_privilege('amr_colleghi_definitore','auth.users','password_hash','SELECT')`);
    await assert.rejects(account.invita({...admin,mfa:false},input(a,{email:c1.email})),{codice:'accesso_non_autorizzato'});
    await assert.rejects(account.invita(sb,input(a,{email:c1.email})),{codice:'accesso_non_autorizzato'});
    await assert.rejects(account.cambiaReferente(sa,input(a,{persona:c2.id})),{codice:'accesso_non_autorizzato'});
    await assert.rejects(account.invita(sa,input(a,{email:owner.email})),{codice:'collega_non_valido'});
    risultati.push('writer senza tabelle/helper/owner; Admin MFA e isolamento SQL verificati');

    const prima=input(a,{email:c1.email}), inv=await account.invita(sa,prima);
    const retry=await account.invita(sa,prima);assert.equal(retry.giaEseguita,true);assert.equal('token' in retry,false);
    await assert.rejects(account.invita(sa,{...prima,email:c2.email}),{codice:'operazione_in_conflitto'});
    await assert.rejects(account.invita(sb,input(b,{email:c1.email.toUpperCase()})),{codice:'invito_esistente'});
    await assert.rejects(aziende.invita(admin,{...input(prefix+'_conflitto'),nome:'Prova colleghi',email:c1.email,moduli:['auto']}),{codice:'invito_esistente'});
    await assertSQL(`(SELECT count(*) FROM amr_accessi.aziende)=2 AND
      (SELECT bool_and(scadenza=creata_il+interval '7 days') FROM amr_accessi.colleghi_inviti)`);

    const holder=await pool.connect(), contendente=await pool.connect();
    let seconda;
    try {
      await holder.query('BEGIN');
      seconda=await creaColleghiPostgres({pool:holder}).invita(sa,input(a,{email:c2.email}));
      const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const altro=(await contendente.query('SELECT pg_backend_pid() pid')).rows[0].pid;
      const concorrenza=creaColleghiPostgres({pool:contendente}).invita(sa,input(a,{email:c3.email})).catch(e=>e);
      await new Promise(r=>setTimeout(r,20));
      await sql(`DO $$ DECLARE osservato boolean:=false; BEGIN FOR i IN 1..100 LOOP
        IF ${pid}=ANY(pg_blocking_pids(${altro})) THEN osservato:=true; EXIT; END IF;
        PERFORM pg_sleep(0.01); END LOOP;
        IF NOT osservato THEN RAISE EXCEPTION 'contesa non osservata'; END IF; END $$;`);
      await holder.query('COMMIT'); assert.equal((await concorrenza).codice,'quota_persone');
    } finally {await holder.query('ROLLBACK');holder.release();contendente.release();}
    await assert.rejects(account.accetta(refB.id,{token:inv.token,operazione:crypto.randomUUID()}),{codice:'invito_non_valido'});
    await assert.rejects(account.accetta(c1.id,{token:inv.token,operazione:crypto.randomUUID()}),{codice:'invito_non_valido'});
    await sql(`UPDATE auth.users SET email_verified=true WHERE id='${c1.id}';`);
    const acceptOp=crypto.randomUUID();
    const doppia=await Promise.all(Array.from({length:2},()=>account.accetta(c1.id,{token:inv.token,operazione:acceptOp})));
    assert.deepEqual(doppia.map(v=>v.giaEseguita).sort(),[false,true]);
    assert.equal((await account.accetta(c1.id,{token:inv.token,operazione:acceptOp})).giaEseguita,true);
    await assert.rejects(account.accetta(c1.id,{token:inv.token,operazione:crypto.randomUUID()}),{codice:'invito_non_valido'});
    await account.accetta(c2.id,{token:seconda.token,operazione:crypto.randomUUID()});
    await assertSQL(`(SELECT count(*) FROM amr_accessi.membri WHERE azienda='${a}')=3 AND
      (SELECT epoca FROM amr_accessi.persone WHERE id='${c1.id}')=1`);
    await assert.rejects(account.invita(sb,input(b,{email:c1.email})),{codice:'appartenenza_esistente'});
    await assert.rejects(account.invita({persona:c1.id,epoca:1,mfa:false},input(a,{email:c3.email})),{codice:'accesso_non_autorizzato'});
    risultati.push('ultimo posto concorrente con lock osservato; accettazione monouso/idempotente senza doppio posto');

    await assert.rejects(account.cambiaReferente(admin,input(a,{persona:refB.id})),{codice:'collega_non_valido'});
    await sql(`UPDATE auth.users SET email_verified=false WHERE id='${c1.id}';`);
    await assert.rejects(account.cambiaReferente(admin,input(a,{persona:c1.id})),{codice:'collega_non_valido'});
    await sql(`UPDATE auth.users SET email_verified=true,disabled=true WHERE id='${c1.id}';`);
    await assert.rejects(account.cambiaReferente(admin,input(a,{persona:c1.id})),{codice:'collega_non_valido'});
    await sql(`UPDATE auth.users SET disabled=false WHERE id='${c1.id}';`);
    const cambio=input(a,{persona:c1.id});await account.cambiaReferente(admin,cambio);
    assert.equal((await account.cambiaReferente(admin,cambio)).giaEseguita,true);
    const nuovoRef={persona:c1.id,epoca:1,mfa:false};
    await assertSQL(`EXISTS(SELECT 1 FROM amr_accessi.membri WHERE persona='${refA.id}' AND azienda='${a}')`);
    await assert.rejects(account.revoca(sa,input(a,{persona:c2.id})),{codice:'accesso_non_autorizzato'});
    await assert.rejects(account.revoca(nuovoRef,input(a,{persona:c1.id})),{codice:'collega_non_valido'});
    await assert.rejects(account.revoca(nuovoRef,input(a,{persona:refB.id})),{codice:'collega_non_valido'});
    const revoca=input(a,{persona:refA.id});await account.revoca(nuovoRef,revoca);
    assert.equal((await account.revoca(nuovoRef,revoca)).giaEseguita,true);
    await assertSQL(`(SELECT epoca FROM amr_accessi.persone WHERE id='${refA.id}')=${epocaRefA+1}`);
    await accetta(nuovoRef,a,refA);
    await account.revoca(nuovoRef,revoca); // vecchio retry non revoca la nuova membership
    await assertSQL(`(SELECT epoca FROM amr_accessi.persone WHERE id='${refA.id}')=${epocaRefA+2} AND
      EXISTS(SELECT 1 FROM amr_accessi.membri WHERE persona='${refA.id}')`);
    if (identita) {
      await provaRevocaCentro({account,identita,gestore:nuovoRef,azienda:a,persona:refA,accetta});
      await account.invita(nuovoRef,input(a,{email:refA.email})); // prenotazione per quota globale
      risultati.push('PostgreSQL reale ferma nuovi job, coda e consegna; reinvito non riabilita vecchie sessioni');
    }
    risultati.push('trasferimento solo Admin MFA; vecchio referente revocabile; epoca monotona su revoca/reinvito');

    const pending=await account.invita(sb,input(b,{email:c3.email}));
    const revI=input(b,{invito:pending.invito});await account.revocaInvito(sb,revI);
    assert.equal((await account.revocaInvito(sb,revI)).giaEseguita,true);
    await assert.rejects(account.invito(pending.token),{codice:'invito_non_valido'});
    const scaduto=await account.invita(sb,input(b,{email:c3.email}));
    await sql(`UPDATE amr_accessi.colleghi_inviti SET creata_il=statement_timestamp()-interval '8 days',
      scadenza=statement_timestamp()-interval '1 day' WHERE id='${scaduto.invito}';`);
    await assert.rejects(account.invito(scaduto.token),{codice:'invito_non_valido'});
    assert.ok((await account.elenco(sb,{id:b})).inviti.some(i=>i.stato==='scaduto'));
    await account.invita(sb,input(b,{email:c3.email}));
    risultati.push('revoca pending idempotente; scadenza 7 giorni libera posto e prenotazione');

    const rollbackEmail='rollback-'+prefix+'@amr.invalid', rollback=input(b,{email:rollbackEmail});
    await sql(`CREATE FUNCTION amr_accessi.prova_colleghi_rollback() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'errore sintetico audit'; END $$;
      CREATE TRIGGER prova_colleghi_rollback BEFORE INSERT ON amr_accessi.colleghi_operazioni
      FOR EACH ROW EXECUTE FUNCTION amr_accessi.prova_colleghi_rollback();`);
    try {await assert.rejects(account.invita(sb,rollback),{codice:'operazione_non_disponibile'});}
    finally {await sql('DROP TRIGGER prova_colleghi_rollback ON amr_accessi.colleghi_operazioni; DROP FUNCTION amr_accessi.prova_colleghi_rollback();');}
    await assertSQL(`NOT EXISTS(SELECT 1 FROM amr_accessi.colleghi_operazioni WHERE id='${rollback.operazione}')
      AND NOT EXISTS(SELECT 1 FROM amr_accessi.colleghi_inviti WHERE email='${rollbackEmail}')`);
    const rr=await pool.connect();
    try {
      await rr.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await rr.query('SELECT current_timestamp');
      await account.invita(sb,input(b,{email:rollbackEmail}));
      await assert.rejects(creaColleghiPostgres({pool:rr}).elenco(sb,{id:b}),{codice:'operazione_non_disponibile'});
    } finally {await rr.query('ROLLBACK');rr.release();}
    risultati.push('rollback include audit/invito; snapshot REPEATABLE READ obsoleto rifiutato');

    for(let n=0;n<8;n++) {
      const ref=await persona('ref-extra-'+n), id=prefix+'_extra_'+n;
      await creaAzienda(id,ref);
      await account.invita(admin,input(id,{email:'pending-1-'+n+'-'+prefix+'@amr.invalid'}));
      await account.invita(admin,input(id,{email:'pending-2-'+n+'-'+prefix+'@amr.invalid'}));
    }
    await assertSQL(`(SELECT count(*) FROM amr_accessi.aziende)=10 AND
      ((SELECT count(*) FROM amr_accessi.membri)+(SELECT count(*) FROM amr_accessi.colleghi_inviti
      WHERE stato='pending' AND scadenza>clock_timestamp()))=30`);
    await assert.rejects(aziende.invita(admin,{...input(prefix+'_undici'),nome:'Prova colleghi',
      email:'extra-'+prefix+'@amr.invalid',moduli:['auto']}),{codice:'quota_aziende'});
    const oltre=await persona('oltre');
    await sql(`INSERT INTO amr_accessi.persone(id) VALUES('${oltre.id}');`);
    await assert.rejects(sql(`INSERT INTO amr_accessi.membri(persona,azienda) VALUES('${oltre.id}','${b}');`));
    await assertSQL(`NOT EXISTS(SELECT 1 FROM amr_accessi.membri WHERE persona='${oltre.id}')`);
    risultati.push('10 aziende / 30 posti inclusi pending; trigger respinge INSERT privilegiato oltre quota');
    return risultati;
  } finally {
    // Solo fixture di questa invocazione, in transazione per le FK differite.
    await sql(`BEGIN;
      DELETE FROM amr_accessi.colleghi_operazioni WHERE azienda LIKE '${prefix}%';
      DELETE FROM amr_accessi.aziende_operazioni WHERE azienda LIKE '${prefix}%';
      DELETE FROM amr_accessi.colleghi_inviti WHERE azienda LIKE '${prefix}%';
      DELETE FROM amr_accessi.aziende_inviti WHERE azienda LIKE '${prefix}%';
      DELETE FROM amr_accessi.membri WHERE azienda LIKE '${prefix}%';
      DELETE FROM amr_accessi.aziende WHERE id LIKE '${prefix}%';
      ${persone.length?`DELETE FROM amr_accessi.persone WHERE id IN (${persone.map(p=>`'${p}'`).join(',')});
      DELETE FROM auth.users WHERE id IN (${persone.map(p=>`'${p}'`).join(',')});`:''}
      COMMIT;`);
  }
}

async function provaRevocaCentro({account,identita,gestore,azienda,persona,accetta}) {
  const {creaCentro}=require('../backend/nodi/centro');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-colleghi-centro-'));
  let s={persona:persona.id,epoca:(await identita(persona.id)).epoca,mfa:false,azienda};
  const accessi={close(){},sessione:req=>req.headers.cookie==='prova=1'?s:null,verifica:async(session,{tipo,admin}={})=>{
    const p=await identita(session?.persona);
    if (!p?.attiva || !session || p.epoca!==session.epoca || (admin&&!p.admin)
      || (tipo && (!p.aziendaValida || !p.moduli.includes(tipo)))) {
      throw Object.assign(new Error('sessione_revocata'),{status:403,codice:'sessione_revocata'});
    }
    return {...p,persona:session.persona};
  }};
  const token='a'.repeat(64), centro=creaCentro({directory:dir,tokens:{a:token},timeoutMs:2000,
    inizializzaAccessi:()=>accessi});
  let server;
  try {
    server=await new Promise((resolve,reject)=>{const srv=centro.app.listen(0,'127.0.0.1',err=>err?reject(err):resolve(srv));srv.on('error',reject);});
    const base='http://127.0.0.1:'+server.address().port;
    const nodo=(verbo,body)=>fetch(base+'/_nodo/'+verbo,{method:body?'POST':'GET',
      headers:{'x-amr-node-id':'a','x-amr-node-token':token,...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify({id:'a',...body})}:{})});
    await nodo('heartbeat',{revisione:'imac-1',occupato:false,
      fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}});
    const cerca=marca=>fetch(base+'/api/search?tipo=auto&marca='+marca,{headers:{cookie:'prova=1'}});
    const inCoda=cerca('Fiat');
    for(let i=0;i<100&&!centro.nodi.get('a').coda.length;i++) await new Promise(r=>setTimeout(r,5));
    assert.equal(centro.nodi.get('a').coda.length,1);
    await account.revoca(gestore,{id:azienda,persona:persona.id,operazione:crypto.randomUUID()});
    assert.equal((await nodo('poll?id=a')).status,204);
    assert.equal((await inCoda).status,403);assert.equal((await cerca('Fiat')).status,403);
    await accetta(gestore,azienda,persona);
    assert.equal((await cerca('Fiat')).status,403); // stesso oggetto sessione: epoca vecchia
    s={...s,epoca:(await identita(persona.id)).epoca};
    const inCorso=cerca('Honda');let job;
    for(let i=0;i<100&&!job;i++) {const r=await nodo('poll?id=a');if(r.status===200)job=await r.json();else await new Promise(r=>setTimeout(r,5));}
    assert.ok(job);
    await account.revoca(gestore,{id:azienda,persona:persona.id,operazione:crypto.randomUUID()});
    await nodo('esito',{idLavoro:job.idLavoro,tentativo:job.tentativo,esito:{status:200,
      body:{risultati:[{id:'sintetico',fonte:'subito',url:'https://www.subito.it/auto/sintetico.htm'}],sources:{subito:{status:'ok'},autoscout:{status:'empty'}}}}});
    const r=await inCorso;assert.equal(r.status,403);assert.equal(Object.hasOwn(await r.json(),'risultati'),false);
  } finally {
    centro.close(); if(server) {server.closeAllConnections();await new Promise(r=>server.close(r));}
    fs.rmSync(dir,{recursive:true,force:true});
  }
}

module.exports={provaColleghiPostgres};
if (require.main === module) test('colleghi PostgreSQL 16: lifecycle reale isolato, concorrenza e privilegi',
  {skip:process.env.AMR_COLLEGHI_PG_DOCKER!=='1' && 'Prova esportata per launcher; oppure AMR_COLLEGHI_PG_DOCKER=1',timeout:120000},async t=>{
    const context=process.env.AMR_COLLEGHI_DOCKER_CONTEXT;
    const dockerArgs=context?['--context',context]:[];
    const docker=(args,input)=>{
      try {return execFileSync('docker',[...dockerArgs,...args],{input,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']}).trim();}
      catch {throw new Error('Docker/SQL di prova non disponibile (output riservato omesso)');}
    };
    const name='amr-colleghi-prova-'+crypto.randomBytes(6).toString('hex');let creato=false, pool,lettore;
    try {
      docker(['run','--pull=never','--rm','-d','--name',name,'-p','127.0.0.1::5432',
        '-e','POSTGRES_HOST_AUTH_METHOD=trust','postgres:16']);creato=true;
      let pronto=false;
      for(let i=0;i<100&&!pronto;i++) {
        // Il server temporaneo dell'entrypoint è raggiungibile sul socket Unix
        // prima del riavvio finale. Aspettare TCP evita la falsa disponibilità.
        try {docker(['exec',name,'pg_isready','-h','127.0.0.1','-U','postgres']);pronto=true;}
        catch {await new Promise(r=>setTimeout(r,100));}
      }
      assert.equal(pronto,true);
      const sql=async q=>docker(['exec','-i',name,'psql','-U','postgres','-v','ON_ERROR_STOP=1','-q'],q);
      await sql(`CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY,email text UNIQUE NOT NULL,
        email_verified boolean NOT NULL,disabled boolean NOT NULL,password_hash text,locale varchar(3) NOT NULL);`);
      for(const schema of ['accessi','aziende','rinnovi','colleghi']) {
        await sql(fs.readFileSync(path.join(__dirname,'../backend/nodi/schema-'+schema+'-prova.sql'),'utf8'));
      }
      await sql(fs.readFileSync(path.join(__dirname,'../backend/nodi/schema-inviti-consegna.sql'),'utf8'));
      await sql('CREATE ROLE prova_writer LOGIN IN ROLE amr_aziende_scrittore;CREATE ROLE prova_reader LOGIN IN ROLE amr_accessi_lettore;');
      const published=docker(['port',name,'5432/tcp']);assert.match(published,/^127\.0\.0\.1:\d+$/);
      const config={host:'127.0.0.1',port:Number(published.split(':')[1]),database:'postgres',max:4,
        connectionTimeoutMillis:2000,statement_timeout:3000,lock_timeout:2000,query_timeout:4000};
      const {Pool}=require('pg');pool=new Pool({...config,user:'prova_writer'});lettore=new Pool({...config,user:'prova_reader'});
      const identita=require('../backend/nodi/accessi-postgres-prova').creaAccessiPostgres({pool:lettore});
      for(const risultato of await provaColleghiPostgres({sql,pool,identita})) t.diagnostic(risultato);
    } finally {
      await pool?.end();await lettore?.end();
      // Mai compose down/prune/stop di nomi esterni: solo questo container posseduto.
      if(creato) docker(['rm','-f',name]);
    }
  });
