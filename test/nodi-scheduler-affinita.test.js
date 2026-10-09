'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {creaCentro}=require('../backend/nodi/centro');
const {test}=require('node:test');
const radice=require('node:os').tmpdir();
const manifest={protocollo:1,release:'0'.repeat(40),codice:'a'.repeat(64),cataloghi:'b'.repeat(64)};
const pausa=ms=>new Promise(r=>setTimeout(r,ms));
const attendi=async fn=>{for(let i=0;i<600;i++){if(fn())return;await pausa(5);}throw Error('attesa_sintetica');};
const vuota={risultati:[],totale:0,sources:{subito:{status:'ok',count:0,hasMore:true},
  autoscout:{status:'skipped',count:0},moto:{status:'skipped',count:0}}};
async function fixture(nome,extra={},verificaHook=async()=>{}){
  const directory=fs.mkdtempSync(path.join(radice,nome+'-'));
  const sessions=new Map(['uno','due','admin'].map(persona=>[persona,{persona,azienda:'aziendaA',
    admin:persona==='admin',mfa:persona==='admin',scadenza:Date.now()+3600000}]));
  const c=creaCentro({directory,tokens:{a:'a'.repeat(64),b:'b'.repeat(64),c:'c'.repeat(64)},adminLocale:true,compatibilita:manifest,
    inizializzaAccessi:()=>({sessione:req=>sessions.get(req.headers.cookie),close(){},
      async verifica(s,{admin=false}={}){
        if(!s||admin&&!s.admin)throw Object.assign(Error('no'),{status:403});
        await verificaHook(s);
        return{persona:s.persona,azienda:s.azienda,aziendaValida:true,moduli:['auto','moto']};
      }}),...extra});
  const server=c.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const boots={},seq={},epoche={};
  const req=(route,{body,cookie='uno',id}={})=>fetch(base+route,{method:body===undefined?'GET':'POST',
    headers:{cookie,...(id?{'x-amr-node-id':id,'x-amr-node-token':id.repeat(64),
      ...(boots[id]?{'x-amr-node-boot':boots[id],'x-amr-center-epoch':epoche[id]}:{})}:{}),
      ...(body?{'content-type':'application/json'}:{}),'x-amr-local-admin':'1'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(4000)});
  const hb=async(id,subito=false)=>{
    if(!boots[id]){
      const contesto=await(await req('/_nodo/registrazione',{id})).json();
      const boot=require('node:crypto').randomUUID();
      assert.equal((await req('/_nodo/registrazione',{id,body:{epoca:contesto.epoca,boot,
        precedente:contesto.boot,compatibilita:manifest}})).status,200);
      boots[id]=boot;epoche[id]=contesto.epoca;seq[id]=0;
    }
    return req('/_nodo/heartbeat',{id,body:{id,revisione:manifest.release,compatibilita:manifest,
      sequenza:++seq[id],occupato:false,fonti:{subito:{fermo:subito},autoscout:{fermo:false},moto:{fermo:false}}}});
  };
  const cerca=(q,cookie='uno')=>{const p=req('/api/search?'+q,{cookie});p.catch(()=>{});return p;};
  const poll=id=>req('/_nodo/poll?id='+id,{id});
  const esito=(id,j,body=vuota)=>req('/_nodo/esito',{id,body:{id,idLavoro:j.idLavoro,tentativo:j.tentativo,
    esito:{status:200,body}}});
  return{c,req,hb,cerca,poll,esito,async close(){c.close();server.closeAllConnections();
    await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});}};
}

// Controlli del comportamento atteso: sul codice attuale devono evidenziare i finding.
// Per portarli in test/ basta rendere relativo l'import di creaCentro in alto.
const completa={...vuota,sources:{...vuota.sources,
  subito:{status:'ok',count:0,hasMore:true,mainNextStart:50,recuperoNextStart:null},
  autoscout:{status:'empty',count:0,hasMore:false}}};
