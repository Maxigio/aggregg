# Recovery dai repository senza database sorgente — 7 ottobre 2026

## Obiettivo e confini

Segue [PostgreSQL e journal su R2](storage-r2-postgres-2026-10-07.md).
Baseline `460f4b7`, branch `feat/nodi-residenziali-prototipo`.
Il precedente test sceglieva i journal dall'outbox del source ancora acceso:
provava il restore, non la discovery dopo perdita del database originale.

Questo incremento completa la discovery delle **copie disponibili**, usando
restic e il replay esistenti. Non cambia SQL, formato dei backup, credenziali,
destinazioni, retention, runtime web o frontend. Solo cluster sintetici nuovi
sull'iMac; il collaudo R2 resta nei due bucket privati EU autorizzati, con
prefisso nuovo e payload cumulativo sotto 10 MiB. Nessuna cancellazione R2,
notifica reale, operazione sullo staging, sul servizio M2 o sui portali.

## Fonti ufficiali e debunking del piano

- [restic scripting](https://restic.readthedocs.io/en/stable/075_scripting.html#snapshots):
  `snapshots --json` restituisce un array con ID, host, path, tag e data.
  Si riusa questo indice anziché introdurre un catalogo parallelo non provato.
- [restic dump](https://restic.readthedocs.io/en/stable/050_restore.html#printing-files-to-stdout):
  lettura di un file per ID esatto. Niente `latest`, shell pipeline, nuovi
  file JSON decifrati o SQL eseguito dal contenuto del journal.
- [PostgreSQL sequence](https://www.postgresql.org/docs/18/functions-sequence.html):
  `nextval` non viene annullato dal rollback. `amr_backup.sequenza` usa proprio
  `nextval`: una numerazione non consecutiva non prova una copia mancante.
- [restic threat model](https://restic.readthedocs.io/en/stable/100_references.html#threat-model):
  integrità dei dati rimasti e rilevazione della scomparsa di un intero
  snapshot sono proprietà diverse. Non dichiarare la discovery completa
  rispetto a tutte le operazioni mai confermate.

Controprova nel codice AMR: due journal validi contengono ciascuno uno snapshot
commerciale completo; omettere quello precedente può lasciare un replay
valido del successivo, senza l'audit dell'operazione omessa. Il nuovo test lo
dimostra. Per attestare il punto di recovery e le copie necessarie serve una
decisione distinta sul checkpoint/indice duraturo. Non è stato introdotto
un formato o un protocollo di checkpoint senza concordarlo.

## Implementazione

- `backend/nodi/backup-restic.js`: `elenca(categoria)` applica host/path/tag,
  controlla nuovamente metadati e unicità, restituisce solo ID/data.
  Riusa cap di 10.000 snapshot e 16 MiB già approvati per l'indice; overflow
  o output inatteso interrompono, senza tagliare la lista.
- `leggiJournal(snapshot)` accetta solo ID completo, legge `/operazioni.json`
  con `restic dump`, limita l'output a 16 KiB come il journal SQL. Errori,
  JSON non valido e overflow non diventano lista vuota.
- `backend/nodi/ripristino-journal.js`: `preparaJournalDaRepository` legge e
  valida tutto prima del replay, deduplica copie con stesso dominio/UUID e
  fingerprint, rifiuta payload confliggenti o sequenze attribuite a operazioni
  diverse, ordina con `BigInt`. Non usa timestamp per scegliere i journal.
- Il replay già presente decide cosa è antecedente al dump usando il watermark
  aziendale ripristinato. I journal vecchi restano `superato`, senza ripristinare
  membership revocate o abbassare epoche. Nessun nuovo writer commerciale.
- `scripts/collauda-backup-r2-postgres.js`: chiude i client e spegne il solo
  source UUID della fixture prima della discovery; verifica stato Docker e
  rifiuto del pool chiuso. L'indice e il piano ricevono solo i repository.
  Stato atteso e hash della ricevuta restano oracoli di confronto del test,
  non input per la selezione. Il dump più vecchio viene scelto solo per
  esercitare il replay: non è la policy automatica del recovery operativo.

## Prove e limiti

Gate completo locale: `/private/tmp/amr-r2-pg-Qg2KGL/esito.json`.
250.204 byte cumulativi; due dump e tredici journal trovati; source spento;
sei journal già nel dump superati, sette successivi applicati, replay
idempotente, stato commerciale equivalente, revoche e permessi preservati,
vecchi accessi invalidati. Container/rete della fixture rimossi; copie
locali e chiave di prova conservate nella directory privata.

R2: `/private/tmp/amr-r2-pg-c4FYYQ/esito.json`, esecuzione unica completata
il 7 ottobre alle **19:47:16 Europe/Rome**, durata totale 138,286 s.
Prefisso nuovo `collaudo-pg-7ba0677a-1af7-454d-aef8-c1c7acff83eb`:
250.246 byte cumulativi, due dump e tredici journal. Discovery solo dai
repository, source spento, nessuna differenza commerciale nel confronto,
sette journal applicati e sei superati; retry idempotente, vecchi accessi
invalidati e permessi verificati. Il dump resta un file ripristinato e
verificato; i journal vengono letti soltanto in memoria.
Retention dry-run: due dump e tredici journal conservati, zero cancellati.
Cleanup confermato, gli otto container preesistenti invariati; copie R2 e
chiave temporanea della prova preservate fuori da Git. La durata non è una
misura del solo upload o della ricerca AMR.

Prima suite pertinente: **130/130**, zero fail/skip/cancelled, 65,976 s,
prima delle correzioni emerse dalla review. Un giro successivo ha dato
133/134 per il solo EACCES della nuova fixture descritto sotto; non viene
conteggiato come gate riuscito. Dopo la correzione del setup: **134/134**,
72,025 s, ricevuta `/tmp/amr-recovery-gate-4U26T1/esito.json`.
Gate finale dopo tutte le correzioni, inclusa la callback del test nativo:
**134/134**, zero fail/skip/cancelled, 73,283 s, ricevuta
`/tmp/amr-recovery-gate-33OCrS/esito.json`.

Node 26.4.0, restic 0.19.1. Sette file: backup-restic, ripristino-journal,
backup-r2-collaudo, backup, backup-notifiche, backup-http, schema-staging.
Comprende le prove restic reali locali, abilitate esplicitamente con
il binario verificato. Non è la suite completa né un nuovo gate Nhost Auth.
Schema del candidato `460f4b7`, undici migrazioni; nessun cambiamento SQL.

Controprove automatiche: ordine di timestamp diverso dalla sequenza,
duplicati equivalenti, operazione/sequence confliggenti, download fallito,
payload non ammesso, metadata inatteso, ID non completo, indice oltre cap,
body oltre 16 KiB. Errori prima di qualsiasi SQL; retry senza nuove scritture.
La prova di lista incompleta non viene conteggiata come difetto risolto.

### Finding confermato della review, corretto

**P2: indice parziale con exit 0.** In restic 0.19.1,
[FindFilteredSnapshots](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/find.go#L46-L70)
può omettere uno snapshot illeggibile e scrivere l'errore su stderr;
[`runSnapshots`](https://github.com/restic/restic/blob/v0.19.1/cmd/restic/cmd_snapshots.go#L77-L116)
può ancora restituire successo. Il wrapper prima drenava stderr senza
considerarlo e accettava la lista parziale/vuota. Non è il caso di una copia
completamente scomparsa: qui esiste una segnalazione di errore osservabile.

Due controprove simulate fallivano prima del fix; ora la sola discovery
rifiuta qualsiasi output diagnostico su stderr, anche con exit 0.
Il contenuto viene drenato e mai conservato/esposto; altri comandi restano
invariati. Scelta conservativa: anche un warning innocuo fermerà il recovery,
che resta un'attività offline, senza pubblicare un indice potenzialmente
incompleto. Non classificare stringhe libere del provider con regex fragili.

Prova nativa sul binario verificato: due snapshot in un repository locale
nuovo, uno reso illeggibile solo nella fixture. Restic restituisce exit 0,
stderr presente e il solo snapshot sano; il wrapper ora interrompe.
Byte originali e permessi del file vengono ripristinati; nuova discovery di
due snapshot e `check --read-data` passano. Test mirato 1/1, 9,429 s.
Il primo tentativo della nuova fixture era fermo per EACCES, prima della
corruzione: restic crea i file readonly. Corretto il solo setup della fixture,
rendendo scrivibile il proprio file appena creato e ripristinando il mode.
Quel tentativo non viene contato come PASS né come difetto AMR.

La seconda review ha inoltre verificato un **P2 nella sola prova nativa**:
`error?.code ?? 0` poteva trattare un processo interrotto con `code:null`
come exit 0. La callback ora rifiuta qualsiasi errore con messaggio fisso,
senza esporre stderr; il `finally` continua a ripristinare byte e permessi.
Cinque controprove in memoria del reviewer confermano il rifiuto degli errori
con codice nullo, numerico o assente e il successo solo senza errore.
Non era un comportamento del wrapper AMR: la correzione rende affidabile
la prova del comportamento nativo.

Dopo il fix, nuova discovery R2 **solo lettura**, sullo stesso prefisso
già collaudato: due dump/tredici journal, zero duplicati, guard stderr attiva.
Conclusa alle 19:51:30 Europe/Rome, ricevuta
`/private/tmp/amr-r2-pg-c4FYYQ/discovery-finale.json`. Nessun nuovo upload
o cancellazione: il ciclo completo R2 precedente non è stato ripetuto per
questa sola guard. Review indipendente finale chiusa: nessun finding
materiale residuo nel perimetro verificato; nessuna modifica o chiamata
esterna eseguita dal reviewer. Restano i limiti espliciti sotto.

Restano esclusi: discovery dopo perdita della chiave, selezione operativa
del punto di recovery, nuove identità/inviti non contenuti nel dump,
Nhost Auth completo, grandi volumi e performance a 10.000 download seriali,
scritture concorrenti durante il recovery, cancellazione di copie e prune.
Il restore resta offline e il database non va riaperto sulla sola base di
`check` o di un replay riuscito.

## Passi e decisioni prima del frontend della console

L'ordine operativo corrente resta quello richiesto nel
[registro console](console-ap-review-piano-2026-10-06.md#7-ottobre--decisione-proxy-applicata-e-ordine-successivo).
Non anticipare il brainstorming frontend.

| Passo ancora necessario | Decisione o prova mancante |
| --- | --- |
| Completare il gate backup (7) | Custodia duratura e recupero della chiave; punto di recovery attestabile e copie mancanti; credenziale R2 stabile/rotazione; backup vivi e restore isolato prima delle modifiche remote. Retention distruttiva resta separata. |
| Chiudere Better Stack (4) | Monitor HTTP a 30 s e recovery a **60 s**, come approvato dopo il rifiuto API di 30 s. Configurazione provider verificata, integrazioni ancora sospese; consegna push e risoluzione da provare. Il test isolato del webhook precede il gate backup; il collegamento al runtime staging segue backup/restore e aggiornamento del candidato. Prove più recenti nel registro notifiche. |
| Baseline prestazioni (5) | Due sole ricerche live già autorizzate: Alfa Romeo/Giulietta/Veloce e Fantic/Caballero 500/Rally, senza altri filtri e almeno 15 s fra ricerche della stessa fonte. Registrare release, cache e fonti; misure browser e processi separate dalle stime di rete. Due campioni non provano percentili o sostenibilità sotto carico. |
| Comandi e soglie (6) | Intervalli ammessi da misure, permessi e persistenza; modifiche solo per nuovi lavori e audit. Non aggirare pause automatiche. Default già approvati: 60 s, 2 pendenti/persona, 60 complessive. |
| CHECK intermittente | Catturare SQLSTATE/vincolo e condizioni violate senza dati personali; causa storica non dimostrata. Non rimuovere CHECK né nascondere il problema con retry. |
| Candidato remoto e M2 | Artefatto/schema aggiornati, backup/rollback e collaudo del candidato nello staging; M2 separato per stato/compatibilità, poi live solo con pause e limiti condivisi con il monolite. Nessun M2 collegato da questo incremento. |
| Review finale del branch | Verifica delle decisioni nel codice e nel candidato effettivo, correzione dei finding confermati, commit; non sostituibile dai soli test locali. |
| Frontend (8), dopo i gate | Applicare il brainstorming con contratti verificati e collaudo manuale dell'utente. UI clienti resta nel perimetro APP. |

Log e bug report su R2 richiedono inoltre campi ammessi, accessi e retention
distinti dai backup. Non sono autorizzati screenshot, allegati o copie di
annunci. Il loro eventuale gate va concordato; non viene aggiunto implicitamente
al prossimo incremento o al release blocker della console.
