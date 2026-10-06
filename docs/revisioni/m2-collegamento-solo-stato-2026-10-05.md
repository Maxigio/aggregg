# Primo collegamento M2: solo stato — 5 ottobre 2026

## Perimetro e stato

Segue il [collaudo iMac](staging-collaudo-nodi-2026-10-05.md), completato nel
browser dall'utente: login, azienda attiva, solo Moto e tre fonti riuscite.
Il primo punto è nel commit `7d25454`. Questa fase prepara il secondo punto:
worker M2 separato, connessione e compatibilità, senza richieste ai portali.
La preparazione locale non equivale a un worker M2 collegato.

Il centro cloud usa ancora `66e2b24`. Le modifiche successive richiedono un
nuovo artefatto dello stesso commit per centro e worker; nessun overlay del
checkout condiviso e nessuna sostituzione dell'AMR di produzione. Lo stato Run
è stato riletto senza risolvere segreti: una replica, immagine per digest,
volume da 1 GiB e 22 variabili, conformi al validatore del pacchetto staging.
Questa lettura non prova backup, arresto o rollback sul provider.

## Implementazione e controprove

- `AMR_NODO_SOLO_STATO=1`: il worker verifica il manifest, si registra e invia
  heartbeat, senza caricare `operazioni` o `annullo` e senza fare poll.
- Il centro esclude questo nodo da assegnazione generica, ricerca, dettagli,
  cataloghi, composizione e fallback, compreso quello verso un simulatore.
  L'eventuale coda precedente viene interrotta. Un lavoro già consegnato resta
  soggetto alle regole preesistenti di esito incerto; non si presume di annullare
  una richiesta al portale già partita.
- Il flag opzionale viene validato come booleano; boot e sequenza restano
  verificati prima di aggiornare lo stato. I worker ordinari non cambiano modo.
- Admin: «Solo stato · ricerche disabilitate», fonti «portale non verificato».
  La rimozione di una sospensione manuale non toglie il vincolo del worker.
  Le pause lette appartengono ai dati isolati del worker, non al processo M2
  di produzione e non a un probe live della piattaforma.
- Il launcher ammette `--solo-stato`, incompatibile con `--live`. Un artefatto
  vecchio ma integro potrebbe ignorare il flag: in questa modalità il worker
  deve coincidere con quello del launcher. Controprova fallente prima della
  guardia e passante dopo; rifiuto prima di mkdir/spawn. Le altre modalità
  mantengono il comportamento precedente.

## Verifiche

Node 24.21.0, credenziali sintetiche e dati temporanei; nessun portale o M2
interrogato dai test. Il sandbox nega i listener loopback con EPERM: i test HTTP
sono stati ripetuti fuori sandbox nel perimetro autorizzato.

- 36/36 test centro, processo worker e launcher.
- 91 pass, zero failure/cancelled, due skip opt-in: UI browser, compatibilità,
  config Run e pacchetto aggiornamento. Gli skip sono materializzazione del
  vero Git HEAD e validazione TOML con CLI, non il nuovo test UI.
- Review indipendente in sola lettura: nessun finding verificato residuo;
  57 test offline e 18 scenari aggiuntivi dichiarati dal reviewer. Controprove
  su poll durante controllo asincrono, boot vecchio, sequenza obsoleta,
  dettagli autorizzati, fallback reale/simulato e vecchio worker. Non estendere
  questa evidenza a browser, Nhost o M2 del reviewer.
- Suite completa iniziale fuori sandbox: 1.457 pass, zero assertion fallite,
  due test browser cancellati per timeout e nove skip opt-in. I due test
  preesistenti passano nella controprova isolata, con gli stessi timeout:
  12/12. Il giro completo era sovrapposto al collaudo browser mirato; il
  nesso con il carico è plausibile, non una vulnerabilità runtime dimostrata.
  Il giro con quattro file simultanei ha poi riprodotto due assunzioni errate
  dei test: una deadline di 100 ms può scadere in coda prima del poll, mentre
  il timeout TLS di 20 ms può precedere l'invio HTTP. Nessun timeout o limite
  applicativo aumentato. Il timer del lavoro è ora pilotato dopo la consegna;
  la sonda ammette zero o una richiesta e prova anche un DNS trattenuto fino
  alla scadenza, senza HTTP successivo né retry. Test mirati: 32 pass, uno
  skip opt-in sulle attese lunghe.
