-- Migrazione successiva al pacchetto iniziale: nessun backfill o reset delle epoche.
-- CREATE OR REPLACE preserva owner/ACL; il writer resta limitato a EXECUTE.
BEGIN;
CREATE OR REPLACE FUNCTION amr_accessi.aziende_accetta(p_persona uuid, p_impronta text) RETURNS jsonb
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
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_persona
    AND u.email_verified AND NOT u.disabled FOR SHARE;
  IF NOT FOUND OR lower(v_email) IS DISTINCT FROM lower(v_i.email) THEN
    RAISE EXCEPTION USING MESSAGE = 'invito_non_valido', ERRCODE = 'P0001';
  END IF;
  INSERT INTO amr_accessi.persone(id) VALUES (p_persona) ON CONFLICT (id) DO NOTHING;
  SELECT * INTO v_p FROM amr_accessi.persone WHERE id = p_persona FOR UPDATE;
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
  UPDATE amr_accessi.aziende_inviti SET persona = p_persona, accettata_il = v_ora
    WHERE id = v_i.id;
  -- La nuova membership non deve riutilizzare una sessione nata senza azienda.
  -- Anche il journal vede l'epoca nuova, nella medesima transazione.
  UPDATE amr_accessi.persone SET epoca = epoca + 1 WHERE id = p_persona;
  INSERT INTO amr_accessi.membri(persona, azienda) VALUES (p_persona, v_i.azienda);
  UPDATE amr_accessi.aziende SET referente = p_persona, accettata_il = v_ora
    WHERE id = v_i.azienda;
  INSERT INTO amr_accessi.aziende_operazioni(id, tipo, azienda, attore, confermata_il)
    VALUES (gen_random_uuid(), 'accetta', v_i.azienda, p_persona, v_ora);
  RETURN jsonb_build_object('ok', true, 'id', v_i.azienda, 'stato', 'accettato');
END
$$;
COMMIT;