const limitata={...completa,sources:{...completa.sources,subito:{status:'error',count:0,erroreHttp:429}}};
const pagina='tipo=auto&marca=Fiat&fetta=1&fonti=subito&subitoMainStart=50&subitoRecuperoStart=-1';
async function primaPagina(f){
  const p=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const j=await(await f.poll('a')).json();await f.esito('a',j,completa);
  const r=await p;assert.equal(r.status,200);return r.json();
}
async function completaPagina(f,p,nodo){
  const j=await(await f.poll(nodo)).json();assert.ok(j.idLavoro);
  assert.equal(j.input.fonti,'subito');assert.equal(j.input.subitoMainStart,'50');
  assert.equal(j.input.subitoRecuperoStart,'-1');assert.equal(j.input.fetta,'1');
  await f.esito(nodo,j,vuota);const r=await p;assert.equal(r.status,200);return r.json();
}
function autorizzazioneBloccata(){
  let prima=true,attende=false,libera;
  const gate=new Promise(r=>{libera=r;});
  return{get attende(){return attende;},libera,
    verifica:()=>{if(prima){prima=false;return{azienda:'aziendaA'};}
      attende=true;return gate.then(()=>({azienda:'aziendaA'}));}};
}

test('S01: ricerca nuova usa B libero mentre A esegue a copertura uguale',async()=>{
 const f=await fixture('busy');try{
  await f.hb('a');await f.hb('b');
  const p1=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const j1=await(await f.poll('a')).json();
  const p2=f.cerca('tipo=auto&marca=Renault','due');await attendi(()=>f.c.lavori.size===2);
  const j2=[...f.c.lavori.values()].find(j=>!j.iniziato);assert.equal(j2.nodoAssegnato,'b');
  await f.esito('b',await(await f.poll('b')).json(),completa);assert.equal((await p2).status,200);
  await f.esito('a',j1,completa);assert.equal((await p1).status,200);
 }finally{await f.close();}
});

test('S01: scelte concorrenti prima dei permessi sono rivalutate prima della coda',async()=>{
 const f=await fixture('race'),v1=autorizzazioneBloccata(),v2=autorizzazioneBloccata();try{
  await f.hb('a');await f.hb('b');
  const p1=f.c.ricerca('aziendaA',{tipo:'auto',marca:'Fiat'},v1.verifica);p1.catch(()=>{});
  await attendi(()=>v1.attende);
  const p2=f.c.ricerca('aziendaA',{tipo:'auto',marca:'Renault'},v2.verifica);p2.catch(()=>{});
  await attendi(()=>v2.attende);assert.equal(f.c.lavori.size,0);
  v1.libera();await attendi(()=>f.c.lavori.size===1);
  v2.libera();await attendi(()=>f.c.lavori.size===2);
  assert.deepEqual([...f.c.lavori.values()].map(j=>j.nodoAssegnato).sort(),['a','b']);
  for(const id of ['a','b'])await f.esito(id,await(await f.poll(id)).json(),completa);
  assert.equal((await p1).status,200);assert.equal((await p2).status,200);
 }finally{v1.libera();v2.libera();await f.close();}
});

for(const manuale of [false,true])test('S02: pagina e cursori passano a B con fonte A in pausa '+(manuale?'manuale':'automatica'),async()=>{
 const f=await fixture('fonte-pausa');try{
  await f.hb('a');await f.hb('b');await primaPagina(f);
  if(manuale)assert.equal((await f.req('/api/admin/nodi/a',{cookie:'admin',body:{sospeso:true,fonte:'subito'}})).status,200);
  else await f.hb('a',true);
  const p=f.cerca(pagina);
  const r=await Promise.race([p,attendi(()=>f.c.lavori.size===1).then(()=>null)]);
  assert.equal(r?.status??200,200); // Fallisce subito se la rotta risponde 503.
  const j=[...f.c.lavori.values()][0];assert.equal(j.nodoAssegnato,'b');
  const data=await completaPagina(f,p,'b');assert.ok(data.avvisiNodi.some(x=>x.includes('altro nodo')));
 }finally{await f.close();}
});

