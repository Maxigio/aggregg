'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { creaCentro } = require('../backend/nodi/centro');
const { mount } = require('../backend/nodi/login-nhost-prova');
const { creaAccessiPostgres } = require('../backend/nodi/accessi-postgres-prova');
const pausa = ms => new Promise(r => setTimeout(r, ms));

async function setup(t, timeoutMs = 2000, maxPersona = 2) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-accessi-async-'));
  const server = require('node:http').createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origine = 'http://127.0.0.1:' + server.address().port;
  const persona = '00000000-0000-4000-8000-000000000001';
  let gate = null, offline = false, ruolo = { attiva:true, admin:false, epoca:0, azienda:'A', aziendaValida:true, moduli:['moto'] };
  const identita = async () => {
    const value = structuredClone(ruolo);
    if (gate) { const g=gate; gate=null; g.entrata(); await g.attesa; }
    if (offline) throw Object.assign(new Error('database_non_disponibile'), {status:503});
    return value;
  };
  const centro = creaCentro({ directory:dir, tokens:{n1:'1'.repeat(64)}, timeoutMs, maxPersona, adminLocale:true,
    inizializzaAccessi: app => mount(app,{ origine, identita, cookiePath:'/', client:{
      login:async()=>({session:{user:{id:persona,emailVerified:true},accessToken:'sintetico',refreshToken:'sintetico'}}),
      logout:async()=>{},
    } }) });
  server.on('request',centro.app);
  t.after(async()=>{centro.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  const req=(route, cookie, method='GET', body)=>fetch(origine+route,{method,
    headers:{...(cookie?{cookie}:{}),...(body?{origin:origine,'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  const bootstrap=await req('/api/auth/bootstrap',undefined,'POST',{login:true});assert.equal(bootstrap.status,200);
  const contesto=bootstrap.headers.getSetCookie().find(v=>v.startsWith('amr_accesso_prova=')).split(';')[0];
  const preparata=await req('/api/auth/login',contesto,'POST',{email:'test@amr.invalid',password:'sintetica-locale',tentativo:(await bootstrap.json()).tentativo});
  assert.equal(preparata.status,200);
  const login=await require('./nodi-auth-finalizza.cjs').finalizza(preparata,
    conferma=>req('/api/auth/finalizza',contesto,'POST',{conferma}));
  assert.equal(login.status,200);
  const cookie=contesto+'; '+login.headers.getSetCookie().find(v=>v.startsWith('amr_sessione_prova=')).split(';')[0];
  const node=(route,method='GET',body)=>fetch(origine+route,{method,headers:{'x-amr-node-id':'n1','x-amr-node-token':'1'.repeat(64),
    ...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify({id:'n1',...body})}:{})});
  await node('/_nodo/heartbeat','POST',{revisione:'imac-1',occupato:false,fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}});
  const cerca=marca=>req('/api/search?tipo=moto&marca='+marca,cookie);
  const attendiCoda=async count=>{for(let i=0;i<200&&centro.nodi.get('n1').coda.length!==count;i++)await pausa(5);assert.equal(centro.nodi.get('n1').coda.length,count);};
  return {centro,req,cookie,node,cerca,attendiCoda,ruolo,offline:()=>{offline=true;},
    ritarda:()=>{let libera,entrata;const dentro=new Promise(r=>{entrata=r;});const attesa=new Promise(r=>{libera=r;});gate={entrata,attesa};return{dentro,libera};}};
}

test('permessi asincroni: due poll concorrenti non consegnano due volte; sospensione durante attesa prevale',async t=>{
  const f=await setup(t), ricerca=f.cerca('Yamaha');await f.attendiCoda(1);
  const g=f.ritarda(), primo=f.node('/_nodo/poll?id=n1');await g.dentro;
  assert.equal((await f.node('/_nodo/poll?id=n1')).status,204);
  // Stato cambiato dall'amministrazione durante la lettura asincrona.
  f.centro.nodi.get('n1').sospeso=true;g.libera();assert.equal((await primo).status,204);
  assert.equal(f.centro.nodi.get('n1').coda.length,1);
  assert.equal(f.centro.nodi.get('n1').occupato,false);
  assert.equal((await ricerca).status,503);
});

test('permessi asincroni: timeout durante il poll non consegna un lavoro già eliminato',async t=>{
  const f=await setup(t,150), ricerca=f.cerca('Honda');await f.attendiCoda(1);
  const g=f.ritarda(), poll=f.node('/_nodo/poll?id=n1');await g.dentro;
  assert.equal((await ricerca).status,503);g.libera();assert.equal((await poll).status,204);
  assert.equal(f.centro.lavori.size,0);assert.equal(f.centro.nodi.get('n1').occupato,false);
});

test('coda piena: il limite di ammissione non impedisce di consegnare i dieci lavori accodati',async t=>{
  const f=await setup(t,600,10), pendenti=[];
  for(let i=0;i<10;i++){pendenti.push(f.cerca('Marca'+i));await f.attendiCoda(i+1);}
  const r=await f.node('/_nodo/poll?id=n1');assert.equal(r.status,200);
  assert.equal(f.centro.nodi.get('n1').coda.length,9);
  await Promise.all(pendenti);
});

test('permessi: database indisponibile e revoca epoca negano accesso senza creare lavori',async t=>{
  const f=await setup(t);f.ruolo.epoca++;
  assert.equal((await f.cerca('Fiat')).status,403);assert.equal(f.centro.lavori.size,0);
  f.offline();assert.equal((await f.cerca('Fiat')).status,503);assert.equal(f.centro.lavori.size,0);
});

test('lettore PostgreSQL: UUID parametrizzato, dati limitati, errori SQL non esposti',async()=>{
  let args;const lookup=creaAccessiPostgres({pool:{query:async(...x)=>{args=x;return{rows:[{attiva:true,admin:false,epoca:2,azienda:'A',azienda_valida:true,moduli:['moto'],password_hash:'non_esporre'}]};}}});
  assert.equal(await lookup("' OR true --"),null);
  const id='00000000-0000-4000-8000-000000000001';const r=await lookup(id);
  assert.deepEqual(args,['SELECT * FROM amr_accessi.identita($1::uuid)',[id]]);assert.ok(!('password_hash' in r));
  const down=creaAccessiPostgres({pool:{query:async()=>{throw new Error('segreto');}}});
  await assert.rejects(down(id),e=>e.status===503&&!e.message.includes('segreto'));
});


test('arresto durante controllo asincrono: nessun nuovo lavoro e poll chiuso senza record residui',async t=>{
  const f=await setup(t), ricerca=f.cerca('Suzuki');await f.attendiCoda(1);
  const g=f.ritarda(), poll=f.node('/_nodo/poll?id=n1');await g.dentro;
  f.centro.close();assert.equal((await ricerca).status,503);g.libera();
  assert.equal((await poll).status,503);assert.equal(f.centro.lavori.size,0);
  assert.equal(f.centro.nodi.get('n1').coda.length,0);
});


test('lettore PostgreSQL: il pool non accumula una coda illimitata di controlli',async()=>{
  const releases=[];const lookup=creaAccessiPostgres({pool:{query:()=>new Promise(r=>releases.push(r))}});
  const id='00000000-0000-4000-8000-000000000001';
  const pendenti=Array.from({length:32},()=>lookup(id));
  await assert.rejects(lookup(id),e=>e.status===503);assert.equal(releases.length,32);
  for(const r of releases)r({rows:[]});await Promise.all(pendenti);
  const dopo=lookup(id);releases[32]({rows:[]});assert.equal(await dopo,null);
});
