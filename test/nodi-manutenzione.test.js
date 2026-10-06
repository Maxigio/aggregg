'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { creaCentro } = require('../backend/nodi/centro');

const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));
async function attendi(fn) {
  for (let n = 0; n < 400; n++) { if (fn()) return; await pausa(5); }
  throw new Error('attesa sintetica scaduta');
}
const completa = { risultati: [], sources: {
  subito: { status: 'empty', count: 0 }, autoscout: { status: 'empty', count: 0 },
} };

async function fixture(t, { directory, hook = async () => {} } = {}) {
  const dati = directory || fs.mkdtempSync('/private/tmp/amr-manutenzione-');
  const sessioni = { cliente: { persona: 'cliente', azienda: 'aziendaA' },
    admin: { persona: 'admin', admin: true, mfa: true } };
  const c = creaCentro({ directory: dati, tokens: { a: 'a'.repeat(64), b: 'b'.repeat(64) }, adminLocale: true,
    inizializzaAccessi: () => ({ sessione: req => sessioni[req.headers.cookie], close() {},
      async verifica(s, { admin = false } = {}) {
        if (!s || admin && (!s.admin || !s.mfa)) throw Object.assign(new Error('no'), { status: 403 });
        await hook(s, admin);
        return { azienda: s.azienda, aziendaValida: true, moduli: ['auto', 'moto'] };
      } }),
  });
  const server = c.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  async function req(route, body, cookie = 'cliente', id) {
    return fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { cookie, 'x-amr-local-admin': '1', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(id ? { 'x-amr-node-id': id, 'x-amr-node-token': id.repeat(64) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  }
  let chiuso = false;
  const close = async () => {
    if (chiuso) return;
    chiuso = true; c.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  };
  t.after(async () => { await close(); if (!directory) fs.rmSync(dati, { recursive: true, force: true }); });
  return { c, req, sessioni, close, directory: dati,
    modo: attiva => req('/api/admin/manutenzione', { manutenzione: attiva }, 'admin'),
    cerca: (id = randomUUID(), marca = 'Fiat') => req('/api/ricerche', { id, input: { tipo: 'auto', marca } }),
    async esito(id) {
      let dato;
      for (let n = 0; n < 100; n++) {
        dato = await (await req('/api/ricerche/' + id)).json();
        if (dato.esito) return dato.esito;
        await pausa(5);
      }
      throw new Error('esito assente');
    },
    hb: id => req('/_nodo/heartbeat', { id, revisione: 'imac-1', occupato: false,
      fonti: { subito: { fermo: false }, autoscout: { fermo: false } } }, 'cliente', id),
    poll: id => req('/_nodo/poll?id=' + id, undefined, 'cliente', id),
    completa: (id, job, body = completa) => req('/_nodo/esito', { id, idLavoro: job.idLavoro,
      tentativo: job.tentativo, esito: { status: 200, body } }, 'cliente', id),
  };
}

test('manutenzione: interrompe la coda mai consegnata, blocca nuovi ID e preserva retry/consultazione', async t => {
  const f = await fixture(t), id = randomUUID(); await f.hb('a');
  assert.equal((await f.cerca(id)).status, 202); await attendi(() => f.c.lavori.size === 1);
  assert.equal((await f.modo(true)).status, 200);
  const out = await f.esito(id);
  assert.equal(out.status, 503); assert.equal(out.body.codice, 'ricerca_manutenzione');
  assert.equal(out.body.incerto, false); assert.equal(out.body.interrotto, true);
  assert.equal(f.c.lavori.size, 0); assert.equal((await f.poll('a')).status, 204);
  assert.equal((await f.cerca(id)).status, 202, 'Lo stesso ID consulta, non rilancia');
  const nuova = await f.cerca(); assert.equal(nuova.status, 503);
  assert.equal((await nuova.json()).codice, 'ricerca_manutenzione');
  assert.equal((await f.modo(false)).status, 200); assert.equal(f.c.lavori.size, 0);
  assert.equal((await f.cerca()).status, 202); await attendi(() => f.c.lavori.size === 1);
});

test('manutenzione: ricerca iniziata completa il failover dopo la pausa, senza ammettere una nuova pagina', async t => {
  const f = await fixture(t), id = randomUUID(); await f.hb('a'); await f.hb('b');
  await f.cerca(id); await attendi(() => f.c.lavori.size === 1);
  const primo = await (await f.poll('a')).json();
  await f.modo(true);
  assert.equal((await f.completa('a', primo, { ...completa,
    sources: { ...completa.sources, subito: { status: 'error', count: 0, erroreHttp: 429 } } })).status, 200);
  await attendi(() => [...f.c.lavori.values()].some(j => j.operazione === 'fonte'));
  const secondo = await (await f.poll('b')).json();
  assert.equal(secondo.fonte, 'subito'); assert.equal(secondo.operazione, 'fonte');
  assert.equal((await f.completa('b', secondo)).status, 200);
  assert.equal((await f.esito(id)).status, 200);
  assert.equal((await f.req('/api/ricerche', { id: randomUUID(), input: {
    tipo: 'auto', marca: 'Fiat', fetta: '1', fonti: 'subito', subitoMainStart: '50', subitoRecuperoStart: '-1' } })).status, 503);
});

test('manutenzione: verifica permessi ancora pendente non può accodare dopo la pausa', async t => {
  let blocca = false, entrata = false, libera;
  const gate = new Promise(resolve => { libera = resolve; }); t.after(libera);
  const f = await fixture(t, { hook: async (s, admin) => {
    if (blocca && !admin) { entrata = true; await gate; }
  } }); await f.hb('a'); blocca = true;
  const ricerca = f.cerca(); await attendi(() => entrata);
  await f.modo(true); libera();
  assert.equal((await ricerca).status, 503); assert.equal(f.c.lavori.size, 0);
});

test('manutenzione: pausa durante i permessi del poll non consegna il job', async t => {
  let blocca = false, entrata = false, libera;
  const gate = new Promise(resolve => { libera = resolve; }); t.after(libera);
  const f = await fixture(t, { hook: async (s, admin) => {
    if (blocca && !admin) { entrata = true; await gate; }
  } }); await f.hb('a'); const id = randomUUID(); await f.cerca(id);
  await attendi(() => f.c.lavori.size === 1); blocca = true;
  const poll = f.poll('a'); await attendi(() => entrata); await f.modo(true); libera();
  assert.equal((await poll).status, 204); assert.equal((await f.esito(id)).body.codice, 'ricerca_manutenzione');
});

test('manutenzione: ON/OFF non resuscita un ID 202 ancora in attesa dei permessi del coordinatore', async t => {
  let controlli = 0, entrata = false, libera;
  const gate = new Promise(resolve => { libera = resolve; }); t.after(libera);
  const f = await fixture(t, { hook: async (s, admin) => {
    if (!admin && ++controlli === 2) { entrata = true; await gate; }
  } }); await f.hb('a'); const id = randomUUID();
  assert.equal((await f.cerca(id)).status, 202); await attendi(() => entrata);
  assert.equal(f.c.lavori.size, 0);
  await f.modo(true);
  assert.equal((await f.esito(id)).body.codice, 'ricerca_manutenzione', 'Esito consultabile senza attendere il provider');
  await f.modo(false); libera();
  assert.equal((await f.esito(id)).body.codice, 'ricerca_manutenzione');
  assert.equal((await f.poll('a')).status, 204);
  assert.equal((await f.cerca(id)).status, 202); assert.equal(f.c.lavori.size, 0);
  assert.equal((await f.cerca()).status, 202); await attendi(() => f.c.lavori.size === 1);
});

test('manutenzione: interrompe anche il coordinatore fra creazione e accodamento di una pagina', async t => {
  const f = await fixture(t); await f.hb('a');
  let controlli = 0, entrata = false, libera;
  const gate = new Promise(resolve => { libera = resolve; }); t.after(libera);
  const verifica = async () => { if (++controlli > 1) { entrata = true; await gate; } return { azienda: 'aziendaA' }; };
  const p = f.c.ricerca('aziendaA', { tipo: 'auto', marca: 'Fiat', fetta: '1', fonti: 'subito' }, verifica);
  const respinta = assert.rejects(p, e => e.codice === 'ricerca_manutenzione');
  await attendi(() => entrata); assert.equal(f.c.lavori.size, 0);
  await f.modo(true); await respinta; libera(); await pausa(10);
  assert.equal(f.c.lavori.size, 0);
});

test('manutenzione: persistenza obbligatoria e autorizzazione Admin MFA', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('/api/admin/manutenzione', { manutenzione: true })).status, 403);
  f.sessioni.admin.mfa = false; assert.equal((await f.modo(true)).status, 403); f.sessioni.admin.mfa = true;
  f.c.db.exec("CREATE TRIGGER rifiuta_manutenzione BEFORE UPDATE ON controlli_centro BEGIN SELECT RAISE(FAIL,'guasto sintetico'); END");
  assert.equal((await f.modo(true)).status, 503);
  assert.equal((await (await f.req('/api/admin/manutenzione', undefined, 'admin')).json()).manutenzione, false);
  f.c.db.exec('DROP TRIGGER rifiuta_manutenzione'); await f.modo(true);
  f.c.db.exec("CREATE TRIGGER rifiuta_manutenzione BEFORE UPDATE ON controlli_centro BEGIN SELECT RAISE(FAIL,'guasto sintetico'); END");
  assert.equal((await f.modo(false)).status, 503);
  assert.equal((await (await f.req('/api/admin/manutenzione', undefined, 'admin')).json()).manutenzione, true);
});

test('manutenzione: il riavvio mantiene la pausa e non riprende la vecchia coda', async t => {
  const directory = fs.mkdtempSync('/private/tmp/amr-manutenzione-riavvio-');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const primo = await fixture(t, { directory }); await primo.modo(true); await primo.close();
  const secondo = await fixture(t, { directory });
  assert.equal((await (await secondo.req('/api/admin/manutenzione', undefined, 'admin')).json()).manutenzione, true);
  assert.equal((await secondo.cerca()).status, 503); assert.equal(secondo.c.lavori.size, 0);
});
