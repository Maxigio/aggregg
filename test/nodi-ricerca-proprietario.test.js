'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { creaRicercaProprietario } = require('../backend/nodi/ricerca-proprietario');
const proprietario = '00000000-0000-4000-8000-000000000001';

test('ricerca proprietario: ID configurato, ruolo corrente e MFA; nessuna azienda commerciale', async () => {
  const s = { persona: proprietario, azienda: null }, originale = structuredClone(s);
  let c = { persona: proprietario, admin: true, mfa: true }, chiamate = 0;
  const p = creaRicercaProprietario({ identificatore: proprietario, accessi: {
    async verifica(ricevuta, options) {
      chiamate++; assert.equal(ricevuta, s); assert.deepEqual(options, { admin: true }); return c;
    },
  } });
  assert.deepEqual(await p.verifica(s, 'moto'), { persona: proprietario,
    azienda: 'diagnostica:' + proprietario, moduli: ['auto', 'moto'] });
  assert.deepEqual(s, originale);
  for (const patch of [{ admin: false }, { mfa: false }, { persona: 'altro' }]) {
    c = { persona: proprietario, admin: true, mfa: true, ...patch };
    await assert.rejects(p.verifica(s, 'auto'), e => e.status === 403);
  }
  const prima = chiamate;
  await assert.rejects(p.verifica({ persona: 'altro', admin: true, mfa: true }, 'moto'), e => e.status === 403);
  await assert.rejects(p.verifica(s, 'ricambi'), e => e.status === 403);
  assert.equal(chiamate, prima);
});

test('ricerca proprietario: configurazione assente nega; errori del provider non autorizzano', async () => {
  await assert.rejects(creaRicercaProprietario({}).verifica({ persona: proprietario }), e => e.status === 403);
  assert.throws(() => creaRicercaProprietario({ identificatore: proprietario }), /configurazione_proprietario_non_valida/);
  for (const identificatore of ['', 'mail@amr.invalid', '../path']) {
    assert.throws(() => creaRicercaProprietario({ identificatore, accessi: {} }), /configurazione_proprietario_non_valida/);
  }
  const p = creaRicercaProprietario({ identificatore: proprietario,
    accessi: { async verifica() { throw Object.assign(new Error('non disponibile'), { status: 503 }); } } });
  await assert.rejects(p.verifica({ persona: proprietario }), e => e.status === 503);
});
