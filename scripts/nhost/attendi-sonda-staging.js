'use strict';
const https = require('node:https');
const { isIP } = require('node:net');
const { setTimeout: pausa } = require('node:timers/promises');
const { origineValida } = require('./sonda-proxy-staging');

// Solo diagnostica della sonda: non interroga AMR e non registra body, header o IP.
async function verificaDisponibilita({ origine, ca, signal, lookup, timeoutMs = 5000 } = {}) {
  const url = origineValida(origine);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
    || (signal !== undefined && !(signal instanceof AbortSignal))
    || (lookup !== undefined && typeof lookup !== 'function')) throw new Error('limiti_non_validi');
  if (signal?.aborted) return { ok: false, codice: 'interrotto', fase: 'dns', status: null, durataMs: 0 };
  const tempo = AbortSignal.timeout(timeoutMs);
  const interruzione = signal ? AbortSignal.any([signal, tempo]) : tempo;
  const avvio = performance.now();
  let fase = 'dns', status = null;
  return new Promise(resolve => {
    let finita = false;
    const termina = (ok, codice) => {
      if (finita) return;
      finita = true;
      resolve({ ok, codice, fase, status, durataMs: Math.round(performance.now() - avvio) });
    };
    const req = https.get(new URL('/healthz', url), { agent: false, ca, lookup, maxHeaderSize: 16384,
      servername: isIP(url.hostname) || url.hostname.startsWith('[') ? '' : url.hostname,
      rejectUnauthorized: true, signal: interruzione, headers: { 'accept-encoding': 'identity' },
    }, res => {
      fase = 'header'; status = res.statusCode;
      let byte = 0; const parti = [];
      res.once('error', () => termina(false, 'risposta_interrotta'));
      res.once('aborted', () => termina(false, 'risposta_interrotta'));
      const codiceHeader = res.headers['set-cookie'] !== undefined ? 'cookie_inatteso'
        : status >= 300 && status < 400 ? 'redirect_non_ammesso'
          : status !== 200 ? 'http_non_disponibile'
            : !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(res.headers['cache-control'] || '') ? 'risposta_inattesa' : null;
      if (codiceHeader) { termina(false, codiceHeader); req.destroy(); return; }
      fase = 'body';
      res.on('data', b => {
        byte += b.length;
        if (byte > 4096) { termina(false, 'risposta_troppo_grande'); req.destroy(); }
        else parti.push(b);
      });
      res.once('end', () => {
        const body = Buffer.concat(parti).toString('utf8');
        termina(body === 'ok', body === 'ok' ? 'disponibile' : 'risposta_inattesa');
      });
    });
    req.once('socket', socket => {
      if (isIP(url.hostname) || url.hostname.startsWith('[')) fase = 'connessione';
      socket.once('lookup', err => { if (!err) fase = 'connessione'; });
      socket.once('connect', () => { fase = 'tls'; });
      socket.once('secureConnect', () => { fase = 'http'; });
    });
    req.once('error', err => {
      const codice = signal?.aborted ? 'interrotto' : tempo.aborted ? 'timeout'
        : err.code === 'ENOTFOUND' ? 'dns_non_disponibile'
          : err.code === 'EAI_AGAIN' ? 'dns_temporaneo'
            : err.code === 'ECONNREFUSED' ? 'connessione_rifiutata'
              : ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
                'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(err.code) ? 'tls_non_valido'
                : err.code === 'HPE_HEADER_OVERFLOW' ? 'header_troppo_grandi' : 'errore_rete';
      termina(false, codice);
    });
  });
}

async function attendiSonda({ origine, ca, signal, lookup, budgetMs = 300000, intervalloMs = 5000,
  timeoutMs = 5000, maxTentativi = 60, registra = () => {} } = {}) {
  origineValida(origine);
  if (![budgetMs, intervalloMs, timeoutMs, maxTentativi].every(Number.isSafeInteger)
    || budgetMs < 1 || budgetMs > 300000 || intervalloMs < 1 || intervalloMs > 5000
    || timeoutMs < 1 || timeoutMs > 5000 || maxTentativi < 1 || maxTentativi > 60
    || typeof registra !== 'function' || (signal !== undefined && !(signal instanceof AbortSignal))
    || (lookup !== undefined && typeof lookup !== 'function')) {
    throw new Error('limiti_non_validi');
  }
  const avvio = performance.now(), controlli = [];
  let codice = 'budget_esaurito';
  while (controlli.length < maxTentativi && performance.now() - avvio < budgetMs) {
    if (signal?.aborted) { codice = 'interrotto'; break; }
    const residuo = Math.max(1, Math.floor(budgetMs - (performance.now() - avvio)));
    const r = await verificaDisponibilita({ origine, ca, signal, lookup, timeoutMs: Math.min(timeoutMs, residuo) });
    const controllo = { tentativo: controlli.length + 1, trascorsiMs: Math.round(performance.now() - avvio), ...r };
    controlli.push(controllo); registra({ ...controllo });
    if (r.ok) return { ok: true, codice: r.codice, controlli, durataMs: Math.round(performance.now() - avvio) };
    const riprovabile = ['dns_non_disponibile', 'dns_temporaneo', 'connessione_rifiutata', 'timeout', 'errore_rete'].includes(r.codice)
      || (r.codice === 'http_non_disponibile' && [404, 502, 503, 504].includes(r.status));
    if (!riprovabile) { codice = r.codice; break; }
    const resta = budgetMs - (performance.now() - avvio);
    if (controlli.length === maxTentativi || resta <= 0) break;
    try { await pausa(Math.min(intervalloMs, resta), undefined, { signal }); }
    catch { codice = 'interrotto'; break; }
  }
  return { ok: false, codice, controlli, durataMs: Math.round(performance.now() - avvio) };
}

module.exports = { verificaDisponibilita, attendiSonda };
