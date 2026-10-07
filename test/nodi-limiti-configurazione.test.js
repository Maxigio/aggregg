'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { creaConfigurazioneLimiti, MASSIMI } = require('../backend/nodi/limiti-configurazione');
const { creaLimitiRicerca } = require('../backend/nodi/limiti-ricerca');
const { creaCentro } = require('../backend/nodi/centro');
const { creaRetention } = require('../backend/nodi/diagnostica-retention');

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const cfg = creaConfigurazioneLimiti({ db }); return { db, cfg };
}
const input = (valori, revisione = 0) => ({ revisione, valori });
test('limiti: persistenza, audit atomico e riavvio senza rialzare i valori', t => {
  const { db, cfg } = fixture(t), valori = { timeoutMs: 15000, maxPersona: 1, maxTotale: 20 };
  assert.equal(cfg.aggiorna(input(valori), 'locale').revisione, 1);
  const riaperta = creaConfigurazioneLimiti({ db });
  assert.deepEqual(riaperta.stato().valori, valori);
  const audit = db.prepare('SELECT * FROM limiti_ricerca_audit').get();
  assert.equal(audit.operatore, 'locale'); assert.deepEqual(JSON.parse(audit.prima), MASSIMI);
  assert.deepEqual(JSON.parse(audit.dopo), valori);
  assert.throws(() => cfg.aggiorna(input({ ...valori, maxTotale: 10 }), 'locale'), { status: 409 });
  assert.equal(cfg.aggiorna(input(valori, 1), 'locale').revisione, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM limiti_ricerca_audit').get().n, 1);
  assert.throws(() => creaConfigurazioneLimiti({ db, iniziali: { ...MASSIMI, timeoutMs: 10000 } }));
});
test('limiti: scrittura audit fallita annulla configurazione e revisione', t => {
  const { db, cfg } = fixture(t);
  db.exec("CREATE TRIGGER guasto BEFORE INSERT ON limiti_ricerca_audit BEGIN SELECT RAISE(ABORT,'guasto sintetico'); END");
  assert.throws(() => cfg.aggiorna(input({ ...MASSIMI, maxPersona: 1 }), 'locale'));
  assert.deepEqual(cfg.stato().valori, MASSIMI); assert.equal(cfg.stato().revisione, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM limiti_ricerca_audit').get().n, 0);
});
test('limiti: input chiuso, niente coercizioni, aumenti o operatore dal body', t => {
  const { cfg } = fixture(t);
  for (const bad of [null, [], {}, { ...input(MASSIMI), extra: 1 },
    input({ ...MASSIMI, timeoutMs: '10000' }), input({ ...MASSIMI, timeoutMs: 60001 }),
    input({ ...MASSIMI, maxPersona: 3 }), input({ ...MASSIMI, maxTotale: 61 }),
    input({ ...MASSIMI, maxTotale: 0 }), input({ ...MASSIMI, maxTotale: 1.5 }),
    input({ ...MASSIMI, sconosciuto: 1 }), input(MASSIMI, '0')]) {
    assert.throws(() => cfg.aggiorna(bad, 'locale'), { status: 400 });
  }
  assert.throws(() => cfg.aggiorna(input(MASSIMI), 'qualcuno@example.test'), { status: 403 });
  assert.deepEqual(cfg.stato().valori, MASSIMI);
});
test('limiti: cap audit blocca il comando invece di perdere storia recente', t => {
  const { db, cfg } = fixture(t); const stmt = db.prepare('INSERT INTO limiti_ricerca_audit VALUES(?,?,?,?,?)');
  db.exec('BEGIN'); for (let n = 1; n <= 10000; n++) stmt.run(n, Date.now(), 'locale', '{}', '{}'); db.exec('COMMIT');
  assert.throws(() => cfg.aggiorna(input({ ...MASSIMI, maxTotale: 10 }), 'locale'), { codice: 'audit_limiti_esaurito' });
  assert.deepEqual(cfg.stato().valori, MASSIMI);
});
test('limiti: nuovi avvii leggono le soglie, vecchi budget e posti restano invariati', t => {
  const { cfg } = fixture(t); let mono = 100;
  const l = creaLimitiRicerca({ leggi: () => cfg.stato().valori, oraMono: () => mono }); t.after(() => l.close());
  const a = l.ammetti({ persona: 'a' }), b = l.ammetti({ persona: 'a' });
  assert.equal(a.budget.scadeAl, 60100);
  cfg.aggiorna(input({ timeoutMs: 10000, maxPersona: 1, maxTotale: 1 }), 'locale');
  assert.equal(a.budget.scadeAl, 60100);
  assert.throws(() => l.ammetti({ persona: 'b' }), { status: 429 });
  a.termina(); assert.throws(() => l.ammetti({ persona: 'a' }), { status: 429 });
  b.termina(); mono = 200;
  const nuova = l.ammetti({ persona: 'a' }); assert.equal(nuova.budget.scadeAl, 10200); nuova.termina();
});

async function centro(t, { onAdmin = () => {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-limiti-admin-'));
  const sessions = { admin: { persona: randomUUID(), admin: true, mfa: true }, cliente: { persona: randomUUID(), azienda: 'aziendaA' },
    cliente2: { persona: randomUUID(), azienda: 'aziendaB' } };
  const c = creaCentro({ directory, adminLocale: true, tokens: { a: 'a'.repeat(64) },
    inizializzaAccessi: () => ({ sessione: req => sessions[req.headers.cookie], close() {},
      verifica: async (s, { admin = false } = {}) => {
        if (!s || admin && (!s.admin || !s.mfa)) throw Object.assign(new Error('no'), { status: 403 });
        if (admin) onAdmin();
        return { azienda: s.azienda, moduli: ['auto', 'moto'], aziendaValida: true };
      } }) });
  const server = c.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { c.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(directory, { recursive: true }); });
  const req = (route, body, cookie = 'admin', extra = {}) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, 'x-amr-local-admin': '1', ...extra,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  return { c, sessions, req, base };
}
test('limiti HTTP: revoca durante il body lento impedisce configurazione e audit', async t => {
  let ammessa; const primaVerifica = new Promise(r => { ammessa = r; });
  const { c, sessions, base, req } = await centro(t, { onAdmin: ammessa });
  const http = require('node:http');
  const body = JSON.stringify(input({ ...MASSIMI, maxTotale: 1 }));
  let invio;
  const risposta = new Promise((resolve, reject) => {
    invio = http.request(base + '/api/admin/limiti', { method: 'POST', headers: {
      cookie: 'admin', 'x-amr-local-admin': '1', 'content-type': 'application/json',
      'content-length': Buffer.byteLength(body) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    invio.on('error', reject); invio.setTimeout(3000, () => invio.destroy(new Error('fixture scaduta')));
    invio.write(body.slice(0, 1));
  });
  t.after(() => invio.destroy());
  await primaVerifica; sessions.admin.admin = false;
  assert.equal((await req('/api/admin/limiti')).status, 403);
  invio.end(body.slice(1)); assert.equal(await risposta, 403);
  assert.equal(c.db.prepare('SELECT revisione FROM limiti_ricerca').get().revisione, 0);
  assert.equal(c.db.prepare('SELECT count(*) AS n FROM limiti_ricerca_audit').get().n, 0);
});
test('limiti: retention periodica elimina audit scaduto senza nuovi comandi', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); let adesso = Date.now();
  const cfg = creaConfigurazioneLimiti({ db, ora: () => adesso });
  db.exec('CREATE TABLE lavori(creato INTEGER, stato TEXT); CREATE TABLE eventi(id INTEGER, ts INTEGER)');
  cfg.aggiorna(input({ ...MASSIMI, maxTotale: 1 }), 'locale');
  adesso += 8 * 86400000;
  const retention = creaRetention({ db, ora: () => adesso, pulisciExtra: cfg.pulisci });
  retention.pulisci();
  assert.equal(db.prepare('SELECT count(*) AS n FROM limiti_ricerca_audit').get().n, 0);
  assert.equal(cfg.stato().revisione, 1); assert.equal(cfg.stato().valori.maxTotale, 1);
});
test('limiti HTTP: Admin MFA, controllo origine e header, body limitato, audit senza email', async t => {
  const { c, sessions, req } = await centro(t);
  assert.equal((await req('/api/admin/limiti', undefined, 'cliente')).status, 403);
  assert.equal((await req('/api/admin/limiti', input(MASSIMI), 'cliente')).status, 403);
  sessions.admin.mfa = false; assert.equal((await req('/api/admin/limiti')).status, 403); sessions.admin.mfa = true;
  assert.equal((await req('/api/admin/limiti', input(MASSIMI), 'admin', { 'x-amr-local-admin': '0' })).status, 403);
  assert.equal((await req('/api/admin/limiti', input(MASSIMI), 'admin', { origin: 'https://altro.example.test' })).status, 403);
  assert.equal((await req('/api/admin/limiti', { ...input(MASSIMI), testo: 'x'.repeat(2000) })).status, 413);
  assert.equal((await req('/api/admin/limiti', input({ ...MASSIMI, maxTotale: 1 }))).status, 200);
  assert.equal((await (await req('/api/admin/limiti')).json()).valori.maxTotale, 1);
  assert.equal(c.db.prepare('SELECT operatore FROM limiti_ricerca_audit').get().operatore, sessions.admin.persona);
});
test('limiti HTTP: vecchia ricerca termina, retry riusa ID, nuova ammissione rispetta cap e pause', async t => {
  const { c, req } = await centro(t), id = randomUUID();
  const heartbeat = { id: 'a', revisione: 'imac-1', occupato: false, fonti: { subito: { fermo: true }, autoscout: { fermo: false } } };
  const headers = { 'x-amr-node-id': 'a', 'x-amr-node-token': 'a'.repeat(64) };
  await req('/_nodo/heartbeat', heartbeat, 'cliente', headers);
  const inizio = { id, input: { tipo: 'auto', marca: 'MarcaSintetica' } };
  assert.equal((await req('/api/ricerche', inizio, 'cliente')).status, 202);
  for (let n = 0; n < 100 && !c.lavori.size; n++) await new Promise(r => setTimeout(r, 5));
  const job = await (await req('/_nodo/poll?id=a', undefined, 'cliente', headers)).json();
  assert.equal((await req('/api/admin/limiti', input({ timeoutMs: 10000, maxPersona: 1, maxTotale: 1 }))).status, 200);
  assert.equal((await req('/api/ricerche', inizio, 'cliente')).status, 202);
  assert.equal((await req('/api/ricerche', { ...inizio, id: randomUUID() }, 'cliente')).status, 429);
  assert.equal(c.nodi.get('a').fonti.subito.fermo, true);
  assert.equal((await req('/_nodo/esito', { id: 'a', idLavoro: job.idLavoro, tentativo: job.tentativo,
    esito: { status: 200, body: { risultati: [], sources: { autoscout: { status: 'empty', count: 0 },
      subito: { status: 'skipped', count: 0 } } } } }, 'cliente', headers)).status, 200);
  let out;
  for (let n = 0; n < 100; n++) { out = await (await req('/api/ricerche/' + id, undefined, 'cliente')).json(); if (out.esito) break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal(out.esito.status, 200);
  assert.equal((await req('/api/ricerche', { ...inizio, id: randomUUID() }, 'cliente')).status, 202);
});
test('limiti HTTP: due utenti con stesse query ma revisioni diverse non condividono il job', async t => {
  const { c, req } = await centro(t);
  await req('/_nodo/heartbeat', { id: 'a', revisione: 'imac-1', occupato: false,
    fonti: { subito: { fermo: false }, autoscout: { fermo: false } } }, 'cliente',
    { 'x-amr-node-id': 'a', 'x-amr-node-token': 'a'.repeat(64) });
  const query = { tipo: 'auto', marca: 'MarcaSintetica' };
  assert.equal((await req('/api/ricerche', { id: randomUUID(), input: query }, 'cliente')).status, 202);
  for (let n = 0; n < 100 && c.lavori.size < 1; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal((await req('/api/admin/limiti', input({ ...MASSIMI, timeoutMs: 15000 }))).status, 200);
  assert.equal((await req('/api/ricerche', { id: randomUUID(), input: query }, 'cliente2')).status, 202);
  for (let n = 0; n < 100 && c.lavori.size < 2; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(c.lavori.size, 2);
  assert.deepEqual([...c.lavori.values()].map(j => j.destinatari.size), [1, 1]);
});
