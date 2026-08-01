'use strict';
// Il log dei test non va nel registro operativo vero (vedi backend/logger.js): deve stare
// PRIMA di ogni require di backend, perche' LOG_DIR e' una const valutata al caricamento.
const osTmp = require('node:os'), fsTmp = require('node:fs'), pathTmp = require('node:path');
process.env.AMR_LOG_DIR = fsTmp.mkdtempSync(pathTmp.join(osTmp.tmpdir(), 'amr-log-'));

const { test } = require('node:test');
const assert = require('node:assert');
const { searchRicambi, relevantToQuery } = require('../backend/ricambi-core');

// stub delle fonti (ognuna risolve al SUO envelope, come lookupOem / searchWebParts / subitoSource)
const okAutodoc = async (oen) => ({ oen, tipoPezzo: 'Bloccasterzo', categoria: 'GOLF 7', articoli: [{ fonte: 'autodoc', nome: 'Bloccasterzo RIDEX 1K0905851B', marca: 'RIDEX', prezzo: 30.99, url: 'https://www.auto-doc.it/ridex/1', articleId: 'A1', stelle: 8, recensioni: 5 }], count: 1 });
const okWeb = async (q) => ({ oen: q, pezzo: { tipo: 'ECU', veicoli: 'VW/Audi' }, articoli: [{ fonte: 'web', nome: 'w', url: 'https://x.it/p' }], count: 1 });
const okSubito = async (term) => ({ articoli: [{ fonte: 'subito', nome: 's', prezzo: 65, url: 'https://subito.it/x' }] });
const emptySubito = async () => ({ articoli: [] });
const emptyCmsnl = async (oen) => ({ oen, articoli: [], count: 0 });
const okCmsnl = async (oen) => ({ oen, tipoPezzo: 'Disco Freno Posteriore', articoli: [{ fonte: 'cmsnl', nome: 'Disco Freno Posteriore', marca: 'BMW', prezzo: 156.77 }], count: 1 });
const emptyEbay = async () => ({ articoli: [] });
const okEbay = async (q) => ({ articoli: [{ fonte: 'ebay', nome: `Disco freno BMW ${q}`, prezzo: 50, valuta: 'EUR', immagine: 'https://i.ebayimg.com/x/s-l500.webp', url: 'https://www.ebay.it/itm/1' }] });
const noSpecs = async () => ({ specs: {}, immagine: null });

// helper: stub-set completo per mode oem (i test NON devono mai toccare le fonti reali)
const stubs = (over = {}) => ({ autodoc: okAutodoc, cmsnl: emptyCmsnl, web: okWeb, subito: okSubito, ebay: emptyEbay, ebaySpecs: noSpecs, ...over });

test('OEM auto: scheda da Autodoc, lista SOLO annunci Subito, web/cmsnl mai', async () => {
  let webCalled = false, cmsnlCalled = false;
  const spyWeb = async (...a) => { webCalled = true; return okWeb(...a); };
  const spyCmsnl = async () => { cmsnlCalled = true; return { articoli: [] }; };
  const r = await searchRicambi('1K0905851B', stubs({ web: spyWeb, cmsnl: spyCmsnl }));
  // envelope v2: i cataloghi NON sono annunci → scheda; articoli = solo offerte mercato
  assert.deepStrictEqual(r.articoli.map(a => a.fonte), ['subito']);
  assert.strictEqual(r.count, 1);
  assert.ok(r.scheda, 'scheda presente');
  assert.ok(r.scheda.catalogo, 'catalogo v7 presente');
  assert.strictEqual(r.scheda.tipoPezzo, 'Bloccasterzo');
  assert.strictEqual(r.scheda.catalogo.multiTipo, false);
  const v = r.scheda.catalogo.tipi[0].articoli[0];
  assert.strictEqual(v.fonte, 'autodoc');
  assert.strictEqual(v.prezzo, 30.99);
  assert.strictEqual(r.scheda.catalogo.defaultArticleId, 'A1');
  assert.strictEqual(webCalled, false);                   // scheda+annunci presenti → web saltata
  assert.strictEqual(cmsnlCalled, false);                 // veicolo auto → mai CMSNL
  assert.strictEqual(r.sources.autodoc.status, 'ok');     // catalogo resta nel breakdown
  assert.strictEqual(r.veicolo, 'auto');
});

