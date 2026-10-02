-- Solo collaudo PG16. Applicare come installatore fidato DOPO accessi/aziende/rinnovi.
-- Nessuna identità del browser può chiamare SQL: UUID, epoca e MFA sono del server.
-- Fonti: postgresql.org/docs/16/{sql-createfunction,explicit-locking,transaction-iso}.html
-- cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
BEGIN;

-- L'invito iniziale è storia dell'onboarding, non un vincolo perpetuo sul vecchio
-- referente: dopo il trasferimento anche lui deve poter essere revocato.
ALTER TABLE amr_accessi.aziende_inviti DROP CONSTRAINT aziende_inviti_persona_azienda_fkey;
ALTER TABLE amr_accessi.aziende_inviti ADD CONSTRAINT aziende_inviti_persona_storica
  FOREIGN KEY (persona) REFERENCES amr_accessi.persone(id);

CREATE TABLE amr_accessi.colleghi_inviti (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  azienda text NOT NULL REFERENCES amr_accessi.aziende(id),
  email text NOT NULL CHECK (char_length(email) <= 254 AND email = lower(email)
    AND email !~ '[[:cntrl:]]' AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  impronta text NOT NULL UNIQUE CHECK (impronta ~ '^[a-f0-9]{64}$'),
  creata_il timestamptz NOT NULL,
  scadenza timestamptz NOT NULL CHECK (scadenza = creata_il + interval '7 days'),
  stato text NOT NULL DEFAULT 'pending' CHECK (stato IN ('pending','accettato','revocato')),
  persona uuid REFERENCES amr_accessi.persone(id),
  accettata_il timestamptz,
  revocata_il timestamptz,
  CHECK ((persona IS NULL) = (accettata_il IS NULL)),
  CHECK (accettata_il IS NULL OR (accettata_il >= creata_il AND accettata_il < scadenza)),
  CHECK ((stato = 'revocato') = (revocata_il IS NOT NULL)),
  CHECK (stato <> 'pending' OR persona IS NULL),
  CHECK (stato <> 'accettato' OR persona IS NOT NULL)
);
CREATE TABLE amr_accessi.colleghi_operazioni (
  id uuid PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('invita','accetta','revoca','revoca_invito','cambia_referente')),
  azienda text NOT NULL REFERENCES amr_accessi.aziende(id),
  attore uuid NOT NULL REFERENCES amr_accessi.persone(id),
  destinatario uuid,
  invito uuid REFERENCES amr_accessi.colleghi_inviti(id),
  risultato jsonb NOT NULL,
  confermata_il timestamptz NOT NULL,
  -- Audit senza email, password, token, impronte o annunci. Copia esterna assente.
  backup_stato text NOT NULL DEFAULT 'pending' CHECK (backup_stato = 'pending'),
  backup_destinazione text NOT NULL DEFAULT 'non_configurata' CHECK (backup_destinazione = 'non_configurata')
);
REVOKE ALL ON amr_accessi.colleghi_inviti, amr_accessi.colleghi_operazioni FROM PUBLIC;
CREATE ROLE amr_colleghi_definitore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE amr_colleghi_scrittore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA amr_accessi, auth TO amr_colleghi_definitore;
GRANT SELECT(id,email,email_verified,disabled), UPDATE(id) ON auth.users TO amr_colleghi_definitore;
GRANT SELECT, INSERT(id), UPDATE(epoca) ON amr_accessi.persone TO amr_colleghi_definitore;
GRANT SELECT, INSERT, DELETE ON amr_accessi.membri TO amr_colleghi_definitore;
GRANT SELECT, UPDATE(referente) ON amr_accessi.aziende TO amr_colleghi_definitore;
GRANT SELECT ON amr_accessi.aziende_inviti TO amr_colleghi_definitore;
GRANT SELECT, INSERT, UPDATE(stato,persona,accettata_il,revocata_il)
  ON amr_accessi.colleghi_inviti TO amr_colleghi_definitore;
GRANT SELECT, INSERT ON amr_accessi.colleghi_operazioni TO amr_colleghi_definitore;
GRANT EXECUTE ON FUNCTION amr_accessi.aziende_blocca() TO amr_colleghi_definitore;

