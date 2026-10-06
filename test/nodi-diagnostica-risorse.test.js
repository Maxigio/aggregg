'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { misuraRegistro } = require('../backend/nodi/diagnostica-risorse');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-risorse-test-'));
  const file = path.join(directory, 'lavori-prototipo.db'), db = new DatabaseSync(file);
  db.exec('CREATE TABLE prova (id INTEGER PRIMARY KEY, dati BLOB)');
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, file, db, ora: () => 1800000000000 };
}

test('risorse: distingue file allocato e pagine riutilizzabili senza compattare o scrivere', t => {
  const f = fixture(t);
  const inserisci = f.db.prepare('INSERT INTO prova(dati) VALUES(zeroblob(4096))');
  for (let n = 0; n < 32; n++) inserisci.run();
  const pieno = misuraRegistro(f);
  f.db.exec('DELETE FROM prova');
  const prima = crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
  const vuoto = misuraRegistro(f);
  const dopo = crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex');
  assert.equal(prima, dopo);
  assert.equal(vuoto.stato, 'ok');
  assert.equal(vuoto.file.database.byte, pieno.file.database.byte);
  assert.equal(vuoto.sqlite.pagineLibere > pieno.sqlite.pagineLibere, true);
  assert.equal(vuoto.sqlite.byteRiutilizzabili > 0, true);
  assert.equal(vuoto.sqlite.journal, 'delete');
  assert.equal(vuoto.istante, 1800000000000);
  assert.deepEqual(vuoto.file.wal, { presente: false, byte: 0 });
  assert.deepEqual(vuoto.file.shm, { presente: false, byte: 0 });
  assert.equal(vuoto.filesystem.byteDisponibili > 0, true);
  assert.equal(JSON.stringify(vuoto).includes(f.directory), false);
});

test('risorse: DB illeggibile restituisce campione parziale senza perdere misure filesystem', t => {
  const f = fixture(t), db = { prepare: () => { throw new Error('messaggio privato sintetico'); } };
  const risultato = misuraRegistro({ ...f, db });
  assert.equal(risultato.stato, 'parziale');
  assert.equal(risultato.sqlite, null);
  assert.equal(risultato.file.database.presente, true);
  assert.equal(risultato.filesystem.byteTotali > 0, true);
  assert.equal(JSON.stringify(risultato).includes('privato'), false);
});

test('risorse: non segue link nei file ausiliari né inventa zero per misure fallite', t => {
  const f = fixture(t), target = path.join(f.directory, 'contenuto-sintetico');
  fs.writeFileSync(target, 'file da non leggere');
  fs.symlinkSync(target, f.file + '-wal');
  t.mock.method(fs, 'statfsSync', () => { throw new Error('stat non disponibile'); });
  let letture = 0;
  const risultato = misuraRegistro({ ...f, db: { prepare: () => { letture++; throw new Error('non deve leggere'); } } });
  assert.equal(risultato.stato, 'parziale');
  assert.deepEqual(risultato.file.wal, { presente: null, byte: null });
  assert.equal(risultato.filesystem, null);
  assert.equal(risultato.sqlite, null);
  assert.equal(letture, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'file da non leggere');
});

test('risorse: valori fuori precisione non diventano una capacità numerica attendibile', t => {
  const f = fixture(t);
  t.mock.method(fs, 'statfsSync', () => ({ bavail: Number.MAX_SAFE_INTEGER, blocks: Number.MAX_SAFE_INTEGER, bsize: 4096 }));
  const risultato = misuraRegistro(f);
  assert.equal(risultato.stato, 'parziale');
  assert.deepEqual(risultato.filesystem, { byteDisponibili: null, byteTotali: null });
});
