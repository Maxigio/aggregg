'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const fs=require('node:fs'), express=require('express');
const {chromium}=require('playwright');
const {mount}=require('../backend/nodi/colleghi-prova-route');
const browserPath=process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
test('colleghi UI: frammento embedded, testo sicuro, idempotenza e risposta tardiva dopo logout',
  {skip:!fs.existsSync(browserPath)&&'Chromium non disponibile',timeout:30000},async t=>{
    const app=express(), owner=crypto.randomUUID(), referente=crypto.randomUUID(), collega=crypto.randomUUID();
    const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',e=>e?reject(e):resolve(s));s.on('error',reject);});
    const origine='http://127.0.0.1:'+server.address().port;
    let ctx={persona:owner,admin:true,mfa:true}, fallisciElenco=false, perdiRevoca=false, attesa=null;
    let membri=[{persona:referente,email:'referente@amr.invalid',referente:true,attiva:true},
      {persona:collega,email:'<script>intruso()</script>@amr.invalid',referente:false,attiva:true}];
    const richieste=[], confermate=new Set(), inviti=[];
    app.get('/',(req,res)=>res.type('html').send('<!doctype html><html lang="it"><body><section data-colleghi-prototipo></section><script src="/api/auth/colleghi/pagina.js" defer></script></body></html>'));
    app.get('/senza',(req,res)=>res.type('html').send('<!doctype html><html><body><p>Nessun pannello</p><script src="/api/auth/colleghi/pagina.js" defer></script></body></html>'));
    app.get('/api/auth/me',(req,res)=>res.json(ctx));
    app.get('/api/auth/aziende/elenco',(req,res)=>res.json({aziende:[
      {id:'prova',nome:'Azienda principale',stato:'attiva'}, {id:'altra',nome:'Altra azienda',stato:'attiva'}]}));
    const api=mount(app,{origine,accessi:{sessione:()=>({persona:ctx.persona,epoca:0,mfa:ctx.mfa}),
      verifica:async()=>ctx},client:{},account:{
      elenco:async()=>{if(attesa)await attesa;if(fallisciElenco)throw Object.assign(new Error(),{status:503});
        return{id:'prova',admin:ctx.admin,membri,inviti};},
      statoOperazione:async(s,b)=>({confermata:confermate.has(b.operazione)}),
      invita:async(s,b)=>{richieste.push({tipo:'invita',...b});const prima=!confermate.has(b.operazione);confermate.add(b.operazione);
        if(prima)inviti.push({id:crypto.randomUUID(),email:b.email,stato:'pending',scadenza:new Date(Date.now()+86400000).toISOString()});
        return{ok:true,id:b.id,operazione:b.operazione,giaEseguita:!prima,tokenDisponibile:true,...(prima?{token:'a'.repeat(64)}:{})};},
      revoca:async(s,b)=>{richieste.push({tipo:'revoca',...b});confermate.add(b.operazione);membri=membri.filter(m=>m.persona!==b.persona);
        if(perdiRevoca){perdiRevoca=false;throw Object.assign(new Error(),{status:503});}return{ok:true};},
      cambiaReferente:async(s,b)=>{richieste.push({tipo:'referente',...b});return{ok:true};}
    }});
    let browser;
    t.after(async()=>{await browser?.close();api.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
    browser=await chromium.launch({headless:true,executablePath:browserPath});
    const page=await browser.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origine+'/');
    await page.waitForFunction(()=>document.querySelector('#colleghi-azienda select')?.options.length===3);
    assert.match(await page.locator('#colleghi-azienda select').textContent(),/Azienda principale/);
    assert.equal(await page.locator('[data-colleghi-prototipo] .solo-pagina').count(),0);
    await page.locator('#colleghi-azienda select').selectOption('prova');
    await page.locator('#colleghi-azienda button').click();
    await page.waitForSelector('#colleghi-elenco article');
    assert.equal(await page.locator('#colleghi-elenco script').count(),0);
    assert.match(await page.locator('#colleghi-elenco').textContent(),/<script>/);
    assert.equal(await page.getByRole('button',{name:'Rendi referente'}).count(),1);
    assert.equal(await page.getByRole('button',{name:'Revoca collega'}).count(),1);
    fallisciElenco=true;
    await page.locator('#colleghi-azienda select').selectOption('altra');await page.locator('#colleghi-azienda button').click();
    await page.waitForFunction(()=>document.querySelector('#colleghi-stato').textContent.includes('Esito non confermato'));
    assert.equal(await page.locator('#colleghi-elenco').textContent(),'');
    assert.equal(await page.locator('#colleghi-invita').isVisible(),false);
    assert.equal(richieste.length,0);
    fallisciElenco=false;await page.locator('#colleghi-azienda select').selectOption('prova');await page.locator('#colleghi-azienda button').click();
    await page.waitForSelector('#colleghi-elenco article');
    await page.locator('#colleghi-invita input').fill('nuovo@amr.invalid'); fallisciElenco=true;
    await page.locator('#colleghi-invita button').click();
    await page.waitForFunction(()=>document.querySelector('#colleghi-stato').textContent.includes('Esito non confermato'));
    const primo=richieste.find(r=>r.tipo==='invita'); fallisciElenco=false;
    await page.evaluate(c=>document.dispatchEvent(new CustomEvent('amr:account',{detail:c})),ctx);
    await page.locator('#colleghi-invita button').click();
    await page.waitForSelector('#colleghi-elenco article:nth-of-type(3)');
    assert.equal(richieste.filter(r=>r.tipo==='invita').at(-1).operazione,primo.operazione);
    assert.equal(inviti.length,1);
    let perdiInvito=true;
    await page.route('**/api/auth/colleghi/invita',async route=>{
      if (!perdiInvito) return route.continue();
      perdiInvito=false;const r=await route.fetch();await r.body();await route.abort('failed');
    });
    await page.locator('#colleghi-invita input').fill('perso@amr.invalid');await page.locator('#colleghi-invita button').click();
    await page.waitForFunction(()=>document.querySelector('#colleghi-stato').textContent.includes('Esito non confermato'));
    const persa=richieste.filter(r=>r.tipo==='invita').at(-1);
    await page.locator('#colleghi-aggiorna').click();await page.waitForSelector('#colleghi-elenco article:nth-of-type(4)');
    await page.locator('#colleghi-invita button').click();
    await page.waitForFunction(()=>!document.querySelector('#colleghi-invita button').disabled);
    assert.equal(richieste.filter(r=>r.tipo==='invita').at(-1).operazione,persa.operazione);
    assert.equal(await page.locator('#colleghi-consegna a').count(),1);
    assert.equal(inviti.length,2);
    perdiRevoca=true;await page.getByRole('button',{name:'Revoca collega'}).click();
    await page.waitForFunction(()=>document.querySelector('#colleghi-stato').textContent.includes('Esito non confermato'));
    await page.locator('#colleghi-aggiorna').click();
    await page.waitForFunction(()=>!document.querySelector('#colleghi-elenco').textContent.includes('<script>'));
    membri.push({persona:collega,email:'collega@amr.invalid',referente:false,attiva:true});
    await page.locator('#colleghi-aggiorna').click();
    await page.getByRole('button',{name:'Revoca collega'}).click();
    await page.waitForFunction(()=>!document.querySelector('#colleghi-elenco').textContent.includes('collega@amr.invalid'));
    await page.waitForFunction(()=>!document.querySelector('#colleghi-aggiorna').disabled);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'colleghi-aggiorna');
    const revoche=richieste.filter(r=>r.tipo==='revoca');assert.equal(revoche.length,2);
    assert.notEqual(revoche[0].operazione,revoche[1].operazione);
    membri.push({persona:collega,email:'collega@amr.invalid',referente:false,attiva:true});
    await page.locator('#colleghi-aggiorna').click();
    await page.waitForFunction(()=>!document.querySelector('#colleghi-aggiorna').disabled);
    let liberaFocus;attesa=new Promise(r=>{liberaFocus=r;});
    await page.getByRole('button',{name:'Revoca collega'}).click();
    await page.locator('#colleghi-invita input').focus();
    liberaFocus();attesa=null;
    await page.waitForFunction(()=>!document.querySelector('#colleghi-aggiorna').disabled);
    assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#colleghi-invita input')),true,
      'il completamento non deve sottrarre il focus spostato dall’utente');
    let libera;attesa=new Promise(r=>{libera=r;});
    const arrivata=new Promise(resolve=>page.once('request',r=>{if(r.url().endsWith('/api/auth/me'))resolve();}));
    await page.locator('#colleghi-aggiorna').click();await arrivata;
    await page.evaluate(()=>document.dispatchEvent(new CustomEvent('amr:account',{detail:null})));
    libera();attesa=null;
    await page.waitForFunction(()=>!document.querySelector('#colleghi-aggiorna').disabled);
    assert.equal(await page.locator('#colleghi-gestione').isVisible(),false);
    assert.equal(await page.locator('#colleghi-elenco').textContent(),'');
    await page.goto(origine+'/api/auth/colleghi/pagina');await page.waitForURL(origine+'/#accountPanel');
    await page.goto(origine+'/senza');assert.equal(await page.locator('[data-colleghi]').count(),0);
    assert.deepEqual(errors,[]);
  });
