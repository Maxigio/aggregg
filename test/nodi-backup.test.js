'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const crypto = require('node:crypto');
const { creaBackupPostgres, creaDumpPostgres, creaStatoBackup } = require('../backend/nodi/backup-postgres-prova');
const snapshot = 'a'.repeat(64);

function fixture({ totale = 1, fallisce = false, retentionFallisce = false } = {}) {
  const jobs = Array.from({ length: totale }, (_, i) => ({ id: 'journal:' + crypto.randomUUID(),
    categoria: 'journal', lease: crypto.randomUUID(), journal: { versione: 1,
      confermata_il: new Date(Date.now() - 1000).toISOString(), azienda: { id: 'sintetica' }, indice: i } }));
  const chiamate = [], buffers = [], manutenzione = new Map();
  const pool = { async query(q, args) {
    const fn = q.match(/amr_backup\.(\w+)/)[1]; chiamate.push({ fn, args });
    let risultato;
    if (fn === 'claim') risultato = jobs.shift() || null;
    else if (fn === 'completa') { risultato = true; manutenzione.set('journal', snapshot); }
    else if (fn === 'fallisce') risultato = true;
    else if (fn === 'retention_pending') risultato = [...manutenzione].map(([categoria,snapshot]) => ({categoria,snapshot}));
    else if (fn === 'esito_retention' && !args[2]) manutenzione.delete(args[0]);
    return { rows: [{ risultato }] };
  } };
  const repo = { identita: async () => 'b'.repeat(64), async copia(data, categoria, opts) {
    buffers.push(data); assert.equal(categoria, 'journal'); assert.ok(opts.data);
    if (fallisce) throw new Error('segreto-sintetico');
    return { snapshot };
  }, async retention(_, opts) {
    assert.equal(opts.dryRun, true);
    if (retentionFallisce) throw new Error('segreto-sintetico');
  } };
  const worker = creaBackupPostgres({ pool, repositoryJournal: repo,
    repositoryDatabase: { ...repo, identita: async () => 'c'.repeat(64) },
    dumpDatabase: async () => Buffer.from('PGDMP-sintetico'), batch: 2, intervalloMs: 10 });
  return { worker, pool, jobs, chiamate, buffers, manutenzione, repo };
}

