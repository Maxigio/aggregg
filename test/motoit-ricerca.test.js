'use strict';
/**
 * Il MOTORE DI RICERCA Moto.it (non la vetrina): la guardia grezze-vs-parsate.
 *
 * REGRESSIONE chiusa qui: `items.length === 0` chiudeva il loop come "fine genuina" anche
 * quando la pagina conteneva card grezze non mappabili, o quando la testata dichiarava
 * migliaia di annunci. Una deriva del markup diventava "Moto.it: 0 risultati" — presentata
 * come dato di mercato, e cacheable. La vetrina gemella (motoit-vetrina) questa guardia
 * ce l'ha da prima: ora le due si comportano allo stesso modo.
 *
 * Si prova il loop (`_scrapeVia`) stubbando `_get`, come fa motoit-vetrina.test.js: niente
 * throttle da 1.5s, niente rete.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const motoit = require('../backend/scrapers/motoit');

// Una card VERA del motore di ricerca ha classe .mcard--big e un <a href> verso l'annuncio.
const card = id => `<div class="mcard--big">${id ? `<a href="/moto-usate/yamaha/mt-07/${id}">MT-07</a>` : ''}
  <h3>Yamaha MT-07</h3><span class="price">5.000 €</span><span>10.000 Km del 2019</span></div>`;
const testata = n => `<div class="plist-head-title-info">${Number(n).toLocaleString('it-IT')} annunci</div>`;
const pagina = (ids, tot) => `<html><body>${tot != null ? testata(tot) : ''}${ids.map(card).join('')}</body></html>`;

function conGet(risposte, fn) {
  const orig = motoit._get;
  let i = 0;
  motoit._get = async () => risposte[Math.min(i++, risposte.length - 1)];
  return Promise.resolve(fn()).finally(() => { motoit._get = orig; });
}

test('card presenti ma nessuna leggibile in pagina 1: errore dichiarato, non "0 risultati"', async () => {
  // 12 card grezze senza <a href> → 0 mappabili, con la testata che dichiara 4.323 annunci.
  const body = pagina([null, null, null, null, null, null, null, null, null, null, null, null], 4323);
  await conGet([{ status: 200, body }], () =>
    assert.rejects(() => motoit._scrapeVia(['u1', 'u2']), /markup/));
});

test('zero card con la testata che dichiara annunci: errore, non fine genuina', async () => {
  await conGet([{ status: 200, body: pagina([], 4323) }], () =>
    assert.rejects(() => motoit._scrapeVia(['u1']), /markup/));
});

test('zero card e zero annunci dichiarati: fine genuina, nessun falso allarme', async () => {
  // total=0 e' legittimo (ricerca senza risultati): la guardia non deve regredirlo.
  await conGet([{ status: 200, body: pagina([], 0) }], async () => {
    const r = await motoit._scrapeVia(['u1']);
    assert.deepStrictEqual(r.pages, []);
    assert.strictEqual(r.truncated, false);
  });
});

test('"Carica altri" oltre il fondo: pagina vuota con totale dichiarato NON e\' deriva', async () => {
  // La fetta 3 di una ricerca da 30 annunci: la testata dichiara ancora il totale della
  // query, ma la pagina e' genuinamente vuota. Senza il gate su fetta sarebbe un falso errore.
  await conGet([{ status: 200, body: pagina([], 30) }], async () => {
    const r = await motoit._scrapeVia(['u1'], { fetta: 3 });
    assert.deepStrictEqual(r.pages, []);
  });
});

test('pagina 2 illeggibile dopo pagina 1 buona: si tengono le buone, ma dichiarato troncato', async () => {
  const buona = pagina([101, 102, 103], 40);
  const rotta = pagina([null, null, null]);   // card presenti, nessuna leggibile
  await conGet([{ status: 200, body: buona }, { status: 200, body: rotta }], async () => {
    const r = await motoit._scrapeVia(['u1', 'u2', 'u3']);
    assert.strictEqual(r.pages.length, 1, 'la pagina buona si tiene');
    assert.strictEqual(r.pages[0].length, 3);
    assert.strictEqual(r.truncated, true, 'vista parziale: senza troncato il crawler farebbe markGone');
  });
});

/**
 * LE MARCHE AGGIUNTE (campagna E1, 2026-08-08). 373 marche del menu non risolvevano uno
 * slug e il runtime diceva «marca non su Moto.it» — provate TUTTE dal vivo sull'API
 * market: 104 esistono (39 con annunci usati in quel momento: Lambretta, Laverda,
 * Garelli, TGB, Aeon, Yadea, BSA…), e per ognuna il campo `value` dei modelli conferma
 * lo slug. Le instabili (Hisun, Volta, Loncin) stanno nei _dubbi, non nelle voci.
 * Qui si pretende che ogni voce curata risolva col SUO slug, senza doppioni.
 */
const testAggiunte = require('node:test');
testAggiunte('le marche aggiunte risolvono col loro slug, i dubbi restano fuori', () => {
  const assert = require('node:assert');
  const { resolveMotoitSlug } = require('../backend/scrapers/motoit-brands');
  const j = require('../data/motoit-marche-aggiunte.json');
  assert.ok(j.voci.length >= 100, `attese >=100 voci, lette ${j.voci.length}`);
  const visti = new Set();
  for (const v of j.voci) {
    assert.ok(v.name && v.slug && v.perche && v.quando, `${v.name}: voce senza slug/prova/data`);
    assert.strictEqual(resolveMotoitSlug(v.name), v.slug, `${v.name}: lo slug curato non arriva al resolver`);
    const k = v.name.toLowerCase();
    assert.ok(!visti.has(k), `${v.name}: doppione`);
    visti.add(k);
  }
  for (const dubbia of ['Hisun', 'Volta', 'Loncin']) {
    assert.ok(!visti.has(dubbia.toLowerCase()), `${dubbia} e' instabile: sta nei _dubbi, non nelle voci`);
    assert.ok(j._dubbi && j._dubbi[dubbia], `${dubbia}: il dubbio va scritto perche' nessuno la riproponga alla cieca`);
  }
});