for(const tornaSoloA of [false,true])test('S03: esecutore principale riassegnato guida '+(tornaSoloA?'avviso':'affinita'),async()=>{
 let clock=Date.now();const f=await fixture('main-owner',{ora:()=>clock});try{
  await f.hb('a');await f.hb('b');
  const p=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const j=[...f.c.lavori.values()][0];clock+=7001;await f.hb('b');
  await attendi(()=>j.nodoAssegnato==='b');assert.equal(j.iniziato,false);
  const jb=await(await f.poll('b')).json();
  assert.equal((await f.req('/_nodo/esito',{id:'b',body:{id:'b',idLavoro:jb.idLavoro,tentativo:jb.tentativo,
    esito:{status:200,body:completa,nodoEsecutore:'a'}}})).status,200);
  const r=await p;assert.equal(r.status,200);assert.equal(Object.hasOwn(await r.json(),'nodoEsecutore'),false);
  if(tornaSoloA)clock+=7001;
  await f.hb('a');const seconda=f.cerca(pagina);await attendi(()=>f.c.lavori.size===1);
  const owner=tornaSoloA?'a':'b';assert.equal([...f.c.lavori.values()][0].nodoAssegnato,owner);
  const data=await completaPagina(f,seconda,owner);
  assert.equal(data.avvisiNodi.some(x=>x.includes('altro nodo')),tornaSoloA);
 }finally{await f.close();}
});

test('S03: 429 esclude B esecutore effettivo anche se il primario scelto era A',async()=>{
 let clock=Date.now();const f=await fixture('exclude-main',{ora:()=>clock});try{
  for(const id of ['a','b','c'])await f.hb(id);
  const p=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const j=[...f.c.lavori.values()][0];clock+=7001;await f.hb('b');await f.hb('c');
  await attendi(()=>j.nodoAssegnato==='b');await f.esito('b',await(await f.poll('b')).json(),limitata);
  await attendi(()=>f.c.lavori.size===1&&[...f.c.lavori.values()][0].operazione==='fonte');
  assert.equal([...f.c.lavori.values()][0].nodoAssegnato,'c');
  await f.esito('c',await(await f.poll('c')).json(),vuota);assert.equal((await p).status,200);
 }finally{await f.close();}
});

test('S03: porzione alternativa riassegnata conserva esclusione e aggiorna affinity dal suo esecutore',async()=>{
 let clock=Date.now();const f=await fixture('alt-owner',{ora:()=>clock});try{
  for(const id of ['a','b','c'])await f.hb(id);
  const p=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  await f.esito('a',await(await f.poll('a')).json(),limitata);
  await attendi(()=>f.c.lavori.size===1&&[...f.c.lavori.values()][0].operazione==='fonte');
  const alt=[...f.c.lavori.values()][0];assert.equal(alt.nodoAssegnato,'b');
  clock+=7001;await f.hb('a');await f.hb('c');
  await attendi(()=>alt.nodoAssegnato!=='b');assert.equal(alt.nodoAssegnato,'c');
  await f.esito('c',await(await f.poll('c')).json(),vuota);assert.equal((await p).status,200);
  await f.hb('b');const seconda=f.cerca(pagina);await attendi(()=>f.c.lavori.size===1);
  assert.equal([...f.c.lavori.values()][0].nodoAssegnato,'c');
  const data=await completaPagina(f,seconda,'c');assert.deepEqual(data.avvisiNodi,[]);
 }finally{await f.close();}
});

test('controprova: pagina resta sul suo nodo sano anche occupato e con B libero',async()=>{
 const f=await fixture('affinity-busy');try{
  await f.hb('a');await f.hb('b');await primaPagina(f);
  const altra=f.cerca('tipo=auto&marca=Renault');await attendi(()=>f.c.lavori.size===1);
  const j=await(await f.poll('a')).json();
  const p=f.cerca(pagina,'due');await attendi(()=>f.c.lavori.size===2);
  assert.equal([...f.c.lavori.values()].find(x=>!x.iniziato).nodoAssegnato,'a');
  assert.equal((await f.poll('b')).status,204);
  await f.esito('a',j,completa);assert.equal((await altra).status,200);
  assert.deepEqual((await completaPagina(f,p,'a')).avvisiNodi,[]);
 }finally{await f.close();}
});

