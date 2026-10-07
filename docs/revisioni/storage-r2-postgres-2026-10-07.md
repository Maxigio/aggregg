# PostgreSQL e journal commerciali su R2 — 7 ottobre 2026

## Obiettivo e perimetro

Verificare il passo successivo al [collaudo di byte sintetici](storage-r2-debunking-2026-10-07.md):
dump PostgreSQL reale, copia cifrata, restore in un cluster separato e replay
ordinato delle operazioni commerciali successive al dump.

Solo dati sintetici sull'iMac e i due bucket R2 privati Standard EU già
autorizzati: `amr-collaudo-backup-db` e `amr-collaudo-backup-journal`.
Credenziale temporanea limitata ai due bucket; nessun collegamento ai backup
vivi, Nhost, M2, portali, log o bug report dei clienti. Payload cumulativo
strettamente inferiore a 10 MiB. Nessuna cancellazione di oggetti R2:
retention verificata soltanto in dry-run.

## Procedure e fonti verificate

- [PostgreSQL SQL dump](https://www.postgresql.org/docs/18/backup-dump.html):
  `pg_dump` produce uno snapshot consistente di un database; non salva i
  ruoli globali. Il collaudo ricrea un manifest di undici ruoli AMR prima
  del restore, senza password/login né privilegi amministrativi.
- [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html):
  `--single-transaction --exit-on-error`, senza `--no-owner` o `--no-acl`.
  Ownership e permessi fanno parte della verifica; il dump proviene solo
  dalla fixture fidata creata dal collaudo, non da SQL esterno arbitrario.
- [restic restore](https://restic.readthedocs.io/en/stable/050_restore.html):
  restore verificato in directory nuove, mai sopra un database vivo.
- [R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/):
  accesso limitato ai due bucket, endpoint con giurisdizione `.eu`.
- [Docker bridge](https://docs.docker.com/engine/network/drivers/bridge/):
  rete dedicata, porte casuali pubblicate esplicitamente su `127.0.0.1`,
  password PostgreSQL casuale tramite file 0600. Su questo Docker 29.5.2
  la rete `--internal` non assegnava le porte necessarie al client host:
  la prova iniziale si fermava prima di accedere al database. La rete
  bridge dedicata consente egress; il collaudo non effettua chiamate dai
  container a servizi esterni. Il percorso R2 è eseguito dall'iMac.

## Collaudo riproducibile

`scripts/collauda-backup-r2-postgres.js` è opt-in, separato dal runtime AMR.
Non carica `.env` automaticamente e non accetta destinazioni PostgreSQL
esterne. Usa solo il daemon Colima `amr-auth` locale e l'immagine PostgreSQL
18.6 già verificata e presente, con digest fissato e `--pull=never`.
Richiede il binario restic assoluto e la sua impronta SHA-256 verificata.

| Variabile | Uso |
| --- | --- |
| `AMR_TEST_BACKUP_DOCKER_HOST` | Socket della sola istanza Colima `amr-auth` |
| `AMR_TEST_RESTIC` | Percorso assoluto del binario verificato |
| `AMR_TEST_RESTIC_SHA256` | Impronta del binario ottenuta da fonte fidata |
| `AMR_TEST_R2_ENV` | File esplicito con i due campi AWS; ometterlo per repository locali |

Il file delle credenziali deve essere regolare 0600, appartenere all'utente
e trovarsi in directory 0700; symlink, campi inattesi e valori vuoti sono
respinti. I valori non vengono mostrati o passati negli argomenti dei
comandi. L'impronta verifica che il binario corrisponda a quello scelto,
non sostituisce la verifica preliminare della provenienza del download.

Esecuzione: `node scripts/collauda-backup-r2-postgres.js` con le sole
variabili esplicite sopra e un ambiente di collaudo. Ogni esecuzione crea
nuovi cluster, prefisso UUID nei repository e chiave restic privata.
La ricevuta `esito.json` e la chiave restano nella nuova directory privata
temporanea, fuori dal repository Git. La CLI sanitizza gli errori;
la ricevuta conserva fase, codici e nomi di colonne divergenti, senza
credenziali o record commerciali.

Percorso esercitato:

1. Due cluster nuovi con dati temporanei, source e recovery separati.
2. Schema Auth minimo sintetico con `citext`, non il provider Nhost;
   pacchetto completo `preparaSchema()` del commit `a2fa54a`, undici
   migrazioni e impronte registrate nella ricevuta.
3. Inviti aziendali, accettazione e attivazione, due inviti colleghi.
   Un primo dump precede sette operazioni: accettazione e attivazione della
   prima azienda, accettazione collega, rinnovo, revoca invito pending,
   revoca collega e revoca azienda.
4. Worker reale `creaBackupPostgres`, con `amr_backup_esecutore`, copia
   outbox e dump periodico in repository distinti; stato backup letto
   tramite `creaStatoBackup` con `amr_commerciale` e Admin sintetico.
5. Check completo restic, restore del dump e dei sette journal successivi,
   confronto di byte e SHA-256 prima di eseguire SQL.
6. Journal forniti in ordine inverso, ordinati dal replay reale; confronto
   di aziende, membership, persone, accettazioni e revoche degli inviti
   con il source. Il confronto esclude email, impronte/token e timestamp
   di creazione degli inviti: non sono ricostruiti dai journal.
7. Replay ripetuto senza cambiamenti; journal successivo senza la precedente
   accettazione rifiutato. Invalidazione delle epoche e delle righe refresh
   sintetiche, sessione con vecchia epoca respinta. Ruolo web senza accesso
   diretto ad Auth o outbox, funzioni Admin ancora utilizzabili.

## Finding confermati e correzioni

**Replay della revoca del collega incompleto.** Il writer marca revocati
anche gli inviti accettati della persona; il suo journal ha `invito: null`
ma conserva destinatario e timestamp dell'operazione. Il replay precedente
rimuoveva la membership e conservava l'epoca, lasciando invece l'invito
accettato e `revocata_il` vuoto. Confermato dal confronto PostgreSQL: uniche
colonne divergenti `colleghi_inviti.stato` e `revocata_il`.

Corretto `backend/nodi/ripristino-journal.js` nello stesso blocco atomico
degli snapshot applicabili: per una revoca collega aggiorna solo inviti
accettati della persona e azienda indicate, con il timestamp del journal.
Nessuna migrazione del formato, nuova autorizzazione o modifica dei ruoli.
Test di regressione fallente prima del fix e riuscito dopo; altri colleghi
e aziende restano invariati, retry idempotente. La membership era già
correttamente revocata: la prova non dimostrava un accesso ripristinato.
Fix e regressione salvati nel commit `a03587a`.

**Problemi del nuovo collaudo**, corretti prima della prova R2:

- Fixture storica con sole cinque migrazioni, senza l'accettazione corrente
  a tre parametri: sostituita con il pacchetto SQL completo del candidato.
- Manifest recovery senza `amr_login_definitore`: restore PostgreSQL
  interrotto, senza ignorare ownership/ACL. Manifest completato.
- Cleanup dopo risposta di creazione persa: nomi registrati prima del
  comando e rimozione solo dopo verifica dell'etichetta UUID. Controprova
  simulata di rete creata con esito incerto; risorsa rimossa e ricevuta
  coerente. Se la verifica fallisce, il collaudo segnala cleanup incompleto.
- Operazioni commerciali/stato eseguiti inizialmente come `postgres`:
  ora client dedicato `amr_commerciale`, anche per verificare funzioni e
  permessi dopo il restore. Il superuser rimane solo per setup, dump e
  recovery offline della fixture.
- Un successivo errore di `RESET ROLE` poteva saltare il rilascio del client
  backup e bloccare il cleanup. Confermato dalla review con mock `pg-pool`:
  connessione trattenuta e `pool.end()` sospeso. Client dedicati ora
  distrutti con `release(true)`; il rilascio backup è in un `finally`
  anche quando l'arresto del worker fallisce. Non servono reset SQL durante
  la chiusura dei cluster sintetici.

## Esiti e gate

Gate locale completo passato dopo il fix: due cluster PostgreSQL 18.6,
restic 0.19.1, Node 26.4.0; 15 copie (due dump e tredici journal),
250.216 byte cumulativi, sette journal successivi riprodotti. Stati
commerciali equivalenti e revoche preservate; retention dry-run conserva
due dump e tredici journal. Cleanup dei soli container/rete di prova
confermato, risorse preesistenti preservate.
Ricevuta locale: `/private/tmp/amr-r2-pg-KmjbcY/esito.json`.

Un tentativo del vecchio gate `nodi-ripristino-inviti-pg.test.js` si è fermato
su `PG not ready`, prima di qualsiasi SQL. La causa di quell'avvio non è
stata dimostrata. Il file resta invariato; quel tentativo non viene contato
come prova riuscita né come regressione del replay. La nuova prova su due
cluster ha invece esercitato realmente il dump, il restore e il caso di
revoca. Non è stata eseguita la suite completa o il collaudo Nhost Auth.

### R2 live

Esecuzione unica PG/R2 conclusa il **7 ottobre, 19:10:43 Europe/Rome**:

| Voce | Risultato verificato |
| --- | --- |
| Payload cumulativo | **250.245 byte**, inclusi due dump e tredici journal |
| Repository | Prefisso nuovo `collaudo-pg-39bf53c5-dd7b-4903-877e-092cede74fdc`, identità distinte |
| Integrità | Check completo restic e file ripristinati identici per dimensione e SHA-256 |
| Recovery | Secondo cluster PostgreSQL; sette journal successivi applicati e ripetuti |
| Confronto commerciale | Nessuna differenza nei campi confrontati delle cinque tabelle |
| Revoche e permessi | Inviti revocati, membership/epoche coerenti, accessi precedenti negati, writer limitato |
| Retention | Dry-run: due dump e tredici journal conservati, zero eliminabili/eliminati |
| Durata | **157,201 secondi** per l'intero percorso, non il solo upload |
| Cleanup | Container e rete nuovi rimossi dopo verifica UUID; copie R2 conservate |

Ricevuta: `/private/tmp/amr-r2-pg-7FcAiD/esito.json`. La directory privata
conserva separatamente la sola chiave di recovery di queste copie sintetiche.
Nessuna credenziale o contenuto dei journal entra in Git.

Suite pertinente: **39/39**, zero skipped, ultimo giro 1,906 s, Node 26.4.0; comprende
replay, guard del collaudo, pacchetto schema, notifiche backup e rotte HTTP.
La suite restic reale era già passata **61/61** nel passo precedente.
Review indipendente finale in sola lettura: fix replay, manifest, ruoli,
cleanup e ricevuta R2 ricontrollati; nessun finding materiale residuo nel
perimetro. Non ha rieseguito il collaudo cloud o verificato Nhost.

Il residuo del cleanup è stato corretto dopo la prova cloud riuscita:
il percorso di backup/replay resta invariato. Nuovo gate completo locale
con l'ultima versione passato, 250.275 byte e cleanup confermato;
ricevuta `/private/tmp/amr-r2-pg-WdXoBr/esito.json`. La prova R2 non è
stata ripetuta per questa sola modifica alla chiusura dei client.
Container e rete del collaudo rimossi, elenco degli otto container
Auth/GraphQL/PostgreSQL/MailHog preesistenti invariato.

Limiti: Auth è una fixture minimale, non Nhost; il nuovo stato Admin è
verificato nel servizio PostgreSQL con ruoli limitati, non nel browser o
nello staging. La selezione dei journal da riprodurre usa l'indice outbox
del source sintetico ancora disponibile e le ricevute delle copie; questa
prova non collauda il recupero dell'intera sequenza dal solo R2 dopo perdita
del database. Non prova tutti i casi di journal mancante, inviti creati
dopo il dump, credenziali/scadenze del provider o recovery senza la chiave.
Lo schema è quello di `a2fa54a`; il replay include il fix verificato nel
worktree, senza cambiamenti SQL. Il gate usa il runtime iMac e non è un
gate di rilascio Nhost/M2.

Restano distinti: backup vivi e loro scheduling, indice di recovery e
procedura senza source, retention con cancellazione, custodia duratura
della chiave, account R2/permessi di altri bucket, recovery Auth completo,
grandi database, costi mensili, UI staging e collegamento M2. Nessun deploy
o attivazione di log/bug report su storage. La credenziale conserva la
scadenza temporanea di 24 ore.
