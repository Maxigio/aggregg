'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const salute = require('../backend/fonti-salute');
const { eseguiSonda, parametri } = require('../backend/nodi/sonde-fonti');
const { creaCentro } = require('../backend/nodi/centro');
const now = Date.now, envData = process.env.USER_DATA_PATH;
let dir;
afterEach(() => {
  Date.now = now; salute._reset();
  if (envData === undefined) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = envData;
  if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null;
});
function ambiente() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-sonde-'));
  process.env.USER_DATA_PATH = dir; salute._reset(); salute.abilitaSonde();
  let t = 2000000000000; Date.now = () => t;
  return { scadi: f => { t = salute.fermo(f).fino + 1; }, avanti: ms => { t += ms; } };
}

test('sonde: scadenza riservata alla sonda, una sola prova; vuoto valido riapre', async () => {
  const tempo = ambiente(); salute.erroreHttp('subito', 429); tempo.scadi('subito');
  assert.equal(salute.fermo('subito').fermo, true);
  await assert.rejects(salute.richiesta('subito', () => assert.fail('ricerca ordinaria durante verifica')), { code: 'FONTE_IN_PAUSA' });
  let completa;
  const prima = salute.sonda('subito', () => new Promise(r => { completa = r; }));
  await assert.rejects(salute.sonda('subito', () => assert.fail('seconda sonda')), { code: 'FONTE_IN_PAUSA' });
  assert.equal(salute.fermo('subito').proveFatte, 1);
  completa([]); await prima;
  assert.equal(salute.fermo('subito').fermo, false);
  salute._reset(); salute.abilitaSonde(); assert.equal(salute.fermo('subito').fermo, false);
});

test('sonde: cinque tentativi persistenti, scala 429 e nessuna sesta chiamata', async () => {
  const tempo = ambiente(); salute.erroreHttp('subito', 429);
  let chiamate = 0;
  for (let i = 1; i <= 5; i++) {
    tempo.scadi('subito');
    await assert.rejects(salute.sonda('subito', async () => {
      chiamate++; throw salute.erroreHttp('subito', 429);
    }), { status: 429 });
    assert.equal(salute.fermo('subito').proveFatte, i);
    assert.equal(salute.fermo('subito').fino - Date.now(), i === 1 ? salute.FINESTRE[1] : salute.FINESTRE[2]);
    salute._reset(); salute.abilitaSonde(); assert.equal(salute.fermo('subito').proveFatte, i);
  }
  tempo.scadi('subito');
  assert.equal(salute.fermo('subito').intervento, 'tentativi_esauriti');
  await assert.rejects(salute.sonda('subito', async () => { chiamate++; }), { code: 'FONTE_IN_PAUSA' });
  await assert.rejects(salute.richiesta('subito', async () => { chiamate++; }), { code: 'FONTE_IN_PAUSA' });
  assert.equal(chiamate, 5);
});

test('sonde: 403 sale una volta, timeout resta distanziato e Retry-After 503 prevale', async () => {
  const tempo = ambiente(); salute.erroreHttp('subito', 429); tempo.scadi('subito');
  const vietato = salute.erroreHttp('subito', 403);
  await assert.rejects(salute.sonda('subito', async () => { throw vietato; }));
  salute.registra('subito', { errore: vietato });
  assert.equal(salute.fermo('subito').fino - Date.now(), salute.FINESTRE[1]);
  tempo.scadi('subito');
  await assert.rejects(salute.sonda('subito', async () => { throw Object.assign(new Error('timeout'), { kind: 'transient' }); }));
  assert.equal(salute.fermo('subito').fino - Date.now(), salute.FINESTRE[0]);
  tempo.scadi('subito');
  await assert.rejects(salute.sonda('subito', async () => { throw salute.erroreHttp('subito', 503, { 'retry-after': '86400' }); }));
  assert.equal(salute.fermo('subito').fino - Date.now(), 86400000);
  salute._reset(); salute.abilitaSonde(); assert.equal(salute.fermo('subito').fino - Date.now(), 86400000);
});

