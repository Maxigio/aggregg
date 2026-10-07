'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const compat = require('../backend/nodi/compatibilita-nodo');
const { configura, avvia } = require('../scripts/avvia-worker-staging');

function fixture(t, worker = '{}') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-worker-staging-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const radice = path.join(dir, 'artefatto');
  const scrivi = (nome, testo) => {
    const file = path.join(radice, nome); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, testo);
  };
  for (const n of compat.CATALOGHI) scrivi('data/' + n, '{}');
  for (const n of ['backend/nodi/worker.js', 'backend/nodi/compatibilita-nodo.js',
    'frontend/prova.js', 'pagine/prova.html', 'scripts/prova.js', 'package.json', 'package-lock.json']) scrivi(n, '{}');
  scrivi('backend/nodi/worker.js', worker);
  const codice = compat.listaCodice(radice), cataloghi = compat.listaCataloghi(path.join(radice, 'data'));
  const manifest = { protocollo: 1, release: 'a'.repeat(40), codice: compat.hashCodice(radice, codice),
    cataloghi: compat.hashCataloghi(path.join(radice, 'data')), inventario: { codice, cataloghi } };
  scrivi('release.json', JSON.stringify(manifest));
  const file = path.join(dir, 'nodo.json');
  const config = { centro: 'https://staging.invalid', id: 'imac-staging', token: 'b'.repeat(64) };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { radice, file, directory: path.join(dir, 'dati'), dir, config, scrivi };
}

test('staging worker: artefatto esatto e dati nuovi; simulazione predefinita e live esplicito', t => {
  const f = fixture(t), c = configura(f);
  assert.equal(c.env.AMR_NODO_SIMULATO, '1');
  assert.equal(c.env.USER_DATA_PATH, f.directory);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  assert.ok(!Object.keys(c.env).some(k => /AUTH|SMTP|PASSWORD|NODE_OPTIONS/.test(k)));
  const live = configura({ ...f, directory: path.join(f.dir, 'live'), live: true });
  assert.equal(live.env.AMR_NODO_SIMULATO, '0');
  assert.throws(() => configura(f), /configurazione_worker_staging_non_valida/);
});

test('staging worker: configurazioni e artefatti rifiutati non avviano processi', async t => {
  for (const [nome, prepara] of [
    ['permessi', f => fs.chmodSync(f.file, 0o644)],
    ['symlink config', f => { fs.renameSync(f.file, f.file + '.orig'); fs.symlinkSync(f.file + '.orig', f.file); }],
    ['schema config', f => fs.writeFileSync(f.file, JSON.stringify({ ...f.config, password: 'sintetica' }))],
    ['redirect credenziale', f => fs.writeFileSync(f.file, JSON.stringify({ ...f.config, centro: 'https://staging.invalid/altro' }))],
    ['codice alterato', f => f.scrivi('backend/nodi/worker.js', 'modificato')],
    ['catalogo alterato', f => f.scrivi('data/models.json', '{"diverso":true}')],
    ['dati nell’artefatto', f => { f.directory = path.join(f.radice, 'dati'); }],
    ['directory esistente', f => fs.mkdirSync(f.directory)],
  ]) await t.test(nome, st => {
    const f = fixture(st); prepara(f); let calls = 0;
    assert.throws(() => avvia(f, () => { calls++; }), /configurazione_worker_staging_non_valida/);
    assert.equal(calls, 0);
  });
});

test('staging worker: arresto idempotente del solo figlio e nessun token negli argv', async t => {
  const f = fixture(t), p = new EventEmitter(), segnali = []; let opts, args;
  p.kill = s => { segnali.push(s); setImmediate(() => { p.emit('exit', 0); p.emit('close', 0); }); };
  const w = avvia(f, (_exe, a, o) => { args = a; opts = o; return p; });
  assert.deepEqual(args, [path.join(f.radice, 'backend/nodi/worker.js')]);
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
  await Promise.all([w.close(), w.close()]);
  assert.deepEqual(segnali, ['SIGTERM']);
  await w.close(); assert.deepEqual(segnali, ['SIGTERM']);
});

test('staging worker solo stato: rifiuta worker precedenti che ignorano il vincolo', t => {
  const vecchio = fixture(t);
  assert.throws(() => configura({ ...vecchio, soloStato: true }), /configurazione_worker_staging_non_valida/);
  assert.equal(fs.existsSync(vecchio.directory), false);
  const attuale = fixture(t, fs.readFileSync(path.join(__dirname, '../backend/nodi/worker.js'), 'utf8'));
  const c = configura({ ...attuale, soloStato: true });
  assert.equal(c.env.AMR_NODO_SOLO_STATO, '1'); assert.equal(c.env.AMR_NODO_SIMULATO, '0');
  assert.throws(() => configura({ ...attuale, live: true, soloStato: true }), /configurazione_worker_staging_non_valida/);
});

test('staging worker CLI: runtime scelto e configurazione incompatibile non diventano successo', {
  skip: Number(process.versions.node.split('.')[0]) !== 24 ? 'CLI collaudata con Node 24' : false,
}, t => {
  const { spawnSync } = require('node:child_process');
  for (const [worker, atteso] of [['', 0], ['process.exit(78);', 1]]) {
    const f = fixture(t, worker);
    const r = spawnSync(process.execPath, [path.join(__dirname, '../scripts/avvia-worker-staging.js'),
      f.file, f.radice, f.directory], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, atteso, r.stderr);
    assert.ok(!r.stdout.includes(f.config.token));
    const ultimo = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.equal(ultimo.evento, 'processo_worker_terminato');
    if (atteso === 1) { assert.equal(ultimo.code, 78); assert.equal(ultimo.signal, null); }
  }
});
