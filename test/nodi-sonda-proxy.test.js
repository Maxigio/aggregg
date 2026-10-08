'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http'), https = require('node:https');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { creaSonda, peerRegistrabile } = require('../scripts/nhost/sonda-proxy-staging');
const { misuraProxy } = require('../scripts/nhost/misura-proxy-staging');
const { verificaDisponibilita, attendiSonda } = require('../scripts/nhost/attendi-sonda-staging');
const SENTINELLA = 'riservato-sintetico-non-stampare';
const ascolta = server => new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); });
async function aspetta(fn) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(fn(), 'condizione non raggiunta entro un secondo');
}

async function fixture(t, opzioni = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-sonda-proxy-'));
  const cnf = path.join(dir, 'tls.cnf'), key = path.join(dir, 'key'), cert = path.join(dir, 'cert');
  fs.writeFileSync(cnf, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:sonda.invalid\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-config', cnf, '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 });
  fs.chmodSync(key, 0o600);
  const ca = fs.readFileSync(cert), logs = [], richieste = [];
  let backend, modo = '', origine;
  const proxy = https.createServer({ key: fs.readFileSync(key), cert: ca }, (req, res) => {
    richieste.push({ url: req.url, cookie: req.headers.cookie });
    if (modo === 'provisioning') {
      res.writeHead(richieste.length < 3 ? 503 : 200, { 'cache-control': 'no-store' });
      return res.end(richieste.length < 3 ? SENTINELLA : 'ok');
    }
    if (modo === 'limitata') { res.writeHead(429); return res.end(SENTINELLA); }
    if (modo.endsWith('-pendente')) {
      const risposte = { '429-pendente': [429, {}], 'redirect-pendente': [302, { location: origine + '/secondo' }],
        'cookie-pendente': [200, { 'set-cookie': 'riservato=' + SENTINELLA }] };
      const [status, headers] = risposte[modo];
      res.writeHead(status, headers); res.flushHeaders(); res.write(SENTINELLA); return;
    }
    if (modo === 'redirect') { res.writeHead(302, { location: origine + '/secondo?' + SENTINELLA }); return res.end(SENTINELLA); }
    if (modo === 'infinito') return;
    if (modo === 'cookie') { res.writeHead(200, { 'set-cookie': 'riservato=' + SENTINELLA }); return res.end('ok'); }
    if (modo === 'vuoto' || modo === 'vuoto-no-store') {
      res.writeHead(200, modo === 'vuoto-no-store' ? { 'cache-control': 'no-store' } : {});
      return res.end();
    }
    if (modo === 'grande') { res.writeHead(200, { 'cache-control': 'no-store' }); return res.end('x'.repeat(65537) + SENTINELLA); }
    if (modo === 'troncato') { res.writeHead(200, { 'content-length': 10000, 'cache-control': 'no-store' }); res.write(SENTINELLA); return setImmediate(() => res.destroy()); }
    if (modo === 'anticipa' && req.url.startsWith('/sonda/attesa-')) {
      res.writeHead(200, { 'cache-control': 'no-store' }); res.flushHeaders();
    }
    if (modo === 'istanza' && req.url === '/sonda/header') {
      res.writeHead(200, { 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, sonda: 'proxy-v1', prova: 'header', istanza: '0'.repeat(16) }));
    }
    const headers = { ...req.headers };
    if (modo !== 'preserva') {
      for (const k of Object.keys(headers)) if (k === 'forwarded' || k === 'x-real-ip' || k.startsWith('x-forwarded-')) delete headers[k];
      headers['x-forwarded-proto'] = 'https';
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: backend.server.address().port,
      path: req.url, method: req.method, headers, agent: false }, r => {
      if (!res.headersSent) res.writeHead(r.statusCode, r.headers);
      r.on('error', () => res.destroy()); r.pipe(res);
    });
    upstream.on('error', () => res.destroy());
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); }); req.pipe(upstream);
  });
  t.after(async () => {
    if (proxy.listening) { const finita = new Promise(r => proxy.close(r)); proxy.closeAllConnections(); await finita; }
    if (backend) await backend.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  await ascolta(proxy); origine = 'https://127.0.0.1:' + proxy.address().port;
  backend = creaSonda({ origine, registra: e => logs.push(e), atteseMs: [20, 30], ...opzioni });
  await ascolta(backend.server);
  const diretto = (route, options = {}) => fetch('http://127.0.0.1:' + backend.server.address().port + route, options);
  return { origine, ca, logs, richieste, backend, diretto, modo: v => { modo = v; richieste.length = 0; } };
}

test('sonda proxy: registra solo IP privati/loopback, mai valori pubblici o testi arbitrary', () => {
  for (const ip of ['10.2.3.4', '172.31.2.3', '192.168.1.2', '127.0.0.1', '::1', 'fd00::1', '::ffff:10.2.3.4']) {
    assert.deepEqual(peerRegistrabile(ip), { tipo: 'privato', ip });
  }
  for (const ip of ['192.0.2.1', '8.8.8.8', '2001:db8::1', '::ffff:192.0.2.1']) {
    assert.deepEqual(peerRegistrabile(ip), { tipo: 'pubblico_non_registrato' });
  }
  assert.deepEqual(peerRegistrabile(SENTINELLA), { tipo: 'non_disponibile' });
});

test('sonda proxy: misura HTTPS completa, header riscritti e attese; nessuna credenziale o fiducia implicita', async t => {
  const f = await fixture(t), r = await misuraProxy({ ...f, attese: true, minAtteseMs: [20, 30] });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.controlli.length, 7);
  assert.equal(f.richieste.length, 7); assert.ok(f.richieste.every(x => x.cookie === undefined));
  assert.equal(r.istanza, f.backend.istanza); assert.ok(r.nonVerificati.includes('fiducia_proxy'));
  const h = f.logs.find(x => x.evento === 'richiesta' && x.prova === 'header');
  assert.equal(h.proto, 'https'); assert.equal(h.forwardedFor, 'assente');
  assert.equal(h.forwardedHost, 'assente'); assert.equal(h.peer.tipo, 'privato');
  assert.equal(f.logs.find(x => x.prova === 'host' && x.evento === 'richiesta').host, 'sentinella');
  const a = f.logs.filter(x => x.evento === 'esito' && x.prova.startsWith('attesa'));
  assert.equal(a.length, 2); assert.ok(a.every(x => x.esito === 'risposta_inviata'));
  const privato = await f.diretto('/sonda/normale', { headers: { authorization: SENTINELLA,
    cookie: SENTINELLA, origin: 'https://' + SENTINELLA + '.invalid', 'x-forwarded-for': SENTINELLA } });
  const body = await privato.text();
  assert.doesNotMatch(body, /peer|host|origin|cookie|riservato/);
  assert.equal(JSON.stringify(f.logs).includes(SENTINELLA), false);
  assert.equal(JSON.stringify(r).includes(SENTINELLA), false);
});

