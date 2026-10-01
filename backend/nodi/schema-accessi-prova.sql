-- Schema del collaudo con Auth reale: nessuna importazione dei dati di produzione.
CREATE SCHEMA amr_accessi;
REVOKE ALL ON SCHEMA amr_accessi FROM PUBLIC;
CREATE TABLE amr_accessi.persone (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  attiva boolean NOT NULL DEFAULT true,
  admin boolean NOT NULL DEFAULT false,
  epoca integer NOT NULL DEFAULT 0 CHECK (epoca >= 0)
);
CREATE TABLE amr_accessi.aziende (
  id text PRIMARY KEY CHECK (id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  attiva boolean NOT NULL DEFAULT true,
  scadenza timestamptz NOT NULL,
  moduli text[] NOT NULL CHECK (cardinality(moduli) BETWEEN 1 AND 2 AND moduli <@ ARRAY['auto','moto']::text[])
);
CREATE TABLE amr_accessi.membri (
  persona uuid PRIMARY KEY REFERENCES amr_accessi.persone(id),
  azienda text NOT NULL REFERENCES amr_accessi.aziende(id)
);
REVOKE ALL ON ALL TABLES IN SCHEMA amr_accessi FROM PUBLIC;

-- Il processo legge solo l'esito dei permessi; non ottiene password/hash o email.
CREATE FUNCTION amr_accessi.identita(persona_id uuid)
RETURNS TABLE (attiva boolean, admin boolean, epoca integer, azienda text,
  azienda_valida boolean, moduli text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p.attiva AND u.email_verified AND NOT u.disabled,
    p.admin, p.epoca, a.id,
    COALESCE(a.attiva AND a.scadenza > statement_timestamp(), false),
    COALESCE(a.moduli, ARRAY[]::text[])
  FROM amr_accessi.persone p JOIN auth.users u ON u.id=p.id
  LEFT JOIN amr_accessi.membri m ON m.persona=p.id
  LEFT JOIN amr_accessi.aziende a ON a.id=m.azienda
  WHERE p.id=persona_id
$$;
REVOKE ALL ON FUNCTION amr_accessi.identita(uuid) FROM PUBLIC;
CREATE ROLE amr_accessi_lettore NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA amr_accessi TO amr_accessi_lettore;
GRANT EXECUTE ON FUNCTION amr_accessi.identita(uuid) TO amr_accessi_lettore;
