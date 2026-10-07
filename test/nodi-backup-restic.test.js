'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { creaRestic } = require('../backend/nodi/backup-restic');
const { creaBackupPostgres } = require('../backend/nodi/backup-postgres-prova');

const MiB = 1024 * 1024;
function pianoSintetico(conservate = 1, eliminate = 0) {
  const snapshot = (i, scaduto = false) => ({
    id: (i + 1).toString(16).padStart(64, '0'), short_id: (i + 1).toString(16).padStart(8, '0'),
    tree: 'a'.repeat(64), time: new Date(Date.UTC(2026, scaduto ? 0 : 8, 30) - i * 1000).toISOString(),
    hostname: 'amr-centro', paths: ['/operazioni.json'], tags: ['journal'],
    username: 'utente-sintetico', uid: 501, gid: 20, program_version: 'restic 0.19.1',
    summary: { backup_start: '2026-09-30T00:00:00Z', backup_end: '2026-09-30T00:00:01Z',
      files_new: 1, total_files_processed: 1, total_bytes_processed: 123, data_added: 123 }
  });
  const keep = Array.from({ length: conservate }, (_, i) => snapshot(i));
  const remove = Array.from({ length: eliminate }, (_, i) => snapshot(conservate + i, true));
  return [{ host: 'amr-centro', paths: ['/operazioni.json'], tags: ['journal'], keep, remove,
    reasons: keep.map((s, i) => ({ snapshot: s, matches: i === 0 ? ['within', 'last snapshot'] : ['within'] })) }];
}

function resticSimulato(risposte) {
  const chiamate = [], processi = [];
  const repo = creaRestic({ binario: '/sintetico/restic', ambiente: {
    RESTIC_REPOSITORY: '/sintetico/journal', RESTIC_PASSWORD_FILE: '/sintetico/password'
  }, spawnProcesso(binario, args) {
    const risposta = typeof risposte === 'function' ? risposte(args) : risposte[chiamate.length] || {};
    chiamate.push(args);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.resume(); child.segnali = [];
    child.kill = segnale => { child.segnali.push(segnale); return true; };
    processi.push(child);
    child.stdin.once('finish', () => setImmediate(() => {
      if (risposta.azioni) risposta.azioni(child);
      else {
        const output = Buffer.isBuffer(risposta.output) ? risposta.output : Buffer.from(risposta.output || '');
        for (let i = 0; i < output.length; i += 16384) child.stdout.write(output.subarray(i, i + 16384));
      }
      child.stdout.end(); child.stderr.end(risposta.stderr);
      // Anche un exit 0 tardivo deve fallire dopo overflow/timeout.
      child.emit('close', risposta.code || 0);
    }));
    return child;
  } });
  return { repo, chiamate, processi };
}

function pianoConRimozioni(n) {
  const piano = pianoSintetico(1, n);
  piano[0].remove = piano[0].remove.map(({ id, time, hostname, paths, tags }) => ({ id, time, hostname, paths, tags }));
  return piano;
}

test('restic: discovery limitato di snapshot, restituisce solo ID e data', async t => {
  for (const categoria of ['journal', 'database']) await t.test(categoria, async () => {
    const snapshots = pianoSintetico(2)[0].keep;
    for (const s of snapshots) { s.tags = [categoria]; s.paths = [categoria === 'journal' ? '/operazioni.json' : '/database.dump']; }
    const f = resticSimulato([{ output: JSON.stringify(snapshots) }]);
    assert.deepEqual(await f.repo.elenca(categoria), snapshots.map(({ id, time }) => ({ id, time })));
    assert.deepEqual(f.chiamate[0], ['--no-cache', 'snapshots', '--json', '--host', 'amr-centro',
      '--path', snapshots[0].paths[0], '--tag', categoria]);
  });
  const f = resticSimulato([{ output: '[]' }]); assert.deepEqual(await f.repo.elenca('journal'), []);
});

test('restic: indice inatteso, duplicato o oltre cap interrompe discovery', async t => {
  const good = pianoSintetico()[0].keep[0];
  for (const bad of [null, [{ ...good, hostname: 'altro' }], [{ ...good, paths: ['/extra', '/operazioni.json'] }],
    [{ ...good, tags: ['journal', 'extra'] }], [{ ...good, id: 'latest' }], [{ ...good, time: 'non-data' }],
    [good, good], pianoSintetico(10001)[0].keep]) await t.test('indice rifiutato', async () => {
    const f = resticSimulato([{ output: JSON.stringify(bad) }]);
    await assert.rejects(f.repo.elenca('journal'), /backup_indice_non_valido/);
    assert.equal(f.chiamate.length, 1);
  });
  const f = resticSimulato([{ output: JSON.stringify(pianoSintetico(10000)[0].keep) }]);
  assert.equal((await f.repo.elenca('journal')).length, 10000);
});

