'use strict';
// Il log dei test non va nel registro operativo vero (vedi backend/logger.js): deve stare
// PRIMA di ogni require di backend, perche' LOG_DIR e' una const valutata al caricamento.
const osTmp = require('node:os'), fsTmp = require('node:fs'), pathTmp = require('node:path');
process.env.AMR_LOG_DIR = fsTmp.mkdtempSync(pathTmp.join(osTmp.tmpdir(), 'amr-log-'));

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const wh = require('../backend/whatsapp/webhook');
const { renderReportPdf, reportStats } = require('../backend/report-pdf');
const { renderRicambiPdf, ricambiStats } = require('../backend/report-pdf-ricambi');
const logger = require('../backend/logger');
const { normOen, dedupeOe } = require('../backend/oem-lookup');
const { cleanHistory } = require('../backend/whatsapp/bot');

// mock res minimale (cattura status/body)
function mockRes() {
  return {
    code: null, body: null, sent: false,
    status(c) { this.code = c; return this; },
    send(b) { this.body = b; this.sent = true; return this; },
    sendStatus(c) { this.code = c; this.sent = true; return this; },
  };
}
const sign = (secret, buf) => 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');

// ─── firma HMAC ───────────────────────────────────────────────────────────────
test('verifySignature: firma valida passa, alterata no', () => {
  process.env.WHATSAPP_APP_SECRET = 'segreto-test';
  const raw = Buffer.from(JSON.stringify({ hello: 'world' }));
  assert.strictEqual(wh.verifySignature(raw, sign('segreto-test', raw)), true);
  assert.strictEqual(wh.verifySignature(raw, sign('altro-segreto', raw)), false);          // secret sbagliato
  assert.strictEqual(wh.verifySignature(Buffer.from('{"x":1}'), sign('segreto-test', raw)), false); // body alterato
  assert.strictEqual(wh.verifySignature(raw, 'sha256=deadbeef'), false);                    // firma spazzatura
  assert.strictEqual(wh.verifySignature(raw, null), false);                                 // header assente
});

test('verifySignature: senza APP_SECRET rifiuta sempre', () => {
  const prev = process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_APP_SECRET;
  const raw = Buffer.from('{}');
  assert.strictEqual(wh.verifySignature(raw, sign('x', raw)), false);
  process.env.WHATSAPP_APP_SECRET = prev;
});

