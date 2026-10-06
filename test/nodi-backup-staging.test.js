'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { creaServer, preparaCopia, eseguiComando, sha } = require('../scripts/nhost/esporta-backup-staging');

async function server(t, prepara, { attesa = 60000 } = {}) {
  const token = 'a'.repeat(64), scadenza = Date.now() + attesa;
  // Il transport valida Host reale; la porta viene fissata dopo listen.
  let out;
  const placeholder = require('node:http').createServer();
  await new Promise(r => placeholder.listen(0,'127.0.0.1',r));
  const port = placeholder.address().port;
  await new Promise(r => placeholder.close(r));
  out = creaServer({ origine: 'http://127.0.0.1:' + port, proxy: [], tokenHash: sha(token), scadenza, prepara });
  await new Promise(r => out.server.listen(port,'127.0.0.1',r));
  t.after(() => out.chiudi());
  return { ...out, token, url: 'http://127.0.0.1:' + port };
}
const richiesta = (s, route, headers = {}) => fetch(s.url + route, { headers: { Authorization: 'Bearer ' + s.token, ...headers } });
test('backup: niente copia senza autorizzazione e nessun percorso libero', async t => {
  let chiamate = 0;
  const s = await server(t, async () => { chiamate++; throw new Error('fixture'); });
  assert.equal((await richiesta(s,'/backup/volume',{ Authorization:'Bearer ' + 'b'.repeat(64) })).status,401);
  assert.equal((await richiesta(s,'/backup/volume',{ Origin: s.url })).status,403);
  assert.equal((await richiesta(s,'/backup/../segreto')).status,403);
  assert.equal((await fetch(s.url+'/healthz')).status,200);
  assert.equal(chiamate,0);
});
test('due categorie e retry condividono una sola acquisizione', async t => {
  let chiamate = 0;
  const s = await server(t, async () => { chiamate++; return { postgres:Buffer.from('pg'),volume:Buffer.from('sqlite') }; });
  const r = await Promise.all(['/backup/volume','/backup/postgres','/backup/volume'].map(p => richiesta(s,p)));
  assert.deepEqual(await Promise.all(r.map(x=>x.text())),['sqlite','pg','sqlite']);
  assert.equal(chiamate,1);
  assert.equal(r[0].headers.get('x-amr-backup-sha256'),sha('sqlite'));
});
test('errore e chiusura: niente dump ripetuto e niente dati tardivi', async t => {
  let chiamate = 0;
  const s = await server(t, async () => { chiamate++; throw new Error('dato-privato-da-non-esporre'); });
  for(let i=0;i<2;i++) {
    const r = await richiesta(s,'/backup/volume'); assert.equal(r.status,503); assert.equal(await r.text(),'');
  }
  assert.equal(chiamate,1);
  let resolve;
  const copia = { postgres:Buffer.from('pg'),volume:Buffer.from('sqlite') };
  const tardivo = await server(t, () => new Promise(r=>{ resolve=r; }));
  const req = richiesta(tardivo,'/backup/postgres').catch(()=>null);
  while (!resolve) await new Promise(r=>setImmediate(r));
  tardivo.chiudi(); resolve(copia); await req;
  await new Promise(r=>setImmediate(r));
  assert.ok(Object.values(copia).every(b=>b.every(x=>x===0)));
});
test('copia SQLite coerente anche con WAL aperto; dump solo read-only e senza password nei ruoli', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(),'amr-backup-staging-test-'));
  fs.chmodSync(parent,0o700); t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const live = path.join(parent,'volume'); fs.mkdirSync(live,{mode:0o700});
  const db = new DatabaseSync(path.join(live,'lavori-prototipo.db')); t.after(()=>db.close());
  db.exec('PRAGMA journal_mode=WAL');
  for (const nome of ['lavori','eventi','sospensioni','token_revocati']) db.exec('CREATE TABLE '+nome+'(id INTEGER)');
  db.exec('INSERT INTO sospensioni VALUES(1)');
  const pg = { host:'fixture',user:'fixture',database:'fixture',password:'fixture-non-segreta' };
  let globals = false;
  const esegui = async (bin,args,opts) => {
    if (bin === process.execPath) return require('node:util').promisify(require('node:child_process').execFile)(bin,args,opts);
    if (bin !== '/usr/bin/tar') assert.ok(opts.env.PGOPTIONS.includes('default_transaction_read_only=on'));
    if (bin.endsWith('/pg_dump')) { assert.ok(args.includes('--snapshot=00000001-00000002-1'));return {stdout:Buffer.from('PGDMP-fixture')}; }
    if (bin.endsWith('/pg_dumpall')) { globals=args.includes('--no-role-passwords');return {stdout:Buffer.from('fixture')}; }
    assert.equal(bin,'/usr/bin/tar');
    assert.ok(!args.includes('lavori-prototipo.db')); return {stdout:Buffer.from('tar-fixture')};
  };
  const apriSnapshot=async()=>({id:'00000001-00000002-1',metadati:{versione:'18.6',pool_attivi:0,
    session_user:'fixture',current_user:'postgres',read_only:true},chiudi:async()=>{}});
  const out=await preparaCopia({directory:live,temporanei:parent,pg,esegui,apriSnapshot});
  assert.equal(globals,true);
  const restored=path.join(parent,'restore.db');fs.writeFileSync(restored,out.volume);
  const copia=new DatabaseSync(restored,{readOnly:true});
  try { assert.equal(copia.prepare('SELECT count(*) AS n FROM sospensioni').get().n,1); }
  finally { copia.close(); }
  assert.equal(fs.readdirSync(parent).some(n=>n.startsWith('amr-backup-')),false);
  out.volume.fill(0);out.postgres.fill(0);
});

