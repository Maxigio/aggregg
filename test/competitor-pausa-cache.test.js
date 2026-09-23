'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const limite = require('../backend/limite-richieste');

// Solo i due moduli di rotta/limite: nessun import di scraper, dati, auth o server.
const sorgente = fs.readFileSync(path.join(__dirname, '../backend/competitor-route.js'), 'utf8');
const TTL = 10 * 60 * 1000;
function monta(t, fonte) {
  let ora = Date.UTC(2026, 8, 23, 10);
  t.mock.method(Date, 'now', () => ora);
  const ferme = new Set();
  const voci = ['a', 'b', 'c'].map(id => ({ fonte, id, nome: id, gruppo: 'g', schedaLetta: true }));
  const chiamate = [];
  let produci = v => ({ veicoli: [{ url: v.id + ':1' }, { url: v.id + ':2' }] });
  const comp = {
    leggi: () => voci,
    parco: async v => { chiamate.push(v.id); return produci(v); },
    aggrega: veicoli => ({ veicoli: veicoli.length }),
  };
  const salute = {
    fermo: f => ({ fermo: ferme.has(f) }),
    avvisoPausa: f => `${f}: richieste sospese dopo un blocco.`,
  };
  const moduleFinto = { exports: {} };
  new Function('require', 'module', sorgente)(id => {
    if (id === './competitor') return comp;
    if (id === './fonti-salute') return salute;
    if (id === './limite-richieste') return limite;
    throw new Error('Import inatteso: ' + id);
  }, moduleFinto);
  const handlers = {};
  moduleFinto.exports.mount({
    get: (p, ...h) => { handlers[p] = h.at(-1); }, post() {}, delete() {},
  }, { competitor: comp, clientIp: () => 'isolato' });
  async function chiedi(id = 'a', forza = false) {
    const gruppo = id === 'gruppo';
    const req = { params: gruppo ? { g: 'g' } : { id: `${fonte}:${id}` }, query: forza ? { forza: '1' } : {} };
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handlers[gruppo ? '/api/competitor/gruppo/:g/parco' : '/api/competitor/:id/parco'](req, res);
    return res;
  }
  return { chiedi, ferme, voci, chiamate, avanza: ms => { ora += ms; },
    quando: () => new Date(ora).toISOString(), produci: fn => { produci = fn; } };
}
const parziale = id => ({ veicoli: [{ url: id + ':1' }], passateKo: [{ tipo: 'moto', status: 429, motivo: 'limite corrente' }] });

