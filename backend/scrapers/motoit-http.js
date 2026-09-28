'use strict';

const https = require('https');
const zlib = require('zlib');
const salute = require('../fonti-salute');
const annullo = require('../annullo');
const budget = require('../budget-richieste');
const ritmo = require('./motoit-ritmo');
const { fail } = require('./utils');

const HOSTS = ['www.moto.it', 'moto.it', 'dealer.moto.it'];
// Byte DECOMPRESSI: il campione ricerca era 527.920 byte, non i 98.173 trasferiti.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 30000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function hostOk(raw, hosts = HOSTS) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && hosts.includes(u.hostname)
      && !u.username && !u.password && (!u.port || u.port === '443');
  } catch { return false; }
}

function get(url, { timeoutMs = 15000, signal = annullo.segnale(), hosts = HOSTS,
  accept = 'text/html', tag = null } = {}) {
  const deadlineAt = Date.now() + DEADLINE_MS;
  async function hop(target, n) {
    if (!hostOk(target, hosts)) throw fail(n ? 'redirect Moto.it non consentito' : 'destinazione Moto.it non consentita', { kind: 'error' });
    if (n > 5) throw fail('troppi redirect Moto.it', { kind: 'error' });
    return salute.richiesta('moto', async () => {
      await ritmo.attendi({ signal, deadlineAt });
      // Un 429 concorrente puo' arrivare durante la coda. Il contesto salute
      // riconosce anche chi possiede l'unico tentativo di ripartenza.
      return salute.richiesta('moto', () => {
        if (signal?.aborted) throw fail('richiesta Moto.it annullata', { kind: 'transient' });
        if (Date.now() >= deadlineAt) throw fail('timeout complessivo Moto.it', { kind: 'transient' });
        budget.conta('motoit', n ? 'redirect' : tag);
        let timer, response, decoded, done = false;
        return new Promise((resolve, reject) => {
          const stop = e => {
            if (done) return;
            done = true;
            reject(e.kind ? e : fail(e.message, { kind: 'transient' }));
            decoded?.destroy(); response?.destroy(); req.destroy();
          };
          const req = https.get(target, { signal: signal || undefined, headers: {
            'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9',
            'Accept-Encoding': 'gzip, deflate', Accept: accept,
          } }, res => {
            response = res;
            res.on('error', stop);
            res.on('aborted', () => stop(fail('risposta interrotta', { kind: 'transient' })));
            res.on('close', () => { if (!res.complete) stop(fail('risposta troncata', { kind: 'transient' })); });
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              let next;
              try { next = new URL(res.headers.location, target).href; }
              catch { stop(fail('redirect Moto.it non valido', { kind: 'error' })); return; }
              // Fissa l'esito prima del destroy: gli eventi della vecchia presa
              // non devono rifiutare la promessa che ora segue la destinazione.
              done = true; clearTimeout(timer); res.destroy(); req.destroy();
              resolve(hop(next, n + 1));
              return;
            }
            if (res.statusCode !== 200) {
              const e = salute.erroreHttp('moto', res.statusCode, res.headers);
              // Stesso Error ai livelli superiori: registra() elimina i doppioni.
              salute.registra('moto', { errore: e });
              stop(e); return;
            }
            const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
            if (encoding === 'gzip') decoded = zlib.createGunzip();
            else if (encoding === 'deflate') decoded = zlib.createInflate();
            else if (encoding && encoding !== 'identity') {
              stop(fail('compressione Moto.it non riconoscibile', { kind: 'error' })); return;
            }
            const stream = decoded || res;
            const chunks = []; let bytes = 0;
            if (decoded) decoded.on('error', stop);
            stream.on('data', c => {
              if (done) return;
              const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
              bytes += chunk.length;
              if (bytes > MAX_BODY_BYTES) {
                chunks.length = 0;
                stop(Object.assign(fail('Moto.it: risposta oltre il limite di dimensione; pagina non letta',
                  { kind: 'error' }), { code: 'MOTO_BODY_TOO_LARGE' }));
              } else chunks.push(chunk);
            });
            stream.on('end', () => {
              if (done) return;
              done = true;
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers });
            });
            if (decoded) res.pipe(decoded);
          });
          req.on('error', stop);
          req.setTimeout(timeoutMs, () => stop(fail('timeout Moto.it', { kind: 'transient' })));
          timer = setTimeout(() => stop(fail('timeout complessivo Moto.it', { kind: 'transient' })),
            Math.max(1, deadlineAt - Date.now()));
        }).finally(() => clearTimeout(timer));
      });
    });
  }
  return hop(url, 0);
}

module.exports = { get, hostOk };