test('S01: menu usa il nodo libero e lascia eseguire la ricerca occupata',async()=>{
 const f=await fixture('menu-load');try{
  await f.hb('a');await f.hb('b');
  const ricerca=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const j=await(await f.poll('a')).json();const menu=f.req('/api/brands?tipo=auto');menu.catch(()=>{});
  await attendi(()=>f.c.lavori.size===2);
  assert.equal([...f.c.lavori.values()].find(x=>x.operazione==='marche').nodoAssegnato,'b');
  await f.esito('b',await(await f.poll('b')).json(),{brands:[]});assert.equal((await menu).status,200);
  await f.esito('a',j,completa);assert.equal((await ricerca).status,200);
 }finally{await f.close();}
});

for(const durantePermessi of [false,true])test('S02: owner torna '+(durantePermessi?'durante i permessi':'prima della pagina')+' e la composizione conserva fonti e cursori',async()=>{
 let clock=Date.now(),armata=false,chiamate=0,entrata=false,libera;
 const gate=new Promise(r=>{libera=r;});
 const f=await fixture('owner-return',{ora:()=>clock},async s=>{
  if(armata&&s.persona==='uno'&&++chiamate===3){entrata=true;await gate;}
 });
 const sospendi=(id,fonte,sospeso)=>f.req('/api/admin/nodi/'+id,{cookie:'admin',body:{fonte,sospeso}});
 const as={...vuota,risultati:[{fonte:'autoscout',id:'fixture-as',url:'https://www.autoscout24.it/annunci/fixture-sintetica'}],totale:1,
  sources:{...vuota.sources,subito:{status:'skipped',count:0},autoscout:{status:'ok',count:1,hasMore:true}}};
 try{
  await f.hb('a');await f.hb('b');
  assert.equal((await sospendi('a','autoscout',true)).status,200);
  assert.equal((await sospendi('b','subito',true)).status,200);
  const prima=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const ja=await(await f.poll('a')).json();assert.equal(ja.input.fonti,'subito');await f.esito('a',ja,vuota);
  await attendi(()=>f.c.lavori.size===1);
  const jb=await(await f.poll('b')).json();assert.equal(jb.fonte,'autoscout');await f.esito('b',jb,as);
  assert.equal((await prima).status,200);
  await sospendi('b','subito',false);clock+=7001;await f.hb('b');
  if(!durantePermessi)await f.hb('a');
  armata=durantePermessi;
  const p=f.cerca('tipo=auto&marca=Fiat&fetta=1&fonti=subito,autoscout&subitoMainStart=50&subitoRecuperoStart=-1');
  if(durantePermessi){await attendi(()=>entrata);assert.equal(f.c.lavori.size,0);await f.hb('a');libera();}
  const anticipata=await Promise.race([p,attendi(()=>f.c.lavori.size===1).then(()=>null)]);
  assert.equal(anticipata?.status??200,200);
  const pa=await(await f.poll('a')).json();assert.equal(pa.input.fonti,'subito');
  assert.equal(pa.input.subitoMainStart,'50');assert.equal(pa.input.subitoRecuperoStart,'-1');
  await f.esito('a',pa,vuota);await attendi(()=>f.c.lavori.size===1);
  const pb=await(await f.poll('b')).json();assert.equal(pb.fonte,'autoscout');assert.equal(pb.input.fetta,'1');
  await f.esito('b',pb,as);const r=await p;assert.equal(r.status,200);
  assert.equal((await r.json()).risultati.length,1);
 }finally{libera();await f.close();}
});

