-- Incremento locale PG16, dopo schema-accessi-prova.sql; nessun dato commerciale.
-- Applicare come installatore fidato, MAI come credenziale del processo web.
-- Non modifica identita() né il default attiva delle fixture preesistenti.
BEGIN;

ALTER TABLE amr_accessi.aziende
  ADD COLUMN nome text CHECK (nome IS NULL OR
    (char_length(nome) BETWEEN 1 AND 80 AND nome = btrim(nome)
      AND nome !~ '[[:cntrl:]]')),
  ADD COLUMN referente uuid,
  ADD COLUMN accettata_il timestamptz,
  ADD COLUMN attivata_il timestamptz,
  ADD CONSTRAINT aziende_prova_stato CHECK (nome IS NULL OR (
    (referente IS NULL) = (accettata_il IS NULL)
    AND (attivata_il IS NULL OR accettata_il IS NOT NULL)
    AND attiva = (attivata_il IS NOT NULL)
    AND (attivata_il IS NULL OR
      (attivata_il >= accettata_il AND scadenza > attivata_il))));
ALTER TABLE amr_accessi.membri ADD CONSTRAINT membri_persona_azienda
  UNIQUE (persona, azienda);
ALTER TABLE amr_accessi.aziende ADD CONSTRAINT aziende_referente_membro
  FOREIGN KEY (referente, id) REFERENCES amr_accessi.membri(persona, azienda)
  DEFERRABLE INITIALLY DEFERRED;

-- ponytail: lock globale; tetto intenzionale di 10 aziende / 3 posti ciascuna.
-- Incrementare la versione protegge anche da snapshot REPEATABLE READ obsoleti.
CREATE TABLE amr_accessi.aziende_quota (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  versione bigint NOT NULL DEFAULT 0 CHECK (versione >= 0)
);
INSERT INTO amr_accessi.aziende_quota(id) VALUES (true);
CREATE TABLE amr_accessi.aziende_inviti (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  azienda text NOT NULL UNIQUE REFERENCES amr_accessi.aziende(id),
  email text NOT NULL CHECK (char_length(email) <= 254
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    AND email !~ '[[:cntrl:]]'),
  impronta text NOT NULL UNIQUE CHECK (impronta ~ '^[a-f0-9]{64}$'),
  -- Il primo referente prenota il posto 1; nessun invito colleghi in questo slice.
  posto smallint NOT NULL DEFAULT 1 CHECK (posto = 1),
  creata_il timestamptz NOT NULL,
  scadenza timestamptz NOT NULL CHECK (scadenza > creata_il),
  persona uuid,
  accettata_il timestamptz,
  CHECK ((persona IS NULL) = (accettata_il IS NULL)),
  CHECK (accettata_il IS NULL OR
    (accettata_il >= creata_il AND accettata_il < scadenza)),
  FOREIGN KEY (persona, azienda) REFERENCES amr_accessi.membri(persona, azienda)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE amr_accessi.aziende_operazioni (
  id uuid PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('invita', 'accetta', 'attiva')),
  azienda text NOT NULL REFERENCES amr_accessi.aziende(id),
  attore uuid NOT NULL REFERENCES amr_accessi.persone(id),
  confermata_il timestamptz NOT NULL,
  -- Solo metadata transazionali: niente email, password, token, hash o annunci.
  backup_stato text NOT NULL DEFAULT 'pending' CHECK (backup_stato = 'pending'),
  backup_destinazione text NOT NULL DEFAULT 'non_configurata'
    CHECK (backup_destinazione = 'non_configurata')
);
REVOKE ALL ON amr_accessi.aziende_quota, amr_accessi.aziende_inviti,
  amr_accessi.aziende_operazioni FROM PUBLIC;

CREATE ROLE amr_aziende_definitore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE amr_aziende_scrittore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA amr_accessi, auth TO amr_aziende_definitore;
-- UPDATE(id) serve solo ai lock FOR SHARE; nessun accesso a password/hash Auth.
GRANT SELECT(id, email, email_verified, disabled), UPDATE(id)
  ON auth.users TO amr_aziende_definitore;
GRANT SELECT, INSERT(id), UPDATE(id) ON amr_accessi.persone TO amr_aziende_definitore;
GRANT SELECT, INSERT ON amr_accessi.membri TO amr_aziende_definitore;
GRANT SELECT, INSERT, UPDATE(attiva, scadenza, referente, accettata_il, attivata_il)
  ON amr_accessi.aziende TO amr_aziende_definitore;
