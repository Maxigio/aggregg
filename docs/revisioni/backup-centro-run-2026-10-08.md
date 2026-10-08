# Collegamento backup del centro Run — 8 ottobre 2026

Baseline `8622564`, branch `feat/nodi-residenziali-prototipo`. Segue
[repository R2 dello staging](storage-r2-staging-2026-10-08.md).
Incremento locale: collegare le dipendenze del worker esistente senza
attivare cloud, acquisire credenziali reali, creare ruoli o cambiare l'M2.
Il gate operativo del backup resta distinto da questo incremento.

## Piano verificato e implementazione

`config-centro-run.js` legge una configurazione esplicita; `centro-run.js`
la passa al nuovo `backup-centro-run.js`, che riusa `creaRestic` e
`creaDumpPostgres`. Il worker conserva outbox, lease, CAS, notifiche,
polling, codici d'errore e azzeramento dei buffer. Nessuna implementazione
parallela di backup, cifratura, SQL o retention.

Senza variabili `AMR_COPIE_*` resta il precedente stato non configurato.
Una configurazione parziale, sconosciuta o invalida impedisce invece l'avvio:
non viene degradata silenziosamente a backup disabilitato. I tre pool
vengono chiusi anche quando la preparazione delle copie fallisce.

Configurazione necessaria, senza segreti nei valori di esempio:

| Variabile | Contenuto |
| --- | --- |
| `AMR_COPIE_R2_ENV` | Percorso assoluto del file con le sole due credenziali AWS R2 |
| `AMR_COPIE_PASSWORD_FILE` | Percorso assoluto della chiave restic già custodita |
| `AMR_COPIE_RESTIC` | Percorso assoluto del binario verificato |
| `AMR_COPIE_RESTIC_SHA256` | SHA-256 atteso del binario |
| `AMR_COPIE_PG_DUMP` | Percorso assoluto del binario PostgreSQL verificato |
| `AMR_COPIE_PG_DUMP_SHA256` | SHA-256 atteso del binario |
| `AMR_COPIE_PG_PASSFILE` | Percorso assoluto del passfile PostgreSQL |
| `AMR_COPIE_PG_USER` | Identità dedicata al dump, distinta dal ruolo dell'outbox |
| `AMR_COPIE_REPOSITORY` | JSON chiuso con endpoint EU e bucket/ID dei due repository |

Esempio esclusivamente sintetico del JSON:

```json
{
  "endpoint": "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.eu.r2.cloudflarestorage.com",
  "database": {"bucket": "backup-db-prova", "id": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
  "journal": {"bucket": "backup-journal-prova", "id": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"}
}
```

Bucket e ID devono essere diversi; prefisso fisso `restic`. Nessun URL
con credenziali, percorso arbitrario, fallback a `latest` o inizializzazione
automatica. Ogni identità letta da restic deve corrispondere all'ID atteso.
La retention resta dry-run: questo incremento non autorizza eliminazioni.

Il dump usa host, porta e database della configurazione PostgreSQL validata,
con utente/passfile espliciti. Sulla rete privata ammessa dal centro resta
il comportamento TLS esistente; fuori da essa `verify-full` e
`PGSSLROOTCERT=system`, da collaudare con il client PostgreSQL scelto.
I processi restic non ricevono credenziali PostgreSQL; pg_dump non riceve
quelle AWS. Password, URI con password e token non entrano negli argomenti.

File segreti 0600 in directory finale 0700, stesso utente, file regolare,
senza seguire il symlink finale. Su macOS anche controllo ACL, con ambiente
dedicato privo dei segreti del centro. Il parser R2 è condiviso con il
collaudo precedente, conservandone il codice d'errore pubblico.

Binari eseguibili non scrivibili da gruppo/altri, proprietario root o utente
corrente, SHA atteso: controllo al setup e prima di ogni processo.
Anche i permessi dei file necessari vengono ricontrollati prima dello spawn.
La credenziale R2 resta quella acquisita al setup: nessuna rotazione implicita.
Il confronto SHA non attesta da solo la provenienza del download e non elimina
la race fra controllo e apertura. Packaging immutabile e directory protette
restano requisiti del runtime; non è una difesa contro un host compromesso.

## Review, prove e controprove

Tre problemi corretti nell'incremento:

1. Il controllo ACL con `ls` ereditava l'ambiente del centro. Controprova
   in VM con sentinella sintetica; ora usa soltanto LANG e TZ espliciti.
