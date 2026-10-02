'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { creaAccountProva } = require('../backend/nodi/account-prova');
const { creaCentro } = require('../backend/nodi/centro');

async function setup(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-account-http-'));
  const db=new DatabaseSync(':memory:');
  let now=1800000000000;
  const ids=['owner','rA','rB','a','b','c','d','ownerNoMfa','nonVerificata'];
  const account=creaAccountProva({db,ora:()=>now,identita:ids.map(id=>({id,email:id+'@amr.invalid',
    verificata:id!=='nonVerificata',admin:id.startsWith('owner'),mfa:id==='owner'}))});
  const owner=account.sessione('owner');
  for(const [id,referente,moduli] of [['A','rA',['auto','moto']],['B','rB',['moto']]])
    account.creaAzienda(owner,{id,referente,moduli,scadenza:now+86400000});
  const tokens={n1:'1'.repeat(64),n2:'2'.repeat(64)};
  const centro=creaCentro({tokens,directory:dir,accountProva:account,ora:()=>now,timeoutMs:2500,adminLocale:true});
  const server=await new Promise((resolve,reject)=>{
    const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);
  });
  t.after(async()=>{
    centro.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
    db.close();fs.rmSync(dir,{recursive:true,force:true});
  });
  const base='http://127.0.0.1:'+server.address().port;
  const req=(route,cookie,method='GET',body)=>fetch(base+route,{method,
    headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  const login=async id=>{
    const r=await req('/api/test/login',null,'POST',{persona:id,azienda:'B',admin:true});
    assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];
  };
  const node=(id,route,method='GET',body)=>fetch(base+route,{method,
    headers:{'x-amr-node-id':id,'x-amr-node-token':tokens[id],...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify({id,...body})}:{})});
  const hb=id=>node(id,'/_nodo/heartbeat','POST',{revisione:'imac-1',fonti:{subito:{fermo:false},
    autoscout:{fermo:false},moto:{fermo:false}},occupato:false,simulato:false});
  for(const id of Object.keys(tokens)) assert.equal((await hb(id)).status,200);
  const poll=async(id='n1')=>{
    for(let n=0;n<100;n++){
      const r=await node(id,'/_nodo/poll?id='+id);
      if(r.status===200)return r.json();assert.equal(r.status,204);
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw new Error('nessun lavoro consegnato');
  };
  const esito=(job,body,id='n1',status=200)=>node(id,'/_nodo/esito','POST',{
    idLavoro:job.idLavoro,tentativo:job.tentativo,esito:{status,body}});
  const cerca=cookie=>req('/api/search?tipo=moto&marca=Yamaha&modello=MT-07',cookie);
  const waitJob=async(count=1)=>{
    for(let n=0;n<100;n++){
      if(centro.lavori.size>=count)return;
      await new Promise(resolve=>setTimeout(resolve,5));
    }throw new Error('lavoro non accodato');
  };
  return {db,account,centro,req,login,node,hb,poll,esito,cerca,waitJob,owner,
    now:()=>now,avanza:ms=>{now+=ms;},entra:id=>{
      const i=account.invita(account.sessione('rA'),{email:id+'@amr.invalid'});
      account.accetta(account.sessione(id),{token:i.token});
    }};
}
const risposta=(id='annuncio')=>({risultati:[{id,fonte:'subito',url:'https://www.subito.it/moto/'+id+'.htm'}],
  sources:{subito:{status:'ok',count:1},autoscout:{status:'empty',count:0},moto:{status:'empty',count:0}},totale:1});
const interrotto=async r=>{
  assert.equal(r.status,403);
  const body=await r.json();
  assert.equal(body.interrotto,true);
  assert.equal('risultati' in body,false);
  assert.equal(JSON.stringify(body).includes('annuncio'),false);
};

test('HTTP: identità di prova non accetta ruoli/aziende e modulo negato non crea lavori',async t=>{
  const f=await setup(t), a=await f.login('rA'), b=await f.login('rB');
  assert.equal((await(await f.req('/api/test/me',a)).json()).azienda,'A');
  assert.equal((await f.req('/api/search?tipo=auto&marca=Fiat',b)).status,403);
  assert.equal(f.centro.lavori.size,0);
  assert.equal((await f.req('/api/test/login',null,'POST',{persona:'nonVerificata'})).status,403);
  assert.equal((await f.req('/api/test/login',null,'POST',{azienda:'A'})).status,401);
  assert.equal((await f.req('/api/admin',a)).status,403);
  assert.equal((await f.req('/api/stato',a)).status,403);
  assert.equal((await f.req('/api/admin',await f.login('ownerNoMfa'))).status,403);
  assert.equal((await f.req('/api/admin',await f.login('owner'))).status,200);
});