- La review indipendente ha falsificato la prima correzione con mock globale
  dei timer: su Node 26 interferiva con HTTP/Undici. Corretta usando il sorgente
  verbatim del centro con il solo timer lessicale sostituito nel test. Timer
  HTTP e budget reali; controprove del caso con Node 24 e 26: 1/1 ciascuna.
  Review statica conclusiva: finding chiuso, assert su incerto, tardivo e stato
  Admin preservati; nessuna modifica al runtime.
- Un ulteriore giro completo con quattro file simultanei: 1.458 pass,
  due failure UI, zero cancelled e nove skip. Il test dei dettagli assumeva
  che il polling non fosse già terminato prima dell'apertura: corretto
  pilotando il callback reale, come il helper preesistente. Controprova
  mirata: 1/1. L'altro fallimento, Ricerca nascosta nella fixture account
  dopo logout e risposte Auth simulate, passa isolato insieme al primo:
  2/2. Causa non dimostrata: nessun fix dell'app giustificato da questa prova.
  Giro completo finale seriale, senza altri browser di collaudo: 1.469 test,
  1.460 pass, zero failure/cancelled, nove skip opt-in, 302,3 secondi.
  Il PASS non dimostra la causa del fallimento UI parallelo e non sostituisce
  i gate immagine/provider/M2. La concorrenza del runner non modifica la
  capacità o le deadline dell'applicazione.

## Gate M2 e aggiornamento remoto

L'ispezione SSH ha confermato arm64 e Node 25.8.1 su Homebrew. Il launcher
staging richiede Node 24. Preparato sull'iMac l'archivio ufficiale arm64
24.21.0, 52.909.993 byte, con SHA-256 verificato rispetto a SHASUMS256.txt:
`bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`.
Non installato sull'M2: il runtime resterà separato da quello di produzione.
L'impronta di `fonti-salute.js` M2 è rimasta uguale tra le due
letture; nessuna scrittura, installazione, avvio o arresto remoto in questa fase.

Prima di avviare il nuovo worker:

1. Artefatto candidato collaudato, configurazione fresca, gate di backup e
   aggiornamento/rollback staging; nessuna migrazione SQL necessaria per il flag.
2. Credenziale M2 distinta, mantenendo quella iMac; le credenziali non entrano
   in Git, documenti, argv o output. Il centro legge la lista all'avvio.
3. Aggiornamento Run con manutenzione esplicita: sessioni e coda RAM vengono
   perse, nuovo login necessario. Arresto effettivo e volume da verificare,
   non dedotti dal semplice numero di repliche richiesto.
4. Directory e dipendenze proprie su M2, manifest uguale al centro, avvio
   manuale arrestabile e `--solo-stato`; produzione estranea al pacchetto.
5. Registrazione, heartbeat, compatibilità, etichetta Admin e mancata
   assegnazione verificati. Poi arresto/disconnessione e riconnessione.

Il terzo punto del lavoro, live sullo stesso IP della produzione, resta
subordinato alla coordinazione di pause e limiti. Condividere SQLite non basta:
la controprova a due processi già attivi non vede il 429 dell'altro. La scelta
dell'intervento sulla produzione va discussa prima di abilitarne il traffico.

## Backup prima della manutenzione

La documentazione Nhost conferma backup PostgreSQL giornalieri Pro/Team con
sette giorni di retention, ma esclude i dati dei servizi Run. Non dedurre
un backup del volume SQLite dalla presenza del piano Pro. Il repository
remoto del worker backup AMR non è configurato nel centro Run attuale:
`centro-run.js` mantiene intenzionalmente l'avviso e non certifica una copia
esterna. Backup, restore e autorizzazione alla manutenzione restano prerequisiti
distinti dall'immagine locale collaudata. Nessun nuovo servizio, costo,
snapshot, download di dati o modifica dei segreti attivato in questa verifica.