GRANT SELECT, INSERT, UPDATE(persona, accettata_il)
  ON amr_accessi.aziende_inviti TO amr_aziende_definitore;
GRANT SELECT, INSERT ON amr_accessi.aziende_operazioni TO amr_aziende_definitore;
GRANT SELECT, UPDATE(versione) ON amr_accessi.aziende_quota TO amr_aziende_definitore;

CREATE FUNCTION amr_accessi.aziende_blocca() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE amr_accessi.aziende_quota SET versione = versione + 1 WHERE id = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'operazione_non_disponibile', ERRCODE = 'P0001';
  END IF;
END
$$;

CREATE FUNCTION amr_accessi.aziende_admin(p_persona uuid, p_epoca integer, p_mfa boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_epoca integer;
BEGIN
  IF p_mfa IS DISTINCT FROM true OR p_epoca IS NULL OR p_epoca < 0 THEN
    RAISE EXCEPTION USING MESSAGE = 'accesso_non_autorizzato', ERRCODE = 'P0001';
  END IF;
  -- Lock condivisi fino al commit: attendere revoche in corso e rileggere lo stato.
  SELECT p.epoca INTO v_epoca FROM amr_accessi.persone p
    JOIN auth.users u ON u.id = p.id
    WHERE p.id = p_persona AND p.attiva AND p.admin
      AND u.email_verified AND NOT u.disabled
    FOR SHARE OF p, u;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'accesso_non_autorizzato', ERRCODE = 'P0001';
  END IF;
  IF v_epoca <> p_epoca THEN
    RAISE EXCEPTION USING MESSAGE = 'sessione_revocata', ERRCODE = 'P0001';
  END IF;
END
$$;

-- Vincoli di quota anche su INSERT/UPDATE privilegiati e fixture legacy.
CREATE FUNCTION amr_accessi.aziende_limite() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  IF (SELECT count(*) FROM amr_accessi.aziende) >= 10 THEN
    RAISE EXCEPTION USING MESSAGE = 'quota_aziende', ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER aziende_limite BEFORE INSERT ON amr_accessi.aziende
  FOR EACH ROW EXECUTE FUNCTION amr_accessi.aziende_limite();

CREATE FUNCTION amr_accessi.aziende_posti() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  IF (SELECT count(*) FROM amr_accessi.membri
        WHERE azienda = NEW.azienda AND persona <> NEW.persona)
    + (SELECT count(*) FROM amr_accessi.aziende_inviti
        WHERE azienda = NEW.azienda AND persona IS NULL
          AND scadenza > clock_timestamp()) >= 3 THEN
    RAISE EXCEPTION USING MESSAGE = 'quota_persone', ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER aziende_posti BEFORE INSERT OR UPDATE ON amr_accessi.membri
  FOR EACH ROW EXECUTE FUNCTION amr_accessi.aziende_posti();

CREATE FUNCTION amr_accessi.aziende_invita(p_persona uuid, p_epoca integer, p_mfa boolean,
  p_operazione uuid, p_id text, p_nome text, p_email text, p_moduli text[], p_impronta text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog SET timezone = 'UTC'
AS $$
DECLARE v_op amr_accessi.aziende_operazioni%ROWTYPE; v_ora timestamptz;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  PERFORM amr_accessi.aziende_admin(p_persona, p_epoca, p_mfa);
  IF p_operazione IS NULL OR p_id IS NULL OR p_id !~ '^[a-zA-Z0-9_-]{1,64}$'
    OR p_nome IS NULL OR char_length(p_nome) NOT BETWEEN 1 AND 80
    OR p_nome <> btrim(p_nome) OR p_nome ~ '[[:cntrl:]]'
    OR p_email IS NULL OR char_length(p_email) > 254 OR p_email ~ '[[:cntrl:]]'
    OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR p_moduli IS NULL OR array_ndims(p_moduli) IS DISTINCT FROM 1
    OR array_lower(p_moduli, 1) IS DISTINCT FROM 1
    OR cardinality(p_moduli) NOT BETWEEN 1 AND 2 OR array_position(p_moduli, NULL) IS NOT NULL
    OR NOT p_moduli <@ ARRAY['auto', 'moto']::text[]
    OR (cardinality(p_moduli) = 2 AND p_moduli[1] = p_moduli[2])
    OR p_impronta IS NULL OR p_impronta !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'input_non_valido', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_op FROM amr_accessi.aziende_operazioni WHERE id = p_operazione;
  IF FOUND THEN
    -- Il nuovo hash casuale del retry NON fa parte dei parametri commerciali.
    IF v_op.tipo <> 'invita' OR v_op.attore <> p_persona OR v_op.azienda <> p_id
      OR NOT EXISTS (SELECT 1 FROM amr_accessi.aziende a
        JOIN amr_accessi.aziende_inviti i ON i.azienda = a.id WHERE a.id = p_id
          AND a.nome = p_nome AND i.email = p_email AND a.moduli = p_moduli) THEN
      RAISE EXCEPTION USING MESSAGE = 'operazione_in_conflitto', ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'operazione', p_operazione,
      'giaCreata', true, 'tokenDisponibile', false);
  END IF;
  IF EXISTS (SELECT 1 FROM amr_accessi.aziende WHERE id = p_id) THEN
    RAISE EXCEPTION USING MESSAGE = 'azienda_esistente', ERRCODE = 'P0001';
  END IF;
  SELECT o.* INTO v_op FROM amr_accessi.aziende_operazioni o
    JOIN amr_accessi.aziende_inviti i ON i.azienda = o.azienda
    WHERE o.tipo = 'invita' AND lower(i.email) = lower(p_email)
      AND i.persona IS NULL AND i.scadenza > clock_timestamp();
  IF FOUND THEN
    -- Recupero dopo reload: il nome non identifica l'azienda. Si riusa solo
    -- l'operazione del medesimo Admin con destinatario e moduli identici.
    IF v_op.attore <> p_persona OR NOT EXISTS (SELECT 1 FROM amr_accessi.aziende a
      JOIN amr_accessi.aziende_inviti i ON i.azienda = a.id
      WHERE a.id = v_op.azienda AND a.nome = p_nome AND i.email = p_email AND a.moduli = p_moduli) THEN
      RAISE EXCEPTION USING MESSAGE = 'invito_esistente', ERRCODE = 'P0001';
    END IF;
    RETURN jsonb_build_object('ok', true, 'id', v_op.azienda, 'operazione', v_op.id,
      'giaCreata', true, 'tokenDisponibile', false);
  END IF;
  IF (SELECT count(*) FROM amr_accessi.aziende) >= 10 THEN
    RAISE EXCEPTION USING MESSAGE = 'quota_aziende', ERRCODE = 'P0001';
  END IF;
  -- Un Admin AMR, incluso il proprietario, non può diventare il referente cliente.
  IF EXISTS (SELECT 1 FROM auth.users u JOIN amr_accessi.persone p ON p.id = u.id
      WHERE lower(u.email) = lower(p_email) AND p.admin) THEN
    RAISE EXCEPTION USING MESSAGE = 'referente_non_valido', ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users u JOIN amr_accessi.membri m ON m.persona = u.id
      WHERE lower(u.email) = lower(p_email)) THEN
    RAISE EXCEPTION USING MESSAGE = 'appartenenza_esistente', ERRCODE = 'P0001';
  END IF;
  v_ora := clock_timestamp();
  INSERT INTO amr_accessi.aziende(id, nome, attiva, scadenza, moduli)
    VALUES (p_id, p_nome, false, v_ora + interval '7 days', p_moduli);
  INSERT INTO amr_accessi.aziende_inviti(azienda, email, impronta, creata_il, scadenza)
    VALUES (p_id, p_email, p_impronta, v_ora, v_ora + interval '7 days');
  INSERT INTO amr_accessi.aziende_operazioni(id, tipo, azienda, attore, confermata_il)
    VALUES (p_operazione, 'invita', p_id, p_persona, v_ora);
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'operazione', p_operazione,
    'giaCreata', false, 'tokenDisponibile', true);
