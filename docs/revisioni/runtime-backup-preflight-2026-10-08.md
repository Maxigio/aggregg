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
