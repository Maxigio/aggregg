-- Checkpoint del login prima di Auth; nessun backfill o reset delle epoche.
BEGIN;
CREATE ROLE amr_login_definitore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA amr_accessi, auth TO amr_login_definitore;
GRANT SELECT(id,email) ON auth.users TO amr_login_definitore;
GRANT SELECT(id,epoca) ON amr_accessi.persone TO amr_login_definitore;

CREATE FUNCTION amr_accessi.inizio_login(p_email text)
RETURNS TABLE(persona uuid,epoca integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $$
  WITH candidati AS (
    SELECT u.id, count(u.id) OVER () AS quanti
    FROM auth.users u
    WHERE char_length(p_email) BETWEEN 1 AND 254
      AND lower(u.email::text)=lower(p_email)
  )
  SELECT c.id,p.epoca
  FROM candidati c JOIN amr_accessi.persone p ON p.id=c.id
  WHERE c.quanti=1
$$;
REVOKE ALL ON FUNCTION amr_accessi.inizio_login(text) FROM PUBLIC;
GRANT CREATE ON SCHEMA amr_accessi TO amr_login_definitore;
ALTER FUNCTION amr_accessi.inizio_login(text) OWNER TO amr_login_definitore;
REVOKE CREATE ON SCHEMA amr_accessi FROM amr_login_definitore;
GRANT EXECUTE ON FUNCTION amr_accessi.inizio_login(text) TO amr_accessi_lettore;
COMMIT;
