'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { supervisiona } = require('../backend/nodi/worker-supervisore');

function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-supervisore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const figli = [], timers = [], consegne = []; let now = 100000;
  const opzioni = { file: path.join(dir, 'worker.js'), cwd: dir,
    env: { USER_DATA_PATH: dir, AMR_CENTRO_URL: 'http://127.0.0.1:1234',
      AMR_NODO_ID: 'prova', AMR_NODI_TOKEN: 'sintetico' },
    ora: () => now, mono: () => now, random: () => 0,
    timer(fn, ms) { const x = { fn, ms, cleared: false, unref() {} }; timers.push(x); return x; },
    cancella(x) { if (x) x.cleared = true; },
    invia: async (_u, o) => { consegne.push(JSON.parse(o.body)); return { ok: true }; },
    spawn: (_exe, argv, opts) => {
      assert.equal(opts.shell, undefined); assert.deepEqual(argv, [path.join(dir, 'worker.js')]);
      const p = new EventEmitter(); p.segnali = []; p.kill = s => p.segnali.push(s); figli.push(p); return p;
    }, ...extra };
  const w = supervisiona(opzioni);
  const closeChild = (code, signal = null) => { const p = figli.at(-1); p.emit('exit', code, signal); p.emit('close', code, signal); };
  const prossimo = () => { const x = timers.find(x => !x.cleared); assert.ok(x); x.cleared = true; now += x.ms; x.fn(); return x.ms; };
  return { dir, w, figli, timers, consegne, closeChild, prossimo, avanti: ms => { now += ms; } };
}

test('supervisore: cinque restart crescenti, poi stop persistente; error non duplica exit/close', async t => {
  const f = fixture(t);
  for (let n = 0; n < 5; n++) {
    const p = f.figli.at(-1); p.emit('error', Object.assign(new Error('dati da non salvare'), { code: 'EPIPE' }));
    p.emit('exit', 1); assert.equal(f.figli.length, n + 1); assert.equal(f.timers.length, n + 1);
    p.emit('close', 1); p.emit('close', 1);
    assert.equal(f.w.stato.restart, n + 1); assert.equal(f.prossimo(), 1000 * 2 ** n);
  }
  f.closeChild(null, 'SIGKILL');
  assert.equal(f.figli.length, 6); assert.equal(f.w.terminato, true);
  assert.equal(f.w.stato.motivo, 'restart_esauriti');
  const file = path.join(f.dir, 'worker-supervisione.json');
  assert.equal(JSON.parse(fs.readFileSync(file)).motivo, 'restart_esauriti');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('sintetico'));
  await f.w.close(); assert.equal(JSON.parse(fs.readFileSync(file)).motivo, 'restart_esauriti');
});

test('supervisore: manual stop, revoca, incompatibilità e sostituzione non fanno restart', async t => {
  for (const [code, signal, motivo] of [[0, null, 'stop_manuale'], [null, 'SIGTERM', 'stop_manuale'],
    [null, 'SIGINT', 'stop_manuale'], [77, null, 'credenziale_revocata'],
    [78, null, 'configurazione_incompatibile'], [79, null, 'worker_sostituito']]) {
    const f = fixture(t); f.closeChild(code, signal);
    assert.equal(f.w.stato.motivo, motivo); assert.equal(f.timers.length, 0);
    assert.equal(f.figli.length, 1); assert.equal(f.w.terminato, true); await f.w.close();
  }
});

test('supervisore: stop durante backoff impedisce anche un callback già pronto', async t => {
  const f = fixture(t); f.closeChild(75); const restart = f.timers[0];
  await f.w.close(); assert.equal(restart.cleared, true);
  restart.fn(); assert.equal(f.figli.length, 1); assert.equal(f.w.stato.stato, 'fermato');
});