test('sonde: credenziali e schema incompatibile chiedono subito intervento; errore locale non inventa un 429', async () => {
  for (const errore of [salute.erroreHttp('moto', 401), Object.assign(new Error('schema'), { code: 'FONTE_FORMATO' })]) {
    const tempo = ambiente(); salute.erroreHttp('moto', 429); tempo.scadi('moto');
    await assert.rejects(salute.sonda('moto', async () => { throw errore; }));
    const f = salute.fermo('moto'); assert.ok(f.intervento); assert.equal(f.verifica, false);
    const ultimo = salute.stato().fonti.find(x => x.fonte === 'moto').aggiornataIl;
    await assert.rejects(salute.richiesta('moto', async () => assert.fail('rete')), { code: 'FONTE_IN_PAUSA' });
    assert.equal(salute.stato().fonti.find(x => x.fonte === 'moto').aggiornataIl, ultimo);
    salute._reset(); salute.abilitaSonde(); assert.equal(salute.fermo('moto').intervento, f.intervento);
    fs.rmSync(dir, { recursive: true, force: true }); dir = null;
  }
});

test('sonde: ammissione persistita prima della rete; crash consuma la prova e conserva pausa', async () => {
  ambiente(); salute._reset();
  const script = `const s = require(${JSON.stringify(require.resolve('../backend/fonti-salute'))});
    let t = 2000000000000; Date.now = () => t; s.abilitaSonde();
    s.erroreHttp('subito', 429); t = s.fermo('subito').fino + 1;
    s.sonda('subito', () => { process.exit(0); });`;
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', script],
    { env: { USER_DATA_PATH: dir, PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  Date.now = () => 2000000000000 + salute.FINESTRE[0] + 1; salute.abilitaSonde();
  assert.equal(salute.fermo('subito').proveFatte, 1);
  assert.equal(salute.fermo('subito').fino - Date.now(), salute.FINESTRE[0]);
  assert.equal(salute.fermo('subito').fermo, true);
});

test('sonde: guasto della persistenza impedisce il download', async () => {
  ambiente(); process.env.USER_DATA_PATH = path.join(dir, 'inesistente'); salute._reset(); salute.abilitaSonde();
  salute.erroreHttp('subito', 429);
  Date.now = () => 2000000000000 + salute.FINESTRE[0] + 1;
  await assert.rejects(salute.sonda('subito', () => assert.fail('rete senza ammissione durabile')), { code: 'SONDA_PERSISTENZA' });
  assert.equal(salute.fermo('subito').intervento, 'persistenza');
});

test('sonde: risposta tardiva dopo annullamento non riapre né azzera il tentativo', async () => {
  const tempo = ambiente(), annullo = require('../backend/annullo');
  salute.erroreHttp('subito', 429); tempo.scadi('subito');
  const ctrl = new AbortController(); let completa;
  const p = annullo.dentro(ctrl.signal, () => salute.sonda('subito',
    () => new Promise(r => { completa = r; })));
  ctrl.abort(); completa([]); await assert.rejects(p, { name: 'AbortError' });
  assert.equal(salute.fermo('subito').proveFatte, 1);
  assert.equal(salute.fermo('subito').fino - Date.now(), salute.FINESTRE[0]);
  salute._reset(); salute.abilitaSonde(); assert.equal(salute.fermo('subito').proveFatte, 1);
});

test('sonde: crash alla quinta ammissione impedisce la sesta dopo riavvio', async () => {
  const tempo = ambiente(); salute.erroreHttp('subito', 429);
  for (let i = 0; i < 4; i++) {
    tempo.scadi('subito');
    await assert.rejects(salute.sonda('subito', async () => { throw new Error('timeout'); }));
  }
  tempo.scadi('subito'); const ts = Date.now(); salute._reset();
  const child = require('node:child_process').spawnSync(process.execPath, ['-e',
    `Date.now = () => ${ts}; const s = require(${JSON.stringify(require.resolve('../backend/fonti-salute'))});
    s.abilitaSonde(); s.sonda('subito', () => process.exit(0));`],
    { env: { USER_DATA_PATH: dir, PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr); salute.abilitaSonde();
  assert.equal(salute.fermo('subito').proveFatte, 5);
  assert.equal(salute.fermo('subito').intervento, 'tentativi_esauriti');
  await assert.rejects(salute.sonda('subito', () => assert.fail('sesta chiamata')));
});

test('sonde: quinta prova invalidata da un 429 concorrente ferma anche la sesta senza riavvio', async () => {
  const tempo = ambiente(); salute.erroreHttp('subito',429);
  for (let i=0;i<4;i++) {
    tempo.scadi('subito');
    await assert.rejects(salute.sonda('subito',async()=>{throw new Error('timeout');}));
  }
  tempo.scadi('subito');
  await salute.sonda('subito',async()=>{salute.erroreHttp('subito',429);return[];});
  assert.equal(salute.fermo('subito').proveFatte,5);
  assert.equal(salute.fermo('subito').intervento,'tentativi_esauriti');
  tempo.scadi('subito');
  await assert.rejects(salute.sonda('subito',()=>assert.fail('sesta chiamata')), {code:'FONTE_IN_PAUSA'});
});

test('sonde: query locali complete e una sola chiamata per fonte, nessun annuncio in esito', async t => {
  const tempo = ambiente(), sub = require('../backend/scrapers/subito-api');
  const moto = require('../backend/scrapers/motoit'), getMoto = moto._get;
  const https = require('node:https'), http = require('node:http'), request = https.request;
  let asCalls = 0, motoCalls = 0, subCalls = 0;
  let asBody = { data: { search: { listings: { listings: [], metadata: { totalItems: 0 } } } } };
  const server = http.createServer((req, res) => {
    asCalls++; let body = ''; req.on('data', x => { body += x; }); req.on('end', () => {
      const v = JSON.parse(body).variables.v;
      assert.equal(v.classification[0].make, 6); assert.equal(v.classification[0].model, 1611);
      assert.equal(v.classification[0].modelVersionInput, 'Veloce');
      res.end(JSON.stringify(asBody));
    });
  }).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { sub._setHttpGetJson(null); moto._get = getMoto; https.request = request;
    server.closeAllConnections(); await new Promise(r => server.close(r)); });
  https.request = (opts, cb) => http.request({ ...opts, host: '127.0.0.1', port: server.address().port }, cb);
  sub._setHttpGetJson(async raw => { subCalls++; const q = new URL(raw, 'https://fixture.invalid').searchParams;
    assert.equal(q.get('cm'), '000313'); assert.equal(q.get('q'), 'Veloce');
    assert.equal(q.get('lim'), '50'); assert.equal(q.get('start'), '0');
    return { status: 200, body: '{"ads":[],"count_all":0}' }; });
  moto._get = async raw => { motoCalls++; const u = new URL(raw);
    assert.equal(u.searchParams.get('model'), 'fantic-motor|caballero-500');
    assert.equal(u.pathname, '/moto-usate/ricerca');
    return { status: 200, body: '<div class="plist-head-title-info">0 annunci</div>' }; };
  assert.equal(parametri('moto').motoitSlugAmmessi.size, 6);
  for (const fonte of ['subito', 'autoscout', 'moto']) {
    salute.erroreHttp(fonte, 429); tempo.scadi(fonte);
    const esito = await eseguiSonda(fonte); assert.equal(esito.status, 200, JSON.stringify(esito));
    assert.deepEqual(Object.keys(esito.body).sort(), ['fonte','intervento','proveFatte','stato']);
    assert.equal(salute.fermo(fonte).fermo, false);
  }
  assert.deepEqual([subCalls, asCalls, motoCalls], [1, 1, 1]);
  salute.erroreHttp('autoscout', 429); tempo.scadi('autoscout');
  asBody = { errors: [{ message: 'backend timeout', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] };
  assert.equal((await eseguiSonda('autoscout')).status, 502);
  assert.equal(salute.fermo('autoscout').intervento || null, null, 'un errore di esecuzione non prova un cambio di schema');
  assert.equal(salute.fermo('autoscout').proveFatte, 1);
  tempo.scadi('autoscout'); asBody = { data: { search: { listings: null } } };
  assert.equal((await eseguiSonda('autoscout')).body.intervento, 'formato');

  salute.erroreHttp('subito', 429); tempo.scadi('subito');
  sub._setHttpGetJson(async () => ({ status: 200, body: '{}' }));
  assert.equal((await eseguiSonda('subito')).status, 200, 'ads assente resta vuoto per decisione di prodotto');
  salute.erroreHttp('subito', 429); tempo.scadi('subito');
  sub._setHttpGetJson(async () => { salute.erroreHttp('subito', 429);
    return { status: 200, body: '{"ads":[],"count_all":0}' }; });
  assert.equal((await eseguiSonda('subito')).body.stato, 'pausa', 'un altro blocco invalida la verifica e il suo falso successo');
  assert.equal(salute.fermo('subito').fermo, true);
});

async function centro(t) {
  const dati = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-centro-sonde-'));
  const c = creaCentro({ directory: dati, tokens: { a: 'a'.repeat(64), b: 'b'.repeat(64) }, adminLocale: true });
  const server = c.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { c.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dati, { recursive: true, force: true }); });
  const req = (route, body, id = 'a') => fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-amr-node-id': id, 'x-amr-node-token': id.repeat(64), 'x-amr-local-admin': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
  const fino = Date.now() - 1;
  const hb = (extra = {}, id = 'a') => req('/_nodo/heartbeat', { id, revisione: 'imac-1', occupato: false,
    sondeAutomatiche: true, fonti: { subito: { fermo: true, verifica: true, fino, proveFatte: 0 },
      autoscout: { fermo: false }, moto: { fermo: false } }, ...extra }, id);
  return { c, req, hb, poll: (id = 'a') => req('/_nodo/poll?id=' + id, undefined, id) };
}

test('centro: sonda autonoma senza utente, diagnostica senza risultati e heartbeat duplicato non ripete', async t => {
  const f = await centro(t); assert.equal((await f.hb()).status, 200);
  assert.equal(f.c.lavori.size, 1);
  const job = await (await f.poll()).json(); assert.equal(job.operazione, 'sonda'); assert.equal(job.fonte, 'subito');
  assert.deepEqual(job.input, { tipo: 'auto', marca: 'Alfa Romeo', modello: 'Giulietta', versione: 'Veloce' });
  await f.req('/_nodo/esito', { id: 'a', idLavoro: job.idLavoro, tentativo: job.tentativo,
    esito: { status: 200, body: { fonte: 'subito', stato: 'ok', proveFatte: 0, intervento: null } } });
  await new Promise(r => setImmediate(r)); await f.hb();
  assert.equal(f.c.lavori.size, 0, 'un heartbeat vecchio non è una nuova scadenza');
  const row = f.c.db.prepare('SELECT operazione,filtri,stato FROM lavori WHERE id=?').get(job.idLavoro);
  assert.equal(row.stato, 'concluso'); assert.ok(!row.filtri.includes('risultati'));
  assert.equal(f.c.db.prepare("SELECT count(*) n FROM eventi WHERE codice='sonda_riuscita'").get().n, 1);
});

test('centro: sospensioni, manutenzione, solo stato, simulato e intervento vietano la sonda', async t => {
  const f = await centro(t);
  for (const extra of [{ soloStato: true }, { simulato: true }, { occupato: true },
    { fonti: { subito: { fermo: true, verifica: false, intervento: 'credenziali' } } }]) {
    await f.hb(extra); assert.equal(f.c.lavori.size, 0);
  }
  await f.req('/api/admin/manutenzione', { manutenzione: true }); await f.hb();
  assert.equal(f.c.lavori.size, 0);
  await f.req('/api/admin/manutenzione', { manutenzione: false });
  await f.req('/api/admin/nodi/a', { sospeso: true, fonte: 'subito' }); await f.hb(); assert.equal(f.c.lavori.size, 0);
  await f.req('/api/admin/nodi/a', { sospeso: false, fonte: 'subito' }); await f.hb(); assert.equal(f.c.lavori.size, 1);
  await f.hb(); assert.equal(f.c.lavori.size, 1);
  await f.req('/api/admin/manutenzione', { manutenzione: true }); assert.equal(f.c.lavori.size, 0);
  await new Promise(r => setImmediate(r)); await f.req('/api/admin/manutenzione', { manutenzione: false });
  await f.hb(); assert.equal(f.c.lavori.size, 1, 'sonda mai consegnata può ripartire dopo manutenzione');
});

test('centro: sospensione dopo consegna lascia terminare la sonda e non anticipa il Retry-After', async t => {
  const f = await centro(t); await f.hb(); const job = await (await f.poll()).json();
  await f.req('/api/admin/nodi/a', { sospeso: true }); await f.req('/api/admin/manutenzione', { manutenzione: true });
  assert.equal((await f.req('/_nodo/esito', { id: 'a', idLavoro: job.idLavoro, tentativo: job.tentativo,
    esito: { status: 502, body: { fonte: 'subito', stato: 'errore', http: 429, proveFatte: 1, intervento: null } } })).status, 200);
  await f.hb({ fonti: { subito: { fermo: true, verifica: false, fino: Date.now() + 86400000 } } });
  assert.equal(f.c.lavori.size, 0);
});

test('sonde: percorso centro–worker reale con parser Hades simulato e riapertura notificata', async t => {
  const tempo = ambiente();salute.erroreHttp('subito',429);tempo.scadi('subito');
  const f=await centro(t), vm=require('node:vm'), processo=new (require('node:events').EventEmitter)();
  const sub=require('../backend/scrapers/subito-api');let calls=0;
  sub._setHttpGetJson(async()=>{calls++;return{status:200,body:'{"ads":[],"count_all":0}'};});
  t.after(()=>sub._setHttpGetJson(null));
  // La prima risposta autenticata rivela soltanto il loopback della fixture.
  const r=await f.req('/_nodo/registrazione');const origine=new URL(r.url).origin;
  processo.env={AMR_CENTRO_URL:origine,AMR_NODO_ID:'a',AMR_NODI_TOKEN:'a'.repeat(64)};
  const modulo={exports:{}};let consegna;
  vm.runInNewContext(fs.readFileSync(require.resolve('../backend/nodi/worker'),'utf8'),{
    module:modulo,process:processo,AbortSignal,AbortController,performance,URL,
    setTimeout,clearTimeout,setInterval,clearInterval,
    require:name=>name==='node:crypto'?require(name):name==='./operazioni'?require('../backend/nodi/operazioni'):require('../backend/annullo'),
    fetch:async(url,opt)=>{const res=await fetch(url,opt);
      if(url.endsWith('/_nodo/esito'))consegna=JSON.parse(opt.body);
      if(consegna&&url.endsWith('/_nodo/heartbeat'))processo.emit('SIGTERM');
      return res;
    },
  });
  const stop=setTimeout(()=>processo.emit('SIGTERM'),8000);
  try{await modulo.exports.avvia();}finally{clearTimeout(stop);}
  assert.equal(calls,1);assert.equal(consegna.esito.status,200);
  assert.equal(consegna.esito.body.stato,'ok');assert.equal(salute.fermo('subito').fermo,false);
  await new Promise(r=>setImmediate(r));
  assert.equal(f.c.db.prepare("SELECT count(*) n FROM eventi WHERE codice='sonda_riuscita'").get().n,1);
  // Il nodo torna disponibile quando comunica lo stato successivo all'esito.
  assert.equal(f.c.nodi.get('a').fonti.subito.fermo,false);
});