2. I quattro test di startup in VM non includevano la nuova dipendenza:
   tutti fallivano prima della correzione della require-map; ora verificano
   nuovamente chiusura durante init/listen e assenza di avvio tardivo.
3. Sostituire stabilmente un binario dopo il setup poteva consegnargli
   credenziali sintetiche. La regressione conferma ora il rifiuto prima
   dello spawn; anche il cambio dei permessi di chiave, passfile e file R2
   blocca il processo. Richiede accesso ai file locali: rischio condizionato,
   senza evidenza che i binari del runtime remoto siano modificabili.

Il test del parser è stato controverificato ripristinando il contenuto valido
prima di ogni input avverso: un caso precedente non deve causare il rifiuto
del successivo e mascherare un errore del parser.

Le prove iniziali dei nove casi dell'adapter e dei quattro casi di startup
sono **13/13 Node 24.21.0**, zero skip/fail/cancel. Il test dell'entrypoint
attraversa spawn con eseguibili Node sintetici e il worker effettivo; SQL
resta simulato. Conferma due job e chiusura dei tre pool, anche con un file
di configurazione assente. Non è un backup PostgreSQL reale o R2 remoto.

Gate finale pertinente: **125/125 Node 24.21.0**, zero fail/skip/cancel,
79,435 s, nove file backup/runtime/recovery. Include cinque scenari nativi
restic **0.19.1**, esclusivamente su repository locali nuovi; nessuna
credenziale reale. Dati/log di test in directory temporanee e ambiente
dedicato. Ricevuta e TAP privati:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-backup-run-gate-RCuf88/`.
Il gate 13/13 è incluso e non viene sommato. Non è la suite completa AMR
o un nuovo collaudo Nhost Auth. Nessuna nuova richiesta ai portali.

Seconda review indipendente in sola lettura: 95 prove focalizzate passate,
quattro casi di startup inclusi senza filtro. Controprove ulteriori con
symlink e directory resa 0755: rifiuto prima dello spawn. Verificate le
ricevute del main, parser condiviso, default non configurato, retention
dry-run e chiusura dei pool. Nessun nuovo finding confermato nel perimetro;
resta il rischio TOCTOU condizionato già dichiarato. Non sommare i conteggi
dei due reviewer/runner come se fossero casi distinti.

## Permessi del dump: ostacolo verificato

Prova nativa PostgreSQL **18.6**, immagine preesistente fissata per digest,
nuovo container senza rete né porte pubblicate. Undici migrazioni AMR di
HEAD `8622564`, schema Auth minimo e dati esclusivamente sintetici.

- Il ruolo attuale `amr_copie` non può eseguire il dump: permission denied.
- Un ruolo di prova senza login, privilegi amministrativi o scrittura, con
  `pg_read_all_data`, produce un archivio PGDMP di **117.202 byte**.
  `pg_restore --list` ne legge il TOC e comprende i dati di `auth.users`.
- UPDATE con lo stesso ruolo viene rifiutato.
- Abilitando RLS sulla tabella sintetica, pg_dump viene rifiutato:
  `pg_read_all_data` non è una soluzione universale per il database Nhost.

Ricevuta privata: `/private/tmp/amr-backup-ruolo-CvK2bb/esito.json`.
Controllo delle risorse preesistenti prima/dopo e cleanup del solo container
creato confermati. Nessun ruolo remoto modificato; leggere il TOC non
sostituisce un restore SQL completo né riproduce tutto lo schema Nhost Auth.

**Decisione da discutere prima dell'attivazione:** identità dedicata al dump,
perimetro dei dati e collocazione del processo con questi privilegi.
Raccomandazione: mantenere i tre ruoli web/outbox limitati; definire il dump
separatamente dopo la verifica dei privilegi e di RLS sullo staging.
Non attribuire automaticamente superuser o BYPASSRLS al centro.

## Prossimo gate

Il Dockerfile del centro non contiene ancora restic o pg_dump: questa
configurazione non è stata applicata a Run. Prima dell'attivazione servono
binari Linux e librerie verificati, provisioning dei file privati, identità
del dump approvata, backup DB/journal effettivi e restore isolato con punto
di recovery e ricevuta custodita separatamente. Anche la seconda copia
offline della chiave resta da confermare. Il checkpoint dell'intero volume
Run prima della manutenzione è distinto dal dump/journal ordinario.

Fonti ufficiali consultate:

- [PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html):
  consistenza del dump, privilegi e limiti rispetto agli oggetti globali.
- [Ruoli predefiniti](https://www.postgresql.org/docs/18/predefined-roles.html):
  `pg_read_all_data` non bypassa RLS.
- [Passfile](https://www.postgresql.org/docs/18/libpq-pgpass.html) e
  [sslrootcert](https://www.postgresql.org/docs/18/libpq-connect.html#LIBPQ-CONNECT-SSLROOTCERT):
  permessi del file e verifica TLS con trust store di sistema.
- [restic backup](https://restic.readthedocs.io/en/stable/040_backup.html) e
  [restore](https://restic.readthedocs.io/en/stable/050_restore.html):
  una copia o un check non sostituiscono la prova di ripristino.
- [OWASP Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html):
  minimo privilegio, separazione, custodia e ciclo di vita delle chiavi.

## Decisione successiva: esecuzione nel centro web e packaging

Il proprietario sceglie dump e upload nel medesimo centro web, senza un
servizio Run permanente aggiuntivo. R2 conserva le copie; non esegue il dump.
Confermati anche la seconda copia offline della chiave restic R2 e il recapito
visibile della push sintetica Better Stack. Le raccomandazioni precedenti su
un executor separato non rappresentano più la direzione scelta.

L'identità del dump deve restare distinta dall'outbox e senza scrittura;
i subprocess ricevono ambienti separati. Questo non isola i privilegi dal
processo web: un attaccante che compromette quel processo può accedere ai
suoi segreti. Le regole `trust` del PostgreSQL Nhost restano un rischio da
verificare con una connessione effettiva, non una prova di escalation già
eseguita. Nessun nuovo ruolo o privilegio remoto applicato in questo incremento.

`backup-segreti-run.js` prepara i tre file temporanei privati dal riferimento
Run `AMR_COPIE_SEGRETI`. JSON chiuso: credenziali R2, chiave restic e password
del dump; niente password in argv, log o volume diagnostico. I metadati dei
binari sono generati nell'immagine e protetti insieme al codice. La chiusura
rimuove soltanto i tre file creati dopo aver verificato l'identità della
directory. I buffer di scrittura vengono azzerati; le stringhe JavaScript
non consentono una garanzia di cancellazione fisica dei segreti dalla RAM.
SIGKILL non esegue il cleanup applicativo; i file non sono collocati nel
volume persistente.

Il Dockerfile riusa immagini ufficiali fissate per digest: Node 24.21.0,
PostgreSQL 18.6 e restic 0.19.1. L'entrypoint PostgreSQL è disattivato;
parte soltanto Node come UID 1000. La base conserva il `VOLUME` PostgreSQL:
lo smoke locale lo copre con tmpfs e usa `--rm`, evitando volumi anonimi
residui. Nessun database server viene avviato dal centro.

### Verifiche e controprove dell'incremento

- **28/28 test Node 24.21.0**, quattro file runtime/backup, zero skip o
  failure, ambiente privo delle credenziali reali. Il sorgente completo
  dell'entrypoint viene eseguito in VM con dipendenze simulate.
- La prima review indipendente ha individuato due problemi confermati:
  porta pgpass non canonica (`05432` contro `5432`) e rejection del cleanup
  non gestita durante arresto/startup. Corretti con test di regressione:
  porta normalizzata come il config, diagnostica fissa ed exitCode 1,
  senza percorsi o errori grezzi.
- Seconda review indipendente in sola lettura: entrambi i fix confermati,
  **12/12 test sintetici** sui due file avvio/segreti, nessun nuovo finding
  nel perimetro di cinque file. Il build Docker resta una prova del main,
  non una seconda esecuzione indipendente del packaging.
- Build **Linux amd64** della sola ricetta Docker PASS, con sorgenti del
  precedente commit `c01d109`: non è l'artefatto distribuibile del nuovo
  codice. Smoke senza rete: UID 1000, Node 24.21.0, SHA dei due binari e
  verifica del precedente manifest PASS. Il gate Auth dell'artefatto
  definitivo resta necessario.

### Incidente locale durante il collaudo

Il profilo Docker `amr-auth` aveva 10 GiB esauriti. Su autorizzazione del
proprietario è stato ampliato a 30 GiB: circa 19 GiB disponibili, stessi
otto container, stessi 38 volumi e contesto Docker invariato. Nessun prune,
eliminazione di immagini o file, installazione host o intervento M2.

**Mancato controllo prima del riavvio:** i due PostgreSQL preesistenti
conservavano i dati in tmpfs. Il riavvio ha azzerato quello stato volatile;
l'inventario dei volumi non lo proteggeva. Ricreato soltanto lo schema Auth
iniziale secondo il runner esistente; tutti gli otto container sono ripartiti,
ma i due database Auth hanno zero utenti. Gli account e gli stati precedenti
non sono stati ripristinati. Non equiparare il riavvio a un restore dei dati.
Per future operazioni rilevare anche tmpfs e ottenere una copia consistente
prima di arrestare un ambiente di cui occorre preservare lo stato.

Ricevute locali:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-colima-ampliamento-20261008-lkndcfua/esito.json`
e `/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-staging-checkpoint-yv4g1p_e/build-riprova.log`.