test('HTTP: revoca durante coda non consegna il lavoro e non mostra annunci',async t=>{
  const f=await setup(t);f.entra('a');const cookie=await f.login('a');
  const pending=f.cerca(cookie);await f.waitJob();
  f.account.revoca(f.account.sessione('rA'),{persona:'a'});
  assert.equal((await f.node('n1','/_nodo/poll?id=n1')).status,204);
  await interrotto(await pending);
  assert.equal(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE stato='interrotto'").get().n,1);
});

test('HTTP: scadenza esatta durante il lavoro elimina tutti gli annunci e non avvia fallback',async t=>{
  const f=await setup(t), cookie=await f.login('rA');
  const pending=f.cerca(cookie), job=await f.poll();
  f.account.configuraAzienda(f.owner,{id:'A',scadenza:f.now(),moduli:['auto','moto'],attiva:true});
  assert.equal((await f.esito(job,risposta())).status,200);
  await interrotto(await pending);
  assert.equal(f.centro.lavori.size,0);
  assert.equal((await f.req('/api/detail?url='+encodeURIComponent(risposta().risultati[0].url),cookie)).status,403);
});

test('HTTP: revoca dopo esito 429 impedisce la richiesta alla fonte alternativa',async t=>{
  const f=await setup(t);f.entra('a');const cookie=await f.login('a');
  const pending=f.cerca(cookie), job=await f.poll();
  f.account.revoca(f.account.sessione('rA'),{persona:'a'});
  assert.equal((await f.esito(job,{...risposta(),sources:{...risposta().sources,
    subito:{status:'error',erroreHttp:429,count:0}}})).status,200);
  await interrotto(await pending);
  assert.equal(f.centro.nodi.get('n2').coda.length,0);
  assert.equal(f.centro.db.prepare('SELECT count(*) n FROM lavori').get().n,1);
});

test('HTTP: prima pagina condivisa sopravvive alla scadenza del primo destinatario',async t=>{
  const f=await setup(t), a=await f.login('rA'), b=await f.login('rB');
  const first=f.cerca(a);await f.waitJob();const second=f.cerca(b);
  for(let n=0;n<100;n++){
    if(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n===1)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n,1);
  f.account.configuraAzienda(f.owner,{id:'A',scadenza:f.now(),moduli:['auto','moto'],attiva:true});
  const job=await f.poll();assert.equal(job.operazione,'ricerca');
  assert.equal((await f.esito(job,risposta())).status,200);
  await interrotto(await first);
  const valid=await second;assert.equal(valid.status,200);
  assert.equal((await valid.json()).risultati[0].id,'annuncio');
  assert.equal(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='ricerca'").get().n,1);
});

test('HTTP: revoca dopo inizio del dettaglio blocca il body e i cataloghi successivi',async t=>{
  const f=await setup(t);f.entra('a');const cookie=await f.login('a');
  const pending=f.cerca(cookie), job=await f.poll();await f.esito(job,risposta());
  const search = await pending; assert.equal(search.status,200);
  const row = (await search.json()).risultati[0];
  const detail=f.req('/api/detail?'+new URLSearchParams({url:row.url,accessoDettagli:row.accessoDettagli}),cookie);
  const detailJob=await f.poll();assert.equal(detailJob.operazione,'dettaglio');
  f.account.revoca(f.account.sessione('rA'),{persona:'a'});
  await f.esito(detailJob,{desc:'annuncio di prova',images:['https://example.invalid/img']});
  await interrotto(await detail);
  assert.equal((await f.req('/api/brands?tipo=moto',cookie)).status,403);
});

test('HTTP: dettaglio oltre 300 risultati resta accessibile solo alla sessione destinataria',async t=>{
  const f=await setup(t), a=await f.login('rA'),b=await f.login('rB');
  const pending=f.cerca(a), job=await f.poll();
  const body=risposta();
  body.risultati=Array.from({length:301},(_,i)=>risposta('s'+i).risultati[0]);
  await f.esito(job,body);
  const row=(await(await pending).json()).risultati[0];
  const query=new URLSearchParams({url:row.url,accessoDettagli:row.accessoDettagli});
  assert.equal((await f.req('/api/detail?'+query,b)).status,403);
  assert.equal(f.centro.lavori.size,0);
  const altered=new URLSearchParams(query);altered.set('url',row.url+'?altro');
  assert.equal((await f.req('/api/detail?'+altered,a)).status,403);
  const detail=f.req('/api/detail?'+query,a), d=await f.poll();
  assert.equal(d.input.url,row.url);
  await f.esito(d,{ok:true,detail:{cilindrata:600}});
  assert.equal((await detail).status,200);
  // Il centro aggiunge l'autorizzazione alla copia per browser, mai alla porzione del nodo.
  assert.equal('accessoDettagli' in body.risultati[0],false);
});

test('HTTP: scadenza durante cataloghi non consegna il risultato già ricevuto dal nodo',async t=>{
  const f=await setup(t), cookie=await f.login('rA');
  const pending=f.req('/api/brands?tipo=moto',cookie), job=await f.poll();
  f.account.configuraAzienda(f.owner,{id:'A',scadenza:f.now(),moduli:['moto'],attiva:true});
  await f.esito(job,{brands:['annuncio']});await interrotto(await pending);
});

test('HTTP: due inviti simultanei all’ultimo posto e accettazione simultanea rispettano la quota',async t=>{
  const f=await setup(t), cookie=await f.login('rA');f.entra('a');
  const rs=await Promise.all(['b','c'].map(id=>f.req('/api/test/account/invita',cookie,'POST',{email:id+'@amr.invalid'})));
  assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
  const idx=rs.findIndex(r=>r.status===200), invited=['b','c'][idx], i=await rs[idx].json();
  const user=await f.login(invited);
  const accepted=await Promise.all([1,2].map(()=>f.req('/api/test/account/accetta',user,'POST',{token:i.token})));
  assert.deepEqual(accepted.map(r=>r.status).sort(),[200,403]);
  assert.equal(f.db.prepare("SELECT count(*) n FROM membri_prova WHERE azienda='A'").get().n,3);
  const tables=f.centro.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  for(const {name} of tables)assert.equal(JSON.stringify(f.centro.db.prepare('SELECT * FROM '+name).all()).includes(i.token),false);
});

test('HTTP: collega non gestisce inviti e referente non si autoassegna il cambio del ruolo',async t=>{
  const f=await setup(t);f.entra('a');const a=await f.login('a'), r=await f.login('rA');
  assert.equal((await f.req('/api/test/account/invita',a,'POST',{email:'c@amr.invalid'})).status,403);
  assert.equal((await f.req('/api/test/account/cambiaReferente',r,'POST',{azienda:'A',persona:'a'})).status,403);
  assert.equal((await f.req('/api/test/account/cambiaReferente',await f.login('owner'),'POST',{azienda:'A',persona:'a'})).status,200);
  assert.equal((await f.req('/api/test/account/invita',r,'POST',{email:'c@amr.invalid'})).status,403);
  assert.equal((await f.req('/api/test/account/invita',a,'POST',{email:'c@amr.invalid'})).status,200);
});

module.exports = { setup, risposta, interrotto };

test('HTTP: PC e telefono condividono il posto, sessioni gestibili solo dal proprietario e revoca in volo',async t=>{
  const f=await setup(t);f.entra('a');
  const pc=await f.login('a'), phone=await f.login('a'), altro=await f.login('rA');
  const own=await(await f.req('/api/test/account/sessioni',pc)).json();
  assert.equal(own.sessioni.length,2);
  assert.equal(JSON.stringify(own).includes(pc.split('=')[1]),false);
  assert.equal(f.db.prepare("SELECT count(*) n FROM membri_prova WHERE azienda='A'").get().n,2);
  const others=await(await f.req('/api/test/account/sessioni',altro)).json();
  assert.equal((await f.req('/api/test/account/revocaSessione',pc,'POST',{id:others.sessioni[0].id})).status,404);
  const pending=f.cerca(phone), job=await f.poll();
  const target=own.sessioni.find(s=>s.id!==require('node:crypto').createHash('sha256').update(pc.split('=')[1]).digest('hex'));
  assert.equal((await f.req('/api/test/account/revocaSessione',pc,'POST',{id:target.id})).status,200);
  await f.esito(job,risposta());await interrotto(await pending);
  assert.equal((await f.req('/api/test/me',phone)).status,401);
  assert.equal((await f.req('/api/test/me',pc)).status,200);
});

test('HTTP: perdita dei dati di autorizzazione non consegna risultati e non autorizza per default',async t=>{
  const f=await setup(t), cookie=await f.login('rA');
  const pending=f.cerca(cookie), job=await f.poll();
  const original=f.account.contesto;
  f.account.contesto=()=>{throw new Error('database temporaneamente non disponibile');};
  await f.esito(job,risposta());
  const r=await pending;assert.equal(r.status,503);
  const body=await r.json();assert.equal('risultati' in body,false);
  assert.equal(f.centro.nodi.get('n2').coda.length,0);
  f.account.contesto=original;
});

test('HTTP: accettazione aggiorna soltanto la sessione corrente senza imporre un nuovo login',async t=>{
  const f=await setup(t), cookie=await f.login('a'), ref=await f.login('rA');
  const invito=await(await f.req('/api/test/account/invita',ref,'POST',{email:'a@amr.invalid'})).json();
  assert.equal((await f.req('/api/test/account/accetta',cookie,'POST',{token:invito.token})).status,200);
  const me=await f.req('/api/test/me',cookie);assert.equal(me.status,200);
  assert.equal((await me.json()).azienda,'A');
});

test('HTTP: entrambi i destinatari condivisi mantengono il nodo nelle pagine successive',async t=>{
  const f=await setup(t), a=await f.login('rA'), b=await f.login('rB');
  const first=f.cerca(a);await f.waitJob();const second=f.cerca(b);
  for(let n=0;n<100;n++){
    if(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n===1)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  const job=await f.poll();await f.esito(job,risposta());
  assert.equal((await first).status,200);assert.equal((await second).status,200);
  // La coda più lunga renderebbe appetibile n2 senza l'affinità della seconda azienda.
  f.centro.nodi.get('n1').coda.push({idLavoro:'soltanto-carico',input:{},operazione:'diagnostica'});
  const page=f.req('/api/search?tipo=moto&marca=Yamaha&modello=MT-07&fetta=1',b);
  await f.waitJob();
  assert.equal(f.centro.nodi.get('n2').coda.length,0);
  f.centro.nodi.get('n1').coda=f.centro.nodi.get('n1').coda.filter(j=>j.idLavoro!=='soltanto-carico');
  const next=await f.poll();assert.equal(next.input.fetta,'1');await f.esito(next,risposta('seconda'));
  assert.equal((await page).status,200);
});

test('HTTP: errore del controllo in coda è indisponibilità, non revoca, e non avvia lavori',async t=>{
  const f=await setup(t), cookie=await f.login('rA');
  const pending=f.cerca(cookie);await f.waitJob();
  f.account.contesto=()=>{throw new Error('SQL segreto di prova non da esporre');};
  assert.equal((await f.node('n1','/_nodo/poll?id=n1')).status,204);
  const r=await pending;assert.equal(r.status,503);
  const body=await r.json();assert.equal(body.error,'autorizzazione_non_disponibile');
  assert.equal('risultati' in body,false);
  assert.equal(JSON.stringify(body).includes('SQL'),false);
});

test('HTTP: destinatario aderente durante failover acquisisce affinità senza job di composizione',async t=>{
  const f=await setup(t), a=await f.login('rA'), b=await f.login('rB');
  const first=f.cerca(a), main=await f.poll();
  await f.esito(main,{...risposta(),sources:{...risposta().sources,subito:{status:'error',erroreHttp:429,count:0}}});
  const alternate=await f.poll('n2');assert.equal(alternate.fonte,'subito');
  const second=f.cerca(b);
  for(let n=0;n<100;n++){
    if(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n===1)break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(f.centro.db.prepare("SELECT count(*) n FROM lavori WHERE operazione='condivisa'").get().n,1);
  await f.esito(alternate,risposta('alternativa'),'n2');
  assert.equal(f.centro.nodi.get('n1').coda.length,0);
  assert.equal((await first).status,200);assert.equal((await second).status,200);
  f.centro.nodi.get('n1').coda.push({idLavoro:'carico',input:{},operazione:'diagnostica'});
  const page=f.req('/api/search?tipo=moto&marca=Yamaha&modello=MT-07&fetta=1&fonti=autoscout',b);
  page.catch(()=>{});await f.waitJob();
  assert.equal(f.centro.nodi.get('n2').coda.length,0);
  f.centro.nodi.get('n1').coda=f.centro.nodi.get('n1').coda.filter(j=>j.idLavoro!=='carico');
  const next=await f.poll();await f.esito(next,risposta('successiva'));assert.equal((await page).status,200);
});
