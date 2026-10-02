'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const express = require('express');
const { mount } = require('../backend/nodi/backup-prova-route');
test('backup HTTP: solo Admin MFA, origine loopback, risposta senza segreti e revoca durante lettura', async t => {
  const app = express();
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening',r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const origine = 'http://127.0.0.1:' + server.address().port;
  let query = 0, retry = 0, segnali = 0, revocata = false, revokeOnRead = false;
  const accessi = { sessione: req => req.headers.cookie === 'sintetico=admin' ? { persona: 'uuid',mfa:true,epoca:0 } : null,
    async verifica(s, scope) {
      assert.deepEqual(scope, { admin: true });
      if (!s || revocata) throw { codice: !s ? 'sessione_non_valida' : 'sessione_revocata' };
    } };
  mount(app, { origine, accessi, segnalaOperazione:()=>{segnali++;}, backup: { async stato() {
    query++; if (revokeOnRead) revocata = true;
    return { avviso: true, pending: 1 };
  }, async riprova(){retry++;return{ok:true,stato:'pending'};} } });
  const get = cookie => fetch(origine + '/api/auth/backup/stato', { headers: cookie ? { cookie } : {} });
  assert.equal((await get()).status, 401); assert.equal(query, 0);
  const r = await get('sintetico=admin'); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await r.json(), { avviso: true,pending:1 });
  const post = (body, origin = origine, cookie = 'sintetico=admin') => fetch(origine+'/api/auth/backup/riprova', {
    method:'POST',headers:{'content-type':'application/json',origin,cookie},body:JSON.stringify(body) });
  assert.equal((await post({},'http://altro.invalid')).status,403);
  assert.equal((await post({},origine,'')).status,401);
  assert.equal((await post({persona:'non-fidarsi'})).status,400);assert.equal(retry,0);
  assert.deepEqual(await (await post({})).json(),{ok:true,stato:'pending'});assert.equal(retry,1);assert.equal(segnali,1);
  revokeOnRead = true; assert.equal((await get('sintetico=admin')).status, 403);
  assert.throws(() => mount(express(), { origine: 'http://esterno.invalid' }), /origine trasporto/);
});
