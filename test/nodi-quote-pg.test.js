'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const {execFileSync}=require('node:child_process'),{Pool}=require('pg');
const host=process.env.AMR_TEST_QUOTE_DOCKER_HOST;

test('quota PG18: frammento runner osserva il lock e rifiuta PID invertiti',
  {skip:!host&&'Impostare AMR_TEST_QUOTE_DOCKER_HOST',timeout:120000},async t=>{
    assert.match(host,/^unix:\/\/.*\/amr-auth\/docker\.sock$/);
    const name='amr-quote-prova-'+crypto.randomBytes(6).toString('hex');
    const image='postgres:18.6-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650';
    const docker=args=>{
      try{return execFileSync('docker',['--host',host,...args],
        {encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']}).trim();}
      catch{throw Error('fixture_postgres_non_disponibile');}
    };
    const ids=()=>docker(['ps','-aq']).split('\n').filter(Boolean).sort();
    const prima=ids();let tentato=false,sqlPool;
    t.after(async()=>{
      try{await sqlPool?.end();}finally{
        if(tentato)try{docker(['rm','-f',name]);}catch{
          assert.equal(docker(['ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']),'');
        }
        assert.deepEqual(ids(),prima,'container estranei modificati');
      }
    });
    assert.equal(docker(['ps','-a','--filter','name=^/'+name+'$','--format','{{.ID}}']),'');
    // Un solo container proprio, immagine già presente e rete solo loopback.
    tentato=true;docker(['run','--pull=never','--rm','-d','--name',name,
      '--memory','512m','--cpus','1','--tmpfs','/var/lib/postgresql:rw,nosuid,size=256m',
      '-p','127.0.0.1::5432','-e','POSTGRES_HOST_AUTH_METHOD=trust',image]);
    let pronta=false;
    for(let n=0;n<40&&!pronta;n++){
      try{docker(['exec',name,'pg_isready','-U','postgres']);pronta=true;}
      catch{await new Promise(r=>setTimeout(r,100));}
    }
    assert.ok(pronta);
    const pgAddress=docker(['port',name,'5432/tcp']);assert.match(pgAddress,/^127\.0\.0\.1:\d+$/);
    sqlPool=new Pool({host:'127.0.0.1',port:Number(pgAddress.split(':')[1]),user:'postgres',
      database:'postgres',max:1,statement_timeout:2500,query_timeout:3000,connectionTimeoutMillis:2000});
    sqlPool.on('error',()=>{});
    let client;const termine=performance.now()+10000;
    while(!client&&performance.now()<termine){
      try{client=await sqlPool.connect();}catch{await new Promise(r=>setTimeout(r,100));}
    }
    assert.ok(client,'forward_TCP_fixture_non_pronto');client.release();
    await sqlPool.query(fs.readFileSync(path.join(__dirname,'fixtures/nhost-quote.sql'),'utf8'));
    const source=fs.readFileSync(path.join(__dirname,'../scripts/collauda-nhost-locale.js'),'utf8');
    const start=source.indexOf('const quotePool ='),end=source.indexOf("if (!manuale && process.env.AMR_TEST_RESTIC)",start);
    assert.ok(start>0&&end>start);const body=source.slice(start,end);
    const risultati=[];
    const sql=async testo=>{
      const c=await sqlPool.connect();let errore;
      try{const raw=await c.query(testo),r=Array.isArray(raw)?raw.at(-1):raw;
        return r.rows.length?String(Object.values(r.rows.at(-1))[0]):'';}
      finally{
        try{await c.query('RESET ROLE');}catch(e){errore=e;}
        c.release(errore);if(errore)throw errore;
      }
    };
    const c={assert,require,pgAddress,postgresPassword:'solo_sintetica',performance,setTimeout,sql,risultati};
    await vm.runInNewContext('(async()=>{'+body+'})()',c);
    assert.equal(risultati.length,1);
    assert.equal(await sql('SELECT count(*) FROM amr_prova.inviti;'),'1');
    assert.equal(await sql('SELECT count(*) FROM amr_prova.membri;'),'2');
    await sqlPool.query('DELETE FROM amr_prova.inviti');
    await assert.rejects(vm.runInNewContext('(async()=>{'+body.replace('[pid,altro]','[altro,pid]')+'})()',c),
      {code:'ERR_ASSERTION'});
    // Anche dopo la controprova il pool del frammento è chiuso.
    let connessioni;const fine=performance.now()+1000;
    for(let n=0;n<100&&performance.now()<fine;n++){
      connessioni=await sql("SELECT count(*) FROM pg_stat_activity WHERE backend_type='client backend';");
      if(connessioni==='1')break;await new Promise(r=>setTimeout(r,10));
    }
    assert.equal(connessioni,'1');
  });
