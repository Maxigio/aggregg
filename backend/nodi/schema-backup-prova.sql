-- Installatore fidato, dopo accessi/aziende/rinnovi/colleghi. Nessuna applicazione live.
-- Solo le nuove INSERT producono lo stato storico esatto: niente backfill inventato.
BEGIN;
CREATE SCHEMA amr_backup;
REVOKE ALL ON SCHEMA amr_backup FROM PUBLIC;
CREATE ROLE amr_backup_definitore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE amr_backup_esecutore NOLOGIN NOINHERIT NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- CACHE 1 evita assegnazioni a blocchi per connessione. Buchi da rollback sono
-- normali; l'ordine deriva dal lock commerciale condiviso, non dall'orologio.
CREATE SEQUENCE amr_backup.sequenza AS bigint NO CYCLE CACHE 1;
-- Checkpoint nel dump, indipendente dalla retention dell'outbox: mai eliminato
-- da pulisci(), anche quando tutti i journal dell'azienda sono già scaduti.
CREATE TABLE amr_backup.aziende_sequenza (
  azienda text PRIMARY KEY, sequenza bigint NOT NULL CHECK (sequenza > 0)
);
CREATE TABLE amr_backup.outbox (
  id text PRIMARY KEY,
  categoria text NOT NULL CHECK (categoria IN ('journal','database')),
  journal jsonb,
  sequenza bigint UNIQUE,
  creata_il timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease uuid, lease_fino timestamptz,
  tentativi integer NOT NULL DEFAULT 0,
  retry_dal timestamptz NOT NULL DEFAULT clock_timestamp(),
  completata_il timestamptz,
  snapshot text CHECK (snapshot ~ '^[a-f0-9]{64}$'),
  errore text CHECK (errore IN ('backup_non_configurato','backup_non_disponibile')),
  CHECK ((categoria = 'journal') = (journal IS NOT NULL)),
  CHECK ((categoria = 'journal') = (sequenza IS NOT NULL)),
  CHECK ((lease IS NULL) = (lease_fino IS NULL)),
  CHECK ((completata_il IS NULL) = (snapshot IS NULL))
);
CREATE INDEX backup_pending ON amr_backup.outbox(retry_dal,creata_il) WHERE completata_il IS NULL;
CREATE TABLE amr_backup.manutenzione (
  categoria text PRIMARY KEY CHECK (categoria IN ('journal','database')),
  errore boolean NOT NULL DEFAULT false,
  snapshot text, pending boolean NOT NULL DEFAULT false
);
INSERT INTO amr_backup.manutenzione(categoria) VALUES ('journal'),('database');
CREATE TABLE amr_backup.configurazione (
  id boolean PRIMARY KEY DEFAULT true CHECK(id), configurato boolean NOT NULL DEFAULT false,
  retention_applicata boolean NOT NULL DEFAULT false,
  ultima_categoria text CHECK (ultima_categoria IN ('journal','database'))
);
INSERT INTO amr_backup.configurazione(id) VALUES(true);
REVOKE ALL ON ALL TABLES IN SCHEMA amr_backup FROM PUBLIC;
REVOKE ALL ON SEQUENCE amr_backup.sequenza FROM PUBLIC;
GRANT USAGE ON SCHEMA amr_backup, amr_accessi TO amr_backup_definitore;
GRANT SELECT,INSERT,UPDATE,DELETE ON amr_backup.outbox TO amr_backup_definitore;
GRANT SELECT,INSERT,UPDATE ON amr_backup.aziende_sequenza TO amr_backup_definitore;
GRANT SELECT,UPDATE ON amr_backup.manutenzione TO amr_backup_definitore;
GRANT SELECT,UPDATE ON amr_backup.configurazione TO amr_backup_definitore;
GRANT USAGE ON SEQUENCE amr_backup.sequenza TO amr_backup_definitore;
GRANT SELECT ON amr_accessi.aziende,amr_accessi.membri,amr_accessi.persone,
  amr_accessi.aziende_operazioni,amr_accessi.aziende_inviti,
  amr_accessi.colleghi_operazioni,amr_accessi.colleghi_inviti TO amr_backup_definitore;
GRANT EXECUTE ON FUNCTION amr_accessi.aziende_admin(uuid,integer,boolean) TO amr_backup_definitore;