test('restic: lettura journal senza file, ID esatto e limite 16 KiB', async () => {
  const f = resticSimulato([{ output: '{"versione":1}' }, { output: Buffer.alloc(16385, ' ') }, { code: 1 }]);
  assert.deepEqual(await f.repo.leggiJournal('a'.repeat(64)), { versione: 1 });
  assert.deepEqual(f.chiamate[0], ['--no-cache', 'dump', 'a'.repeat(64), '/operazioni.json']);
  await assert.rejects(f.repo.leggiJournal('latest'), /backup_input_non_valido/);
  await assert.rejects(f.repo.leggiJournal('b'.repeat(64)), /backup_non_disponibile/);
  assert.deepEqual(f.processi[1].segnali, ['SIGTERM']);
  await assert.rejects(f.repo.leggiJournal('c'.repeat(64)), /backup_non_disponibile/);
});

test('restic: indice recovery separato, ID completo e limite di 16 MiB', async () => {
  const f = resticSimulato([{ output: JSON.stringify({ message_type: 'summary', snapshot_id: 'a'.repeat(64) }) },
    { output: '{"versione":1}' }, { output: Buffer.alloc(16 * MiB + 1) }]);
  assert.deepEqual(await f.repo.copiaIndice(Buffer.from('{}')), { snapshot: 'a'.repeat(64) });
  assert.ok(f.chiamate[0].includes('recovery.json')); assert.ok(f.chiamate[0].includes('recovery'));
  assert.equal((await f.repo.leggiIndice('a'.repeat(64))).toString(), '{"versione":1}');
  assert.deepEqual(f.chiamate[1], ['--no-cache','dump','a'.repeat(64),'/recovery.json']);
  await assert.rejects(f.repo.leggiIndice('latest'), /backup_input_non_valido/);
  await assert.rejects(f.repo.copiaIndice(Buffer.alloc(16 * MiB + 1)), /backup_input_non_valido/);
  await assert.rejects(f.repo.copia(Buffer.from('{}'), 'recovery'), /backup_input_non_valido/);
  await assert.rejects(f.repo.retention('recovery', { snapshot: 'a'.repeat(64) }), /backup_input_non_valido/);
  await assert.rejects(f.repo.leggiIndice('a'.repeat(64)), /backup_non_disponibile/);
  assert.deepEqual(f.processi[2].segnali, ['SIGTERM']);
});

test('restic: discovery con exit 0 e diagnostica non accetta un indice parziale o vuoto', async t => {
  for (const snapshots of [[], pianoSintetico()[0].keep]) await t.test('indice con errori', async () => {
    const f = resticSimulato([{ output: JSON.stringify(snapshots),
      stderr: 'Ignoring "snapshot-sintetico": load snapshot failed\n' }]);
    await assert.rejects(f.repo.elenca('journal'), e => e.message === 'backup_non_disponibile' && !e.cause);
    assert.equal(f.chiamate.length, 1);
  });
  const f = resticSimulato([{ code: 1, output: '[]' }]);
  await assert.rejects(f.repo.elenca('journal'), /backup_non_disponibile/);
});

test('restic: configurazione esplicita senza caricamento env', () => {
  assert.throws(() => creaRestic({ binario: 'restic', ambiente: {} }), /backup_non_configurato/);
  assert.throws(() => creaRestic({ binario: '/restic', ambiente: {
    RESTIC_REPOSITORY: '/repo', RESTIC_PASSWORD_FILE: '/repo/password' } }), /backup_non_configurato/);
});

