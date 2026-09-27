'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../frontend/app.js'), 'utf8');
const estrai = name => {
  const m = new RegExp('^(?:async )?function ' + name + '\\(', 'm').exec(app);
  return app.slice(m.index, app.indexOf('\n}', m.index) + 2);
};
function schermo() {
  const richieste = [];
  const input = { value: 'https://www.subito.it/negozi/prova' }, btn = {};
  const ctx = vm.createContext({
    cpParchi: {}, cpGruppi: {}, cpVoci: [], cpRestanti: null, cpApertoId: null,
    cpVistaGen: 0, searchGen: 0, searchMode: 'competitor', currentResults: [], searchActive: false,
    cpChiave: v => v.fonte + ':' + v.id, cpRender() {},
    fetch: url => new Promise(resolve => richieste.push({ url, resolve })),
    document: { getElementById: id => id === 'cpUrl' ? input : id === 'cpAdd' ? btn : null,
      body: { classList: { add() {} } } }, cpEl: () => ({ classList: { add() {} }, innerHTML: '' }),
    hideResults() { ctx.currentResults = []; ctx.searchGen++; },
    resetContesto() { ctx.currentResults = []; ctx.searchGen++; },
    initPrezzoSlider() {}, prezzoSliderInstance: null, renderResults() {},
  });
  vm.runInContext(['cpAggiungi', 'cpScarica', 'cpScaricaGruppo', 'cpMostraParco', 'cpMostraGruppo', 'cpChiudi'].map(estrai).join('\n'), ctx);
  const finisci = (i, id) => richieste[i].resolve({ json: async () => ({ ok: true, veicoli: [{ id }] }) });
  return { ctx, finisci, richieste };
}
test('risposta tardiva dopo uscita: conserva cache ma non sostituisce la nuova vista', async () => {
  for (const gruppo of [false, true]) {
    const s = schermo();
    const p = gruppo ? s.ctx.cpScaricaGruppo('g') : s.ctx.cpScarica('subito:a');
    s.ctx.cpChiudi(); s.ctx.searchMode = 'cerca'; s.ctx.currentResults = [{ id: 'nuovo' }];
    s.finisci(0, 'vecchio'); await p;
    assert.equal(s.ctx.currentResults[0].id, 'nuovo');
    assert.equal((gruppo ? s.ctx.cpGruppi.g : s.ctx.cpParchi['subito:a']).stato, 'ok');
  }
});
test('ultima scelta vince fra vetrine, gruppi e selezione manuale di una cache', async () => {
  const s = schermo();
  const a = s.ctx.cpScarica('subito:a'), b = s.ctx.cpScaricaGruppo('g');
  s.finisci(1, 'b'); await b;
  s.finisci(0, 'a'); await a;
  assert.equal(s.ctx.currentResults[0].id, 'b');
  const c = s.ctx.cpScarica('subito:c');
  s.ctx.cpMostraParco('subito:a');
  s.finisci(2, 'c'); await c;
  assert.equal(s.ctx.currentResults[0].id, 'a');
});
test('aggiornamenti concorrenti della stessa vetrina non sovrascrivono la cache recente', async () => {
  const s = schermo();
  const a = s.ctx.cpScarica('subito:a'), b = s.ctx.cpScarica('subito:a');
  s.finisci(1, 'recente'); await b;
  s.finisci(0, 'vecchio'); await a;
  assert.equal(s.ctx.cpParchi['subito:a'].dati.veicoli[0].id, 'recente');
  assert.equal(s.ctx.currentResults[0].id, 'recente');
});

test('aggiunta lenta: il POST non promuove una scelta superata, il parco resta in cache', async () => {
  for (const cambia of [false, true]) {
    const s = schermo();
    s.ctx.cpParchi['subito:b'] = { stato: 'ok', dati: { veicoli: [{ id: 'b' }] } };
    const aggiunta = s.ctx.cpAggiungi();
    if (cambia) s.ctx.cpMostraParco('subito:b');
    s.richieste[0].resolve({ json: async () => ({ ok: true, voce: { fonte: 'subito', id: 'a' } }) });
    await aggiunta;
    assert.equal(s.richieste.length, 2);
    s.finisci(1, 'a');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.ctx.cpParchi['subito:a'].stato, 'ok');
    assert.equal(s.ctx.currentResults[0].id, cambia ? 'b' : 'a');
  }
});

test('aggiunta lenta della stessa vetrina non sostituisce il refresh più recente', async () => {
  for (const giaFinito of [false, true]) {
    const s = schermo();
    s.ctx.currentResults = [{ id: 'vecchio' }];
    const aggiunta = s.ctx.cpAggiungi();
    const refresh = s.ctx.cpScarica('subito:a', true);
    if (giaFinito) { s.finisci(1, 'aggiornato'); await refresh; }
    s.richieste[0].resolve({ json: async () => ({ ok: false, voce: { fonte: 'subito', id: 'a' } }) });
    await aggiunta;
    assert.equal(s.richieste.length, 2, 'il POST superato riusa lo scarico più recente');
    if (!giaFinito) { s.finisci(1, 'aggiornato'); await refresh; }
    assert.equal(s.ctx.currentResults[0].id, 'aggiornato');
    assert.equal(s.ctx.cpParchi['subito:a'].dati.veicoli[0].id, 'aggiornato');
  }
});
