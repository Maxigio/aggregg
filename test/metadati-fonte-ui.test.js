'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = require('../scripts/build-frontend').frontendSourceSync().js;
test('AutoScout: errore della prima pagina visibile negli Avvisi sulla ricerca', () => {
  const start = app.indexOf('function renderSourceStatus()');
  const end = app.indexOf('\nfunction fontePausaHTML', start);
  assert.ok(start >= 0 && end > start);
  let avvisi;
  const ctx = vm.createContext({ fonteBreakdown: { innerHTML: '' },
    lastSources: { autoscout: { status: 'error', erroreCodice: 'AS24_BODY_TOO_LARGE',
      parziale: null, pausa: { fermo: false } } }, paginaErrore: null,
    SOURCE_STATUS: { error: { cls: 'src-bad', txt: 'errore' } }, SKIP_REASON_TXT: {},
    FONTE_LABEL: { autoscout: 'AutoScout24' }, escapeHtml: String,
    fontePausaTesto: () => '', renderSearchAlerts: x => { avvisi = x; },
  });
  vm.runInContext(app.slice(start, end), ctx);
  ctx.renderSourceStatus();
  assert.equal(avvisi.length, 1);
  assert.match(avvisi[0], /AutoScout24.*limite di dimensione/);
  assert.match(ctx.fonteBreakdown.innerHTML, /errore/);
  ctx.lastSources.autoscout = { status: 'timeout', erroreTipo: 'transient', parziale: null,
    pausa: { fermo: false } };
  ctx.renderSourceStatus();
  assert.match(avvisi[0], /errore di rete/);
});
