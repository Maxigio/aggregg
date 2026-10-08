# Preflight runtime R2 e monitor — 8 ottobre 2026

Segue [login e pannelli staging](candidato-ingress-staging-2026-10-08.md).
Baseline `cef0d0c`; immagine remota ancora `d632f50`. M2 e portali esclusi.

## Configurazione di aggiornamento e rollback

Finding confermato: `prepara-aggiornamento-staging.js` ammetteva solo la
configurazione precedente e rifiutava i campi R2/Better Stack già implementati
nel runtime. Il validatore ammette ora il gruppo completo
`AMR_COPIE_SEGRETI`, `AMR_COPIE_REPOSITORY`, `AMR_COPIE_PG_USER=amr_dump`
e, indipendentemente, `AMR_BETTERSTACK_WEBHOOK_URL`.

Tutti i valori riservati rimangono riferimenti Run. Non vengono risolti
nei pacchetti: la verifica del contratto runtime usa valori sintetici.
Gruppo backup parziale, ruolo diverso, valori letterali, duplicati e campi
ignoti sono rifiutati. Ogni fase conserva esattamente le opzioni presenti
o assenti; il rollback resta identico all'input.

Review indipendente: nessun bug di implementazione confermato; due lacune
nei test verificate mediante mutazioni in RAM. Corretti confronto integrale
delle opzioni e confronto di tutti i blocchi environment dei TOML.
Entrambe le mutazioni ora producono una failure mirata, senza modificare
il codice durante la controprova.

Prove Node 24.21.0 con ambiente sterile:

- 32 test ordinari del pacchetto PASS; due gate opt-in distinti.
- Gate HEAD completo PASS prima del successivo rafforzamento dei soli test;
  nessun overlay, credenziale o deploy.
- CLI Nhost ufficiale 1.51.2: dieci TOML baseline/runtime, cinque fasi
  ciascuno, validati senza login o rete.
- 21 test backup/runtime PASS; centro/incidenti 31/31 PASS. Le prime
  sette prove HTTP erano impedite da `listen EPERM` nel sandbox: ripetute
  autorizzando soltanto listener localhost, senza cambiamenti al codice.

## Permessi PostgreSQL e decisione

Inventario remoto in sola lettura, 14:08:45 UTC: `amr_dump` assente, zero
RLS applicative; `pg_read_all_data` non dispone di scrittura diretta né
EXECUTE su funzioni SECURITY DEFINER degli schemi applicativi esaminati.
Non sono state lette righe di persone, aziende o credenziali.

L'utente autorizza il ruolo dedicato nel solo staging, con
`pg_read_all_data`, senza superuser, scrittura o BYPASSRLS. Il dump completo
include i dati Auth e sarà cifrato con restic. La scelta di eseguire il dump
nel centro web resta confermata: non isola questi privilegi da una
compromissione dello stesso processo. Le regole HBA `trust` già rilevate
restano un limite distinto; l'inventario non prova una connessione di
escalation. Se in futuro viene aggiunta RLS, il dump deve fallire anziché
essere ristretto silenziosamente.

## Finding del monitor

GET remoto in sola lettura, 14:08:46 UTC: monitor `5036432` sospeso,
tipo `status`, nessuna keyword; controlli 30 s, timeout 10 s, recovery
60 s, email/push standard, altri canali disabilitati.

Il [checkpoint precedente](checkpoint-ingress-2026-10-08.md) ha osservato
Run rispondere 200 con body vuoto quando l'app è ferma. Il monitor solo
HTTP può quindi dichiarare sano quell'esito. Correzione preparata:
`monitor_type=keyword`, `required_keyword=ok`, mantenendo la sospensione
e tutti gli altri parametri. La keyword è case-insensitive e non è una
verifica universale dell'uguaglianza del body o delle funzioni applicative.
Non promette funzionamento di Auth, database o ricerche.

Ricevute private non sensibili e script di collaudo:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-runtime-backup-preflight-20261008-me172a0h/`.
Il preflight non ha applicato ruoli, configurazioni Run o notifiche.
Gli esiti dell'applicazione saranno registrati separatamente.

### Controprova nativa del ruolo

PostgreSQL 18.6 preesistente e fissato per digest, container nuovo senza
rete o porte, memoria 256 MiB. Il ruolo proposto produce un dump PGDMP di
1.518 byte della fixture, non dispone di privilegi amministrativi o DML,
e il dump fallisce quando viene attivata RLS. Container della prova chiuso
e volumi preesistenti invariati. Non è un dump o restore dello staging.

Il primo tentativo ometteva `-d postgres` dalla fixture e si fermava nel
dump: il client cercava un database con il nome del ruolo. Corretta la
fixture; il runtime AMR imposta già `PGDATABASE` esplicitamente.
La ricevuta iniziale fallita è preservata, non sostituita dal PASS.

Fonti: [ruoli PostgreSQL](https://www.postgresql.org/docs/18/predefined-roles.html),
[pg_dump e RLS](https://www.postgresql.org/docs/18/app-pgdump.html),
[keyword Better Stack](https://betterstack.com/docs/uptime/keyword-monitor/),
[PATCH monitor](https://betterstack.com/docs/uptime/api/update-an-existing-monitor/).

## Provisioning autorizzato e verificato

Alle 14:45:58 UTC il solo staging ha ricevuto `amr_dump` inizialmente
**NOLOGIN**, con `pg_read_all_data` ereditato ma non impostabile tramite
SET ROLE. Readback: nessun superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS,
limite due connessioni. Default: transazioni in sola lettura, timeout
statement 120 s e lock 10 s; password impostata con SCRAM-SHA-256.

Creati mediante `insertSecret` i due nuovi riferimenti
`AMR_COPIE_SEGRETI` e `AMR_COPIE_REPOSITORY`; ACK esatto del nome e
inventario dei soli nomi confermati. Nessun valore in ricevute, file di
configurazione, argomenti o output. Questo non attesta le politiche interne
di logging di Nhost. Configurazione Run non risolta identica prima/dopo;
nessun comando di avvio backup o modifica a M2/portali.

Review indipendente: confermati e corretti due difetti dell'executor
preparatorio (interruzione ignorata e ricevuta troncata prima della
riscrittura). Ora il journal JSONL è esclusivo, append-only e sincronizzato:
il tentativo è registrato prima della mutazione, l'ACK dopo; una scrittura
fallita impedisce altre mutazioni. Interruzione e ACK incerto non producono
successo o retry automatico. Riesame finale: **27 controprove mock PASS**.

Un rischio condizionato di sovrascrittura concorrente ha fatto sostituire
`updateSecret` con `insertSecret`. Schema Cloud consultato in sola lettura;
il sorgente ufficiale distingue la creazione e rifiuta un nome già presente.
La controprova di collisione è simulata, non un tentativo sul cloud.

Ricevuta: `provision-execute.jsonl` nella directory privata di preflight.
Il ruolo NOLOGIN e i secrets non dimostrano backup o restore funzionanti:
attivazione del runtime, copie effettive e restore isolato restano il gate
successivo. La retention rimane non distruttiva.

Riferimenti: [secrets Nhost](https://docs.nhost.io/platform/cloud/secrets),
[CLI create/update](https://docs.nhost.io/reference/cli/commands),
[sorgente insertSecret](https://github.com/nhost/nhost/blob/main/vendor/github.com/nhost/be/services/mimir/graph/m_insert_secret.go).
