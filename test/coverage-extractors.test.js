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

test('Moto.it _extractTotal: "N annunci" dalla pagina reale (punto = migliaia)', () => {
  const n = motoit._extractTotal(fx('motoit-count-snippet.html'));
  assert.equal(n, 4323, `atteso 4323, ottenuto ${n}`);
  assert.equal(motoit._extractTotal('0 annunci'), 0);       // pagina 0-risultati
  assert.equal(motoit._extractTotal('class="mkt-head-meta-item--annunci"'), null);  // CSS, niente cifra
  assert.equal(motoit._extractTotal(''), null);
  assert.equal(motoit._extractTotal(null), null);
});

test('AS24 _countQueryString: mmmv → queryString (atype C auto / B moto)', () => {
  assert.equal(as24._countQueryString('29|1768||', 'auto'),
    'sort=standard&desc=0&ustate=N,U&atype=C&cy=I&mmm=29|1768|');
  assert.equal(as24._countQueryString('2120|71635||', 'moto'),
    'sort=standard&desc=0&ustate=N,U&atype=B&cy=I&mmm=2120|71635|');
  assert.equal(as24._countQueryString('29|||', 'auto'),     // brand-only
    'sort=standard&desc=0&ustate=N,U&atype=C&cy=I&mmm=29||');
  assert.equal(as24._countQueryString('', 'auto'), null);   // senza make → null
});