END
$$;

CREATE FUNCTION amr_accessi.aziende_invito(p_impronta text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_email text;
BEGIN
  -- Lookup interno server per signup: la visita non consuma né attiva.
  SELECT i.email INTO v_email FROM amr_accessi.aziende_inviti i
    JOIN amr_accessi.aziende a ON a.id = i.azienda
    WHERE i.impronta = p_impronta AND i.persona IS NULL
      AND i.scadenza > clock_timestamp() AND NOT a.attiva AND a.referente IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'invito_non_valido', ERRCODE = 'P0001';
  END IF;
  RETURN jsonb_build_object('email', v_email);
END
$$;

CREATE FUNCTION amr_accessi.aziende_accetta(p_persona uuid, p_impronta text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_i amr_accessi.aziende_inviti%ROWTYPE;
  v_p amr_accessi.persone%ROWTYPE; v_email text; v_ora timestamptz;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  SELECT * INTO v_i FROM amr_accessi.aziende_inviti WHERE impronta = p_impronta FOR UPDATE;
  IF NOT FOUND OR v_i.persona IS NOT NULL OR v_i.scadenza <= clock_timestamp() THEN
    RAISE EXCEPTION USING MESSAGE = 'invito_non_valido', ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM amr_accessi.aziende WHERE id = v_i.azienda
    AND NOT attiva AND referente IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'invito_non_valido', ERRCODE = 'P0001';
  END IF;
  -- UUID dal provider verificato SERVER-SIDE, anche senza sessione/permessi AMR.
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_persona
    AND u.email_verified AND NOT u.disabled FOR SHARE;
  IF NOT FOUND OR lower(v_email) IS DISTINCT FROM lower(v_i.email) THEN
    RAISE EXCEPTION USING MESSAGE = 'invito_non_valido', ERRCODE = 'P0001';
  END IF;
  INSERT INTO amr_accessi.persone(id) VALUES (p_persona) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v_p FROM amr_accessi.persone WHERE id = p_persona FOR SHARE;
  IF NOT v_p.attiva OR v_p.admin THEN
    RAISE EXCEPTION USING MESSAGE = 'referente_non_valido', ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM amr_accessi.membri WHERE persona = p_persona) THEN
    RAISE EXCEPTION USING MESSAGE = 'appartenenza_esistente', ERRCODE = 'P0001';
  END IF;
  v_ora := clock_timestamp();
  IF v_i.scadenza <= v_ora THEN
    RAISE EXCEPTION USING MESSAGE = 'invito_non_valido', ERRCODE = 'P0001';
  END IF;
  -- Convertire la prenotazione prima dell'INSERT; la FK del membro è differita.
  UPDATE amr_accessi.aziende_inviti SET persona = p_persona, accettata_il = v_ora
    WHERE id = v_i.id;
  INSERT INTO amr_accessi.membri(persona, azienda) VALUES (p_persona, v_i.azienda);
  UPDATE amr_accessi.aziende SET referente = p_persona, accettata_il = v_ora
    WHERE id = v_i.azienda;
  INSERT INTO amr_accessi.aziende_operazioni(id, tipo, azienda, attore, confermata_il)
    VALUES (gen_random_uuid(), 'accetta', v_i.azienda, p_persona, v_ora);
  RETURN jsonb_build_object('ok', true, 'id', v_i.azienda, 'stato', 'accettato');
END
$$;

CREATE FUNCTION amr_accessi.aziende_attiva(p_persona uuid, p_epoca integer, p_mfa boolean,
  p_operazione uuid, p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone = 'UTC'
AS $$
DECLARE v_op amr_accessi.aziende_operazioni%ROWTYPE; v_ora timestamptz;
  v_a amr_accessi.aziende%ROWTYPE;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  PERFORM amr_accessi.aziende_admin(p_persona, p_epoca, p_mfa);
  IF p_operazione IS NULL OR p_id IS NULL OR p_id !~ '^[a-zA-Z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION USING MESSAGE = 'input_non_valido', ERRCODE = 'P0001';
  END IF;
  SELECT * INTO v_op FROM amr_accessi.aziende_operazioni WHERE id = p_operazione;
  IF FOUND THEN
    IF v_op.tipo <> 'attiva' OR v_op.attore <> p_persona OR v_op.azienda <> p_id THEN
      RAISE EXCEPTION USING MESSAGE = 'operazione_in_conflitto', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_a FROM amr_accessi.aziende WHERE id = p_id;
    RETURN jsonb_build_object('ok', true, 'id', p_id, 'stato', 'attiva',
      'scadenza', v_a.scadenza, 'giaAttivata', true);
  END IF;
  SELECT * INTO v_a FROM amr_accessi.aziende WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR v_a.nome IS NULL OR v_a.attiva OR v_a.referente IS NULL
      OR v_a.accettata_il IS NULL OR v_a.attivata_il IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM amr_accessi.aziende_inviti
        WHERE azienda = p_id AND persona = v_a.referente AND accettata_il IS NOT NULL) THEN
    RAISE EXCEPTION USING MESSAGE = 'azienda_non_pronta', ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM amr_accessi.persone p JOIN auth.users u ON u.id = p.id
    WHERE p.id = v_a.referente AND p.attiva AND NOT p.admin
      AND u.email_verified AND NOT u.disabled FOR SHARE OF p, u;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE = 'referente_non_valido', ERRCODE = 'P0001';
  END IF;
  v_ora := clock_timestamp();
  UPDATE amr_accessi.aziende SET attiva = true, attivata_il = v_ora,
    scadenza = v_ora + interval '1 year' WHERE id = p_id RETURNING * INTO v_a;
  INSERT INTO amr_accessi.aziende_operazioni(id, tipo, azienda, attore, confermata_il)
    VALUES (p_operazione, 'attiva', p_id, p_persona, v_ora);
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'stato', 'attiva',
    'scadenza', v_a.scadenza, 'giaAttivata', false);
