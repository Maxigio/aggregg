'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { chromium } = require('playwright');
const browserPath = process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

test('prototipo: aggiornamento lavori conserva dettagli, focus e scroll senza congelare i dati',
  { skip: !fs.existsSync(browserPath) && 'Chromium non disponibile' }, async t => {
  const server = require('node:http').createServer((req, res) => {
    const files = { '/': 'backend/nodi/prototipo.html', '/prototipo.js': 'frontend/nodi-prototipo.js',
      '/prototipo.css': 'frontend/nodi-prototipo.css' };
    const file = files[req.url];
    if (!file) { res.writeHead(404).end(); return; }
    res.setHeader('content-type', req.url.endsWith('.js') ? 'text/javascript'
      : req.url.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(__dirname, '..', file)));
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  let browser;
  t.after(async () => { await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  let aggiornamenti = 0, inverti = false, rimossi = new Set(), nuovaMarca = 'BMW';
  let dettagli = 0;
  let consegnaDettagli;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    let json;
    if (url.pathname === '/api/test/config') json = {accesso:'sintetico'};
    else if (url.pathname === '/api/test/me') { await route.fulfill({status:401,json:{}}); return; }
    else if (url.pathname === '/api/stato') json = {nodi:[]};
    else if (url.pathname === '/api/detail') {
      dettagli++;
      assert.equal(url.searchParams.get('accessoDettagli'),'firma-sintetica');
      assert.equal(url.searchParams.get('url'),'https://www.subito.it/moto/prova.htm');
      json={ok:true,detail:{cambio:'<script>non_eseguire()</script>',cilindrata:600}};
      await new Promise(resolve=>{consegnaDettagli=resolve;});
    }
    else if (url.pathname === '/api/admin') {
      aggiornamenti++;
      const lavori = Array.from({length:20},(_, i) => ({
        id:'job-'+i,operazione:'ricerca',azienda:'fittizia',stato:i===0 && aggiornamenti>1?'concluso':'in_corso',
        creato:1800000000000,filtri:{tipo:'moto',marca:nuovaMarca,modello:'R 1200 GS Adventure'},nodo:'locale',
        nodo_ms:aggiornamenti*10})).filter(job=>!rimossi.has(job.id));
      if (inverti) lavori.reverse();
      json = {nodi:[], pagina:1,pagine:1,totale:lavori.length,eventi:[],lavori};
    } else throw new Error('Chiamata inattesa: '+url.pathname);
    await route.fulfill({json});
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForSelector('#lavori details');
  const summary = page.locator('#lavori summary').first();
  await summary.click(); await summary.focus();
  const aperto = await page.evaluate(() => {
    const details = document.querySelector('#lavori details'); window.dettaglioOriginale = details;
    const scroll = document.querySelector('.table-scroll'); scroll.scrollTop=80; scroll.scrollLeft=50;
    return {top:scroll.scrollTop,left:scroll.scrollLeft};
  });
  const prima=aggiornamenti;
  await page.waitForFunction(() => document.querySelector('#lavori .state').textContent==='Concluso');
  assert.ok(aggiornamenti>prima);
  assert.deepEqual(await page.evaluate(() => ({open:document.querySelector('#lavori details').open,
    stesso:document.querySelector('#lavori details')===window.dettaglioOriginale,
    focus:document.activeElement===document.querySelector('#lavori summary'),
    top:document.querySelector('.table-scroll').scrollTop,left:document.querySelector('.table-scroll').scrollLeft})),
  {open:true,stesso:true,focus:true,...aperto});
  await summary.click();
  const contatore=aggiornamenti;
  await page.waitForFunction(n => document.querySelector('#lavori tr').children[8].textContent !== n,
    await page.locator('#lavori tr').first().locator('td').nth(8).textContent());
  assert.ok(aggiornamenti>contatore);
  assert.equal(await page.locator('#lavori details').first().evaluate(e=>e.open),false);
  await summary.click(); await summary.focus();
  inverti = true; nuovaMarca = 'Marca aggiornata';
  await page.waitForFunction(() => document.querySelector('#lavori tr').dataset.lavoro==='job-19');
  assert.deepEqual(await page.evaluate(() => ({open:window.dettaglioOriginale.open,
    focus:document.activeElement===window.dettaglioOriginale.querySelector('summary'),
    aggiornato:window.dettaglioOriginale.querySelector('pre').textContent.includes('Marca aggiornata')})),
  {open:true,focus:true,aggiornato:true});
  rimossi.add('job-0'); rimossi.add('job-1');
  await page.waitForFunction(() => !document.querySelector('[data-lavoro="job-0"]'));
  assert.equal(await page.evaluate(() => document.activeElement===document.querySelector('.table-scroll')),true);
  assert.equal(await page.locator('#lavori tr').count(),18);
  rimossi = new Set(Array.from({length:20},(_,i)=>'job-'+i));
  await page.waitForFunction(() => document.getElementById('lavori').textContent.includes('Nessun lavoro'));
  assert.equal(await page.locator('#lavori tr').count(),1);
  await page.evaluate(() => {
    document.getElementById('ricercaPanel').hidden=false;
    renderRisultato({risultati:[{titolo:'Moto',url:'https://www.subito.it/moto/prova.htm',
      fonte:'subito',accessoDettagli:'firma-sintetica'}],sources:{}});
  });
  assert.equal(dettagli,0);
  await page.locator('#risultati summary').click();
  for(let i=0;!consegnaDettagli&&i<100;i++)await page.waitForTimeout(5);
  assert.ok(consegnaDettagli);
  // Una pagina successiva fallita cambia la sequenza HTTP, non la card esistente.
  await page.evaluate(()=>{sequenzaRicerca++;});
  consegnaDettagli();
  await page.waitForFunction(()=>document.querySelector('#risultati details p').textContent.includes('600'));
  assert.equal(dettagli,1);
  assert.equal(await page.locator('#risultati script').count(),0);
  await page.locator('#risultati summary').click();
  await page.locator('#risultati summary').click();
  await page.waitForTimeout(100);
  assert.equal(dettagli,1);
  assert.deepEqual(errors,[]);
});
