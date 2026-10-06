'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Snapshot in sola lettura dello store del centro. File, pagine SQLite e
// spazio del filesystem sono misure diverse; nessuna soglia o compattazione.
function misuraRegistro({ db, directory, ora = Date.now }) {
  const out = { istante: ora(), stato: 'ok', file: {}, sqlite: null, filesystem: null };
  const numero = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  let sqliteMisurabile = true;
  for (const [nome, suffix] of [['database', ''], ['wal', '-wal'], ['shm', '-shm'], ['journal', '-journal']]) {
    try {
      const stat = fs.lstatSync(path.join(directory, 'lavori-prototipo.db' + suffix));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      out.file[nome] = { presente: true, byte: numero(stat.size) };
      if (out.file[nome].byte === null) out.stato = 'parziale';
    } catch (e) {
      out.file[nome] = e.code === 'ENOENT' ? { presente: false, byte: 0 } : { presente: null, byte: null };
      if (e.code !== 'ENOENT' || nome === 'database') {
        out.stato = 'parziale';
        sqliteMisurabile = false;
      }
    }
  }
  try {
    // Anche un PRAGMA di lettura può aprire journal ausiliari: non interrogare
    // SQLite se il controllo dei file ha rilevato un oggetto non verificabile.
    if (!sqliteMisurabile) throw new Error();
    const pagine = numero(db.prepare('PRAGMA page_count').get().page_count);
    const libere = numero(db.prepare('PRAGMA freelist_count').get().freelist_count);
    const bytePagina = numero(db.prepare('PRAGMA page_size').get().page_size);
    const journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
    if (pagine === null || libere === null || bytePagina === null || libere > pagine
        || !['delete','truncate','persist','memory','wal','off'].includes(journal)) throw new Error();
    out.sqlite = { journal, pagine, pagineLibere: libere, bytePagina,
      byteAllocati: numero(pagine * bytePagina), byteRiutilizzabili: numero(libere * bytePagina) };
    if (out.sqlite.byteAllocati === null || out.sqlite.byteRiutilizzabili === null) out.stato = 'parziale';
  } catch { out.stato = 'parziale'; }
  try {
    const stat = fs.statfsSync(directory);
    out.filesystem = { byteDisponibili: numero(stat.bavail * stat.bsize),
      byteTotali: numero(stat.blocks * stat.bsize) };
    if (Object.values(out.filesystem).includes(null)) out.stato = 'parziale';
  } catch { out.stato = 'parziale'; }
  return out;
}

module.exports = { misuraRegistro };
