'use strict';
/**
 * Le misure della redazione: il filtro per modello.
 *
 * Qui non si prova la rete, si prova la sola cosa che decide cosa vedi: quali prove
 * "possono" essere di questo modello. Il rischio e' l'opposto di quello che sembra — non
 * scartare troppo, ma tenere dentro una prova di un'altra moto e farla passare per la tua.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const route = require('../backend/prove-route');
const { _perModello } = route;
const autoit = require('../backend/scrapers/autoit-rilevamenti');

const V = [
  { nome: 'Golf VII 1.0 TSI' }, { nome: 'Golf VI R 2.0 TFSI DSG 3p' },
  { nome: 'Golf GTI Clubsport' }, { nome: 'Polo 1.4 TDI' }, { nome: 'up! 1.0 3 p' },
];

test('tiene solo le voci che contengono TUTTE le parole del modello', () => {
  assert.equal(_perModello(V, 'Golf').length, 3);
  assert.equal(_perModello(V, 'Golf GTI').length, 1);
  assert.equal(_perModello(V, 'Polo').length, 1);
});

test('un modello che la fonte non ha non tira dentro niente', () => {
  // Meglio "nessun rilevamento" che il rilevamento di un'altra macchina.
  assert.deepEqual(_perModello(V, 'Passat'), []);
  assert.deepEqual(_perModello(V, 'Golf Cabriolet'), []);
});

test('senza modello non si filtra: le voci restano quelle della marca', () => {
  assert.equal(_perModello(V, '').length, V.length);
  assert.equal(_perModello(V, null).length, V.length);
});

test('le parole si confrontano intere, non come pezzi di altre', () => {
  // "up" non deve agganciare "Clubsport" solo perche' contiene quelle due lettere.
  assert.equal(_perModello(V, 'up').length, 1);
  assert.equal(_perModello(V, 'up')[0].nome, 'up! 1.0 3 p');
});

/** Un finto `app` che tiene gli handler: la rotta e' quella vera, la rete no. */
function montaProveAuto() {
  let h = null;
  route.mount({ get: (p, ...f) => { if (p === '/api/prove/auto') h = f[f.length - 1]; } }, {});
  return h;
}
function resFinta() {
  const r = { code: 200, body: null };
  r.status = c => { r.code = c; return r; };
  r.json = b => { r.body = b; return r; };
  return r;
}
/** Chiama la rotta con lo scraper sostituito: nessuna richiesta, nessuna cache toccata. */
async function conFonte(d, query) {
  const prima = { marche: autoit.marche, rilevamenti: autoit.rilevamenti, pausaFinoA: autoit.pausaFinoA };
  autoit.marche = async () => [{ nome: 'Jaguar', acronimo: 'jaguar-jag' }];
  autoit.rilevamenti = async () => d;
  autoit.pausaFinoA = () => 0;
  const res = resFinta();
  try { await montaProveAuto()({ query, ip: '203.0.113.9' }, res); } finally { Object.assign(autoit, prima); }
  return res.body;
}

test('un elenco monco esce dichiarato monco, non come assenza', async () => {
  // Jaguar dichiara 13 rilevamenti su due pagine e la seconda cade in timeout: la F-Pace SVR
  // stava li'. Zero voci qui NON vuol dire che la fonte non abbia quel modello, e il pannello
  // deve poterlo distinguere — altrimenti afferma per la fonte una cosa che la fonte non ha detto.
  const b = await conFonte({
    marca: 'Jaguar', slug: 'jaguar-jag', dichiarati: 13, completo: false,
    rilevamenti: [{ nome: 'E-Pace 2.0d AWD', anno: 2018 }],
    fonte: 'Auto (auto.it) — rilevamenti della redazione',
  }, { marca: 'Jaguar', modello: 'F-Pace SVR' });
  assert.equal(b.ok, true);
  assert.deepEqual(b.voci, []);
  assert.equal(b.completo, false);
  assert.equal(b.dichiarati, 13);
});

test('un elenco intero si dichiara intero', async () => {
  const b = await conFonte({
    marca: 'Jaguar', slug: 'jaguar-jag', dichiarati: 2, completo: true,
    rilevamenti: [{ nome: 'F-Pace SVR', anno: 2019 }, { nome: 'E-Pace 2.0d AWD', anno: 2018 }],
    fonte: 'Auto (auto.it) — rilevamenti della redazione',
  }, { marca: 'Jaguar', modello: 'F-Pace SVR' });
  assert.equal(b.completo, true);
  assert.equal(b.quante, 1);
});