test('scheda AUTO: catalogo multi-tipo — raggruppa per tipo, dominante primo, NO auto-pick', async () => {
  const multi = async (oen) => ({ oen, articoli: [
    { fonte: 'autodoc', nome: 'Bloccasterzo TOPRAN 1K0905851B', marca: 'TOPRAN', prezzo: 36.99, articleId: 'B1', recensioni: 2 },
    { fonte: 'autodoc', nome: 'Bloccasterzo AIC 1K0905851B', marca: 'AIC', prezzo: 35.99, articleId: 'B2', recensioni: 0 },
    { fonte: 'autodoc', nome: 'Blocchetto accensione RIDEX 1K0905851B', marca: 'RIDEX', prezzo: 8.29, articleId: 'C1', recensioni: 1 },
  ], count: 3 });
  const r = await searchRicambi('1K0905851B', stubs({ autodoc: multi }));
  const cat = r.scheda.catalogo;
  assert.strictEqual(cat.multiTipo, true);
  assert.strictEqual(cat.tipi[0].tipo, 'Bloccasterzo');            // dominante = più varianti (2)
  assert.strictEqual(cat.tipi[0].articoli.length, 2);
  assert.strictEqual(cat.tipi[1].tipo, 'Blocchetto accensione');
  assert.strictEqual(cat.defaultArticleId, null);                 // multi-tipo → nessun auto-pick (niente €8.29)
});

test('scheda AUTO: tipo singolo → default = variante PIÙ RECENSITA (non min-prezzo)', async () => {
  const single = async (oen) => ({ oen, articoli: [
    { fonte: 'autodoc', nome: 'Bloccasterzo TOPRAN 1K0', marca: 'TOPRAN', prezzo: 40, articleId: 'S1', recensioni: 1 },
    { fonte: 'autodoc', nome: 'Bloccasterzo VIKA 1K0', marca: 'VIKA', prezzo: 30, articleId: 'S2', recensioni: 9 },
    { fonte: 'autodoc', nome: 'Bloccasterzo AIC 1K0', marca: 'AIC', prezzo: 20, articleId: 'S3', recensioni: 0 },
  ], count: 3 });
  const r = await searchRicambi('1K0905851B', stubs({ autodoc: single }));
  assert.strictEqual(r.scheda.catalogo.multiTipo, false);
  assert.strictEqual(r.scheda.catalogo.defaultArticleId, 'S2');   // più recensita, non il min-prezzo S3 (€20)
});

test('scheda AUTO: casing marca/nome divergente → stesso tipo, niente gruppi fasulli', async () => {
  const mixed = async (oen) => ({ oen, articoli: [
    { fonte: 'autodoc', nome: 'Bloccasterzo TOPRAN 1K0', marca: 'TOPRAN', prezzo: 40, articleId: 'M1', recensioni: 1 },
    { fonte: 'autodoc', nome: 'BLOCCASTERZO Febi Bilstein 1K0', marca: 'FEBI BILSTEIN', prezzo: 30, articleId: 'M2', recensioni: 3 },
  ], count: 2 });
  const r = await searchRicambi('1K0905851B', stubs({ autodoc: mixed }));
  assert.strictEqual(r.scheda.catalogo.multiTipo, false);          // un solo tipo nonostante il casing
  assert.strictEqual(r.scheda.catalogo.tipi[0].articoli.length, 2);
  assert.strictEqual(r.scheda.catalogo.defaultArticleId, 'M2');    // più recensita
});

test('OEM moto: CMSNL+Subito, Autodoc mai; veicoli dai fits CMSNL', async () => {
  let autodocCalled = false;
  const spyA = async () => { autodocCalled = true; return { articoli: [] }; };
  const cmsnlFits = async (oen) => ({ oen, tipoPezzo: 'Disco Freno Posteriore', veicoli: 'R1250GS, R1250RT', articoli: [{ fonte: 'cmsnl', nome: 'Disco Freno Posteriore', prezzo: 156.77 }], count: 1 });
  const r = await searchRicambi('34218526568', { veicolo: 'moto', autodoc: spyA, cmsnl: cmsnlFits, web: okWeb, subito: okSubito, ebay: emptyEbay, ebaySpecs: noSpecs });
  assert.strictEqual(autodocCalled, false);
  assert.strictEqual(r.sources.autodoc, undefined);
  assert.strictEqual(r.sources.cmsnl.status, 'ok');
  assert.strictEqual(r.veicolo, 'moto');
  assert.strictEqual(r.tipoPezzo, 'Disco Freno Posteriore');
  assert.strictEqual(r.veicoli, 'R1250GS, R1250RT');      // fits CMSNL (web non ha girato)
});