test('restic: la password resta fuori dal repository anche con alias locali', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restic-percorsi-'));
  const repository = path.join(dir, 'repository'), password = path.join(repository, 'password');
  fs.mkdirSync(repository); fs.writeFileSync(password, 'password-sintetica', { mode: 0o600 });
  const aliasRepo = path.join(dir, 'alias-repository'), aliasPassword = path.join(dir, 'alias-password');
  fs.symlinkSync(repository, aliasRepo); fs.symlinkSync(password, aliasPassword);
  fs.mkdirSync(path.join(repository, 'interna')); fs.mkdirSync(path.join(dir, 'links'));
  const linkInterno = path.join(dir, 'links', 'interna'); fs.symlinkSync(path.join(repository, 'interna'), linkInterno);
  const crea = (repo, pw = password) => creaRestic({ binario: '/sintetico/restic',
    ambiente: { RESTIC_REPOSITORY: repo, RESTIC_PASSWORD_FILE: pw } });
  try {
    for (const [nome, repo, pw] of [
      ['assoluto', repository, password],
      ['relativo', path.relative(process.cwd(), repository), password],
      ['local assoluto', 'local:' + repository, password],
      ['local relativo', 'local:' + path.relative(process.cwd(), repository), password],
      ['symlink repository', aliasRepo, password],
      ['symlink password', repository, aliasPassword],
      ['genitore lessicale del repository', linkInterno + '/..', path.join(dir, 'links', 'password')],
      ['directory non ancora creata', path.join(aliasRepo, 'nuova'), path.join(repository, 'nuova', 'password')],
    ]) await t.test(nome, () => assert.throws(() => crea(repo, pw), /backup_non_configurato/));
    await t.test('password esterna e directory nuova sono ammesse', () => {
      assert.doesNotThrow(() => crea(path.join(aliasRepo, 'nuova'), path.join(dir, 'password-esterna')));
      assert.doesNotThrow(() => crea(path.join(dir, 'repository-altro'), password));
      assert.doesNotThrow(() => crea(linkInterno + '/..', password));
      assert.doesNotThrow(() => crea('s3:https://storage.example.invalid/bucket', password));
    });
    await t.test('symlink non risolvibile rifiutato senza percorso nell’errore', () => {
      const mancante = path.join(dir, 'mancante'); fs.symlinkSync(path.join(dir, 'non-esiste'), mancante);
      assert.throws(() => crea(mancante), e => e.message === 'backup_non_configurato' && !e.path);
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restic: ricontrolla gli alias prima del comando, senza cambiare i repository remoti', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restic-alias-'));
  const repository = path.join(dir, 'repository'), esterno = path.join(dir, 'esterno');
  const password = path.join(repository, 'password'), alias = path.join(dir, 'alias');
  fs.mkdirSync(repository); fs.mkdirSync(esterno); fs.writeFileSync(password, 'sintetica', { mode: 0o600 });
  fs.symlinkSync(esterno, alias);
  let chiamate = 0;
  try {
    const repo = creaRestic({ binario: '/sintetico/restic', ambiente: {
      RESTIC_REPOSITORY: alias, RESTIC_PASSWORD_FILE: password },
    spawnProcesso() { chiamate++; throw new Error('non deve partire'); } });
    fs.unlinkSync(alias); fs.symlinkSync(repository, alias);
    await assert.rejects(repo.inizializza(), e => e.message === 'backup_non_configurato' && !e.path);
    assert.equal(chiamate, 0);
    const remoto = 's3:https://storage.example.invalid:443/bucket';
    const s3 = creaRestic({ binario: '/sintetico/restic', ambiente: {
      RESTIC_REPOSITORY: remoto, RESTIC_PASSWORD_FILE: password },
    spawnProcesso(_binario, _args, { env }) {
      assert.equal(env.RESTIC_REPOSITORY, remoto); chiamate++; throw new Error('trasporto simulato');
    } });
    await assert.rejects(s3.inizializza(), /backup_non_disponibile/);
    assert.equal(chiamate, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restic: restore fallito elimina i dump o segnala la pulizia incompleta senza percorsi', async t => {
  for (const caso of ['normale', 'directory non scrivibile', 'rimozione fallita']) await t.test(caso, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restic-cleanup-'));
    let destinazione;
    const rm = fs.rmSync;
    if (caso === 'rimozione fallita') t.mock.method(fs, 'rmSync', (p, ...args) => {
      if (p === destinazione) throw Object.assign(new Error('errore filesystem sintetico: ' + p), { path: p });
      return rm(p, ...args);
    });
    const f = resticSimulato(args => ({ code: 1, azioni() {
      destinazione = args[args.indexOf('--target') + 1];
      fs.writeFileSync(path.join(destinazione, 'database.dump'), 'dump-sintetico');
      if (caso === 'directory non scrivibile') fs.chmodSync(destinazione, 0o500);
    } }));
    try {
      await assert.rejects(f.repo.ripristina('a'.repeat(64), dir), e =>
        e.message === 'backup_non_disponibile' && !e.path && !e.cause
        && !!e.cleanupIncompleto === (caso === 'rimozione fallita'));
      assert.equal(fs.existsSync(destinazione), caso === 'rimozione fallita');
      assert.equal(f.chiamate.length, 1);
    } finally {
      t.mock.restoreAll();
      if (destinazione && fs.existsSync(destinazione)) fs.chmodSync(destinazione, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('restic: piano da 2500 snapshot con reasons supera 1 MiB e resta valido', async () => {
  const piano = pianoSintetico(2500), output = JSON.stringify(piano);
  assert.equal(piano[0].reasons.length, 2500);
  assert.ok(Buffer.byteLength(output) > MiB && Buffer.byteLength(output) < 16 * MiB);
  const f = resticSimulato([{ output }]);
  assert.deepEqual(await f.repo.retention('journal', { snapshot: piano[0].keep[0].id }),
    { dryRun: true, conservate: 2500, eliminate: 0, eliminabili: 0 });
  assert.equal(f.chiamate.length, 1); assert.deepEqual(f.processi[0].segnali, []);
});

test('restic: hardcap 10000 snapshot conta tutti i gruppi, keep e remove', async t => {
  await t.test('10000 sono ammessi', async () => {
    const piano = pianoSintetico(10000), f = resticSimulato([{ output: JSON.stringify(piano) }]);
    assert.equal((await f.repo.retention('journal', { snapshot: piano[0].keep[0].id })).conservate, 10000);
  });
  for (const variante of ['gruppi', 'keep+remove']) await t.test('10001 rifiutati: ' + variante, async () => {
    const piano = pianoSintetico(5000, variante === 'keep+remove' ? 5001 : 0);
    if (variante === 'gruppi') {
      const gruppo = pianoSintetico(10001)[0];
      piano[0].keep = gruppo.keep.slice(0, 5000); piano[0].reasons = gruppo.reasons.slice(0, 5000);
      piano.push({ ...gruppo, keep: gruppo.keep.slice(5000), reasons: gruppo.reasons.slice(5000) });
    }
    const f = resticSimulato([{ output: JSON.stringify(piano) }]);
    await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }),
      /backup_retention_non_sicura/);
    assert.equal(f.chiamate.length, 1);
  });
});

test('restic: piano esattamente 16 MiB ammesso, un byte in più rifiutato', async t => {
  const piano = pianoSintetico(), json = Buffer.from(JSON.stringify(piano));
  for (const extra of [0, 1]) await t.test('16 MiB + ' + extra, async () => {
    const output = Buffer.alloc(16 * MiB + extra, ' '); json.copy(output);
    const f = resticSimulato([{ output }, {}, {}]);
    const esito = f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id });
    if (extra) await assert.rejects(esito, /backup_non_disponibile/);
    else assert.equal((await esito).conservate, 1);
    assert.equal(f.chiamate.length, extra ? 1 : 3);
  });
});

test('restic: dopo overflow ignora nuovi chunk anche se più piccoli', async t => {
  const tardivo = Buffer.from('non-acquisire'), letture = [];
  t.mock.method(tardivo, 'toString', () => { letture.push('decode'); return 'non-acquisire'; });
  t.mock.method(tardivo, 'copy', () => { letture.push('copy'); return tardivo.length; });
  const f = resticSimulato([{ azioni(child) {
    child.stdout.write(Buffer.alloc(16 * MiB + 1));
    child.stdout.write(tardivo);
    child.stdout.write(Buffer.alloc(16 * MiB + 1));
  } }]);
  await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: 'a'.repeat(64) }), /backup_non_disponibile/);
  assert.deepEqual(letture, []); assert.deepEqual(f.processi[0].segnali, ['SIGTERM']);
  assert.equal(f.chiamate.length, 1);
});

