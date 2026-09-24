'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Esegue il blocco reale della cache con rete e orologio controllati.
function prepara() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'backend/scrapers/subito-api.js'), 'utf8');
  const start = source.indexOf('const RECUPERO_TTL =');
  const end = source.indexOf('const MAX_FAMIGLIE_MOTO', start);
  assert.ok(start >= 0 && end > start);
  let now = 0, richieste = 0;
  const timers = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    filtriAuto: { chiaveCache: () => '' },
    fetchPage: async () => ({ ads: [{ n: ++richieste }] }),
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.active = false; },
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.api = { paginaRecupero, recuperoCache, RECUPERO_TTL };', context);
  return {
    ...context.api,
    richieste: () => richieste,
    attivi: () => timers.filter(t => t.active).length,
    avanza(ms) {
      now += ms;
      for (const t of timers) if (t.active && t.at <= now) { t.active = false; t.fn(); }
    },
  };
}

const params = id => ({ tipo: 'moto', subitoNodo: { marcaId: id } });

test('gli annunci grezzi scadono anche senza un nuovo accesso', async () => {
  const c = prepara();
  const primo = await c.paginaRecupero(params('ducati'));
  assert.strictEqual(await c.paginaRecupero(params('ducati')), primo);
  assert.equal(c.richieste(), 1);
  c.avanza(c.RECUPERO_TTL);
  assert.equal(c.recuperoCache.size, 0);
  assert.equal((await c.paginaRecupero(params('ducati')))[0].n, 2);
});

test('l’espulsione non lascia timer attivi che trattengono la cache', async () => {
  const c = prepara();
  for (let i = 0; i < 201; i++) await c.paginaRecupero(params(String(i)));
  assert.equal(c.recuperoCache.size, 200);
  assert.equal(c.attivi(), 200);
  c.avanza(c.RECUPERO_TTL);
  assert.equal(c.recuperoCache.size, 0);
});
