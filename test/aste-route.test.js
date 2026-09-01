'use strict';
/**
 * LE ROTTE DELL'AREA ASTE. Le prove che contano:
 *  - il magazzino vuoto o rotto si DICHIARA, non diventa «nessuna asta trovata»;
 *  - le rotte fisse (`/filtri`, `/portale`) non vengono mangiate da `/:id`;
 *  - dal dettaglio non escono i dati personali del referente della procedura;
 *  - il portale che non risponde e' un 502, non un errore nostro, e intanto si serve
 *    quello che abbiamo gia' in magazzino.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const route = require('../backend/aste-route');
const db = require('../backend/aste-db');

/** Un finto `app` che tiene gli handler, nell'ordine in cui sono stati registrati. */
function monta(deps = {}) {
  const H = {};
  const ordine = [];
  const app = {
    get: (p, ...h) => { H['GET ' + p] = h[h.length - 1]; ordine.push('GET ' + p); },
    post: (p, ...h) => { H['POST ' + p] = h[h.length - 1]; ordine.push('POST ' + p); },
  };
  route.mount(app, deps);
  return { H, ordine };
}
function resFinta() {
  const r = { code: 200, body: null, headers: {} };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  return r;
}
/**
 * Ogni prova col SUO indirizzo: il limitatore vive a livello di modulo, quindi lo stato passa da
 * un test all'altro. Con un indirizzo solo, la prova che ne consuma uno faceva fallire quella
 * che conta i tre giri — e il guasto sembrava del limitatore, non del test.
 */
let contatore = 0;
const req = (query = {}, params = {}, ip = null) => ({ query, params, ip: ip || `10.0.0.${++contatore}` });
const stessoIp = () => `10.9.9.${++contatore}`;

function conCartella(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-aste-rt-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  db._reset();
  const pulisci = () => {
    db._reset();
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
  };
  const esito = (() => { try { return fn(dir); } catch (e) { pulisci(); throw e; } })();
  if (esito && typeof esito.then === 'function') return esito.then(v => { pulisci(); return v; }, e => { pulisci(); throw e; });
  pulisci();
  return esito;
}

const GIORNO = 24 * 60 * 60 * 1000;
const fraGiorni = n => new Date(Date.now() + n * GIORNO).toISOString().slice(0, 10);
const lotto = (id, extra = {}) => ({
  id, descrizione: `Motociclo di prova ${id}`, marca: 'Voge', cumulativo: false, piattaforma: null,
  prezzoBase: 900, offertaMinima: 700, rialzoMinimo: 50, dataVendita: fraGiorni(20),
  orarioVendita: '10:00', dataPubblicazione: fraGiorni(-5), citta: 'Verona', provincia: 'Verona',
  tribunale: 'Tribunale di VERONA', numeroLotto: 'LOTTO UNICO', procedura: '3', ...extra,
});

test('le rotte fisse si registrano PRIMA di /:id', () => {
  // Express 5 non accetta piu' il vincolo `:id(\\d+)`: senza questo ordine, una richiesta a
  // /api/aste/filtri finirebbe nel gestore del dettaglio e uscirebbe «id non valido».
  const { ordine } = monta();
  const i = n => ordine.indexOf(n);
  assert.ok(i('GET /api/aste/filtri') < i('GET /api/aste/:id'), '/filtri deve venire prima di /:id');
  assert.ok(i('GET /api/aste/portale') < i('GET /api/aste/:id'), '/portale deve venire prima di /:id');
});

test('nessuna risposta e\' cachabile dal browser', async () => conCartella(async () => {
  // Senza `Cache-Control` il browser decide da solo per quanto tenere una risposta, e su
  // un'asta significa mostrare una scadenza o un prezzo base vecchi. Successo davvero.
  const { H } = monta({
    pvp: { dettaglio: async () => ({ idVendita: 1 }), pagina: async () => ({ lotti: [], totale: 0 }), urlAnnuncio: () => '', urlAllegato: l => l },
    aste: { giro: async () => ({ ok: true }), indiceMarche: () => new Map() },
  });
  const chiamate = [
    ['GET /api/aste', req()],
    ['GET /api/aste/filtri', req()],
    ['GET /api/aste/portale', req({ q: 'honda' })],
    ['GET /api/aste/:id', req({}, { id: '1' })],
    ['POST /api/aste/aggiorna', req()],
  ];
  for (const [nome, r] of chiamate) {
    const res = resFinta();
    await H[nome](r, res);
    assert.equal(res.headers['Cache-Control'], 'no-store', `${nome} deve dire no-store`);
  }
}));

