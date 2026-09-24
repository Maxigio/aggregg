'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const scrape = require('../backend/scrapers/subito-api');
const mapAd = scrape._mapAd;
const buildPath = scrape._buildPath;

const f = (label, value) => ({ label, values: [{ value }] });
const AD = {
  subject: 'BMW 320d Touring Luxury',
  urls: { default: 'https://www.subito.it/auto/bmw-320d-roma-123.htm' },
  geo: { region: { friendly_name: 'lazio' }, city: { value: 'Roma' } },
  features: [
    f('Prezzo', '9.500 €'),
    f('Km', '190.000 - 199.999'),
    f('Immatricolazione', '05/2013'),
    f('Carburante', 'Diesel'),
    f('Cambio', 'Automatico'),
    f('Auto', 'BMW'),
  ],
};

test('mapAd: shape coerente con gli altri scraper', () => {
  const r = mapAd(AD);
  assert.strictEqual(r.fonte, 'subito');
  assert.strictEqual(r.titolo, 'BMW 320d Touring Luxury');
  assert.strictEqual(r.prezzo, 9500);
  assert.strictEqual(r.km, 190000);        // estremo inferiore del bucket
  assert.strictEqual(r.anno, 2013);        // da "05/2013"
  assert.strictEqual(r.carburante, 'Diesel');
  assert.strictEqual(r.cambio, 'Automatico');
  // La provincia e' una SIGLA su tutte e tre le fonti: e' una chiave di raggruppamento, e
  // «Roma» contro «RM» faceva due gruppi per la stessa provincia. Questa asserzione
  // pretendeva il nome esteso: difendeva il difetto.
  assert.strictEqual(r.provincia, 'RM');
  assert.strictEqual(r.url, 'https://www.subito.it/auto/bmw-320d-roma-123.htm');
});

test('mapAd: km esatto "124000 Km" → 124000', () => {
  const ad = JSON.parse(JSON.stringify(AD));
  ad.features = [f('Prezzo', '7000 €'), f('Km', '124000 Km'), f('Immatricolazione', '01/2016')];
  assert.strictEqual(mapAd(ad).km, 124000);
});

test('mapAd: i km vengono dal valore esatto, non dalla fascia (payload hades vero)', () => {
  // Nel payload vero l'etichetta 'Km' e' DOPPIA: /mileage (fascia "95.000 - 99.999") e
  // /mileage_scalar (98000). La fascia viene prima, e cercando per label si prendeva quella:
  // un'auto con "Km 98.000 certificati" scritto dal venditore usciva come 95.000.
  const fx = require('./fixtures/subito-hades-sample.json');
  assert.strictEqual(mapAd(fx.ads[0]).km, 98000);

  const km = feats => mapAd({ urls: { default: 'u' }, features: feats }).km;
  const S = v => ({ uri: '/mileage_scalar', label: 'Km', values: [{ value: v }] });
  const F = v => ({ uri: '/mileage', label: 'Km', values: [{ value: v }] });
  assert.strictEqual(km([F('95.000 - 99.999'), S('98000 Km')]), 98000, 'lo scalare vince sulla fascia');
  assert.strictEqual(km([F('120.000 - 129.999')]), 120000, 'senza scalare, la fascia resta il ripiego');
  // 9999999 e' il segnaposto di "non dichiarato": stamparlo sarebbe peggio di non dire niente.
  assert.strictEqual(km([S('9999999 Km')]), null, 'il segnaposto non diventa un chilometraggio');
  assert.strictEqual(km([S('0 Km')]), 0, 'zero km e\' un dato vero (km 0), non un assente');
});

test('km: quanto e\' larga davvero la fascia chiesta, sui due lati', () => {
  // `ms` e `me` sono CATEGORIE, non numeri: il filtro km di Subito arriva fino alla fine della
  // fascia e parte dal suo inizio. Finora non si notava perche' l'app stampava il fondo-fascia;
  // ora che i km sono quelli veri, quegli annunci si vedono e vanno spiegati a chi guarda.
  const { kmTettoFascia: su, kmPavimentoFascia: giu } = scrape;
  assert.strictEqual(su(200000), 249999, 'chiedendo max 200.000 arrivano annunci fino a 249.999');
  assert.strictEqual(su(100000), 109999);
  assert.strictEqual(giu(22000), 20000, 'chiedendo min 22.000 arrivano annunci da 20.000');
  assert.strictEqual(giu(205000), 200000);
  // Sui numeri tondi la fascia combacia: niente da avvertire, e l'avviso non deve comparire.
  assert.strictEqual(giu(20000), null);
  assert.strictEqual(giu(30000), null);
  assert.strictEqual(su(24999), null);
  // Valori assenti o senza senso: nessun avviso, mai un NaN a schermo.
  for (const v of [null, undefined, 0, -1, 'boh']) {
    assert.strictEqual(su(v), null); assert.strictEqual(giu(v), null);
  }
});

