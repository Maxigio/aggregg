'use strict';
const https = require('node:https');
const { isIP } = require('node:net');

// Sonda anonima esplicita: non carica .env, non esegue login/ricerche e non
// conserva né reinvia i cookie. Il PASS non attesta il peer del proxy o Auth.
function origineValida(origine) {
  let url;
  try { url = new URL(origine); } catch { throw new Error('origine_non_valida'); }
  if (typeof origine !== 'string' || url.protocol !== 'https:' || url.origin !== origine
      || url.username || url.password) throw new Error('origine_non_valida');
  return url;
}
function cookieBootstrap(headers) {
  const cookies = headers['set-cookie'];
  if (!Array.isArray(cookies) || cookies.length !== 1) return false;
  const [valore, ...parti] = cookies[0].split(';').map(v => v.trim());
  if (!/^amr_accesso_prova=[a-f0-9]{64}$/.test(valore)) return false;
  const attributi = new Map();
  for (const p of parti) {
    const i = p.indexOf('='), nome = (i < 0 ? p : p.slice(0, i)).toLowerCase();
    if (attributi.has(nome)) return false;
    attributi.set(nome, i < 0 ? '' : p.slice(i + 1));
  }
  return attributi.get('httponly') === '' && attributi.get('secure') === ''
    && attributi.get('samesite')?.toLowerCase() === 'strict'
    && attributi.get('path') === '/' && !attributi.has('domain');
}
const nienteCookie = r => r.headers['set-cookie'] === undefined;
const json = r => { try { return JSON.parse(r.body); } catch { return null; } };
function hstsValido(value) {
  if (typeof value !== 'string') return false;
  // Formati usati da AMR/ingress: niente PASS per numeri parziali o duplicati.
  const direttive = value.split(';').map(v => v.trim()).filter(Boolean);
  const nomi = direttive.map(v => v.split('=')[0].trim().toLowerCase());
  if (new Set(nomi).size !== nomi.length) return false;
  let eta;
  for (const d of direttive) {
    if (/^(?:includeSubDomains|preload)$/i.test(d)) continue;
    const m = /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/i.exec(d);
    if (!m) return false;
    eta = m[1] || m[2];
  }
  return typeof eta === 'string' && /[1-9]/.test(eta);
}
const protezioni = r => /(?:^|,)\s*no-store\s*(?:,|$)/i.test(r.headers['cache-control'] || '')
  && r.headers['x-content-type-options'] === 'nosniff'
  && hstsValido(r.headers['strict-transport-security']);

