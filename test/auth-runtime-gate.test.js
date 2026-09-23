'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('un auth.json configurato che sparisce chiude le API fino al ripristino', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-auth-http-'));
  const prima = process.env.USER_DATA_PATH;
  process.env.USER_DATA_PATH = dir;
  let server;
  try {
    const auth = require('../backend/auth');
    auth.setPassword('password-di-prova-123');
    const file = path.join(dir, 'auth.json');
    const copia = fs.readFileSync(file);
    const app = require('../backend/server').app;
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/me`;

    assert.equal((await fetch(url)).status, 401);
    fs.unlinkSync(file);
    assert.equal((await fetch(url)).status, 503);
    fs.writeFileSync(file, copia);
    assert.equal((await fetch(url)).status, 401);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (prima == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prima;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
