'use strict';
// F50 copertura — estrattori PURI del totale per-query, provati su FIXTURE REALI
// catturate dalle fonti (no rete in test). + builder count-query AS24.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const subito = require('../backend/scrapers/subito-api');
const motoit = require('../backend/scrapers/motoit');
const as24 = require('../backend/scrapers/autoscout-graphql');

const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

test('Subito _extractTotal: count_all dalla risposta hades reale', () => {
  const j = JSON.parse(fx('subito-hades-sample.json'));
  const n = subito._extractTotal(j);
  assert.ok(Number.isInteger(n) && n > 1000, `count_all atteso int>1000, ottenuto ${n}`);
  assert.equal(subito._extractTotal({}), null);            // assente → null
  assert.equal(subito._extractTotal({ count_all: 'x' }), null);
});

test('Moto.it _extractTotal: "N annunci" dallo span titolo-lista (ancorato, punto=migliaia)', () => {
  const n = motoit._extractTotal(fx('motoit-count-snippet.html'));
  assert.equal(n, 4323, `atteso 4323, ottenuto ${n}`);
  const span = v => `<span class="plist-head-title-info">${v}</span>`;
  assert.equal(motoit._extractTotal(span('0 annunci')), 0);             // pagina 0-risultati
  // ANTI-tetto-sbagliato: un "N annunci" di marketing PRIMA dello span NON vince.
  assert.equal(motoit._extractTotal('<p>oltre 100.000 annunci su Moto.it</p>' + span('4.323 annunci')), 4323);
  assert.equal(motoit._extractTotal(span('4.323&nbsp;annunci')), 4323);  // entity ammessa
  assert.equal(motoit._extractTotal('0 annunci'), null);                 // fuori dallo span → miss (non 0)
  assert.equal(motoit._extractTotal('class="mkt-head-meta-item--annunci"'), null);  // CSS, niente cifra
  assert.equal(motoit._extractTotal(''), null);
  assert.equal(motoit._extractTotal(null), null);
});

test('Subito _extractTotal: non muta l’input → additività degli items garantita', () => {
  // Il rischio di regressione (finder): "total calcolato consumando la stessa lista".
  // La cattura del tetto NON deve toccare `ads` (da cui si costruiscono gli items).
  const j = { count_all: 4874, ads: [{ urls: { default: 'x' } }] };
  const before = JSON.stringify(j);
  subito._extractTotal(j);
  assert.equal(JSON.stringify(j), before);
});

test('AS24 _countQueryString: mmmv → queryString (atype C auto / B moto · ustate=U usato-only)', () => {
  // ustate=U: il tetto conta SOLO usato (= ciò che ingeriamo); le nuove gonfiavano la copertura.
  assert.equal(as24._countQueryString('29|1768||', 'auto'),
    'sort=standard&desc=0&ustate=U&atype=C&cy=I&mmm=29|1768|');
  assert.equal(as24._countQueryString('2120|71635||', 'moto'),
    'sort=standard&desc=0&ustate=U&atype=B&cy=I&mmm=2120|71635|');
  assert.equal(as24._countQueryString('29|||', 'auto'),     // brand-only
    'sort=standard&desc=0&ustate=U&atype=C&cy=I&mmm=29||');
  assert.equal(as24._countQueryString('', 'auto'), null);   // senza make → null
});

test('AS24 _parseTotalCount: legge totalItems dalla risposta (0/mancante/stringa)', () => {
  const wrap = ti => ({ data: { search: { listingsByQueryString: { metadata: { totalItems: ti } } } } });
  assert.equal(as24._parseTotalCount(wrap(33)), 33);        // Ford Bronco provato live
  assert.equal(as24._parseTotalCount(wrap(0)), 0);          // 0 valido (modello delistato)
  assert.equal(as24._parseTotalCount(wrap('33')), null);    // stringa: scartata (mai valore non-numerico)
  assert.equal(as24._parseTotalCount({ data: { search: { listingsByQueryString: { metadata: {} } } } }), null);
  assert.equal(as24._parseTotalCount({ data: {} }), null);  // shape parziale
  assert.equal(as24._parseTotalCount({}), null);
  assert.equal(as24._parseTotalCount(null), null);
});