CREATE FUNCTION amr_accessi.colleghi_quota() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
  -- ponytail: stesso lock/versione globale delle aziende, tetto di 30 clienti.
  -- UPDATE(versione) provoca serialization failure su snapshot RR obsoleti.
  PERFORM amr_accessi.aziende_blocca();
  IF (SELECT count(*) FROM amr_accessi.aziende) > 10 THEN
    RAISE EXCEPTION USING MESSAGE='quota_aziende', ERRCODE='P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT azienda FROM amr_accessi.membri
      UNION ALL SELECT azienda FROM amr_accessi.aziende_inviti
        WHERE persona IS NULL AND scadenza > clock_timestamp()
      UNION ALL SELECT azienda FROM amr_accessi.colleghi_inviti
        WHERE stato = 'pending' AND scadenza > clock_timestamp()
    ) posti GROUP BY ROLLUP(azienda)
    HAVING count(*) > CASE WHEN GROUPING(azienda) = 1 THEN 30 ELSE 3 END
  ) THEN RAISE EXCEPTION USING MESSAGE='quota_persone', ERRCODE='P0001'; END IF;
  -- Anche il writer del primo referente deve rispettare prenotazioni colleghi.
  IF EXISTS (SELECT 1 FROM (
    SELECT lower(email) email FROM amr_accessi.aziende_inviti
      WHERE persona IS NULL AND scadenza>clock_timestamp()
    UNION ALL SELECT email FROM amr_accessi.colleghi_inviti
      WHERE stato='pending' AND scadenza>clock_timestamp()
  ) prenotazioni GROUP BY email HAVING count(*)>1) THEN
    RAISE EXCEPTION USING MESSAGE='invito_esistente', ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM (
    SELECT lower(email) email FROM amr_accessi.aziende_inviti
      WHERE persona IS NULL AND scadenza>clock_timestamp()
    UNION ALL SELECT email FROM amr_accessi.colleghi_inviti
      WHERE stato='pending' AND scadenza>clock_timestamp()
  ) prenotazioni JOIN auth.users u ON lower(u.email)=prenotazioni.email
    JOIN amr_accessi.membri m ON m.persona=u.id) THEN
    RAISE EXCEPTION USING MESSAGE='appartenenza_esistente', ERRCODE='P0001';
  END IF;
END $$;
CREATE FUNCTION amr_accessi.colleghi_posti() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$ BEGIN PERFORM amr_accessi.colleghi_quota(); RETURN NULL; END $$;
-- Copre anche i writer aziende esistenti e INSERT privilegiati. Prima della
-- membership l'accettazione converte il pending, evitando il doppio conteggio.
CREATE TRIGGER colleghi_posti AFTER INSERT OR UPDATE OR DELETE ON amr_accessi.membri
  FOR EACH ROW EXECUTE FUNCTION amr_accessi.colleghi_posti();
CREATE TRIGGER colleghi_posti AFTER INSERT OR UPDATE OR DELETE ON amr_accessi.aziende_inviti
  FOR EACH ROW EXECUTE FUNCTION amr_accessi.colleghi_posti();
CREATE TRIGGER colleghi_posti AFTER INSERT OR UPDATE OR DELETE ON amr_accessi.colleghi_inviti
  FOR EACH ROW EXECUTE FUNCTION amr_accessi.colleghi_posti();

