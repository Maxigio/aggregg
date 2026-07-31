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

/**
 * REGRESSIONE. A file corrotto leggi() risponde [] — e il primo POST riscriveva il file
 * partendo da quel vuoto, rendendo definitiva una perdita che era ancora recuperabile a
 * mano. Ora chi scrive controlla leggi.ultimoErrore e risponde 503 senza toccare il disco.
 */
test('elenco corrotto: le scritture rispondono 503 e il file resta byte per byte com\'era', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    const p = path.join(process.env.USER_DATA_PATH, 'competitor.json');
    const rotto = '{"voci":[{"fonte":"subito","id":"1","nome":"Recuperabi';   // troncato
    fs.writeFileSync(p, rotto);
    const r = resFinta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '42', nome: 'X' } }, r);
    assert.strictEqual(r.code, 503);
    assert.strictEqual(r.body.corrotto, true);
    assert.match(r.body.error, /illeggibile/);
    assert.strictEqual(fs.readFileSync(p, 'utf8'), rotto, 'il file corrotto NON va sovrascritto');
    // E chi legge lo viene a sapere: elenco vuoto per guasto ≠ elenco vuoto davvero.
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.ok(lista.body.erroreElenco, 'la GET deve dichiarare il guasto');
  });
});

/**
 * REGRESSIONE. Le rotte indirizzavano per solo id, ma Subito e Autoscout numerano ognuno
 * per conto suo: con una collisione si serviva il parco del venditore sbagliato e DELETE
 * toglieva due voci. La chiave e' `fonte:id`, la stessa dei POST e della cache.
 */
test('collisione di id fra fonti: la chiave composta indirizza la voce giusta, DELETE ne toglie una', async () => {
  await conCartellaPulita(async () => {
    const H = monta();
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'subito', id: '7008', nome: 'Sub' } }, resFinta());
    await H['POST /api/competitor/da-annuncio']({ body: { fonte: 'autoscout', id: '7008', nome: 'As' } }, resFinta());
    // DELETE con la chiave composta toglie SOLO quella voce.
    const del = resFinta();
    H['DELETE /api/competitor/:id']({ params: { id: 'autoscout:7008' } }, del);
    assert.strictEqual(del.code, 200);
    assert.strictEqual(del.body.tolti, 1, 'una voce sola, non tutte quelle con quell\'id');
    const lista = resFinta();
    H['GET /api/competitor']({}, lista);
    assert.deepStrictEqual(lista.body.voci.map(x => x.fonte + ':' + x.id), ['subito:7008']);
  });
});

/**
 * REGRESSIONE. La rotta di gruppo scavalcava PARCO_MAX: N scarichi reali per richiesta,
 * nessun addebito, e il doppio clic (la ragione d'esistere del limitatore) non coperto.
 * Ora ogni voce non in cache passa dal budget, e il budget e' condiviso con la rotta singola.
 */
test('rotta di gruppo: gli scarichi passano dal limitatore e si addebitano', async () => {
  const chiamate = [];
  const stub = {
    leggi: () => [
      { fonte: 'subito', id: '1', nome: 'A', gruppo: 'g1', schedaLetta: true },
      { fonte: 'autoscout', id: '2', nome: 'B', gruppo: 'g1', schedaLetta: true },
    ],
    scrivi: v => v,
    parco: async voce => { chiamate.push(voce.fonte + ':' + voce.id); return { veicoli: [], troncato: false, illeggibili: 0, totaleFonte: null }; },
    aggrega: () => ({ veicoli: 0 }),
  };
  const H = {};
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; },
    delete: (p, ...h) => { H['DELETE ' + p] = h[h.length - 1]; },
  };
  route.mount(app, { json: (req, res, next) => next(), competitor: stub, clientIp: () => 'ip-test-gruppo' });
  // Prima richiesta: 2 voci, 2 scarichi, entrambi addebitati.
  const r1 = resFinta();
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, r1);
  assert.strictEqual(r1.code, 200);
  assert.strictEqual(chiamate.length, 2);
  assert.ok(r1.body.scarichiRestanti < 6, 'gli scarichi di gruppo devono consumare il budget');
  // Si insiste col doppio clic: al giro che sfora il budget la risposta e' 429, non
  // un giro silenzioso di scarichi (budget 6: 2+2+2 ok, il quarto giro rifiuta).
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, resFinta());
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, resFinta());
  const r4 = resFinta();
  await H['GET /api/competitor/gruppo/:g/parco']({ params: { g: 'g1' }, query: { forza: '1' } }, r4);
  assert.strictEqual(r4.code, 429, 'a budget esaurito il gruppo risponde 429 come la rotta singola');
  assert.match(r4.body.error, /Troppi scarichi/);
  assert.strictEqual(chiamate.length, 6, 'oltre il budget non deve partire nessuno scarico reale');
});
