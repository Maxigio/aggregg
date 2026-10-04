'use strict';
const path = require('node:path'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const FILES = Object.freeze(['accessi-prova', 'aziende-prova', 'inviti-consegna',
  'rinnovi-prova', 'rinnovi-datestyle', 'colleghi-prova', 'backup-prova', 'ripristino-sequenza']
  .map(nome => 'backend/nodi/schema-' + nome + '.sql'));

// Solo prima installazione: nessuna connessione, password o applicazione automatica.
// Le definizioni provengono da un solo commit; non sono un parser di SQL arbitrario.
function preparaSchema({ leggi, release } = {}) {
  if (!leggi) {
    const cwd = path.resolve(__dirname, '../..');
    release = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, encoding: 'utf8' }).trim();
    leggi = nome => execFileSync('git', ['show', release + ':' + nome],
      { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw new Error('release_schema_non_valida');
  const impronte = [];
  const parti = FILES.map((nome, i) => {
    const testo = leggi(nome);
    const begin = [...testo.matchAll(/^BEGIN;\r?$/gm)], commit = [...testo.matchAll(/^COMMIT;\r?$/gm)];
    if (begin.length !== (i === 0 ? 0 : 1) || commit.length !== begin.length) {
      throw new Error('transazione_schema_non_verificata');
    }
    impronte.push({ nome, sha256: crypto.createHash('sha256').update(testo).digest('hex') });
    return '-- ' + nome + '\n' + testo.replace(/^(?:BEGIN|COMMIT);\r?$/gm, '');
  });
  const sql = '-- Prima installazione AMR; release ' + release + '\n'
    + impronte.map(p => '-- ' + p.nome + ' sha256 ' + p.sha256).join('\n') + `
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $amr_preflight$
BEGIN
  IF current_setting('server_version_num')::int / 10000 <> 18 THEN
    RAISE EXCEPTION 'amr_schema_versione_non_verificata';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('amr_accessi','amr_backup','amr_ripristino'))
      OR EXISTS (SELECT 1 FROM pg_roles WHERE left(rolname,4)='amr_') THEN
    RAISE EXCEPTION 'amr_schema_installazione_non_vuota';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'
      AND ((column_name='id' AND udt_name='uuid' AND udt_schema='pg_catalog')
        OR (column_name='email' AND udt_name='citext' AND udt_schema='public')
        OR (column_name IN ('email_verified','disabled') AND udt_name='bool' AND udt_schema='pg_catalog'))) <> 4
      OR to_regclass('auth.refresh_tokens') IS NULL THEN
    RAISE EXCEPTION 'amr_schema_auth_non_verificato';
  END IF;
END $amr_preflight$;
` + parti.join('\n') + `
-- Preparati senza accesso: password e LOGIN saranno configurati separatamente.
CREATE ROLE amr_gateway NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE amr_commerciale NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE amr_copie NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT amr_accessi_lettore TO amr_gateway WITH INHERIT TRUE, SET FALSE;
GRANT amr_aziende_scrittore, amr_colleghi_scrittore TO amr_commerciale WITH INHERIT TRUE, SET FALSE;
GRANT amr_backup_esecutore TO amr_copie WITH INHERIT TRUE, SET FALSE;
COMMIT;
`;
  return { release, impronte, sql };
}
if (require.main === module) {
  try { process.stdout.write(preparaSchema().sql); }
  catch { console.error('Pacchetto SQL non preparato: verificare commit e definizioni.'); process.exitCode = 1; }
}
module.exports = { preparaSchema, FILES };
