# Ripristino: numerazione dei journal — 3 ottobre 2026

## Obiettivo e perimetro

Incremento successivo alla preparazione dello staging, sul branch
`feat/nodi-residenziali-prototipo`, baseline `e1e3f76`. Corregge B01 della
[review precedente](branch-nodi-2026-10-02-646fcbe.md): dopo il replay dei journal,
le nuove operazioni commerciali potevano ricevere numeri già recuperati e
venire ignorate da un secondo restore.

Solo codice SQL, migrazione per recovery, launcher e test di collaudo. Nessuna
modifica ai database manuali, Nhost, M2, credenziali o portali. Lo staging Run
resta con zero repliche; questo incremento non autorizza il suo avvio.

## Prova prima della correzione

Il test PostgreSQL esistente è stato esteso usando `applicaJournal` realmente,
al posto del replay parziale scritto dentro la fixture. Su PostgreSQL 16/Auth
locali, il rinnovo dopo replay e invalidazione riceve una sequenza inferiore
alla massima importata: fallisce l'asserzione del secondo restore.

Un primo tentativo non raggiungeva questa prova: la fase preesistente di copia
da NOTIFY falliva. Il successivo arriva all'asserzione specifica B01. Non si
confonde quell'esito preliminare con una prova della vulnerabilità.

Evidenza: `/private/tmp/amr-b01-before.log`. Tutte le identità sono sintetiche;
gli errori non espongono messaggi raw SQL/Auth o credenziali. Sono ammessi solo
fase, codice controllato e posizione dell'asserzione.

## Correzione e controverifiche

`amr_backup.invalida_accessi_ripristinati()` acquisisce il lock del replay e
quello dei writer commerciali. Considera il massimo dei checkpoint del dump,
dell'outbox e dei due registri offline. Aggiorna la sequenza globale soltanto
in avanti, dopo aver invalidato accessi e inviti.

- I checkpoint originali del dump non vengono riscritti: servono ancora a
  distinguere un journal antecedente alla copia.
- `last_value` e `is_called` preservano anche i buchi da rollback e la sequenza
  nuova che non ha mai assegnato un numero.
- Una sola tabella di audit presente è un errore esplicito: finalizzazione
  rifiutata, nessuna invalidazione parziale o variazione della sequenza.
- Nessun nuovo privilegio per i ruoli web o backup; funzione invoker e
  `EXECUTE` revocato a PUBLIC.

Un dump storico contiene la vecchia definizione SQL. La migrazione
`backend/nodi/schema-ripristino-sequenza.sql`, riapplicabile, va eseguita dal
manifest fidato **dopo pg_restore, prima della finalizzazione**. Il launcher
di recovery locale lo fa esplicitamente. Per nuove installazioni la stessa
correzione è già nello schema backup iniziale.

Restore e finalizzazione restano operazioni **offline** su un database separato:
Auth, AMR e worker backup non vanno riaperti prima del commit concluso. I lock
non trasformano questa procedura in un restore online supportato.

## Prove e limiti

Gate PostgreSQL/Auth/restic con repository locali, ruoli limitati, due cluster
nuovi e un secondo database di recovery. Comprende restore → replay →
finalizzazione → nuovo rinnovo → secondo restore; più aziende; migrazione
ripetuta; rollback; audit incompleto; contatore mai usato; rifiuto della
finalizzazione al writer; vecchi refresh/JWT invalidati e nuovo login riuscito.

Esito finale: **6/6 pass, nessuno skip o errore**, PostgreSQL 16/Auth reali
e restic locale. Review indipendente in sola lettura: nessun finding bloccante
nel diff; verificati lock, massimo globale, patch e privilegi. Il coordinatore
ha ricontrollato le conclusioni contro codice e prove prima della chiusura.
Log: `/private/tmp/amr-b01-after.log`. Suite completa Node 24.21.0:
**1.216 test, 1.212 pass, quattro gate opt-in esclusi, zero failure**,
`/private/tmp/amr-b01-suite.log`. Il gate PG opt-in è eseguito separatamente.

Non sono prove di PostgreSQL Nhost remoto, recovery gestito dal provider,
storage S3 o procedura cloud. La vecchia immagine `646fcbe` non contiene il fix:
prima di distribuirlo occorre un artefatto dal nuovo commit e il suo gate.

Rifinalizzare offline incrementa nuovamente le epoche e invalida nuovamente
gli inviti; è la numerazione a essere idempotente, non ogni effetto della
procedura. Un eventuale avanzamento `setval` sopravvissuto al rollback lascia
un buco ammesso. Il recovery va ripetuto e finalizzato con commit riuscito
prima della riapertura; non è stata simulata un'interruzione del server dopo
`setval`. Resta da provare il restore dei metadati SQLite, distinto da B01.

## Fonti confrontate con il codice

- [PostgreSQL 16: sequenze](https://www.postgresql.org/docs/16/functions-sequence.html):
  `setval` è visibile subito e non viene annullato da rollback. Per questo
  viene eseguito per ultimo e mai all'indietro; un buco non è perdita di un journal.
- [Lock](https://www.postgresql.org/docs/16/explicit-locking.html): un advisory
  lock funziona solo fra operazioni che lo rispettano. Si usa anche il lock
  commerciale già adottato dai writer, senza promettere sicurezza di un restore live.
- [pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html): il dump conserva
  definizioni e stato del database, non i ruoli globali. Definizione corretta e
  ruoli ristretti devono provenire dal manifest fidato, non da credenziali copiate.
