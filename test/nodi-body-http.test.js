'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { creaCentro } = require('../backend/nodi/centro');

test('parser HTTP: nessun frammento di body in risposta, stderr o registro', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-body-'));
  const centro = creaCentro({ directory, tokens: { n: 'n'.repeat(64) }, adminLocale: true });
  centro.app.set('env', 'production');
  const server = centro.app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(async () => {
    centro.close(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json', 'x-amr-node-id': 'n',
    'x-amr-node-token': 'n'.repeat(64), 'x-amr-local-admin': '1' };
  const log = [], precedente = console.error;
  console.error = (...args) => log.push(args.join(' '));
  try {
    for (const [url, body, status] of [
      ['/_nodo/heartbeat', 'PRIVATE_MARKER', 400],
      ['/api/test/login', '{"password":"PRIVATE_MARKER"', 400],
      ['/api/admin/nodi/n', 'PRIVATE_MARKER', 400],
      ['/_nodo/heartbeat', JSON.stringify({ value: 'PRIVATE_MARKER'.repeat(700000) }), 413],
    ]) {
      const r = await fetch(base + url, { method: 'POST', headers, body });
      assert.equal(r.status, status);
      assert.deepEqual(await r.json(), { codice: 'richiesta_non_valida' });
    }
    const r = await fetch(base + '/_nodo/heartbeat', { method: 'POST', headers,
      body: JSON.stringify({ id: 'n', revisione: 'imac-1', occupato: false, fonti: {} }) });
    assert.equal(r.status, 200);
    await r.text();
    const denied = await fetch(base + '/_nodo/heartbeat', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: 'PRIVATE_MARKER' });
    assert.equal(denied.status, 401);
    await denied.text();
    await new Promise(r => setTimeout(r, 30));
    assert.deepEqual(log, []);
    const eventi = centro.db.prepare('SELECT * FROM eventi').all();
    assert.equal(eventi.filter(e => e.codice === 'richiesta_non_valida').length, 4);
    assert.equal(JSON.stringify(eventi).includes('PRIVATE_MARKER'), false);
  } finally { console.error = precedente; }
});
