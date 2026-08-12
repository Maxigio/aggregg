'use strict';
/**
 * QUELLO CHE E' MIO NON E' TUO.
 *
 * Il cancello non puo' fare questo lavoro: da li' non si vede di chi e' una riga. Lo fa il
 * magazzino, e queste prove guardano proprio il confine — non "il salvataggio funziona", ma
 * "quello dell'altro non lo tocco, non lo leggo, e non scopro nemmeno che esiste".
 *
 * L'ultima parte e' meno ovvia delle prime due: se cancellare la ricerca di un altro rispondesse
 * "non e' tua" invece di "non c'e'", quel "no" diverso direbbe che esiste.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');

process.env.AMR_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-log-persone-'));
process.env.USER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-persone-'));

const dbmod = require('../backend/utenti-db');
const saved = require('../backend/saved');
const miei = require('../backend/dati-utente');
const comp = require('../backend/competitor');

const R = (url, prezzo) => ({ url, prezzo, anno: 2018, km: 80000, titolo: 'BMW 320d' });

function daCapo() {
  dbmod.chiudi();
  const p = dbmod.percorso();
  for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* non c'era */ } }
}

test('ricerche salvate: due persone, due elenchi', () => {
  daCapo();
  const a = saved.addSaved('anna', { label: 'Golf di Anna', params: { tipo: 'auto', marca: 'Volkswagen' } });
  const b = saved.addSaved('bruno', { label: 'Panda di Bruno', params: { tipo: 'auto', marca: 'Fiat' } });

  assert.deepStrictEqual(saved.listSaved('anna').map(s => s.label), ['Golf di Anna']);
  assert.deepStrictEqual(saved.listSaved('bruno').map(s => s.label), ['Panda di Bruno']);
  assert.deepStrictEqual(saved.listSaved('carlo'), [], 'chi non ha salvato niente non vede niente');

  // Leggere la ricerca di un altro conoscendone l'id: non si puo'.
  assert.strictEqual(saved.getSaved('anna', b.id), null, 'Anna non deve poter leggere la ricerca di Bruno');
  assert.ok(saved.getSaved('bruno', b.id), 'ma Bruno la sua si\'');
});

