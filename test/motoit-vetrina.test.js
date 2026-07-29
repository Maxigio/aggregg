'use strict';
/**
 * La vetrina di un concessionario su Moto.it (sezione Competitor).
 *
 * La fixture e' un ritaglio VERO di dealer.moto.it/nikomoto: due card e il riquadro dei
 * contatti, non un HTML inventato. Quello che conta qui non e' che il parser giri, ma che
 * non prometta cose che la fonte non dice — un id che non c'e', un prezzo che non e' un
 * prezzo, uno slug preso da un link qualsiasi.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const v = require('../backend/scrapers/motoit-vetrina');

const HTML = fs.readFileSync(path.join(__dirname, 'fixtures', 'motoit-vetrina.html'), 'utf8');

test('lo slug si prende solo da dealer.moto.it, e solo il primo pezzo', () => {
  assert.equal(v.slugVetrina('https://dealer.moto.it/nikomoto'), 'nikomoto');
  assert.equal(v.slugVetrina('https://dealer.moto.it/nikomoto/Usato/pagina-2'), 'nikomoto');
  // Un link di Moto.it non e' una vetrina: chi chiama deve poter provare le altre fonti.
  assert.equal(v.slugVetrina('https://www.moto.it/moto-usate/yamaha/mt-07'), null);
  assert.equal(v.slugVetrina('https://dealer.moto.it/'), null);
  assert.equal(v.slugVetrina('non un url'), null);
});

test('l\'anagrafica si legge dall\'icona, non dalla posizione della riga', () => {
  const s = v._scheda(HTML, 'nikomoto');
  assert.equal(s.nome, 'Niko Moto');                 // il <title> continua dopo il trattino
  assert.equal(s.dove, 'Lavis (TN)');
  assert.equal(s.provincia, 'TN');                   // l'unico pezzo confrontabile con le altre fonti
  assert.match(s.via, /VIA PAGANELLA 42/);
  assert.equal(s.telefono, '0461420150');            // NON il fax, che sta nella riga dopo
  assert.equal(s.sito, 'https://www.nikomoto.it');
});

test('la card diventa un annuncio con foto, prezzo, km e anno', () => {
  const items = v._mapCards(HTML, { venditoreNome: 'Niko Moto', provincia: 'TN' });
  assert.equal(items.length, 2);
  const a = items[0];
  assert.equal(a.fonte, 'moto');
  assert.equal(a.marca, 'KTM');                      // la dice la fonte, non la prima parola del titolo
  assert.ok(a.prezzo > 0);
  assert.ok(a.anno >= 1990 && a.anno <= 2100);
  assert.equal(a.venditore, 'concessionario');       // una vetrina non ha privati dentro
  assert.equal(a.venditoreNome, 'Niko Moto');
  assert.equal(a.provincia, 'TN');
  assert.equal(a.immagini.length, 1);
  assert.match(a.immagini[0].thumb, /^https:\/\/cdn-img\./);
  assert.ok(a.descrizione && a.descrizione.length > 10);
  assert.equal(a.nuovo, false);
});

test('l\'URL dell\'annuncio lo normalizza Moto.it: conta solo l\'id in fondo', () => {
  // Misurato: /moto-usate/xxx/xxx/xxx/10066816 risponde 301 verso il percorso giusto,
  // mentre l'id da solo (/moto-usate/10066816) e' 404. Gli slug sono un tentativo, l'id no.
  const u = v._urlAnnuncio('10066816', 'Yamaha', 'Tricity 125 (2017 - 20)');
  assert.equal(u, 'https://www.moto.it/moto-usate/yamaha/tricity-125/tricity-125-2017-20/10066816');
  assert.match(v._urlAnnuncio('123', null, null), /\/123$/);
});

test('senza id la card non diventa un annuncio', () => {
  // Meglio una card in meno che un URL che finisce da un'altra parte.
  assert.deepEqual(v._mapCards('<div class="dlr-card"><h4>Yamaha</h4></div>'), []);
  assert.deepEqual(v._mapCards(''), []);
});
