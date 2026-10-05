'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { preparaVolume } = require('../scripts/nhost/prepara-volume-staging');
function fixture({ files = [], link = false, mount = true } = {}) {
  let uid = 0, gid = 0, mode = 0o755;
  const calls = [];
  const filesystem = {
    readFileSync: () => mount ? '10 9 8:1 / /var/lib/amr rw - ext4 /dev/test rw' : '',
    openSync: (_path, flags) => {
      assert.ok(flags & require('node:fs').constants.O_NOFOLLOW);
      if (link) throw new Error('symlink_non_ammesso');
      return 23;
    },
    fstatSync: () => ({ isDirectory: () => true, uid, gid, mode }),
    readdirSync: () => files,
    fchownSync: (fd, u, g) => { calls.push(['owner', fd, u, g]); uid = u; gid = g; },
    fchmodSync: (fd, m) => { calls.push(['mode', fd, m]); mode = m; },
    closeSync: fd => calls.push(['close', fd]),
  };
  return { filesystem, calls };
}
test('volume nuovo: modifica soltanto la directory del mount e verifica i permessi', () => {
  const f = fixture({ files: ['lost+found'] });
  assert.deepEqual(preparaVolume({ ...f, uid: 0 }), { uid: 1000, gid: 1000, mode: '0700' });
  assert.deepEqual(f.calls, [['owner', 23, 1000, 1000], ['mode', 23, 0o700], ['close', 23]]);
});
test('volume con stato esistente o symlink: nessuna modifica', () => {
  for (const opts of [{ files: ['centro.db'] }, { link: true }]) {
    const f = fixture(opts);
    assert.throws(() => preparaVolume({ ...f, uid: 0 }), /volume_non_nuovo|symlink_non_ammesso/);
    assert.equal(f.calls.some(c => c[0] !== 'close'), false);
  }
});
test('directory diversa o processo non root: nessuna modifica', () => {
  for (const opts of [{ directory: '/tmp' }, { uid: 1000 }]) {
    const f = fixture();
    assert.throws(() => preparaVolume({ ...f, uid: 0, ...opts }), /non_ammessa/);
    assert.deepEqual(f.calls, []);
  }
});
test('permessi non applicati: non dichiarare successo', () => {
  const f = fixture(); f.filesystem.fchmodSync = () => {};
  assert.throws(() => preparaVolume({ ...f, uid: 0 }), /non_confermati/);
  assert.deepEqual(f.calls.at(-1), ['close', 23]);
});
test('directory interna al container: non dichiarare preparato un mount assente', () => {
  const f = fixture({ mount: false });
  assert.throws(() => preparaVolume({ ...f, uid: 0 }), /mount_volume_non_confermato/);
  assert.deepEqual(f.calls, []);
});
test('pathname sostituito: le modifiche restano sul descriptor originale', () => {
  const f = fixture();
  f.filesystem.readdirSync = path => { assert.equal(path, '/proc/self/fd/23'); return []; };
  preparaVolume({ ...f, uid: 0 });
  assert.deepEqual(f.calls, [['owner', 23, 1000, 1000], ['mode', 23, 0o700], ['close', 23]]);
});
