'use strict';
const https = require('node:https');
const { isIP } = require('node:net');
const { origineValida } = require('./sonda-proxy-staging');

// Misura la sonda separata. Un esito positivo non abilita trust proxy in AMR.
async function misuraProxy({ origine, attese = false, ca, signal, timeoutMs = 5000,
  timeoutAtteseMs = 75000, totaleMs = 160000, minAtteseMs = [55000, 65000] } = {}) {
  const url = origineValida(origine);
  if (typeof attese !== 'boolean' || ![timeoutMs, timeoutAtteseMs, totaleMs].every(Number.isSafeInteger)
    || timeoutMs < 1 || timeoutMs > 5000 || timeoutAtteseMs < 1 || timeoutAtteseMs > 75000
    || totaleMs < 1 || totaleMs > 160000 || !Array.isArray(minAtteseMs) || minAtteseMs.length !== 2
    || minAtteseMs.some((n, i) => !Number.isSafeInteger(n) || n < 1 || n > [55000, 65000][i])) {
    throw new Error('limiti_non_validi');
  }
  const totale = AbortSignal.timeout(totaleMs);
  const interruzione = signal ? AbortSignal.any([signal, totale]) : totale;
  const falsi = { forwarded: 'for=192.0.2.1;proto=http;host=estranea.invalid',
    'x-forwarded-proto': 'http', 'x-forwarded-host': 'estranea.invalid',
    'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.2' };
  const prove = [
    { nome: 'liveness', route: '/healthz' }, { nome: 'normale', route: '/sonda/normale' },
    { nome: 'header', route: '/sonda/header', headers: falsi },
    { nome: 'origin', route: '/sonda/origin', headers: { origin: 'https://estranea.invalid' } },
    { nome: 'host', route: '/sonda/host', headers: { host: 'estranea.invalid' } },
    ...(attese ? [{ nome: 'attesa_55', route: '/sonda/attesa-55', lenta: true, minimoMs: minAtteseMs[0] },
      { nome: 'attesa_65', route: '/sonda/attesa-65', lenta: true, minimoMs: minAtteseMs[1] }] : []),
  ];
  function request(p) {
    return new Promise((resolve, reject) => {
      const avvio = performance.now();
      const req = https.request(new URL(p.route, url), { agent: false, ca, maxHeaderSize: 16384,
        servername: isIP(url.hostname) || url.hostname.startsWith('[') ? '' : url.hostname,
        rejectUnauthorized: true, signal: AbortSignal.any([interruzione,
          AbortSignal.timeout(p.lenta ? timeoutAtteseMs : timeoutMs)]),
        headers: { 'accept-encoding': 'identity', ...p.headers },
      }, res => {
        const headerMs = Math.round(performance.now() - avvio);
        let byte = 0; const parti = [];
        res.on('error', reject); res.on('aborted', () => reject(new Error('risposta_interrotta')));
        res.on('data', b => { byte += b.length;
          if (byte > 65536) req.destroy(new Error('risposta_troppo_grande')); else parti.push(b); });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
          body: Buffer.concat(parti).toString('utf8'), headerMs }));
      });
      req.on('error', reject); req.end();
    });
  }
  const controlli = [], avvio = performance.now(); let istanza;
  for (const p of prove) {
    const da = performance.now(); let ok = false, codice = 'risposta_inattesa', status = null, headerMs = null;
    try {
      const r = await request(p); status = r.status; headerMs = r.headerMs;
      if (r.headers['set-cookie'] !== undefined) codice = 'cookie_inatteso';
      else if (p.nome === 'host' && [403, 404, 421].includes(status)) { ok = true; codice = 'routing_negato'; }
      else if (status === 200 && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(r.headers['cache-control'] || '')) {
        if (p.nome === 'liveness') ok = r.body === 'ok';
        else {
          let b; try { b = JSON.parse(r.body); } catch {}
          ok = b?.ok === true && b.sonda === 'proxy-v1' && b.prova === p.nome
            && /^[a-f0-9]{16}$/.test(b.istanza)
            && Object.keys(b).sort().join(',') === 'istanza,ok,prova,sonda';
          if (ok && istanza && b.istanza !== istanza) { ok = false; codice = 'istanza_cambiata'; }
          if (ok && p.lenta && headerMs < p.minimoMs - Math.min(100, p.minimoMs / 10)) {
            ok = false; codice = 'header_anticipati';
          }
          if (ok) istanza = b.istanza;
        }
        if (ok) codice = 'misurato';
      }
    } catch (e) {
      codice = signal?.aborted ? 'interrotto' : totale.aborted || e.name === 'AbortError' ? 'timeout'
        : ['risposta_interrotta', 'risposta_troppo_grande'].includes(e.message) ? e.message
          : e.code === 'HPE_HEADER_OVERFLOW' ? 'header_troppo_grandi' : 'rete_o_tls';
    }
    controlli.push({ prova: p.nome, ok, codice, status, headerMs, durataMs: Math.round(performance.now() - da) });
    if (!ok) break;
  }
  return { ok: controlli.length === prove.length && controlli.every(p => p.ok), istanza,
    controlli, durataMs: Math.round(performance.now() - avvio),
    nonVerificati: ['fiducia_proxy', 'stabilita_peer', 'ricerca', 'auth', 'postgres', 'volume', 'rollback'] };
}
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (![2, 3].includes(args.length) || args[0] !== '--origine'
      || (args.length === 3 && args[2] !== '--attese')) throw new Error();
    const r = await misuraProxy({ origine: args[1], attese: args.length === 3 });
    console.log(JSON.stringify(r)); if (!r.ok) process.exitCode = 1;
  })().catch(() => { console.error('Usare --origine HTTPS esplicita e, facoltativamente, --attese.'); process.exitCode = 1; });
}
module.exports = { misuraProxy };
