-- Eseguire nell'editor SQL con «Read only» attivo e «Track this» disattivo.
-- Solo metadati: nessuna riga di utenti, token, aziende o annunci.
SELECT jsonb_build_object(
  'postgres_version', current_setting('server_version'),
  'database', current_database(),
  'installatore', current_user,
  'puo_assumere_postgres', pg_has_role(current_user, 'postgres', 'SET'),
  'capacita_postgres', (
    SELECT jsonb_build_object('superuser', rolsuper, 'createrole', rolcreaterole,
      'createdb', rolcreatedb, 'bypassrls', rolbypassrls)
    FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  ),
  'capacita_installatore', (
    SELECT jsonb_build_object('superuser', rolsuper, 'createrole', rolcreaterole,
      'createdb', rolcreatedb, 'bypassrls', rolbypassrls)
    FROM pg_catalog.pg_roles WHERE rolname = current_user
  ),
  'schemi_amr_presenti', (
    SELECT coalesce(jsonb_agg(nspname ORDER BY nspname), '[]'::jsonb)
    FROM pg_catalog.pg_namespace
    WHERE nspname IN ('amr_accessi', 'amr_aziende', 'amr_colleghi', 'amr_backup')
  ),
  'colonne_auth_richieste', (
    SELECT coalesce(jsonb_agg(jsonb_build_object('nome', column_name, 'tipo', data_type,
      'tipo_schema', udt_schema, 'tipo_nome', udt_name)
      ORDER BY column_name), '[]'::jsonb)
    FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name IN ('id', 'email', 'email_verified', 'disabled')
  ),
  'tabelle_auth_recovery', (
    SELECT coalesce(jsonb_agg(relname ORDER BY relname), '[]'::jsonb)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relkind IN ('r', 'p')
      AND c.relname IN ('refresh_tokens', 'refresh_token_sessions', 'oauth2_refresh_tokens')
  ),
  'ruoli_amr_presenti', (
    SELECT coalesce(jsonb_agg(rolname ORDER BY rolname), '[]'::jsonb)
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('amr_gateway', 'amr_commerciale', 'amr_copie',
      'amr_accessi_lettore', 'amr_aziende_definitore', 'amr_aziende_scrittore',
      'amr_colleghi_definitore', 'amr_colleghi_scrittore',
      'amr_backup_definitore', 'amr_backup_esecutore')
  )
) AS inventario;
