-- Upgrade esplicito dei database di collaudo già inizializzati; nessuna mutazione
-- automatica dello stack manuale. I record originari ISO/UTC restano compatibili.
-- Prima di migrare record importati in un altro formato, riconciliarli: un testo
-- come 03/04 non permette di stabilire senza contesto quale istante fosse voluto.
BEGIN;
ALTER FUNCTION amr_accessi.aziende_rinnova(uuid,integer,boolean,uuid,text,timestamptz)
  SET datestyle='ISO, MDY';
COMMIT;