test('backup: batch limitato, drain serializzato, buffer azzerati dopo copia e CAS', async () => {
  const f = fixture({ totale: 3 });
  const a = f.worker.drain(), b = f.worker.drain(); assert.equal(a, b);
  assert.deepEqual(await a, { ok: true, completate: 2, fallite: 0 });
  assert.equal(f.jobs.length, 1); assert.equal(f.chiamate.filter(c => c.fn === 'claim').length, 2);
  assert.ok(f.buffers.every(b => b.every(v => v === 0)));
  await f.worker.drain(); assert.equal(f.jobs.length, 0);
});
test('backup: errore copia isolato, nessun complete e codice persistito senza dettagli', async () => {
  const f = fixture({ fallisce: true });
  assert.deepEqual(await f.worker.drain(), { ok: true, completate: 0, fallite: 1 });
  const fallimento = f.chiamate.find(c => c.fn === 'fallisce');
  assert.equal(fallimento.args[2], 'backup_non_disponibile');
  assert.ok(!f.chiamate.some(c => c.fn === 'completa'));
  assert.ok(f.buffers[0].every(v => v === 0));
});
test('backup: configurazione assente e repository uguali non copiano né completano', async () => {
  for (const stessaDestinazione of [false, true]) {
    const f = fixture();
    const repo = { identita: async () => snapshot, copia: async () => assert.fail('non deve copiare') };
    const worker = creaBackupPostgres({ pool: f.pool, ...(stessaDestinazione ? {
      repositoryJournal: repo, repositoryDatabase: repo, dumpDatabase: async () => Buffer.from('PGDMP') } : {}) });
    await worker.drain();
    assert.equal(f.chiamate.find(c => c.fn === 'fallisce').args[2],
      stessaDestinazione ? 'backup_non_disponibile' : 'backup_non_configurato');
  }
});
test('backup: retention fallita resta pending e viene riprovata senza nuove operazioni', async () => {
  const f = fixture({ retentionFallisce: true }); await f.worker.drain();
  assert.equal(f.manutenzione.size, 1); await f.worker.drain();
  assert.equal(f.chiamate.filter(c => c.fn === 'esito_retention').length, 2);
  assert.ok(!f.chiamate.some(c => c.fn === 'pulisci'));
});
test('backup: repository DB o dump indisponibile non bloccano il journal indipendente', async () => {
  for (const dumpFallisce of [false,true]) {
    const f = fixture();
    f.jobs.push({id:'database:sintetico',categoria:'database',lease:crypto.randomUUID()});
    const worker = creaBackupPostgres({pool:f.pool,repositoryJournal:f.repo,
      repositoryDatabase:{identita:async()=>{if(!dumpFallisce)throw new Error('offline');return 'd'.repeat(64);}},
      dumpDatabase:async()=>{throw new Error('dump indisponibile');},batch:2});
    assert.deepEqual(await worker.drain(),{ok:true,completate:1,fallite:1});
    assert.ok(f.chiamate.some(c=>c.fn==='completa' && c.args[0].startsWith('journal:')));
  }
});
test('backup: start/stop espliciti, segnali coalescenti e nessuna attività prima dello start', async () => {
  const f = fixture(); f.worker.segnalaOperazione();
  await new Promise(r => setImmediate(r)); assert.equal(f.chiamate.length, 0);
  f.worker.start(); f.worker.start(); f.worker.segnalaOperazione(); f.worker.segnalaOperazione();
  await new Promise(r => setTimeout(r, 25)); await f.worker.stop();
  const n = f.chiamate.length; f.worker.segnalaOperazione();
  await new Promise(r => setTimeout(r, 25)); assert.equal(f.chiamate.length, n);
});
test('backup: lease perso non dichiara completamento; guasto DB resta codice neutro', async () => {
  const f = fixture(), query = f.pool.query;
  f.pool.query = async (q, args) => q.includes('.completa(') ? { rows: [{ risultato: false }] } : query(q,args);
  assert.equal((await f.worker.drain()).completate, 0);
  f.pool.query = async () => { throw new Error('dsn-segreto-sintetico'); };
  assert.deepEqual(await f.worker.drain(), { ok: false, completate: 0, fallite: 0, codice: 'backup_non_disponibile' });
});
test('backup stato: identità solo server, errori PostgreSQL mai propagati', async () => {
  const s = { persona: crypto.randomUUID(), epoca: 2, mfa: true };
  const api = creaStatoBackup({ pool: { async query(_, args) {
    assert.deepEqual(args, [s.persona,2,true]); throw Object.assign(new Error('password-sintetica'), { code: 'XX000' });
  } } });
  await assert.rejects(api.stato({ ...s, mfa: false }), e => e.codice === 'accesso_non_autorizzato');
  await assert.rejects(api.stato(s), e => e.message === 'backup_non_disponibile' && !e.cause);
});
test('pg_dump: formato custom, ambiente dedicato, limite buffer e nessun raw error', async () => {
  for (const caso of ['ok','troppo','errore','formato']) {
    let opzioni;
    const dump = creaDumpPostgres({ binario: '/synthetic/pg_dump', ambiente: { PGDATABASE: 'prova' }, maxBytes: 16,
      spawnProcesso: (cmd, args, opts) => {
        assert.equal(cmd, '/synthetic/pg_dump'); assert.ok(args.includes('--format=custom')); opzioni = opts;
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => true;
        queueMicrotask(() => {
          child.stderr.write('credenziale-sintetica');
          child.stdout.write(Buffer.from(caso === 'troppo' ? 'PGDMP' + 'x'.repeat(32) : caso === 'formato' ? 'altro' : 'PGDMP-ok'));
          child.emit('close', caso === 'errore' ? 1 : 0);
        });
        return child;
      } });
    if (caso === 'ok') { const b = await dump(); assert.equal(b.toString(), 'PGDMP-ok'); b.fill(0); }
    else await assert.rejects(dump(), e => e.message === 'backup_non_disponibile');
    assert.equal(opzioni.env.PGDATABASE, 'prova'); assert.ok(!opzioni.env.HOME); assert.ok(!opzioni.env.PGPASSWORD);
  }
  assert.throws(() => creaDumpPostgres({ binario: '/pg_dump', ambiente: { PGDATABASE: 'x', PGPASSWORD: 'non-leggere' } }), /backup_non_configurato/);
});
