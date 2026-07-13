'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { deriveCtx, cleanHistory } = require('../backend/assistant/assistant');

// deriveCtx: la categoria (dai bottoni) → contesto deterministico. Niente inferenza LLM.
test('deriveCtx: auto/moto → cerca_veicoli col tipo giusto', () => {
  assert.deepStrictEqual(deriveCtx({ categoria: 'auto' }), { categoria: 'auto', kind: 'veicoli', tipo: 'auto' });
  assert.deepStrictEqual(deriveCtx({ categoria: 'moto' }), { categoria: 'moto', kind: 'veicoli', tipo: 'moto' });
});

test('deriveCtx: ricambio → veicolo + mode da OEM sì/no', () => {
  assert.deepStrictEqual(deriveCtx({ categoria: 'ricambio_auto', oem: true }), { categoria: 'ricambio_auto', kind: 'ricambio', veicolo: 'auto', mode: 'oem' });
  assert.deepStrictEqual(deriveCtx({ categoria: 'ricambio_moto', oem: false }), { categoria: 'ricambio_moto', kind: 'ricambio', veicolo: 'moto', mode: 'nome' });
  assert.deepStrictEqual(deriveCtx({ categoria: 'ricambio_moto' }), { categoria: 'ricambio_moto', kind: 'ricambio', veicolo: 'moto', mode: 'nome' });
});

test('deriveCtx: categoria ignota/assente → default auto (nessun crash)', () => {
  assert.deepStrictEqual(deriveCtx({}), { categoria: 'auto', kind: 'veicoli', tipo: 'auto' });
  assert.deepStrictEqual(deriveCtx({ categoria: 'boh' }), { categoria: 'auto', kind: 'veicoli', tipo: 'auto' });
});

// cleanHistory: Anthropic esige tool_use↔tool_result appaiati e vieta tool_result orfano in testa.
test('cleanHistory: vuoto → []', () => {
  assert.deepStrictEqual(cleanHistory([]), []);
});

test('cleanHistory: finisce con assistant text-only → invariato', () => {
  const h = [
    { role: 'user', content: 'ciao' },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ];
  assert.deepStrictEqual(cleanHistory(h), h);
});

test('cleanHistory: coda con tool_use non risposto → tronca all\'ultimo turno pulito', () => {
  const h = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'cerca_veicoli', input: {} }] },
  ];
  const out = cleanHistory(h);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[out.length - 1].content[0].type, 'text');   // niente tool_use orfano in coda
});

test('cleanHistory: scarta i leading finché il primo non è un turno utente (user string)', () => {
  const h = [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'orfano' }] },  // orfano in testa
    { role: 'assistant', content: [{ type: 'text', text: 'r' }] },
  ];
  const out = cleanHistory(h);
  assert.strictEqual(out.length, 0);   // nessun user-string valido → tutto scartato (no 400)
});