test('supervisore: arresto idempotente aspetta close e segnala solo il proprio figlio', async t => {
  const f = fixture(t); let risolto = false;
  const p = f.w.close().then(() => { risolto = true; }); f.w.close();
  assert.deepEqual(f.figli[0].segnali, ['SIGTERM']);
  f.figli[0].emit('error', new Error('kill fallito')); await Promise.resolve(); assert.equal(risolto, false);
  assert.equal(f.prossimo(), 5000); assert.deepEqual(f.figli[0].segnali, ['SIGTERM', 'SIGKILL']);
  f.closeChild(null, 'SIGKILL'); await p;
  assert.equal(f.figli.length, 1); assert.equal(f.w.terminato, true);
});

test('supervisore: successi brevi non resettano il budget, cinque minuti di heartbeat sì', t => {
  const f = fixture(t); f.closeChild(75); f.prossimo();
  const p = f.figli.at(-1); p.emit('message', { tipo: 'worker_attivo' });
  assert.equal(f.w.stato.restart, 1);
  f.avanti(300000); p.emit('message', { tipo: 'worker_attivo' }); // Una lunga assenza non è stabilità.
  assert.equal(f.w.stato.restart, 1);
  for (let n = 0; n < 60; n++) { f.avanti(5000); p.emit('message', { tipo: 'worker_attivo' }); }
  assert.equal(f.w.stato.restart, 0);
  f.closeChild(75); assert.equal(f.w.stato.restart, 1);
});

test('supervisore: errore spawn definitivo attende close, poi richiede intervento', async t => {
  const f = fixture(t); f.figli[0].emit('error', Object.assign(new Error('file'), { code: 'ENOENT' }));
  assert.equal(f.w.terminato, false); f.closeChild(-2);
  assert.equal(f.w.stato.motivo, 'configurazione_incompatibile'); assert.equal(f.timers.length, 0); await f.w.close();
});

test('supervisore: registro locale guasto impedisce l’avvio o ferma il figlio', async t => {
  const f = fixture(t);
  const terminali = []; f.w.eventi.on('fine', x => terminali.push(x));
  fs.renameSync(f.dir, f.dir + '-spostata');
  t.after(() => fs.rmSync(f.dir + '-spostata', { recursive: true, force: true }));
  f.figli[0].emit('message', { tipo: 'worker_attivo' });
  assert.equal(f.w.stato.motivo, 'registro_non_disponibile');
  assert.deepEqual(f.figli[0].segnali, ['SIGTERM']);
  const p = f.w.close(); assert.equal(f.timers.filter(x => x.ms === 5000).length, 1);
  f.closeChild(0); await p; assert.equal(f.figli.length, 1);
  assert.equal(terminali.length, 1); assert.equal(terminali[0].stato, 'intervento');
  assert.equal(terminali[0].motivo, 'registro_non_disponibile');
});

test('supervisore: pubblica solo stati tecnici; una consegna tardiva mantiene la sequenza', async t => {
  const f = fixture(t), boot = require('node:crypto').randomUUID();
  f.figli[0].emit('message', { tipo: 'worker_contesto', boot, epoca: 'centro' });
  f.figli[0].emit('message', { tipo: 'worker_attivo' });
  await new Promise(r => setImmediate(r));
  f.prossimo(); await new Promise(r => setImmediate(r));
  assert.ok(f.consegne.length >= 2);
  assert.equal(f.consegne.at(-1).stato, 'attivo'); assert.equal(f.consegne.at(-1).boot, boot);
  assert.ok(f.consegne.at(-1).sequenza > f.consegne[0].sequenza);
  assert.ok(f.consegne.every(x => !Object.hasOwn(x, 'env') && !Object.hasOwn(x, 'token')));
  f.closeChild(0); await f.w.close();
});