test('mode nome: Autodoc e CMSNL SALTATI, solo Web + Subito (con filtro pertinenza)', async () => {
  let autodocCalled = false, cmsnlCalled = false;
  const spyAutodoc = async () => { autodocCalled = true; return { articoli: [] }; };
  const spyCmsnl = async () => { cmsnlCalled = true; return { articoli: [] }; };
  const subitoPertinente = async () => ({ articoli: [{ fonte: 'subito', nome: 'Pastiglie freni Golf 7', prezzo: 30, url: 'https://subito.it/x' }] });
  const r = await searchRicambi('pastiglie freni golf', { mode: 'nome', autodoc: spyAutodoc, cmsnl: spyCmsnl, web: okWeb, subito: subitoPertinente, ebay: emptyEbay, ebaySpecs: noSpecs });
  assert.strictEqual(autodocCalled, false);
  assert.strictEqual(cmsnlCalled, false);
  assert.strictEqual(r.sources.autodoc, undefined);       // non presente nell'envelope
  assert.strictEqual(r.sources.cmsnl, undefined);
  assert.strictEqual(r.sources.web, undefined);           // subito ha trovato → web saltata
  assert.strictEqual(r.sources.subito.status, 'ok');
  assert.strictEqual(r.count, 1);
});

test('never-reject: una fonte lancia → le altre sopravvivono; web resta fuori', async () => {
  const boom = async () => { throw new Error('kaboom'); };
  const r = await searchRicambi('X1', stubs({ autodoc: boom }));
  assert.strictEqual(r.sources.autodoc.status, 'error');
  assert.strictEqual(r.sources.subito.status, 'ok');
  assert.strictEqual(r.sources.web, undefined);           // subito ha item → niente fallback web
  assert.strictEqual(r.count, 1);                         // solo subito
});

test('fallback web: tutte le strutturate a 0 → web PARTE e identifica', async () => {
  const missAutodoc = async (oen) => ({ oen, articoli: [], count: 0 });
  let webCalled = false;
  const spyWeb = async (...a) => { webCalled = true; return okWeb(...a); };
  const r = await searchRicambi('06A906032HP', stubs({ autodoc: missAutodoc, subito: emptySubito, web: spyWeb }));
  assert.strictEqual(webCalled, true);                    // 0 strutturati → fallback
  assert.strictEqual(r.sources.autodoc.status, 'empty');
  assert.strictEqual(r.sources.web.status, 'ok');
  assert.strictEqual(r.tipoPezzo, 'ECU');
  assert.strictEqual(r.count, 1);
});

test('fonte blocked → status blocked, non abbatte le altre', async () => {
  const blocked = async () => ({ blocked: true, error: 'cloudflare', articoli: [], count: 0 });
  const r = await searchRicambi('Y2', stubs({ autodoc: blocked }));
  assert.strictEqual(r.sources.autodoc.status, 'blocked');
  assert.strictEqual(r.sources.subito.status, 'ok');      // subito ha item → web mai partita
  assert.strictEqual(r.sources.web, undefined);
});

test('oeAlternativi: passano da Autodoc all\'envelope; [] se assenti', async () => {
  const withOe = async (oen) => ({ oen, tipoPezzo: 'ECU', articoli: [{ fonte: 'autodoc', nome: 'a', prezzo: 10 }], count: 1, oeAlternativi: ['06A 906 032 HN', '06A 906 032 HP'] });
  const r = await searchRicambi('06A906032HP', stubs({ autodoc: withOe, subito: emptySubito }));
  assert.deepStrictEqual(r.oeAlternativi, ['06A 906 032 HN', '06A 906 032 HP']);
  const r2 = await searchRicambi('pastiglie', { mode: 'nome', web: okWeb, subito: emptySubito, ebay: emptyEbay, ebaySpecs: noSpecs });   // niente Autodoc
  assert.deepStrictEqual(r2.oeAlternativi, []);
});