CREATE FUNCTION amr_backup.accoda_operazione() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC'
AS $$
DECLARE v_journal jsonb; v_dominio text; v_new jsonb:=to_jsonb(NEW); v_invito jsonb; v_sequenza bigint;
BEGIN
  v_dominio:=CASE TG_TABLE_NAME WHEN 'aziende_operazioni' THEN 'aziende' WHEN 'colleghi_operazioni' THEN 'colleghi' END;
  IF v_dominio IS NULL THEN RAISE EXCEPTION 'backup_input_non_valido'; END IF;
  -- I writer aziende/colleghi detengono già aziende_blocca() fino al commit.
  v_sequenza:=nextval('amr_backup.sequenza'::regclass);
  IF v_dominio='colleghi' THEN
    SELECT jsonb_build_object('id',id,'stato',stato,'scadenza',scadenza,'persona',persona)
      INTO v_invito FROM amr_accessi.colleghi_inviti WHERE id=(v_new->>'invito')::uuid;
  ELSE
    SELECT jsonb_build_object('id',id,'stato',CASE WHEN persona IS NULL THEN 'pending' ELSE 'accettato' END,
      'scadenza',scadenza,'persona',persona) INTO v_invito FROM amr_accessi.aziende_inviti WHERE azienda=NEW.azienda;
  END IF;
  -- Allowlist costruita dallo stato nella transazione: NEW.dati non è copiato.
  SELECT jsonb_build_object('versione',1,'sequenza',v_sequenza::text,'dominio',v_dominio,'operazione',NEW.id,'tipo',NEW.tipo,
    'confermata_il',NEW.confermata_il,'attore',NEW.attore,
    'destinatario',(v_new->>'destinatario')::uuid,'invito',v_invito,
    'azienda',jsonb_build_object('id',a.id,'nome',a.nome,'attiva',a.attiva,'moduli',a.moduli,
      'scadenza',a.scadenza,'referente',a.referente,'accettata_il',a.accettata_il,
      'attivata_il',a.attivata_il),
    'persone',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,
      'attiva',p.attiva,'epoca',p.epoca,'membro',coalesce(m.azienda=a.id,false)) ORDER BY p.id)
      FROM amr_accessi.persone p LEFT JOIN amr_accessi.membri m ON p.id=m.persona
      WHERE m.azienda=a.id OR p.id=(v_new->>'destinatario')::uuid),'[]'::jsonb)) INTO v_journal
    FROM amr_accessi.aziende a WHERE a.id=NEW.azienda;
  IF v_journal IS NULL THEN RAISE EXCEPTION 'backup_outbox_non_disponibile'; END IF;
  INSERT INTO amr_backup.outbox(id,categoria,journal,sequenza,creata_il)
    VALUES ('journal:'||v_dominio||':'||NEW.id,'journal',v_journal,v_sequenza,NEW.confermata_il);
  INSERT INTO amr_backup.aziende_sequenza(azienda,sequenza) VALUES (NEW.azienda,v_sequenza)
    ON CONFLICT (azienda) DO UPDATE SET sequenza=greatest(amr_backup.aziende_sequenza.sequenza,EXCLUDED.sequenza);
  -- NOTIFY viene consegnato soltanto al commit; payload senza dati commerciali.
  PERFORM pg_notify('amr_backup_operazione','');
  RETURN NEW;
END $$;
CREATE TRIGGER backup_commerciale AFTER INSERT ON amr_accessi.aziende_operazioni
  FOR EACH ROW EXECUTE FUNCTION amr_backup.accoda_operazione();
CREATE TRIGGER backup_commerciale AFTER INSERT ON amr_accessi.colleghi_operazioni
  FOR EACH ROW EXECUTE FUNCTION amr_backup.accoda_operazione();