test('sonda proxy: header preservati restano osservazioni, non PASS di sicurezza', async t => {
  const f = await fixture(t); f.modo('preserva');
  const r = await misuraProxy(f); assert.equal(r.ok, true);
  const h = f.logs.find(x => x.evento === 'richiesta' && x.prova === 'header');
  assert.equal(h.proto, 'http'); assert.equal(h.forwardedFor, 'sentinella');
  assert.equal(h.forwarded, 'sentinella'); assert.ok(r.nonVerificati.includes('fiducia_proxy'));
});

test('sonda proxy: rifiuta metodi/body/query, capacità e finestra finite; healthz resta vivo', async t => {
  const f = await fixture(t, { maxRichieste: 3 });
  assert.equal((await f.diretto('/sonda/normale', { method: 'POST', body: SENTINELLA })).status, 404);
  assert.equal((await f.diretto('/sonda/normale?' + SENTINELLA)).status, 404);
  assert.equal((await f.diretto('/sonda/normale')).status, 200);
  assert.equal((await f.diretto('/sonda/normale')).status, 410);
  assert.equal((await f.diretto('/healthz')).status, 200);
  assert.equal(f.logs.filter(x => x.evento === 'richiesta').length, 1);
  const scaduta = await fixture(t, { durataMs: 1 });
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await scaduta.diretto('/sonda/normale')).status, 410);
  assert.equal((await scaduta.diretto('/healthz')).status, 200); assert.equal(scaduta.logs.length, 0);
});

test('sonda proxy: limite due attese, abort libera posto senza duplicare esito', async t => {
  const f = await fixture(t, { atteseMs: [500, 500] });
  const a = new AbortController(), b = new AbortController();
  const p = f.diretto('/sonda/attesa-55', { signal: a.signal }).catch(() => null);
  const q = f.diretto('/sonda/attesa-65', { signal: b.signal }).catch(() => null);
  await aspetta(() => f.logs.filter(x => x.evento === 'richiesta').length === 2);
  assert.equal((await f.diretto('/sonda/attesa-55')).status, 429);
  a.abort(); b.abort(); await Promise.all([p, q]);
  await aspetta(() => f.logs.filter(x => x.evento === 'esito').length === 2);
  assert.equal((await f.diretto('/sonda/attesa-55')).status, 200);
  assert.deepEqual(f.logs.filter(x => x.evento === 'esito').map(x => x.esito),
    ['collegamento_interrotto', 'collegamento_interrotto', 'risposta_inviata']);
});

