'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const fs=require('node:fs'), express=require('express');
const {chromium}=require('playwright');
const browserPath=process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

test('referente UI: risposta accettazione persa, stesso ID e conferma senza seconda modifica',
  {skip:!fs.existsSync(browserPath)&&'Chromium non disponibile',timeout:30000},async t=>{
    const app=express(), token=crypto.randomBytes(32).toString('hex'), persona=crypto.randomUUID();
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const origine='http://127.0.0.1:'+server.address().port;
    app.get('/api/auth/bootstrap.js',(req,res)=>res.type('js').send(''));
    app.get('/api/auth/pagina.css',(req,res)=>res.type('css').send(''));
    let confermata=null, modifiche=0, logout=0, browser;
    const richieste=[];
    const api=require('../backend/nodi/aziende-prova-route').mount(app,{origine,accessi:{},
      client:{login:async()=>({session:{user:{id:persona,emailVerified:true}}}),logout:async()=>{logout++;}},
      account:{invito:async tok=>{assert.equal(tok,token);return{email:'ref@amr.invalid',stato:confermata?'accettato':'pending'};},
        accetta:async(id,tok,op)=>{
          assert.equal(id,persona);assert.equal(tok,token);richieste.push(op);
          if(confermata){assert.equal(op,confermata);return{ok:true,giaEseguita:true};}
          confermata=op;modifiche++;return{ok:true,giaEseguita:false};
        }}});
    t.after(async()=>{await browser?.close();api.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
    browser=await chromium.launch({headless:true,executablePath:browserPath});
    const page=await browser.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
    let perdi=true;
    await page.route('**/api/auth/aziende/accetta',async route=>{
      if(!perdi)return route.continue();
      perdi=false;const risposta=await route.fetch();assert.equal(risposta.status(),200);
      await risposta.body();await route.abort('failed');
    });
    await page.goto(origine+'/api/auth/aziende/pagina#'+token);
    await page.locator('#account-accetta input').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('#account-accetta button')?.disabled===false);
    for(let n=0;n<2;n++){
      await page.locator('#account-accetta input').fill('password-sintetica');
      await page.locator('#account-accetta button').click();
      await page.waitForFunction(()=>document.querySelector('#account-accetta button').disabled===false);
      if(!n) assert.match(await page.locator('#account-stato').textContent(),/Esito non confermato/);
    }
    assert.equal(modifiche,1);assert.equal(richieste.length,2);assert.equal(richieste[0],richieste[1]);
    assert.equal(logout,2);assert.equal(await page.locator('#account-destinatario').isVisible(),false);
    assert.match(await page.locator('#account-stato').textContent(),/Accedi nuovamente/);
    assert.deepEqual(errors,[]);
    await page.goto(origine+'/api/auth/aziende/pagina#'+token);
    await page.reload(); // Stesso percorso + nuovo hash è una navigazione nel documento.
    await page.waitForFunction(()=>document.querySelector('#account-stato')?.textContent.includes('Invito già accettato'));
    assert.equal(await page.locator('#account-destinatario').isVisible(),false);
    assert.equal(richieste.length,2);
  });
