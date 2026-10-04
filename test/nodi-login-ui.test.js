'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

test('pagina login: una lettura iniziale tardiva non riapre la sessione dopo logout',async()=>{
  let completa;
  const nodes=Object.fromEntries(['login','mfa','stato','logout','prototipo'].map(id=>[id,{hidden:['mfa','logout','prototipo'].includes(id),
    elements:{password:{value:''},otp:{value:''},email:{value:''}},addEventListener:()=>{}}]));
  const script=fs.readFileSync(path.join(__dirname,'../frontend/nodi-login-prova.js'),'utf8');
  const navigazioni=[];
  const ctx=vm.createContext({navigator: { locks: {} }, window: { amrBootstrap: async () => ({ tentativo: "a".repeat(64) }) },location:{replace:url=>navigazioni.push(url)},document:{querySelector:s=>nodes[s.slice(1)],querySelectorAll:()=>[]},AbortSignal,
    fetch:async url=>url.endsWith('/me')?new Promise(r=>{completa=r;}):{ok:true,json:async()=>({ok:true,providerRevocato:true})}});
  vm.runInContext(script,ctx);
  await vm.runInContext("manda('login', {})",ctx);assert.equal(nodes.prototipo.hidden,false);assert.deepEqual(navigazioni,['/']);
  await vm.runInContext("manda('logout', {})",ctx);assert.equal(nodes.prototipo.hidden,true);
  assert.deepEqual(navigazioni,['/']);
  completa({ok:true});await new Promise(r=>setImmediate(r));
  assert.equal(nodes.login.hidden,false);assert.equal(nodes.logout.hidden,true);assert.equal(nodes.prototipo.hidden,true);assert.deepEqual(navigazioni,['/']);
});

test('C03: due schede iniziali condividono contesto e logout; altro browser e login successivo indipendenti', { timeout: 20000 }, async t => {
  const express = require('express'), { chromium } = require('playwright');
  const { mount } = require('../backend/nodi/login-nhost-prova');
  let server, browser, auth, entra, libera, prima = true, contesti = 0;
  const dentro = new Promise(r => { entra = r; }), attesa = new Promise(r => { libera = r; });
  const app = express();
  app.use((req, res, next) => { res.on('finish', () => {
    if ([].concat(res.getHeader('set-cookie') || []).some(v => v.startsWith('amr_accesso_prova='))) contesti++;
  }); next(); });
  server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const origine = 'http://127.0.0.1:' + server.address().port;
  let numero = 0;
  auth = mount(app, { origine, identita: async () => ({ attiva: true }), client: {
    login: async () => { const n = ++numero; if (prima) { prima = false; entra(); await attesa; }
      return { session: { user: { id: 'sintetica', emailVerified: true }, accessToken: 'access-' + n, refreshToken: 'refresh-' + n } }; },
    logout: async () => {},
  } });
  app.get('/', (req, res) => res.send('Accesso sintetico completato'));
  t.after(async () => { libera(); auth.close(); await browser?.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const executablePath = process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
    ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext(), a = await context.newPage(), b = await context.newPage();
  await Promise.all([a.goto(origine + '/api/auth/pagina'), b.goto(origine + '/api/auth/pagina')]);
  await a.waitForFunction(() => typeof window.amrBootstrap === 'function');
  await Promise.all([a.evaluate(() => amrBootstrap()), b.evaluate(() => amrBootstrap())]);
  assert.equal(contesti, 1, 'Il bootstrap simultaneo non deve creare contesti diversi');
  await a.locator('[name=email]').fill('sintetica@amr.invalid');
  await a.locator('[name=password]').fill('password-sintetica');
  await a.locator('#login button').click(); await dentro;
  // Un altro browser ha una sessione autonoma anche per la stessa persona.
  const altro = await browser.newContext();
  const prep = await altro.request.post(origine + '/api/auth/bootstrap', { headers: { origin: origine }, data: {login:true} });
  assert.equal((await altro.request.post(origine + '/api/auth/login', { headers: { origin: origine },
    data: { email: 'sintetica@amr.invalid', password: 'password-sintetica', tentativo: (await prep.json()).tentativo } })).status(), 200);
  await b.evaluate(() => manda('logout', {})); libera();
  await a.waitForFunction(() => document.getElementById('stato').textContent.includes('Ripeti il login'));
  assert.equal((await context.request.get(origine + '/api/auth/me')).status(), 401);
  assert.equal((await altro.request.get(origine + '/api/auth/me')).status(), 200);
  await b.locator('[name=email]').fill('sintetica@amr.invalid');
  await b.locator('[name=password]').fill('password-sintetica');
  await b.locator('#login button').click(); await b.waitForURL(origine + '/');
  assert.equal((await context.request.get(origine + '/api/auth/me')).status(), 200);
  assert.equal(contesti, 2, 'Il login successivo deve riusare il contesto, oltre a quello del browser indipendente');
  await altro.close();
});

test('C03: senza Web Locks il bootstrap fallisce esplicitamente senza richieste', async () => {
  let calls = 0;
  const ctx = vm.createContext({ window: {}, navigator: {}, AbortSignal, fetch: () => { calls++; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frontend/nodi-bootstrap-prova.js'), 'utf8'), ctx);
  await assert.rejects(vm.runInContext('window.amrBootstrap(true)', ctx), /browser aggiornato/);
  assert.equal(calls, 0);
});
