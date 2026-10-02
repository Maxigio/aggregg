'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { creaRestic } = require('../backend/nodi/backup-restic');

test('restic: configurazione esplicita senza caricamento env', () => {
  assert.throws(() => creaRestic({ binario: 'restic', ambiente: {} }), /backup_non_configurato/);
});

test('restic reale: repository cifrati separati, restore e password errata',
  { skip: !process.env.AMR_TEST_RESTIC && 'Impostare AMR_TEST_RESTIC al binario verificato' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restic-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const password = path.join(dir, 'password');
    fs.writeFileSync(password, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const copie = {};
    for (const categoria of ['journal', 'database']) {
      const ambiente = { RESTIC_REPOSITORY: path.join(dir, categoria), RESTIC_PASSWORD_FILE: password };
      const repo = creaRestic({ binario: process.env.AMR_TEST_RESTIC, ambiente });
      assert.deepEqual(await repo.inizializza(), { ok: true });
      const dati = categoria === 'journal'
        ? Buffer.from(JSON.stringify({ versione: 1, id: crypto.randomUUID(), stato: 'revocata' }))
        : crypto.randomBytes(2048);
      const copia = await repo.copia(dati, categoria);
      assert.deepEqual(await repo.verifica(), { ok: true });
      const restore = await repo.ripristina(copia.snapshot, dir);
      assert.deepEqual(fs.readFileSync(path.join(restore, categoria === 'journal' ? 'operazioni.json' : 'database.dump')), dati);
      await assert.rejects(repo.copia(dati, '--password-command=non-eseguire'), /backup_input_non_valido/);
      copie[categoria] = { ambiente, snapshot: copia.snapshot };
    }
    const errata = path.join(dir, 'errata'); fs.writeFileSync(errata, 'password-sintetica-errata', { mode: 0o600 });
    const repo = creaRestic({ binario: process.env.AMR_TEST_RESTIC,
      ambiente: { ...copie.journal.ambiente, RESTIC_PASSWORD_FILE: errata } });
    await assert.rejects(repo.ripristina(copie.journal.snapshot, dir), e => e.message === 'backup_non_disponibile');
    await assert.rejects(repo.ripristina(copie.journal.snapshot,path.join(dir,'assente')), e =>
      e.message === 'backup_non_disponibile' && !e.path);
  });
