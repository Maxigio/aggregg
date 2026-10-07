'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { leggiCredenziali, validaConfigurazione } = require('../scripts/collauda-backup-r2-postgres');

test('collaudo R2: file esplicito privato, nessuna configurazione extra o symlink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-r2-env-test-'));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, '.env'), alias = path.join(dir, 'alias');
  const key = crypto.randomBytes(16).toString('hex'), secret = crypto.randomBytes(32).toString('hex');
  const good = 'AWS_ACCESS_KEY_ID=' + key + '\nAWS_SECRET_ACCESS_KEY=' + secret + '\n';
  try {
    fs.writeFileSync(file, good, { mode: 0o600 });
    assert.deepEqual(leggiCredenziali(file), { AWS_ACCESS_KEY_ID: key, AWS_SECRET_ACCESS_KEY: secret });
    fs.chmodSync(file, 0o644);
    assert.throws(() => leggiCredenziali(file), { message: 'credenziali_collaudo_non_valide' });
    fs.chmodSync(file, 0o600); fs.symlinkSync(file, alias);
    assert.throws(() => leggiCredenziali(alias), { message: 'credenziali_collaudo_non_valide' });
    for (const bad of [good + 'AWS_SESSION_TOKEN=extra\n', good + 'AWS_ACCESS_KEY_ID=' + key + '\n',
      'AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\n']) {
      fs.writeFileSync(file, bad);
      assert.throws(() => leggiCredenziali(file), { message: 'credenziali_collaudo_non_valide' });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collaudo PG: rifiuta daemon diverso e binario modificato prima di eseguire processi', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-r2-bin-test-'));
  const file = path.join(dir, 'restic'), alias = path.join(dir, 'alias');
  try {
    fs.writeFileSync(file, 'fixture non eseguibile', { mode: 0o600 });
    const config = { host: 'unix://' + path.join(os.homedir(), '.colima/amr-auth/docker.sock'), restic: file,
      impronta: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    assert.deepEqual(validaConfigurazione(config), {});
    assert.throws(() => validaConfigurazione({ ...config, host: 'tcp://127.0.0.1:2375' }), { message: 'collaudo_non_configurato' });
    fs.symlinkSync(file, alias);
    assert.throws(() => validaConfigurazione({ ...config, restic: alias }), { message: 'collaudo_non_configurato' });
    fs.appendFileSync(file, 'alterato');
    assert.throws(() => validaConfigurazione(config), { message: 'collaudo_non_configurato' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('collaudo PG: cleanup della rete creata con risposta persa, soltanto dopo verifica etichetta', async () => {
  const Module = require('node:module'), { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-r2-cleanup-test-'));
  const file = path.join(dir, 'restic'), commands = [];
  let present = false, owner, generated;
  fs.writeFileSync(file, 'fixture non eseguibile', { mode: 0o600 });
  const fakeSpawn = (binary, args) => {
    assert.equal(binary, 'docker'); commands.push(args.slice(2, 4).join(' '));
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.resume(); child.kill = () => true;
    setImmediate(() => {
      let code = 0;
      if (args[2] === 'network' && args[3] === 'create') {
        present = true; owner = args[args.indexOf('--label') + 1].slice('amr.collaudo='.length); code = 1;
      } else if (args[2] === 'network' && args[3] === 'inspect') child.stdout.write(owner + '\n');
      else if (args[2] === 'network' && args[3] === 'rm') present = false;
      else assert.fail('Comando imprevisto nel mock');
      child.stdout.end(); child.stderr.end(); child.emit('close', code);
    });
    return child;
  };
  const filename = path.resolve(__dirname, '../scripts/collauda-backup-r2-postgres.js');
  const fixture = new Module(filename, module); fixture.filename = filename;
  fixture.paths = Module._nodeModulePaths(path.dirname(filename));
  fixture.require = name => name === 'node:child_process' ? { spawn: fakeSpawn } : Module.prototype.require.call(fixture, name);
  fixture._compile(fs.readFileSync(filename, 'utf8'), filename);
  try {
    await assert.rejects(fixture.exports.collauda({ host: 'unix://' + path.join(os.homedir(), '.colima/amr-auth/docker.sock'),
      restic: file, impronta: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }), e => {
      generated = e.directory;
      assert.equal(present, false);
      assert.deepEqual(commands, ['network create', 'network inspect', 'network rm']);
      assert.equal(JSON.parse(fs.readFileSync(path.join(generated, 'esito.json'))).cleanup, true);
      return e.message === 'collaudo_non_confermato';
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (generated) fs.rmSync(generated, { recursive: true, force: true });
  }
});