## Fonti autorevoli

- [Microsoft health monitoring](https://learn.microsoft.com/en-us/azure/architecture/patterns/health-endpoint-monitoring):
  distinguere processo raggiungibile, dipendenze verificate e ammissione al
  traffico; evitare probe che attivano workflow o gravano sulle dipendenze.
- [Nhost CLI deployments](https://docs.nhost.io/products/run/cli-deployments):
  build/upload e applicazione della configurazione sono passaggi distinti.
- [Node test runner](https://nodejs.org/docs/latest-v24.x/api/test.html):
  concorrenza dei file di test configurabile; non è un limite del servizio AMR.
- [Nhost backup](https://docs.nhost.io/products/database/backups):
  dati Run esclusi dai backup gestiti; restore da provare su ambiente distinto.

## Gate dell'immagine candidata — 6 ottobre

Preparazione committata in `1a497bf7976113363ba7e87c6fdda8e53fc1cfcc`.
L'immagine locale `amr-centro:staging-1a497bf` proviene esclusivamente dal
contesto Git di quel commit: Linux amd64, utente `node`, codice
`219bdde80515c8698180ae907b1eef131914ad7c8b37dddb2f7d0f13e512b70d`,
cataloghi invariati
`0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.
L'ID restituito da Docker è
`sha256:78e67bee9e016e62609f49ad62af289da6f5a4e9d78aecb7d540b99832f732ac`:
non è ancora un digest letto dal registry Nhost e non attesta un upload.

Il primo gate completo si è fermato prima della prova dell'immagine:
`aziende_attiva`, SQLSTATE `23514`, 13 ms, riga 33 del corpo PL/pgSQL,
durante il ciclo delle aziende extra della fixture colleghi. Il codice
localizza una violazione CHECK nell'UPDATE; non è un timeout. La review
indipendente sostiene l'ipotesi del confronto fra accettazione e attivazione
su due campionamenti di `clock_timestamp()`, senza dimostrare che l'orologio
sia arretrato nell'evento osservato. Nome del vincolo e valori esatti del
tentativo non sono stati acquisiti in quel primo giro. NTP, bug PostgreSQL,
contesa e immagine non sono cause dimostrate. Nessun vincolo, timeout,
attesa, retry o funzione SQL modificato per superare il gate.

La controprova con osservazione temporanea dei soli nomi di vincolo ammessi
non riproduce `23514` e completa **il gate integrato con exit 0 e cleanup
verificato**: PostgreSQL 18.6, Auth locale 0.49.1, quote e isolamento,
email/MFA, permessi, inviti, rinnovi e revoche; centro HTTPS della stessa
immagine; SIGTERM e riavvio sullo stesso volume con sospensione e revoca
conservate, vecchie sessioni respinte. Ricerca sintetica: avvio 73 ms,
15 consultazioni, massimo 105 ms, lavoro 16.054 ms oltre il timeout del
proxy fixture di 15 secondi, un solo lavoro. Restic reale: due repository
locali separati, dump, restore in secondo cluster, journal e replay
idempotente. Nessun portale o dato di account reale usato dalla fixture.
Il PASS non chiude la diagnosi del precedente CHECK e Auth cloud 0.52.0
non è certificato dalla fixture 0.49.1.

Log locali con soli metadati diagnostici e risultati sintetici:

- `/private/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-gate-immagine-1a497bf-GEBSp0/gate.log`;
- `/private/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-gate-immagine-1a497bf-3puIgM/gate.log`.

Preparato anche l'archivio del nodo dal medesimo contesto: 4.102.750 byte,
1.410 membri, SHA-256
`f39e6edcd3f0b0c838b2907ca36a40322d9e71e0eaf4be1bcd5d1e24095535ae`.
Assenti symlink/hardlink, percorsi assoluti o parent, `.env`, auth locale e
database. È ancora sull'iMac, non copiato sull'M2. Il worker iMac esistente
e il centro cloud restano sulla release precedente `66e2b24`.

La lettura dei metadati Nhost ha trovato tre backup PostgreSQL completati
dal 3 al 5 ottobre; non sono stati scaricati o ripristinati e non si deduce
che coprano l'ultima attivazione dell'utente. I dati Run restano esclusi.
L'utente ha scelto una copia cifrata temporanea sul solo iMac, con restore
isolato, autorizzando la breve manutenzione del solo staging e l'uso interno
delle credenziali necessarie senza esposizione. Il passaggio allo storage
gestito è previsto dopo l'ingresso in produzione; non è un requisito già
implementato né un servizio da attivare ora. La decisione è stata salvata
anche nella memoria della chat su richiesta esplicita. Nessuna manutenzione,
nuova credenziale M2, upload, aggiornamento cloud, download di backup reale
o scrittura sull'M2 effettuati a questo punto: preparazione e prova di
restore precedono le operazioni remote.

### Procedura temporanea di copia — gate locale

La copia usa un container di manutenzione separato, UID 1000, client
PostgreSQL 18.6 e Node 24. Una credenziale temporanea viene generata in RAM;
Run riceve soltanto la sua SHA-256 e una scadenza assoluta, massimo 20 minuti.
Si riusano origine HTTPS e IP espliciti del proxy; niente rotta AMR, percorsi
o SQL arbitrari. La richiesta acquisisce una sola copia: un retry del download
non ripete i dump. I buffer sono limitati a 64 MiB e cancellati all'arresto.
I temporanei del container stanno in `/dev/shm`; nessuna copia in chiaro
viene scritta sul volume Run.

Il profilo privato Nhost `nhost_admin`, con possibilità di `SET ROLE postgres`,
è stato verificato leggendo soltanto metadati e regole HBA. La copia non
aggiunge password, ruoli o privilegi ai login runtime AMR. Una richiesta di
password imprevista interrompe il collegamento: niente fallback a `.pgpass`
o credenziali ambientali. La corrispondenza DNS richiesta dall'HBA resta
da provare sul container reale; in caso negativo la manutenzione si ferma.

Conteggi e dump PostgreSQL importano lo stesso snapshot `REPEATABLE READ`;
ruoli globali senza password e SQLite sono acquisiti durante l'arresto AMR.
Auth può continuare a scrivere, ma non va eseguita contemporaneamente una
modifica di schema o ruoli. Lo snapshot PostgreSQL non è una fotografia
atomica globale di PostgreSQL e SQLite.

La review e le controprove hanno corretto: backup SQLite non cancellabile,
abort segnalato prima dell'uscita del child, conteggi non legati allo snapshot,
fallback di password impliciti e cleanup interrotto al primo errore.
Regressioni **9/9 pass**; verifica precedente con restic **60 pass, 3 opt-in
skip**. Gate Docker reale con dati sintetici: PostgreSQL 18.6, archivio
10.240 byte, SQLite 20.480 byte, repository cifrati separati, `restic check`,
restore e SHA uguali, conteggi e permessi conservati, rete del restore `none`,
cleanup verificato. Il PASS non certifica ancora il backup cloud.

Il primo restore globals con bootstrap differente falliva con SQLSTATE
`42501` su `GRANT`. Il restore conserva ora l'identità bootstrap e omette
solo il suo unico `CREATE ROLE` già eseguito da initdb: attributi e grants
restano invariati; il formato inatteso viene rifiutato. Controprove nel test
dedicato. Riferimenti: [GRANT PostgreSQL 18](https://www.postgresql.org/docs/18/sql-grant.html)
e [note di pg_dumpall](https://www.postgresql.org/docs/18/app-pg-dumpall.html).

Lo stato effettivo di Run è consultabile mediante `getProjectStatus`, con
stato e repliche. La manutenzione deve verificare l'arresto effettivo, non
soltanto `resources.replicas=0`, prima di cambiare immagine sul medesimo volume.

### Tentativo remoto e recovery da autorizzare — 6 ottobre

L'immagine temporanea di manutenzione è stata caricata nel solo registry
staging: digest
`sha256:62edc54fe9ce30de09b2236ed6372a37da8a2dc9f4d329df22b1cb43f3f002a1`,
manifest OCI remoto verificato, config
`sha256:87da91ab044722d3a9cdacabfe81bd1273b5ffea43bf49f3dba4fcc6ea0efe5e`.
Sorgente exporter SHA-256
`75796b5ba3d98cfb2178c96cef80a5c8b6afb6a65e67ab79fb75a4b0589f9ea3`.
L'upload non costituisce un backup.

Il preflight remoto passa e la configurazione precedente viene preservata.
Nhost, durante lo stop, omette il servizio da `getProjectStatus` e rimuove
la risoluzione del suo hostname. Il controllo iniziale che pretendeva una
voce esplicita e un HTTP 503 era quindi errato. La correzione considera
l'assenza soltanto insieme alla configurazione a zero repliche e a due
campioni di indisponibilità; `EAI_NONAME` è distinto da timeout o generici
errori di rete, con risoluzione del dominio di controllo `app.nhost.io`.
Connessioni PostgreSQL dei tre login AMR a zero verificate prima di tentare
la copia. Il solo DNS non attesta l'arresto.

Il container di manutenzione non diventa pronto entro il budget di avvio:
provider `Updating`, replica non pronta, nessun messaggio fisso di boot
trovato nei log interrogati. Non è dimostrata la causa: non attribuirla
al codice, all'immagine o all'HBA senza ulteriori prove. Nessuna richiesta
di dump completata, nessun backup cloud acquisito e nessuna copia reale
conservata sull'iMac. Il profilo PG privato non è ancora collaudato da Run.

La recovery automatica riceve `cloud_rifiutato`; un comando minimale
`updateRunServiceConfig` per zero repliche viene successivamente accettato.
Ultima verifica: immagine di manutenzione ancora configurata, zero repliche
richieste, volume originale conservato; la replica era ancora non pronta
in `Updating`. Non dichiarare lo staging disponibile né l'arresto fisico
deducendolo solo dalle repliche richieste.

Verifica successiva in sola lettura, 6 ottobre alle 00:39 UTC: immagine di
manutenzione ancora configurata, zero repliche richieste, volume identico
alla configurazione originale. Il provider non elenca più repliche del
servizio; `/healthz` è indisponibile con `EAI_NONAME`, mentre `app.nhost.io`
risolve correttamente. Nessun ripristino eseguito durante questa verifica.

Preparata recovery separata che attende l'arresto effettivo, ripristina la
configurazione originale `66e2b24` sullo stesso volume e verifica replica
pronta più HTTP 200. La richiesta di esecuzione viene rifiutata dal controllo
di approvazione (`rejected by user`): il processo di recovery non parte.
Richiesta nuova decisione all'utente; nessun tentativo equivalente attraverso
altri strumenti. Il gate M2 resta fermo e la produzione M2 non è stata toccata.

La review indipendente della procedura operativa ha inoltre verificato le
correzioni a timeout distruttivo del parent, cleanup dopo risposta Docker
perduta e controlli prima di ogni comando. Le sostituzioni Run rileggono la
configurazione e rifiutano drift sconosciuto; non sono CAS atomiche e richiedono
manutenzione esclusiva. Il restore locale non include le password dei ruoli
PG e non certifica il login Auth o un restore completo del progetto Nhost.

### Ripristino autorizzato e verificato — 6 ottobre

L'utente autorizza esplicitamente il ripristino dell'originale e il commit.
Arresto della manutenzione verificato con configurazione a zero repliche,
assenza di repliche e due controlli distinti dell'indisponibilità. Ripristinata
la configurazione originale `66e2b24`, inclusi digest dell'immagine, riferimenti
dei segreti, porta, healthcheck, compute e identico volume `amr-centro-dati`.
Nessun restore di database o aggiornamento dello schema eseguito.

La prima attesa di 300 secondi non conferma l'avvio: configurazione originale
esatta e una replica richiesta, ma Run ancora assente dall'elenco del provider.
Una richiesta minimale successiva `updateRunServiceConfig(resources.replicas=1)`
viene accettata; alle 00:50:17 UTC il provider registra una replica pronta,
stato `Running`. Non è dimostrato che sia stata la richiesta minimale a
sbloccare il servizio: un ritardo di provisioning resta una spiegazione
possibile. La CLI ufficiale usa anch'essa `ReplaceRunServiceConfig`; non è
emerso un passaggio di deploy aggiuntivo mancante nel helper.

Alle 00:51 UTC la configurazione coincide ancora integralmente con l'originale.
Il resolver di sistema dell'iMac restituisce `EAI_NONAME`, mentre Google e
Cloudflare DNS rispondono entrambi con stato NOERROR e indirizzi A del servizio.
Questo distingue un problema del percorso DNS locale dall'assenza del servizio;
non prova quale cache o resolver abbia conservato l'esito negativo.

Prova HTTPS mediante lookup limitato al solo hostname dello staging e agli
indirizzi restituiti dal DNS pubblico: certificato e hostname verificati,
nessuna modifica al DNS di sistema, nessun redirect seguito. `/healthz`:
HTTP 200, body esatto `ok`, `no-store`, 130 ms; ingresso frontend `/`: 200;
`/api/auth/backup/stato` anonima: 401. Nessun cookie, login o ricerca ai portali.
Login MFA, azienda e ricerca dopo questo riavvio restano da ricollaudare
manualmente; la precedente prova dell'utente non vale come nuova verifica.

I manifest delle immagini originale e di manutenzione sono presenti nel
registry. L'originale è un indice OCI multiarch; la manutenzione un manifest
OCI amd64. Questa differenza non dimostra un'incompatibilità di Nhost.
Il backup reale resta mancante e il gate M2 resta fermo. Produzione M2 e
file delle altre chat non modificati.

Riferimenti verificati: [Run resources](https://docs.nhost.io/products/run/resources),
[healthcheck](https://docs.nhost.io/products/run/health-checks),
[deploy CLI](https://docs.nhost.io/products/run/cli-deployments) e
[sorgente CLI](https://github.com/nhost/nhost/blob/main/cli/cmd/run/config_deploy.go).

### Correzione e collaudo dell'exporter — 6 ottobre

Verificato un difetto locale di avvio: l'exporter separava i proxy sulla
virgola senza rimuovere gli spazi, mentre il centro li normalizza. Con
`127.0.0.1, 192.0.2.1` l'immagine precedente termina; con la correzione
avvia il listener e `/healthz` risponde 200. La validazione continua a
rifiutare hostname, subnet, IP non validi e più di 32 indirizzi. Questo
non dimostra che il medesimo difetto abbia causato il precedente mancato
avvio remoto: il valore del segreto non è stato letto.

La review indipendente trova un errore aggiuntivo nel client del collaudo:
`fetch` di Node 24.21.0 elimina l'override di `Host`. Riprodotto con un
server loopback; sostituito con `node:http.get` nel solo collaudo, mantenendo
timeout, cap, controllo di lunghezza e SHA-256. Nessuna modifica alla policy
di trasporto dell'app.

Nuova immagine costruita da tre soli file, con basi già presenti e digest
fissati, senza installare dipendenze o includere il worktree nel contesto.
Test mirati: 10/10. Collaudo effettivo Docker + Restic, con origine HTTPS
di fixture e proxy separati da virgola/spazio: dump PostgreSQL 10.240 byte,
SQLite 20.480 byte, due repository cifrati, verifica e restore riusciti.
Restore PostgreSQL con rete `none`, owner, GRANT e conteggi controllati;
SQLite integro e conteggi coerenti. Cleanup delle sole risorse create
dal collaudo verificato. Nessun dato cloud o portale interrogato.

Queste sono prove locali, non un backup reale dello staging. Nhost conferma
che i backup gestiti PostgreSQL escludono i dati Run: la copia del volume
resta necessaria. Riferimenti: [backup Nhost](https://docs.nhost.io/products/database/backups),
[verifica repository Restic](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).
