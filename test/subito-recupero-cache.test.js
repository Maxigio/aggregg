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
  const end = source.indexOf('async function scrapeSubitoApi', start);
  assert.ok(start >= 0 && end > start);
  let now = 0, richieste = 0, signal;
  let risposta = async () => ({ ads: [{ n: ++richieste }] });
  const timers = [];
  const context = {
    Date: class extends Date { static now() { return now; } },
    filtriAuto: { chiaveCache: () => '' },
    fetchPage: (...args) => risposta(...args),
    annullo: { segnale: () => signal, annullata: () => !!signal?.aborted },
    setTimeout(fn, ms) {
      const timer = { fn, at: now + ms, active: true, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.active = false; },
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.api = { paginaRecupero, recuperoCache, recuperoInVolo, RECUPERO_TTL };', context);
  return {
    ...context.api,
    richieste: () => richieste,
    attivi: () => timers.filter(t => t.active).length,
    setFetchPage(fn) { risposta = fn; },
    setSignal(s) { signal = s; },
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

test('due modelli della stessa marca attendono un solo recupero, senza fondere marche diverse', async () => {
  const c = prepara();
  const pendenti = [];
  c.setFetchPage(() => new Promise(resolve => pendenti.push(resolve)));
  const prima = c.paginaRecupero({ ...params('alfa'), modello: 'Giulia' });
  const seconda = c.paginaRecupero({ ...params('alfa'), modello: 'Stelvio' });
  assert.equal(pendenti.length, 1);
  pendenti[0]({ ads: [{ id: 1 }] });
  const [a, b] = await Promise.all([prima, seconda]);
  assert.strictEqual(a, b);
  assert.equal(c.recuperoInVolo.size, 0);

  const altraMarca = c.paginaRecupero(params('beta'));
  assert.equal(pendenti.length, 2);
  pendenti[1]({ ads: [{ id: 2 }] });
  assert.equal((await altraMarca)[0].id, 2);
});

test('un 429 raggiunge entrambi gli attesi, non genera un secondo tentativo e libera la chiave', async () => {
  const c = prepara();
  const pendenti = [];
  c.setFetchPage(() => new Promise((resolve, reject) => pendenti.push({ resolve, reject })));
  const leader = new AbortController();
  const attesa = new AbortController();
  c.setSignal(leader.signal);
  const primo = c.paginaRecupero(params('alfa'));
  c.setSignal(attesa.signal);
  const secondo = c.paginaRecupero(params('alfa'));
  assert.equal(pendenti.length, 1);
  const errore = Object.assign(new Error('limite'), { status: 429 });
  pendenti[0].reject(errore);
  leader.abort(); // runSubito annulla il controller anche quando l'errore era un 429
  const esiti = await Promise.allSettled([primo, secondo]);
  assert.ok(esiti.every(e => e.status === 'rejected' && e.reason === errore));
  assert.equal(pendenti.length, 1);
  assert.equal(c.recuperoInVolo.size, 0);
  assert.equal(c.recuperoCache.size, 0);
});

test('se il primo tentativo viene annullato, chi attende è ancora attivo riprova', async () => {
  const c = prepara();
  const pendenti = [];
  c.setFetchPage(() => new Promise((resolve, reject) => pendenti.push({ resolve, reject })));
  const leader = new AbortController();
  const attesa = new AbortController();
  c.setSignal(leader.signal);
  const primo = c.paginaRecupero(params('alfa'));
  c.setSignal(attesa.signal);
  const secondo = c.paginaRecupero(params('alfa'));
  assert.equal(pendenti.length, 1);
  leader.abort();
  const errore = Object.assign(new Error('annullato'), { code: 'ABORT_ERR', kind: 'transient' });
  pendenti[0].reject(errore);
  assert.equal((await Promise.allSettled([primo]))[0].reason, errore);
  for (let i = 0; i < 5 && pendenti.length < 2; i++) await Promise.resolve();
  assert.equal(pendenti.length, 2);
  pendenti[1].resolve({ ads: [{ id: 3 }] });
  assert.equal((await secondo)[0].id, 3);
  assert.equal(c.recuperoInVolo.size, 0);
});

test('un atteso già annullato non avvia un recupero nuovo dopo la caduta del primo', async () => {
  const c = prepara();
  const pendenti = [];
  c.setFetchPage(() => new Promise((resolve, reject) => pendenti.push({ resolve, reject })));
  const leader = new AbortController();
  const attesa = new AbortController();
  c.setSignal(leader.signal);
  const primo = c.paginaRecupero(params('alfa'));
  c.setSignal(attesa.signal);
  const secondo = c.paginaRecupero(params('alfa'));
  const errore = Object.assign(new Error('annullato'), { code: 'ABORT_ERR' });
  leader.abort(); attesa.abort();
  pendenti[0].reject(errore);
  const esiti = await Promise.allSettled([primo, secondo]);
  assert.ok(esiti.every(e => e.status === 'rejected' && e.reason === errore));
  assert.equal(pendenti.length, 1);
  assert.equal(c.recuperoInVolo.size, 0);
});
