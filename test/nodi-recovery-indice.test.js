'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pubblicaIndiceRecovery, preparaRecoveryIndice } = require('../backend/nodi/recovery-indice');
const { preparaJournalDaRepository } = require('../backend/nodi/ripristino-journal');
const { creaRestic } = require('../backend/nodi/backup-restic');
const id = n => n.toString(16).padStart(64, '0');
const journal = n => ({ versione: 1, sequenza: String(n), dominio: 'aziende',
  operazione: '00000000-0000-4000-8000-' + String(n).padStart(12, '0'), tipo: 'revoca_azienda',
  confermata_il: '2026-10-08T00:00:00Z', attore: '00000000-0000-4000-8000-000000000001',
  destinatario: null, invito: null, azienda: { id: 'sintetica', nome: null, attiva: false,
    moduli: ['moto'], scadenza: '2027-10-08T00:00:00Z', referente: null, accettata_il: null, attivata_il: null }, persone: [] });

function fixture() {
  let indice; const calls = [];
  const database = { identita: async () => id(1), elenca: async () => [{ id: id(3) }],
    copiaIndice: async bytes => { calls.push('copia'); indice = Buffer.from(bytes); return { snapshot: id(4) }; },
    leggiIndice: async snap => { assert.equal(snap, id(4)); return Buffer.from(indice); } };
  const journals = new Map([[id(5), journal(5)], [id(8), journal(8)]]);
  const repository = { identita: async () => id(2), elenca: async () => [...journals.keys()].map(id => ({ id })),
    leggiJournal: async snapshot => journals.get(snapshot) };
  const arg = { repositoryDatabase: database, repositoryJournal: repository };
  return { database, repository, journals, calls, arg,
    publish: () => pubblicaIndiceRecovery({ ...arg, database: id(3), journalAttesi: [id(8), id(5)] }),
    altera: fn => { indice = fn(indice); } };
}

test('indice: ricevuta separata, ID esatti, ordine per sequenza e buchi legittimi', async () => {
  const f = fixture(), ricevuta = await f.publish();
  assert.deepEqual(Object.keys(ricevuta), ['versione','repositoryDatabase','repositoryJournal','indice','sha256']);
  const piano = await preparaRecoveryIndice({ ...f.arg, ricevuta });
  assert.equal(piano.database, id(3)); assert.deepEqual(piano.journals.map(j => j.sequenza), ['5', '8']);
  assert.equal(f.calls.length, 1);
});
test('indice: copia omessa blocca anche quando discovery residua sarebbe valida', async () => {
  const f = fixture(), ricevuta = await f.publish(); f.journals.delete(id(5));
  assert.equal((await preparaJournalDaRepository({ repository: f.repository })).journals.length, 1);
  await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta }), { codice: 'recovery_copia_mancante' });
});
test('indice: dump mancante non sceglie una copia alternativa', async () => {
  const f = fixture(), ricevuta = await f.publish(); f.database.elenca = async () => [{ id: id(99) }];
  await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta }), { codice: 'recovery_copia_mancante' });
});
test('indice: ricevuta alterata, payload alterato e repository diverso impediscono il piano', async () => {
  const f = fixture(), ricevuta = await f.publish();
  await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta: { ...ricevuta, sha256: id(99) } }),
    { codice: 'recovery_indice_non_verificato' });
  f.database.identita = async () => id(99);
  await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta }), { codice: 'recovery_repository_diverso' });
  f.database.identita = async () => id(1); f.altera(b => Buffer.concat([b, Buffer.from(' ')]));
  await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta }), { codice: 'recovery_indice_non_verificato' });
});
test('indice: lista attesa obbligatoria dal chiamante, niente discovery come sostituto', async () => {
  for (const journalAttesi of [undefined, [id(5), id(5)], ['latest'], Array(10001).fill(id(5)), [id(99)]]) {
    const f = fixture();
    await assert.rejects(pubblicaIndiceRecovery({ ...f.arg, database: id(3), journalAttesi }));
    assert.equal(f.calls.length, 0);
  }
});
test('indice: errore di lettura o journal invalido non consegna un piano', async () => {
  for (const tipo of ['lettura', 'payload']) {
    const f = fixture(), ricevuta = await f.publish();
    f.repository.leggiJournal = async () => { if (tipo === 'lettura') throw new Error('backup_non_disponibile'); return {}; };
    await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta }));
  }
});
test('indice: readback fallito non produce una ricevuta confermata', async () => {
  const f = fixture(); f.database.leggiIndice = async () => Buffer.from('{}');
  await assert.rejects(f.publish(), { codice: 'recovery_indice_non_verificato' });
  assert.equal(f.calls.length, 1, 'La copia può esistere: non ritentare automaticamente la pubblicazione');
});
test('indice: input inatteso rifiutato prima di contattare i repository', async () => {
  const f = fixture(); f.database.leggiIndice = async () => assert.fail('input non valido');
  for (const ricevuta of [null, {}, [], { versione: 1, repositoryDatabase: id(1), repositoryJournal: id(2),
    indice: 'latest', sha256: id(3) }, { versione: 1, repositoryDatabase: id(1), repositoryJournal: id(2),
    indice: id(4), sha256: id(3), extra: 1 }]) await assert.rejects(preparaRecoveryIndice({ ...f.arg, ricevuta }));
});

test('indice reale: restic cifrato, chiave errata e snapshot rimosso nella sola fixture',
  { skip: !process.env.AMR_TEST_RESTIC && 'Impostare AMR_TEST_RESTIC al binario verificato' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-recovery-indice-'));
    fs.chmodSync(dir, 0o700); const password = path.join(dir, 'password');
    fs.writeFileSync(password, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const crea = (nome, key = password) => creaRestic({ binario: process.env.AMR_TEST_RESTIC,
      ambiente: { RESTIC_REPOSITORY: path.join(dir, nome), RESTIC_PASSWORD_FILE: key } });
    const database = crea('database'), repository = crea('journal');
    try {
      await database.inizializza(); await repository.inizializza();
      const dump = await database.copia(Buffer.from('PGDMP-fixture'), 'database');
      const copia = await repository.copia(Buffer.from(JSON.stringify(journal(5))), 'journal');
      const arg = { repositoryDatabase: database, repositoryJournal: repository };
      const ricevuta = await pubblicaIndiceRecovery({ ...arg, database: dump.snapshot, journalAttesi: [copia.snapshot] });
      assert.equal((await preparaRecoveryIndice({ ...arg, ricevuta })).journals.length, 1);
      const wrong = path.join(dir, 'password-errata'); fs.writeFileSync(wrong, randomBytes(32).toString('hex'), { mode: 0o600 });
      await assert.rejects(preparaRecoveryIndice({ ...arg, ricevuta, repositoryDatabase: crea('database', wrong) }));
      const file = path.join(dir, 'journal', 'snapshots', copia.snapshot), saved = path.join(dir, 'snapshot-preservato');
      fs.renameSync(file, saved);
      try { await assert.rejects(preparaRecoveryIndice({ ...arg, ricevuta }), { codice: 'recovery_copia_mancante' }); }
      finally { fs.renameSync(saved, file); }
      assert.equal((await preparaRecoveryIndice({ ...arg, ricevuta })).journals.length, 1);
      await database.verifica(); await repository.verifica();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
