'use strict';
/**
 * I FILTRI AVANZATI DELLE AUTO, e le tre trappole che li rendono pericolosi.
 *
 * Non si prova che "il filtro funziona": si prova che ogni fonte riceve il SUO dialetto.
 * Le tre unita' di misura non coincidono, e sbagliarne una non da' nessun errore — da'
 * risultati plausibili e sbagliati, che e' il modo peggiore di rompersi:
 *
 *   potenza   Subito CV, Autoscout kW. Misurato live: `power 74-81` torna auto da 101-105 CV.
 *   posti     Subito `ss/se` sono la CHIAVE del menu, non i posti: ss=4 → auto a CINQUE posti.
 *   Euro      Autoscout vuole un valore SINGOLO e cumulativo ("almeno"); Subito li vuole
 *             esatti, elencati con la virgola.
 *
 * E la regola che vale piu' di tutte: questi filtri stanno SOLO sulle auto. Le moto hanno
 * anche Moto.it, che non li onora — provato con un controllo che funziona (`price_t` muove
 * il totale, `cc_f` e `type` no) — e un filtro ignorato da una fonte su tre e' peggio di un
 * filtro che non c'e'.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-filtri-'));

const { test } = require('node:test');
const assert = require('node:assert');
const f = require('../backend/filtri-auto');

test('ogni fonte riceve il suo dialetto, non il nostro', () => {
  const scelta = { carrozzeria: 'suv', cambio: 'automatico', alimentazione: 'diesel' };
  const s = f.perSubito(scelta);
  const a = f.perAutoscout(scelta);

  assert.strictEqual(s.ct, '5', 'Subito vuole il codice carrozzeria');
  assert.strictEqual(s.gr, '2');
  assert.strictEqual(s.fl, '2');

  // Una voce nostra puo' valerne DUE loro: su Autoscout il fuoristrada e' separato dal SUV.
  assert.deepStrictEqual(a.bodyType, ['SUV', 'OffRoad'],
    'SUV/Fuoristrada da noi deve coprire SUV e OffRoad da loro, se no il fuoristrada sparisce');
  assert.deepStrictEqual(a.transmissionType, ['Automatic']);
  assert.deepStrictEqual(a.fuel, ['Diesel']);
});

test('una voce nostra puo\' coprire piu\' codici della fonte', () => {
  // "Ibrida" su Subito sono tre voci diverse (Ibrida, Mild Hybrid, Full Hybrid): vanno
  // elencate tutte, e la virgola le unisce in OR (verificato live: 444 + 359 = 803).
  const s = f.perSubito({ alimentazione: 'ibrida' });
  assert.strictEqual(s.fl.split(',').length, 3, `l'ibrida su Subito e' piu' di un codice: ${s.fl}`);
  const a = f.perAutoscout({ alimentazione: 'ibrida' });
  assert.ok(a.fuel.length >= 2, 'su Autoscout l\'ibrida benzina e l\'ibrida diesel sono due voci');
});

test('TRAPPOLA potenza: i CV diventano kW per Autoscout, restano CV per Subito', () => {
  const scelta = { cvMin: 100, cvMax: 150 };
  const s = f.perSubito(scelta);
  assert.strictEqual(s.hps, '100', 'Subito ragiona in CV: non si converte niente');
  assert.strictEqual(s.hpe, '150');

  const a = f.perAutoscout(scelta);
  assert.ok(a.power, 'Autoscout non ha ricevuto la potenza');
  assert.ok(a.power.to < 150 && a.power.from < 100,
    `passare i CV come kW darebbe auto molto piu' potenti: ${JSON.stringify(a.power)}`);
  // 100 CV = 73,5 kW, 150 CV = 110,3 kW. Verso l'esterno: un intervallo di CV non cade mai
  // esatto sui kW, e stringere taglierebbe proprio i confini che l'utente ha scritto.
  assert.strictEqual(a.power.from, Math.floor(100 / f.CV_PER_KW));
  assert.strictEqual(a.power.to, Math.ceil(150 / f.CV_PER_KW));
  assert.ok(a.power.from <= 74 && a.power.to >= 110, `intervallo kW fuori misura: ${JSON.stringify(a.power)}`);
});

test('TRAPPOLA posti: Subito vuole la chiave del menu, Autoscout il numero vero', () => {
  const s = f.perSubito({ posti: '5' });
  const a = f.perAutoscout({ posti: '5' });
  // Misurato live: ss=4&se=4 torna auto a CINQUE posti. Mandare 5 darebbe auto a sei.
  assert.strictEqual(s.ss, '4', `cinque posti su Subito e' la chiave 4, non 5 (ricevuto ${s.ss})`);
  assert.strictEqual(s.se, '4');
  assert.deepStrictEqual(a.numberOfSeats, { from: 5, to: 5 }, 'Autoscout invece vuole il numero vero');
});

test('TRAPPOLA classe ambientale: singolo e cumulativo su Autoscout, elenco esatto su Subito', () => {
  const s = f.perSubito({ classeAmbientale: 'euro6' });
  const a = f.perAutoscout({ classeAmbientale: 'euro6' });
  assert.strictEqual(typeof a.emissionClass, 'string',
    'la forma a lista da\' errore su Autoscout: deve essere un valore singolo');
  assert.strictEqual(a.emissionClass, 'Euro6');
  // Su Subito i valori sono esatti: "almeno Euro 6" si scrive elencando Euro 6 e i suoi figli.
  const codici = s.pl.split(',');
  assert.ok(codici.length >= 5,
    `"almeno Euro 6" su Subito deve elencare anche 6b/6d-TEMP/6d/6e, ricevuti: ${s.pl}`);
  assert.ok(!codici.includes('5') && !codici.includes('6'),
    `"almeno Euro 6" non deve contenere Euro 4 (5) ne' Euro 5 (6): ${s.pl}`);
});

test('un valore inventato viene scartato, non passato alla fonte', () => {
  // Le fonti reagiscono in modo diverso alla spazzatura — Subito risponde 400, Autoscout la
  // ignora — quindi un errore per fonte sarebbe peggio di un filtro non applicato.
  const letto = f.leggiDaQuery({ carrozzeria: 'astronave', cambio: 'automatico', cvMin: 'x', cvMax: '-3' });
  assert.deepStrictEqual(letto, { cambio: 'automatico' });
  assert.deepStrictEqual(f.perSubito(letto), { gr: '2' });
});

test('chi allarga invece di restringere lo dichiara', () => {
  // Il chilometro zero su Autoscout non esiste: li' e' "usato". Quella colonna torna piu'
  // larga di quanto e' stato chiesto, e chi guarda deve saperlo.
  const av = f.avvisi({ condizione: 'km0' });
  assert.strictEqual(av.length, 1, 'il km0 su Autoscout deve produrre un avviso');
  assert.strictEqual(av[0].fonte, 'autoscout');
  assert.deepStrictEqual(f.perAutoscout({ condizione: 'km0' }).usageState, ['Used']);
  // Le voci che non allargano non devono avvisare di niente.
  assert.deepStrictEqual(f.avvisi({ condizione: 'usato' }), []);
});

test('l\'impronta per la cache distingue scelte diverse', () => {
  // Ci sono DUE cache che la usano — le ricerche e il recupero Subito — e dimenticarne una
  // non si vede: la ricerca torna istantanea con i risultati di prima. E' successo a
  // entrambe appena aggiunti questi filtri.
  const a = f.chiaveCache({ carrozzeria: 'suv', cambio: 'automatico' });
  const b = f.chiaveCache({ carrozzeria: 'berlina', cambio: 'automatico' });
  assert.notStrictEqual(a, b, 'due carrozzerie diverse devono dare chiavi diverse');
  assert.strictEqual(a, f.chiaveCache({ cambio: 'automatico', carrozzeria: 'suv' }),
    'l\'ordine in cui arrivano non deve cambiare la chiave');
  assert.strictEqual(f.chiaveCache({}), '');
  assert.strictEqual(f.chiaveCache(null), '');
});

test('le due cache CONTENGONO davvero l\'impronta dei filtri', () => {
  // Prova sul sorgente: il difetto non era nella funzione, era nel non chiamarla.
  const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  const subito = fs.readFileSync(path.join(__dirname, '..', 'backend', 'scrapers', 'subito-api.js'), 'utf8');
  const chiaveRicerca = server.slice(server.indexOf('function searchCacheKey'), server.indexOf('function cacheable'));
  assert.ok(chiaveRicerca.length > 100, 'searchCacheKey non si trova piu\': aggiorna questo test');
  assert.ok(/chiaveCache\(/.test(chiaveRicerca),
    'la chiave della cache ricerche non include i filtri: due ricerche con filtri diversi si riuserebbero');
  const chiaveRecupero = subito.slice(subito.indexOf('async function paginaRecupero'), subito.indexOf('const hit = recuperoCache.get'));
  assert.ok(/chiaveCache\(/.test(chiaveRecupero),
    'la chiave del recupero Subito non include i filtri: la fonte dichiarava 2 annunci e ne consegnava 13');
});

test('i filtri stanno solo sulle auto', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
  assert.ok(/tipo\.trim\(\)\s*===\s*'auto'\s*\?\s*filtriAuto\.leggiDaQuery/.test(server),
    'parseSearchParams deve leggere i filtri avanzati solo per le auto');
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
  assert.ok(/id="filtriAutoGrid"[^>]*data-solo="auto"/.test(html),
    'la griglia dei filtri deve dichiararsi solo-auto');
  const app = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app.js'), 'utf8');
  assert.ok(/if \(tipo === 'auto'\) Object\.assign\(params, filtriAutoScelti\(\)\)/.test(app),
    'il browser non deve mandare questi filtri sulle moto');
});

test('le voci per il menu non portano i codici delle fonti', () => {
  // Il menu deve poter cambiare senza toccare la traduzione, e viceversa.
  for (const nome of f.NOMI) {
    for (const v of f.voci(nome)) {
      assert.deepStrictEqual(Object.keys(v).sort(), ['allargaSu', 'etichetta', 'id'],
        `la voce ${nome}/${v.id} espone piu' di quanto serve a un menu`);
    }
  }
  assert.ok(f.NOMI.includes('carrozzeria') && f.NOMI.includes('cambio'),
    'carrozzeria e cambio sono i due filtri chiesti: devono esserci');
});
