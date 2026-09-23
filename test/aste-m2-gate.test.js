'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('senza opt-in locale, le Aste non hanno né pulsante né API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'amr-aste-off-'));
  const prevData = process.env.USER_DATA_PATH;
  const prevFlag = process.env.AMR_ASTE_LOCALE;
  process.env.USER_DATA_PATH = dir;
  delete process.env.AMR_ASTE_LOCALE;
  let server;
  try {
    const app = require('../backend/server').app;
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const html = await (await fetch(base + '/')).text();
    assert.doesNotMatch(html, /data-mode="aste"|id="astePanel"/);
    for (const percorso of ['//index.html', '/%69ndex.html']) {
      const variante = await (await fetch(base + percorso)).text();
      assert.doesNotMatch(variante, /data-mode="aste"|id="astePanel"/, percorso);
    }
    assert.strictEqual((await fetch(base + '/api/aste')).status, 404);
    assert.strictEqual((await fetch(base + '/api/aste/filtri')).status, 404);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (prevData == null) delete process.env.USER_DATA_PATH; else process.env.USER_DATA_PATH = prevData;
    if (prevFlag == null) delete process.env.AMR_ASTE_LOCALE; else process.env.AMR_ASTE_LOCALE = prevFlag;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