test('supervisore: collisione del file temporaneo non cancella un file preesistente', async t => {
  const f = fixture(t), crypto = require('node:crypto'), originale = crypto.randomUUID;
  const tmp = path.join(f.dir, 'worker-supervisione.json.tmp-preesistente'); fs.writeFileSync(tmp, 'TENERE');
  try {
    crypto.randomUUID = () => 'preesistente';
    f.figli[0].emit('message', { tipo: 'worker_attivo' });
  } finally { crypto.randomUUID = originale; }
  assert.equal(fs.readFileSync(tmp, 'utf8'), 'TENERE');
  assert.equal(f.w.stato.motivo, 'registro_non_disponibile');
  const p = f.w.close(); f.closeChild(0); await p;
});

test('supervisore: stop in coda a un invio precedente viene confermato prima della chiusura', async t => {
  let completa; const inviati = [];
  const f = fixture(t, { invia: async (_u, opts) => {
    const b = JSON.parse(opts.body); inviati.push(b);
    if (inviati.length === 1) await new Promise(r => { completa = r; });
    return { ok: true };
  } });
  f.figli[0].emit('message', { tipo: 'worker_contesto', epoca: 'centro', boot: require('node:crypto').randomUUID() });
  let finito = false; const close = f.w.close().then(() => { finito = true; });
  f.closeChild(0); await new Promise(r => setImmediate(r)); assert.equal(finito, false);
  completa(); await close;
  assert.deepEqual(inviati.map(x => x.stato), ['avvio', 'fermato']);
  const registro = JSON.parse(fs.readFileSync(path.join(f.dir, 'worker-supervisione.json')));
  assert.equal(registro.comunicazione.stato, 'accettato');
  assert.equal(registro.comunicazione.sequenza, inviati[1].sequenza);
  assert.equal(f.timers.filter(x => !x.cleared).length, 0);
});

test('supervisore: stop non confermato sopravvive al successivo avvio senza replay obsoleto', async t => {
  const f = fixture(t, { invia: async () => { throw new Error('centro assente'); } });
  f.figli[0].emit('message', { tipo: 'worker_contesto', epoca: 'centro', boot: require('node:crypto').randomUUID() });
  const p = f.w.close(); f.closeChild(0); await p;
  const registro = path.join(f.dir, 'worker-supervisione.json');
  assert.equal(JSON.parse(fs.readFileSync(registro)).comunicazione.stato, 'incerto');
  const figlio = new EventEmitter(); figlio.kill = () => {};
  const inviati = [];
  const nuovo = supervisiona({ file: path.join(f.dir, 'worker.js'), cwd: f.dir,
    env: { USER_DATA_PATH: f.dir }, spawn: () => figlio,
    invia: async (_u, opts) => { inviati.push(opts); return { ok: true }; } });
  const dopo = JSON.parse(fs.readFileSync(registro));
  assert.equal(dopo.precedentiNonConfermati[0].stato, 'fermato'); assert.equal(inviati.length, 0);
  const q = nuovo.close(); figlio.emit('exit', 0); await q;
});

test('supervisore: stop terminale autonomo scarica la coda senza close o timer di retry', async t => {
  let completa; const inviati = [];
  const f = fixture(t, { invia: async (_u, opts) => {
    inviati.push(JSON.parse(opts.body));
    if (inviati.length === 1) await new Promise(r => { completa = r; });
    return { ok: true };
  } });
  f.figli[0].emit('message', { tipo: 'worker_contesto', epoca: 'centro', boot: require('node:crypto').randomUUID() });
  f.closeChild(0); completa(); await new Promise(r => setImmediate(r));
  assert.deepEqual(inviati.map(x => x.stato), ['avvio', 'fermato']);
  await f.w.close(); assert.equal(inviati.length, 2);
});

