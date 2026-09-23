'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('lo specchio non assegna all’owner la password di un iscritto sull’altra macchina', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-sync-'));
  const locale = path.join(root, 'locale');
  const remoto = path.join(root, 'remoto');
  fs.mkdirSync(locale); fs.mkdirSync(remoto);
  const precedente = process.env.USER_DATA_PATH;
  const auth = require('../backend/auth');
  const { pianifica, applica } = require('../scripts/utenti-da-env');
  try {
    process.env.USER_DATA_PATH = locale;
    auth.setPassword('vecchio-owner-123');
    const prima = fs.readFileSync(path.join(locale, 'auth.json'));
    process.env.USER_DATA_PATH = remoto;
    auth.setPassword('owner-remoto-123');
    auth.creaPersona('Iscritto Web', 'nuovo-owner-123');
    const primaRemoto = fs.readFileSync(path.join(remoto, 'auth.json'));
    process.env.USER_DATA_PATH = locale;

    assert.throws(() => applica(pianifica({ AMR_ADMIN_PASSWORD: 'nuovo-owner-123' }),
      { AMR_AUTH_ANCHE: remoto }), /password.*gia|collisione|occupata/i);
    assert.deepStrictEqual(fs.readFileSync(path.join(locale, 'auth.json')), prima,
      'la collisione deve essere scoperta prima di cambiare la password locale');
    assert.deepStrictEqual(fs.readFileSync(path.join(remoto, 'auth.json')), primaRemoto);

    assert.throws(() => applica(pianifica({
      AMR_ADMIN_PASSWORD: 'altro-owner-123',
      AMR_UTENTE_01: 'Iscritto Web:collega-nuovo-123',
    }), { AMR_AUTH_ANCHE: remoto }), /id.*iscritto web/i);
    assert.deepStrictEqual(fs.readFileSync(path.join(locale, 'auth.json')), prima);
  } finally {
    if (precedente == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = precedente;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
