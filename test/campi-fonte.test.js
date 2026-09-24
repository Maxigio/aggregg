'use strict';
/**
 * I CAMPI CHE LE FONTI DICEVANO E NON LEGGEVAMO.
 *
 * Tre parser, una regola sola: un campo ASSENTE resta `null`, non diventa `false`.
 * "Non dichiarato" e "No" sono due cose diverse — un annuncio che non parla di IVA non
 * e' un annuncio senza IVA, e mostrarlo come "No" sarebbe scrivere una cosa non vera.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const { _mapAd } = require('../backend/scrapers/subito-api');
const { _parseMotoit } = require('../backend/scrapers/detail');
const { _testoPulito, _mapListing } = require('../backend/scrapers/autoscout-graphql');
const { _mapCards } = require('../backend/scrapers/motoit');

// ─── Subito ───────────────────────────────────────────────────────────────────
const adSubito = (features, extra = {}) => ({
  subject: 'Volkswagen Golf', urls: { default: 'https://www.subito.it/x/1.htm' },
  features: [{ label: 'Prezzo', values: [{ key: '9000', value: '9.000 €' }] }, ...features],
  geo: { region: { friendly_name: 'lombardia' }, city: { value: 'Brescia' } },
  ...extra,
});

test('subito: i kW sono nativi, non stimati dai CV', () => {
  const r = _mapAd(adSubito([{ label: 'Potenza', values: [{ key: '51/69', value: '51 kW / 69 Cv' }] }]));
  assert.strictEqual(r.potenzaKw, 51);
  assert.strictEqual(r.potenzaCv, 69);
});

test('subito: IVA e garanzia dalla chiave nativa; assenti restano null', () => {
  const pieno = _mapAd(adSubito([
    { label: 'Iva esposta', values: [{ key: '1', value: 'Sì' }] },
    { label: 'Garanzia', values: [{ key: '24', value: '24 mesi' }] },
    { label: 'Mese di immatricolazione', values: [{ key: '7', value: 'Luglio' }] },
  ]));
  assert.strictEqual(pieno.ivaEsposta, true);
  assert.strictEqual(pieno.garanziaMesi, 24);
  assert.strictEqual(pieno.mese, 7);

  const vuoto = _mapAd(adSubito([]));
  assert.strictEqual(vuoto.ivaEsposta, null, 'IVA non dichiarata NON e\' "No"');
  assert.strictEqual(vuoto.garanziaMesi, null);
  assert.strictEqual(vuoto.mese, null);

  // "No" dichiarato resta false: e' un dato, non un buco.
  const no = _mapAd(adSubito([{ label: 'Iva esposta', values: [{ key: '0', value: 'No' }] }]));
  assert.strictEqual(no.ivaEsposta, false);
});

test('subito: comune con codice ISTAT e testo dell\'annuncio', () => {
  const r = _mapAd(adSubito([], {
    advertiser: { company: true },
    body: '  Ottime condizioni  ',
    geo: { region: { friendly_name: 'lombardia' }, city: { value: 'Pavia' },
           town: { value: 'Badia Pavese', istat: '018006' } },
  }));
  assert.strictEqual(r.comune, 'Badia Pavese');
  assert.strictEqual(r.istat, '018006');
  assert.strictEqual(r.descrizione, 'Ottime condizioni');
  assert.strictEqual(_mapAd(adSubito([])).descrizione, null, 'annuncio senza testo → null, non stringa vuota');
});

// ─── Autoscout ────────────────────────────────────────────────────────────────
test('autoscout: il testo perde il markup ma tiene gli a capo', () => {
  const t = _testoPulito('Auto incidentata.<br />Portiere buone.<br/><p>Vendo &amp; tratto</p>');
  assert.strictEqual(t, 'Auto incidentata.\nPortiere buone.\nVendo & tratto');
  assert.strictEqual(_testoPulito('   '), null);
  assert.strictEqual(_testoPulito(null), null);
});

const nodoAs24 = (extra = {}) => ({
  details: {
    webPage: 'https://www.autoscout24.it/annunci/x',
    prices: { public: { amountInEUR: { raw: 12000 }, ...(extra.prezzo || {}) } },
    vehicle: {
      classification: { make: { formatted: 'Volkswagen' }, model: { formatted: 'Golf' } },
      condition: {}, ...(extra.vehicle || {}),
    },
    ...(extra.top || {}),
  },
});

test('autoscout: la valutazione c\'e\' solo se la fonte manda la mediana', () => {
  const senza = _mapListing(nodoAs24());
  assert.strictEqual(senza.valutazione, null, 'niente mediana → niente valutazione inventata');

  const con = _mapListing(nodoAs24({ prezzo: { evaluation: { median: 11000, category: 3, equipmentCount: 12 } } }));
  assert.deepStrictEqual(con.valutazione, { mediana: 11000, categoria: 3, optionalContati: 12 });
});

test('autoscout: optional in lista piatta, le voci senza nome cadono', () => {
  const r = _mapListing(nodoAs24({ vehicle: { equipment: { as24: [
    { id: { formatted: 'Sedili riscaldati' }, equipmentCategory: { formatted: 'Comfort' } },
    { id: { formatted: '' }, equipmentCategory: { formatted: 'Comfort' } },
    { id: { formatted: 'ABS' } },
  ] }, condition: {} } }));
  assert.deepStrictEqual(r.optional, [
    { nome: 'Sedili riscaldati', categoria: 'Comfort' },
    { nome: 'ABS', categoria: null },
  ]);
  assert.deepStrictEqual(_mapListing(nodoAs24()).optional, []);
});

test('autoscout: il peso a vuoto arriva in due unita\' e si normalizza in kg', () => {
  // Misurato su 65 annunci veri: 34 in tonnellate, 31 in chilogrammi, stesso campo.
  const peso = w => _mapListing(nodoAs24({ vehicle: { emptyWeight: { raw: w }, condition: {} } })).pesoVuoto;
  assert.strictEqual(peso(1.441), 1441, 'tonnellate → kg');
  assert.strictEqual(peso(1.2), 1200);
  assert.strictEqual(peso(1322), 1322, 'i kg restano kg');
  assert.strictEqual(peso(1760), 1760);
  assert.strictEqual(peso(90.5), 91, 'uno scooter da 90,5 kg NON e\' mezza tonnellata');
  assert.strictEqual(peso(0), null);
  assert.strictEqual(peso(null), null);
});

test('autoscout: garanzia senza durata = 0 (c\'e\'), garanzia assente = null', () => {
  assert.strictEqual(_mapListing(nodoAs24({ top: { warranty: { warrantyExists: true } } })).garanziaMesi, 0);
  assert.strictEqual(_mapListing(nodoAs24({ top: { warranty: { warrantyExists: true, generic: { durationInMonth: { raw: 12 } } } } })).garanziaMesi, 12);
  assert.strictEqual(_mapListing(nodoAs24()).garanziaMesi, null);
  assert.strictEqual(_mapListing(nodoAs24({ top: { warranty: { warrantyExists: false } } })).garanziaMesi, null);
});

// ─── Moto.it ──────────────────────────────────────────────────────────────────
const PAGINA_MOTO = `
<html><body>
  <div class="mseller-name"><a href="https://dealer.moto.it/nikomoto" title="Niko Moto">Niko Moto</a></div>
  <p>Luogo Lavis (TN)</p>
  <p>Annuncio nr.10066816 inserito il 15 luglio 2026 ore 00:10</p>
  <div>Tipo offerta Passaggio di propriet&agrave; a carico dell&#039;acquirente
       Garanzia garanzia concessionario
       Incidentata No Depotenziata No Solo uso pista No Abs S&igrave; Special No Elettrica No</div>
  <p>SEGNALA / PREVIENI UNA TRUFFA</p>
  <div>Annunci pubblicati 1.018 Annunci online 164 Utente di Moto.it dal 2009</div>
  <div>Cambio automatico Yamaha Tricity</div>
  <div>Scheda tecnica del modello: Abs S&igrave;</div>
</body></html>`;

test('moto.it: la data di inserimento diventa una data vera (prima era null)', () => {
  const d = _parseMotoit(PAGINA_MOTO);
  assert.strictEqual(d.posted_at, '2026-07-15T00:10:00');
  assert.strictEqual(d.numeroAnnuncio, '10066816');
});

test('moto.it: chi paga il passaggio, garanzia, venditore e vetrina', () => {
  const d = _parseMotoit(PAGINA_MOTO);
  assert.match(d.tipoOfferta, /a carico dell'acquirente$/);   // entita' HTML sciolte
  assert.strictEqual(d.garanzia, 'garanzia concessionario');
  assert.strictEqual(d.venditoreNome, 'Niko Moto');
  assert.strictEqual(d.vetrinaUrl, 'https://dealer.moto.it/nikomoto');
  assert.strictEqual(d.venditoreAnnunciOnline, 164);
  assert.strictEqual(d.venditoreDal, 2009);
  assert.strictEqual(d.comune, 'Lavis (TN)');
});

test('moto.it: le bandierine si leggono SOLO nel blocco della scheda', () => {
  const d = _parseMotoit(PAGINA_MOTO);
  // "Abs Sì" compare due volte: nella scheda dell'annuncio e in quella del MODELLO piu'
  // in basso. Vale la prima, se no un dato del listino passerebbe per un dato dell'usato.
  assert.strictEqual(d.abs, true);
  assert.strictEqual(d.incidentata, false);
  assert.strictEqual(d.usoPista, false);
  // pagina senza il blocco → tutte null, nessuna bandierina inventata
  const vuota = _parseMotoit('<html><body>niente scheda</body></html>');
  assert.strictEqual(vuota.incidentata, null);
  assert.strictEqual(vuota.tipoOfferta, null);
  assert.strictEqual(vuota.posted_at, null);
});

test('moto.it: il cambio e\' UNA parola (leggeva "automatico Y")', () => {
  assert.strictEqual(_parseMotoit(PAGINA_MOTO).cambio, 'automatico');
});

// ─── La provincia e' UNA sigla, su tutte e tre le fonti ────────────────────────
test('provincia: sigla di due maiuscole (o null) da tutti e tre i mapper', () => {
  // E' una CHIAVE di raggruppamento: «Cagliari» contro «CA» faceva due gruppi per la
  // stessa provincia — in griglia, nel CSV e nel PDF. La forma si blinda sui MAPPER,
  // che sono l'unico punto in cui le tre fonti diventano una colonna sola.
  const sigla = /^[A-Z]{2}$/;
  // Subito: la sigla nativa quando c'e' (geo.city.short_name)...
  const conSigla = _mapAd(adSubito([], { geo: { city: { value: 'Cagliari', short_name: 'CA' } } }));
  assert.strictEqual(conSigla.provincia, 'CA');
  // ...e il risolutore unico quando manca: la fixture base porta solo «Brescia».
  const daNome = _mapAd(adSubito([]));
  assert.strictEqual(daNome.provincia, 'BS');
  // Autoscout: location.city passa gia' dal risolutore unico.
  const as = _mapListing(nodoAs24({ top: { location: { city: 'Milano (MI)', zip: '20121' } } }));
  assert.strictEqual(as.provincia, 'MI');
  // Moto.it: la card di ricerca legge la sigla fra parentesi, e la porta com'e'.
  const card = _mapCards([{ titolo: 'Yamaha MT-07', priceRaw: '€ 5.000', href: '/x', provincia: 'TN' }])[0];
  assert.strictEqual(card.provincia, 'TN');
  for (const p of [conSigla.provincia, daNome.provincia, as.provincia, card.provincia]) {
    assert.ok(p === null || sigla.test(p), `provincia "${p}" non e' una sigla di due maiuscole`);
  }
});
