'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { preparaSchema } = require('./nhost/prepara-schema-staging');

// Solo il cluster sintetico del launcher: il nome non è un login cloud.
async function collaudaSchema({ sql, controprove = true,
  leggi = nome => fs.readFileSync(path.join(__dirname, '..', nome), 'utf8') }) {
  let atteso;
  try { atteso = preparaSchema(); }
  catch { throw new Error('schema_checkout_diverso_dal_candidato'); }
  const pacchetto = preparaSchema({ release: atteso.release, leggi });
  assert.deepEqual(pacchetto.impronte, atteso.impronte, 'schema_checkout_diverso_dal_candidato');
  await sql(`CREATE ROLE installatore_prova NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT postgres TO installatore_prova WITH INHERIT FALSE, SET TRUE;`);
  const installa = testo => sql('SET SESSION AUTHORIZATION installatore_prova;\n' + testo
    + '\nSELECT current_user;\nRESET SESSION AUTHORIZATION;');
  if (controprove) {
    await assert.rejects(installa('CREATE ROLE amr_vietato;'), { code: '42501' });
    const guasto = pacchetto.sql.replace(/COMMIT;\n$/, 'SELECT 1 / 0;\nCOMMIT;\n');
    await assert.rejects(installa(guasto), { code: '22012' });
    assert.equal(await sql("SELECT count(*) FROM pg_namespace WHERE nspname='amr_accessi';"), '0');
    assert.equal(await sql("SELECT count(*) FROM pg_roles WHERE left(rolname,4)='amr_';"), '0');
    await sql('CREATE SCHEMA amr_accessi;');
    await assert.rejects(installa(pacchetto.sql), { code: 'P0001' });
    assert.equal(await sql("SELECT count(*) FROM pg_roles WHERE left(rolname,4)='amr_';"), '0');
    await sql('DROP SCHEMA amr_accessi;');
  }
  const risultato = await installa(pacchetto.sql);
  assert.equal(risultato, 'installatore_prova');
  assert.equal(await sql(`SELECT count(*) FROM pg_roles WHERE rolname IN ('amr_gateway','amr_commerciale','amr_copie')
    AND NOT (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);`), '3');
  for (const ruolo of ['amr_gateway', 'amr_commerciale', 'amr_copie']) {
    const come = query => sql('SET SESSION AUTHORIZATION ' + ruolo + ';\n' + query);
    for (const query of ['SET ROLE postgres;', 'SET ROLE amr_aziende_definitore;',
      'SELECT * FROM auth.users;', 'SELECT * FROM amr_accessi.persone;', 'SELECT * FROM amr_backup.outbox;',
      'CREATE TABLE amr_accessi.vietata(id int);']) {
      await assert.rejects(come(query), { code: '42501' });
    }
  }
  assert.equal(await sql("SELECT has_function_privilege('amr_gateway','amr_accessi.identita(uuid)','EXECUTE');"), 't');
  assert.equal(await sql("SELECT has_function_privilege('amr_commerciale','amr_accessi.aziende_elenco(uuid,integer,boolean)','EXECUTE');"), 't');
  assert.equal(await sql("SELECT has_function_privilege('amr_copie','amr_backup.claim(integer)','EXECUTE');"), 't');
  assert.equal(await sql(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
    LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE n.nspname IN ('amr_accessi','amr_backup') AND a.grantee=0 AND a.privilege_type='EXECUTE';`), '0');
  return 'Installazione PG18: percorso installatore → SET LOCAL ROLE, rollback totale, rifiuto DB esistente e tre ruoli minimi senza LOGIN; nessuna funzione AMR pubblica';
}
module.exports = { collaudaSchema };