test('magazzino mai riempito: elenco vuoto MA lo stato lo dice', () => conCartella(() => {
  const { H } = monta();
  const res = resFinta();
  H['GET /api/aste'](req(), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.lotti, []);
  // La differenza fra «non ho ancora scaricato» e «non c'e' niente da vedere».
  assert.equal(res.body.magazzino, 'assente');
  assert.equal(res.body.daAggiornare, true);
  assert.equal(res.body.ultimoGiro, null);
}));

test('l\'elenco filtra, e il tipo sbagliato e\' un 400', () => conCartella(() => {
  db.sostituisci('moto', [
    lotto(1, { marca: 'Voge', prezzoBase: 800 }),
    lotto(2, { marca: 'Yamaha', prezzoBase: 4000, provincia: 'Milano' }),
    lotto(3, { marca: null, cumulativo: true, descrizione: 'N. 12 scooter incidentati' }),
  ], Date.now());
  const { H } = monta();

  let res = resFinta();
  H['GET /api/aste'](req({ marca: 'Voge' }), res);
  assert.deepEqual(res.body.lotti.map(l => l.id), [1]);

  res = resFinta();
  H['GET /api/aste'](req({ soloSingoli: '1' }), res);
  assert.deepEqual(res.body.lotti.map(l => l.id).sort(), [1, 2]);

  res = resFinta();
  H['GET /api/aste'](req({ q: 'incidentati' }), res);
  assert.deepEqual(res.body.lotti.map(l => l.id), [3]);

  res = resFinta();
  H['GET /api/aste'](req({ tipo: 'camion' }), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.ok, false);
}));

test('i filtri contano a parte i lotti senza marca, invece di nasconderli', () => conCartella(() => {
  db.sostituisci('moto', [lotto(1, { marca: 'Voge' }), lotto(2, { marca: null })], Date.now());
  const { H } = monta();
  const res = resFinta();
  H['GET /api/aste/filtri'](req(), res);
  assert.deepEqual(res.body.marche, [{ nome: 'Voge', quanti: 1 }]);
  assert.equal(res.body.senzaMarca, 1, 'il lotto senza marca si conta, non sparisce');
  assert.deepEqual(res.body.province, [{ provincia: 'Verona', quanti: 2 }]);
}));

test('dal dettaglio non escono i dati personali del referente', async () => conCartella(async () => {
  const pvpFinto = {
    dettaglio: async () => ({
      idVendita: 99, impoBaseAsta: 900, dataVendita: '2026-10-01', dataTermPresOff: '30/09/2026',
      descModVendita: 'Telematica', procedura: { numeRg: '3', numeAnnoRg: 2019, descUfficio: 'Tribunale di Siena' },
      // Il rito e' incollato senza spazio anche qui, non solo in `descLotto`.
      beni: [{ descrizione: 'Motociclo Voge 300RPer visionare la documentazione disponibile, si invitano le parti', descTipologiaBene: 'Motoveicolo' }],
      allegati: [{ nomeFile: 'perizia.pdf', codiceTipoAllegato: 'PERIZ', dimensioneAllegato: 201346, linkAllegato: '/allegati/99/perizia.pdf' }],
      // Il ministero li pubblica; noi non li ridistribuiamo.
      soggetti: [{ nome: 'Mario', cognome: 'Rossi', cellulare: '3331234567', email: 'm@r.it', cf: 'RSSMRA80A01L781X' }],
    }),
    urlAnnuncio: id => `https://pvp.giustizia.it/pvp/it/detail_annuncio.page?idAnnuncio=${id}`,
    urlAllegato: l => `https://resource-pvp.giustizia.it${l}`,
  };
  const { H } = monta({ pvp: pvpFinto });
  const res = resFinta();
  await H['GET /api/aste/:id'](req({}, { id: '99' }), res);
  assert.equal(res.code, 200);
  const testo = JSON.stringify(res.body);
  for (const vietato of ['Mario', 'Rossi', '3331234567', 'RSSMRA80A01L781X', 'soggetti']) {
    assert.ok(!testo.includes(vietato), `${vietato} non deve uscire dal dettaglio`);
  }
  // Ma quello che serve per decidere c'e' tutto, allegati compresi.
  assert.equal(res.body.dettaglio.termineOfferte, '2026-09-30');
  assert.equal(res.body.dettaglio.beni[0].descrizione, 'Motociclo Voge 300R', 'il rito va tolto anche dai beni');
  assert.equal(res.body.dettaglio.allegati[0].tipo, 'PERIZ');
  assert.ok(res.body.dettaglio.allegati[0].url.startsWith('https://resource-pvp.giustizia.it/'));
}));