for(const caso of ['nessun-nodo','timeout-fonte','429-pausa','http-429','parziale-con-righe',
  'settlement-in-coda','settlement-incerto','completa'])test('R1: fonte omessa recuperabile dopo '+caso,async()=>{
 // Lo stesso timeout vale per il lavoro principale, che deve ricevere l'esito in tempo,
 // e per quello alternativo, che nei casi settlement deve scadere: 300 ms non bastavano
 // al lavoro principale su una CI carica.
 const f=await fixture('fonte-omessa',{timeoutMs:1500});
 const riga=(fonte,id)=>({fonte,id,url:'https://www.'+(fonte==='subito'?'subito.it':'autoscout24.it')+'/annunci/'+id});
 const omessa={status:'skipped',reason:'fonte esaurita nelle pagine precedenti',count:0,hasMore:false};
 const principale={...completa,risultati:[riga('autoscout','principale')],totale:1,
  subitoStatus:'skipped',subitoReason:omessa.reason,
  sources:{...completa.sources,subito:omessa,autoscout:{status:'ok',count:1,hasMore:false}}};
 try{
  await f.hb('a',true);
  if(caso!=='nessun-nodo'){
   await f.hb('b');
   assert.equal((await f.req('/api/admin/nodi/b',{cookie:'admin',body:{sospeso:true,fonte:'autoscout'}})).status,200);
  }
  const p=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const ja=await(await f.poll('a')).json();assert.equal(ja.input.fonti,'autoscout');
  assert.equal((await f.esito('a',ja,principale)).status,200);
  let statoAlternativo;
  if(caso!=='nessun-nodo'){
   await attendi(()=>f.c.lavori.size===1&&[...f.c.lavori.values()][0].operazione==='fonte');
   assert.equal([...f.c.lavori.values()][0].nodoAssegnato,'b');
   if(caso!=='settlement-in-coda'){
    const jb=await(await f.poll('b')).json();assert.equal(jb.fonte,'subito');
    if(caso!=='settlement-incerto'){
     statoAlternativo=caso==='429-pausa'?{status:'error',reason:'limite fonte',erroreHttp:429,
      pausa:{fermo:true,fino:Date.now()+60000,motivo:'429'},incerto:true}
      :caso==='timeout-fonte'?{status:'timeout',reason:'timeout fonte'}
      :{status:'ok',count:1,hasMore:true,mainNextStart:50,recuperoNextStart:0,
       ...(caso==='parziale-con-righe'?{parzialeRete:true,reason:'risposta incompleta',errori:[{fase:'recupero'}]}:{})};
     const risposta={...completa,risultati:['completa','parziale-con-righe'].includes(caso)?[riga('subito','alternativa')]:[],
      sources:{...completa.sources,subito:statoAlternativo}};
     if(caso==='http-429')assert.equal((await f.req('/_nodo/esito',{id:'b',body:{id:'b',idLavoro:jb.idLavoro,
      tentativo:jb.tentativo,esito:{status:429,body:{error:'nodo limitato',incerto:true}}}})).status,200);
     else assert.equal((await f.esito('b',jb,risposta)).status,200);
    }
   }
  }
  const r=await p;assert.equal(r.status,200);const data=await r.json(),stato=data.sources.subito;
  assert.deepEqual(data.sources.autoscout,principale.sources.autoscout);
  if(caso==='completa'){
   assert.deepEqual(stato,statoAlternativo);
   assert.deepEqual(data.risultati.map(r=>r.id),['alternativa','principale']);
   assert.equal(data.subitoStatus,'ok');assert.deepEqual(data.avvisiNodi,[]);
  }else{
   assert.equal(stato.status,caso==='timeout-fonte'?'timeout':'error');
   assert.notEqual(stato.reason,omessa.reason);assert.equal(stato.count,0);assert.equal(stato.hasMore,null);
   assert.deepEqual(data.risultati.map(r=>r.id),['principale']);
   assert.equal(data.subitoStatus,stato.status);assert.equal(data.subitoReason,stato.reason);
   // Il caller UI riconosce error/timeout senza avanzare dai cursori della porzione non consegnata.
   for(const campo of ['mainNextStart','recuperoNextStart','errori'])assert.equal(Object.hasOwn(stato,campo),false);
   if(['429-pausa','http-429'].includes(caso)){assert.equal(stato.erroreHttp,429);assert.equal(stato.incerto,true);}
   if(caso==='429-pausa')assert.deepEqual(stato.pausa,statoAlternativo.pausa);
   if(caso==='settlement-incerto')assert.equal(stato.incerto,true);
   if(caso==='settlement-in-coda')assert.equal(stato.interrotto,true);
  }
  assert.deepEqual(principale.sources.subito,omessa);
 }finally{await f.close();}
});

