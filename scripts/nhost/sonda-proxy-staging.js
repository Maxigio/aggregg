'use strict';
const http = require('node:http');
const { isIP, BlockList } = require('node:net');
const { randomBytes } = require('node:crypto');

// Processo separato da AMR: osserva il trasporto, non autentica né assegna lavori.
const privati = new BlockList();
for (const [ip, bit] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8]]) {
  privati.addSubnet(ip, bit, 'ipv4');
}
privati.addSubnet('fc00::', 7, 'ipv6'); privati.addAddress('::1', 'ipv6');
function peerRegistrabile(ip) {
  const v = isIP(ip || '');
  if (!v) return { tipo: 'non_disponibile' };
  return privati.check(ip, v === 6 ? 'ipv6' : 'ipv4')
    ? { tipo: 'privato', ip } : { tipo: 'pubblico_non_registrato' };
}
function origineValida(origine) {
  let u;
  try { u = new URL(origine); } catch { throw new Error('origine_non_valida'); }
  if (typeof origine !== 'string' || u.protocol !== 'https:' || u.origin !== origine
    || u.username || u.password) throw new Error('origine_non_valida');
  return u;
}
function creaSonda({ origine, registra = evento => console.log(JSON.stringify(evento)),
  durataMs = 900000, maxRichieste = 200, atteseMs = [55000, 65000] } = {}) {
  const url = origineValida(origine);
  if (!Number.isSafeInteger(durataMs) || durataMs < 1 || durataMs > 900000
    || !Number.isSafeInteger(maxRichieste) || maxRichieste < 1 || maxRichieste > 200
    || !Array.isArray(atteseMs) || atteseMs.length !== 2
    || atteseMs.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > [55000, 65000][i])) {
    throw new Error('limiti_non_validi');
  }
  const istanza = randomBytes(8).toString('hex'), inizio = performance.now();
  let numero = 0, attive = 0, chiusa = false;
  const timer = new Set();
  const percorsi = new Map([
    ['/sonda/normale', ['normale', 0]], ['/sonda/header', ['header', 0]],
    ['/sonda/origin', ['origin', 0]], ['/sonda/host', ['host', 0]],
    ['/sonda/attesa-55', ['attesa_55', atteseMs[0]]], ['/sonda/attesa-65', ['attesa_65', atteseMs[1]]],
  ]);
  function classe(req, nome, valori) {
    const raw = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === nome) raw.push(req.rawHeaders[i + 1]);
    }
    if (!raw.length) return 'assente';
    if (raw.length !== 1) return 'multiplo';
    return valori.get(raw[0]) || 'altro';
  }
  function risposta(res, status, dati) {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'connection': 'close' });
    res.end(JSON.stringify(dati));
  }
  const server = http.createServer({ maxHeaderSize: 16384, headersTimeout: 5000,
    requestTimeout: 5000, connectionsCheckingInterval: 1000 }, (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'cache-control': 'no-store', 'connection': 'close' }); return res.end('ok');
    }
    if (chiusa || performance.now() - inizio >= durataMs || numero >= maxRichieste) {
      return risposta(res, 410, { ok: false, codice: 'sonda_terminata' });
    }
    numero++;
    if (req.method !== 'GET' || !percorsi.has(req.url)) return risposta(res, 404, { ok: false });
    if (req.headers['transfer-encoding'] !== undefined
      || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      return risposta(res, 413, { ok: false });
    }
    const [prova, attesa] = percorsi.get(req.url);
    if (attesa && attive >= 2) return risposta(res, 429, { ok: false, codice: 'sonda_occupata' });
    const richiesta = numero, avvio = performance.now();
    registra({ evento: 'richiesta', istanza, richiesta, prova, peer: peerRegistrabile(req.socket.remoteAddress),
      host: classe(req, 'host', new Map([[url.host, 'atteso'], ['estranea.invalid', 'sentinella']])),
      origin: classe(req, 'origin', new Map([[origine, 'atteso'], ['https://estranea.invalid', 'sentinella'], ['null', 'null']])),
      proto: classe(req, 'x-forwarded-proto', new Map([['https', 'https'], ['http', 'http']])),
      forwarded: classe(req, 'forwarded', new Map([['for=192.0.2.1;proto=http;host=estranea.invalid', 'sentinella']])),
      forwardedHost: classe(req, 'x-forwarded-host', new Map([[url.host, 'atteso'], ['estranea.invalid', 'sentinella']])),
      forwardedFor: classe(req, 'x-forwarded-for', new Map([['192.0.2.1', 'sentinella']])),
      realIp: classe(req, 'x-real-ip', new Map([['192.0.2.2', 'sentinella']])),
    });
    let t, finita = false;
    const termina = esito => {
      if (finita) return;
      finita = true;
      if (t) { clearTimeout(t); timer.delete(t); attive--; }
      registra({ evento: 'esito', istanza, richiesta, prova, esito,
        durataMs: Math.round(performance.now() - avvio) });
    };
    res.once('finish', () => termina('risposta_inviata'));
    res.once('close', () => termina('collegamento_interrotto'));
    const invia = () => risposta(res, 200, { ok: true, sonda: 'proxy-v1', istanza, prova });
    if (attesa) { attive++; t = setTimeout(invia, attesa); timer.add(t); }
    else invia();
  });
  server.maxConnections = 32;
  server.setTimeout(75000, socket => socket.destroy());
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('checkContinue', (_req, res) => risposta(res, 413, { ok: false }));
  server.on('upgrade', (_req, socket) => socket.destroy());
  function close() {
    chiusa = true;
    for (const t of timer) clearTimeout(t);
    timer.clear();
    return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
  return { server, close, istanza };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (![2, 4].includes(args.length) || args[0] !== '--origine'
      || (args.length === 4 && (args[2] !== '--ascolto' || args[3] !== '0.0.0.0'))) throw new Error();
    const sonda = creaSonda({ origine: args[1] });
    sonda.server.on('error', () => { console.error('Sonda non avviata.'); process.exitCode = 1; });
    sonda.server.listen(3000, args[3] || '127.0.0.1');
    for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => { void sonda.close(); });
  } catch { console.error('Usare --origine HTTPS esplicita; --ascolto 0.0.0.0 solo per il container isolato.'); process.exitCode = 1; }
}
module.exports = { creaSonda, origineValida, peerRegistrabile };
