'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const express = require('express'), http = require('node:http');
const { mount } = require('../backend/nodi/login-nhost-prova');
const fs = require('node:fs'), { chromium } = require('playwright');
const browserPath = process.env.AMR_TEST_CHROMIUM || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const differita = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, { identita, mfa = false } = {}) {
  let now = Date.now(), numero = 0;
  const revocate = [], app = express(), server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origine = 'http://127.0.0.1:' + server.address().port;
  const session = () => ({ session: { user: { id: 'sintetica', emailVerified: true },
    accessToken: 'access-' + ++numero, refreshToken: 'refresh-' + numero } });
  const auth = mount(app, { origine, ora: () => now, identita: identita || (async () => ({ attiva: true })), client: {
    login: async () => mfa ? { mfa: { ticket: 'ticket-sintetico' } } : session(),
    mfa: async () => session(), logout: async s => { revocate.push(s.refreshToken); },
  } });
  app.get('/', (req, res) => res.send('Accesso sintetico'));
  t.after(async () => { auth.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const post = (route, body = {}, cookie, origin = origine) => fetch(origine + '/api/auth/' + route, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(cookie ? {cookie} : {}) }, body: JSON.stringify(body),
  });
  const prepara = async cookie => {
    const b = await post('bootstrap', { login: true }, cookie);
    cookie ||= b.headers.getSetCookie()[0].split(';')[0];
    const r = await post('login', { email: 'sintetica@amr.invalid', password: 'sintetica', tentativo: (await b.json()).tentativo }, cookie);
    assert.equal(r.status, 200); assert.deepEqual(r.headers.getSetCookie(), []);
    const data = await r.json(); assert.deepEqual(Object.keys(data), ['conferma']);
    return { cookie, data };
  };
  const applica = (r, prima) => {
    const jar = new Map(prima.split(';').map(v => v.trim().split('=')));
    for (const h of r.headers.getSetCookie()) {
      const [k,v] = h.split(';')[0].split('='); if (v) jar.set(k,v); else jar.delete(k);
    }
    return [...jar].map(([k,v]) => k + '=' + v).join('; ');
  };
  const me = cookie => fetch(origine + '/api/auth/me', {headers:{cookie}});
  return { post, prepara, me, applica, revocate, origine, auth, avanza: ms => {now += ms;} };
}

test('finalizza: risposta di verifica tardiva dopo logout e nuovo login non scrive cookie né riapre il tentativo', async t => {
  const f = await setup(t), a = await f.prepara();
  await f.post('logout', {}, a.cookie);
  const b = await f.prepara(a.cookie), nuovo = await f.post('finalizza', b.data, b.cookie);
  assert.equal(nuovo.status, 200); const jar = f.applica(nuovo, b.cookie);
  const tardiva = await f.post('finalizza', a.data, a.cookie);
  assert.equal(tardiva.status, 401); assert.deepEqual(tardiva.headers.getSetCookie(), []);
  assert.equal((await f.me(jar)).status, 200); assert.deepEqual(f.revocate, ['refresh-1']);
});

test('finalizza: handle monouso e browser vincolato; origine, contesto e permessi verificati prima dei cookie', async t => {
  let attiva = true;
  const f = await setup(t, {identita: async () => ({attiva})}), a = await f.prepara();
  const altro = await f.post('bootstrap'); const cookie = altro.headers.getSetCookie()[0].split(';')[0];
  for (const [c,o] of [[undefined,f.origine],[cookie,f.origine],[a.cookie,'https://estraneo.invalid']]) {
    const r = await f.post('finalizza', a.data, c, o); assert.ok([401,403].includes(r.status)); assert.deepEqual(r.headers.getSetCookie(), []);
  }
  attiva = false; const denied = await f.post('finalizza', a.data, a.cookie);
  assert.equal(denied.status,403); assert.deepEqual(denied.headers.getSetCookie(), []);
  attiva = true; const b = await f.prepara(a.cookie), ok = await f.post('finalizza', b.data, b.cookie);
  assert.equal(ok.status,200); assert.equal((await f.post('finalizza', b.data, b.cookie)).status,401);
});

test('finalizza: logout durante controllo PostgreSQL prevale; due finalizzazioni non duplicano sessioni', async t => {
  const dentro = differita(), gate = differita();
  const f = await setup(t, {identita: async () => {dentro.resolve(); await gate.promise; return {attiva:true};}});
  const a = await f.prepara(), pending = f.post('finalizza',a.data,a.cookie);
  try {
    await dentro.promise;
    assert.equal((await f.post('finalizza',a.data,a.cookie)).status,401);
    const out = await f.post('logout',{},a.cookie); assert.equal(out.status,200);
    gate.resolve(); const r = await pending;
    assert.equal(r.status,401); assert.deepEqual(r.headers.getSetCookie(),[]);
    assert.deepEqual(f.revocate,['refresh-1']); assert.equal((await f.me(a.cookie)).status,401);
  } finally {gate.resolve(); await pending;}
});

test('finalizza: esiti abbandonati scadono, nuovo tentativo e close ritirano provider una volta', async t => {
  const f = await setup(t), a = await f.prepara();
  f.avanza(3 * 60000); assert.equal((await f.post('finalizza',a.data,a.cookie)).status,401);
  assert.deepEqual(f.revocate,['refresh-1']);
  await f.prepara(a.cookie); await f.prepara(a.cookie);
  assert.deepEqual(f.revocate,['refresh-1','refresh-2']);
  f.auth.close(); assert.deepEqual(f.revocate,['refresh-1','refresh-2','refresh-3']);
});