test('restic: gli altri comandi mantengono il budget di 1 MiB', async t => {
  for (const comando of ['inizializza', 'identita']) for (const extra of [0, 1]) {
    await t.test(comando + ': 1 MiB + ' + extra, async () => {
      const output = Buffer.alloc(MiB + extra, ' ');
      if (comando === 'identita') Buffer.from(JSON.stringify({ id: 'a'.repeat(64) })).copy(output);
      const f = resticSimulato([{ output }]), esito = f.repo[comando]();
      if (extra) await assert.rejects(esito, /backup_non_disponibile/);
      else assert.deepEqual(await esito, comando === 'identita' ? 'a'.repeat(64) : { ok: true });
    });
  }
});

test('restic: UTF-8 spezzato viene decodificato alla fine, stderr viene drenato', async t => {
  const piano = pianoSintetico();
  piano[0].keep[0].username = 'sintetico-è-😀-終';
  const output = JSON.stringify(piano), bytes = Buffer.from(output), inputJSON = [];
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (input, ...args) => { inputJSON.push(input); return parse(input, ...args); });
  const f = resticSimulato([{ stderr: 'diagnostica-sintetica'.repeat(100000), azioni(child) {
    for (let i = 0; i < bytes.length; i++) child.stdout.write(bytes.subarray(i, i + 1));
  } }]);
  assert.equal((await f.repo.retention('journal', { snapshot: piano[0].keep[0].id })).conservate, 1);
  assert.deepEqual(inputJSON, [output]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.processi[0].stderr.readableLength, 0);
});

