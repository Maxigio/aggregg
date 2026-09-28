'use strict';
const { test, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-dettagli-429-'));
const prima = process.env.USER_DATA_PATH;
process.env.USER_DATA_PATH = dir;
const dotenv = require('dotenv');
const configOriginale = dotenv.config;
dotenv.config = () => ({ parsed: {} });
const salute = require('../backend/fonti-salute');
const { getDetail } = require('../backend/scrapers/detail');
const specs = require('../backend/scrapers/motoit-specs');
const getOriginale = https.get;
const oraOriginale = Date.now;
const ritmo = require('../backend/scrapers/motoit-ritmo'), attesaOriginale = ritmo.attendi;
const reteVietata = () => { throw new Error('rete reale vietata'); };
let ora;

beforeEach(() => {
  // Questo file verifica gli esiti, la coda reale e' coperta da motoit-protezioni.
  ritmo.attendi = async () => {};
  ora = 1800000000000;
  Date.now = () => ora;
  https.get = reteVietata;
  salute.azzera();
});
afterEach(() => {
  salute.azzera();
  salute._reset();
  https.get = reteVietata;
  Date.now = oraOriginale;
  ritmo.attendi = attesaOriginale;
});
after(() => {
  salute._reset();
  https.get = getOriginale;
  dotenv.config = configOriginale;
  if (prima === undefined) delete process.env.USER_DATA_PATH;
  else process.env.USER_DATA_PATH = prima;
  fs.rmSync(dir, { recursive: true, force: true });
});

// Solo eventi in memoria: hold non invia mai il body finche' la prova non lo libera.
function risposte(...coda) {
  const richieste = [];
  https.get = (url, opts, callback) => {
    const risposta = coda[richieste.length];
    assert.ok(risposta, `richiesta inattesa: ${url}`);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = e => { req.destroyed = true; if (e) req.emit('error', e); };
    const res = new EventEmitter();
    res.statusCode = risposta.status;
    res.headers = risposta.headers || {};
    res.setEncoding = () => {};
    const voce = { url: String(url), drained: false, closed: false, fine() {
      if (voce.closed) return;
      res.complete = true;
      res.emit('data', Buffer.from(risposta.body || '<html></html>'));
      res.emit('end');
      res.emit('close');
    } };
    res.destroy = () => { voce.closed = true; res.emit('aborted'); res.emit('close'); };
    res.resume = () => {
      voce.drained = true;
      res.complete = true;
      if (risposta.onResume) risposta.onResume();
    };
    richieste.push(voce);
    process.nextTick(() => {
      callback(res);
      if (risposta.afterHeaders) risposta.afterHeaders(res);
      if (!risposta.hold && !voce.drained) voce.fine();
    });
    return req;
  };
  return richieste;
}

function scadi(fonte) {
  salute.erroreHttp(fonte, 429);
  ora = salute.fermo(fonte).fino + 1;
}

for (const [fonte, host] of [['subito', 'www.subito.it'], ['autoscout', 'autoscout24.it'], ['moto', 'www.moto.it']]) {
  test(`detail ${fonte}: 429 agli header ferma subito; nessun body o secondo HTTP`, { timeout: 1000 }, async () => {
    const chiamate = risposte({ status: 429, hold: true, headers: { 'retry-after': '7200' },
      onResume: () => assert.equal(salute.fermo(fonte).fermo, true) });
    const url = `https://${host}/dettaglio-429`;
    await assert.rejects(getDetail(url), { status: 429, kind: 'blocked', retryAfter: '7200' });
    assert.equal(salute.fermo(fonte).fino, ora + 7200000);
    await assert.rejects(getDetail(url), { code: 'FONTE_IN_PAUSA' });
    assert.equal(chiamate.length, 1);
    assert.equal(chiamate[0].drained, fonte !== 'moto');
    assert.equal(chiamate[0].closed, fonte === 'moto');
    for (const altra of ['subito', 'autoscout', 'moto'].filter(f => f !== fonte)) {
      assert.equal(salute.fermo(altra).fermo, false);
    }
  });
}

test('detail: la cache resta leggibile in pausa, un cache-miss non esce', async () => {
  const chiamate = risposte({ status: 200, body: '{"rawPowerInHp":123}' });
  const url = 'https://www.autoscout24.it/dettaglio-cache';
  const caldo = await getDetail(url);
  assert.equal(caldo.potenzaCv, 123);
  salute.erroreHttp('autoscout', 429);
  assert.strictEqual(await getDetail(url), caldo);
  await assert.rejects(getDetail(url + '-freddo'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
});

test('specs: 429 con Retry-After ferma anche detail e preserva errore tipizzato', { timeout: 1000 }, async () => {
  const chiamate = risposte({ status: 429, hold: true, headers: { 'retry-after': '7200' },
    onResume: () => assert.equal(salute.fermo('moto').fermo, true) });
  await assert.rejects(specs.fetchMotoitSpecs('https://www.moto.it/listino/prova'),
    e => e.status === 429 && e.kind === 'blocked' && e.retryAfter === '7200');
  await assert.rejects(getDetail('https://moto.it/dettaglio-dopo-specs'), { code: 'FONTE_IN_PAUSA' });
  await assert.rejects(specs.httpGetText('https://dealer.moto.it/listino/prova'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
});

test('specs: HTTP 401 conserva il genere auth e non mette in pausa', async () => {
  risposte({ status: 401 });
  await assert.rejects(specs.httpGetText('https://www.moto.it/listino/auth'),
    e => e.status === 401 && e.kind === 'auth');
  assert.equal(salute.fermo('moto').fermo, false);
});

test('specs: un 200 privo di scheda valida non conclude la verifica', async () => {
  scadi('moto');
  const chiamate = risposte({ status: 200, body: '<html><h1>Temporarily unavailable</h1></html>' });
  await assert.rejects(specs.fetchMotoitSpecs('https://www.moto.it/listino/prova-semantica'), /scheda non disponibile/);
  assert.equal(salute.fermo('moto').fermo, true);
  await assert.rejects(specs.httpGetText('https://www.moto.it/listino/dopo-prova'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
});

test('specs: il reset del body dopo gli header 429 ha gia un listener', async () => {
  const nonGestiti = [];
  const chiamate = risposte({ status: 429, hold: true, afterHeaders(res) {
    try { res.emit('error', Object.assign(new Error('aborted'), { code: 'ECONNRESET' })); }
    catch (e) { nonGestiti.push(e.code); }
    res.emit('aborted');
  } });
  await assert.rejects(specs.fetchMotoitSpecs('https://www.moto.it/listino/reset-dopo-429'), { status: 429 });
  assert.deepEqual(nonGestiti, []);
  assert.equal(chiamate.length, 1);
  assert.equal(salute.fermo('moto').fermo, true);
});

test('specs: dopo la scadenza un solo tentativo include redirect e validazione della scheda', async () => {
  scadi('moto');
  const chiamate = risposte({ status: 302, headers: { location: '/listino/finale' } },
    { status: 200, hold: true, body: '<table><tr><td>Allestimento</td><td>MT-07</td></tr><tr><td>Cilindrata</td><td>689 cc</td></tr></table>' });
  const prova = specs.fetchMotoitSpecs('https://www.moto.it/listino/redirect');
  await new Promise(setImmediate);
  assert.equal(chiamate.length, 2);
  assert.equal(chiamate[1].url, 'https://www.moto.it/listino/finale');
  await assert.rejects(specs.httpGetText('https://www.moto.it/listino/concorrente'), { code: 'FONTE_IN_PAUSA' });
  await assert.rejects(getDetail('https://www.moto.it/dettaglio-concorrente'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 2);
  chiamate[1].fine();
  const scheda = await prova;
  assert.equal(scheda.head.allestimento, 'MT-07');
  assert.ok(scheda.groups.length > 0);
  assert.equal(salute.fermo('moto').fino, null);
});

test('detail: un non-200 non chiude la pausa anche se il chiamante restituisce null', async () => {
  scadi('subito');
  const chiamate = risposte({ status: 503 });
  const url = 'https://subito.it/dettaglio-verifica-ko';
  assert.equal(await getDetail(url), null);
  assert.equal(salute.fermo('subito').fermo, true);
  await assert.rejects(getDetail(url), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
});

test('detail: eccezione del parser dopo HTTP 200 mantiene pausa e contratto null', async () => {
  scadi('autoscout');
  const body = '{"rawPowerInHp":123,"provaParser":"fallisce"}';
  const chiamate = risposte({ status: 200, body });
  const match = String.prototype.match;
  // Simula un'eccezione del parser solo su questo body, senza aggiungere hook al modulo.
  String.prototype.match = function (re) {
    if (String(this) === body) throw new Error('parser non disponibile');
    return match.call(this, re);
  };
  const url = 'https://www.autoscout24.it/annunci/prova-parser';
  try { assert.equal(await getDetail(url), null); }
  finally { String.prototype.match = match; }
  assert.equal(salute.fermo('autoscout').fermo, true);
  await assert.rejects(getDetail(url), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
});

for (const status of [302, 404, 503]) {
  test(`specs: HTTP terminale ${status} rigetta dentro la verifica`, async () => {
    scadi('moto');
    const chiamate = risposte({ status });
    await assert.rejects(specs.httpGetText('https://www.moto.it/listino/non-200'), e => e.status === status);
    assert.equal(salute.fermo('moto').fermo, true);
    assert.equal(chiamate.length, 1);
  });
}

test('detail: il redirect verso un altro sito rispetta la sua pausa', async () => {
  salute.erroreHttp('autoscout', 429);
  const chiamate = risposte({ status: 302, headers: { location: 'https://www.autoscout24.it/annunci/destinazione' } });
  await assert.rejects(getDetail('https://www.subito.it/dettaglio-redirect-fonte'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
  assert.equal(salute.fermo('subito').fermo, false);
});

test('detail e specs: host esterni vietati anche dopo redirect, senza HTTP esterno', async () => {
  const esterno = 'https://example.com/privato';
  await assert.rejects(getDetail(esterno), /host not allowed/);
  await assert.rejects(specs.httpGetText(esterno), /destinazione Moto.it non consentita/);
  const chiamate = risposte({ status: 302, headers: { location: esterno } },
    { status: 302, headers: { location: esterno } });
  assert.equal(await getDetail('https://www.moto.it/dettaglio-ssrf'), null);
  await assert.rejects(specs.httpGetText('https://www.moto.it/listino/ssrf'), /redirect Moto.it non consentito/);
  assert.equal(chiamate.length, 2);
  assert.ok(chiamate.every(c => new URL(c.url).hostname === 'www.moto.it'));
});

test('detail: HTTP 200 senza campi leggibili non conferma la ripartenza', async () => {
  scadi('subito');
  const chiamate = risposte({ status: 200, body: '<html>manutenzione</html>' });
  await assert.rejects(getDetail('https://www.subito.it/dettaglio-manutenzione'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(salute.fermo('subito').fermo, true);
  await assert.rejects(getDetail('https://www.subito.it/dettaglio-manutenzione'), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate.length, 1);
});