for (const fonte of ['subito', 'autoscout', 'moto']) {
  test(`${fonte}: il parziale si restituisce ma non sostituisce la cache completa né ne prolunga il TTL`, async t => {
    const h = monta(t, fonte);
    const quando = h.quando();
    await h.chiedi();
    h.avanza(TTL - 1000);
    h.produci(v => parziale(v.id));
    const nuovo = await h.chiedi('a', true);
    assert.equal(nuovo.body.veicoli.length, 1);
    assert.equal(nuovo.body.daCache, false);
    assert.equal(nuovo.body.passateKo[0].status, 429);
    const hit = await h.chiedi();
    assert.equal(hit.body.veicoli.length, 2);
    assert.equal(hit.body.passateKo, null);
    assert.equal(hit.body.quando, quando);
    assert.equal(hit.body.daCache, true);
    h.avanza(1000);
    const scaduta = await h.chiedi();
    assert.equal(scaduta.body.daCache, false);
    assert.equal(scaduta.body.veicoli.length, 1);
    assert.equal(h.chiamate.length, 3);
  });

  test(`${fonte}: pausa e forza servono cache fresca, avviso e data originali senza addebiti`, async t => {
    const h = monta(t, fonte);
    h.voci.splice(1);
    const quando = h.quando();
    const primo = await h.chiedi();
    h.ferme.add(fonte);
    h.avanza(TTL - 1000);
    for (let i = 0; i < 7; i++) {
      const hit = await h.chiedi('a', true);
      assert.equal(hit.code, 200);
      assert.equal(hit.body.daCache, true);
      assert.equal(hit.body.veicoli.length, 2);
      assert.equal(hit.body.passateKo, null, 'la pausa non rende incompleta la copia buona');
      assert.equal(hit.body.quando, quando);
      assert.match(hit.body.avvisoCache, /cache.*non aggiornati/i);
      assert.match(hit.body.avvisoCache, /richieste sospese/);
      assert.equal(hit.body.scarichiRestanti, primo.body.scarichiRestanti);
    }
    const gruppo = await h.chiedi('gruppo', true);
    assert.equal(gruppo.body.veicoli.length, 2);
    assert.equal(gruppo.body.parti[0].daCache, true);
    assert.equal(gruppo.body.parti[0].quando, quando);
    assert.equal(gruppo.body.errori[0].error, gruppo.body.parti[0].avvisoCache);
    assert.equal(gruppo.body.scarichiRestanti, primo.body.scarichiRestanti);
    assert.equal(h.chiamate.length, 1);
    h.avanza(1000);
    const scaduta = await h.chiedi('a', true);
    assert.equal(scaduta.code, 502, 'la pausa non rende eterna la cache');
    assert.equal(h.chiamate.length, 1);
    h.ferme.clear();
    const ripresa = await h.chiedi();
    assert.equal(ripresa.body.daCache, false);
    assert.equal(h.chiamate.length, 2);
  });

  test(`${fonte}: il vecchio 429 in cache non ferma le altre vetrine`, async t => {
    const h = monta(t, fonte);
    h.voci.splice(2);
    h.produci(v => parziale(v.id));
    await h.chiedi(); // Non esiste una copia completa: si conserva il parziale.
    h.produci(v => ({ veicoli: [{ url: v.id }] }));
    const gruppo = await h.chiedi('gruppo');
    assert.deepEqual(h.chiamate, ['a', 'b']);
    assert.equal(gruppo.body.parti[0].daCache, true);
    assert.equal(gruppo.body.parti[0].passateKo[0].status, 429);
    assert.equal(gruppo.body.parti[1].daCache, false);
    assert.equal(gruppo.body.errori.length, 0);
  });

  test(`${fonte}: un nuovo 429 ferma la stessa fonte, conserva cache e lascia lavorare le altre`, async t => {
    const h = monta(t, fonte);
    h.voci.push({ fonte: fonte === 'moto' ? 'subito' : 'moto', id: 'altra', nome: 'altra', gruppo: 'g', schedaLetta: true });
    await h.chiedi('b');
    h.produci(v => v.id === 'a' ? parziale(v.id) : { veicoli: [{ url: v.id }] });
    // Nessuna pausa finta globale: si prova anche il freno locale fontiLimitate.
    const gruppo = await h.chiedi('gruppo', true);
    assert.deepEqual(h.chiamate, ['b', 'a', 'altra']);
    assert.equal(gruppo.body.veicoli.length, 4);
    assert.equal(gruppo.body.parti[1].daCache, true);
    assert.match(gruppo.body.parti[1].avvisoCache, /cache/);
    assert.ok(gruppo.body.errori.some(e => e.id === 'c'));
    assert.equal(gruppo.body.scarichiRestanti, 3);
  });
}

test('cache sana: hit non addebita; forza senza pausa aggiorna e sostituisce il parziale', async t => {
  const h = monta(t, 'moto');
  h.produci(v => parziale(v.id));
  await h.chiedi();
  const hit = await h.chiedi();
  assert.equal(hit.body.daCache, true);
  assert.equal(hit.body.scarichiRestanti, 5);
  h.produci(v => ({ veicoli: [{ url: v.id + ':nuovo' }] }));
  const nuovo = await h.chiedi('a', true);
  assert.equal(nuovo.body.daCache, false);
  assert.equal(nuovo.body.scarichiRestanti, 4);
  assert.equal(nuovo.body.passateKo, null);
  assert.equal((await h.chiedi()).body.veicoli[0].url, 'a:nuovo');
});