END
$$;

CREATE FUNCTION amr_accessi.aziende_elenco(p_persona uuid, p_epoca integer, p_mfa boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_aziende jsonb;
BEGIN
  PERFORM amr_accessi.aziende_admin(p_persona, p_epoca, p_mfa);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'nome', coalesce(a.nome, a.id),
    'stato', CASE WHEN NOT a.attiva AND a.attivata_il IS NOT NULL THEN 'revocata'
      WHEN a.attiva AND a.scadenza <= statement_timestamp() THEN 'scaduta'
      WHEN a.attiva THEN 'attiva' WHEN a.accettata_il IS NOT NULL
      THEN 'accettato' WHEN i.persona IS NULL AND i.scadenza <= statement_timestamp()
      THEN 'scaduto' ELSE 'pending' END,
    'scadenza', CASE WHEN a.attiva THEN a.scadenza ELSE NULL END,
    'inviteScadenza', i.scadenza) ORDER BY a.id), '[]'::jsonb)
    INTO v_aziende FROM amr_accessi.aziende a
    LEFT JOIN amr_accessi.aziende_inviti i ON i.azienda = a.id;
  RETURN jsonb_build_object('aziende', v_aziende);
END
$$;

-- Proprietario senza login e senza privilegi generali sulle colonne Auth.
GRANT CREATE ON SCHEMA amr_accessi TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_blocca() OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_admin(uuid, integer, boolean) OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_limite() OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_posti() OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_invita(uuid, integer, boolean, uuid, text, text, text, text[], text)
  OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_invito(text) OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_accetta(uuid, text) OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_attiva(uuid, integer, boolean, uuid, text) OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_elenco(uuid, integer, boolean) OWNER TO amr_aziende_definitore;
REVOKE CREATE ON SCHEMA amr_accessi FROM amr_aziende_definitore;
REVOKE ALL ON FUNCTION amr_accessi.aziende_blocca(),
  amr_accessi.aziende_admin(uuid, integer, boolean), amr_accessi.aziende_limite(),
  amr_accessi.aziende_posti(),
  amr_accessi.aziende_invita(uuid, integer, boolean, uuid, text, text, text, text[], text),
  amr_accessi.aziende_invito(text), amr_accessi.aziende_accetta(uuid, text),
  amr_accessi.aziende_attiva(uuid, integer, boolean, uuid, text),
  amr_accessi.aziende_elenco(uuid, integer, boolean) FROM PUBLIC;
GRANT USAGE ON SCHEMA amr_accessi TO amr_aziende_scrittore;
GRANT EXECUTE ON FUNCTION
  amr_accessi.aziende_invita(uuid, integer, boolean, uuid, text, text, text, text[], text),
  amr_accessi.aziende_invito(text), amr_accessi.aziende_accetta(uuid, text),
  amr_accessi.aziende_attiva(uuid, integer, boolean, uuid, text),
  amr_accessi.aziende_elenco(uuid, integer, boolean) TO amr_aziende_scrittore;
COMMIT;