test('query vuota → error, niente chiamate', async () => {
  let called = false;
  const spy = async () => { called = true; };
  const r = await searchRicambi('', { autodoc: spy, cmsnl: spy, web: spy, subito: spy, ebay: spy });
  assert.strictEqual(r.error, 'query vuota');
  assert.strictEqual(called, false);
});

test('mode prodotto: term NON normalizzato (punti/trattini intatti), solo Web + Subito', async () => {
  let autodocCalled = false, cmsnlCalled = false, webTerm = null, webMode = null;
  const spyA = async () => { autodocCalled = true; return { articoli: [] }; };
  const spyC = async () => { cmsnlCalled = true; return { articoli: [] }; };
  const spyWeb = async (term, o) => { webTerm = term; webMode = o.mode; return { oen: term, articoli: [], count: 0 }; };
  const r = await searchRicambi(' 09.A758.11 ', { mode: 'prodotto', autodoc: spyA, cmsnl: spyC, web: spyWeb, subito: emptySubito, ebay: emptyEbay, ebaySpecs: noSpecs });
  assert.strictEqual(autodocCalled, false);
  assert.strictEqual(cmsnlCalled, false);
  assert.strictEqual(webTerm, '09.A758.11');       // trim sì, normOen no
  assert.strictEqual(webMode, 'prodotto');
  assert.strictEqual(r.mode, 'prodotto');
});

test('veicolo moto + cmsnl ok + 0 annunci: scheda presente, lista vuota, web saltata', async () => {
  let webCalled = false;
  const spyWeb = async (...a) => { webCalled = true; return okWeb(...a); };
  const r = await searchRicambi('34218526568', { veicolo: 'moto', cmsnl: okCmsnl, web: spyWeb, subito: emptySubito, ebay: emptyEbay, ebaySpecs: noSpecs });
  assert.strictEqual(r.sources.cmsnl.status, 'ok');
  assert.strictEqual(webCalled, false);                   // scheda trovata → niente fallback web
  assert.ok(r.scheda);
  assert.ok(r.scheda.catalogo);
  assert.strictEqual(r.scheda.catalogo.tipi[0].articoli[0].fonte, 'cmsnl');
  assert.strictEqual(r.scheda.catalogo.multiTipo, false);
  assert.strictEqual(r.tipoPezzo, 'Disco Freno Posteriore');
  assert.deepStrictEqual(r.articoli, []);                 // catalogo ≠ annunci
  assert.strictEqual(r.count, 0);
});

test('relevantToQuery: tiene i pertinenti, scarta il rumore, stopword ignorate', () => {
  const items = [
    { nome: 'Faretto LED BMW R1250GS' },
    { nome: 'Barre portatutto Nordrive per auto' },
    { nome: 'Supporto navigatore Garmin' },
    { nome: 'Coppia faretti fendinebbia GS Adventure' },
  ];
  const out = relevantToQuery(items, 'faretto originale bmw gs');
  assert.deepStrictEqual(out.map(i => i.nome), ['Faretto LED BMW R1250GS', 'Coppia faretti fendinebbia GS Adventure']);
  assert.strictEqual(relevantToQuery(items, '').length, 4);   // query vuota → nessun filtro
});


// ─── v6: fonte eBay + scheda arricchita ────────────────────────────────────────
const { parsePrezzoEur, isPlaceholder } = require('../backend/ebay-scrape');