test('sonda proxy: TLS, redirect, cookie, body grande, socket e istanza diversa fermano senza retry', async t => {
  const f = await fixture(t);
  const tls = await misuraProxy({ origine: f.origine }); assert.equal(tls.ok, false);
  assert.equal(f.richieste.length, 0);
  for (const modo of ['redirect', 'cookie', 'grande', 'troncato', 'istanza']) {
    f.modo(modo); const r = await misuraProxy(f);
    assert.equal(r.ok, false, modo); assert.equal(f.richieste.length, modo === 'istanza' ? 3 : 1);
    assert.equal(JSON.stringify(r).includes(SENTINELLA), false);
    if (modo === 'istanza') assert.equal(r.controlli.at(-1).codice, 'istanza_cambiata');
  }
});

test('sonda proxy: deadline reale e abort; configurazioni non valide non aprono rete', async t => {
  const f = await fixture(t); f.modo('infinito');
  const r = await misuraProxy({ ...f, timeoutMs: 20 });
  assert.equal(r.ok, false); assert.equal(r.controlli[0].codice, 'timeout');
  // Il budget include connessione e TLS: la scadenza può precedere l'HTTP.
  assert.equal(r.controlli.length, 1); assert.ok(f.richieste.length <= 1);
  const abort = await fixture(t); abort.modo('infinito'); const a = new AbortController(); a.abort();
  const b = await misuraProxy({ ...abort, signal: a.signal }); assert.equal(b.controlli[0].codice, 'interrotto');
  assert.equal(abort.richieste.length, 0);
  for (const origine of ['http://127.0.0.1', 'https://user:password@amr.invalid', 'https://amr.invalid/x', 'https://amr.invalid/']) {
    await assert.rejects(misuraProxy({ origine }), /origine_non_valida/);
    assert.throws(() => creaSonda({ origine }), /origine_non_valida/);
  }
  await assert.rejects(misuraProxy({ ...f, timeoutAtteseMs: 75001 }), /limiti_non_validi/);
  assert.throws(() => creaSonda({ origine: f.origine, maxRichieste: 201 }), /limiti_non_validi/);
  const cli = await promisify(execFile)(process.execPath,
    [path.resolve('scripts/nhost/misura-proxy-staging.js'), '--origine', f.origine],
    { env: {}, timeout: 10000, encoding: 'utf8' }).catch(e => e);
  assert.equal(cli.code, 1); assert.equal(JSON.parse(cli.stdout).ok, false);
  assert.equal(cli.stdout.includes(SENTINELLA), false); assert.equal(cli.stderr.includes(SENTINELLA), false);
});

test('sonda proxy: deadline prima della risoluzione DNS non invia HTTP né riprova', async t => {
  const f = await fixture(t), risoluzioni = [];
  const r = await misuraProxy({ ...f, origine: f.origine.replace('127.0.0.1', 'sonda.invalid'),
    timeoutMs: 20, lookup: (_nome, opzioni, callback) => risoluzioni.push({ opzioni, callback }) });
  assert.equal(r.ok, false); assert.equal(r.controlli[0].codice, 'timeout');
  assert.equal(r.controlli.length, 1); assert.equal(risoluzioni.length, 1);
  assert.equal(f.richieste.length, 0);
  const { opzioni, callback } = risoluzioni[0];
  if (opzioni.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
  await new Promise(r => setImmediate(r));
  assert.equal(f.richieste.length, 0);
});

test('sonda proxy: rifiuta finte attese e flush anticipato anche con body corretto', async t => {
  const f = await fixture(t, { atteseMs: [100, 100] });
  const immediata = await misuraProxy({ ...f, attese: true });
  assert.equal(immediata.ok, false); assert.equal(immediata.controlli.at(-1).codice, 'header_anticipati');
  f.modo('anticipa'); const anticipata = await misuraProxy({ ...f, attese: true, minAtteseMs: [100, 100] });
  assert.equal(anticipata.ok, false); assert.equal(anticipata.controlli.at(-1).codice, 'header_anticipati');
});

test('sonda proxy: header duplicati, GET con body e arresto di attesa non perdono privacy o cleanup', async t => {
  const f = await fixture(t, { atteseMs: [500, 500] });
  const richiesta = (headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: f.backend.server.address().port,
      path: '/sonda/normale', headers, agent: false }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    }); req.once('error', reject); req.end(body);
  });
  assert.equal(await richiesta({ 'x-forwarded-proto': ['https', 'http'],
    origin: ['https://estranea.invalid', SENTINELLA] }), 200);
  assert.equal(f.logs[0].proto, 'multiplo'); assert.equal(f.logs[0].origin, 'multiplo');
  assert.equal(await richiesta({ 'content-length': Buffer.byteLength(SENTINELLA) }, SENTINELLA), 413);
  const p = f.diretto('/sonda/attesa-55').catch(() => null);
  await aspetta(() => f.logs.some(x => x.evento === 'richiesta' && x.prova === 'attesa_55'));
  await f.backend.close(); assert.equal(await p, null);
  await new Promise(r => setTimeout(r, 550));
  assert.equal(f.logs.filter(x => x.evento === 'esito' && x.prova === 'attesa_55').length, 1);
  assert.equal(f.logs.at(-1).esito, 'collegamento_interrotto');
  assert.equal(JSON.stringify(f.logs).includes(SENTINELLA), false);
});

