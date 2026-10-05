'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { osservaPool } = require('../scripts/diagnostica-pg-collaudo');
const { DatabaseError } = require('pg');
const sql = 'SELECT amr_accessi.aziende_accetta($1::uuid,$2::text) AS risultato';

test('diagnostica PG: errore e parametri originali conservati, solo allowlist in output', async () => {
  const error = Object.assign(new DatabaseError('token-sentinella', 0, 'error'), { code: '23514',
    detail: 'email-sentinella', constraint: 'email-sentinella',
    where: 'PL/pgSQL function amr_accessi.aziende_accetta(uuid,text) line 41 at UPDATE\n'
      + 'PL/pgSQL function privata.email_sentinella(text) line 3 at RETURN' });
  const output = [], args = [], pool = { totalCount: 4, idleCount: 2, waitingCount: 1,
    query(...a) { args.push(a); return Promise.reject(error); } };
  const originale = pool.query;
  const ripristina = osservaPool(pool, { scrivi: e => output.push(e), adesso: () => 1 });
  const params = ['id-sentinella', 'token-sentinella'];
  await assert.rejects(pool.query(sql, params), e => e === error);
  assert.equal(args[0][1], params);
  assert.deepEqual(output, [{ operazione: 'aziende_accetta', tipo: 'server_sql', sqlstate: '23514', ms: 0,
    dominio: null, funzioni: [{ funzione: 'amr_accessi.aziende_accetta', riga: 41 }],
    pool: { totalCount: 4, idleCount: 2, waitingCount: 1 } }]);
  assert.doesNotMatch(JSON.stringify(output), /sentinella/);
  ripristina(); assert.equal(pool.query, originale);
});

test('diagnostica PG: EPIPE del socket non diventa un SQLSTATE', async () => {
  const error = Object.assign(new Error('socket-sentinella'), { code: 'EPIPE' });
  const output = [], pool = { query: () => Promise.reject(error) };
  osservaPool(pool, { scrivi: e => output.push(e) });
  await assert.rejects(pool.query(sql), e => e === error);
  assert.equal(output[0].tipo, 'client_non_classificato');
  assert.equal(output[0].sqlstate, null);
  assert.doesNotMatch(JSON.stringify(output), /sentinella/);
});

test('diagnostica PG: distingue timeout client senza SQLSTATE, Promise e callback', async () => {
  for (const [message, tipo] of [['Query read timeout', 'query_timeout'],
    ['timeout exceeded when trying to connect', 'pool_timeout'],
    ['Connection terminated due to connection timeout', 'pool_timeout'],
    ['messaggio-sentinella', 'client_non_classificato']]) {
    const error = new Error(message), output = [];
    const pool = { query(...args) {
      if (typeof args.at(-1) === 'function') { queueMicrotask(() => args.at(-1)(error)); return undefined; }
      return Promise.reject(error);
    } };
    osservaPool(pool, { scrivi: e => output.push(e) });
    await assert.rejects(pool.query(sql), e => e === error);
    await new Promise(resolve => { assert.equal(pool.query({ text: sql }, (e, result) => {
      assert.equal(e, error); assert.equal(result, undefined); resolve();
    }), undefined); });
    assert.equal(output.length, 2);
    assert.ok(output.every(e => e.tipo === tipo && e.sqlstate === null));
    assert.doesNotMatch(JSON.stringify(output), /sentinella/);
  }
});

test('diagnostica PG: successo, query estranee e reporter fallito non cambiano il contratto', async () => {
  let chiamate = 0;
  const result = { rows: [{ risultato: { ok: true } }] };
  const error = new Error('Query read timeout');
  const pool = { query(testo) { return testo === 'fallisci' ? Promise.reject(error) : Promise.resolve(result); } };
  osservaPool(pool, { scrivi: () => { chiamate++; throw new Error('reporter non disponibile'); } });
  assert.equal(await pool.query(sql), result);
  await assert.rejects(pool.query('fallisci'), e => e === error);
  assert.equal(chiamate, 0);
  const poolErrore = { query() { return Promise.reject(error); } };
  osservaPool(poolErrore, { scrivi: () => { chiamate++; throw new Error('reporter non disponibile'); } });
  await assert.rejects(poolErrore.query(sql), e => e === error);
  assert.equal(chiamate, 1);
});