test('eBay: le offerte restano offerte, e la SCHEDA resta il catalogo', async () => {
  // La scheda di un ricambio e' la sua identita' di catalogo: dati tecnici e prezzo del
  // NUOVO. Prima si riempiva coi dati degli annunci — la foto da un'inserzione eBay o, se
  // mancava, dal PRIMO annuncio USATO di Subito, e i dati tecnici da quella stessa
  // inserzione. Un pezzo usato ammaccato poteva finire come immagine di catalogo del nuovo.
  let specsChiamate = false;
  const specs = async () => { specsChiamate = true; return { specs: { 'Marca': 'BMW' }, immagine: 'https://i.ebayimg.com/hi/s-l1600.webp' }; };
  const r = await searchRicambi('34218526568', { veicolo: 'moto', cmsnl: okCmsnl, subito: okSubito, ebay: okEbay, ebaySpecs: specs, web: okWeb });
  // Gli annunci ci sono, e restano dove devono: nella lista delle offerte.
  assert.deepStrictEqual(r.articoli.map(a => a.fonte), ['subito', 'ebay']);
  assert.strictEqual(r.sources.ebay.status, 'ok');
  // Ma NON entrano nella scheda, in nessuna forma.
  assert.strictEqual(r.scheda.fotoReale, undefined, 'la foto della scheda non puo\' venire da un annuncio');
  assert.strictEqual(r.scheda.datiTecniciEbay, undefined, 'i dati tecnici della scheda vengono dal catalogo');
  assert.strictEqual(r.scheda.galleria, undefined);
  // E nemmeno si va a chiederli: era una richiesta di rete per un dato che non si mostra piu'.
  assert.strictEqual(specsChiamate, false, 'niente richiesta eBay per riempire la scheda');
});

test('parsePrezzoEur: formati IT', () => {
  assert.strictEqual(parsePrezzoEur('EUR 50,00'), 50);
  assert.strictEqual(parsePrezzoEur('EUR 1.234,56'), 1234.56);
  assert.strictEqual(parsePrezzoEur('EUR 30,00 a EUR 45,00'), 30);
  assert.strictEqual(parsePrezzoEur(''), null);
  // Serve eBay.it: un importo in un'altra valuta e' anche formattato al contrario, e letto
  // all'italiana "US $1,234.56" diventava 1,23 — marcato euro. Meglio nessun prezzo.
  assert.strictEqual(parsePrezzoEur('US $1,234.56'), null);
  assert.strictEqual(parsePrezzoEur('$89.99'), null);
  assert.strictEqual(parsePrezzoEur('GBP 45.00'), null);
});

test('isPlaceholder: scarta gli slot pubblicitari della serp', () => {
  assert.strictEqual(isPlaceholder('Shop on eBay', 'https://ebay.com/itm/123456'), true);
  assert.strictEqual(isPlaceholder('Disco freno BMW', 'https://www.ebay.it/itm/146652568276'), false);
});

test('isJunkSpec: via spedizione/consegna/resi, restano i dati tecnici veri', () => {
  const { isJunkSpec } = require('../backend/ebay-scrape');
  assert.strictEqual(isJunkSpec('Spedizione:'), true);
  assert.strictEqual(isJunkSpec('Consegna:'), true);
  assert.strictEqual(isJunkSpec('Restituzioni:'), true);
  assert.strictEqual(isJunkSpec('Marca'), false);
  assert.strictEqual(isJunkSpec('Numero ricambio OEM'), false);
  assert.strictEqual(isJunkSpec('Condizione'), false);
});

test('normalizzaSpec: WHITELIST — solo chiavi mappate, ogni altra scartata (niente tedesco residuo)', () => {
  const { normalizzaSpec } = require('../backend/ebay-scrape');
  assert.strictEqual(normalizzaSpec('Hersteller:'), 'Marca');
  assert.strictEqual(normalizzaSpec('Herstellernummer'), 'Codice produttore');
  assert.strictEqual(normalizzaSpec('OE/OEM Referenznummer(n)'), 'Numero OEM');
  assert.strictEqual(normalizzaSpec('Manufacturer Part Number'), 'Codice produttore');
  assert.strictEqual(normalizzaSpec('EAN'), 'EAN');
  assert.strictEqual(normalizzaSpec('Einbauposition'), 'Posizione');
  assert.strictEqual(normalizzaSpec('Oberfläche'), 'Finitura');
  assert.strictEqual(normalizzaSpec('Größe'), 'Dimensioni');       // ora mappata
  assert.strictEqual(normalizzaSpec('Breite'), 'Larghezza');       // tedesco ASCII: ora mappato
  assert.strictEqual(normalizzaSpec('Diametro'), 'Diametro');      // italiana in whitelist
  assert.strictEqual(normalizzaSpec('Lieferumfang'), null);        // tedesco ASCII ignoto → drop (whitelist)
  assert.strictEqual(normalizzaSpec('Unit Type'), null);           // inglese ignota → drop
});