test('supervisore: più stop non confermati sopravvivono senza sostituire quello precedente', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-stop-incerti-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'worker-supervisione.json'), boots = [];
  for (let n = 0; n < 3; n++) {
    const figlio = new EventEmitter(); figlio.kill = () => {};
    const w = supervisiona({ file: path.join(dir, 'worker.js'), cwd: dir,
      env: { USER_DATA_PATH: dir, AMR_CENTRO_URL: 'http://127.0.0.1:1234', AMR_NODO_ID: 'prova', AMR_NODI_TOKEN: 'sintetico' },
      spawn: () => figlio, invia: async () => { throw new Error('risposta persa'); } });
    const boot = require('node:crypto').randomUUID(); boots.push(boot);
    figlio.emit('message', { tipo: 'worker_contesto', epoca: 'centro', boot });
    const p = w.close(); figlio.emit('exit', 0); await p;
    const registro = JSON.parse(fs.readFileSync(file));
    assert.equal(registro.precedentiNonConfermati.length, n);
    assert.deepEqual(registro.precedentiNonConfermati.map(r => r.comunicazione.boot), boots.slice(0, n));
    assert.equal(registro.comunicazione.boot, boot);
  }
});

test('supervisore: ACK di un boot precedente non conferma il nuovo stato con la stessa sequenza', async t => {
  let completa;
  const f = fixture(t, { invia: () => new Promise(r => { completa = r; }) });
  const p = f.figli[0], crypto = require('node:crypto');
  p.emit('message', { tipo: 'worker_contesto', epoca: 'centro-a', boot: crypto.randomUUID() });
  p.emit('message', { tipo: 'worker_contesto', epoca: 'centro-b', boot: crypto.randomUUID() });
  completa({ ok: true }); await new Promise(r => setImmediate(r));
  const registro = JSON.parse(fs.readFileSync(path.join(f.dir, 'worker-supervisione.json')));
  assert.equal(registro.comunicazione.stato, 'pendente');
  assert.equal(registro.comunicazione.epoca, 'centro-b');
  // Nessun contesto nuovo viene inviato finché non termina quello vecchio.
  const close = f.w.close(); f.closeChild(0);
  await new Promise(r => setImmediate(r)); completa({ ok: true }); await close;
});

test('supervisore: guasto del registro dopo exit conclude con intervento, senza falso successo', async t => {
  const f = fixture(t), terminali = [];
  f.w.eventi.on('fine', x => terminali.push(x));
  fs.renameSync(f.dir, f.dir + '-spostata');
  t.after(() => fs.rmSync(f.dir + '-spostata', { recursive: true, force: true }));
  f.closeChild(75);
  assert.equal(f.w.stato.motivo, 'registro_non_disponibile');
  assert.equal(terminali.length, 1); assert.equal(terminali[0].stato, 'intervento');
  assert.equal(f.timers.length, 0); await f.w.close(); assert.equal(terminali.length, 1);
});

test('supervisore reale: crash SIGKILL riparte una volta e stop non crea orfani', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-supervisore-reale-'));
  let w; t.after(async () => { await w?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'worker.js');
  fs.writeFileSync(file, `const fs=require('node:fs'),p=require('node:path').join(process.env.USER_DATA_PATH,'avvii');
    const n=fs.existsSync(p)?Number(fs.readFileSync(p))+1:1;fs.writeFileSync(p,String(n));
    process.on('disconnect',()=>process.exit(0));
    if(n===1)process.kill(process.pid,'SIGKILL');else setInterval(()=>{},1000);`);
  w = supervisiona({ file, cwd: dir, env: { USER_DATA_PATH: dir }, attese: [10,20,30,40,50] });
  for (let n = 0; n < 100 && (!fs.existsSync(path.join(dir,'avvii')) || fs.readFileSync(path.join(dir,'avvii'),'utf8') !== '2'); n++) await new Promise(r => setTimeout(r,20));
  assert.equal(fs.readFileSync(path.join(dir,'avvii'),'utf8'), '2');
  const child = w.child; await w.close(); assert.notEqual(child.signalCode, null);
  assert.equal(w.terminato, true); assert.equal(fs.readFileSync(path.join(dir,'avvii'),'utf8'), '2');
});
