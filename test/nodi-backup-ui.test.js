'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// DOM minimo e risposte differite: nessun server, account o timer reale.
const sorgente = fs.readFileSync(path.join(__dirname, '../frontend/nodi-backup-prova.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Elemento {
  constructor(tag = 'section') {
    this.tagName = tag;
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.testo = '';
    this.listeners = new Map();
    const classi = new Set();
    this.classList = {
      add: nome => classi.add(nome),
      contains: nome => classi.has(nome),
      toggle: (nome, attiva) => attiva ? classi.add(nome) : classi.delete(nome)
    };
  }
  get textContent() { return this.testo + this.children.map(e => e.textContent).join(''); }
  set textContent(testo) { this.testo = String(testo); this.children = []; }
  replaceChildren(...elementi) { this.testo = ''; this.children = elementi; }
  append(...elementi) { this.children.push(...elementi); }
  addEventListener(tipo, fn) {
    if (!this.listeners.has(tipo)) this.listeners.set(tipo, []);
    this.listeners.get(tipo).push(fn);
  }
  dispatchEvent(evento) {
    for (const fn of this.listeners.get(evento.type) || []) fn(evento);
    return true;
  }
  click() { if (!this.disabled) this.dispatchEvent({ type: 'click' }); }
}

function fixture({ presente = true } = {}) {
  const root = new Elemento(); root.hidden = true;
  const stato = new Elemento('dl'), avviso = new Elemento('p');
  const aggiorna = new Elemento('button'), riprova = new Elemento('button');
  const campi = { '[data-backup-stato]': stato, '[data-backup-avviso]': avviso,
    '[data-backup-aggiorna]': aggiorna, '[data-backup-riprova]': riprova };
  root.querySelector = selector => campi[selector] || null;
  const document = new Elemento('document');
  document.querySelector = selector => presente && selector === '[data-backup-prototipo]' ? root : null;
  document.createElement = tag => new Elemento(tag);
  const richieste = [], intervalli = [];
  vm.runInNewContext(sorgente, { document,
    fetch: (url, options) => new Promise((resolve, reject) => richieste.push({ url, options, resolve, reject })),
    AbortSignal: { timeout: ms => ({ timeout: ms }) },
    setInterval: (fn, ms) => { intervalli.push({ fn, ms }); return intervalli.length; }
  }, { filename: 'frontend/nodi-backup-prova.js' });
  return { root, stato, avviso, aggiorna, riprova, richieste, intervalli,
    account: detail => document.dispatchEvent({ type: 'amr:account', detail }),
    risposta: async (richiesta, dati, ok = true) => {
      richiesta.resolve({ ok, json: async () => dati }); await tick();
    },
    polling: () => { for (const i of intervalli) i.fn(); }
  };
}

function status(stato = 'confermato') {
  const confermato = stato === 'confermato';
  return { configurato: true, retentionApplicata: true, operazioniPreesistenti: 0,
    journal: { stato, pending: confermato ? 0 : 1, failed: 0, confirmed: confermato ? 1 : 0,
      ultimo: confermato ? '2026-10-02T08:00:00.000Z' : null },
    database: { stato, ultimo: confermato ? '2026-10-02T08:00:00.000Z' : null, errore: null },
    avviso: !confermato };
}

test('backup UI assente: nessuna richiesta o polling', () => {
  const f = fixture({ presente: false });
  assert.equal(f.richieste.length, 0);
  assert.equal(f.intervalli.length, 0);
});

test('backup UI richiede admin booleano e non chiama le API riservate per altri account', async () => {
  const f = fixture();
  assert.equal(f.richieste[0].url, '/api/auth/me');
  await f.risposta(f.richieste[0], { admin: false });
  for (const account of [null, {}, { admin: 'true' }, { admin: 1 }]) {
    f.account(account); f.aggiorna.click(); f.riprova.click(); f.polling();
    assert.equal(f.root.hidden, true);
    assert.equal(f.stato.textContent, '');
  }
  assert.equal(f.richieste.length, 1);
});

test('backup UI ignora /me precedente al logout o al cambio di account', async () => {
  const f = fixture();
  f.account(null);
  await f.risposta(f.richieste[0], { admin: true });
  assert.equal(f.root.hidden, true);
  assert.equal(f.richieste.length, 1);
  f.account({ admin: true, persona: 'admin-sintetico' });
  assert.equal(f.richieste[1].url, '/api/auth/backup/stato');
});

test('backup UI raggruppa refresh e polling mentre la richiesta è in corso', async () => {
  const f = fixture();
  await f.risposta(f.richieste[0], { admin: true });
  assert.equal(f.aggiorna.disabled, true);
  f.aggiorna.click(); f.polling(); f.polling();
  assert.equal(f.richieste.length, 2);
  assert.equal(f.intervalli[0].ms, 10000);
  await f.risposta(f.richieste[1], status());
  assert.equal(f.aggiorna.disabled, false);
  assert.match(f.avviso.textContent, /^Copie confermate\./);
  assert.equal(f.root.classList.contains('warning'), false);
  assert.equal(f.richieste[1].options.credentials, 'same-origin');
  assert.equal(f.richieste[1].options.signal.timeout, 10000);
});

test('backup UI svuota il pannello al logout e scarta il precedente stato Admin', async () => {
  const f = fixture();
  f.account({ admin: true });
  const precedente = f.richieste[1];
  f.account(null);
  await f.risposta(precedente, status());
  assert.equal(f.root.hidden, true);
  assert.equal(f.stato.textContent, '');
  assert.equal(f.avviso.textContent, '');
  f.polling();
  assert.equal(f.richieste.length, 2);
});

test('backup UI una risposta di un precedente account non sovrascrive il nuovo refresh', async () => {
  const f = fixture();
  f.account({ admin: true, persona: 'admin-primo' });
  const vecchia = f.richieste[1];
  f.account(null);
  f.account({ admin: true, persona: 'admin-secondo' });
  const nuova = f.richieste[2];
  await f.risposta(vecchia, status());
  assert.equal(f.stato.textContent, '');
  assert.equal(f.aggiorna.disabled, true);
  f.polling(); assert.equal(f.richieste.length, 3);
  await f.risposta(nuova, status('pending'));
  assert.match(f.stato.textContent, /In attesa/);
  assert.equal(f.aggiorna.disabled, false);
  assert.equal(f.root.classList.contains('warning'), true);
});

test('backup UI retry e vecchio GET non confermano la copia prima del nuovo stato', async () => {
  const f = fixture();
  f.account({ admin: true });
  const vecchia = f.richieste[1];
  f.riprova.click(); f.riprova.click();
  const post = f.richieste[2];
  assert.equal(f.richieste.length, 3);
  assert.equal(post.url, '/api/auth/backup/riprova');
  assert.equal(post.options.method, 'POST');
  assert.equal(post.options.body, '{}');
  assert.equal(post.options.headers['content-type'], 'application/json');
  await f.risposta(vecchia, status());
  assert.doesNotMatch(f.avviso.textContent, /^Copie confermate\./);
  await f.risposta(post, { ok: true, stato: 'pending' });
  assert.match(f.avviso.textContent, /Copia ancora da confermare/);
  assert.equal(f.riprova.disabled, true);
  assert.equal(f.richieste[3].url, '/api/auth/backup/stato');
  await f.risposta(f.richieste[3], status('pending'));
  assert.equal(f.riprova.disabled, false);
  assert.equal(f.root.classList.contains('warning'), true);
  assert.doesNotMatch(f.avviso.textContent, /^Copie confermate\./);
});

test('backup UI scarta anche il risultato di un retry completato dopo il logout', async () => {
  const f = fixture();
  f.account({ admin: true });
  await f.risposta(f.richieste[1], status('pending'));
  f.riprova.click(); const post = f.richieste[2];
  f.account(null);
  await f.risposta(post, { ok: true, stato: 'pending' });
  assert.equal(f.root.hidden, true);
  assert.equal(f.avviso.textContent, '');
  assert.equal(f.richieste.length, 3);
});

test('backup UI conserva un avviso con backup non configurato o retention non applicata', async () => {
  const f = fixture(); f.account({ admin: true });
  const nonConfigurato = status('non_configurato'); nonConfigurato.configurato = false;
  await f.risposta(f.richieste[1], nonConfigurato);
  assert.match(f.avviso.textContent, /Backup esterno non configurato/);
  assert.equal(f.root.classList.contains('warning'), true);
  const retention = status(); retention.retentionApplicata = false; retention.avviso = true;
  retention.operazioniPreesistenti = 3;
  f.aggiorna.click(); await f.risposta(f.richieste[2], retention);
  assert.match(f.avviso.textContent, /retention non è confermata/);
  assert.match(f.avviso.textContent, /Operazioni precedenti senza journal: 3/);
  assert.equal(f.root.classList.contains('warning'), true);
});

test('backup UI errore HTTP non attesta nuove copie; i dati inattesi non entrano nel DOM', async () => {
  const f = fixture(); f.account({ admin: true });
  const dati = status(); dati.repository = 'private-synthetic-repository';
  await f.risposta(f.richieste[1], dati);
  assert.doesNotMatch(f.stato.textContent, /private-synthetic/);
  assert.deepEqual(f.stato.children.map(e => e.tagName), ['dt', 'dd', 'dt', 'dd']);
  f.aggiorna.click();
  dati.journal.ultimo = '<img src=x onerror=synthetic>'; dati.journal.stato = 'sconosciuto';
  await f.risposta(f.richieste[2], dati);
  assert.doesNotMatch(f.stato.textContent, /private-synthetic|<img/);
  assert.match(f.avviso.textContent, /Nessuna nuova copia è confermata/);
  f.aggiorna.click(); await f.risposta(f.richieste[3], {}, false);
  assert.match(f.avviso.textContent, /Nessuna nuova copia è confermata/);
  assert.equal(f.root.classList.contains('warning'), true);
  assert.equal(f.aggiorna.disabled, false);
});

test('backup UI un JSON incompleto non conferma copie o retention', async () => {
  const f = fixture(); f.account({ admin: true });
  await f.risposta(f.richieste[1], {});
  assert.doesNotMatch(f.avviso.textContent, /^Copie confermate\./);
  assert.equal(f.root.classList.contains('warning'), true);
});
