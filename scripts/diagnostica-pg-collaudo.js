'use strict';
const { performance } = require('node:perf_hooks');
const { DatabaseError } = require('pg');
const OPERAZIONI = new Set(['aziende_invita', 'aziende_accetta', 'aziende_attiva']);
const FUNZIONI = new Set(['amr_accessi.aziende_invita', 'amr_accessi.aziende_accetta',
  'amr_accessi.aziende_attiva', 'amr_accessi.aziende_blocca', 'amr_accessi.aziende_admin',
  'amr_accessi.aziende_limite', 'amr_accessi.aziende_posti',
  'amr_accessi.colleghi_quota', 'amr_accessi.colleghi_posti', 'amr_backup.accoda_operazione']);
const DOMINI = new Set(['operazione_non_disponibile', 'invito_non_valido', 'referente_non_valido',
  'quota_persone', 'quota_aziende', 'appartenenza_esistente', 'azienda_non_pronta']);
const VINCOLI = new Set(['aziende_prova_stato', 'aziende_inviti_check',
  'aziende_inviti_check1', 'aziende_inviti_check2']);

// Osserva esclusivamente il pool della fixture, prima che il dominio mascheri
// gli errori. Nessuna query aggiuntiva, lettura dei parametri o diagnostica raw.
function osservaPool(pool, { scrivi, adesso = () => performance.now() }) {
  const originale = pool.query;
  function query(...args) {
    const testo = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    const operazione = /^SELECT amr_accessi\.([a-z_]+)\(/.exec(testo || '')?.[1];
    if (!OPERAZIONI.has(operazione)) return originale.apply(this, args);
    const iniziata = adesso();
    function segnala(e) {
      try {
        const sqlstate = e instanceof DatabaseError && /^[0-9A-Z]{5}$/.test(e.code) ? e.code : null;
        const tipo = sqlstate ? 'server_sql'
          : e?.message === 'Query read timeout' ? 'query_timeout'
          : ['timeout exceeded when trying to connect', 'Connection terminated due to connection timeout']
            .includes(e?.message) ? 'pool_timeout' : 'client_non_classificato';
        const contesto = typeof e?.where === 'string' ? e.where.slice(0, 4096) : '';
        const funzioni = [...contesto.matchAll(/PL\/pgSQL function ([a-z_0-9.]+)\([^\n]*\) line (\d+)/gi)]
          .filter(m => FUNZIONI.has(m[1])).slice(0, 8)
          .map(m => ({ funzione: m[1], riga: Number(m[2]) }));
        const contatori = {};
        for (const nome of ['totalCount', 'idleCount', 'waitingCount']) {
          if (Number.isSafeInteger(pool[nome]) && pool[nome] >= 0) contatori[nome] = pool[nome];
        }
        scrivi({ operazione, tipo, sqlstate, ms: Math.max(0, Math.round(adesso() - iniziata)),
          dominio: DOMINI.has(e?.message) ? e.message : null,
          vincolo: sqlstate && VINCOLI.has(e?.constraint) ? e.constraint : null,
          funzioni, pool: contatori });
      } catch { /* La diagnostica non cambia mai l'esito della query. */ }
    }
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = function (e, ...valori) {
        if (e) segnala(e);
        return callback.call(this, e, ...valori);
      };
      return originale.apply(this, args);
    }
    try {
      return originale.apply(this, args).catch(e => { segnala(e); throw e; });
    } catch (e) { segnala(e); throw e; }
  }
  pool.query = query;
  return () => { if (pool.query === query) pool.query = originale; };
}
module.exports = { osservaPool };