test('mapAd: senza url → null', () => {
  const ad = JSON.parse(JSON.stringify(AD)); ad.urls = {};
  assert.strictEqual(mapAd(ad), null);
});

test('buildPath: categoria auto=2 / moto=3 + query', () => {
  assert.match(buildPath({ tipo: 'auto', marca: 'BMW', modello: '320d' }, 0), /[?&]c=2&/);
  assert.match(buildPath({ tipo: 'auto', marca: 'BMW', modello: '320d' }, 0), /q=BMW\+320d/);
  assert.match(buildPath({ tipo: 'moto', marca: 'Honda' }, 50), /[?&]c=3&/);
  assert.match(buildPath({ tipo: 'moto', marca: 'Honda' }, 50), /start=50/);
});

/**
 * REGRESSIONE. Il commento diceva "hades espone ad.date (ISO)", ma nel payload vero quel
 * campo non esiste (ne' `dates.created`): la catena ripiegava sempre su `dates.display`,
 * che e' la stessa data SENZA fuso — `new Date()` la interpreta col fuso della macchina,
 * quindi su un host UTC slitta di due ore. Il campo giusto e' li' accanto, gia' pronto.
 */
test('posted_at: si legge display_iso8601, non la stringa locale senza fuso', () => {
  const dates = {
    display: '2026-06-24 11:17:20',
    display_iso8601: '2026-06-24T11:17:20.26+0200',
  };
  const r = mapAd({ ...AD, dates }, {});
  assert.strictEqual(r.posted_at, '2026-06-24T11:17:20.26+0200');
  // La prova che conta: l'istante e' univoco, non dipende dal fuso di chi legge.
  assert.strictEqual(new Date(r.posted_at).toISOString(), '2026-06-24T09:17:20.260Z');
  // Senza il campo ISO si dice null: meglio nessuna data che una che slitta.
  assert.strictEqual(mapAd({ ...AD, dates: { display: '2026-06-24 11:17:20' } }, {}).posted_at, null);
  assert.strictEqual(mapAd({ ...AD }, {}).posted_at, null);
});

test('privato: il testo aiuta a dedurre la versione Auto ma non arriva al client', async () => {
  const ad = {
    subject: 'Volkswagen Golf del 2016', body: 'Vendo Golf 1.6 TDI 110 CV 5p. Highline BlueMotion Technology, unico proprietario',
    urls: { default: 'https://www.subito.it/auto/golf-prova-456.htm' },
    advertiser: { company: false, name: 'Persona Test', user_id: 77 },
    features: [f('Prezzo', '9.500 €'), { type: 'pack', uri: '/car', label: 'Auto', values: [
      { label: 'Marca', key: '000101', value: 'Volkswagen' },
      { label: 'Modello', key: '004152', value: 'Golf 7ª serie' },
      { label: 'Versione', key: '000000', value: 'Altro allestimento' },
    ] }],
  };
  scrape._setHttpGetJson(async () => ({ status: 200, body: JSON.stringify({ ads: [ad], count_all: 1 }) }));
  try {
    const r = await scrape({ tipo: 'auto', marca: 'Volkswagen', modello: 'Golf' },
      { withMeta: true, maxPages: 1, senzaRecupero: true });
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].versioneDedotta?.versione, 'Golf 1.6 TDI 110 CV 5p. Highline BlueMotion Technology');
    assert.equal(r.items[0].descrizione, null);
    assert.equal(r.items[0].venditoreNome, null);
    assert.equal(r.items[0].venditoreId, null);
    assert.equal(JSON.stringify(r.items).includes('Persona Test'), false);
  } finally { scrape._setHttpGetJson(null); }
});

test('Subito: il body al limite è valido; oltre il limite si interrompe senza dichiarare zero annunci', async () => {
  const get = https.get;
  let distrutta = false;
  let body;
  https.get = (_options, cb) => {
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => { distrutta = true; };
    process.nextTick(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.setEncoding = () => {};
      cb(res);
      res.emit('data', body);
      if (!distrutta) res.emit('end');
    });
    return req;
  };
  try {
    const vuoto = '{"ads":[],"count_all":0,"pad":""}';
    body = vuoto.replace('""}', '"' + 'x'.repeat(808290 - Buffer.byteLength(vuoto)) + '"}');
    assert.equal(Buffer.byteLength(body), 808290);
    const ok = await scrape({ tipo: 'auto', marca: 'Volkswagen' }, { withMeta: true, senzaRecupero: true });
    assert.equal(ok.items.length, 0);
    assert.equal(distrutta, false);

    body += ' ';
    await assert.rejects(
      scrape({ tipo: 'moto', marca: 'Ducati' }, { withMeta: true, senzaRecupero: true }),
      e => e.kind === 'error' && e.code === 'SUBITO_BODY_TOO_LARGE' && /oltre il limite/.test(e.message));
    assert.equal(distrutta, true);
  } finally { https.get = get; }
});
