'use strict';
const { isIP, BlockList } = require('node:net');

function origineConfigurata(origine) {
  let url;
  try { url = new URL(origine); } catch { throw new Error('origine trasporto non valida'); }
  if (typeof origine !== 'string' || url.origin !== origine || url.username || url.password
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
    throw new Error('origine trasporto non valida');
  }
  return url;
}
const versioneIP = ip => typeof ip === 'string' && !ip.includes('%') ? isIP(ip) : 0;
const tipoIP = ip => versioneIP(ip) === 6 ? 'ipv6' : 'ipv4';
function creaTrasporto({ origine, proxy, proxyAttendibili, ingress }) {
  if (proxy !== undefined && proxyAttendibili !== undefined) throw new Error('configurazione proxy duplicata');
  const ips = proxy !== undefined ? proxy : proxyAttendibili !== undefined ? proxyAttendibili : [];
  const url = origineConfigurata(origine), secure = url.protocol === 'https:';
  if (!Array.isArray(ips) || ips.length > 32
      || ips.some(ip => !versioneIP(ip)) || (!secure && ips.length)) {
    throw new Error('proxy attendibili devono essere IP espliciti in modalita HTTPS');
  }
  if (ingress !== undefined && (ingress !== 'nhost' || !secure || ips.length)) {
    throw new Error('ingress Nhost richiede HTTPS e nessuna lista proxy');
  }
  // Confronto IP nativo, incluse le rappresentazioni IPv4-mapped IPv6.
  const proxyIPs = new BlockList(), loopback = new BlockList();
  for (const ip of ips) proxyIPs.addAddress(ip, tipoIP(ip));
  loopback.addAddress('127.0.0.1', 'ipv4');
  const trustProxy = ip => Boolean(versioneIP(ip)) && proxyIPs.check(ip, tipoIP(ip));
  function verificaTrasporto(req, res, next) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    // Header ambigui non possono selezionare origine o protocollo differenti.
    for (const name of ['host', 'origin', 'x-forwarded-proto']) {
      let count = 0;
      for (let i = 0; i < (req.rawHeaders?.length || 0); i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
      if (count > 1) return res.sendStatus(403);
    }
    if (req.headers.host !== url.host) return res.sendStatus(403);
    const peer = req.socket.remoteAddress;
    if (!versioneIP(peer)) return res.sendStatus(403);
    if (!secure) {
      if (!loopback.check(peer, tipoIP(peer)) || req.socket.encrypted) return res.sendStatus(403);
    } else if (ingress === 'nhost') {
      // Run termina il TLS pubblico. La rete del progetto appartiene al
      // confine fidato: questo header non autentica il chiamante interno.
      // La modalita non rende fidati Forwarded-For/Host per Express.
      if (req.headers['x-forwarded-proto'] !== 'https') return res.sendStatus(403);
    } else if (trustProxy(req.socket.remoteAddress)) {
      // Il proxy configurato deve sovrascrivere questo header, non appendere.
      if (req.headers['x-forwarded-proto'] !== 'https') return res.sendStatus(403);
    } else if (!req.socket.encrypted || req.headers['x-forwarded-proto'] !== undefined) {
      return res.sendStatus(403);
    }
    if (secure) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  }
  function verificaOrigine(req, res, next) {
    const safe = ['GET', 'HEAD'].includes(req.method);
    if ((!safe || req.headers.origin !== undefined) && req.headers.origin !== origine) {
      return res.sendStatus(403);
    }
    next();
  }
  function middleware(req, res, next) {
    verificaTrasporto(req, res, () => verificaOrigine(req, res, next));
  }
  return Object.freeze({ origine, host: url.host, secure, middleware, verificaTrasporto, verificaOrigine, trustProxy });
}

function trasportoPerRotta({ origine, proxyAttendibili, trasporto }) {
  const policy = creaTrasporto(trasporto === undefined ? { origine, proxyAttendibili } : trasporto);
  if (trasporto !== undefined && ((origine !== undefined && origine !== policy.origine)
      || proxyAttendibili !== undefined)) throw new Error('configurazione trasporto contraddittoria');
  return policy;
}
module.exports = { creaTrasporto, origineConfigurata, trasportoPerRotta };