test('sonda proxy: attese reali 55/65 secondi senza flush anticipato',
  { skip: process.env.AMR_TEST_SONDA_LENTA !== '1', timeout: 150000 }, async t => {
    const f = await fixture(t, { atteseMs: [55000, 65000] });
    const r = await misuraProxy({ ...f, attese: true }); assert.equal(r.ok, true, JSON.stringify(r));
    for (const [prova, ms] of [['attesa_55', 55000], ['attesa_65', 65000]]) {
      const c = r.controlli.find(x => x.prova === prova); assert.ok(c.durataMs >= ms - 100, JSON.stringify(c));
      const e = f.logs.find(x => x.evento === 'esito' && x.prova === prova);
      assert.equal(e.esito, 'risposta_inviata'); assert.ok(e.durataMs >= ms - 100);
    }
  });

test('disponibilità sonda: provisioning, budget, abort e TLS distinti senza dati grezzi', async t => {
  const f = await fixture(t), eventi = [];
  f.modo('provisioning');
  const r = await attendiSonda({ ...f, intervalloMs: 5, budgetMs: 1000, registra: e => eventi.push(e) });
  assert.equal(r.ok, true); assert.equal(r.controlli.length, 3);
  assert.deepEqual(r.controlli.map(c => c.status), [503, 503, 200]);
  assert.equal(eventi.length, 3); assert.equal(JSON.stringify(eventi).includes(SENTINELLA), false);
  assert.ok(f.richieste.every(q => q.url === '/healthz' && q.cookie === undefined));
  f.modo('infinito');
  const budget = await attendiSonda({ ...f, budgetMs: 30, intervalloMs: 5 });
  assert.equal(budget.ok, false); assert.ok(budget.controlli.length >= 1);
  assert.ok(budget.controlli.every(c => c.codice === 'timeout'));
  assert.ok(budget.durataMs < 500);
  f.modo('');
  const a = new AbortController(); a.abort();
  assert.equal((await attendiSonda({ ...f, signal: a.signal })).codice, 'interrotto');
  assert.equal(f.richieste.length, 0);
  const tls = await attendiSonda({ origine: f.origine, intervalloMs: 1 });
  assert.equal(tls.codice, 'tls_non_valido'); assert.equal(tls.controlli.length, 1);
  assert.equal(f.richieste.length, 0);
  for (const modo of ['redirect', 'cookie', 'grande', 'troncato', 'limitata', 'vuoto', 'vuoto-no-store']) {
    f.modo(modo); const negata = await attendiSonda({ ...f, intervalloMs: 1 });
    assert.equal(negata.ok, false, modo); assert.equal(negata.controlli.length, 1, modo);
    assert.equal(f.richieste.length, 1, modo); assert.equal(JSON.stringify(negata).includes(SENTINELLA), false);
    if (modo === 'grande') assert.equal(negata.codice, 'risposta_troppo_grande');
    if (modo === 'troncato') assert.equal(negata.codice, 'risposta_interrotta');
    if (modo.startsWith('vuoto')) {
      assert.equal(negata.controlli[0].status, 200);
      assert.equal(negata.codice, 'risposta_inattesa');
    }
  }
});