CREATE FUNCTION amr_accessi.colleghi_autorizza(p_persona uuid,p_epoca integer,p_mfa boolean,
  p_azienda text,p_solo_admin boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_p amr_accessi.persone%ROWTYPE;
BEGIN
  IF p_persona IS NULL OR p_epoca IS NULL OR p_epoca < 0
    OR p_azienda IS NULL OR p_azienda !~ '^[a-zA-Z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION USING MESSAGE='accesso_non_autorizzato', ERRCODE='P0001';
  END IF;
  SELECT p.* INTO v_p FROM amr_accessi.persone p JOIN auth.users u ON u.id=p.id
    WHERE p.id=p_persona AND p.attiva AND u.email_verified AND NOT u.disabled FOR SHARE OF p,u;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='accesso_non_autorizzato', ERRCODE='P0001'; END IF;
  IF v_p.epoca <> p_epoca THEN RAISE EXCEPTION USING MESSAGE='sessione_revocata', ERRCODE='P0001'; END IF;
  IF v_p.admin THEN
    IF p_mfa IS DISTINCT FROM true THEN
      RAISE EXCEPTION USING MESSAGE='accesso_non_autorizzato', ERRCODE='P0001';
    END IF;
  ELSIF p_solo_admin OR NOT EXISTS (
    SELECT 1 FROM amr_accessi.aziende a JOIN amr_accessi.membri m ON m.azienda=a.id
      WHERE a.id=p_azienda AND a.referente=p_persona AND m.persona=p_persona
  ) THEN RAISE EXCEPTION USING MESSAGE='accesso_non_autorizzato', ERRCODE='P0001'; END IF;
  PERFORM 1 FROM amr_accessi.aziende WHERE id=p_azienda FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='azienda_non_pronta', ERRCODE='P0001'; END IF;
  RETURN v_p.admin;
END $$;

CREATE FUNCTION amr_accessi.colleghi_scrivi(p_persona uuid,p_epoca integer,p_mfa boolean,
  p_operazione uuid,p_azienda text,p_tipo text,p_destinatario uuid,p_email text,p_impronta text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone='UTC'
AS $$
DECLARE v_op amr_accessi.colleghi_operazioni%ROWTYPE; v_invito uuid;
  v_ora timestamptz; v_out jsonb; v_email text; v_epoca integer;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  IF p_operazione IS NULL OR p_tipo IS NULL
    OR p_tipo NOT IN ('invita','revoca','revoca_invito','cambia_referente')
    OR (p_tipo = 'invita' AND (p_destinatario IS NOT NULL OR p_email IS NULL
      OR char_length(p_email) > 254 OR p_email ~ '[[:cntrl:]]'
      OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR p_impronta IS NULL OR p_impronta !~ '^[a-f0-9]{64}$'))
    OR (p_tipo <> 'invita' AND (p_destinatario IS NULL OR p_email IS NOT NULL OR p_impronta IS NOT NULL)) THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido', ERRCODE='P0001';
  END IF;
  PERFORM amr_accessi.colleghi_autorizza(p_persona,p_epoca,p_mfa,p_azienda,p_tipo='cambia_referente');
  SELECT * INTO v_op FROM amr_accessi.colleghi_operazioni WHERE id=p_operazione;
  IF FOUND THEN
    IF v_op.tipo <> p_tipo OR v_op.attore <> p_persona OR v_op.azienda <> p_azienda
      OR v_op.destinatario IS DISTINCT FROM p_destinatario
      OR (p_tipo='invita' AND NOT EXISTS (SELECT 1 FROM amr_accessi.colleghi_inviti
        WHERE id=v_op.invito AND email=lower(p_email))) THEN
      RAISE EXCEPTION USING MESSAGE='operazione_in_conflitto', ERRCODE='P0001';
    END IF;
    RETURN v_op.risultato || jsonb_build_object('giaEseguita',true,'tokenDisponibile',
      p_tipo='invita' AND EXISTS (SELECT 1 FROM amr_accessi.colleghi_inviti
        WHERE id=v_op.invito AND stato='pending' AND scadenza>clock_timestamp()));
  END IF;
  v_ora := clock_timestamp();
  IF p_tipo='invita' THEN
    PERFORM 1 FROM amr_accessi.aziende WHERE id=p_azienda AND attiva AND scadenza>v_ora
      AND referente IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='azienda_non_pronta', ERRCODE='P0001'; END IF;
    v_email := lower(p_email);
    IF EXISTS (SELECT 1 FROM auth.users u JOIN amr_accessi.persone p ON p.id=u.id
      WHERE lower(u.email)=v_email AND (p.admin OR NOT p.attiva OR u.disabled)) THEN
      RAISE EXCEPTION USING MESSAGE='collega_non_valido', ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM auth.users u JOIN amr_accessi.membri m ON m.persona=u.id
      WHERE lower(u.email)=v_email) THEN
      RAISE EXCEPTION USING MESSAGE='appartenenza_esistente', ERRCODE='P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM amr_accessi.colleghi_inviti WHERE email=v_email AND stato='pending' AND scadenza>v_ora)
      OR EXISTS (SELECT 1 FROM amr_accessi.aziende_inviti WHERE lower(email)=v_email AND persona IS NULL AND scadenza>v_ora) THEN
      RAISE EXCEPTION USING MESSAGE='invito_esistente', ERRCODE='P0001';
    END IF;
    INSERT INTO amr_accessi.colleghi_inviti(azienda,email,impronta,creata_il,scadenza)
      VALUES(p_azienda,v_email,p_impronta,v_ora,v_ora+interval '7 days') RETURNING id INTO v_invito;
  ELSIF p_tipo='revoca_invito' THEN
    UPDATE amr_accessi.colleghi_inviti SET stato='revocato',revocata_il=v_ora
      WHERE id=p_destinatario AND azienda=p_azienda AND stato='pending' RETURNING id INTO v_invito;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001'; END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM amr_accessi.membri WHERE persona=p_destinatario AND azienda=p_azienda)
      OR EXISTS (SELECT 1 FROM amr_accessi.aziende WHERE id=p_azienda AND referente=p_destinatario) THEN
      RAISE EXCEPTION USING MESSAGE='collega_non_valido', ERRCODE='P0001';
    END IF;
    IF p_tipo='revoca' THEN
      UPDATE amr_accessi.persone SET epoca=epoca+1 WHERE id=p_destinatario RETURNING epoca INTO v_epoca;
      DELETE FROM amr_accessi.membri WHERE persona=p_destinatario AND azienda=p_azienda;
      UPDATE amr_accessi.colleghi_inviti SET stato='revocato',revocata_il=v_ora
        WHERE persona=p_destinatario AND azienda=p_azienda AND stato='accettato';
    ELSE
      PERFORM 1 FROM amr_accessi.persone p JOIN auth.users u ON u.id=p.id
        WHERE p.id=p_destinatario AND p.attiva AND NOT p.admin AND u.email_verified AND NOT u.disabled
        FOR SHARE OF p,u;
      IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='collega_non_valido', ERRCODE='P0001'; END IF;
      PERFORM 1 FROM amr_accessi.aziende WHERE id=p_azienda AND attiva AND scadenza>v_ora;
      IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='azienda_non_pronta', ERRCODE='P0001'; END IF;
      UPDATE amr_accessi.aziende SET referente=p_destinatario WHERE id=p_azienda;
      -- Il vecchio referente conserva membership ed epoca: perde solo i permessi gestionali.
    END IF;
  END IF;
  v_out := jsonb_build_object('ok',true,'id',p_azienda,'operazione',p_operazione,
    'invito',v_invito,'persona',p_destinatario,'giaEseguita',false,'tokenDisponibile',p_tipo='invita');
  INSERT INTO amr_accessi.colleghi_operazioni(id,tipo,azienda,attore,destinatario,invito,risultato,confermata_il)
    VALUES(p_operazione,p_tipo,p_azienda,p_persona,p_destinatario,v_invito,v_out,v_ora);
  RETURN v_out;
END $$;

CREATE FUNCTION amr_accessi.colleghi_invito(p_impronta text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_i amr_accessi.colleghi_inviti%ROWTYPE;
BEGIN
  IF p_impronta IS NULL OR p_impronta !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
  END IF;
  SELECT i.* INTO v_i FROM amr_accessi.colleghi_inviti i JOIN amr_accessi.aziende a ON a.id=i.azienda
    WHERE i.impronta=p_impronta AND a.attiva AND a.scadenza>clock_timestamp()
      AND ((i.stato='pending' AND i.scadenza>clock_timestamp()) OR (i.stato='accettato'
        AND EXISTS (SELECT 1 FROM amr_accessi.membri WHERE persona=i.persona AND azienda=i.azienda)));
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001'; END IF;
  -- Accettato: permette solo il login necessario a un retry con lo stesso operation UUID.
  RETURN jsonb_build_object('email',v_i.email,'stato',v_i.stato);
END $$;

CREATE FUNCTION amr_accessi.colleghi_accetta(p_persona uuid,p_operazione uuid,p_impronta text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET timezone='UTC'
AS $$
DECLARE v_i amr_accessi.colleghi_inviti%ROWTYPE; v_op amr_accessi.colleghi_operazioni%ROWTYPE;
  v_p amr_accessi.persone%ROWTYPE; v_email text; v_ora timestamptz; v_out jsonb;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  IF p_persona IS NULL OR p_operazione IS NULL OR p_impronta IS NULL OR p_impronta !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido', ERRCODE='P0001';
  END IF;
  SELECT * INTO v_i FROM amr_accessi.colleghi_inviti WHERE impronta=p_impronta FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001'; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id=p_persona AND email_verified AND NOT disabled FOR SHARE;
  IF NOT FOUND OR lower(v_email) IS DISTINCT FROM v_i.email THEN
    RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
  END IF;
  PERFORM 1 FROM amr_accessi.aziende WHERE id=v_i.azienda AND attiva AND scadenza>clock_timestamp() FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='azienda_non_pronta', ERRCODE='P0001'; END IF;
  INSERT INTO amr_accessi.persone(id) VALUES(p_persona) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO v_p FROM amr_accessi.persone WHERE id=p_persona FOR UPDATE;
  IF NOT v_p.attiva OR v_p.admin THEN RAISE EXCEPTION USING MESSAGE='collega_non_valido', ERRCODE='P0001'; END IF;
  SELECT * INTO v_op FROM amr_accessi.colleghi_operazioni WHERE id=p_operazione;
  IF FOUND THEN
    IF v_op.tipo<>'accetta' OR v_op.attore<>p_persona OR v_op.invito<>v_i.id THEN
      RAISE EXCEPTION USING MESSAGE='operazione_in_conflitto', ERRCODE='P0001';
    END IF;
    IF v_i.stato<>'accettato' OR NOT EXISTS (SELECT 1 FROM amr_accessi.membri
      WHERE persona=p_persona AND azienda=v_i.azienda) THEN
      RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
    END IF;
    RETURN v_op.risultato || jsonb_build_object('giaEseguita',true);
  END IF;
  v_ora := clock_timestamp();
  IF v_i.stato<>'pending' OR v_i.scadenza<=v_ora THEN
    RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM amr_accessi.membri WHERE persona=p_persona) THEN
    RAISE EXCEPTION USING MESSAGE='appartenenza_esistente', ERRCODE='P0001';
  END IF;
  UPDATE amr_accessi.colleghi_inviti SET stato='accettato',persona=p_persona,accettata_il=v_ora WHERE id=v_i.id;
  -- Invalida anche sessioni nate mentre la persona era priva di membership.
  -- Mai azzerare epoca: un reinvito non fa rivivere alcuna vecchia sessione.
  UPDATE amr_accessi.persone SET epoca=epoca+1 WHERE id=p_persona;
  INSERT INTO amr_accessi.membri(persona,azienda) VALUES(p_persona,v_i.azienda);
  v_out := jsonb_build_object('ok',true,'id',v_i.azienda,'operazione',p_operazione,'giaEseguita',false);
  INSERT INTO amr_accessi.colleghi_operazioni(id,tipo,azienda,attore,invito,risultato,confermata_il)
    VALUES(p_operazione,'accetta',v_i.azienda,p_persona,v_i.id,v_out,v_ora);
  RETURN v_out;
END $$;

CREATE FUNCTION amr_accessi.colleghi_elenco(p_persona uuid,p_epoca integer,p_mfa boolean,p_azienda text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_admin boolean; v_membri jsonb; v_inviti jsonb;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  v_admin := amr_accessi.colleghi_autorizza(p_persona,p_epoca,p_mfa,p_azienda,false);
  SELECT coalesce(jsonb_agg(jsonb_build_object('persona',p.id,'email',u.email,
    'referente',a.referente=p.id,'attiva',p.attiva AND u.email_verified AND NOT u.disabled)
    ORDER BY p.id),'[]'::jsonb) INTO v_membri FROM amr_accessi.membri m
    JOIN amr_accessi.persone p ON p.id=m.persona JOIN auth.users u ON u.id=p.id
    JOIN amr_accessi.aziende a ON a.id=m.azienda WHERE m.azienda=p_azienda;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'email',email,'scadenza',scadenza,
    'stato',CASE WHEN scadenza<=clock_timestamp() THEN 'scaduto' ELSE 'pending' END)
    ORDER BY creata_il),'[]'::jsonb) INTO v_inviti FROM amr_accessi.colleghi_inviti
    WHERE azienda=p_azienda AND stato='pending';
  RETURN jsonb_build_object('id',p_azienda,'admin',v_admin,'membri',v_membri,'inviti',v_inviti);