// ─── handshake GET ──────────────────────────────────────────────────────────────
test('handleVerify: token giusto → 200 + challenge; sbagliato → 403', () => {
  process.env.WHATSAPP_VERIFY_TOKEN = 'vt-123';
  const ok = mockRes();
  wh.handleVerify({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt-123', 'hub.challenge': '42' } }, ok);
  assert.strictEqual(ok.code, 200);
  assert.strictEqual(ok.body, '42');

  const ko = mockRes();
  wh.handleVerify({ query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'sbagliato', 'hub.challenge': '42' } }, ko);
  assert.strictEqual(ko.code, 403);
});

// ─── POST gating ────────────────────────────────────────────────────────────────
test('handlePost: firma valida → 200, firma non valida → 401, body non-buffer → 400', () => {
  process.env.WHATSAPP_APP_SECRET = 'segreto-test';
  const raw = Buffer.from(JSON.stringify({ entry: [] }));   // niente messaggi → processPayload no-op
  const reqGood = { body: raw, get: h => (h.toLowerCase() === 'x-hub-signature-256' ? sign('segreto-test', raw) : undefined) };
  const rGood = mockRes();
  wh.handlePost(reqGood, rGood, async () => ({}));
  assert.strictEqual(rGood.code, 200);

  const reqBad = { body: raw, get: () => 'sha256=00' };
  const rBad = mockRes();
  wh.handlePost(reqBad, rBad, async () => ({}));
  assert.strictEqual(rBad.code, 401);

  const reqNoBuf = { body: { not: 'a buffer' }, get: () => undefined };
  const rNoBuf = mockRes();
  wh.handlePost(reqNoBuf, rNoBuf, async () => ({}));
  assert.strictEqual(rNoBuf.code, 400);
});

test('handlePost: senza APP_SECRET la webhook NON risponde (503)', () => {
  // Prima qui si asseriva il contrario — 200, "MVP no-firma" — e quel 200 era il difetto:
  // e' l'unica rotta senza autenticazione, sta su internet mentre tutto il resto e' dietro
  // login, e dentro gira una ricerca vera verso le tre fonti dall'IP di casa. Senza segreto
  // non si accetta niente, e chi la vuole accesa mette la variabile.
  const prev = process.env.WHATSAPP_APP_SECRET;
  delete process.env.WHATSAPP_APP_SECRET;
  const raw = Buffer.from(JSON.stringify({ entry: [] }));
  let chiamata = false;
  const r = mockRes();
  wh.handlePost({ body: raw, get: () => undefined }, r, async () => { chiamata = true; return {}; });
  assert.strictEqual(r.code, 503);
  assert.strictEqual(chiamata, false, 'la ricerca non deve nemmeno partire');
  if (prev === undefined) delete process.env.WHATSAPP_APP_SECRET; else process.env.WHATSAPP_APP_SECRET = prev;
});

// ─── allowlist ────────────────────────────────────────────────────────────────
test('allowed: elenco vuoto = NESSUNO; csv filtra per sole cifre', () => {
  const prev = process.env.WHATSAPP_ALLOWED_SENDERS;
  process.env.WHATSAPP_ALLOWED_SENDERS = '';
  // Prima l'elenco vuoto valeva "tutti", e il `from` lo scrive chi manda il payload: era anche
  // il modo di aggirare il rate limit, che e' chiavato proprio su quel numero.
  assert.strictEqual(wh.allowed('393520727252'), false, 'elenco vuoto non deve aprire a chiunque');
  delete process.env.WHATSAPP_ALLOWED_SENDERS;
  assert.strictEqual(wh.allowed('393520727252'), false, 'variabile assente = come vuota');
  process.env.WHATSAPP_ALLOWED_SENDERS = '+39 352 072 7252, 39111';
  assert.strictEqual(wh.allowed('393520727252'), true);        // match ignorando spazi/+
  assert.strictEqual(wh.allowed('399999999'), false);          // non in lista
  process.env.WHATSAPP_ALLOWED_SENDERS = prev;
});

// ─── PDF server-side ────────────────────────────────────────────────────────────
test('renderReportPdf: ritorna un Buffer PDF; reportStats calcola mediana', () => {
  const rows = [
    { fonte: 'subito', titolo: 'A', prezzo: 10000, anno: 2018, km: 50000, carburante: 'Diesel', provincia: 'MI' },
    { fonte: 'autoscout', titolo: 'B', prezzo: 20000, anno: 2019, km: 40000, carburante: 'Benzina', provincia: 'RM' },
    { fonte: 'moto', titolo: 'C senza prezzo', prezzo: null, anno: 2017, km: 90000, carburante: 'Diesel', provincia: 'TO' },
  ];
  const buf = renderReportPdf(rows, { marca: 'Audi', modello: 'A3' });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  const s = reportStats(rows);
  assert.deepStrictEqual([s.totale, s.conPrezzo, s.min, s.mediana, s.media, s.max], [3, 2, 10000, 15000, 15000, 20000]);
});

test('renderReportPdf: 0 risultati non crasha', () => {
  const buf = renderReportPdf([], { marca: 'Fiat', modello: 'Panda' });
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  assert.deepStrictEqual(reportStats([]), { totale: 0, conPrezzo: 0, min: null, mediana: null, media: null, max: null });
});

// ─── PDF ricambi (bot multi-fonte) ────────────────────────────────────────────
test('renderRicambiPdf: ritorna Buffer PDF; ricambiStats calcola min/max', () => {
  const arts = [
    { fonte: 'autodoc', nome: 'Bloccasterzo', marca: 'TOPRAN', prezzo: 30.99, venditore: 'Autodoc' },
    { fonte: 'subito', nome: 'Serratura usata', prezzo: 25, venditore: 'privato' },
    { fonte: 'web', nome: 'Ricambio OE', prezzo: null, venditore: 'ricambi.it' },
  ];
  const buf = renderRicambiPdf(arts, { oen: '1K0905851B', tipoPezzo: 'Bloccasterzo', veicoli: 'VW Golf' });
  assert.ok(Buffer.isBuffer(buf) && buf.length > 0);
  assert.strictEqual(buf.slice(0, 5).toString(), '%PDF-');
  const s = ricambiStats(arts);
  assert.deepStrictEqual([s.totale, s.conPrezzo, s.min, s.max], [3, 2, 25, 30.99]);
  assert.strictEqual(renderRicambiPdf([], {}).slice(0, 5).toString(), '%PDF-');   // 0 articoli non crasha
});

// ─── logger: redazione segreti + ring-buffer ──────────────────────────────────
test('logger: redige i segreti nel ring-buffer, timestamp ISO', () => {
  logger.error('[test]', 'chiave sk-ant-ABCDEFGHIJKLMNOP nel messaggio');
  const last = logger.tail(5).join('\n');
  assert.ok(last.includes('***'), 'segreto non redatto');
  assert.ok(!last.includes('sk-ant-ABCDEFGHIJKLMNOP'), 'segreto trapelato nel buffer');
  assert.ok(/\d{4}-\d\d-\d\dT.*ERROR/.test(last), 'manca timestamp/livello');
});

// ─── OEM lookup: normalizzazione codice ─────────────────────────────────────────
// ─── cleanHistory: niente coppie tool spezzate / orfani (evita Anthropic 400) ────
const uStr = t => ({ role: 'user', content: t });
const aText = t => ({ role: 'assistant', content: [{ type: 'text', text: t }] });
const aTool = id => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'x', input: {} }] });
const uToolRes = id => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'r' }] });