CREATE FUNCTION amr_backup.configura(p_configurato boolean,p_retention_applicata boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  IF p_retention_applicata AND EXISTS (SELECT 1 FROM amr_backup.configurazione WHERE id AND NOT retention_applicata) THEN
    UPDATE amr_backup.manutenzione SET pending=true WHERE snapshot IS NOT NULL;
  END IF;
  UPDATE amr_backup.configurazione SET configurato=p_configurato,retention_applicata=p_retention_applicata WHERE id;
END $$;

CREATE FUNCTION amr_backup.programma_database() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC'
AS $$
  INSERT INTO amr_backup.outbox(id,categoria)
    VALUES ('database:'||to_char(clock_timestamp(),'YYYY-MM-DD'),'database') ON CONFLICT DO NOTHING
$$;
CREATE FUNCTION amr_backup.claim(p_secondi integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
DECLARE v_id text; v_ora timestamptz:=clock_timestamp(); v_out jsonb; v_ultima text;
BEGIN
  IF p_secondi IS NULL OR p_secondi NOT BETWEEN 60 AND 3600 THEN RAISE EXCEPTION 'backup_input_non_valido'; END IF;
  -- Serializza solo la scelta breve, mai la copia esterna. Alternare categorie
  -- evita starvation dei dump con journal continui; per i journal vale sequenza.
  SELECT ultima_categoria INTO v_ultima FROM amr_backup.configurazione WHERE id FOR UPDATE;
  SELECT id INTO v_id FROM amr_backup.outbox
    WHERE completata_il IS NULL AND retry_dal<=v_ora AND (lease_fino IS NULL OR lease_fino<=v_ora)
    ORDER BY CASE WHEN categoria=v_ultima THEN 1 ELSE 0 END,sequenza NULLS LAST,creata_il,id
    FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE amr_backup.outbox SET lease=gen_random_uuid(),lease_fino=v_ora+make_interval(secs=>p_secondi),
    tentativi=tentativi+1 WHERE id=v_id
    RETURNING jsonb_build_object('id',id,'categoria',categoria,'journal',journal,'lease',lease) INTO v_out;
  UPDATE amr_backup.configurazione SET ultima_categoria=v_out->>'categoria' WHERE id;
  RETURN v_out;
END $$;
CREATE FUNCTION amr_backup.completa(p_id text,p_lease uuid,p_snapshot text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  IF p_snapshot IS NULL OR p_snapshot !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'backup_input_non_valido'; END IF;
  UPDATE amr_backup.outbox SET snapshot=p_snapshot,completata_il=clock_timestamp(),
    lease=NULL,lease_fino=NULL,errore=NULL
    WHERE id=p_id AND lease=p_lease AND lease_fino>clock_timestamp() AND completata_il IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE amr_backup.manutenzione SET snapshot=p_snapshot,pending=true
    WHERE categoria=(SELECT categoria FROM amr_backup.outbox WHERE id=p_id);
  RETURN true;
END $$;
CREATE FUNCTION amr_backup.fallisce(p_id text,p_lease uuid,p_errore text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  IF p_errore IS NULL OR p_errore NOT IN ('backup_non_configurato','backup_non_disponibile') THEN
    RAISE EXCEPTION 'backup_input_non_valido'; END IF;
  UPDATE amr_backup.outbox SET errore=p_errore,lease=NULL,lease_fino=NULL,
    retry_dal=clock_timestamp()+make_interval(secs=>least(3600,30*greatest(1,least(tentativi,120))))
    WHERE id=p_id AND lease=p_lease AND lease_fino>clock_timestamp() AND completata_il IS NULL;
  RETURN FOUND;
END $$;
CREATE FUNCTION amr_backup.retention_pending() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$ SELECT coalesce(jsonb_agg(jsonb_build_object('categoria',categoria,'snapshot',snapshot)), '[]'::jsonb)
  FROM amr_backup.manutenzione WHERE pending AND snapshot IS NOT NULL $$;
CREATE FUNCTION amr_backup.esito_retention(p_categoria text,p_snapshot text,p_errore boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$ UPDATE amr_backup.manutenzione SET errore=p_errore,pending=p_errore
  WHERE categoria=p_categoria AND snapshot=p_snapshot $$;
-- Pulizia DB solo di journal confermati da oltre 90 giorni. I pending non scadono.
-- I marker giornalieri DB restano piccoli e impediscono di ricopiare lo stesso giorno.
CREATE FUNCTION amr_backup.pulisci() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$ DELETE FROM amr_backup.outbox WHERE categoria='journal' AND completata_il IS NOT NULL
  AND errore IS NULL AND creata_il<clock_timestamp()-interval '90 days'
  AND completata_il<clock_timestamp()-interval '90 days' $$;
CREATE FUNCTION amr_backup.stato(p_persona uuid,p_epoca integer,p_mfa boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp SET timezone='UTC'
AS $$
DECLARE v_j jsonb; v_d jsonb; v_config boolean; v_pre bigint; v_ret boolean; v_applicata boolean;
BEGIN
  PERFORM amr_accessi.aziende_admin(p_persona,p_epoca,p_mfa);
  SELECT configurato,retention_applicata INTO v_config,v_applicata FROM amr_backup.configurazione WHERE id;
  SELECT bool_or(errore) INTO v_ret FROM amr_backup.manutenzione;
  v_applicata:=v_applicata AND NOT EXISTS (SELECT 1 FROM amr_backup.manutenzione WHERE pending OR errore);
  SELECT count(*) INTO v_pre FROM (
    SELECT 'journal:aziende:'||id AS id,confermata_il FROM amr_accessi.aziende_operazioni
    UNION ALL SELECT 'journal:colleghi:'||id,confermata_il FROM amr_accessi.colleghi_operazioni
  ) o WHERE NOT EXISTS (SELECT 1 FROM amr_backup.outbox b WHERE b.id=o.id)
    AND o.confermata_il>=clock_timestamp()-interval '90 days';
  SELECT jsonb_build_object('pending',count(*) FILTER (WHERE completata_il IS NULL),
    'failed',count(*) FILTER (WHERE errore IS NOT NULL),
    'confirmed',count(*) FILTER (WHERE completata_il IS NOT NULL),'ultimo',max(completata_il),
    'stato',CASE WHEN NOT v_config THEN 'non_configurato'
      WHEN bool_or(errore IS NOT NULL) OR (SELECT errore FROM amr_backup.manutenzione WHERE categoria='journal') THEN 'errore'
      WHEN bool_or(completata_il IS NULL) OR v_pre>0 THEN 'pending' ELSE 'confermato' END)
    INTO v_j FROM amr_backup.outbox WHERE categoria='journal';
  SELECT jsonb_build_object('ultimo',max(completata_il),
    'errore',CASE WHEN NOT v_config THEN 'backup_non_configurato'
      WHEN bool_or(errore IS NOT NULL) OR (SELECT errore FROM amr_backup.manutenzione WHERE categoria='database') THEN 'backup_non_disponibile' END,
    'stato',CASE WHEN NOT v_config THEN 'non_configurato'
      WHEN bool_or(errore IS NOT NULL) OR (SELECT errore FROM amr_backup.manutenzione WHERE categoria='database') THEN 'errore'
      WHEN coalesce(bool_or(completata_il IS NULL),false) OR NOT coalesce(bool_or(completata_il IS NOT NULL
        AND id='database:'||to_char(clock_timestamp(),'YYYY-MM-DD')),false) THEN 'pending' ELSE 'confermato' END)
    INTO v_d FROM amr_backup.outbox WHERE categoria='database';
  RETURN jsonb_build_object('configurato',v_config,'journal',v_j,'database',v_d,
    'retentionApplicata',v_applicata,'operazioniPreesistenti',v_pre,'avviso',NOT v_config OR NOT v_applicata OR v_ret OR v_pre>0
      OR (v_j->>'stato')<>'confermato' OR (v_d->>'stato')<>'confermato');
END $$;
CREATE FUNCTION amr_backup.riprova_admin(p_persona uuid,p_epoca integer,p_mfa boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp
AS $$
BEGIN
  PERFORM amr_accessi.aziende_admin(p_persona,p_epoca,p_mfa);
  UPDATE amr_backup.outbox SET retry_dal=clock_timestamp()
    WHERE completata_il IS NULL AND (lease_fino IS NULL OR lease_fino<=clock_timestamp());
  UPDATE amr_backup.manutenzione SET pending=true WHERE errore;
  RETURN jsonb_build_object('ok',true,'stato','pending');
END $$;

-- Proprietà ristretta delle funzioni; nessuna tabella leggibile dal worker/web.
GRANT CREATE ON SCHEMA amr_backup TO amr_backup_definitore;
ALTER FUNCTION amr_backup.accoda_operazione() OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.configura(boolean,boolean) OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.programma_database() OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.claim(integer) OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.completa(text,uuid,text) OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.fallisce(text,uuid,text) OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.retention_pending() OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.esito_retention(text,text,boolean) OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.pulisci() OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.stato(uuid,integer,boolean) OWNER TO amr_backup_definitore;
ALTER FUNCTION amr_backup.riprova_admin(uuid,integer,boolean) OWNER TO amr_backup_definitore;
REVOKE CREATE ON SCHEMA amr_backup FROM amr_backup_definitore;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA amr_backup FROM PUBLIC;
GRANT USAGE ON SCHEMA amr_backup TO amr_backup_esecutore,amr_aziende_scrittore;
GRANT EXECUTE ON FUNCTION amr_backup.configura(boolean,boolean),amr_backup.programma_database(),amr_backup.claim(integer),
  amr_backup.completa(text,uuid,text),amr_backup.fallisce(text,uuid,text),
  amr_backup.retention_pending(),amr_backup.esito_retention(text,text,boolean),amr_backup.pulisci() TO amr_backup_esecutore;
GRANT EXECUTE ON FUNCTION amr_backup.stato(uuid,integer,boolean),
  amr_backup.riprova_admin(uuid,integer,boolean) TO amr_aziende_scrittore;

-- Solo l'operatore del restore, prima di esporre Auth/AMR, nel DB separato.
-- I ruoli globali vanno ricreati dal manifest fidato: pg_dump non li include.
-- Riavviare i processi AMR elimina anche sessioni/challenge conservati in RAM.
CREATE FUNCTION amr_backup.invalida_accessi_ripristinati() RETURNS void
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