test('restic: timeout non riapre il buffer, escalation e cleanup restano attivi', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const tardivo = Buffer.from('non-acquisire'), letture = [];
  t.mock.method(tardivo, 'toString', () => { letture.push('decode'); return 'non-acquisire'; });
  t.mock.method(tardivo, 'copy', () => { letture.push('copy'); return tardivo.length; });
  const f = resticSimulato([{ azioni(child) {
    child.stdout.write(Buffer.from('{'));
    t.mock.timers.tick(120000); child.stdout.write(tardivo);
    t.mock.timers.tick(5000);
  } }]);
  await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: 'a'.repeat(64) }), /backup_non_disponibile/);
  assert.deepEqual(letture, []); assert.deepEqual(f.processi[0].segnali, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(125000);
  assert.deepEqual(f.processi[0].segnali, ['SIGTERM', 'SIGKILL']); assert.equal(f.chiamate.length, 1);
});

test('restic: applicazione in batch da 1000 usa solo ID approvati dopo il check', async () => {
  const piano = pianoConRimozioni(2501);
  const f = resticSimulato([{ output: JSON.stringify(piano) }, {}, {}, {}, {}, {}]);
  assert.equal((await f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id })).eliminate, 2501);
  assert.deepEqual(f.chiamate[1], ['--no-cache', 'check', '--read-data']);
  const batches = f.chiamate.slice(2, -1);
  assert.deepEqual(batches.map(args => args.length - 2), [1000, 1000, 501]);
  for (const args of batches) assert.deepEqual(args.slice(0, 2), ['--no-cache', 'forget']);
  assert.deepEqual(batches.flatMap(args => args.slice(2)), piano[0].remove.map(s => s.id));
  assert.ok(!batches.some(args => args.includes(piano[0].keep[0].id)));
  assert.deepEqual(f.chiamate.at(-1), ['--no-cache', 'prune']);
});

test('restic: secondo batch fallito interrompe senza esito di successo', async () => {
  const piano = pianoConRimozioni(2501);
  const f = resticSimulato([{ output: JSON.stringify(piano) }, {}, {}, { code: 3, stderr: 'diagnostica-sintetica' }, {}]);
  await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }),
    e => e.message === 'backup_non_disponibile');
  assert.equal(f.chiamate.length, 4);
  assert.deepEqual(f.chiamate[2].slice(2), piano[0].remove.slice(0, 1000).map(s => s.id));
  assert.deepEqual(f.chiamate[3].slice(2), piano[0].remove.slice(1000, 2000).map(s => s.id));
  assert.ok(!f.chiamate.some(args => args[1] === 'prune'));
});

