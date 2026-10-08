'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { preparaSegreti } = require('../backend/nodi/backup-segreti-run');
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-segreti-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const temporanei = path.join(directory, 'tmp'); fs.mkdirSync(temporanei, { mode: 0o700 });
  const metadati = path.join(directory, 'binari.json');
  fs.writeFileSync(metadati, JSON.stringify({ restic: { path: '/usr/bin/restic', sha256: 'a'.repeat(64) },
    pgDump: { path: '/usr/lib/postgresql/18/bin/pg_dump', sha256: 'b'.repeat(64) } }), { mode: 0o444 });
  const sintetici = { r2: { AWS_ACCESS_KEY_ID: 'c'.repeat(32), AWS_SECRET_ACCESS_KEY: 'd'.repeat(64) },
    passwordRestic: 'e'.repeat(64), passwordDump: 'f'.repeat(64) };
  return { directory, temporanei, metadati, sintetici, env: { AMR_COPIE_SEGRETI: JSON.stringify(sintetici),
    AMR_PG_HOST: 'postgres', AMR_PG_DATABASE: 'amr', AMR_COPIE_PG_USER: 'amr_dump' } };
}
test('segreti Run: configurazione preesistente senza segreto aggregato resta invariata', () => {
  const env = { AMR_COPIE_R2_ENV: '/fixture/r2.env' };
  const p = preparaSegreti(env); assert.equal(p.ambiente, env); p.chiudi(); p.chiudi();
});
test('segreti Run: tre file privati effimeri, nessun segreto aggregato nel config; cleanup idempotente', t => {
  const f = fixture(t), p = preparaSegreti(f.env, f);
  assert.equal(p.ambiente.AMR_COPIE_SEGRETI, undefined);
  assert.equal(fs.statSync(path.dirname(p.ambiente.AMR_COPIE_R2_ENV)).mode & 0o777, 0o700);
  for (const k of ['R2_ENV', 'PASSWORD_FILE', 'PG_PASSFILE']) {
    assert.equal(fs.statSync(p.ambiente['AMR_COPIE_' + k]).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(p.ambiente.AMR_COPIE_PG_PASSFILE, 'utf8'), 'postgres:5432:amr:amr_dump:' + 'f'.repeat(64) + '\n');
  assert.equal(p.ambiente.AMR_COPIE_RESTIC_SHA256, 'a'.repeat(64));
  assert.deepEqual(Object.keys(p.ambiente).filter(k => /PASSWORD$|SECRET_ACCESS_KEY/.test(k)), []);
  p.chiudi(); p.chiudi(); assert.deepEqual(fs.readdirSync(f.temporanei), []);
});
test('segreti Run: input ostili e percorsi doppi rifiutati prima di creare file', t => {
  const f = fixture(t);
  for (const patch of [{ AMR_COPIE_SEGRETI: 'null' }, { AMR_COPIE_SEGRETI: '{' },
    { AMR_COPIE_R2_ENV: '/etc/fixture' }, { AMR_PG_HOST: 'host:injection' },
    ...['0', '65536', '5432:injection', 'NaN'].map(AMR_PG_PORT => ({ AMR_PG_PORT })),
    { AMR_COPIE_SEGRETI: JSON.stringify({ ...f.sintetici, passwordDump: 'x\ninjection' }) },
    { AMR_COPIE_SEGRETI: JSON.stringify({ ...f.sintetici, altro: true }) }]) {
    assert.throws(() => preparaSegreti({ ...f.env, ...patch }, f), /segreti_copie_non_validi/);
    assert.deepEqual(fs.readdirSync(f.temporanei), []);
  }
});
test('segreti Run: pgpass usa la stessa porta canonica del config del centro', t => {
  const f = fixture(t), p = preparaSegreti({ ...f.env, AMR_PG_PORT: '05432' }, f);
  assert.equal(fs.readFileSync(p.ambiente.AMR_COPIE_PG_PASSFILE, 'utf8'), 'postgres:5432:amr:amr_dump:' + 'f'.repeat(64) + '\n');
  p.chiudi();
});
test('segreti Run: metadata symlink/scrivibili rifiutati prima di creare file', t => {
  const f = fixture(t), alias = path.join(f.directory, 'alias'); fs.symlinkSync(f.metadati, alias);
  assert.throws(() => preparaSegreti(f.env, { ...f, metadati: alias }), /segreti_copie_non_validi/);
  fs.chmodSync(f.metadati, 0o666);
  assert.throws(() => preparaSegreti(f.env, f), /segreti_copie_non_validi/);
  assert.deepEqual(fs.readdirSync(f.temporanei), []);
});
test('segreti Run: cleanup rifiuta una directory sostituita e preserva file estranei', t => {
  const f = fixture(t), p = preparaSegreti(f.env, f), directory = path.dirname(p.ambiente.AMR_COPIE_R2_ENV);
  fs.renameSync(directory, directory + '-originale'); fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'preserva'), 'fixture');
  assert.throws(() => p.chiudi(), /segreti_copie_non_validi/);
  assert.equal(fs.readFileSync(path.join(directory, 'preserva'), 'utf8'), 'fixture');
});
