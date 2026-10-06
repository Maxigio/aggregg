'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { preparaSchema, FILES } = require('../scripts/nhost/prepara-schema-staging');
const leggi = nome => fs.readFileSync(path.join(__dirname, '..', nome), 'utf8');
const release = 'a'.repeat(40);
test('pacchetto staging: undici migrazioni, una transazione, definizioni invariate e impronte verificabili', () => {
  const p = preparaSchema({ leggi, release });
  assert.equal(p.release, release); assert.equal(p.impronte.length, 11);
  assert.equal((p.sql.match(/^BEGIN;$/gm) || []).length, 1);
  assert.equal((p.sql.match(/^COMMIT;$/gm) || []).length, 1);
  let posizione = 0;
  for (const file of FILES) {
    const testo = leggi(file), i = p.sql.indexOf('-- ' + file + '\n', posizione);
    assert.ok(i > posizione); posizione = i;
    assert.ok(p.sql.includes(testo.replace(/^(?:BEGIN|COMMIT);\r?$/gm, '')));
    assert.equal(p.impronte.find(p => p.nome === file).sha256,
      crypto.createHash('sha256').update(testo).digest('hex'));
  }
  assert.match(p.sql, /SET LOCAL ROLE postgres;/);
  assert.doesNotMatch(p.sql, /PASSWORD\s+'/i);
});
test('pacchetto staging: wrapper SQL cambiati e release non valida vengono rifiutati', () => {
  for (const suffix of ['\nBEGIN;\n', '\nCOMMIT;\n']) {
    assert.throws(() => preparaSchema({ release, leggi: nome => leggi(nome) + suffix }),
      /transazione_schema_non_verificata/);
  }
  assert.throws(() => preparaSchema({ leggi, release: 'HEAD' }), /release_schema_non_valida/);
});
test('collaudo schema: checkout diverso da HEAD respinto prima di contattare PostgreSQL', async () => {
  let chiamate = 0;
  await assert.rejects(require('../scripts/collauda-schema-staging-locale').collaudaSchema({
    sql: async () => { chiamate++; }, leggi: nome => leggi(nome) + '\n-- differenza sintetica\n',
  }), /schema_checkout_diverso_dal_candidato/);
  assert.equal(chiamate, 0);
});