test('ricerche salvate: cancellare quella di un altro risponde "non c\'e\'", non "non e\' tua"', () => {
  daCapo();
  saved.addSaved('anna', { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
  const b = saved.addSaved('bruno', { label: 'Panda', params: { tipo: 'auto', marca: 'Fiat' } });

  assert.strictEqual(saved.removeSaved('anna', b.id), false, 'la ricerca di Bruno non e\' cancellabile da Anna');
  assert.strictEqual(saved.removeSaved('anna', 'id-inventato'), false);
  // Le due risposte sono identiche di proposito: un "no" diverso direbbe che quella ricerca
  // esiste, e chi la sta cercando lo scoprirebbe provando.
  assert.strictEqual(saved.listSaved('bruno').length, 1, 'e infatti e\' ancora li\'');

  assert.strictEqual(saved.markRead('anna', b.id), false, 'nemmeno segnarla letta');
  assert.strictEqual(saved.recordCheck('anna', b.id, [R('x', 10000)]).length, 0,
    'e nemmeno scriverci dentro lo storico');
  assert.ok(saved.getSaved('bruno', b.id).seen === undefined || !Object.keys(saved.getSaved('bruno', b.id).seen).length,
    'lo storico di Bruno non deve essersi mosso');
});

test('ricerche salvate: gli avvisi di uno non entrano nella coda dell\'altro', () => {
  daCapo();
  const a = saved.addSaved('anna', { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });
  const b = saved.addSaved('bruno', { label: 'Golf', params: { tipo: 'auto', marca: 'Volkswagen' } });

  const base = [R('a', 10000), R('b', 9000), R('c', 9500)];
  saved.recordCheck('anna', a.id, base);              // baseline silenziosa
  saved.recordCheck('bruno', b.id, base);
  const nuoviAnna = saved.recordCheck('anna', a.id, [...base, R('d', 8800)]);

  assert.deepStrictEqual(nuoviAnna.map(x => x.motivo), ['nuovo']);
  assert.strictEqual(saved.listSaved('anna')[0].novita, 1);
  assert.strictEqual(saved.listSaved('bruno')[0].novita, 0,
    'Bruno non ha controllato niente: la sua coda deve essere ferma');

  // E segnare letto e' un gesto suo: non tocca la coda dell'altro.
  saved.recordCheck('bruno', b.id, [...base, R('d', 8800)]);
  assert.strictEqual(saved.listSaved('bruno')[0].novita, 1);
  saved.markRead('anna', a.id);
  assert.strictEqual(saved.listSaved('anna')[0].novita, 0);
  assert.strictEqual(saved.listSaved('bruno')[0].novita, 1, 'la coda di Bruno e\' rimasta come stava');
});

test('ricerche salvate: senza un padrone non si scrive niente', () => {
  daCapo();
  // Una chiamata che dimentica CHI non deve finire in un mucchio comune chiamato "undefined":
  // sarebbe il mucchio unico di prima, con un altro nome e senza che nessuno se ne accorga.
  for (const vuoto of [undefined, null, '', '   ']) {
    assert.throws(() => saved.listSaved(vuoto), /manca l'utente/);
    assert.throws(() => saved.addSaved(vuoto, { params: { tipo: 'auto', marca: 'BMW' } }), /manca l'utente/);
  }
});

test('archivio di prima: entra una volta sola e a nome del proprietario', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-archivio-'));
  const vecchio = process.env.USER_DATA_PATH;
  try {
    process.env.USER_DATA_PATH = dir;
    dbmod.chiudi();
    const file = path.join(dir, 'saved-searches.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'vecchia1', label: 'Golf di prima', params: { tipo: 'auto', marca: 'Volkswagen' }, alerts: [], seen: {} },
      { id: 'vecchia2', label: 'Panda di prima', params: { tipo: 'auto', marca: 'Fiat' }, alerts: [], seen: {} },
    ], null, 2));
    const prima = fs.readFileSync(file);

    delete require.cache[require.resolve('../backend/saved')];
    const s2 = require('../backend/saved');

    assert.deepStrictEqual(s2.listSaved('owner').map(x => x.label), ['Golf di prima', 'Panda di prima']);
    assert.deepStrictEqual(s2.listSaved('anna'), [], 'l\'archivio e\' del proprietario, non di tutti');
    assert.strictEqual(Buffer.compare(prima, fs.readFileSync(file)), 0,
      'il file di prima resta intatto: e\' l\'unica copia e non si cancella per una migrazione');

    // Seconda apertura: non si importa una seconda volta sopra a quello che c'e' gia'.
    s2.removeSaved('owner', 'vecchia1');
    dbmod.chiudi();
    delete require.cache[require.resolve('../backend/saved')];
    const s3 = require('../backend/saved');
    assert.deepStrictEqual(s3.listSaved('owner').map(x => x.label), ['Panda di prima'],
      'la ricerca cancellata e\' tornata: l\'archivio si e\' reimportato sopra');
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    delete require.cache[require.resolve('../backend/saved')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Annunci, ricambi, codici preferiti, impostazioni di prezzo ────────────────

test('le mie cose: tre elenchi, e quelli di un altro non si vedono', () => {
  daCapo();
  miei.scriviElenco('anna', 'annuncio', [{ url: 'a1', titolo: 'Golf' }]);
  miei.scriviElenco('anna', 'oem', [{ q: '1K0615301AA', mode: 'oem' }]);
  miei.scriviElenco('bruno', 'annuncio', [{ url: 'b1', titolo: 'Panda' }, { url: 'b2' }]);

  assert.deepStrictEqual(miei.leggiElenco('anna', 'annuncio').map(x => x.url), ['a1']);
  assert.deepStrictEqual(miei.leggiElenco('bruno', 'annuncio').map(x => x.url), ['b1', 'b2']);
  assert.deepStrictEqual(miei.leggiElenco('bruno', 'oem'), [], 'i preferiti di Anna non sono di Bruno');
  assert.deepStrictEqual(miei.leggiElenco('carlo', 'ricambio'), []);

  // L'ORDINE conta: i codici preferiti si mettono in cima, e un elenco che torna rimescolato
  // e' un elenco diverso da quello che si era lasciato.
  miei.scriviElenco('anna', 'oem', [{ q: 'B' }, { q: 'A' }, { q: 'C' }]);
  assert.deepStrictEqual(miei.leggiElenco('anna', 'oem').map(x => x.q), ['B', 'A', 'C']);
});

test('le mie cose: il tetto e\' quello dello schermo, non uno piu\' largo', () => {
  daCapo();
  // Se qui ne stessero 1000 e nello schermo 200, la differenza si scoprirebbe il giorno che
  // qualcuno perde qualcosa senza capire perche'.
  const tanti = Array.from({ length: miei.GENERI.oem.cap + 10 }, (_, i) => ({ q: 'C' + i }));
  const tenuti = miei.scriviElenco('anna', 'oem', tanti);
  assert.strictEqual(tenuti, miei.GENERI.oem.cap);
  assert.strictEqual(miei.leggiElenco('anna', 'oem').length, miei.GENERI.oem.cap);
  assert.strictEqual(miei.leggiElenco('anna', 'oem')[0].q, 'C0', 'si taglia dal fondo, non dall\'inizio');
});

test('le mie cose: preferenze per persona, e solo quelle dichiarate', () => {
  daCapo();
  miei.scriviPreferenza('anna', 'amr_price_v', '{"comm":500}');
  miei.scriviPreferenza('bruno', 'amr_price_v', '{"comm":900}');

  assert.deepStrictEqual(miei.leggiPreferenze('anna'), { amr_price_v: '{"comm":500}' });
  assert.deepStrictEqual(miei.leggiPreferenze('bruno'), { amr_price_v: '{"comm":900}' },
    'due persone, due preventivi: sono le cifre che finiscono sul PDF del cliente');

  // Una chiave qualunque non entra: il magazzino non e' un deposito per quello che passa.
  assert.throws(() => miei.scriviPreferenza('anna', 'qualunque', 'x'), e => e.code === 'PREFERENZA_SCONOSCIUTA');
  assert.throws(() => miei.scriviPreferenza('anna', 'amr_price_v', 'x'.repeat(5000)), e => e.code === 'TROPPO_GRANDE');
  assert.throws(() => miei.scriviElenco('anna', 'inventato', []), /genere sconosciuto/);
  for (const vuoto of [undefined, null, '']) {
    assert.throws(() => miei.scriviElenco(vuoto, 'oem', []), /manca l'utente/);
  }
});

test('le mie cose: magazzino guasto = elenco vuoto DICHIARATO, e nessuna scrittura', () => {
  const vecchio = process.env.USER_DATA_PATH;
  try {
    dbmod.chiudi();
    process.env.USER_DATA_PATH = path.join(os.tmpdir(), `amr-miei-sparito-${process.pid}`);
    const t = miei.tutto('anna');
    assert.deepStrictEqual(t.salvataggi.annuncio, []);
    assert.ok(t.guasto, 'un elenco vuoto per guasto NON e\' "non hai niente salvato", e va detto');
    assert.throws(() => miei.scriviElenco('anna', 'oem', [{ q: 'X' }]), e => e.code === 'DATI_NON_DISPONIBILI');
    assert.throws(() => miei.scriviPreferenza('anna', 'amr_price_v', '{}'), e => e.code === 'DATI_NON_DISPONIBILI');
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
  }
});

test('parco concorrenti: uno per persona, e i gruppi non si sovrascrivono', () => {
  daCapo();
  comp.scrivi('anna', [{ fonte: 'subito', id: '1', nome: 'Vetrina di Anna', gruppo: 'g1' }]);
  comp.scrivi('bruno', [{ fonte: 'subito', id: '9', nome: 'Vetrina di Bruno', gruppo: 'altro' }]);

  assert.deepStrictEqual(comp.leggi('anna').map(v => v.nome), ['Vetrina di Anna']);
  assert.deepStrictEqual(comp.leggi('bruno').map(v => v.nome), ['Vetrina di Bruno']);
  assert.deepStrictEqual(comp.leggi('carlo'), []);

  // Prima era un file solo per macchina: riassegnare un gruppo riscriveva l'elenco di tutti.
  comp.scrivi('anna', comp.leggi('anna').map(v => ({ ...v, gruppo: 'nuovo' })));
  assert.strictEqual(comp.leggi('anna')[0].gruppo, 'nuovo');
  assert.strictEqual(comp.leggi('bruno')[0].gruppo, 'altro', 'il gruppo di Bruno non si e\' mosso');
  assert.throws(() => comp.scrivi('', []), /manca l'utente/);
});
