'use strict';
/**
 * IL MAGAZZINO DEI LOTTI D'ASTA. Le prove che contano sono due, e sono le due che distinguono
 * l'area Aste da un elenco qualsiasi:
 *  - un lotto che ESCE dal portale si marca, non si cancella (decisione del proprietario);
 *  - un lotto la cui VENDITA E' PASSATA non e' un lotto sparito. Sono due cose diverse, e
 *    confonderle farebbe sembrare venduto tutto quello che invecchia.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('../backend/aste-db');

/** Ogni prova in una cartella sua: niente stato che passa da un test all'altro. */
function conCartella(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-aste-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  db._reset();
  const pulisci = () => {
    db._reset();
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
  };
  try { return fn(dir); }
  finally { pulisci(); }
}

const GIORNO = 24 * 60 * 60 * 1000;
const fraGiorni = n => new Date(Date.now() + n * GIORNO).toISOString().slice(0, 10);

const lotto = (id, extra = {}) => ({
  id, descrizione: `Motociclo di prova ${id}`, marca: 'Yamaha', cumulativo: false,
  piattaforma: null, prezzoBase: 1000, offertaMinima: 750, rialzoMinimo: 50,
  dataVendita: fraGiorni(30), orarioVendita: '10:00', dataPubblicazione: fraGiorni(-10),
  citta: 'Verona', provincia: 'Verona', tribunale: 'Tribunale di VERONA',
  numeroLotto: 'LOTTO UNICO', procedura: '3', ...extra,
});

test('un magazzino mai riempito e\' "assente", non "illeggibile"', () => conCartella(() => {
  assert.equal(db.stato(), 'assente');
  assert.equal(db.guasto(), null);
  // E leggere non lancia: torna vuoto, e chi chiama dichiara lo stato accanto al dato.
  assert.deepEqual(db.cerca(), []);
  assert.deepEqual(db.province(), []);
  assert.equal(db.ultimoGiro(), null);
}));

test('un lotto che esce dal portale si marca, non si cancella', () => conCartella(() => {
  const ieri = Date.now() - GIORNO;
  db.sostituisci('moto', [lotto(1), lotto(2)], ieri);
  assert.equal(db.cerca({ tipo: 'moto' }).length, 2);

  // Giro di oggi: il portale da' solo il lotto 1. Il 2 e' stato venduto o ritirato.
  const r = db.sostituisci('moto', [lotto(1)], Date.now());
  assert.equal(r.spariti, 1);
  assert.equal(r.nuovi, 0, 'un lotto gia\' conosciuto non e\' nuovo');

  // Esce dalla lista viva...
  assert.deepEqual(db.cerca({ tipo: 'moto' }).map(l => l.id), [1]);
  // ...ma la traccia resta, ed e' dichiarata.
  const sparito = db.unLotto(2);
  assert.ok(sparito, 'la riga non deve essere cancellata');
  assert.equal(sparito.sparito, true);
}));

test('il lotto sparito tiene la SUA data, anche se il giro si ripete', () => conCartella(() => {
  const t0 = Date.now() - 3 * GIORNO;
  db.sostituisci('moto', [lotto(1), lotto(2)], t0);
  const primo = db.sostituisci('moto', [lotto(1)], Date.now() - 2 * GIORNO);
  assert.equal(primo.spariti, 1);
  // Il giorno dopo il 2 continua a non esserci: non deve essere contato sparito una seconda
  // volta, se no «sparito da quando» diventerebbe sempre oggi.
  const secondo = db.sostituisci('moto', [lotto(1)], Date.now());
  assert.equal(secondo.spariti, 0);
}));

test('un lotto che torna sul portale smette di essere sparito', () => conCartella(() => {
  db.sostituisci('moto', [lotto(1)], Date.now() - GIORNO);
  db.sostituisci('moto', [], Date.now() - GIORNO / 2);
  assert.equal(db.unLotto(1).sparito, true);
  db.sostituisci('moto', [lotto(1)], Date.now());
  assert.equal(db.unLotto(1).sparito, false, 'ricomparso: la marcatura va tolta');
  assert.equal(db.cerca({ tipo: 'moto' }).length, 1);
}));

test('vendita passata NON vuol dire sparito', () => conCartella(() => {
  db.sostituisci('moto', [lotto(1, { dataVendita: fraGiorni(-1) }), lotto(2)], Date.now());
  // Fuori dalla lista viva perche' la data e' passata...
  assert.deepEqual(db.cerca({ tipo: 'moto' }).map(l => l.id), [2]);
  // ...ma NON marcato sparito: sul portale c'e' ancora.
  assert.equal(db.unLotto(1).sparito, false);
}));

test('i tipi non si pestano: un giro sulle moto non fa sparire le auto', () => conCartella(() => {
  db.sostituisci('auto', [lotto(10)], Date.now() - GIORNO);
  const r = db.sostituisci('moto', [lotto(20)], Date.now());
  assert.equal(r.spariti, 0, 'il giro moto non deve toccare le righe auto');
  assert.equal(db.unLotto(10).sparito, false);
  assert.equal(db.cerca({ limite: 100 }).length, 2);
}));

