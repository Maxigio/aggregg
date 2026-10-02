-- Applicare da manifest fidato sul DB di recovery, dopo pg_restore e prima
-- della finalizzazione: un dump storico contiene la vecchia funzione.
-- Non assegna privilegi ai processi web o backup; può essere riapplicata.
BEGIN;
CREATE OR REPLACE FUNCTION amr_backup.invalida_accessi_ripristinati() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp
AS $$
DECLARE v_corrente bigint; v_chiamata boolean; v_massima bigint; v_audit bigint;
BEGIN
  IF to_regclass('auth.refresh_tokens') IS NULL THEN RAISE EXCEPTION 'backup_restore_auth_non_verificato'; END IF;
  -- Stesso lock del replay, poi quello dei writer commerciali. Restore offline:
  -- nessun processo AMR/Auth/backup deve essere riaperto prima del commit.
  PERFORM pg_advisory_xact_lock(724013,1);
  PERFORM amr_accessi.aziende_blocca();
  SELECT last_value,is_called INTO v_corrente,v_chiamata FROM amr_backup.sequenza;
  SELECT greatest(coalesce((SELECT max(sequenza) FROM amr_backup.aziende_sequenza),0),
    coalesce((SELECT max(sequenza) FROM amr_backup.outbox),0)) INTO v_massima;
  IF (to_regclass('amr_ripristino.aziende') IS NULL) <>
      (to_regclass('amr_ripristino.operazioni') IS NULL) THEN
    RAISE EXCEPTION 'backup_restore_audit_non_verificato';
  END IF;
  IF to_regclass('amr_ripristino.aziende') IS NOT NULL THEN
    EXECUTE 'SELECT greatest(coalesce((SELECT max(sequenza) FROM amr_ripristino.aziende),0),
      coalesce((SELECT max(sequenza) FROM amr_ripristino.operazioni),0))' INTO v_audit;
    v_massima:=greatest(v_massima,v_audit);
  END IF;
  UPDATE amr_accessi.persone SET epoca=epoca+1;
  DELETE FROM auth.refresh_tokens;
  IF to_regclass('auth.refresh_token_sessions') IS NOT NULL THEN DELETE FROM auth.refresh_token_sessions; END IF;
  IF to_regclass('auth.oauth2_refresh_tokens') IS NOT NULL THEN DELETE FROM auth.oauth2_refresh_tokens; END IF;
  UPDATE amr_accessi.aziende_inviti SET impronta=
    replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')
    WHERE persona IS NULL;
  UPDATE amr_accessi.colleghi_inviti SET impronta=
    replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','')
    WHERE stato='pending';
  -- setval non è transazionale: farlo per ultimo e mai diminuire il contatore.
  -- Nessun aggiornamento dei checkpoint del dump durante la finalizzazione.
  IF v_massima>v_corrente OR (NOT v_chiamata AND v_massima=v_corrente) THEN
    PERFORM setval('amr_backup.sequenza'::regclass,v_massima,true);
  END IF;
END $$;
REVOKE ALL ON FUNCTION amr_backup.invalida_accessi_ripristinati() FROM PUBLIC;
COMMIT;
