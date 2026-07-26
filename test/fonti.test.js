'use strict';
/**
 * Area FONTI — le quattro banche dati aperte.
 *
 * I test girano OFFLINE: si prova il parsing sui dati reali gia' letti e l'instradamento delle
 * route su un finto `app`. Le chiamate di rete (Overpass, EPREL, bilstein, Wheel-Size) non si
 * fanno qui: una suite che dipende dalla rete diventa rossa quando cade una fonte terza, e a quel
 * punto smette di dire qualcosa sul NOSTRO codice.
 */
const { test } = require('node:test');
const assert = require('node:assert');

const fonti = require('../backend/fonti-route');
const osm = require('../backend/scrapers/osm-territorio');
const eprel = require('../backend/scrapers/eprel-pneumatici');
const bilstein = require('../backend/scrapers/bilstein-oe');
const wheelsize = require('../backend/scrapers/wheelsize');
const PROVINCE = require('../data/province.json');

const rotte = {};
fonti.mount({ get: (p, h) => { rotte[p] = h; } }, { clientIp: () => 'test' });

async function chiama(percorso, query = {}) {
  const h = rotte[percorso];
  assert.ok(h, 'route non montata: ' + percorso);
  let out = null;
  const res = { _h: {}, status() { return this; }, set(k, v) { this._h[k] = v; return this; }, json(b) { out = b; return this; } };
  await h({ query, ip: 'test' }, res);
  return { corpo: out, headers: res._h };
}

test('sono montate tutte le route dell\'area', () => {
  for (const p of ['/api/fonti', '/api/fonti/territorio/categorie', '/api/fonti/territorio/conta',
    '/api/fonti/territorio/oggetti', '/api/fonti/pneumatici/totale', '/api/fonti/pneumatici/cerca',
    '/api/fonti/ricambi-oe/cerca', '/api/fonti/ricambi-oe/equivalenti', '/api/fonti/cerchi/calzate',
    '/api/fonti/costi/provincia', '/api/fonti/costi/classifica']) {
    assert.ok(rotte[p], 'manca ' + p);
  }
});

test('ogni fonte dichiara cosa sa E cosa non sa', async () => {
  // Sono banche dati parziali: nasconderne i limiti le renderebbe inservibili proprio quando
  // servono. L'interfaccia lo mostra, e questo test impedisce che una fonte nuova arrivi muta.
  const { corpo, headers } = await chiama('/api/fonti');
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(headers['Cache-Control'], 'no-store', 'porta lo stato di pausa: non si caccia');
  assert.strictEqual(corpo.fonti.length, 5);
  assert.deepStrictEqual(corpo.fonti.map(f => f.id), ['territorio', 'pneumatici', 'ricambiOe', 'cerchi', 'costi']);
  for (const f of corpo.fonti) {
    assert.ok(f.sa && f.sa.length > 30, f.id + ': manca cosa sa');
    assert.ok(f.nonSa && f.nonSa.length > 30, f.id + ': manca cosa NON sa');
    assert.ok(f.dettaglio && /—/.test(f.dettaglio), f.id + ': il dettaglio deve citare la fonte');
  }
});

test('categorie del territorio: nessuna rete, tredici voci e le venti regioni', async () => {
  const { corpo } = await chiama('/api/fonti/territorio/categorie');
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.categorie.length, 13);
  assert.ok(corpo.categorie.some(c => c.id === 'concessionari' && c.nome === 'Concessionari'));
  assert.strictEqual(corpo.regioni.length, 20);
  // Le regioni devono essere le stesse chiavi che usa gia' province.json, o da una provincia non
  // si arriverebbe alla sua regione.
  const nostre = [...new Set(Object.values(PROVINCE).map(p => p.regione))];
  assert.deepStrictEqual(nostre.filter(r => !corpo.regioni.includes(r)), []);
});

