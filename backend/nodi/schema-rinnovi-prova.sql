-- Dopo schema-aziende-prova.sql; schema di collaudo, nessuna migrazione live implicita.
BEGIN;
ALTER TABLE amr_accessi.aziende DROP CONSTRAINT aziende_prova_stato;
ALTER TABLE amr_accessi.aziende ADD CONSTRAINT aziende_prova_stato CHECK (nome IS NULL OR (
  (referente IS NULL) = (accettata_il IS NULL)
  AND (attivata_il IS NULL OR accettata_il IS NOT NULL)
  AND (NOT attiva OR attivata_il IS NOT NULL)
  AND (attivata_il IS NULL OR (attivata_il >= accettata_il AND scadenza > attivata_il))));
ALTER TABLE amr_accessi.aziende_operazioni DROP CONSTRAINT aziende_operazioni_tipo_check;
ALTER TABLE amr_accessi.aziende_operazioni ADD CONSTRAINT aziende_operazioni_tipo_check
  CHECK (tipo IN ('invita','accetta','attiva','rinnova','revoca_azienda'));
ALTER TABLE amr_accessi.aziende_operazioni ADD COLUMN dati jsonb NOT NULL DEFAULT '{}'::jsonb;
GRANT UPDATE(epoca) ON amr_accessi.persone TO amr_aziende_definitore;

CREATE FUNCTION amr_accessi.aziende_rinnova(p_persona uuid,p_epoca integer,p_mfa boolean,
  p_operazione uuid,p_id text,p_scadenza timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET timezone='UTC'
SET datestyle='ISO, MDY'
AS $$
DECLARE v_op amr_accessi.aziende_operazioni%ROWTYPE;
  v_a amr_accessi.aziende%ROWTYPE; v_fino timestamptz; v_ora timestamptz;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  PERFORM amr_accessi.aziende_admin(p_persona,p_epoca,p_mfa);
  IF p_operazione IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido',ERRCODE='P0001';
  END IF;
  SELECT * INTO v_op FROM amr_accessi.aziende_operazioni WHERE id=p_operazione;
  IF FOUND THEN
    IF v_op.tipo<>'rinnova' OR v_op.attore<>p_persona OR v_op.azienda<>p_id
      OR (v_op.dati->>'richiesta') IS DISTINCT FROM p_scadenza::text THEN
      RAISE EXCEPTION USING MESSAGE='operazione_in_conflitto',ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('ok',true,'id',p_id,'scadenza',v_op.dati->'scadenza','giaEseguita',true);
  END IF;
  SELECT * INTO v_a FROM amr_accessi.aziende WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_a.attivata_il IS NULL THEN
    RAISE EXCEPTION USING MESSAGE='azienda_non_pronta',ERRCODE='P0001';
  END IF;
  v_ora:=clock_timestamp();
  v_fino:=coalesce(p_scadenza,greatest(v_a.scadenza,v_ora)+interval '1 year');
  IF NOT isfinite(v_fino) OR v_fino<=v_ora OR v_fino<=v_a.attivata_il THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido',ERRCODE='P0001';
  END IF;
  UPDATE amr_accessi.aziende SET attiva=true,scadenza=v_fino WHERE id=p_id;
  INSERT INTO amr_accessi.aziende_operazioni(id,tipo,azienda,attore,confermata_il,dati)
    VALUES(p_operazione,'rinnova',p_id,p_persona,v_ora,
      jsonb_build_object('richiesta',p_scadenza::text,'scadenza',v_fino));
  RETURN jsonb_build_object('ok',true,'id',p_id,'scadenza',v_fino,'giaEseguita',false);
END $$;

CREATE FUNCTION amr_accessi.aziende_revoca(p_persona uuid,p_epoca integer,p_mfa boolean,
  p_operazione uuid,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
DECLARE v_op amr_accessi.aziende_operazioni%ROWTYPE;
BEGIN
  PERFORM amr_accessi.aziende_blocca();
  PERFORM amr_accessi.aziende_admin(p_persona,p_epoca,p_mfa);
  IF p_operazione IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido',ERRCODE='P0001';
  END IF;
  SELECT * INTO v_op FROM amr_accessi.aziende_operazioni WHERE id=p_operazione;
  IF FOUND THEN
    IF v_op.tipo<>'revoca_azienda' OR v_op.attore<>p_persona OR v_op.azienda<>p_id THEN
      RAISE EXCEPTION USING MESSAGE='operazione_in_conflitto',ERRCODE='P0001';
    END IF;
    RETURN jsonb_build_object('ok',true,'id',p_id,'giaEseguita',true);
  END IF;
  PERFORM 1 FROM amr_accessi.aziende WHERE id=p_id AND attivata_il IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE='azienda_non_pronta',ERRCODE='P0001'; END IF;
  UPDATE amr_accessi.aziende SET attiva=false WHERE id=p_id;
  -- Tutte le sessioni precedenti restano revocate anche dopo un futuro rinnovo.
  UPDATE amr_accessi.persone SET epoca=epoca+1
    WHERE id IN (SELECT persona FROM amr_accessi.membri WHERE azienda=p_id);
  INSERT INTO amr_accessi.aziende_operazioni(id,tipo,azienda,attore,confermata_il)
    VALUES(p_operazione,'revoca_azienda',p_id,p_persona,clock_timestamp());
  RETURN jsonb_build_object('ok',true,'id',p_id,'giaEseguita',false);
END $$;
CREATE FUNCTION amr_accessi.aziende_operazione(p_persona uuid,p_epoca integer,p_mfa boolean,
  p_operazione uuid,p_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM amr_accessi.aziende_admin(p_persona,p_epoca,p_mfa);
  IF p_operazione IS NULL OR p_id IS NULL THEN
    RAISE EXCEPTION USING MESSAGE='input_non_valido',ERRCODE='P0001';
  END IF;
  RETURN jsonb_build_object('confermata', EXISTS (
    SELECT 1 FROM amr_accessi.aziende_operazioni
      WHERE id=p_operazione AND attore=p_persona AND azienda=p_id));
END $$;
GRANT CREATE ON SCHEMA amr_accessi TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_rinnova(uuid,integer,boolean,uuid,text,timestamptz) OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_revoca(uuid,integer,boolean,uuid,text) OWNER TO amr_aziende_definitore;
ALTER FUNCTION amr_accessi.aziende_operazione(uuid,integer,boolean,uuid,text) OWNER TO amr_aziende_definitore;
REVOKE CREATE ON SCHEMA amr_accessi FROM amr_aziende_definitore;
REVOKE ALL ON FUNCTION amr_accessi.aziende_rinnova(uuid,integer,boolean,uuid,text,timestamptz),
  amr_accessi.aziende_revoca(uuid,integer,boolean,uuid,text),
  amr_accessi.aziende_operazione(uuid,integer,boolean,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION amr_accessi.aziende_rinnova(uuid,integer,boolean,uuid,text,timestamptz),
  amr_accessi.aziende_revoca(uuid,integer,boolean,uuid,text),
  amr_accessi.aziende_operazione(uuid,integer,boolean,uuid,text) TO amr_aziende_scrittore;
COMMIT;
