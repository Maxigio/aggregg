'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
function funzione(nome) {
  const a = app.indexOf('function ' + nome + '(');
  return app.slice(a, app.indexOf('\n}', a) + 2);
}
function schermo(extra = {}) {
  const ctx = vm.createContext({ rcEur: p => Number.isFinite(p) ? 'EUR ' + p : null,
    escapeHtml: x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    cpRiga: (k, v) => `${k}: ${v}`, cpNum: String, ...extra,
  });
  vm.runInContext(['rcPriceText', 'rcNoteSubito', 'cpNumeriChiave', 'cpGruppoNumeriHTML'].map(funzione).join('\n'), ctx);
  return ctx;
}
test('prezzo assente, illeggibile, richiesto e zero restano distinti anche nel PDF', () => {
  let payload;
  const arts = [{ prezzo: null }, { prezzo: null, prezzoIlleggibile: true },
    { prezzo: null, prezzoSuRichiesta: true }, { prezzo: 0 }, { prezzo: 25 }].map(x => ({ fonte: 'subito', ...x }));
  const ctx = schermo({ rcCurrentList: () => arts, rcData: { sources: { subito: { status: 'ok', total: 75, truncated: true } } },
    priceCfgR: {}, priceExtraHeaders: () => [], priceExtraValues: () => [], rPricing: () => null,
    scaricaPdf: x => { payload = x; }, showError: assert.fail,
  });
  const attesi = ['prezzo non indicato', 'prezzo non leggibile', 'su richiesta', 'EUR 0', 'EUR 25'];
  assert.deepEqual(arts.map(a => ctx.rcPriceText(a)), attesi);
  vm.runInContext(funzione('exportPdfRicambi'), ctx); ctx.exportPdfRicambi();
  assert.deepEqual(Array.from(payload.righe, r => r[3]), attesi);
  assert.match(payload.avvisi.join(' '), /prima pagina.*75/);
});
test('copertura: totale grezzo distinto da count filtrato, sconosciuto non inventato', () => {
  const ctx = schermo();
  assert.match(ctx.rcNoteSubito({ total: 75, count: 9, truncated: true }).join(' '), /prima dei filtri AMR: 75/);
  assert.equal(ctx.rcNoteSubito({ total: 50, truncated: false }).length, 0);
  assert.match(ctx.rcNoteSubito({ status: 'empty', total: null }).join(' '), /non ha comunicato/);
});
test('Competitor: avvisi di campi illeggibili visibili e con escape, senza falsi annunci persi', () => {
  const ctx = schermo();
  const note = [{ tipo: 'auto', motivo: '<img src=x> prezzo non leggibile' }];
  const single = ctx.cpNumeriChiave({ veicoli: 1 }, null, {}, false, 0, 1, null, note);
  const group = ctx.cpGruppoNumeriHTML({ veicoli: [{}], parti: [{ voce: { nome: 'Test' }, avvisiLettura: note }] }, [{}]);
  for (const html of [single, group]) {
    assert.match(html, /prezzo non leggibile/); assert.match(html, /restano inclusi/);
    assert.doesNotMatch(html, /<img|parziale|calcolati senza/);
  }
});
