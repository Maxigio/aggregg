'use strict';
const { test, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-vetrina-salute-'));
process.env.USER_DATA_PATH = dir;
process.env.AMR_LOG_DIR = dir;
process.env.AMR_WHATSAPP = '0';
require('dotenv').config = () => ({ parsed: {} });
const salute = require('../backend/fonti-salute');
const competitor = require('../backend/competitor');
const get = https.get, request = https.request, now = Date.now;
const URL_SUBITO = 'https://www.subito.it/shops/123-sintetico';
const HTML = '<title>Negozio sintetico</title><script>advertiser: { id: \'900123\' }</script>';
let ora;
afterEach(() => { https.get = get; https.request = request; Date.now = now; salute.azzera(); });
after(() => { salute._reset(); fs.rmSync(dir, { recursive: true, force: true }); });
function ambiente() {
  salute.azzera(); ora = 2000000000000; Date.now = () => ora;
  const pending = [];
  https.request = () => assert.fail('rete inattesa');
  https.get = (url, _opts, cb) => {
    assert.match(url, /^https:\/\/(www\.)?(subito|autoscout24)\.it\//);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = e => { if (e) req.emit('error', e); };
    pending.push({ url, req, cb });
    return req;
  };
  return {
    pending,
    scadi(fonte = 'subito') { ora = salute.fermo(fonte).fino + 1; },
    rispondi(status, body = '', headers = {}, index = pending.length - 1) {
      const res = new PassThrough(); res.statusCode = status; res.headers = headers;
      pending[index].cb(res); res.end(body);
    },
    async errore(status, url = URL_SUBITO, headers = {}) {
      const p = competitor.risolviVetrina(url);
      const n = pending.length;
      this.rispondi(status, '', headers);
      let errore;
      await assert.rejects(p, e => { errore = e; return e.status === status; });
      assert.equal(pending.length, n);
      return errore;
    },
  };
}

for (const status of [403, 429]) test(`vetrina Subito: HTTP ${status}, scala 15 → 60 → 360 senza doppi conteggi`, async () => {
  const t = ambiente();
  if (status === 403) {
    await t.errore(403); assert.equal(salute.fermo('subito').fermo, false);
  }
  for (const [i, finestra] of salute.FINESTRE.entries()) {
    if (i) t.scadi();
    const e = await t.errore(status, URL_SUBITO, { 'retry-after': '30' });
    assert.equal(e.retryAfter, '30');
    const fine = salute.fermo('subito').fino;
    assert.equal(fine - ora, finestra);
    salute.registra('subito', { errore: e });
    salute.registra('subito', { errore: e });
    assert.equal(salute.fermo('subito').fino, fine);
    const n = t.pending.length;
    await assert.rejects(competitor.risolviVetrina(URL_SUBITO), { code: 'FONTE_IN_PAUSA' });
    assert.equal(t.pending.length, n, 'il rifiuto locale non avvia HTTP');
  }
  assert.equal(t.pending.length, status === 403 ? 4 : 3);
});

test('vetrina 429: chiude il body prima di scaricarlo e conserva Retry-After', async () => {
  salute.azzera();
  let req, letti = 0;
  https.get = (_url, _opts, cb) => {
    const res = new PassThrough();
    res.statusCode = 429;
    res.headers = { 'retry-after': '120' };
    res.on('data', chunk => { letti += chunk.length; });
    req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => { req.destroyed = true; res.destroy(); return req; };
    process.nextTick(() => { cb(res); res.write(Buffer.alloc(1024 * 1024)); });
    return req;
  };
  await assert.rejects(competitor.risolviVetrina(URL_SUBITO),
    e => e.status === 429 && e.retryAfter === '120');
  assert.equal(req.destroyed, true);
  assert.equal(letti, 0);
  assert.equal(salute.fermo('subito').fermo, true);
});

test('un input locale non valido alla scadenza non consuma la verifica della fonte', async () => {
  const t = ambiente();
  salute.erroreHttp('subito', 429); salute.erroreHttp('autoscout', 429); t.scadi();
  const prima = ['subito', 'autoscout'].map(f => salute.fermo(f));
  for (const url of [
    'https://www.subito.it/shops/senza-id',
    'https://www.subito.it/shops/senza-id?link=/shops/123',
    'https://invalid.example/?next=https://www.subito.it/shops/123',
    'https://invalid.example/?next=https://www.autoscout24.it/concessionari/prova',
    'http://www.subito.it/shops/123',
    'https://[subito.it/shops/123',
  ]) {
    await assert.rejects(competitor.risolviVetrina(url));
    assert.equal(t.pending.length, 0);
    assert.deepEqual(['subito', 'autoscout'].map(f => salute.fermo(f)), prima);
  }
  const p = competitor.risolviVetrina(URL_SUBITO); assert.equal(t.pending.length, 1);
  t.rispondi(200, HTML); const r = await p;
  assert.equal(r.id, '900123'); assert.equal(r.shopId, '123');
  assert.equal(salute.fermo('subito').fino, null);
});

test('HTTP 200 senza id rimane una verifica fallita; il successo reale interrompe i 403 consecutivi', async () => {
  const t = ambiente();
  salute.erroreHttp('subito', 429); t.scadi();
  const illeggibile = competitor.risolviVetrina(URL_SUBITO);
  t.rispondi(200, '<html>nessuna vetrina</html>');
  await assert.rejects(illeggibile, /non espone l'id utente/);
  assert.equal(salute.fermo('subito').fino - ora, salute.FINESTRE[0]);
  t.scadi(); const riuscita = competitor.risolviVetrina(URL_SUBITO);
  t.rispondi(200, HTML); await riuscita;
  assert.equal(salute.fermo('subito').fermo, false);
  await t.errore(403);
  const normale = competitor.risolviVetrina(URL_SUBITO);
  t.rispondi(200, HTML); await normale;
  await t.errore(403);
  assert.equal(salute.fermo('subito').fermo, false, 'i due 403 sono separati da una vetrina letta correttamente');
});

test('una sola verifica concorrente; una risposta vecchia non toglie la nuova pausa', async () => {
  const t = ambiente();
  const vecchia = competitor.risolviVetrina(URL_SUBITO);
  salute.erroreHttp('subito', 429); t.scadi();
  const prova = competitor.risolviVetrina(URL_SUBITO);
  await assert.rejects(competitor.risolviVetrina(URL_SUBITO), { code: 'FONTE_IN_PAUSA' });
  assert.equal(t.pending.length, 2);
  t.rispondi(403, '', {}, 1); await assert.rejects(prova, { status: 403 });
  const fine = salute.fermo('subito').fino;
  assert.equal(fine - ora, salute.FINESTRE[1]);
  t.rispondi(200, HTML, {}, 0); await vecchia;
  assert.equal(salute.fermo('subito').fino, fine);
});

test('503 e guasto prima degli header: in verifica pausa breve, senza nuovo blocco', async () => {
  const t = ambiente();
  const e = await t.errore(503);
  assert.equal(e.kind, 'transient'); assert.equal(salute.fermo('subito').fermo, false);
  salute.erroreHttp('subito', 429); t.scadi();
  const p = competitor.risolviVetrina(URL_SUBITO);
  const errore = new Error('socket interrotto'); t.pending.at(-1).req.emit('error', errore);
  await assert.rejects(p, e => e === errore);
  assert.equal(salute.fermo('subito').fino - ora, salute.FINESTRE[0]);
  t.scadi(); await t.errore(429);
  assert.equal(salute.fermo('subito').fino - ora, salute.FINESTRE[1]);
});

test('il trasporto condiviso preserva anche gli errori HTTP della vetrina AutoScout', async () => {
  const t = ambiente(), url = 'https://www.autoscout24.it/concessionari/sintetico';
  await t.errore(403, url); assert.equal(salute.fermo('autoscout').fermo, false);
  const p = competitor.risolviVetrina(url);
  t.rispondi(200, '<h1>Concessionario sintetico</h1><script>{"customerId":"900123"}</script>');
  assert.equal((await p).id, '900123');
  await t.errore(403, url); assert.equal(salute.fermo('autoscout').fermo, false);
  await t.errore(403, url);
  assert.equal(salute.fermo('autoscout').fino - ora, salute.FINESTRE[0]);
});