test('R1 controprova: alternativa fallita conserva la porzione primaria con righe e 429',async()=>{
 const f=await fixture('primaria-parziale');try{
  await f.hb('a');await f.hb('b');
  const p=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  const stato={status:'ok',count:1,erroreHttp:429,parzialeRete:true,mainNextStart:50,
   pausa:{fermo:true,fino:Date.now()+60000,motivo:'429'}};
  const body={...completa,risultati:[{fonte:'subito',id:'primaria',url:'https://www.subito.it/annunci/primaria'}],totale:1,
   sources:{...completa.sources,subito:stato}};
  await f.esito('a',await(await f.poll('a')).json(),body);
  await attendi(()=>f.c.lavori.size===1&&[...f.c.lavori.values()][0].operazione==='fonte');
  await f.esito('b',await(await f.poll('b')).json(),{...completa,sources:{...completa.sources,subito:{status:'timeout'}}});
  const r=await p;assert.equal(r.status,200);const data=await r.json();
  assert.deepEqual(data.sources.subito,stato);assert.deepEqual(data.risultati.map(r=>r.id),['primaria']);
 }finally{await f.close();}
});

test('R2: retry esplicito pagina zero resta sull owner sano occupato; nuova ricerca usa B libero',async()=>{
 const f=await fixture('retry-zero');try{
  await f.hb('a');await f.hb('b');
  const prima=f.cerca('tipo=auto&marca=Fiat');await attendi(()=>f.c.lavori.size===1);
  await f.esito('a',await(await f.poll('a')).json(),{...completa,
   sources:{...completa.sources,autoscout:{status:'error',reason:'temporaneo'}}});assert.equal((await prima).status,200);
  const occupata=f.cerca('tipo=auto&marca=Renault');await attendi(()=>f.c.lavori.size===1);
  const ja=await(await f.poll('a')).json();
  const retry=f.cerca('tipo=auto&marca=Fiat&fetta=0&fonti=autoscout','due');await attendi(()=>f.c.lavori.size===2);
  assert.equal([...f.c.lavori.values()].find(j=>!j.iniziato).nodoAssegnato,'a');
  const nuova=f.cerca('tipo=auto&marca=Citroen','due');await attendi(()=>f.c.lavori.size===3);
  assert.equal([...f.c.lavori.values()].find(j=>j.input.marca==='Citroen').nodoAssegnato,'b');
  await f.esito('b',await(await f.poll('b')).json(),completa);assert.equal((await nuova).status,200);
  await f.esito('a',ja,completa);assert.equal((await occupata).status,200);
  const jr=await(await f.poll('a')).json();assert.equal(jr.input.fetta,'0');assert.equal(jr.input.fonti,'autoscout');
  await f.esito('a',jr,completa);const r=await retry;assert.equal(r.status,200);assert.deepEqual((await r.json()).avvisiNodi,[]);
 }finally{await f.close();}
});

test('R2 controprova: retry pagina zero passa a B se la fonte dell owner è in pausa',async()=>{
 const f=await fixture('retry-zero-pausa');try{
  await f.hb('a');await f.hb('b');await primaPagina(f);await f.hb('a',true);
  const p=f.cerca('tipo=auto&marca=Fiat&fetta=0&fonti=subito');await attendi(()=>f.c.lavori.size===1);
  assert.equal([...f.c.lavori.values()][0].nodoAssegnato,'b');
  await f.esito('b',await(await f.poll('b')).json(),vuota);const r=await p;assert.equal(r.status,200);
  assert.ok((await r.json()).avvisiNodi.some(x=>x.includes('altro nodo')));
 }finally{await f.close();}
});
