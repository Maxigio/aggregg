'use strict';
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), https = require('node:https'), zlib = require('node:zlib');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-moto-protezioni-'));
process.env.USER_DATA_PATH = dir; process.env.AMR_LOG_DIR = dir;
const salute = require('../backend/fonti-salute');
const ritmo = require('../backend/scrapers/motoit-ritmo');
const trasporto = require('../backend/scrapers/motoit-http');
const models = require('../backend/scrapers/motoit-models');
const detail = require('../backend/scrapers/detail');
const specs = require('../backend/scrapers/motoit-specs');
const moto = require('../backend/scrapers/motoit');
const get = https.get, attesa = ritmo.attendi;
let handler, hits = 0, port;
const srv = http.createServer((req, res) => { hits++; handler(req, res); });
before(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); port = srv.address().port;
  https.get = (url, opts, cb) => http.get(String(url).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), opts, cb);
});
afterEach(() => { salute.azzera(); ritmo.attendi = attesa; hits = 0; });
after(async () => {
  https.get = get; srv.closeAllConnections(); await new Promise(r => srv.close(r));
  salute._reset(); fs.rmSync(dir, { recursive: true, force: true });
});
const fast = () => { ritmo.attendi = async () => {}; };
const url = s => 'https://www.moto.it/' + s;

test('M01: la chiamata gia in coda non parte dopo un 429', async () => {
  handler = (_, res) => { res.writeHead(429, { 'retry-after': '900' }); res.end(); };
  const r = await Promise.allSettled([trasporto.get(url('prima')), trasporto.get(url('seconda'))]);
  assert.equal(hits, 1); assert.equal(r[0].reason.status, 429);
  assert.equal(r[1].reason.code, 'FONTE_IN_PAUSA');
});

for (const [nome, run] of [
  ['menu', i => models.getBrandModels('amr-403-' + i, { rilancia: true })],
  ['dettaglio', i => detail.getDetail(url('detail-403-' + i))],
]) test(`M02: due 403 ${nome}, non tre, fermano la fonte senza doppio conteggio`, async () => {
  fast(); handler = (_, res) => { res.writeHead(403); res.end(); };
  for (let i = 0; i < 3; i++) {
    try { await run(i); } catch (e) { salute.registra('moto', { errore: e }); }
    if (i === 0) assert.equal(salute.fermo('moto').fermo, false);
  }
  assert.equal(hits, 2); assert.equal(salute.fermo('moto').fermo, true);
});

test('M03/04: il menu malformato non sblocca la fonte; il vuoto valido si', async () => {
  fast(); salute.erroreHttp('moto', 429);
  const now = Date.now; let ora = salute.fermo('moto').fino + 1; Date.now = () => ora;
  handler = (_, res) => res.end('{"result":"KO","data":null}');
  try {
    await assert.rejects(models.getBrandModels('amr-prova-menu', { rilancia: true }), /non riconoscibile/);
    assert.equal(salute.fermo('moto').fermo, true);
    ora = salute.fermo('moto').fino + 1;
    handler = (_, res) => res.end('{"result":"OK","data":[{"value":"","text":"Tutti"}]}');
    const both = await Promise.all([models.getBrandModels('amr-prova-menu', { rilancia: true }), models.getBrandModels('amr-prova-menu', { rilancia: true })]);
    assert.deepEqual(both, [[], []]); assert.equal(hits, 2);
    assert.equal(salute.fermo('moto').fino, null);
  } finally { Date.now = now; }
});

test('M04: nessun superstite di un menu parziale entra in cache', async () => {
  fast(); handler = (_, res) => res.end(JSON.stringify({ result: 'OK', data: [
    { value: '', text: 'Tutte' }, { value: 'abc123', text: 'Versione (2020-22)' }, { id: 'nuovo', label: 'cambiato' },
  ] }));
  for (let i = 0; i < 2; i++) await assert.rejects(models.getModelBikes('amr-partial', 'prova', { rilancia: true }), /non riconoscibile/);
  assert.equal(hits, 2);
  handler = (_, res) => res.end('{"result":"OK","data":[{"value":"abc123","text":"Versione (2020-22)"}]}');
  assert.equal((await models.getModelBikes('amr-partial', 'prova', { rilancia: true }))[0].code, 'abc123');
});

for (const tipo of ['redirect', '429']) test(`M06: il body ${tipo} viene chiuso`, async () => {
  fast(); let closed;
  const finito = new Promise(r => { closed = r; });
  handler = (req, res) => {
    if (req.url === '/ok') return res.end('ok');
    res.writeHead(tipo === '429' ? 429 : 302, tipo === '429' ? { 'retry-after': '1800' } : { location: '/ok' });
    res.flushHeaders(); const timer = setInterval(() => res.write(Buffer.alloc(65536)), 5);
    res.on('close', () => { clearInterval(timer); closed(); });
  };
  if (tipo === '429') await assert.rejects(detail.getDetail(url('429')), { status: 429 });
  else assert.equal((await trasporto.get(url('redirect'))).body, 'ok');
  await Promise.race([finito, new Promise((_, no) => { const t = setTimeout(() => no(Error('socket ancora aperto')), 250); t.unref(); })]);
  assert.equal(hits, tipo === '429' ? 1 : 2);
});

