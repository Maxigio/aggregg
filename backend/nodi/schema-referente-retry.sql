BEGIN;

CREATE OR REPLACE FUNCTION amr_accessi.aziende_invito(p_impronta text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_i amr_accessi.aziende_inviti%ROWTYPE;
BEGIN
  SELECT i.* INTO v_i FROM amr_accessi.aziende_inviti i
    JOIN amr_accessi.aziende a ON a.id=i.azienda
    WHERE i.impronta=p_impronta AND (
      (i.persona IS NULL AND i.scadenza>clock_timestamp() AND NOT a.attiva AND a.referente IS NULL)
      OR (i.persona IS NOT NULL AND a.referente=i.persona AND (a.attiva OR a.attivata_il IS NULL)
        AND EXISTS (SELECT 1 FROM amr_accessi.membri WHERE persona=i.persona AND azienda=i.azienda)));
  IF NOT FOUND THEN
    RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
  END IF;
  -- Un invito accettato abilita solo il login per confermare la stessa operazione;
  -- non permette una nuova registrazione o una nuova accettazione.
  RETURN jsonb_build_object('email',v_i.email,'stato',CASE WHEN v_i.persona IS NULL THEN 'pending' ELSE 'accettato' END);
END $$;

CREATE FUNCTION amr_accessi.aziende_accetta(p_persona uuid,p_impronta text,p_operazione uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE v_i amr_accessi.aziende_inviti%ROWTYPE; v_p amr_accessi.persone%ROWTYPE;
  v_op amr_accessi.aziende_operazioni%ROWTYPE; v_email text; v_ora timestamptz;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  IF p_persona IS NULL OR p_operazione IS NULL OR p_impronta IS NULL OR p_impronta !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido', ERRCODE='P0001';
  END IF;
  SELECT * INTO v_i FROM amr_accessi.aziende_inviti WHERE impronta=p_impronta FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001'; END IF;
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id=p_persona
    AND u.email_verified AND NOT u.disabled FOR SHARE;
  IF NOT FOUND OR lower(v_email) IS DISTINCT FROM lower(v_i.email) THEN
    RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
  END IF;
  INSERT INTO amr_accessi.persone(id) VALUES(p_persona) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO v_p FROM amr_accessi.persone WHERE id=p_persona FOR UPDATE;
  IF NOT v_p.attiva OR v_p.admin THEN
    RAISE EXCEPTION USING MESSAGE='referente_non_valido', ERRCODE='P0001';
  END IF;
  SELECT * INTO v_op FROM amr_accessi.aziende_operazioni WHERE id=p_operazione;
  IF FOUND THEN
    IF v_op.tipo<>'accetta' OR v_op.attore<>p_persona OR v_op.azienda<>v_i.azienda THEN
      RAISE EXCEPTION USING MESSAGE='operazione_in_conflitto', ERRCODE='P0001';
    END IF;
    IF v_i.persona IS DISTINCT FROM p_persona OR NOT EXISTS (
      SELECT 1 FROM amr_accessi.membri m JOIN amr_accessi.aziende a ON a.id=m.azienda
      WHERE m.persona=p_persona AND m.azienda=v_i.azienda AND a.referente=p_persona
        AND (a.attiva OR a.attivata_il IS NULL)) THEN
      RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('ok',true,'id',v_i.azienda,'stato','accettato',
      'operazione',p_operazione,'giaEseguita',true);
  END IF;
  IF v_i.persona IS NOT NULL OR v_i.scadenza<=clock_timestamp() THEN
    RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001';
  END IF;
  PERFORM 1 FROM amr_accessi.aziende WHERE id=v_i.azienda
    AND NOT attiva AND referente IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001'; END IF;
  IF EXISTS (SELECT 1 FROM amr_accessi.membri WHERE persona=p_persona) THEN
    RAISE EXCEPTION USING MESSAGE='appartenenza_esistente', ERRCODE='P0001';
  END IF;
  v_ora:=clock_timestamp();
  IF v_i.scadenza<=v_ora THEN RAISE EXCEPTION USING MESSAGE='invito_non_valido', ERRCODE='P0001'; END IF;
  UPDATE amr_accessi.aziende_inviti SET persona=p_persona,accettata_il=v_ora WHERE id=v_i.id;
  UPDATE amr_accessi.persone SET epoca=epoca+1 WHERE id=p_persona;
  INSERT INTO amr_accessi.membri(persona,azienda) VALUES(p_persona,v_i.azienda);
  UPDATE amr_accessi.aziende SET referente=p_persona,accettata_il=v_ora WHERE id=v_i.azienda;
  INSERT INTO amr_accessi.aziende_operazioni(id,tipo,azienda,attore,confermata_il)
    VALUES(p_operazione,'accetta',v_i.azienda,p_persona,v_ora);
  RETURN jsonb_build_object('ok',true,'id',v_i.azienda,'stato','accettato',
    'operazione',p_operazione,'giaEseguita',false);
END $$;
GRANT CREATE ON SCHEMA amr_accessi TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_accetta(uuid,text,uuid) OWNER TO amr_aziende_definitore;
REVOKE CREATE ON SCHEMA amr_accessi FROM amr_aziende_definitore;
REVOKE ALL ON FUNCTION amr_accessi.aziende_accetta(uuid,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amr_accessi.aziende_accetta(uuid,text,uuid) TO amr_aziende_scrittore;
COMMIT;