END $$;

CREATE FUNCTION amr_accessi.colleghi_operazione(p_persona uuid,p_epoca integer,p_mfa boolean,
  p_operazione uuid,p_azienda text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  PERFORM amr_accessi.colleghi_autorizza(p_persona,p_epoca,p_mfa,p_azienda,false);
  IF p_operazione IS NULL THEN RAISE EXCEPTION USING MESSAGE='input_non_valido', ERRCODE='P0001'; END IF;
  RETURN jsonb_build_object('confermata',EXISTS (SELECT 1 FROM amr_accessi.colleghi_operazioni
    WHERE id=p_operazione AND attore=p_persona AND azienda=p_azienda));
END $$;

-- Owner NOLOGIN; niente CREATE permanente, niente tabelle/colonne Auth ai writer.
GRANT CREATE ON SCHEMA amr_accessi TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_quota() OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_posti() OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_autorizza(uuid,integer,boolean,text,boolean) OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_scrivi(uuid,integer,boolean,uuid,text,text,uuid,text,text) OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_invito(text) OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_accetta(uuid,uuid,text) OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_elenco(uuid,integer,boolean,text) OWNER TO amr_colleghi_definitore;
ALTER FUNCTION amr_accessi.colleghi_operazione(uuid,integer,boolean,uuid,text) OWNER TO amr_colleghi_definitore;
REVOKE CREATE ON SCHEMA amr_accessi FROM amr_colleghi_definitore;
REVOKE ALL ON FUNCTION amr_accessi.colleghi_quota(), amr_accessi.colleghi_posti(),
  amr_accessi.colleghi_autorizza(uuid,integer,boolean,text,boolean),
  amr_accessi.colleghi_scrivi(uuid,integer,boolean,uuid,text,text,uuid,text,text),
  amr_accessi.colleghi_invito(text), amr_accessi.colleghi_accetta(uuid,uuid,text),
  amr_accessi.colleghi_elenco(uuid,integer,boolean,text),
  amr_accessi.colleghi_operazione(uuid,integer,boolean,uuid,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA amr_accessi TO amr_colleghi_scrittore;
GRANT EXECUTE ON FUNCTION amr_accessi.colleghi_scrivi(uuid,integer,boolean,uuid,text,text,uuid,text,text),
  amr_accessi.colleghi_invito(text), amr_accessi.colleghi_accetta(uuid,uuid,text),
  amr_accessi.colleghi_elenco(uuid,integer,boolean,text),
  amr_accessi.colleghi_operazione(uuid,integer,boolean,uuid,text) TO amr_colleghi_scrittore;
-- Integrazione esplicita: il pool commerciale esistente eredita SOLO nuove EXECUTE.
-- Nessun grant al lettore, al provider, a GraphQL o a PUBLIC.
-- PG16: amr_aziende_scrittore è NOINHERIT; rendere esplicita questa membership
-- evita che il login commerciale perda le nuove EXECUTE nella catena di ruoli.
GRANT amr_colleghi_scrittore TO amr_aziende_scrittore WITH INHERIT TRUE;
SELECT amr_accessi.colleghi_quota();
COMMIT;
