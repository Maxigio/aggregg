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

test('parco: l\'elenco finisce sulle card PRESENTI, non su quelle che si sono lette', async () => {
  // Il ciclo confrontava le card RIUSCITE con 12: una sola card fuori standard (promo, "in
  // arrivo", markup diverso) su una pagina piena faceva credere che l'elenco fosse finito, e
  // un parco da sessanta si fermava a undici — con `troncato: false` e le mediane calcolate
  // su quegli undici, senza nessun avviso.
  const card = id => '<div class="dlr-card">' + (id ? `<a data-target="#annuncio_${id}"></a>` : '')
    + '<span class="dlr-card__info__title__brand">Yamaha</span>'
    + '<span class="dlr-card__info__title__model">MT-07</span>'
    + '<span class="dlr-card__extrainfo__price">5.000 €</span>'
    + '<span class="dlr-card__meta">10.000 km del 2019</span></div>';
  const pag = ids => `<html><body>${ids.map(card).join('')}</body></html>`;

  const motoit = require('../backend/scrapers/motoit');
  const orig = motoit._get;
  const chieste = [];
  // Pagina 1: 12 card grezze, di cui UNA senza data-target → 11 leggibili. Pagina 2: 5 card.
  motoit._get = async url => {
    chieste.push(url);
    if (/pagina-2/.test(url)) return { status: 200, body: pag([2001, 2002, 2003, 2004, 2005]) };
    if (/pagina-/.test(url)) return { status: 200, body: pag([]) };
    return { status: 200, body: pag([null, 1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011]) };
  };
  try {
    const r = await v.parco('prova', { maxPagine: 5 });
    assert.strictEqual(chieste.length, 2, 'la pagina 2 deve essere chiesta: la pagina 1 era PIENA');
    assert.strictEqual(r.items.length, 16, '11 leggibili + 5 = 16');
    assert.strictEqual(r.illeggibili, 1, 'la card non letta si conta e si dice');
    assert.strictEqual(r.troncato, false);
  } finally { motoit._get = orig; }
});

test('parco: card presenti ma nessuna leggibile → errore dichiarato, non parco vuoto', async () => {
  // Se cambiano le classi della vetrina, prima si rispondeva "veicoli presi 0" come se il
  // piazzale fosse vuoto: un parco inesistente archiviato come completo.
  const motoit = require('../backend/scrapers/motoit');
  const orig = motoit._get;
  motoit._get = async () => ({ status: 200, body: '<html><body>' + '<div class="dlr-card"></div>'.repeat(12) + '</body></html>' });
  try {
    await assert.rejects(() => v.parco('prova', { maxPagine: 2 }), /non si leggono/);
  } finally { motoit._get = orig; }
});

// ─── Una vetrina vista a meta' non e' una vetrina completa ────────────────────
// Fino a ieri i due `break` dalla pagina 2 in poi — status non-200 e card illeggibili —
// uscivano senza toccare `troncato`, che diventava vero solo raggiungendo il tetto delle 40
// pagine. Il parco del concessionario tornava dimezzato e dichiarato completo, e il pannello
// Competitor ci calcolava sopra prezzo minimo, mediana, giacenze e arrivi recenti.
const cardOk = id => '<div class="dlr-card">' + `<a data-target="#annuncio_${id}"></a>`
  + '<span class="dlr-card__info__title__brand">Yamaha</span>'
  + '<span class="dlr-card__info__title__model">MT-07</span>'
  + '<span class="dlr-card__extrainfo__price">5.000 €</span>'
  + '<span class="dlr-card__meta">10.000 km del 2019</span></div>';
const paginaPiena = base => `<html><body>${Array.from({ length: 12 }, (_, i) => cardOk(base + i)).join('')}</body></html>`;

test('parco: una pagina non-200 a meta\' conserva i veicoli e dichiara la pagina fallita', async () => {
  const motoit = require('../backend/scrapers/motoit');
  const orig = motoit._get;
  motoit._get = async url => (/pagina-3/.test(url) ? { status: 503, body: '' } : { status: 200, body: paginaPiena(/pagina-2/.test(url) ? 2000 : 1000) });
  try {
    const r = await v.parco('prova', { maxPagine: 5 });
    assert.strictEqual(r.items.length, 24, 'le due pagine buone si tengono');
    assert.strictEqual(r.errorePagina.status, 503, 'senza questo il parco esce dichiarato completo e le mediane si calcolano su meta\' piazzale');
  } finally { motoit._get = orig; }
});

test('parco: card illeggibili a pagina >1 → troncato E contate', async () => {
  const motoit = require('../backend/scrapers/motoit');
  const orig = motoit._get;
  // Pagina 2 piena di card che non espongono l'id: markup cambiato, non piazzale finito.
  motoit._get = async url => (/pagina-2/.test(url)
    ? { status: 200, body: '<html><body>' + '<div class="dlr-card"></div>'.repeat(12) + '</body></html>' }
    : { status: 200, body: paginaPiena(1000) });
  try {
    const r = await v.parco('prova', { maxPagine: 5 });
    assert.strictEqual(r.items.length, 12);
    assert.strictEqual(r.troncato, true);
    assert.strictEqual(r.illeggibili, 12, 'prima l\'uscita saltava anche la riga che le conta: sparivano due volte');
  } finally { motoit._get = orig; }
});
