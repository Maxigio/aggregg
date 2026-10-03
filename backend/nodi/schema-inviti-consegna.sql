-- Aggiornamento circoscritto per DB esistenti: stesso owner e privilegi della funzione.
-- Applicare dopo schema-aziende-prova.sql; nessuna modifica ai dati o ai token.
BEGIN;
CREATE OR REPLACE FUNCTION amr_accessi.aziende_invita(p_persona uuid, p_epoca integer, p_mfa boolean,
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
      'giaCreata', true, 'tokenDisponibile', EXISTS (
        SELECT 1 FROM amr_accessi.aziende_inviti i JOIN amr_accessi.aziende a ON a.id=i.azienda
        WHERE i.azienda=p_id AND i.persona IS NULL AND i.scadenza>clock_timestamp()
          AND NOT a.attiva AND a.referente IS NULL));
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
      'giaCreata', true, 'tokenDisponibile', EXISTS (
        SELECT 1 FROM amr_accessi.aziende_inviti i JOIN amr_accessi.aziende a ON a.id=i.azienda
        WHERE i.azienda=v_op.azienda AND i.persona IS NULL AND i.scadenza>clock_timestamp()
          AND NOT a.attiva AND a.referente IS NULL));
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
COMMIT;
