'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('../backend/veicolo-dati-route');

const routes = {};
mount({ get(path, handler) { routes[path] = handler; } });

function risposta() {
  return {
    body: null,
    json(body) { this.body = body; return this; },
    set() { return this; },
  };
}

test('le tre rotte dei dati veicolo restano montate', () => {
  for (const path of ['/api/liquidita', '/api/passaggio', '/api/carburanti']) {
    assert.equal(typeof routes[path], 'function', path);
  }
});

test('liquidità e passaggio conservano il rifiuto dei parametri insufficienti', async () => {
  const liq = risposta();
  routes['/api/liquidita']({ query: {} }, liq);
  assert.deepEqual(liq.body, { ok: false });

  const passaggio = risposta();
  await routes['/api/passaggio']({ query: {} }, passaggio);
  assert.equal(passaggio.body.ok, false);
  assert.match(passaggio.body.motivo, /localita/);
});
