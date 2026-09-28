'use strict';
/**
 * Il MOTORE DI RICERCA Moto.it (non la vetrina): la guardia grezze-vs-parsate.
 *
 * REGRESSIONE chiusa qui: `items.length === 0` chiudeva il loop come "fine genuina" anche
 * quando la pagina conteneva card grezze non mappabili, o quando la testata dichiarava
 * migliaia di annunci. Una deriva del markup diventava "Moto.it: 0 risultati" — presentata
 * come dato di mercato, e cacheable.
 *
 * Si prova il loop (`_scrapeVia`) stubbando `_get`: niente throttle da 1.5s, niente rete.
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

test('un 200 senza struttura di ricerca non diventa zero annunci', async () => {
  await conGet([{ status: 200, body: '<html><title>Manutenzione</title></html>' }], () =>
    assert.rejects(() => motoit._scrapeVia(['u1']), /non riconoscibile/));
});

test('una card non leggibile resta dichiarata anche se altre card sono valide', async () => {
  const params = { tipo: 'moto', marca: 'Yamaha', motoitBrandSlug: 'yamaha', motoitModelSlug: 'mt-07' };
  await conGet([{ status: 200, body: pagina([101, null], 2) }], async () => {
    const r = await motoit(params, { withMeta: true });
    assert.equal(r.items.length, 1);
    assert.equal(r.truncated, true);
    assert.match(r.parziale, /1 card/);
  });
});

test('la prima fetta Moto.it chiede una pagina nativa, la seconda la pagina 2', async () => {
  const params = { tipo: 'moto', marca: 'Yamaha', motoitBrandSlug: 'yamaha', motoitModelSlug: 'mt-07' };
  const orig = motoit._get, chieste = [];
  motoit._get = async url => { chieste.push(url); return { status: 200, body: pagina([101], 40) }; };
  try {
    await motoit(params, { withMeta: true, fetta: 0 });
    await motoit(params, { withMeta: true, fetta: 1 });
    assert.equal(chieste.length, 2);
    assert.match(chieste[0], /ricerca\?/);
    assert.match(chieste[1], /ricerca\/pagina-2\?/);
  } finally { motoit._get = orig; }
});

test('risposta troncata con FIN pulita: la porta HTTP rigetta, non resta pendente', async () => {
  // Content-Length 1000, 100 byte scritti, poi FIN pulita: prima del fix niente 'end',
  // niente errore su req, e il timeout socket muore col socket → Promise pendente per
  // sempre.
  const http = require('node:http');
  const https = require('node:https');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write('x'.repeat(100));
    setTimeout(() => res.socket.end(), 50);   // FIN a meta' body
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const porta = server.address().port;
  const orig = https.get;
  // motoit.js risolve `https.get` a ogni chiamata: la patch devia sul server locale.
  https.get = (url, opts, cb) => http.get(url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${porta}`), opts, cb);
  try {
    const esito = await Promise.race([
      motoit._get('https://www.moto.it/troncata', 0, 2000).then(() => 'risolta', () => 'rigettata'),
      new Promise(r => { setTimeout(() => r('pendente'), 5000).unref(); }),
    ]);
    assert.strictEqual(esito, 'rigettata');
  } finally {
    https.get = orig;
    server.close();
  }
});

test('body troppo grande e redirect fuori Moto.it sono rifiutati prima di una seconda destinazione', async () => {
  const http = require('node:http'), https = require('node:https');
  const richieste = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/grande') { res.writeHead(200); return res.end(Buffer.alloc(2 * 1024 * 1024 + 1024, 65)); }
    res.writeHead(302, { Location: 'https://127.0.0.1/privato' }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const orig = https.get, porta = server.address().port;
  https.get = (url, opts, cb) => {
    richieste.push(url);
    return http.get(url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${porta}`), opts, cb);
  };
  try {
    await assert.rejects(motoit._get('https://www.moto.it/grande'), e => e.code === 'MOTO_BODY_TOO_LARGE');
    await assert.rejects(motoit._get('https://www.moto.it/redirect'), /redirect Moto.it non consentito/);
    assert.equal(richieste.length, 2, 'il redirect non raggiunge la destinazione esterna');
  } finally { https.get = orig; server.close(); }
});

test('ricerca e menu condividono la distanza fra richieste Moto.it', async () => {
  const http = require('node:http'), https = require('node:https');
  const menu = require('../backend/scrapers/motoit-models');
  const arrivi = [];
  const server = http.createServer((req, res) => {
    arrivi.push(Date.now());
    res.end(req.url.includes('/api-50/') ? '{"result":"OK","data":[]}' : '<div class="plist-head-title-info">0 annunci</div>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const orig = https.get, porta = server.address().port;
  https.get = (url, opts, cb) => http.get(url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${porta}`), opts, cb);
  try {
    await Promise.all([
      motoit._get('https://www.moto.it/moto-usate/ricerca'),
      menu.getBrandModels('amr-ritmo-prova', { rilancia: true }),
    ]);
    assert.equal(arrivi.length, 2);
    assert.ok(arrivi[1] - arrivi[0] >= 1300, `intervallo ${arrivi[1] - arrivi[0]} ms`);
  } finally { https.get = orig; server.close(); }
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
    assert.strictEqual(r.cadute, 2, 'due pagine su tre non lette');
  });
});

/**
 * LE PAGINE PERSE DEVONO USCIRE DAL LOOP, e separate da `truncated`.
 *
 * `truncated` lo alza anche il caso ordinario (cap esaurito con got < total), che e' normale
 * e deve restare cachabile: se reggesse l'avviso, Moto.it non entrerebbe in cache mai piu'.
 * `cadute` invece dice solo "abbiamo smesso prima", ed e' quello che diventa `parziale`.
 */
