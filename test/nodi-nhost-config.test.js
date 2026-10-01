'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configura, totp } = require('../scripts/collauda-nhost-locale');

test('collaudo Nhost: soltanto Auth e mail locali sono pubblicati, nessun file host montato', () => {
  const c = configura({ password: 'sintetica', jwt: 'sintetico', admin: 'sintetico' });
  for (const [nome, servizio] of Object.entries(c.services)) {
    assert.ok(!servizio.volumes?.length);
    if (['postgres', 'graphql'].includes(nome)) assert.ok(!servizio.ports?.length);
    for (const porta of servizio.ports || []) assert.match(porta, /^127\.0\.0\.1:0:/);
  }
  assert.deepEqual(c.services.postgres.tmpfs, ['/var/lib/postgresql/data']);
});

test('collaudo Nhost: verifica email, MFA e destinatari SMTP soltanto locali', () => {
  const env = configura({ password: 'sintetica', jwt: 'sintetico', admin: 'sintetico' }).services.auth.environment;
  assert.equal(env.AUTH_EMAIL_SIGNIN_EMAIL_VERIFIED_REQUIRED, 'true');
  assert.equal(env.AUTH_MFA_ENABLED, 'true');
  assert.equal(env.AUTH_ANONYMOUS_USERS_ENABLED, 'false');
  assert.equal(env.AUTH_SMTP_HOST, 'localhost');
  assert.equal(configura({}).services.auth.network_mode, 'service:mail');
  assert.equal(env.AUTH_GRAVATAR_ENABLED, 'false');
  assert.equal(env.AUTH_PASSWORD_HIBP_ENABLED, 'false');
});

test('il generatore TOTP di prova rispetta il vettore RFC 6238 SHA1 a 59 secondi', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});