test('restic: applicazione senza remove esegue check e prune per entrambe le categorie', async t => {
  for (const categoria of ['journal', 'database']) await t.test(categoria, async () => {
    const piano = pianoSintetico();
    if (categoria === 'database') {
      piano[0].paths = ['/database.dump']; piano[0].tags = ['database'];
      piano[0].keep[0].paths = ['/database.dump']; piano[0].keep[0].tags = ['database'];
    }
    const f = resticSimulato([{ output: JSON.stringify(piano) }, {}, {}]);
    assert.deepEqual(await f.repo.retention(categoria, { dryRun: false, snapshot: piano[0].keep[0].id }),
      { dryRun: false, conservate: 1, eliminate: 0, eliminabili: 0 });
    assert.equal(f.chiamate.length, 3);
    assert.deepEqual(f.chiamate[1], ['--no-cache', 'check', '--read-data']);
    assert.deepEqual(f.chiamate[2], ['--no-cache', 'prune']);
  });
  await t.test('check fallito non chiama prune', async () => {
    const piano = pianoSintetico(), f = resticSimulato([{ output: JSON.stringify(piano) }, { code: 1 }]);
    await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }), /backup_non_disponibile/);
    assert.equal(f.chiamate.length, 2);
  });
});

test('restic: dry-run senza o con remove non chiama check, forget applicato o prune', async t => {
  for (const rimozioni of [0, 1501]) await t.test('remove: ' + rimozioni, async () => {
    const piano = pianoConRimozioni(rimozioni), f = resticSimulato([{ output: JSON.stringify(piano) }]);
    assert.deepEqual(await f.repo.retention('journal', { snapshot: piano[0].keep[0].id }),
      { dryRun: true, conservate: 1, eliminate: 0, eliminabili: rimozioni });
    assert.equal(f.chiamate.length, 1); assert.ok(f.chiamate[0].includes('--dry-run'));
  });
});

test('restic e worker: dopo forget il retry senza remove resta pending finché prune riesce', async t => {
  const piano = pianoConRimozioni(1), snapshot = piano[0].keep[0].id;
  let rimosso = false, tentativiPrune = 0, pruneRiuscito = false, pending = true, pulizie = 0;
  const eventi = [], esiti = [];
  const prune = () => {
    tentativiPrune++;
    const code = tentativiPrune <= 2 ? 1 : 0;
    pruneRiuscito = code === 0;
    eventi.push(pruneRiuscito ? 'prune:ok' : 'prune:errore');
    return { code, stderr: code ? 'errore-prune-sintetico' : undefined };
  };
  const f = resticSimulato(args => {
    const comando = args[1];
    eventi.push('restic:' + comando);
    if (comando === 'cat') return { output: JSON.stringify({ id: 'a'.repeat(64) }) };
    if (comando === 'check') return {};
    if (comando === 'prune') return prune();
    assert.equal(comando, 'forget');
    if (args.includes('--dry-run')) return { output: JSON.stringify([{ ...piano[0], remove: rimosso ? [] : piano[0].remove }]) };
    rimosso = true;
    // Riproduce anche il comportamento precedente: forget riuscito, prune fallito.
    return args.includes('--prune') ? prune() : {};
  });
  const pool = { async query(query, args = []) {
    const funzione = query.match(/^SELECT amr_backup\.(\w+)\(/)?.[1];
    eventi.push('sql:' + funzione);
    let risultato;
    switch (funzione) {
      case 'programma_database': case 'configura': risultato = true; break;
      case 'claim': risultato = null; break;
      case 'retention_pending': risultato = pending ? [{ categoria: 'journal', snapshot }] : []; break;
      case 'esito_retention': esiti.push([...args]); pending = args[2]; risultato = true; break;
      case 'pulisci': pulizie++; risultato = true; break;
      default: assert.fail('SQL inatteso nel pool sintetico: ' + funzione);
    }
    return { rows: [{ risultato }] };
  } };
  const worker = creaBackupPostgres({ pool, repositoryJournal: f.repo,
    repositoryDatabase: { identita: async () => 'b'.repeat(64) },
    dumpDatabase: () => assert.fail('nessun dump nel test retention'), applicaRetention: true });
  t.after(() => worker.stop());
  for (let i = 1; i <= 2; i++) {
    assert.equal((await worker.drain()).ok, true);
    assert.equal(rimosso, true);
    assert.deepEqual({ pending, pulizie, pruneRiuscito }, { pending: true, pulizie: 0, pruneRiuscito: false });
    assert.equal(tentativiPrune, i);
    assert.deepEqual(esiti.at(-1), ['journal', snapshot, true]);
  }
  assert.equal((await worker.drain()).ok, true);
  assert.equal(tentativiPrune, 3); assert.equal(pruneRiuscito, true);
  assert.equal(pending, false); assert.equal(pulizie, 1);
  assert.deepEqual(esiti.at(-1), ['journal', snapshot, false]);
  assert.ok(eventi.indexOf('prune:ok') < eventi.lastIndexOf('sql:esito_retention'));
  assert.ok(eventi.lastIndexOf('sql:esito_retention') < eventi.indexOf('sql:pulisci'));
  assert.equal(f.chiamate.filter(args => args[1] === 'check').length, 3);
  assert.equal(f.chiamate.filter(args => args[1] === 'forget' && !args.includes('--dry-run')).length, 1);
  assert.equal((await worker.drain()).ok, true);
  assert.equal(tentativiPrune, 3); assert.equal(pulizie, 1); assert.equal(esiti.length, 3);
});

test('restic: valida tutto il piano prima di check o eliminazioni', async t => {
  const invalidazioni = {
    id: s => { s.id = 'non-valido'; }, host: s => { s.hostname = 'altro'; },
    path: s => { s.paths = ['/database.dump']; }, tag: s => { s.tags = ['database']; },
    tempo: s => { s.time = 'non-valido'; }, recente: s => { s.time = '2026-09-30T00:00:00Z'; }
  };
  for (const [nome, invalida] of Object.entries(invalidazioni)) await t.test(nome, async () => {
    const piano = pianoConRimozioni(1501); invalida(piano[0].remove.at(-1));
    const f = resticSimulato([{ output: JSON.stringify(piano) }]);
    await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }),
      /backup_retention_non_sicura/);
    assert.equal(f.chiamate.length, 1);
  });
  await t.test('duplicati', async () => {
    const piano = pianoConRimozioni(1501); piano[0].remove.at(-1).id = piano[0].remove[0].id;
    const f = resticSimulato([{ output: JSON.stringify(piano) }]);
    await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }),
      /backup_retention_non_sicura/);
    assert.equal(f.chiamate.length, 1);
  });
  await t.test('JSON troncato', async () => {
    const piano = pianoSintetico(), f = resticSimulato([{ output: JSON.stringify(piano).slice(0, -1) }]);
    await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }), /backup_non_disponibile/);
    assert.equal(f.chiamate.length, 1);
  });
  await t.test('check fallito', async () => {
    const piano = pianoConRimozioni(1501), f = resticSimulato([{ output: JSON.stringify(piano) }, { code: 1 }]);
    await assert.rejects(f.repo.retention('journal', { dryRun: false, snapshot: piano[0].keep[0].id }), /backup_non_disponibile/);
    assert.equal(f.chiamate.length, 2);
  });
});