Il checkpoint remoto tentato prima dell'aggiornamento non è acquisito:
download HTTP rifiutato, configurazione originale Run ripristinata e
confrontata esattamente. `/healthz` 200 ma frontend 403 su richieste ripetute.
La diagnosi ingress e il restore verificato precedono altri aggiornamenti.
Backup automatici R2 non attivati, candidato non distribuito, M2 non collegato.

### Diagnosi del gate completo e correzione della fixture

Build immutabile del commit `fffdf17`, Linux amd64, eseguito: Node 24.21.0,
UID 1000, pg_dump 18.6 e restic 0.19.1 funzionanti. Il gate completo con
Auth reale locale e restic nativo si è fermato nel restore commerciale.
La diagnostica filtrata conferma `pg_restore` exit 1: manca
`amr_login_definitore`, richiesto dall'OWNER della funzione `inizio_login`.
Il problema è nella lista dei ruoli della fixture, precedente alla nuova
migrazione login; non dimostra un dump corrotto o un guasto di restic.

Il runner ricrea ora quel ruolo NOLOGIN con attributi limitati e verifica
il proprietario effettivamente ripristinato. Restano ACL, transazione unica
e invalidazione degli accessi: nessun `--no-owner` o `--no-acl` per ottenere
un PASS artificiale. La [documentazione PostgreSQL](https://www.postgresql.org/docs/18/app-pgrestore.html)
descrive il ripristino degli owner; i ruoli globali devono essere preparati
separatamente dal dump del database.

La review indipendente ha rilevato un volume anonimo anche nella fixture
TLS, che usa la stessa immagine PostgreSQL. Il tmpfs sul percorso inutilizzato
è stato spostato nei limiti comuni a centro e TLS. Seconda review statica:
nessun finding nei due diff. Il nuovo gate reale è **PASS**, exit 0: login/MFA,
centro HTTPS e riavvio, permessi, restic nativo, restore nel secondo cluster,
replay dei journal, revoche e invalidazione degli accessi; cleanup verificato.
Questi runner modificati non fanno parte dell'immagine `fffdf17` già costruita:
il candidato definitivo richiede un nuovo contesto immutabile dopo il commit.

Ricevuta locale del gate corretto:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-candidato-fffdf17-verifica-561k2_ei/auth-gate-corretto.log`.
Le due controprove precedenti falliscono sul ruolo mancante. Nessun nuovo
CHECK 23514 osservato: la causa intermittente storica resta non dimostrata.

La sonda ingress non ha ancora prodotto misure. La review ha confermato
una riserva insufficiente per l'arresto entro la finestra: tentativo interrotto
prima delle misure, conversazione MCP non più utilizzabile per il recovery.
Una connessione nuova ha ripristinato esattamente la configurazione originale
e richiesto una replica; questo readback non attesta da solo la disponibilità
HTTP. Il controller rivisto separa recovery e frontend funzionante, riserva
600 secondi all'arresto e usa una nuova connessione per il recovery.
Readback successivo: configurazione originale esatta, Running, una replica
pronta e health 200. Due successivi tentativi della sonda si fermano prima
delle mutazioni: prima preflight non disponibile, poi inizializzazione MCP
non disponibile. Un controllo indipendente inizializza la CLI correttamente;
non è dimostrata una scadenza del login. Nessuna nuova misura ingress,
aggiunta di IP o modifica dei controlli di trasporto.
