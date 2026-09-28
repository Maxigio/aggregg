'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Montiamo la rotta vera senza avviare server o leggere credenziali.
test('il limite PDF rifiuta la troncatura e lascia integro un export ammesso', () => {
  let handler, render = 0, righe, avvisi;
  require('../backend/report-route').mount({ post: (url, ...hs) => {
    if (url === '/api/report-pdf') handler = hs.at(-1);
  } }, {
    limitePdf: { consuma: () => ({ ok: true }) }, chiaveLimite: () => 'test',
    renderReportPdf: (_r, _p, x) => { render++; righe = x.righe; avvisi = x.avvisi; return Buffer.from('pdf'); },
  });
  const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(x) { this.body = x; return this; }, setHeader() {}, send(x) { this.body = x; } });
  const troppi = res(); handler({ body: { righe: Array.from({ length: 2001 }, (_, i) => [i]) } }, troppi);
  assert.equal(troppi.code, 400); assert.match(troppi.body.error, /2\.000.*CSV/); assert.equal(render, 0);
  const giusti = res(); handler({ body: { righe: Array.from({ length: 2000 }, (_, i) => [i]) } }, giusti);
  assert.equal(giusti.code, 200); assert.equal(render, 1); assert.equal(righe.length, 2000); assert.equal(righe[1999][0], 1999);
  for (const note of ['testo', [1], Array(11).fill('nota'), ['x'.repeat(4001)]]) {
    const r = res(); handler({ body: { righe: [['riga']], avvisi: note } }, r);
    assert.equal(r.code, 400); assert.equal(render, 1);
  }
  const ammesso = res(), note = Array(10).fill('x'.repeat(400));
  handler({ body: { righe: [['riga']], avvisi: note } }, ammesso);
  assert.equal(ammesso.code, 200); assert.equal(render, 2); assert.deepEqual(avvisi, note);
});

test('il PDF prodotto conserva gli avvisi anche con sottotitolo lungo e avvisi su più pagine', () => {
  const { renderReportPdf } = require('../backend/report-pdf');
  const base = { titolo: 'Report annunci', sottotitolo: 'Criteri di ricerca sintetici '.repeat(30),
    colonne: ['Fonte', 'Annuncio'], righe: [['Subito', 'ULTIMA-RIGA']], colonneStile: {}, fonti: ['subito'] };
  for (const avvisi of [
    ['Prima pagina, copertura parziale.', 'Totale grezzo: 75.', 'Prezzo non leggibile.'],
    Array.from({ length: 10 }, (_, i) => `AVVISO-${i} ` + 'Testo completo senza troncatura. '.repeat(12)),
  ]) {
    const pdf = renderReportPdf([], {}, { ...base, avvisi }).toString('latin1');
    assert.match(pdf, /ULTIMA-RIGA/);
    for (const a of avvisi) assert.ok(pdf.includes(a.split(' ').slice(0, 2).join(' ')), a);
  }
});

test('la UI mostra il motivo del rifiuto PDF, non soltanto HTTP 400', async () => {
  const app = require('../scripts/build-frontend').frontendSourceSync().js;
  const start = app.indexOf('function scaricaPdf(');
  const avvisi = [];
  const ctx = vm.createContext({ fetch: async () => ({ ok: false, status: 400,
    json: async () => ({ error: 'Massimo 2.000 annunci: usa CSV.' }) }),
    console: { error() {} }, showError: x => avvisi.push(x),
  });
  vm.runInContext(app.slice(start, app.indexOf('\n}', start) + 2), ctx);
  await ctx.scaricaPdf({ righe: [] });
  assert.deepEqual(avvisi, ['PDF non generato: Massimo 2.000 annunci: usa CSV.']);
});