test('restic reale: il repository con symlink/.. segue la normalizzazione del backend',
  { skip: !process.env.AMR_TEST_RESTIC && 'Impostare AMR_TEST_RESTIC al binario verificato' }, async t => {
    for (const prefisso of ['', 'local:']) await t.test(prefisso || 'senza prefisso', async t => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restic-normalizza-'));
      t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
      const fisico = path.join(dir, 'fisico'), links = path.join(dir, 'links');
      fs.mkdirSync(path.join(fisico, 'interna'), { recursive: true }); fs.mkdirSync(links);
      fs.symlinkSync(path.join(fisico, 'interna'), path.join(links, 'interna'));
      const interno = path.join(links, 'password'), esterno = path.join(fisico, 'password');
      for (const file of [interno, esterno]) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      const crea = password => creaRestic({ binario: process.env.AMR_TEST_RESTIC, ambiente: {
        RESTIC_REPOSITORY: prefisso + path.join(links, 'interna') + '/..', RESTIC_PASSWORD_FILE: password } });
      assert.throws(() => crea(interno), /backup_non_configurato/);
      const repo = crea(esterno);
      await repo.inizializza(); await repo.copia(Buffer.from('sintetico'), 'journal'); await repo.verifica();
      assert.equal(fs.existsSync(path.join(links, 'config')), true);
      assert.equal(fs.existsSync(path.join(fisico, 'config')), false);
    });
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

test('restic reale: snapshot illeggibile con exit 0 non produce discovery parziale',
  { skip: !process.env.AMR_TEST_RESTIC && 'Impostare AMR_TEST_RESTIC al binario verificato' }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-restic-discovery-'));
    fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const password = path.join(dir, 'password'), location = path.join(dir, 'repository');
    fs.writeFileSync(password, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const ambiente = { RESTIC_REPOSITORY: location, RESTIC_PASSWORD_FILE: password };
    const repo = creaRestic({ binario: process.env.AMR_TEST_RESTIC, ambiente });
    await repo.inizializza();
    const one = await repo.copia(Buffer.from('{"versione":1,"sintetico":1}'), 'journal');
    const two = await repo.copia(Buffer.from('{"versione":1,"sintetico":2}'), 'journal');
    assert.equal((await repo.elenca('journal')).length, 2);
    const file = path.join(location, 'snapshots', one.snapshot), original = fs.readFileSync(file);
    const mode = fs.statSync(file).mode & 0o777;
    fs.chmodSync(file, mode | 0o200);
    try {
      // Corrompere soltanto un file appena creato nella fixture privata,
      // conservando i byte originali per ripristinarlo prima del cleanup.
      fs.writeFileSync(file, Buffer.from('snapshot sintetico illeggibile'));
      const { execFile } = require('node:child_process');
      const raw = await new Promise((resolve, reject) => execFile(process.env.AMR_TEST_RESTIC,
        ['--no-cache', 'snapshots', '--json', '--host', 'amr-centro', '--path', '/operazioni.json', '--tag', 'journal'],
        { env: { PATH: process.env.PATH, LANG: 'C', TZ: 'UTC', ...ambiente }, timeout: 120000, maxBuffer: 65536 },
        (e, stdout, stderr) => e ? reject(new Error('restic_sintetico_non_confermato'))
          : resolve({ code: 0, stdout, diagnostica: stderr.length > 0 })));
      assert.equal(raw.code, 0); assert.equal(raw.diagnostica, true);
      assert.deepEqual(JSON.parse(raw.stdout).map(s => s.id), [two.snapshot]);
      await assert.rejects(repo.elenca('journal'), /backup_non_disponibile/);
    } finally {
      try { fs.writeFileSync(file, original); }
      finally { original.fill(0); fs.chmodSync(file, mode); }
    }
    assert.equal((await repo.elenca('journal')).length, 2);
    await repo.verifica();
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
      const protetto = await repo.retention(categoria, { dryRun: false, snapshot: ids[0] });
      assert.equal(protetto.conservate, piano.conservate + 1);
      assert.equal(protetto.eliminate, piano.eliminabili - 1);
      await repo.ripristina(ids[0], dir);
      const applied = await repo.retention(categoria, { ...opts,dryRun:false });
      assert.equal(applied.eliminate,1);
      await assert.rejects(repo.ripristina(ids[0],dir), /backup_non_disponibile/);
      const restored = await repo.ripristina(ids.at(-1),dir);
      assert.equal(fs.readFileSync(path.join(restored,categoria === 'journal' ? 'operazioni.json' : 'database.dump'),'utf8'), 'sintetico-0');
      await repo.ripristina(estranea.snapshot,dir); await repo.verifica();
    }
  });