test('la stessa vendita puo\' essere auto E moto insieme, e non si ruba la riga', () => conCartella(() => {
  // Caso vero del PVP: «autovettura SMART FORTWO e motociclo APRILIA PEGASO», una sola vendita
  // che compare in tutt'e due le categorie. Con la chiave sul solo id, il giro delle moto
  // sovrascriveva la riga di quello delle auto: due righe perse e «2 nuovi» a ogni giro.
  const t = Date.now();
  db.sostituisci('auto', [lotto(4624408, { marca: 'Smart' })], t);
  const r = db.sostituisci('moto', [lotto(4624408, { marca: 'Aprilia' })], t);
  assert.equal(r.nuovi, 1);
  assert.equal(r.spariti, 0, 'il giro moto non deve far sparire la riga auto della stessa vendita');
  assert.equal(db.cerca({ tipo: 'auto' }).length, 1);
  assert.equal(db.cerca({ tipo: 'moto' }).length, 1);
  assert.equal(db.unLotto(4624408, 'auto').marca, 'Smart');
  assert.equal(db.unLotto(4624408, 'moto').marca, 'Aprilia');
  // E un secondo giro identico non deve trovare "nuovi": era il sintomo del difetto.
  assert.equal(db.sostituisci('auto', [lotto(4624408, { marca: 'Smart' })], t + 1000).nuovi, 0);
}));

test('i filtri della ricerca locale', () => conCartella(() => {
  db.sostituisci('moto', [
    lotto(1, { marca: 'Voge', prezzoBase: 800, provincia: 'Verona' }),
    lotto(2, { marca: 'Yamaha', prezzoBase: 5000, provincia: 'Milano' }),
    lotto(3, { marca: null, prezzoBase: 300, cumulativo: true, descrizione: 'N. 12 scooter incidentati' }),
  ], Date.now());
  assert.deepEqual(db.cerca({ marca: 'Voge' }).map(l => l.id), [1]);
  assert.deepEqual(db.cerca({ provincia: 'Milano' }).map(l => l.id), [2]);
  assert.deepEqual(db.cerca({ prezzoMax: 1000 }).map(l => l.id).sort(), [1, 3]);
  assert.deepEqual(db.cerca({ soloSingoli: true }).map(l => l.id).sort(), [1, 2]);
  assert.deepEqual(db.cerca({ testo: 'incidentati' }).map(l => l.id), [3]);
  // La marca non riconosciuta resta null e si conta: non diventa una marca finta.
  const perMarca = db.perMarca('moto');
  assert.ok(perMarca.some(x => x.marca === null && x.quanti === 1));
}));

test('un giro riuscito toglie lo "stantio"', () => conCartella(() => {
  assert.equal(db.stantio(), true, 'senza nessun giro, ne serve uno');
  const g = db.iniziaGiro();
  db.chiudiGiro(g, { esito: 'ok', visti: 1, nuovi: 1, spariti: 0 });
  assert.equal(db.stantio(), false);
  // Ma un giro di ieri e' di nuovo stantio: si guarda l'ETA', non l'orologio.
  assert.equal(db.stantio(Date.now() + 25 * 60 * 60 * 1000), true);
}));

test('un giro FALLITO non conta come riuscito', () => conCartella(() => {
  const g = db.iniziaGiro();
  db.chiudiGiro(g, { esito: 'ko', motivo: 'PVP non raggiungibile' });
  assert.equal(db.ultimoGiro(), null, 'solo i giri ok valgono');
  assert.equal(db.stantio(), true, 'un giro fallito non rimanda il prossimo');
}));

test('le righe sparite da oltre un mese si potano', () => conCartella(() => {
  const vecchio = Date.now() - 40 * GIORNO;
  db.sostituisci('moto', [lotto(1), lotto(2)], vecchio);
  db.sostituisci('moto', [lotto(1)], vecchio + 60 * 1000);   // il 2 sparisce, 40 giorni fa
  assert.ok(db.unLotto(2));
  assert.equal(db.potaSpariti(), 1);
  assert.equal(db.unLotto(2), null);
  assert.ok(db.unLotto(1), 'chi non e\' sparito resta');
}));

test('nel magazzino non entrano dati personali', () => conCartella(() => {
  // Il dettaglio del PVP contiene nome, cellulare, email e codice fiscale del referente.
  // Nessuna colonna deve poterli ospitare: se qualcuno ne aggiunge una, questa prova cade.
  const ammesse = new Set(db._const.COLONNE.concat(['sparito_il']));
  db.sostituisci('moto', [lotto(1)], Date.now());
  const colonne = db.apri().prepare('PRAGMA table_info(lotti)').all().map(r => r.name);
  for (const c of colonne) {
    assert.ok(ammesse.has(c), `colonna non prevista in lotti: ${c}`);
    assert.ok(!/nome|cognome|cellulare|telefono|email|^cf$|codice_fiscale|soggett/i.test(c),
      `la colonna ${c} sembra un dato personale`);
  }
}));
