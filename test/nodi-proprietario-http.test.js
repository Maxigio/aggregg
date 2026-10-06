'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { creaCentro } = require('../backend/nodi/centro');
const ownerId = '00000000-0000-4000-8000-000000000001';
const pausa = ms => new Promise(resolve => setTimeout(resolve, ms));
async function attendi(fn) {
  for (let n = 0; n < 400; n++) { if (fn()) return; await pausa(5); }
  throw new Error('attesa sintetica scaduta');
}
const risposta = { risultati: [{ id: 'fixture', fonte: 'subito', url: 'https://www.subito.it/moto/fixture.htm' }],
  sources: { subito: { status: 'ok', count: 1, hasMore: false },
    autoscout: { status: 'empty', count: 0 }, moto: { status: 'empty', count: 0 } } };
async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync('/private/tmp/amr-proprietario-http-');
  const owner = { persona: ownerId, azienda: null, admin: true, mfa: true, scadenza: Date.now() + 60000 };
  const sessioni = { owner, owner2: { ...owner }, cliente: { persona: 'cliente', azienda: 'aziendaA', scadenza: owner.scadenza },
    admin: { ...owner, persona: '00000000-0000-4000-8000-000000000002' } };
  let ruoloAttivo = true;
  const centro = creaCentro({ directory, tokens: { n: 'n'.repeat(64) }, adminLocale: true,
    proprietarioId: ownerId,
    inizializzaAccessi: () => ({ sessione: req => sessioni[req.headers.cookie], close() {},
      async verifica(s, { admin = false, tipo } = {}) {
        if (!s || s.revocata || !ruoloAttivo || admin && (!s.admin || !s.mfa)
            || tipo !== undefined && !s.azienda) throw Object.assign(new Error('negato'), { status: 403 });
        return { persona: s.persona, admin: !!s.admin, mfa: !!s.mfa,
          azienda: s.azienda, aziendaValida: !!s.azienda, moduli: ['auto', 'moto'] };
      } }), ...options });
  const server = centro.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { centro.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = (route, { body, cookie = 'owner', method, node = false, headers = {} } = {}) => fetch(base + route, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { cookie, 'x-amr-local-admin': '1', ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(node ? { 'x-amr-node-id': typeof node === 'string' ? node : 'n',
        'x-amr-node-token': (typeof node === 'string' ? node : 'n').repeat(64) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const cerca = (id = randomUUID(), cookie = 'owner', input = { tipo: 'moto', marca: 'BMW' }, path = '/api/admin/ricerche') =>
    req(path, { cookie, body: { id, input } });
  const poll = (id = 'n') => req('/_nodo/poll?id=' + id, { node: id });
  const completa = (job, body = risposta, id = 'n') => req('/_nodo/esito', { node: id, body: {
    id, idLavoro: job.idLavoro, tentativo: job.tentativo, esito: { status: 200, body } } });
  const esito = async (id, path = '/api/admin/ricerche', cookie = 'owner') => {
    for (let n = 0; n < 100; n++) {
      const r = await req(path + '/' + id, { cookie }), dato = await r.json();
      if (r.status !== 200) return { status: r.status, dato };
      if (dato.esito) return dato.esito;
      await pausa(5);
    }
    throw new Error('esito non pronto');
  };
  await req('/_nodo/heartbeat', { node: true, body: { id: 'n', revisione: 'imac-1', occupato: false,
    fonti: { subito: { fermo: false }, autoscout: { fermo: false }, moto: { fermo: false } } } });
  return { centro, req, cerca, poll, completa, esito, sessioni, ruolo: v => { ruoloAttivo = v; } };
}

test('owner HTTP: senza azienda, stessa ricerca/cataloghi/dettagli e sessione originale invariata', async t => {
  const f = await fixture(t), prima = structuredClone(f.sessioni.owner), id = randomUUID();
  assert.equal((await f.req('/api/admin/ricerca/filtri')).status, 200);
  for (const [path, operazione] of [['brands', 'marche'], ['models', 'modelli'], ['versioni', 'versioni']]) {
    const p = f.req('/api/admin/ricerca/' + path + '?tipo=moto&marca=BMW&modello=GS');
    await attendi(() => f.centro.lavori.size === 1);
    const j = await (await f.poll()).json(); assert.equal(j.operazione, operazione);
    assert.equal(j.azienda, 'diagnostica:' + ownerId);
    await f.completa(j, { voci: [] }); assert.equal((await p).status, 200);
  }
  const avvio = await f.cerca(id); assert.equal(avvio.status, 202);
  assert.equal(avvio.headers.get('location'), '/api/admin/ricerche/' + id);
  await attendi(() => f.centro.lavori.size === 1);
  await f.completa(await (await f.poll()).json());
  const out = await f.esito(id); assert.equal(out.status, 200);
  const r = out.body.risultati[0]; assert.ok(r.accessoDettagli);
  const dettaglio = f.req('/api/admin/ricerca/detail?' + new URLSearchParams({ url: r.url, accessoDettagli: r.accessoDettagli }));
  await attendi(() => f.centro.lavori.size === 1);
  const j = await (await f.poll()).json(); assert.equal(j.operazione, 'dettaglio'); assert.equal(j.fonte, 'subito');
  await f.completa(j, { immagini: [] }); assert.equal((await dettaglio).status, 200);
  assert.deepEqual(f.sessioni.owner, prima); assert.equal((await f.req('/api/filtri')).status, 403);
  assert.equal((await f.cerca(id)).status, 202); assert.equal(f.centro.lavori.size, 0);
  assert.equal((await f.req('/api/admin/ricerche/' + id, { method: 'DELETE' })).status, 200);
});

test('owner HTTP: cliente, altro Admin, MFA mancante, configurazione assente e ID altrui negati', async t => {
  const f = await fixture(t);
  for (const cookie of ['cliente', 'admin', 'anonimo']) {
    assert.notEqual((await f.cerca(randomUUID(), cookie)).status, 202);
    assert.notEqual((await f.req('/api/admin/ricerca/brands?tipo=moto', { cookie })).status, 200);
  }
  f.sessioni.owner.mfa = false; assert.equal((await f.cerca()).status, 403); f.sessioni.owner.mfa = true;
  assert.equal((await f.cerca(randomUUID(), 'owner', { tipo: 'ricambi', marca: 'BMW' })).status, 400);
  const id = randomUUID(); await f.cerca(id); await attendi(() => f.centro.lavori.size === 1);
  assert.equal((await f.req('/api/admin/ricerche/' + id, { cookie: 'owner2' })).status, 404);
  assert.equal((await f.cerca(id, 'owner2')).status, 404);
  assert.equal((await f.req('/api/admin/ricerche/' + id, { cookie: 'owner2', method: 'DELETE' })).status, 404);
  const senza = await fixture(t, { proprietarioId: null }); assert.equal((await senza.cerca()).status, 403);
});

test('owner HTTP: contesti separati anche per stessa sessione, ID, condivisione e firme dettaglio', async t => {
  const f = await fixture(t); f.sessioni.owner.azienda = 'aziendaA'; const id = randomUUID();
  await f.cerca(id); await attendi(() => f.centro.lavori.size === 1);
  assert.equal((await f.req('/api/ricerche/' + id)).status, 404);
  assert.equal((await f.cerca(id, 'owner', undefined, '/api/ricerche')).status, 404);
  const clienteId = randomUUID(); await f.cerca(clienteId, 'owner', undefined, '/api/ricerche');
  await attendi(() => f.centro.lavori.size === 2);
  assert.deepEqual([...f.centro.lavori.values()].map(j => j.azienda).sort(), ['aziendaA', 'diagnostica:' + ownerId]);
  await f.completa(await (await f.poll()).json());
  await f.completa(await (await f.poll()).json());
  const r = (await f.esito(id)).body.risultati[0];
  assert.equal((await f.req('/api/detail?' + new URLSearchParams({ url: r.url, accessoDettagli: r.accessoDettagli }))).status, 403);
  const c = (await f.esito(clienteId, '/api/ricerche')).body.risultati[0];
  assert.equal((await f.req('/api/admin/ricerca/detail?' + new URLSearchParams({ url: c.url, accessoDettagli: c.accessoDettagli }))).status, 403);
});

test('owner HTTP: ruolo revocato al poll e alla rilettura; nessun bypass alla manutenzione', async t => {
  const f = await fixture(t), id = randomUUID(); await f.cerca(id); await attendi(() => f.centro.lavori.size === 1);
  f.ruolo(false); assert.equal((await f.poll()).status, 204); assert.equal(f.centro.lavori.size, 0);
  f.ruolo(true); const secondo = randomUUID(); await f.cerca(secondo); await attendi(() => f.centro.lavori.size === 1);
  await f.completa(await (await f.poll()).json()); assert.equal((await f.esito(secondo)).status, 200);
  f.sessioni.owner.revocata = true; assert.equal((await f.req('/api/admin/ricerche/' + secondo)).status, 403);
  f.sessioni.owner.revocata = false;
  await f.req('/api/admin/manutenzione', { body: { manutenzione: true } });
  assert.equal((await f.cerca()).status, 503); assert.equal(f.centro.lavori.size, 0);
});

test('owner HTTP: limite globale condiviso con clienti e limite personale fra contesti', async t => {
  const f = await fixture(t, { maxTotale: 1 }); await f.cerca(); await attendi(() => f.centro.lavori.size === 1);
  assert.equal((await f.cerca(randomUUID(), 'cliente', undefined, '/api/ricerche')).status, 429);
  assert.equal(f.centro.lavori.size, 1);
  const g = await fixture(t, { maxPersona: 1 }); g.sessioni.owner.azienda = 'aziendaA';
  await g.cerca(); await attendi(() => g.centro.lavori.size === 1);
  assert.equal((await g.cerca(randomUUID(), 'owner', undefined, '/api/ricerche')).status, 429);
});

test('owner HTTP: failover 429 preserva contesto e il retry usa gli stessi cursori', async t => {
  const f = await fixture(t, { tokens: { n: 'n'.repeat(64), m: 'm'.repeat(64) } });
  await f.req('/_nodo/heartbeat', { node: 'm', body: { id: 'm', revisione: 'imac-1', occupato: false,
    fonti: { subito: { fermo: false }, autoscout: { fermo: false }, moto: { fermo: false } } } });
  const id = randomUUID(); await f.cerca(id); await attendi(() => f.centro.lavori.size === 1);
  await f.completa(await (await f.poll()).json(), { ...risposta, risultati: [],
    sources: { ...risposta.sources, subito: { status: 'error', count: 0, erroreHttp: 429 } } });
  await attendi(() => [...f.centro.lavori.values()].some(j => j.operazione === 'fonte'));
  const recupero = await (await f.poll('m')).json();
  assert.equal(recupero.fonte, 'subito'); assert.equal(recupero.azienda, 'diagnostica:' + ownerId);
  await f.completa(recupero, risposta, 'm'); assert.equal((await f.esito(id)).status, 200);
  const prossimo = randomUUID(); await f.cerca(prossimo, 'owner', { tipo: 'moto', marca: 'BMW',
    fetta: '1', fonti: 'subito', subitoMainStart: '50', subitoRecuperoStart: '-1' });
  await attendi(() => f.centro.lavori.size === 1);
  const pagina = await (await f.poll('m')).json();
  assert.equal(pagina.input.subitoMainStart, '50'); assert.equal(pagina.input.subitoRecuperoStart, '-1');
  await f.completa(pagina, risposta, 'm'); assert.equal((await f.esito(prossimo)).status, 200);
});
