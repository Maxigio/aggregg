'use strict';
/**
 * IL MAGAZZINO DELLE PERSONE, provato sui modi in cui si rompe.
 *
 * Le prove non guardano "il database si apre" — quello lo si vede a occhio. Guardano i quattro
 * modi in cui un magazzino tace invece di dire che e' rotto:
 *
 *   1. il POSTO non c'e' (volume smontato) e si crea un database nuovo e vuoto altrove:
 *      nessuna richiesta, nessun invito, nessun tetto, e nessun messaggio;
 *   2. il file c'e' ma non e' il nostro, e le tabelle si creano sopra a qualcos'altro;
 *   3. le migrazioni si riapplicano a ogni avvio;
 *   4. lo stesso nome ottiene due richieste vive, quindi due inviti, quindi il secondo si
 *      prende l'account del primo.
 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const dbmod = require('../backend/utenti-db');

/** Ogni prova nella sua cartella: il magazzino vero di questa macchina non si tocca mai. */
function inUnPostoNuovo(fn) {
  const vecchio = process.env.USER_DATA_PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-db-'));
  process.env.USER_DATA_PATH = dir;
  dbmod.chiudi();
  try { return fn(dir); }
  finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const TABELLE = ['meta', 'richieste', 'inviti', 'ricerche', 'salvataggi', 'preferenze', 'parco', 'uso'];

test('magazzino: nasce da zero con tutte le tabelle e il timbro d\'identita\'', () => {
  inUnPostoNuovo(dir => {
    assert.strictEqual(dbmod.stato(), 'ok');
    assert.ok(fs.existsSync(path.join(dir, 'amr-utenti.db')), 'il file deve nascere dentro USER_DATA_PATH');

    const db = dbmod.richiedi();
    const trovate = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    for (const t of TABELLE) assert.ok(trovate.includes(t), `manca la tabella ${t}`);

    // Il timbro: un file che esiste ma non ce l'ha non e' "vuoto", e' un altro file.
    const m = db.prepare("SELECT valore FROM meta WHERE chiave='creato_il'").get();
    assert.ok(m && Number(m.valore) > 0, 'senza creato_il non si distingue un database nostro da uno qualunque');
    assert.strictEqual(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal',
      'senza WAL un secondo processo che scrive fa fallire questo, e in questo repo il secondo processo esiste');
  });
});

test('magazzino: riaprirlo non riapplica le migrazioni', () => {
  inUnPostoNuovo(() => {
    dbmod.richiedi();
    const prima = dbmod.richiedi().prepare('SELECT n, applicata_il FROM _migrazioni ORDER BY n').all();
    dbmod.chiudi();
    dbmod.richiedi();
    const dopo = dbmod.richiedi().prepare('SELECT n, applicata_il FROM _migrazioni ORDER BY n').all();
    assert.deepStrictEqual(dopo, prima, 'le migrazioni si sono riapplicate: il timbro sarebbe cambiato');
    assert.strictEqual(dopo.length, dbmod.MIGRAZIONI.length);
  });
});

test('magazzino: se il posto non c\'e\', si dice — non si crea un database vuoto altrove', () => {
  const vecchio = process.env.USER_DATA_PATH;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-db-sparito-'));
  try {
    process.env.USER_DATA_PATH = dir;
    dbmod.chiudi();
    assert.strictEqual(dbmod.stato(), 'ok');          // prima c'era
    dbmod.chiudi();
    fs.rmSync(dir, { recursive: true, force: true }); // …e adesso il volume si e' smontato

    assert.strictEqual(dbmod.stato(), 'assente',
      'un posto sparito non e\' un magazzino vuoto: rispondere "ok" vorrebbe dire zero richieste e tetti a zero');
    assert.strictEqual(dbmod.apri(), null);
    assert.throws(() => dbmod.richiedi(), e => e.code === 'DB_NON_PRONTO');
    assert.ok(!fs.existsSync(dir), 'nessun database deve essere stato ricreato al posto di quello sparito');
  } finally {
    dbmod.chiudi();
    if (vecchio == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = vecchio;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('magazzino: un file che non e\' un database si dichiara illeggibile, non si sovrascrive', () => {
  inUnPostoNuovo(dir => {
    const p = path.join(dir, 'amr-utenti.db');
    fs.writeFileSync(p, 'questo non e\' un database, e\' un file di testo qualunque');
    dbmod.chiudi();

    assert.strictEqual(dbmod.stato(), 'illeggibile');
    assert.throws(() => dbmod.richiedi(), e => e.code === 'DB_NON_PRONTO');
    assert.ok(dbmod.guasto(), 'il motivo del guasto deve restare leggibile, non sparire in un catch');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), 'questo non e\' un database, e\' un file di testo qualunque',
      'il file non nostro e\' stato riscritto: quello che c\'era dentro e\' perso');
  });
});

test('magazzino: una sola richiesta VIVA per persona', () => {
  inUnPostoNuovo(() => {
    const db = dbmod.richiedi();
    const ins = (persona, stato) => db.prepare(
      'INSERT INTO richieste (persona, nome, email, ip, creata_il, scade_il, stato) VALUES (?,?,?,?,?,?,?)'
    ).run(persona, 'Mario Rossi', 'm@r.it', '10.0.0.1', Date.now(), Date.now() + 1000, stato);

    ins('mario-rossi', 'attesa');
    // Approvata NON e' finita: se contasse come "libera", lo stesso nome otterrebbe un secondo
    // invito, e il secondo consumato mesi dopo si prenderebbe l'account del primo.
    assert.throws(() => ins('mario-rossi', 'approvata'), /UNIQUE|constraint/i);
    assert.throws(() => ins('mario-rossi', 'attesa'), /UNIQUE|constraint/i);

    // Rifiutata e usata invece sono chiuse: quel nome torna richiedibile.
    db.prepare("UPDATE richieste SET stato='rifiutata' WHERE persona='mario-rossi'").run();
    assert.doesNotThrow(() => ins('mario-rossi', 'attesa'));
    db.prepare("UPDATE richieste SET stato='usata' WHERE stato='attesa' AND persona='mario-rossi'").run();
    assert.doesNotThrow(() => ins('mario-rossi', 'attesa'));
  });
});

test('magazzino: due connessioni scrivono sullo stesso file senza buttarsi fuori', () => {
  inUnPostoNuovo(dir => {
    const db = dbmod.richiedi();
    // Il secondo processo non e' teorico: l'Electron che forka il server mentre il LaunchAgent
    // gira ha gia' lasciato orfani. Senza WAL questo sarebbe SQLITE_BUSY.
    const altro = new DatabaseSync(path.join(dir, 'amr-utenti.db'));
    try {
      altro.exec('PRAGMA busy_timeout = 3000');
      db.prepare('INSERT INTO preferenze (utente, chiave, valore) VALUES (?,?,?)').run('anna', 'tema', 'scuro');
      altro.prepare('INSERT INTO preferenze (utente, chiave, valore) VALUES (?,?,?)').run('bruno', 'tema', 'chiaro');
      const n = db.prepare('SELECT COUNT(*) AS n FROM preferenze').get().n;
      assert.strictEqual(Number(n), 2, 'una delle due scritture e\' andata persa');
    } finally { altro.close(); }
  });
});

test('magazzino: il giorno e\' quello dell\'orologio di casa, non un fuso', () => {
  const d = new Date(2026, 0, 5, 23, 30, 0);   // 5 gennaio 2026, sera
  assert.strictEqual(dbmod.giorno(d.getTime()), '2026-01-05');
  assert.match(dbmod.giorno(), /^\d{4}-\d{2}-\d{2}$/);
});