test('normalizzaVal: enum DE→IT token-wise, testo libero intatto', () => {
  const { normalizzaVal } = require('../backend/ebay-scrape');
  assert.strictEqual(normalizzaVal('Gebraucht'), 'Usato');
  assert.strictEqual(normalizzaVal('Vorne links'), 'Anteriore Sinistra');
  assert.strictEqual(normalizzaVal('Neu'), 'Nuovo');
  assert.strictEqual(normalizzaVal('Nero'), 'Nero');               // testo libero → intatto
  assert.strictEqual(normalizzaVal('12,5 mm'), '12,5 mm');         // numeri → intatti
});

test('ebayCardMeta: condizione + spedizione dagli span .su-styled-text della card serp', () => {
  const { ebayCardMeta } = require('../backend/ebay-scrape');
  const attrs = ['Disco freno posteriore BMW 34218526568', 'Di seconda mano |', 'Venditore professionale',
    'EUR 50,00', 'EUR 50,00', 'Compralo Subito', '+EUR 22,00 per la consegna'];
  assert.deepStrictEqual(ebayCardMeta(attrs), { condizione: 'Usato', spedizione: 'EUR 22,00 per la consegna' });
  assert.deepStrictEqual(ebayCardMeta(['Nuovo', 'Consegna gratis']), { condizione: 'Nuovo', spedizione: 'Consegna gratis' });
  assert.deepStrictEqual(ebayCardMeta([]), { condizione: null, spedizione: null });
});

test('parseEbaySeller: nome + feedback + tipo dal blocco venditore item', () => {
  const { parseEbaySeller } = require('../backend/ebay-scrape');
  const r = parseEbaySeller('rollerdunse-owschlag(9151)Venditore professionaleRegistrato come venditore professionale');
  assert.strictEqual(r.nome, 'rollerdunse-owschlag');
  assert.strictEqual(r.feedback, '9151');
  assert.strictEqual(r.tipo, 'Professionale');
  assert.deepStrictEqual(parseEbaySeller(''), {});
});

test('parseEbayQty: estrae disponibili/venduti (best-effort)', () => {
  const { parseEbayQty } = require('../backend/ebay-scrape');
  assert.strictEqual(parseEbayQty('5 disponibili - 1 venduto'), '5 disponibili · 1 venduti');
  assert.strictEqual(parseEbayQty('Più di 10 disponibili'), 'Più di 10 disponibili');
  assert.strictEqual(parseEbayQty(''), null);
  assert.strictEqual(parseEbayQty('spedizione gratis'), null);
});

test('buildEbayDetails: assembla venditore/spedizione/quantità/marca dai testi grezzi', () => {
  const { buildEbayDetails } = require('../backend/ebay-scrape');
  const d = buildEbayDetails({
    seller: 'rollerdunse-owschlag(9151)Venditore professionale',
    shipping: 'EUR 22,00 Standard International. Vedi i dettagli per la spedizione',
    qty: '5 disponibili - 1 venduto',
    marca: 'BMW',
  });
  assert.strictEqual(d.venditore, 'rollerdunse-owschlag (9151) · Professionale');
  assert.strictEqual(d.spedizione, 'EUR 22,00 Standard International');
  assert.strictEqual(d.marca, 'BMW');
  assert.strictEqual(d.quantita, '5 disponibili · 1 venduti');
  assert.deepStrictEqual(buildEbayDetails({}), {});
});

test('cleanEbayTitle: via il testo accessibilità dal titolo', () => {
  const { cleanEbayTitle } = require('../backend/ebay-scrape');
  assert.strictEqual(cleanEbayTitle('Disco freno BMW viene aperta una nuova finestra o scheda'), 'Disco freno BMW');
  assert.strictEqual(cleanEbayTitle('Si apre in una nuova finestra o scheda Pinza freno'), 'Pinza freno');
  assert.strictEqual(cleanEbayTitle('Filtro olio Opens in a new window or tab'), 'Filtro olio');
  assert.strictEqual(cleanEbayTitle('Titolo normale'), 'Titolo normale');
});