test('finalizza: risposta non ricevuta non equivale a rollback; nuovo login ritira anche sessione senza cookie consegnato', async t => {
  const f = await setup(t), a = await f.prepara();
  const persa = await f.post('finalizza',a.data,a.cookie); assert.equal(persa.status,200);
  // Il browser non applica la risposta persa. Il successivo accesso usa solo il contesto.
  assert.equal((await f.me(a.cookie)).status,401);
  const b = await f.prepara(a.cookie), r = await f.post('finalizza',b.data,b.cookie);
  assert.equal(r.status,200); assert.deepEqual(f.revocate,['refresh-1']);
  assert.equal((await f.me(f.applica(r,b.cookie))).status,200);
  assert.equal((await f.me(f.applica(persa,a.cookie))).status,401);
});

test('finalizza: socket chiuso durante verifica non ritira la sessione precedente né ne crea una nuova', async t => {
  let gate;
  const dentro = differita(), f = await setup(t,{identita: async () => {if(gate){dentro.resolve(); await gate.promise;}return {attiva:true};}});
  const a = await f.prepara(), ok = await f.post('finalizza',a.data,a.cookie), jar = f.applica(ok,a.cookie);
  const b = await f.prepara(jar); gate = differita();
  const req = http.request(f.origine + '/api/auth/finalizza',{method:'POST',headers:{origin:f.origine,'content-type':'application/json',cookie:jar}});
  req.on('error',()=>{}); req.end(JSON.stringify(b.data));
  try {await dentro.promise; req.destroy(); await new Promise(r=>setTimeout(r,30)); gate.resolve();
    for(let i=0;i<100&&!f.revocate.length;i++)await new Promise(r=>setTimeout(r,5));
    gate=null; assert.deepEqual(f.revocate,['refresh-2']); assert.equal((await f.me(jar)).status,200);
  }finally{gate?.resolve();req.destroy();}
});

test('finalizza: MFA richiede due esiti server; logout tra verifica OTP e conferma nega cookie tardivi', async t => {
  const f=await setup(t,{mfa:true}), a=await f.prepara();
  const challenge=await f.post('finalizza',a.data,a.cookie), jar=f.applica(challenge,a.cookie);
  assert.deepEqual(await challenge.json(),{mfa:true});
  const otp=await f.post('mfa',{otp:'123456'},jar); assert.equal(otp.status,200); assert.deepEqual(otp.headers.getSetCookie(),[]);
  const data=await otp.json(); await f.post('logout',{},jar);
  const late=await f.post('finalizza',data,jar); assert.equal(late.status,401); assert.deepEqual(late.headers.getSetCookie(),[]);
  assert.deepEqual(f.revocate,['refresh-1']);
});

test('finalizza browser: lock ordina risposta ritardata e logout; timeout reale non applica cookie dopo nuovo login', {timeout:20000, skip:!fs.existsSync(browserPath)&&'Chromium non disponibile'}, async t => {
  const f=await setup(t);
  const browser=await chromium.launch({headless:true,executablePath:browserPath});t.after(()=>browser.close());
  const ctx=await browser.newContext(), a=await ctx.newPage(), b=await ctx.newPage();
  await Promise.all([a.goto(f.origine+'/api/auth/pagina'),b.goto(f.origine+'/api/auth/pagina')]);
  const prepara=page=>page.evaluate(async()=>{const p=await amrBootstrap(true);return(await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'sintetica@amr.invalid',password:'sintetica',tentativo:p.tentativo})})).json();});
  const old=await prepara(a), inside=differita(), release=differita();
  await a.route('**/api/auth/finalizza',async route=>{const r=await route.fetch();inside.resolve();await release.promise;await route.fulfill({response:r}).catch(()=>{});});
  const final=a.evaluate(data=>amrCookieFetch('/api/auth/finalizza',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(r=>r.status),old);
  await inside.promise;
  let logoutDone=false;
  const out=b.evaluate(()=>amrCookieFetch('/api/auth/logout',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.status)).then(status=>{logoutDone=true;return status;});
  await new Promise(r=>setTimeout(r,40)); assert.equal(logoutDone,false);
  release.resolve(); assert.equal(await final,200); assert.equal(await out,200);
  assert.equal((await ctx.request.get(f.origine+'/api/auth/me')).status(),401);
  await a.unroute('**/api/auth/finalizza');
  const timed=await prepara(a), received=differita(), delayed=differita();
  await a.route('**/api/auth/finalizza',async route=>{const r=await route.fetch();received.resolve();await delayed.promise;await route.fulfill({response:r}).catch(()=>{});});
  const timeout=a.evaluate(data=>amrCookieFetch('/api/auth/finalizza',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(100)}).then(()=> 'unexpected',e=>e.name),timed);
  await received.promise; assert.equal(await timeout,'TimeoutError');
  const fresh=await prepara(b);
  assert.equal(await b.evaluate(data=>amrCookieFetch('/api/auth/finalizza',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(r=>r.status),fresh),200);
  const before=(await ctx.cookies()).find(c=>c.name==='amr_sessione_prova').value;
  delayed.resolve();await new Promise(r=>setTimeout(r,40));
  assert.equal((await ctx.cookies()).find(c=>c.name==='amr_sessione_prova').value,before);
  assert.equal((await ctx.request.get(f.origine+'/api/auth/me')).status(),200);
});