test('cleanHistory: turno completo resta invariato', () => {
  const h = [uStr('ciao'), aText('ciao!')];
  assert.deepStrictEqual(cleanHistory(h), h);
});
test('cleanHistory: coda con tool_use non risposto / tool_result orfano → troncata al turno pulito', () => {
  const h = [uStr('a'), aText('b'), aTool('t1'), uToolRes('t1')];   // MAX_ITERS exhaustion
  assert.deepStrictEqual(cleanHistory(h), [uStr('a'), aText('b')]);
});
test('cleanHistory: nessun turno assistant completo → vuoto (fresh start sicuro)', () => {
  assert.deepStrictEqual(cleanHistory([uStr('a'), aTool('t1'), uToolRes('t1')]), []);
});

test('normOen: maiuscolo + solo alfanumerici', () => {
  assert.strictEqual(normOen('1k0 905 851 b'), '1K0905851B');
  assert.strictEqual(normOen(' 06J-115.403Q '), '06J115403Q');
  assert.strictEqual(normOen(''), '');
  assert.strictEqual(normOen(null), '');
  assert.strictEqual(normOen('a/b_c'), 'ABC');
});

// ─── dedupeOe: codici OE equivalenti — esclude self, deduplica, scarta non-codici ─────
test('dedupeOe: esclude il codice cercato, deduplica, scarta i non-codici', () => {
  const r = dedupeOe(['1K0 905 851 B', '1K0905851B', '06A 906 032 HP', 'testo a caso', '12', '06A 906 032 HP'], '1K0905851B');
  assert.deepStrictEqual(r, ['06A 906 032 HP']);   // self (2 forme) esclusa, HP deduplicato, "testo"/"12" scartati
  assert.deepStrictEqual(dedupeOe([], 'X'), []);
  assert.deepStrictEqual(dedupeOe(null, 'X'), []);
});