test('parametri mancanti: si dice cosa manca invece di rispondere vuoto', async () => {
  assert.strictEqual((await chiama('/api/fonti/territorio/oggetti')).corpo.motivo, 'categoria mancante');
  assert.match((await chiama('/api/fonti/pneumatici/cerca')).corpo.motivo, /misura o.*marca/);
  assert.strictEqual((await chiama('/api/fonti/ricambi-oe/cerca')).corpo.motivo, 'codice mancante');
  assert.match((await chiama('/api/fonti/cerchi/calzate', { marca: 'Fiat' })).corpo.motivo, /marca, modello e anno/);
});

test('territorio: categoria o regione inventata non va in rete', async () => {
  // Il controllo sta PRIMA della richiesta: una categoria sbagliata non deve costare una query
  // all'istanza pubblica di Overpass, che e' un bene comune.
  const a = await chiama('/api/fonti/territorio/oggetti', { categoria: 'inventata' });
  assert.strictEqual(a.corpo.ok, false);
  assert.match(a.corpo.motivo, /categoria sconosciuta/);
  const b = await chiama('/api/fonti/territorio/oggetti', { categoria: 'concessionari', regione: 'atlantide' });
  assert.strictEqual(b.corpo.ok, false);
  assert.match(b.corpo.motivo, /regione sconosciuta/);
});

test('costi: una provincia porta premio, percentili, classi e imposta', async () => {
  const { corpo } = await chiama('/api/fonti/costi/provincia', { provincia: 'mi', tipo: 'auto' });
  assert.strictEqual(corpo.ok, true);
  assert.strictEqual(corpo.sigla, 'MI');
  assert.strictEqual(corpo.nome, 'Milano', 'la sigla da sola non si mostra a un operatore');
  // La mediana e' il numero da leggere: la media la tirano su le poche polizze carissime.
  assert.ok(corpo.rc.mediana > 0 && corpo.rc.mediana < corpo.rc.medio, 'a Milano media > mediana');
  for (const k of ['p10', 'p25', 'p75', 'p90']) assert.ok(corpo.rc[k] > 0, 'manca ' + k);
  assert.ok(Object.keys(corpo.rc.perClasse).length >= 4, 'mancano le classi bonus-malus');
  assert.strictEqual(typeof corpo.aliquotaRc, 'number');
  // Tutti e tre i tipi in una risposta sola: la domanda e' "quanto costa qui", non "quanto costa
  // l'auto qui", e rifare la richiesta per la moto sarebbe un giro a vuoto.
  assert.deepStrictEqual(Object.keys(corpo.perTipo), ['auto', 'moto', 'ciclomotore']);
  assert.ok(corpo.posizione.posto >= 1 && corpo.posizione.posto <= corpo.posizione.su);
});

test('costi: dove il dato non c\'e\' si dice PERCHE\', non si stima', async () => {
  // Sette province non hanno l'aliquota e una non ha i premi: e' una ragione della fonte, non
  // nostra, e nasconderla farebbe sembrare rotta l'app.
  const bz = (await chiama('/api/fonti/costi/provincia', { provincia: 'BZ' })).corpo;
  assert.strictEqual(bz.aliquotaRc, null);
  assert.match(bz.aliquotaMotivo, /statuto speciale|autonom/i);
  const zz = (await chiama('/api/fonti/costi/provincia', { provincia: 'ZZ' })).corpo;
  assert.match(zz.motivo, /provincia sconosciuta/);
  assert.match((await chiama('/api/fonti/costi/provincia')).corpo.motivo, /sigla/);
});