async function collaudaIngress({ origine, ca, signal, timeoutMs = 5000, totaleMs = 60000 } = {}) {
  const url = origineValida(origine);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000
      || !Number.isSafeInteger(totaleMs) || totaleMs < 1 || totaleMs > 60000) {
    throw new Error('limiti_non_validi');
  }
  const totale = AbortSignal.timeout(totaleMs);
  const interruzione = signal ? AbortSignal.any([signal, totale]) : totale;
  function request({ route, method = 'GET', body, headers = {} }) {
    return new Promise((resolve, reject) => {
      const dati = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = https.request(new URL(route, url), { method, ca, agent: false,
        // Host falsificato nella controprova non deve cambiare la verifica TLS.
        servername: isIP(url.hostname) || url.hostname.startsWith('[') ? '' : url.hostname,
        rejectUnauthorized: true, maxHeaderSize: 16384,
        signal: AbortSignal.any([interruzione, AbortSignal.timeout(timeoutMs)]),
        headers: { 'accept-encoding': 'identity',
          ...(dati ? { 'content-type': 'application/json', 'content-length': dati.length } : {}), ...headers },
      }, res => {
        let byte = 0; const parti = [];
        res.on('error', reject);
        res.on('aborted', () => reject(new Error('risposta_interrotta')));
        res.on('data', b => {
          byte += b.length;
          if (byte > 65536) req.destroy(new Error('risposta_troppo_grande'));
          else parti.push(b);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(parti).toString('utf8') }));
      });
      req.on('error', reject); req.end(dati);
    });
  }
  const controlli = [], inizio = performance.now();
  const negata = (nome, route) => ({ nome, route, verifica: r => r.status === 401 && nienteCookie(r) && protezioni(r) });
  const falsificati = { forwarded: 'for=192.0.2.1;proto=http;host=estranea.invalid',
    'x-forwarded-proto': 'http', 'x-forwarded-host': 'estranea.invalid',
    'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.2' };
  const config = r => r.status === 200 && json(r)?.accesso === 'nhost' && nienteCookie(r) && protezioni(r);
  const prove = [
    { nome: 'liveness', route: '/healthz', verifica: r => r.status === 200 && r.body === 'ok'
      && nienteCookie(r) && /no-store/i.test(r.headers['cache-control'] || '') },
    { nome: 'modalita_nhost', route: '/api/test/config', verifica: config },
    negata('identita_anonima', '/api/auth/me'),
    negata('admin_anonimo', '/api/admin'),
    negata('backup_anonimo', '/api/auth/backup/stato'),
    { ...negata('ricerca_anonima', '/api/ricerche'), method: 'POST',
      body: { id: '00000000-0000-4000-8000-000000000001', input: { tipo: 'moto', marca: 'Yamaha' } },
      headers: { origin: origine } },
    { nome: 'ricerca_get_disabilitata', route: '/api/search?tipo=moto',
      verifica: r => r.status === 405 && nienteCookie(r) && protezioni(r) },
    negata('nodo_senza_token', '/_nodo/registrazione'),
    { nome: 'login_sintetico_disabilitato', route: '/api/test/login', method: 'POST',
      body: { azienda: 'aziendaA' }, headers: { origin: origine },
      verifica: r => r.status === 404 && nienteCookie(r) && protezioni(r) },
    { nome: 'header_inoltrati_pubblico', route: '/api/test/config', headers: falsificati, verifica: config },
    { ...negata('header_inoltrati_admin', '/api/admin'), headers: falsificati },
    { nome: 'cookie_bootstrap', route: '/api/auth/bootstrap', method: 'POST', body: {},
      headers: { origin: origine }, verifica: r => r.status === 200 && json(r)?.ok === true
        && cookieBootstrap(r.headers) && protezioni(r) },
    ...[undefined, 'https://estranea.invalid', 'null'].map((origin, i) => ({
      nome: ['origine_assente', 'origine_estranea', 'origine_null'][i],
      route: '/api/auth/bootstrap', method: 'POST', body: {},
      headers: origin === undefined ? {} : { origin },
      verifica: r => r.status === 403 && nienteCookie(r) })),
    { nome: 'host_estraneo', route: '/api/test/config', headers: { host: 'estranea.invalid' },
      // Il proxy può rifiutare il routing prima del guard AMR: non è una prova del guard.
      verifica: r => [403, 404, 421].includes(r.status) && nienteCookie(r) },
  ];
  for (const prova of prove) {
    const avvio = performance.now(); let status = null, codice = 'risposta_inattesa', ok = false;
    try { const r = await request(prova); status = r.status; ok = prova.verifica(r); }
    catch (e) {
      if (signal?.aborted) codice = 'interrotto';
      else if (totale.aborted || e.name === 'AbortError') codice = 'timeout';
      else if (['risposta_interrotta', 'risposta_troppo_grande'].includes(e.message)) codice = e.message;
      else if (['DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED'].includes(e.code)) codice = 'tls_non_valido';
      else if (e.code === 'HPE_HEADER_OVERFLOW') codice = 'header_troppo_grandi';
      else codice = 'rete_non_disponibile';
    }
    controlli.push({ nome: prova.nome, ok, status, codice: ok ? 'ok' : codice,
      durataMs: Math.round(performance.now() - avvio) });
    // Nessun retry o prosecuzione dopo un esito non verificato.
    if (!ok) break;
  }
  return { ok: controlli.length === prove.length && controlli.every(c => c.ok),
    controlli, durataMs: Math.round(performance.now() - inizio),
    nonVerificati: ['peer_proxy', 'cookie_sessione_mfa', 'auth_postgres', 'long_poll_deadline',
      'volume_uid', 'arresto_rollback', 'backup_esterno', 'ricerche'] };
}
if (require.main === module) {
  (async () => {
    if (process.argv.length !== 4 || process.argv[2] !== '--origine') throw new Error('argomenti_non_validi');
    const esito = await collaudaIngress({ origine: process.argv[3] });
    console.log(JSON.stringify(esito)); if (!esito.ok) process.exitCode = 1;
  })().catch(() => {
    console.error('Collaudo ingress non eseguito: usare --origine con una origine HTTPS esplicita.');
    process.exitCode = 1;
  });
}
module.exports = { collaudaIngress };