test('un non-200 a pagina 2 conta come pagina persa; tre pagine buone no', async () => {
  const buona = pagina([101, 102, 103], 4323);
  await conGet([{ status: 200, body: buona }, { status: 503, body: '' }], async () => {
    const r = await motoit._scrapeVia(['u1', 'u2', 'u3']);
    assert.strictEqual(r.pages.length, 1, 'la pagina buona si tiene');
    assert.strictEqual(r.cadute, 2, 'un 503 a pagina 2 lascia due pagine non lette');
  });
  // Cap esaurito con il sito che dichiara di piu': troncato SI', ma nessuna pagina persa.
  await conGet([{ status: 200, body: buona }], async () => {
    const r = await motoit._scrapeVia(['u1', 'u2', 'u3']);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.cadute, 0, 'niente avviso quando non si e\' perso nulla');
  });
});

/**
 * IL PERCORSO VIVO: `truncated` non sopravvive a `sciogli()` in server.js (campi fissi),
 * quindi l'unico modo per far arrivare l'elenco monco fino alla pill e a `cacheable()` e'
 * `parziale`. Senza, una pagina caduta usciva con pastiglia VERDE, nessun avviso, e la
 * risposta monca congelata tre minuti in cache: ripremere Cerca serviva la stessa lista.
 */
test('pagina caduta: scrapeMotoIt dichiara `parziale`, non solo `truncated`', async () => {
  const params = { tipo: 'moto', marca: 'Yamaha', modello: 'MT-07',
    motoitBrandSlug: 'yamaha', motoitModelSlug: 'mt-07' };
  await conGet([{ status: 200, body: pagina([101, 102, 103], 4323) }, { status: 503, body: '' }], async () => {
    const r = await motoit(params, { withMeta: true, maxPages: 3, pageDelayMs: 1 });
    assert.strictEqual(r.items.length, 3, 'le superstiti si tengono');
    assert.match(r.parziale, /non si sono lasciate leggere/);
  });
  // La ricerca ordinaria chiede una sola pagina nativa e non inventa un avviso.
  await conGet([{ status: 200, body: pagina([101, 102, 103], 4323) }], async () => {
    const r = await motoit(params, { withMeta: true });
    assert.strictEqual(r.parziale, null);
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