test('costi: la classifica e\' ordinata e non nasconde le province senza premio', async () => {
  const { corpo } = await chiama('/api/fonti/costi/classifica', { tipo: 'auto' });
  assert.ok(corpo.province.length > 100);
  for (let i = 1; i < corpo.province.length; i++) {
    assert.ok(corpo.province[i].mediana >= corpo.province[i - 1].mediana, 'classifica non ordinata');
  }
  assert.strictEqual(corpo.province[0].posto, 1);
  // Sud Sardegna non ha i premi: deve comparire fra le assenti, non sparire dall'elenco.
  assert.ok(corpo.senzaDato.some(x => x.sigla === 'SU'), 'una provincia senza dato non si cancella');
  assert.ok(corpo.periodo && corpo.fonti && corpo.nota);
});

test('OSM: l\'area si costruisce col codice ISO, non col nome', () => {
  assert.match(osm._areaDi('lombardia'), /IT-25/);
  assert.match(osm._areaDi(), /ISO3166-1"="IT"/);
  assert.match(osm._areaDi('inesistente'), /ISO3166-1"="IT"/, 'una regione ignota ricade sull\'Italia');
});

test('OSM: way e relation prendono la posizione da center', () => {
  // Meta' degli oggetti sono `way` e non hanno lat/lon proprie: senza leggere `center` finirebbero
  // tutti senza posizione, e la colonna mappa sarebbe vuota per meta' della tabella.
  const chiavi = osm.CATEGORIE.concessionari.chiavi;
  const nodo = osm._mappaOggetto({ type: 'node', id: 1, lat: 44.6, lon: 10.9, tags: { name: 'X', 'addr:city': 'Modena' } }, chiavi);
  assert.strictEqual(nodo.lat, 44.6);
  const via = osm._mappaOggetto({ type: 'way', id: 2, center: { lat: 45.1, lon: 9.2 }, tags: { name: 'Y' } }, chiavi);
  assert.strictEqual(via.lat, 45.1);
  assert.strictEqual(via.id, 'way/2');
  // I tag fuori elenco non si buttano: restano disponibili invece di sparire.
  const extra = osm._mappaOggetto({ type: 'node', id: 3, lat: 1, lon: 2, tags: { name: 'Z', shop: 'car', chissa: 'che' } }, chiavi);
  assert.strictEqual(extra.altriTag.chissa, 'che');
  assert.strictEqual(extra.dati.name, 'Z');
});

test('bilstein: i codici si confrontano ripuliti, o non agganciano mai', () => {
  // La fonte scrive "85E 819 439 B", i nostri dati e gli annunci lo portano attaccato.
  assert.strictEqual(bilstein._normCodice('85E 819 439 B'), '85E819439B');
  assert.strictEqual(bilstein._normCodice('1k0-615-301-aa'), '1K0615301AA');
  assert.strictEqual(bilstein._normCodice(null), '');
});

test('bilstein: da un articolo escono cross-reference e misure', () => {
  const a = bilstein._mappa({
    id: '1', attributes: {
      masterId: 360859, bgBrand: 'FEBI', articleDescription: 'disco freno', fittingSide: 'assale anteriore',
      packagingQty: 2, vehicleType: 'CAR',
      oeNumbers: [{ make: 'Audi', numbers: ['5Q0 615 301 F', '1K0 615 301 AA'] }, { make: 'Ford', numbers: ['2 631 432'] }],
      articleAttributes: [{ type: 'diametro esterno', unit: 'mm', value: '312' }, { type: 'senza valore' }],
    },
  });
  assert.strictEqual(a.marchio, 'FEBI');
  assert.strictEqual(a.descrizione, 'disco freno');
  assert.deepStrictEqual(a.costruttori, ['Audi', 'Ford']);
  assert.deepStrictEqual(a.codiciNormalizzati, ['5Q0615301F', '1K0615301AA', '2631432']);
  assert.strictEqual(a.misure.length, 1, 'una misura senza valore non si mostra');
  assert.deepStrictEqual(a.misure[0], { nome: 'diametro esterno', valore: '312', unita: 'mm' });
});

test('EPREL: la misura e i suoi cinque campi, non solo la stringa', () => {
  const p = eprel._mappa({
    eprelRegistrationNumber: '408316', supplierOrTrademark: 'MICHELIN',
    additionalDetails: { commercialName: 'PRIMACY 4 S1' }, modelIdentifier: '012961',
    sizeDesignation: '205/55R16', tyreDesignation: '205/55R16 91 H',
    tyreSection: 205, aspectRatio: 55, rimDiameter: 16, loadCapacityIndex: 91, speedCategorySymbol: 'H',
    energyClass: 'A', wetGripClass: 'B', externalRollingNoiseValue: 68, externalRollingNoiseClass: 'A',
    severeSnowTyre: false, iceTyre: false, tyreClass: 'C1', status: 'PUBLISHED', blocked: false,
  });
  assert.strictEqual(p.misura, '205/55R16');
  assert.strictEqual(p.misuraCompleta, '205/55R16 91 H');
  assert.strictEqual(p.sezione, 205);
  assert.strictEqual(p.rapporto, 55);
  assert.strictEqual(p.diametroCerchio, 16);
  assert.strictEqual(p.indiceCarico, 91);
  assert.strictEqual(p.simboloVelocita, 'H');
  // Il nome che il cliente riconosce e' commercialName, non il codice interno.
  assert.strictEqual(p.modello, 'PRIMACY 4 S1');
  assert.strictEqual(p.modelloDichiarato, '012961');
  assert.strictEqual(p.neve, false);
  assert.match(p.scheda, /^https:\/\/eprel\.ec\.europa\.eu\//);
});

test('Wheel-Size: metrico e imperiale convivono, si prende il metrico', () => {
  // Leggendo il testo della cella si otterrebbe "2.2 bar32 psi".
  assert.strictEqual(wheelsize._metrico('<span class="metric">2.2 bar</span><span class="imperial">32 psi</span>'), '2.2 bar');
  assert.strictEqual(wheelsize._metrico('<td>solo testo</td>'), 'solo testo');
  assert.strictEqual(wheelsize._slug('Alfa Romeo'), 'alfa-romeo');
});

test('Wheel-Size: la misura si estrae dal testo sporco del popover', () => {
  // La cella contiene anche la spiegazione di indice di carico e codice velocita'.
  const righe = wheelsize._calzateDa(`<tr>
    <td class="data-tire"><span class="metric">OE 175/65R15 88 560 kg 1235 lbs T 190 km/h 118 mph "&gt;88T</span></td>
    <td class="data-rim"><span class="metric">6Jx15 ET35</span></td>
    <td class="data-pressure"><span class="metric">2.2 2.0</span></td>
    <td class="data-weight"><span class="metric">7.7</span></td></tr>`);
  assert.strictEqual(righe.length, 1);
  const r = righe[0];
  assert.strictEqual(r.misura, '175/65R15');
  assert.strictEqual(r.indiceCarico, 88);
  assert.strictEqual(r.caricoKg, 560);
  assert.strictEqual(r.simboloVelocita, 'T');
  assert.strictEqual(r.velocitaMaxKmh, 190);
  assert.strictEqual(r.primoEquipaggiamento, true);
  assert.strictEqual(r.pressioneAntBar, 2.2);
  assert.strictEqual(r.pressionePostBar, 2);
});

test('Wheel-Size: una cella riempita dal JavaScript resta null, non diventa spazzatura', () => {
  // Sulle righe che la fonte carica via JS la misura non c'e': deve restare null, cosi'
  // l'interfaccia puo' scrivere "non servita" invece di mostrare uno spinner.
  const righe = wheelsize._calzateDa(`<tr>
    <td class="data-tire"><span id="abc"></span><span class="js-loading">loading</span></td>
    <td class="data-pressure"><span class="metric">2.2 2.0</span></td></tr>`);
  assert.strictEqual(righe[0].misura, null);
  assert.strictEqual(righe[0].pressioneAntBar, 2.2, 'la pressione invece c\'e su tutte le righe');
});