test('il portale che non risponde e\' un 502, e intanto si serve il magazzino', async () => conCartella(async () => {
  db.sostituisci('moto', [lotto(42)], Date.now());
  const pvpFinto = {
    dettaglio: async () => { throw new Error('timeout'); },
    urlAnnuncio: id => `https://pvp.giustizia.it/x?id=${id}`,
    urlAllegato: l => l,
  };
  const { H } = monta({ pvp: pvpFinto });
  const res = resFinta();
  await H['GET /api/aste/:id'](req({}, { id: '42' }), res);
  assert.equal(res.code, 502);
  assert.equal(res.body.ok, false);
  assert.ok(res.body.lotto, 'quello che abbiamo gia\' si serve lo stesso');
  assert.equal(res.body.lotto.id, 42);
  assert.ok(res.body.url, 'e il link al portale resta, per andarci a mano');
}));

test('un id non numerico non arriva alla fonte', async () => conCartella(async () => {
  let chiamato = false;
  const { H } = monta({ pvp: { dettaglio: async () => { chiamato = true; return null; }, urlAnnuncio: () => '', urlAllegato: l => l } });
  const res = resFinta();
  await H['GET /api/aste/:id'](req({}, { id: 'pippo' }), res);
  assert.equal(res.code, 400);
  assert.equal(chiamato, false, 'niente rete per un id che non e\' un numero');
}));

test('la ricerca libera divide i vivi dai passati invece di buttarli in silenzio', async () => conCartella(async () => {
  const pvpFinto = {
    pagina: async () => ({
      totale: 2, ultima: true,
      lotti: [
        { id: 1, descLotto: 'Motociclo Honda CB500', dataVendita: fraGiorni(10), indirizzo: {} },
        { id: 2, descLotto: 'Motociclo Honda Hornet', dataVendita: fraGiorni(-10), indirizzo: {} },
      ],
    }),
  };
  const { H } = monta({ pvp: pvpFinto, aste: { indiceMarche: () => new Map() } });
  const res = resFinta();
  await H['GET /api/aste/portale'](req({ q: 'honda' }), res);
  assert.equal(res.body.ok, true);
  assert.deepEqual(res.body.lotti.map(l => l.id), [1]);
  assert.equal(res.body.passati, 1, 'i passati si contano e si dicono');
  assert.equal(res.body.totalePortale, 2);
}));

test('la ricerca libera senza testo non esce verso il portale', async () => conCartella(async () => {
  let chiamato = false;
  const { H } = monta({ pvp: { pagina: async () => { chiamato = true; return { lotti: [], totale: 0 }; } } });
  const res = resFinta();
  await H['GET /api/aste/portale'](req({ q: '  ' }), res);
  assert.equal(res.code, 400);
  assert.equal(chiamato, false);
}));

test('l\'aggiornamento a mano si ferma dopo tre giri nell\'ora', async () => conCartella(async () => {
  let giri = 0;
  const { H } = monta({ aste: { giro: async () => { giri++; return { ok: true, visti: 1, nuovi: 0, spariti: 0 }; }, indiceMarche: () => new Map() } });
  const ip = stessoIp();
  for (let i = 0; i < 3; i++) {
    const res = resFinta();
    await H['POST /api/aste/aggiorna'](req({}, {}, ip), res);
    assert.equal(res.code, 200, `il giro ${i + 1} doveva passare`);
  }
  const res = resFinta();
  await H['POST /api/aste/aggiorna'](req({}, {}, ip), res);
  assert.equal(res.code, 429);
  assert.equal(giri, 3, 'il quarto non deve toccare il portale');
  assert.ok(res.body.riprovaFra > 0, 'e si dice quando riprovare');
}));
