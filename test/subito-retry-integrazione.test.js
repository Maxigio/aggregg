'use strict';
// Percorso UI -> handler Express -> core -> scraper: solo trasporto e DOM sono sostituiti.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-retry-integrazione-'));
process.env.USER_DATA_PATH = dir; process.env.AMR_LOG_DIR = dir;
process.env.AMR_WHATSAPP = '0'; process.env.AMR_ASTE_LOCALE = '0';
require('dotenv').config = () => ({ parsed: {} });
const get = https.get, request = https.request, now = Date.now;
https.get = () => { throw new Error('Richiesta live vietata nel test'); };
const sub = require('../backend/scrapers/subito-api');
const salute = require('../backend/fonti-salute');
const server = require('../backend/server');
const handler = server.app.router.stack.find(l => l.route?.path === '/api/search').route.stack.at(-1).handle;
const app = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const codice = app.slice(app.indexOf('let searchGen = 0;'), app.indexOf('// ─── Slider prezzo'));
after(() => { sub._setHttpGetJson(null); https.get = get; https.request = request; Date.now = now; salute._reset(); fs.rmSync(dir, { recursive: true, force: true }); });

for (const errore of [503, 429]) test(`ricerca iniziale: nessun recupero automatico anche se il ramo separato darebbe HTTP ${errore}`, async () => {
  salute.azzera();
  let ora = now(), fail = true, asCalls = 0;
  Date.now = () => ora;
  class Clock extends Date { static now() { return ora; } }
  const hades = [], urls = [], statuses = [];
  const ad = id => ({ urn: `id:ad:synthetic:list:${id}`, subject: 'Fiat Panda',
    urls: { default: `https://www.subito.it/auto/panda-${id}.htm` },
    features: [{ uri: '/price', label: 'Prezzo', values: [{ value: '10000 €' }] }] });
  sub._setHttpGetJson(async p => {
    const q = new URL('https://mock.invalid' + p).searchParams;
    const recovery = q.get('cm') === '000000';
    hades.push([recovery ? 'recupero' : 'nativo', q.get('start')]);
    if (recovery && fail) return { status: errore, headers: {}, body: '{}' };
    return { status: 200, body: JSON.stringify({ ads: [ad(recovery ? 2 : 1)], count_all: 1 }) };
  });
  https.request = (options, cb) => {
    assert.equal(options.host, 'listing-search.api.autoscout24.com');
    const req = new EventEmitter(); req.write = () => {}; req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      asCalls++;
      const res = new EventEmitter(); res.statusCode = 200; res.headers = {}; res.setEncoding = () => {};
      cb(res); res.emit('data', JSON.stringify({ data: { search: { listings: { metadata: { totalItems: 1 },
        listings: [{ id: 'as1', details: { webPage: 'https://www.autoscout24.it/annunci/panda-1',
          prices: { public: { amountInEUR: { raw: 10000 } } }, vehicle: { classification: {
            make: { formatted: 'Fiat' }, model: { formatted: 'Panda' } } } } }] } } } })); res.emit('end');
    });
    return req;
  };
  const fields = Object.fromEntries(['modello', 'prezzoMin', 'prezzoMax', 'annoMin', 'annoMax', 'kmMin', 'kmMax', 'raggio']
    .map(k => [k, { value: k === 'modello' ? 'Panda' : k === 'prezzoMin' ? String(errore) : '' }]));
  const button = {}, box = { classList: { toggle() {} }, querySelector: () => button };
  const ctx = vm.createContext({ URLSearchParams, Date: Clock, setTimeout: () => 1, clearTimeout() {},
    searchGen: 0, searchActive: false, currentResults: [], lastSources: null, lastSearchParams: null,
    currentTipo: () => 'auto', matchedBrand: () => ({ nome: 'Fiat' }), selectedModel: null,
    versioneInput: { value: 'Nessuna Versione' }, sceltaVersione: () => ({ versione: null }),
    regioneSelect: { value: '' }, filtriAutoScelti: () => ({}),
    document: { getElementById: id => id === 'caricaAltri' ? box : fields[id], body: { dataset: {}, classList: { add() {} } } },
    closeMatrix() {}, showLoading() {}, hideResults() {}, liqCarica() {}, colsDefault: () => [], syncColMenu() {},
    hideLoading() {}, showError: assert.fail, renderSourceStatus() {}, renderResults() {}, initPrezzoSlider() {},
    prezzoSliderInstance: null, manigliePrezzoStrette: () => null, toast() {}, resultsToolbar: { scrollIntoView() {} },
    FONTE_LABEL: { subito: 'Subito', autoscout: 'AutoScout', moto: 'Moto.it' },
    fetch: async url => {
      urls.push(url); const query = Object.fromEntries(new URL('https://mock.invalid' + url).searchParams);
      let status = 200, body;
      await handler({ query, authId: 'test', authRole: 'full', ip: '127.0.0.1', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
        { status(n) { status = n; return this; }, json(d) { body = d; return this; }, setHeader() {} });
      statuses.push(status); return { ok: status === 200, status, json: async () => body };
    },
  });
  vm.runInContext(codice, ctx);
  await ctx.doSearch();
  assert.equal(ctx.currentResults.length, 2); assert.equal(asCalls, 1);
  assert.deepEqual(hades, [['nativo', '0']]);
  await ctx.caricaAltri(); assert.equal(urls.length, 1, 'nessuna pagina aggiuntiva richiesta');
  ora += 3_600_000; fail = false;
  await ctx.caricaAltri();
  assert.deepEqual(statuses, [200]);
  assert.deepEqual(hades, [['nativo', '0']]);
  assert.equal(asCalls, 1);
  assert.equal(ctx.currentResults.filter(r => r.fonte === 'subito').length, 1);
  assert.equal(ctx.currentResults.filter(r => r.fonte === 'autoscout').length, 1);
  assert.equal(ctx.lastSources.subito.hasMore, false);
  assert.equal(vm.runInContext('fettaPresa', ctx), 0);
});