test('B06: protegge il marker scaduto dopo la validazione, senza dimenticare altri vincoli', async t => {
  for (const categoria of ['journal', 'database']) await t.test(categoria, async () => {
    const piano = pianoConRimozioni(2);
    if (categoria === 'database') for (const s of [...piano[0].keep, ...piano[0].remove]) {
      s.paths = ['/database.dump']; s.tags = ['database'];
      s.time = piano[0].keep[0].time;
    }
    const marker = piano[0].remove[0].id;
    const f = resticSimulato([{ output: JSON.stringify(piano) }, {}, {}, {}]);
    assert.deepEqual(await f.repo.retention(categoria, { dryRun: false, snapshot: marker }),
      { dryRun: false, conservate: 2, eliminate: 1, eliminabili: 1 });
    assert.deepEqual(f.chiamate[2].slice(2), [piano[0].remove[1].id]);
    for (const vizio of ['categoria', 'duplicato', 'assente', 'check']) {
      const bad = structuredClone(piano);
      if (vizio === 'categoria') bad[0].remove[0].tags = ['estranea'];
      if (vizio === 'duplicato') bad[0].keep.push(bad[0].remove[0]);
      const g = resticSimulato([{ output: JSON.stringify(bad) }, { code: vizio === 'check' ? 3 : 0 }]);
      await assert.rejects(g.repo.retention(categoria, { dryRun: false,
        snapshot: vizio === 'assente' ? 'f'.repeat(64) : marker }), /backup_(retention_non_sicura|non_disponibile)/);
      assert.ok(!g.chiamate.some(args => args[1] === 'prune' || (args[1] === 'forget' && !args.includes('--dry-run'))));
    }
  });
});
