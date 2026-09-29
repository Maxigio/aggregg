'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { creaCentro } = require('../backend/nodi/centro');
const { componiRicerca } = require('../backend/nodi/componi-ricerca');

test('centro locale: autenticazione dei nodi, isolamento dei moduli e failover di una sola fonte', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-centro-'));
  const tokens = { a: 'a'.repeat(64), b: 'b'.repeat(64) };
  const centro = creaCentro({ tokens, directory: dir });
  const server = await new Promise(resolve => {
    const s = centro.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const node = (id, method, route, body, tok = tokens[id]) => fetch(url + route, {
    method, headers: { 'x-amr-node-token': tok, 'x-amr-node-id': id,
      ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify({ id, ...body }) } : {}),
  });
  const heartbeat = id => node(id, 'POST', '/_nodo/heartbeat', { revisione: 'imac-1',
    fonti: Object.fromEntries(['subito','autoscout','moto'].map(f => [f, { fermo: false }])),
    occupato: false, simulato: id === 'b' });
  const poll = async id => {
    for (let i = 0; i < 50; i++) {
      const r = await node(id, 'GET', `/_nodo/poll?id=${id}`);
      if (r.status === 200) return r.json();
      assert.equal(r.status, 204);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('lavoro non consegnato');
  };
  const esito = (id, lavoro, body) => node(id, 'POST', '/_nodo/esito', {
    idLavoro: lavoro.idLavoro, tentativo: lavoro.tentativo, esito: { status: 200, body },
  });
  const completaSulPrincipale = async () => {
    const lavoro = await poll('a');
    assert.equal(lavoro.operazione,'componi');
    assert.equal((await esito('a', lavoro,
      componiRicerca(lavoro.input.principale, lavoro.input.sostituzioni))).status,200);
  };
  try {
    assert.equal((await node('a','POST','/_nodo/heartbeat',{ revisione:'imac-1',fonti:{} }, tokens.b)).status,401);
    assert.equal((await fetch(url+'/_nodo/heartbeat',{method:'POST',
      headers:{'x-amr-node-id':'a','x-amr-node-token':tokens.a,'content-type':'application/json'},
      body:JSON.stringify({id:'b',revisione:'imac-1',fonti:{}})})).status,403);
    assert.equal((await heartbeat('a')).status,200);
    assert.equal((await heartbeat('b')).status,200);
    const statoPubblico = await (await fetch(url + '/api/stato')).json();
    assert.equal(statoPubblico.nodi.length, 2);
    assert.equal(statoPubblico.lavori.every(x => !Object.hasOwn(x, 'filtri')), true);
    assert.equal((await fetch(url + '/api/admin')).status, 401);
    assert.equal((await fetch(url + '/prototipo.js')).status, 200);
    assert.equal((await fetch(url + '/prototipo.css')).status, 200);
    assert.equal((await fetch(url+'/api/test/login',{method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({azienda:'__proto__'})})).status,400);
    const login = await fetch(url + '/api/test/login', { method:'POST',
      headers:{ 'content-type':'application/json' }, body:JSON.stringify({azienda:'aziendaB'}) });
    assert.equal(login.status,200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.deepEqual((await (await fetch(url + '/api/test/me', {headers:{cookie}})).json()).moduli, ['moto']);
    const filtri = await (await fetch(url + '/api/filtri', {headers:{cookie}})).json();
    assert.equal(filtri.regioni.includes('lombardia'), true);
    assert.equal(filtri.filtriAuto.length > 0, true);
    assert.equal((await fetch(url + '/api/search?tipo=moto&marca=Yamaha&marca=Honda',
      { headers: { cookie } })).status, 400);
    const loginOperatore = await fetch(url + '/api/test/login', { method:'POST',
      headers:{'content-type':'application/json'},body:JSON.stringify({azienda:'operatore'}) });
    const cookieOperatore = loginOperatore.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(url + '/api/admin',{headers:{cookie}})).status,403);
    assert.equal((await fetch(url + '/api/search?tipo=auto&marca=Fiat', {headers:{cookie}})).status,403);
    const rottaGuasta = fetch(url + '/api/search?tipo=moto&marca=Guasto', {headers:{cookie}});
    const lavoroGuasto = await poll('a');
    assert.equal((await esito('a', lavoroGuasto, {error:'body inatteso'})).status,200);
    assert.equal((await rottaGuasta).status,502);
    const richiesta = fetch(url + '/api/search?tipo=moto&marca=Yamaha&modello=MT-07', {headers:{cookie}});
    const prima = await poll('a');
    assert.equal(prima.azienda,'aziendaB');
    assert.equal(prima.operazione,'ricerca');
    const base = { risultati:[{fonte:'autoscout',id:'a1'}], totale:1,
      sources:{ subito:{status:'error',erroreHttp:429,count:0},
        autoscout:{status:'ok',count:1}, moto:{status:'empty',count:0} },
      versioneConto:null,versionePerFonte:null };
    assert.equal((await esito('a',prima,base)).status,200);
    const seconda = await poll('b');
    assert.equal(seconda.operazione,'fonte');
    assert.equal(seconda.fonte,'subito');
    assert.equal(seconda.input.modello,'MT-07');
    const sostituta = { risultati:[{fonte:'subito',id:'s1'}],totale:1,
      sources:{subito:{status:'ok',count:1}},versioneConto:null,versionePerFonte:null };
    assert.equal((await esito('b',seconda,sostituta)).status,200);
    await completaSulPrincipale();
    const r = await richiesta, body = await r.json();
    assert.equal(r.status,200);
    assert.deepEqual(body.risultati.map(x=>x.id),['s1','a1']);
    assert.equal(body.sources.subito.status,'ok');
    assert.equal(body.sources.autoscout.status,'ok');
    const eventi = (await (await fetch(url + '/api/admin',{headers:{cookie:cookieOperatore}})).json()).eventi;
    assert.equal(eventi.some(e => e.codice === 'fonte_limitata' && e.fonte === 'subito' && e.http === 429), true);
    const admin = await (await fetch(url + '/api/admin',{headers:{cookie:cookieOperatore}})).json();
    assert.equal(admin.lavori.length,4);
    assert.equal(admin.lavori.every(x=>x.azienda==='aziendaB'),true);
    assert.equal(admin.lavori.every(x => !Object.hasOwn(x, 'risultati') && !Object.hasOwn(x.filtri, 'risultati')),true);
    const pubblici = await (await fetch(url + '/api/stato')).json();
    assert.equal(pubblici.lavori.every(x => !Object.hasOwn(x, 'filtri')), true);
    assert.equal(pubblici.lavori.find(x => x.id === prima.idLavoro).nodo, 'a');
    assert.deepEqual(admin.lavori.find(x=>x.operazione==='componi').filtri,{fonti:['subito']});
    assert.equal((await node('a','POST','/_nodo/esito',{idLavoro:prima.idLavoro,tentativo:1,esito:{status:200,body:base}})).status,409);

    const pagina = fetch(url + '/api/search?tipo=moto&marca=Yamaha&modello=MT-07&fetta=1&fonti=subito,autoscout',
      {headers:{cookie}});
    const principalePagina = await poll('a');
    assert.equal(principalePagina.input.fonti,'autoscout');
    assert.equal((await esito('a',principalePagina,{ ...base,
      sources:{subito:{status:'skipped',reason:'fonte esaurita nelle pagine precedenti'},
        autoscout:{status:'ok',count:1},moto:{status:'skipped'} } })).status,200);
    const subitoPagina = await poll('b');
    assert.equal(subitoPagina.fonte,'subito');
    assert.equal((await esito('b',subitoPagina,{risultati:[{fonte:'subito',id:'s2'}],
      sources:{subito:{status:'ok',count:1}},versioneConto:null,versionePerFonte:null})).status,200);
    await completaSulPrincipale();
    assert.equal((await pagina).status,200);
    assert.equal((await fetch(url + '/api/admin/nodi/b', { method:'POST',
      headers:{cookie:cookieOperatore,'content-type':'application/json'},body:JSON.stringify({sospeso:true}) })).status,200);
    const paginaRiassegnata = fetch(url + '/api/search?tipo=moto&marca=Yamaha&modello=MT-07&fetta=2&fonti=subito,autoscout',
      {headers:{cookie}});
    const nuovoNodo = await poll('a');
    assert.equal(nuovoNodo.input.fonti,'subito,autoscout');
    assert.equal((await esito('a',nuovoNodo,{...rispostaDaPagina(),
      risultati:[{fonte:'subito',id:'s3'}]})).status,200);
    const riassegnata = await (await paginaRiassegnata).json();
    assert.equal(riassegnata.avvisiNodi.some(x=>x.includes('copertura può cambiare')),true);
    assert.equal((await fetch(url + '/api/admin/nodi/b', { method:'POST',
      headers:{cookie:cookieOperatore,'content-type':'application/json'},body:JSON.stringify({sospeso:false}) })).status,200);

    const loginA = await fetch(url + '/api/test/login', { method:'POST',
      headers:{ 'content-type':'application/json' }, body:JSON.stringify({azienda:'aziendaA'}) });
    const cookieA = loginA.headers.get('set-cookie').split(';')[0];
    const identica = '/api/search?tipo=moto&marca=Yamaha&modello=MT-07&versione=Base';
    const richiestaA = fetch(url + identica, { headers:{cookie:cookieA} });
    const richiestaB = fetch(url + identica, { headers:{cookie} });
    const unica = await poll('a');
    assert.equal((await node('b','GET','/_nodo/poll?id=b')).status,204);
    const risposta = { ...base, sources: { subito:{status:'empty',count:0},
      autoscout:{status:'ok',count:1}, moto:{status:'empty',count:0} } };
    assert.equal((await esito('a',unica,risposta)).status,200);
    assert.equal((await richiestaA).status,200);
    assert.equal((await richiestaB).status,200);
    const condivisi = await (await fetch(url + '/api/admin',{headers:{cookie:cookieOperatore}})).json();
    assert.equal(condivisi.lavori.filter(x=>x.operazione==='condivisa').length,1);
    const retry = fetch(url + '/api/search?tipo=moto&marca=Yamaha&modello=MT-07&fetta=0&fonti=subito',
      {headers:{cookie}});
    const retryJob = await poll('a');
    assert.equal(retryJob.input.fonti,'subito');
    assert.equal((await node('b','GET','/_nodo/poll?id=b')).status,204);
    assert.equal((await esito('a',retryJob,{risultati:[{fonte:'subito',id:'solo'}],totale:1,
      sources:{subito:{status:'ok',count:1},autoscout:{status:'skipped'},moto:{status:'skipped'}},
      versioneConto:null,versionePerFonte:null})).status,200);
    assert.equal((await retry).status,200);

    const diversaA=fetch(url+'/api/search?tipo=moto&marca=Yamaha&modello=MT-07&versione=R',
      {headers:{cookie:cookieA}});
    const diversaB=fetch(url+'/api/search?tipo=moto&marca=Yamaha&modello=MT-07&versione=S',
      {headers:{cookie}});
    const primoDiverso=await poll('a');
    assert.equal((await esito('a',primoDiverso,rispostaDaPagina())).status,200);
    const secondoDiverso=await poll('a');
    assert.notEqual(primoDiverso.input.versione,secondoDiverso.input.versione);
    assert.equal((await esito('a',secondoDiverso,rispostaDaPagina())).status,200);
    assert.equal((await diversaA).status,200);
    assert.equal((await diversaB).status,200);
    assert.equal((await fetch(url + '/api/detail?url=https%3A%2F%2Fwww.subito.it%2Fauto%2Fmai-visto.htm',
      {headers:{cookie}})).status,403);

    assert.equal((await fetch(url + '/api/admin/nodi/a', { method:'POST',
      headers:{cookie:cookieOperatore,'content-type':'application/json'},body:JSON.stringify({fonte:'subito',sospeso:true}) })).status,200);
    const richiestaSospesa = fetch(url + '/api/search?tipo=moto&marca=Yamaha&modello=MT-07&versione=Sport',
      {headers:{cookie}});
    const parziale = await poll('a');
    assert.equal(parziale.input.fonti,'autoscout,moto');
    assert.equal((await esito('a',parziale,{...risposta,risultati:[]})).status,200);
    const altra = await poll('b');
    assert.equal(altra.fonte,'subito');
    assert.equal((await esito('b',altra,sostituta)).status,200);
    await completaSulPrincipale();
    assert.equal((await richiestaSospesa).status,200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    centro.close(); fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('catalogo Moto locale accessibile anche con Moto.it in pausa', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-menu-pausa-'));
  const tokens={a:'a'.repeat(64)}, centro=creaCentro({tokens,directory:dir,timeoutMs:3000});
  const server=await new Promise(resolve=>{const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={'x-amr-node-id':'a','x-amr-node-token':tokens.a,'content-type':'application/json'};
  try {
    await fetch(url+'/_nodo/heartbeat',{method:'POST',headers,body:JSON.stringify({id:'a',
      revisione:'imac-1',fonti:{moto:{fermo:true},subito:{fermo:false},autoscout:{fermo:false}}})});
    const login=await fetch(url+'/api/test/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({azienda:'aziendaB'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const richiesta=fetch(url+'/api/models?tipo=moto&marca=Yamaha',{headers:{cookie}});
    let job;
    for(let i=0;i<50 && !job;i++) {
      const poll=await fetch(url+'/_nodo/poll?id=a',{headers});
      if(poll.status===200) job=await poll.json();
      else {assert.equal(poll.status,204); await new Promise(resolve=>setTimeout(resolve,10));}
    }
    assert.ok(job);
    assert.equal(job.operazione,'modelli');
    await fetch(url+'/_nodo/esito',{method:'POST',headers,body:JSON.stringify({id:'a',
      idLavoro:job.idLavoro,tentativo:job.tentativo,esito:{status:200,body:{modelli:[{nome:'MT-07'}]}}})});
    assert.equal((await richiesta).status,200);
  } finally {await new Promise(resolve=>server.close(resolve));centro.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('pagine lavori, log operativi e backup solo su richiesta Operatore', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-log-nodi-'));
  const tokens={a:'a'.repeat(64)}, centro=creaCentro({tokens,directory:dir});
  const server=await new Promise(resolve=>{const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const url=`http://127.0.0.1:${server.address().port}`;
  try {
    const insert=centro.db.prepare('INSERT INTO lavori(id,azienda,operazione,filtri,stato,creato,aggiornato,nodo) VALUES(?,?,?,?,?,?,?,?)');
    for(let i=0;i<25;i++) insert.run('job-'+i,'aziendaA','ricerca','{"marca":"Fiat"}','concluso',Date.now()+i,Date.now()+i,'a');
    insert.run('attivo','aziendaA','ricerca','{"marca":"Fiat"}','in_corso',Date.now()+30,Date.now()+30,'a');
    const login=await fetch(url+'/api/test/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({azienda:'operatore'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const pubblico=await (await fetch(url+'/api/stato?pagina=2')).json();
    assert.equal(pubblico.lavori.length,6);
    assert.equal(pubblico.pagine,2);
    assert.equal(pubblico.lavoriAttivi,1);
    assert.equal(pubblico.lavori.every(r=>!Object.hasOwn(r,'filtri')),true);
    assert.equal((await fetch(url+'/api/admin/esporta')).status,401);
    const esporta=await fetch(url+'/api/admin/esporta',{headers:{cookie}});
    assert.equal(esporta.status,200);
    assert.match(esporta.headers.get('content-disposition'),/attachment/);
    assert.equal((await esporta.json()).lavori.length,26);
    assert.equal(fs.readdirSync(dir).some(name=>name.endsWith('.json')),false);
    assert.equal((await fetch(url+'/api/admin/lavori',{method:'DELETE',headers:{cookie}})).status,200);
    const admin=await (await fetch(url+'/api/admin',{headers:{cookie}})).json();
    assert.equal(admin.lavori.length,1);
    assert.equal(admin.lavori[0].id,'attivo');
    assert.equal(admin.eventi.some(e=>e.codice==='lavori_cancellati'),true);
  } finally {await new Promise(resolve=>server.close(resolve));centro.close();fs.rmSync(dir,{recursive:true,force:true})}
});

function rispostaDaPagina() {
  return { risultati:[],totale:0,sources:{subito:{status:'ok',count:0},
    autoscout:{status:'empty',count:0},moto:{status:'skipped',count:0}},
  versioneConto:null,versionePerFonte:null };
}

test('riavvio: i lavori pendenti sono dichiarati e i metadati vecchi eliminati', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-centro-storia-'));
  const tokens = { a:'a'.repeat(64) }, tempo = 1800000000000;
  try {
    const db = new DatabaseSync(path.join(dir,'lavori-prototipo.db'));
    db.exec('CREATE TABLE lavori (id TEXT PRIMARY KEY, azienda TEXT NOT NULL, operazione TEXT NOT NULL, filtri TEXT NOT NULL, stato TEXT NOT NULL, creato INTEGER NOT NULL, aggiornato INTEGER NOT NULL)');
    const ins = db.prepare('INSERT INTO lavori(id,azienda,operazione,filtri,stato,creato,aggiornato) VALUES(?,?,?,?,?,?,?)');
    ins.run('attesa','aziendaA','ricerca','{}','attesa',tempo-1000,tempo-1000);
    ins.run('iniziato','aziendaA','ricerca','{}','in_corso',tempo-1000,tempo-1000);
    ins.run('vecchio','aziendaA','ricerca','{}','concluso',tempo-8*86400000,tempo-8*86400000);
    db.close();
    const centro = creaCentro({tokens,directory:dir,ora:()=>tempo});
    assert.equal(centro.db.prepare('PRAGMA table_info(lavori)').all().some(x => x.name === 'nodo'), true);
    const rows = centro.db.prepare('SELECT id,stato FROM lavori ORDER BY id').all().map(x => ({...x}));
    assert.deepEqual(rows,[{id:'attesa',stato:'interrotto'},{id:'iniziato',stato:'incerto'}]);
    centro.close();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('sospensioni manuali restano attive dopo il riavvio del centro', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-centro-pause-'));
  const tokens = { a: 'a'.repeat(64) };
  const avvia = async () => {
    const centro = creaCentro({ tokens, directory: dir });
    const server = await new Promise(resolve => {
      const s = centro.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    return { centro, server, url: `http://127.0.0.1:${server.address().port}` };
  };
  const chiudi = async x => { await new Promise(resolve => x.server.close(resolve)); x.centro.close(); };
  const heartbeat = x => fetch(x.url + '/_nodo/heartbeat', { method: 'POST',
    headers: { 'x-amr-node-token': tokens.a, 'x-amr-node-id': 'a', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'a', revisione: 'imac-1', fonti: { subito: { fermo: false } } }),
  });
  try {
    let x = await avvia();
    await heartbeat(x);
    const login = await fetch(x.url + '/api/test/login', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ azienda: 'operatore' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const fonte of [null, 'subito']) {
      const r = await fetch(x.url + '/api/admin/nodi/a', { method: 'POST',
        headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fonte, sospeso: true }) });
      assert.equal(r.status, 200);
    }
    await chiudi(x);
    x = await avvia();
    await heartbeat(x);
    assert.equal(x.centro.nodi.get('a').sospeso, true);
    assert.equal(x.centro.nodi.get('a').sospese.has('subito'), true);
    await chiudi(x);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('menu offline del nodo conserva la forma delle rotte esistenti', async () => {
  const { esegui } = require('../backend/nodi/operazioni');
  const marche = await esegui({ operazione:'marche', input:{tipo:'auto'} });
  assert.equal(marche.status,200);
  assert.equal(marche.body.brands.some(x=>x.nome==='Fiat'),true);
  const modelli = await esegui({ operazione:'modelli', input:{tipo:'auto',marca:'Fiat'} });
  assert.equal(modelli.status,200);
  assert.equal(modelli.body.modelli.some(x=>x.nome==='Panda'),true);
  const versioni = await esegui({ operazione:'versioni', input:{tipo:'auto',marca:'Fiat',modello:'Panda'} });
  assert.equal(versioni.status,200);
  assert.equal(Array.isArray(versioni.body.versioni),true);
  const dettaglio = await esegui({ operazione:'dettaglio', input:{url:'https://non-ammesso.invalid/annuncio'} });
  assert.equal(dettaglio.status,400);
  assert.equal(typeof dettaglio.body.error,'string');
  const base = rispostaDaPagina();
  const composizione = await esegui({operazione:'componi',input:{principale:base,sostituzioni:{}}});
  assert.equal(composizione.status,200);
  assert.deepEqual(composizione.body.risultati,base.risultati);
});

test('nodo senza esito: nessun replay automatico e risposta tardiva rifiutata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-centro-incerto-'));
  const tokens = { a:'a'.repeat(64) };
  const centro = creaCentro({tokens,directory:dir,timeoutMs:100});
  const server = await new Promise(resolve => {
    const s = centro.app.listen(0,'127.0.0.1',()=>resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const auth = {'x-amr-node-token':tokens.a,'x-amr-node-id':'a','content-type':'application/json'};
    await fetch(url+'/_nodo/heartbeat',{method:'POST',headers:auth,
      body:JSON.stringify({id:'a',revisione:'imac-1',fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}})});
    const login = await fetch(url+'/api/test/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({azienda:'aziendaA'})});
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const pending = fetch(url+'/api/search?tipo=auto&marca=Fiat',{headers:{cookie}});
    let job;
    for (let i=0;i<30;i++) {
      const p = await fetch(url+'/_nodo/poll?id=a',{headers:auth});
      if (p.status===200) { job=await p.json(); break; }
      await new Promise(r=>setTimeout(r,5));
    }
    assert.ok(job);
    const r = await pending;
    assert.equal(r.status,504);
    assert.equal((await r.json()).incerto,true);
    const tardi = await fetch(url+'/_nodo/esito',{method:'POST',headers:auth,
      body:JSON.stringify({id:'a',idLavoro:job.idLavoro,tentativo:job.tentativo,
        esito:{status:200,body:{risultati:[]}}})});
    assert.equal(tardi.status,409);
    const operatore = await fetch(url+'/api/test/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({azienda:'operatore'})});
    const cookieOperatore=operatore.headers.get('set-cookie').split(';')[0];
    const admin = await (await fetch(url+'/api/admin',{headers:{cookie:cookieOperatore}})).json();
    assert.equal(admin.lavori[0].stato,'incerto');
  } finally {
    await new Promise(resolve=>server.close(resolve));
    centro.close();fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('failover incerto: le fonti riuscite restano visibili con avviso', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-centro-parziale-'));
  const tokens={a:'a'.repeat(64),b:'b'.repeat(64)};
  const centro=creaCentro({tokens,directory:dir,timeoutMs:250});
  const server=await new Promise(resolve=>{const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers=id=>({'x-amr-node-id':id,'x-amr-node-token':tokens[id],'content-type':'application/json'});
  const poll=async id=>{for(let i=0;i<40;i++){const r=await fetch(url+'/_nodo/poll?id='+id,{headers:headers(id)});
    if(r.status===200)return r.json();await new Promise(ok=>setTimeout(ok,5))}throw new Error('poll vuoto')};
  try {
    for(const id of ['a','b'])await fetch(url+'/_nodo/heartbeat',{method:'POST',headers:headers(id),
      body:JSON.stringify({id,revisione:'imac-1',simulato:id==='b',fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}})});
    const login=await fetch(url+'/api/test/login',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({azienda:'aziendaA'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const pending=fetch(url+'/api/search?tipo=auto&marca=Fiat',{headers:{cookie}});
    const prima=await poll('a');
    await fetch(url+'/_nodo/esito',{method:'POST',headers:headers('a'),body:JSON.stringify({id:'a',idLavoro:prima.idLavoro,
      tentativo:prima.tentativo,esito:{status:200,body:{risultati:[{fonte:'autoscout',id:'a1'}],totale:1,
        sources:{subito:{status:'error',erroreHttp:429,count:0},autoscout:{status:'ok',count:1},moto:{status:'skipped'}},
        versioneConto:null,versionePerFonte:null}}})});
    await poll('b');
    const r=await pending,body=await r.json();
    assert.equal(r.status,200);
    assert.deepEqual(body.risultati.map(x=>x.id),['a1']);
    assert.equal(body.sources.subito.erroreHttp,429);
    assert.equal(body.avvisiNodi.some(x=>x.includes('esito incerto')),true);
  } finally {await new Promise(resolve=>server.close(resolve));centro.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('riavvio rapido del worker: il lavoro già iniziato diventa incerto', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-centro-worker-'));
  const tokens={a:'a'.repeat(64)}, centro=creaCentro({tokens,directory:dir,timeoutMs:3000});
  const server=await new Promise(resolve=>{const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={'x-amr-node-id':'a','x-amr-node-token':tokens.a,'content-type':'application/json'};
  const battito=(occupato,idLavoroAttivo=null)=>fetch(url+'/_nodo/heartbeat',{method:'POST',headers,
    body:JSON.stringify({id:'a',revisione:'imac-1',occupato,idLavoroAttivo,
      fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}})});
  try {
    await battito(false);
    const pending=centro.ricerca('aziendaA',{tipo:'auto',marca:'Fiat'});
    const polled=await fetch(url+'/_nodo/poll?id=a',{headers});
    assert.equal(polled.status,200);
    const job=await polled.json();
    assert.equal((await battito(false)).status,200);
    await assert.rejects(pending,e=>e.incerto===true);
    const late=await fetch(url+'/_nodo/esito',{method:'POST',headers,
      body:JSON.stringify({id:'a',idLavoro:job.idLavoro,tentativo:job.tentativo,
        esito:{status:200,body:{risultati:[]}}})});
    assert.equal(late.status,409);
    assert.equal(centro.db.prepare('SELECT stato FROM lavori WHERE id=?').get(job.idLavoro).stato,'incerto');
  } finally {await new Promise(resolve=>server.close(resolve));centro.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('heartbeat assente: il centro dichiara incerto il lavoro già accettato', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-centro-offline-'));
  let tempo=1800000000000;
  const tokens={a:'a'.repeat(64)}, centro=creaCentro({tokens,directory:dir,ora:()=>tempo,timeoutMs:3000});
  const server=await new Promise(resolve=>{const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={'x-amr-node-id':'a','x-amr-node-token':tokens.a,'content-type':'application/json'};
  try {
    await fetch(url+'/_nodo/heartbeat',{method:'POST',headers,body:JSON.stringify({id:'a',
      revisione:'imac-1',fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}})});
    const pending=centro.ricerca('aziendaA',{tipo:'auto',marca:'Fiat'});
    const polled=await fetch(url+'/_nodo/poll?id=a',{headers});
    assert.equal(polled.status,200);
    tempo+=7000;
    await assert.rejects(pending,e=>e.incerto===true && e.message.includes('disconnesso'));
    assert.equal(centro.lavori.size,0);
  } finally {await new Promise(resolve=>server.close(resolve));centro.close();fs.rmSync(dir,{recursive:true,force:true})}
});

test('lavoro non ancora iniziato passa al secondo nodo senza ripetizioni', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'amr-centro-coda-'));
  let tempo=1800000000000;
  const tokens={a:'a'.repeat(64),b:'b'.repeat(64)};
  const centro=creaCentro({tokens,directory:dir,ora:()=>tempo,timeoutMs:3000});
  const server=await new Promise(resolve=>{const s=centro.app.listen(0,'127.0.0.1',()=>resolve(s))});
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers=id=>({'x-amr-node-id':id,'x-amr-node-token':tokens[id],'content-type':'application/json'});
  try {
    for(const id of ['a','b'])await fetch(url+'/_nodo/heartbeat',{method:'POST',headers:headers(id),
      body:JSON.stringify({id,revisione:'imac-1',occupato:id==='a',
        fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}})});
    const pending=centro.ricerca('aziendaA',{tipo:'auto',marca:'Fiat'});
    assert.equal(centro.nodi.get('a').coda.length,1);
    tempo+=7000;
    await fetch(url+'/_nodo/heartbeat',{method:'POST',headers:headers('b'),
      body:JSON.stringify({id:'b',revisione:'imac-1',occupato:false,
        fonti:{subito:{fermo:false},autoscout:{fermo:false},moto:{fermo:false}}})});
    await new Promise(resolve=>setTimeout(resolve,1100));
    assert.equal(centro.nodi.get('a').coda.length,0);
    const polled=await fetch(url+'/_nodo/poll?id=b',{headers:headers('b')});
    assert.equal(polled.status,200);
    const job=await polled.json();
    assert.equal(job.operazione,'ricerca');
    await fetch(url+'/_nodo/esito',{method:'POST',headers:headers('b'),body:JSON.stringify({id:'b',
      idLavoro:job.idLavoro,tentativo:job.tentativo,esito:{status:200,body:rispostaDaPagina()}})});
    assert.equal((await pending).status,200);
    assert.equal(centro.lavori.size,0);
  } finally {await new Promise(resolve=>server.close(resolve));centro.close();fs.rmSync(dir,{recursive:true,force:true})}
});