test('disponibilità sonda: DNS classificato senza errori grezzi e massimo di tentativi', async t => {
  const { EventEmitter } = require('node:events');
  const originale = https.get; let chiamate = 0;
  t.after(() => { https.get = originale; });
  https.get = (_url, opzioni) => {
    assert.equal(opzioni.rejectUnauthorized, true); assert.equal(opzioni.agent, false);
    assert.equal(opzioni.headers.cookie, undefined); chiamate++;
    const req = new EventEmitter();
    process.nextTick(() => req.emit('error', Object.assign(new Error(SENTINELLA), { code: 'ENOTFOUND' })));
    return req;
  };
  const f = { origine: 'https://sonda.example.invalid', intervalloMs: 1, maxTentativi: 3 };
  const r = await attendiSonda(f);
  assert.equal(r.ok, false); assert.equal(chiamate, 3); assert.equal(r.controlli.length, 3);
  assert.ok(r.controlli.every(c => c.codice === 'dns_non_disponibile' && c.fase === 'dns' && c.status === null));
  assert.equal(JSON.stringify(r).includes(SENTINELLA), false);
  for (const options of [{ budgetMs: 300001 }, { timeoutMs: 5001 }, { maxTentativi: 61 }, { signal: {} },
    { origine: 'https://user:password@sonda.example.invalid' }]) {
    await assert.rejects(attendiSonda({ ...f, ...options }));
  }
  assert.equal(chiamate, 3);
  assert.equal((await verificaDisponibilita(f)).codice, 'dns_non_disponibile');
});

test('disponibilità sonda: header terminali fermano anche un body che non termina', async t => {
  const f = await fixture(t);
  for (const [modo, codice] of [['429-pendente', 'http_non_disponibile'],
    ['redirect-pendente', 'redirect_non_ammesso'], ['cookie-pendente', 'cookie_inatteso']]) {
    f.modo(modo);
    const r = await attendiSonda({ ...f, timeoutMs: 500, budgetMs: 1500, intervalloMs: 1, maxTentativi: 3 });
    assert.equal(r.ok, false); assert.equal(r.codice, codice, modo);
    assert.equal(r.controlli.length, 1, modo); assert.equal(f.richieste.length, 1, modo);
    assert.equal(JSON.stringify(r).includes(SENTINELLA), false);
  }
});

test('sonda: lookup diagnostico esplicito mantiene verifica TLS e hostname', async t => {
  const f = await fixture(t), nomi = [];
  const lookup = (nome, opzioni, callback) => {
    nomi.push(nome);
    process.nextTick(() => opzioni.all ? callback(null, [{ address: '127.0.0.1', family: 4 }])
      : callback(null, '127.0.0.1', 4));
  };
  const origine = f.origine.replace('127.0.0.1', 'sonda.invalid');
  assert.equal((await attendiSonda({ origine, ca: f.ca, lookup })).ok, true);
  const r = await misuraProxy({ origine, ca: f.ca, lookup });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.controlli.length, 5);
  assert.equal(nomi.length, 6); assert.ok(nomi.every(n => n === 'sonda.invalid'));
  const prima = f.richieste.length;
  const errata = origine.replace('sonda.invalid', 'certificato-errato.invalid');
  assert.equal((await attendiSonda({ origine: errata, ca: f.ca, lookup })).codice, 'tls_non_valido');
  assert.equal((await misuraProxy({ origine: errata, ca: f.ca, lookup })).ok, false);
  assert.equal(f.richieste.length, prima);
  const a = new AbortController(); a.abort(); const primaDNS = nomi.length;
  assert.equal((await verificaDisponibilita({ origine, ca: f.ca, lookup, signal: a.signal })).codice, 'interrotto');
  assert.equal((await misuraProxy({ origine, ca: f.ca, lookup, signal: a.signal })).controlli[0].codice, 'interrotto');
  assert.equal(nomi.length, primaDNS);
  const DNSko = (_nome, _opzioni, callback) => process.nextTick(() =>
    callback(Object.assign(new Error(SENTINELLA), { code: 'ENOTFOUND' })));
  const ko = await misuraProxy({ origine, ca: f.ca, lookup: DNSko });
  assert.equal(ko.controlli[0].codice, 'dns_non_disponibile');
  assert.equal(ko.controlli.length, 1); assert.equal(f.richieste.length, prima);
  assert.equal(JSON.stringify(ko).includes(SENTINELLA), false);
  await assert.rejects(attendiSonda({ origine, lookup: true }), /limiti_non_validi/);
  await assert.rejects(misuraProxy({ origine, lookup: true }), /limiti_non_validi/);
});
