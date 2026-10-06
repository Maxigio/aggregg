'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { creaAutorizzazioniDettagli } = require('../backend/nodi/autorizzazioni-dettagli');

test('dettagli firmati: oltre 300 risultati, URL e sessioni separate, scadenza esatta', () => {
  let now = 1000;
  const auth = creaAutorizzazioniDettagli({ora:()=>now});
  const a={scadenza:2000},b={scadenza:2000};
  const url='https://www.subito.it/moto/primo.htm';
  const primo=auth.emetti(a,url,'moto');
  for(let i=0;i<500;i++)auth.emetti(a,url+i,'auto');
  assert.equal(auth.verifica(a,url,primo),'moto');
  assert.equal(auth.verifica(b,url,primo),null);
  const altro=auth.emetti(b,url,'moto');
  assert.notEqual(primo,altro);
  assert.equal(auth.verifica(a,url+'?diverso',primo),null);
  assert.equal(auth.verifica(a,url,primo.slice(0,-2)+'AA'),null);
  assert.equal(auth.verifica(a,url,'x'.repeat(1000)),null);
  assert.equal(auth.verifica(a,url,null),null);
  a.azienda='altra';
  assert.equal(auth.verifica(a,url,primo),null);
  delete a.azienda;
  now=2000;
  assert.equal(auth.verifica(a,url,primo),null);
  assert.equal(auth.emetti(a,url,'moto'),null);
});

test('dettagli firmati: contesto diagnostico distinto anche nella stessa sessione', () => {
  const auth = creaAutorizzazioniDettagli({ ora: () => 1000 }), s = { scadenza: 2000 };
  const url = 'https://www.subito.it/moto/fixture.htm';
  const owner = auth.emetti(s, url, 'moto', 'proprietario'), cliente = auth.emetti(s, url, 'moto');
  assert.equal(auth.verifica(s, url, owner, 'proprietario'), 'moto');
  assert.equal(auth.verifica(s, url, owner), null);
  assert.equal(auth.verifica(s, url, cliente, 'proprietario'), null);
  assert.equal(auth.verifica(s, url, cliente), 'moto');
});
