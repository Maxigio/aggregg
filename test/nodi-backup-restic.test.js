'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { creaRestic } = require('../backend/nodi/backup-restic');

test('restic: configurazione esplicita senza caricamento env', () => {
  assert.throws(() => creaRestic({ binario: 'restic', ambiente: {} }), /backup_non_configurato/);
  assert.throws(() => creaRestic({ binario: '/restic', ambiente: {
    RESTIC_REPOSITORY: '/repo', RESTIC_PASSWORD_FILE: '/repo/password' } }), /backup_non_configurato/);
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

test('restic reale: retention 90 giorni e 14 giorni DB, dry-run e restore dei conservati',
  { skip: !process.env.AMR_TEST_RESTIC && 'Impostare AMR_TEST_RESTIC al binario verificato' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-retention-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const password = path.join(dir, 'password');
    fs.writeFileSync(password, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const ora = Date.now() - 60000;
    for (const categoria of ['journal', 'database']) {
      const repo = creaRestic({ binario: process.env.AMR_TEST_RESTIC,
        ambiente: { RESTIC_REPOSITORY: path.join(dir,categoria), RESTIC_PASSWORD_FILE: password } });
      await repo.inizializza();
      const ids = [];
      for (const giorni of categoria === 'journal' ? [100,91,89,20,1,0] : Array.from({length:17},(_,i)=>16-i)) {
        ids.push((await repo.copia(Buffer.from('sintetico-' + giorni), categoria,
          { data: new Date(ora - giorni * 86400000).toISOString() })).snapshot);
      }
      // Un altro insieme nello stesso repo adversarial: filtro categoria lo preserva.
      const estranea = await repo.copia(Buffer.from('estraneo'), categoria === 'journal' ? 'database' : 'journal');
      const opts = { snapshot: ids.at(-1) };
      const piano = await repo.retention(categoria, opts);
      assert.equal(piano.dryRun, true); assert.equal(piano.eliminate, 0);
      assert.equal(piano.conservate, categoria === 'journal' ? 4 : 14);
      assert.equal(piano.eliminabili, categoria === 'journal' ? 2 : 3);
      // Il dry-run conserva anche quelli candidati alla rimozione.
      await repo.ripristina(ids[0],dir);
      await assert.rejects(repo.retention(categoria, { dryRun: false,snapshot: ids[0] }), /backup_retention_non_sicura/);
      const applied = await repo.retention(categoria, { ...opts,dryRun:false });
      assert.equal(applied.eliminate,piano.eliminabili);
      await assert.rejects(repo.ripristina(ids[0],dir), /backup_non_disponibile/);
      const restored = await repo.ripristina(ids.at(-1),dir);
      assert.equal(fs.readFileSync(path.join(restored,categoria === 'journal' ? 'operazioni.json' : 'database.dump'),'utf8'), 'sintetico-0');
      await repo.ripristina(estranea.snapshot,dir); await repo.verifica();
    }
  });
