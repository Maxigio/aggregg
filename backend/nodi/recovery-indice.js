'use strict';

const { createHash } = require('node:crypto');
const { preparaJournalDaRepository } = require('./ripristino-journal');
const MAX = 10000, MAX_BYTE = 16 * 1024 * 1024;
const idValido = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const errore = codice => Object.assign(new Error(codice), { codice, manuale: true });
const sha = b => createHash('sha256').update(b).digest('hex');
function oggetto(v, campi) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== campi.length
      || campi.some(k => !Object.hasOwn(v, k))) throw errore('recovery_indice_non_valido');
}
function ids(v) {
  if (!Array.isArray(v) || v.length > MAX || v.some(x => !idValido(x))
      || new Set(v).size !== v.length) throw errore('recovery_indice_non_valido');
  return [...v].sort();
}
function validaIndice(v) {
  oggetto(v, ['versione','creato_il','repositoryDatabase','repositoryJournal','database','journal']);
  if (v.versione !== 1 || ![v.repositoryDatabase, v.repositoryJournal, v.database].every(idValido)
      || v.repositoryDatabase === v.repositoryJournal || typeof v.creato_il !== 'string'
      || !Number.isFinite(Date.parse(v.creato_il)) || new Date(v.creato_il).toISOString() !== v.creato_il) {
    throw errore('recovery_indice_non_valido');
  }
  return { versione: 1, creato_il: v.creato_il, repositoryDatabase: v.repositoryDatabase,
    repositoryJournal: v.repositoryJournal, database: v.database, journal: ids(v.journal) };
}
function validaRicevuta(v) {
  oggetto(v, ['versione','repositoryDatabase','repositoryJournal','indice','sha256']);
  if (v.versione !== 1 || ![v.repositoryDatabase,v.repositoryJournal,v.indice,v.sha256].every(idValido)
      || v.repositoryDatabase === v.repositoryJournal) throw errore('recovery_ricevuta_non_valida');
}
async function preparaIndice({ indice, repositoryDatabase, repositoryJournal }) {
  const [database, journal] = await Promise.all([
    repositoryDatabase.identita(), repositoryJournal.identita()]);
  if (database !== indice.repositoryDatabase || journal !== indice.repositoryJournal) {
    throw errore('recovery_repository_diverso');
  }
  const [dump, disponibili] = await Promise.all([
    repositoryDatabase.elenca('database'), repositoryJournal.elenca('journal')]);
  if (!Array.isArray(dump) || dump.length > MAX || !Array.isArray(disponibili) || disponibili.length > MAX
      || [...dump, ...disponibili].some(s => !idValido(s?.id))) throw errore('recovery_indice_non_valido');
  const presenti = new Set(disponibili.map(s => s.id));
  if (!dump.some(s => s.id === indice.database) || indice.journal.some(s => !presenti.has(s))) {
    throw errore('recovery_copia_mancante');
  }
  // Leggere solo le copie del punto esplicito, ma validarle tutte prima del SQL.
  const piano = await preparaJournalDaRepository({ repository: {
    elenca: async () => indice.journal.map(id => ({ id })),
    leggiJournal: id => repositoryJournal.leggiJournal(id),
  } });
  return { database: indice.database, ...piano };
}

// Chiamante offline: journalAttesi viene dal source congelato/outbox, non dalla
// lista R2 già potenzialmente incompleta. La ricevuta va custodita separatamente.
async function pubblicaIndiceRecovery({ repositoryDatabase, repositoryJournal, database, journalAttesi, ora = Date.now }) {
  const [repoDB, repoJournal] = await Promise.all([
    repositoryDatabase.identita(), repositoryJournal.identita()]);
  const indice = validaIndice({ versione: 1, creato_il: new Date(ora()).toISOString(),
    repositoryDatabase: repoDB, repositoryJournal: repoJournal, database, journal: journalAttesi });
  await preparaIndice({ indice, repositoryDatabase, repositoryJournal });
  const bytes = Buffer.from(JSON.stringify(indice));
  try {
    const copia = await repositoryDatabase.copiaIndice(bytes);
    if (!idValido(copia?.snapshot)) throw errore('recovery_indice_non_valido');
    const ricevuta = { versione: 1, repositoryDatabase: repoDB, repositoryJournal: repoJournal,
      indice: copia.snapshot, sha256: sha(bytes) };
    await preparaRecoveryIndice({ ricevuta, repositoryDatabase, repositoryJournal });
    return ricevuta;
  } finally { bytes.fill(0); }
}

// La ricevuta è l'ancora fidata: non scegliere silenziosamente un indice vecchio.
// Nessun accesso al DB sorgente, pg_restore o scrittura SQL in questa funzione.
async function preparaRecoveryIndice({ ricevuta, repositoryDatabase, repositoryJournal }) {
  validaRicevuta(ricevuta);
  const bytes = await repositoryDatabase.leggiIndice(ricevuta.indice);
  try {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_BYTE || sha(bytes) !== ricevuta.sha256) {
      throw errore('recovery_indice_non_verificato');
    }
    let indice;
    try { indice = validaIndice(JSON.parse(bytes.toString('utf8'))); }
    catch { throw errore('recovery_indice_non_valido'); }
    if (indice.repositoryDatabase !== ricevuta.repositoryDatabase || indice.repositoryJournal !== ricevuta.repositoryJournal) {
      throw errore('recovery_repository_diverso');
    }
    return await preparaIndice({ indice, repositoryDatabase, repositoryJournal });
  } finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
}

module.exports = { pubblicaIndiceRecovery, preparaRecoveryIndice };