test('copia SQLite: deadline e annullamento terminano il child prima del dump', async t => {
  for (const annulla of [false,true]) await t.test(annulla?'abort':'deadline',async t=>{
    const parent=fs.mkdtempSync(path.join(os.tmpdir(),'amr-backup-annullo-'));
    fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
    fs.writeFileSync(path.join(parent,'lavori-prototipo.db'),'fixture');
    const controller=new AbortController();let pid,chiuso=false,chiamate=0;
    const esegui=(bin,args,opts)=>{
      assert.equal(bin,process.execPath);chiamate++;
      // Simula l'attesa nativa: il processo usa davvero timeout, signal e SIGKILL.
      const promessa=eseguiComando(bin,['-e','setInterval(()=>{},1000)'],opts);
      pid=promessa.child.pid;
      if(annulla)setImmediate(()=>controller.abort());
      return promessa;
    };
    const apriSnapshot=async()=>({id:'00000001-00000002-1',metadati:{versione:'18.6',pool_attivi:0,
      session_user:'fixture',current_user:'postgres',read_only:true},chiudi:async()=>{chiuso=true;}});
    const inizio=performance.now();
    await assert.rejects(preparaCopia({directory:parent,temporanei:parent,pg:{host:'fixture',user:'fixture',database:'fixture'},
      esegui,apriSnapshot,signal:controller.signal,tempoMs:annulla?2000:150}),e=>e.message==='backup_non_confermato'&&e.fase==='sqlite');
    assert.ok(performance.now()-inizio<2000);assert.equal(chiamate,1);assert.equal(chiuso,true);
    assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
    assert.equal(fs.readdirSync(parent).some(n=>n.startsWith('amr-backup-')),false);
  });
});
test('collaudo: rifiuta un Docker remoto prima di creare risorse',async()=>{
  const {collauda}=require('../scripts/collauda-backup-staging-locale');
  await assert.rejects(collauda({host:'tcp://example.invalid:2375',image:'amr-backup:staging-locale',restic:'/fixture/restic'}),
    /collaudo_non_locale/);
});
test('restore: conserva attributi e GRANT del bootstrap; rifiuta un formato inatteso',()=>{
  const {globalsPerRestore}=require('../scripts/collauda-backup-staging-locale');
  const sql='CREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER;\nGRANT postgres TO fixture GRANTED BY postgres;\n';
  assert.equal(globalsPerRestore(Buffer.from(sql),'postgres').toString(),sql.replace('CREATE ROLE postgres;\n',''));
  assert.throws(()=>globalsPerRestore(Buffer.from(sql+sql),'postgres'),/bootstrap_non_atteso/);
  assert.throws(()=>globalsPerRestore(Buffer.from(sql),'postgres; DROP ROLE fixture'),/bootstrap_non_atteso/);
});