test('M06: redirect fuori host e credenziali nella URL non partono', async () => {
  fast(); handler = (_, res) => { res.writeHead(302, { location: 'https://127.0.0.1/secret' }); res.end(); };
  await assert.rejects(trasporto.get(url('redirect')), /non consentito/);
  await assert.rejects(trasporto.get('https://user:pass@www.moto.it/test'), /non consentita/);
  assert.equal(hits, 1);
});

test('M07: dettagli e schede attraversano la stessa coda', async () => {
  let libera, n = 0;
  ritmo.attendi = () => { n++; return new Promise(r => { libera = r; }); };
  handler = (_, res) => res.end('<span>Cilindrata 899 cc</span>');
  const p = detail.getDetail(url('queued-detail')); await Promise.resolve();
  assert.equal(hits, 0); libera(); await p;
  const q = specs.httpGetText(url('queued-specs')); await Promise.resolve();
  assert.equal(hits, 1); libera(); await q; assert.equal(n, 2);
});

test('M07: gzip valido si legge, il limite riguarda i byte decompressi', async () => {
  fast(); let grande = false;
  handler = (_, res) => {
    res.setHeader('content-encoding', 'gzip');
    res.end(zlib.gzipSync(grande ? Buffer.alloc(3 * 1024 * 1024, 65) : 'scheda valida'));
  };
  assert.equal((await specs.httpGetText(url('gzip'))).body, 'scheda valida');
  grande = true; await assert.rejects(specs.httpGetText(url('big-gzip')), { code: 'MOTO_BODY_TOO_LARGE' });
  assert.equal(await detail.getDetail(url('big-detail')), null, 'il dettaglio resta best-effort, non accetta il body');
});

test('M07: la deadline interrompe un body attivo, senza aspettare inattivita', async t => {
  fast(); const original = setTimeout;
  t.mock.method(global, 'setTimeout', (fn, ms, ...args) => original(fn, ms > 25000 ? 60 : ms, ...args));
  handler = (_, res) => {
    res.writeHead(200); res.flushHeaders(); const timer = setInterval(() => res.write('x'), 5);
    res.on('close', () => clearInterval(timer));
  };
  await assert.rejects(specs.httpGetText(url('drip')), /timeout complessivo/);
});

test('M07: la cancellazione in coda non invia la richiesta', async () => {
  const ctrl = new AbortController();
  // Prenota il primo slot senza rete, poi interrompe l'attesa del secondo.
  await ritmo.attendi();
  const p = trasporto.get(url('annullata'), { signal: ctrl.signal }); ctrl.abort();
  await assert.rejects(p); assert.equal(hits, 0);
});

test('review M03: anche la pagina modello deve essere leggibile per riaprire la fonte', async () => {
  fast(); salute.erroreHttp('moto', 429);
  const now = Date.now; let ora = salute.fermo('moto').fino + 1; Date.now = () => ora;
  handler = (_, res) => res.end('<html>Manutenzione</html>');
  try {
    await assert.rejects(specs.fetchModelVersionsMeta('yamaha', 'mt-07'), /non riconoscibile/);
    assert.equal(salute.fermo('moto').fermo, true);
    ora = salute.fermo('moto').fino + 1;
    handler = (_, res) => res.end('<a href="/listino/yamaha/mt-07/versione/abcdef">Versione</a>');
    const meta = await specs.fetchModelVersionsMeta('yamaha', 'mt-07');
    assert.ok(meta.versioni.abcdef); assert.equal(salute.fermo('moto').fino, null);
  } finally { Date.now = now; }
});

test('review M02: un menu valido fra due 403 interrompe la serie dei rifiuti', async () => {
  fast();
  handler = (_, res) => {
    if (hits === 2) return res.end('{"result":"OK","data":[{"value":"abc123","text":"Versione valida"}]}');
    res.writeHead(403); res.end();
  };
  await assert.rejects(models.getModelBikes('amr-sequenza', 'prima', { rilancia: true }), { status: 403 });
  assert.equal((await models.getModelBikes('amr-sequenza', 'valida', { rilancia: true })).length, 1);
  await assert.rejects(models.getModelBikes('amr-sequenza', 'dopo', { rilancia: true }), { status: 403 });
  assert.equal(salute.fermo('moto').fermo, false, 'i 403 non sono consecutivi');
});
