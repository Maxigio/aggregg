'use strict';
/**
 * LE ROTTE DI COMPETITOR — quelle che si possono provare senza rete.
 *
 * `POST /api/competitor/da-annuncio` mette in elenco il venditore di un annuncio partendo
 * dal suo id, che l'annuncio porta gia': niente link da incollare, niente richieste. E'
 * l'unica delle sette che non tocca nessuna fonte, quindi e' anche l'unica che si puo'
 * sorvegliare per davvero.
 *
 * ISOLAMENTO: `filePath()` di competitor.js legge USER_DATA_PATH a OGNI chiamata, quindi
 * basta puntarlo a una cartella temporanea per non sfiorare ne' data/competitor.json ne'
 * quello di produzione. (Lezione imparata a mani nude: una prova scritta senza questa
 * accortezza aveva davvero aggiunto una voce finta all'elenco vero.)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const route = require('../backend/competitor-route');

/** Un finto `app` che tiene gli handler, e le risposte finte per leggerne l'esito. */
function monta() {
  const H = {};
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; },
    delete: (p, ...h) => { H['DELETE ' + p] = h[h.length - 1]; },
  };
  route.mount(app, { json: (req, res, next) => next() });
  return H;
}
function resFinta() {
  const r = { code: 200, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.set = () => r;
  return r;
}
/** Esegue un handler in una cartella dati usa-e-getta. */
async function conCartellaPulita(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-cp-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  try { return await fn(); }
  finally {
    if (prima === undefined) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('da-annuncio: il venditore entra in elenco col suo id, senza link e senza richieste', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    const res = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'autoscout', id: '7008', nome: 'Stemar Snc' } }, res);
    assert.strictEqual(res.code, 200);
    const v = res.body.voce;
    assert.strictEqual(v.fonte, 'autoscout');
    assert.strictEqual(v.id, '7008');
    assert.strictEqual(v.nome, 'Stemar Snc');
    // L'anagrafica non la conosciamo: l'annuncio non porta il link della vetrina. Si dice
    // null invece di inventarla, e `schedaLetta` resta true perche' non c'e' niente da rileggere.
    assert.strictEqual(v.url, null);
    assert.strictEqual(v.schedaLetta, true);
    assert.strictEqual(v.daAnnuncio, true, 'com\'e\' entrata in elenco deve restare scritto');
    // E finisce davvero su disco, non solo nella risposta.
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.deepStrictEqual(lista.body.voci.map(x => x.fonte + ':' + x.id), ['autoscout:7008']);
  });
});

test('da-annuncio: lo stesso venditore due volte e\' 409, non un doppione', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '105412305', nome: 'FC AUTO SRL' } }, resFinta());
    const due = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '105412305' } }, due);
    assert.strictEqual(due.code, 409);
    assert.match(due.body.error, /gia'/);
    assert.strictEqual(due.body.voce.nome, 'FC AUTO SRL', 'il 409 rimanda la voce che c\'era gia\'');
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.strictEqual(lista.body.voci.length, 1, 'in elenco deve restarne una sola');
  });
});

test('da-annuncio: fonte e id sono controllati, e senza nome se ne mette uno leggibile', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    // Moto.it non passa di qui: la sua vetrina e' un link, e la porta di sempre lo risolve.
    for (const body of [{ fonte: 'moto', id: '7008' }, { fonte: '', id: '7008' }, { fonte: 'pippo', id: '1' }]) {
      const r = resFinta();
      await H['POST /api/competitor/da-annuncio']({ body }, r);
      assert.strictEqual(r.code, 400, `fonte "${body.fonte}" doveva essere rifiutata`);
    }
    // L'id finisce in una chiave e in una query: si accettano solo cifre.
    for (const id of ['abc', "1' or 1=1", '../../etc', '', '1234567890123456']) {
      const r = resFinta();
      await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id } }, r);
      assert.strictEqual(r.code, 400, `id ${JSON.stringify(id)} doveva essere rifiutato`);
    }
    // Senza nome non si scrive "undefined": si mette qualcosa che si legge.
    const senzaNome = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '999' } }, senzaNome);
    assert.strictEqual(senzaNome.code, 200);
    assert.match(senzaNome.body.voce.nome, /Venditore Subito 999/);
  });
});
