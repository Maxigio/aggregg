'use strict';
const path = require('node:path');

// Configurazione esplicita dell'entrypoint remoto. Nessun .env caricato qui.
function configura(env) {
  const errore = () => { throw new Error('configurazione_centro_run_non_valida'); };
  const proprietarioId = env.AMR_CENTRO_PROPRIETARIO_ID ?? null;
  if (proprietarioId !== null && !require('./ricerca-proprietario').idValido(proprietarioId)) errore();
  const intero = (nome, defaultValue, max) => {
    const n = Number(env[nome] ?? defaultValue);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) errore();
    return n;
  };
  let origine, auth, tokens;
  try { origine = new URL(env.AMR_CENTRO_ORIGINE); auth = new URL(env.AMR_NHOST_AUTH_URL);
    tokens = JSON.parse(env.AMR_NODI_TOKENS || 'null'); } catch { errore(); }
  if (origine.protocol !== 'https:' || origine.origin !== env.AMR_CENTRO_ORIGINE
    || origine.username || origine.password || auth.protocol !== 'https:' || auth.username || auth.password
    || auth.search || auth.hash || auth.pathname !== '/v1') errore();
  if (!tokens || Array.isArray(tokens) || typeof tokens !== 'object' || !Object.keys(tokens).length
    || Object.entries(tokens).some(([id,t])=>!/^[a-zA-Z0-9_-]{1,40}$/.test(id)
      || typeof t !== 'string' || !/^[a-f0-9]{64}$/.test(t))) errore();
  if (new Set(Object.values(tokens)).size !== Object.keys(tokens).length) errore();
  for (const nome of ['AMR_NODI_RELEASE_FILE','AMR_NODI_DATA_DIR']) {
    if (!path.isAbsolute(env[nome] || '')) errore();
  }
  // Un solo scheduler e sessioni RAM: vietato uno scaling non ancora implementato.
  if (env.AMR_CENTRO_REPLICHE !== '1') errore();
  const proxy = (env.AMR_CENTRO_PROXY_IP || '').split(',').map(s=>s.trim()).filter(Boolean);
  if (!proxy.length || proxy.some(v=>require('node:net').isIP(v)===0)) errore();
  const pgHost = env.AMR_PG_HOST;
  if (typeof pgHost !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(pgHost)
    || !/^[a-zA-Z0-9_-]{1,63}$/.test(env.AMR_PG_DATABASE || '')) errore();
  const privatePg = env.AMR_PG_RETE_PRIVATA === '1';
  // Nhost documenta postgres-service; postgres resta la fixture Docker locale.
  if (privatePg && !['postgres-service','postgres'].includes(pgHost)) errore();
  const pools = {};
  for (const ruolo of ['LETTURA','COMMERCIALE','BACKUP']) {
    const user = env['AMR_PG_'+ruolo+'_USER'], password = env['AMR_PG_'+ruolo+'_PASSWORD'];
    if (!/^[a-zA-Z0-9_-]{1,63}$/.test(user || '') || typeof password !== 'string' || password.length < 16) errore();
    pools[ruolo.toLowerCase()] = { host:pgHost,port:intero('AMR_PG_PORT',5432,65535),
      database:env.AMR_PG_DATABASE,user,password,max:ruolo==='BACKUP'?2:4,
      ssl:privatePg?false:{rejectUnauthorized:true},
      statement_timeout:2500,lock_timeout:1500,connectionTimeoutMillis:2000,query_timeout:3000 };
  }
  if (new Set(Object.values(pools).map(p=>p.user)).size!==3) errore();
  return {origine:origine.origin,auth:auth.href,proxy,tokens,pools,proprietarioId,
    port:intero('PORT',3000,65535),directory:env.AMR_NODI_DATA_DIR,releaseFile:env.AMR_NODI_RELEASE_FILE,
    timeoutRicercaMs:intero('AMR_NODI_RICERCA_TIMEOUT_MS',60000,300000),
    maxPersona:intero('AMR_NODI_RICERCHE_MAX_PERSONA',2,60),maxTotale:intero('AMR_NODI_RICERCHE_MAX_TOTALE',60,300)};
}
module.exports = { configura };
