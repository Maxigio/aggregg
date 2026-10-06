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

### Seconda acquisizione staging — preparazione verificata

Immagine di manutenzione del commit `3a513a2`, verificata nel registry:
`sha256:5e92df98e569ac6edd5a3b545443810e9c1b9495a8c7f891a2d6a7dc4eb93678`.
Exporter SHA-256:
`0e1cde40aa788ed43b51ee4e23b50282882fb51379dc4076a8bd7c1eab071ccb`.
Questo upload non è un backup e non aggiorna il candidato AMR originale.

Prima dell'esecuzione: configurazione completa uguale all'originale,
replica Run pronta, PostgreSQL 18.6 con `citext`, `pgcrypto`, `plpgsql`,
nessun tablespace aggiuntivo. Queste estensioni sono presenti nella
fixture di restore. Riferimenti ai segreti preservati, senza risolverne
i valori; nessuna migrazione, nuova porta o nuovo volume.

Il helper operativo usa due risposte DNS pubbliche concordanti per il
solo hostname dello staging, con indirizzi pubblici e TLS/hostname verificati.
Nessun redirect, proxy da ambiente o modifica al DNS di sistema per la
connessione di backup. Controprove locali: rifiuto di indirizzi privati
e risposte discordanti, NXDOMAIN ammesso solo se concordante, altri hostname
lasciati al resolver originale. HTTPS reale del healthcheck confermato.

Budget di avvio 480 secondi: il precedente ripristino era diventato pronto
oltre i primi 300 secondi. La scadenza assoluta dell'exporter, 15 minuti,
viene impostata dopo l'arresto del centro. Il budget non prova che l'avvio
riuscirà. Rilettura completa della configurazione prima di ogni sostituzione;
manutenzione esclusiva necessaria perché la API non offre un CAS utilizzato
dal helper. La review indipendente non rileva blocchi nel diff operativo.

Corretto inoltre il percorso di interruzione controllata: `SIGTERM` avvia
il cleanup, e un secondo `SIGTERM` non interrompe la recovery. Prova locale
del signal handler eseguita. La recovery verifica configurazione originale,
replica pronta, healthcheck, frontend 200 e rifiuto anonimo 401. SIGKILL,
perdita della macchina o del canale al provider possono comunque impedire
il ripristino automatico: in quel caso serve recovery separata verificata.

L'esito reale dell'acquisizione e del restore va registrato separatamente
quando completato; nessuna prova locale chiude questo gate.

### Diagnosi remota e correzione di compatibilità

Il tentativo con immagine solo amd64 non arriva al healthcheck. Un filtro
iniziale limitato ai messaggi dell'app non restituiva log; la ricerca mirata
degli errori infrastrutturali trova 11 righe `exec /usr/local/bin/node:
exec format error`, dal primo tentativo del 5 ottobre fino alle 01:13:36 UTC
del 6 ottobre. `getServiceLabelValues` conferma il nome corretto del servizio.
Nessun dato personale o log applicativo completo riportato. È un rifiuto
del binario prima dell'avvio JS, non una prova di errore del dump o dei proxy.

Il helper viene interrotto con SIGTERM sul suo solo PID verificato. La recovery
conclude senza acquisire copie. Verifica indipendente successiva: configurazione
integralmente originale, Run `Running`, replica pronta alle 01:16:59 UTC.
Frontend 200, healthcheck valido e API anonima 401. Volume e schema invariati.

Correzione: build esplicita `linux/amd64,linux/arm64`; lo stage delle dipendenze
usa ora il digest dell'immagine originale multiarch dal registry, invece di
un tag locale solo amd64. Le basi Node e PostgreSQL sono già indici ufficiali
multiarch fissati per digest. Nessuna installazione npm, nuovo builder o
modifica alla VM. Il boot stampa anche `process.arch`, senza dati sensibili,
per verificare quale variante venga eseguita realmente.

Il runner di collaudo accetta soltanto amd64/arm64 e rende esplicita la
piattaforma di tutti i propri container. Entrambi i gate completi passano:
dump PG 10.240 byte, SQLite 20.480 byte, cifratura Restic, hash, owner/ACL,
conteggi e restore isolato; cleanup verificato per entrambe le esecuzioni.
Test mirati 10/10. Review indipendente del runner: nessun finding confermato.
Il solo campo `platform` nell'esito non prova un'architettura: servono
manifest e funzionamento del runtime. La variante scelta da Nhost va ancora
osservata direttamente, senza dedurla dal solo messaggio `exec format error`.

La review del signal handler trova inoltre che il vecchio `http_code`
poteva assorbire l'interruzione durante una richiesta HTTP. Controprova
locale con errore simulato, poi propagazione esplicita nel helper aggiornato
e codice `manutenzione_interrotta` preservato nel report. Il tentativo
interrotto aveva già caricato il helper precedente: la sua recovery riuscita
non prova il nuovo ramo HTTP, che è verificato separatamente.

Riferimenti: [Docker multi-platform](https://docs.docker.com/build/building/multi-platform/)
e [Nhost CLI deploy](https://docs.nhost.io/products/run/cli-deployments),
che mostra la build per entrambe le architetture.


### Acquisizione multiarch e checkpoint locale — 6 ottobre

Il registry conferma il digest multiarch della manutenzione
`sha256:fd8a496609c3862f9121f8e1394317836b492f926d061b751c38c7157a805a80`.
Il log di boot remoto alle 01:41:22 UTC riporta `Architettura backup: arm64.`:
è una prova diretta della variante eseguita da Run.

La manutenzione scarica PostgreSQL (235.520 byte) e SQLite (36.864 byte),
con lunghezza e SHA-256 controllati. Il helper, però, aspettava il riavvio
del centro prima di avviare Restic. Un errore `cloud_rifiutato` durante la
lettura dello stato interrompe quel percorso: i body restavano soltanto in
RAM e nessuna copia cifrata era stata creata. Questa acquisizione NON è un
backup conservato, né una prova di restore. La causa dell'errore di controllo
Nhost non è dimostrata; una lettura successiva torna a funzionare.

La configurazione originale era già ripristinata integralmente con una
replica richiesta. Dopo questa verifica viene rinnovata soltanto la richiesta
di una replica, senza risostituire immagine, segreti, porte o volume.
Replica pronta alle 01:54:06 UTC; conferma indipendente: configurazione
originale esatta, healthcheck 200 con body `ok`, frontend 200, API protetta
anonima 401. Nessun coinvolgimento M2 o richiesta ai portali.

Correzione del percorso: `scripts/nhost/conserva-backup-staging.js` separa
`cifra` da `verifica`. Subito dopo il download crea due repository Restic
separati e cifrati, ricevuta e chiave locali private. La ricevuta dichiara
`cifrato:true, restore:false`; soltanto il restore isolato può confermare
`restore:true`. Un errore successivo non cancella copie o chiave.
Il restore usa una risorsa Docker nuova, PostgreSQL 18.6 fissato per digest,
rete `none`, nessuna porta, nessun database vivo sovrascritto; cleanup delle
sole risorse create. I dati in chiaro temporanei vengono rimossi.

Il helper operativo effettua al massimo tre tentativi per le sole letture
Nhost, non ripete mutazioni con esito incerto e non ferma nuovamente un
originale già configurato correttamente. Prove controllate: due letture
rifiutate e terza riuscita; recovery con originale già presente = nessuna
mutazione; checkpoint collocato prima di arresto/riavvio e restore.

Test mirati 13/13. Il runner Docker/Restic usa ora lo stesso conservatore:
cifratura, buffer azzerati, errore cloud simulato, riapertura dal disco e
restore isolato. La prova amd64 passa. Il collaudo arm64 e la review
indipendente sono ancora in corso; l'acquisizione reale va ripetuta solo
dopo questi controlli. Le copie locali temporanee non sono lo storage
gestito di produzione. La chiave resta separata dai repository, sullo stesso
iMac: questo protegge il transito e l'accesso locale, non la perdita del Mac.


### Review del conservatore e controprove

La review indipendente riproduce con VM due difetti: collisione del nome
Docker seguita da cleanup del container preesistente; errore ENOSPC nella
scrittura finale che nasconde la causa operativa. Correzioni: ownership
nonce distinta dal nome, lettura della sola label e dell'ID prima del
cleanup, cancellazione per ID verificato; causa operativa sanitizzata
preservata se la ricevuta non si può aggiornare. Il gate effettivo conferma
anche il cleanup del nuovo container. La collisione e ENOSPC sono prove
controllate, non incidenti osservati sullo staging.

Il rischio di mancata durabilità dopo perdita di alimentazione è condizionato:
non è stato simulato un guasto fisico del disco. Aggiunto `fsync` a chiave,
ricevuta e directory prima del successo; Restic verifica integralmente i
repository. Questo non garantisce la conservazione in caso di guasto del Mac.

La prova sul filesystem macOS conferma invece che `0700` può convivere con
ACL permissive. Il flag `@` di `ls` può nascondere il `+`: il controllo legge
anche le voci ACL. Un parent con ACL viene rifiutato senza modificarlo;
l'ACL viene rimossa esclusivamente dalle risorse nuove della procedura.
Test reale con ACL sintetica: nessuna copia creata, ACL parent preservata.

Test mirati aggiornati 14/14; fixture PostgreSQL/SQLite cifrate e ripristinate
su amd64 e arm64. Prova aggiuntiva con due processi Node distinti: il
processo di cifratura termina prima del restore; buffer originali azzerati,
repository riaperti da disco e dati ripristinati correttamente. Gate amd64
ripetuto dopo le ultime correzioni, con cleanup confermato. Preflight remoto
aggiornato: configurazione originale, HTTPS e accesso PostgreSQL compatibili;
nessuna mutazione effettuata dal preflight.


Review indipendente finale del commit `ca1ffaf`: nessun blocco confermato
nelle quattro correzioni. 17 scenari VM passano (durabilità simulata,
ACL, collisioni, ENOSPC e cause preservate). Sono prove controllate;
la prova ACL sul filesystem e il gate Docker/Restic sono distinti e reali
sull'iMac. Nessuna prova di perdita di alimentazione o guasto hardware.
La nuova acquisizione remota usa l'immagine multiarch già verificata;
nessun nuovo upload o aggiornamento del candidato AMR.


### Backup reale e restore isolato completati

Nuova acquisizione reale completata il 6 ottobre. Copie conservate in
`/Users/aincrad/AMR-backup-staging/copia-Bvprsj`, fuori dalla repository:

- PostgreSQL: archivio 235.520 byte, dump custom del database, ruoli senza
  password di connessione e manifest. Snapshot Restic
  `3d9e45d64f8384240a3018b06ab7acae261bd38b3c89728fff2febbd8059512b`.
- Run: SQLite coerente 36.864 byte. Snapshot Restic
  `724a7627ee6a9dbd0faf14faf615d1fa8fef9ce5507666fed20643ccccb3b97f`.

Due repository cifrati separati; chiave esterna ai repository, privata sullo
stesso iMac. Hash, lunghezze e `restic check --read-data` verificati.
La ricevuta `esito.json` viene conservata con le copie; l'ultimo controllo
indipendente conferma `cifrato:true`, `restore:true`, `cleanup:true`.
Directory 0700 e chiave 0600, controllo ACL applicato; nessun valore di
credenziale o riga personale esposto. L'exporter accetta soltanto il contenuto
Run atteso (SQLite e sidecar, oltre a lost+found), non ignora altri dati.

Il restore viene eseguito dopo la ripartenza del centro. Repository riaperti
in un nuovo processo sull'iMac, byte/hash confrontati con l'acquisizione;
PostgreSQL 18.6 in container nuovo senza rete o porte, bootstrap coerente,
ruoli/owner/ACL riprodotti da dump e globals senza opzioni che li eliminino.
Conteggi di utenti Auth e aziende uguali allo snapshot. SQLite: integrity_check
`ok` e conteggi di lavori, eventi, sospensioni e revoche coerenti. Nessun
ripristino sopra lo staging. Nessuna verifica funzionale Auth eseguita sul
clone: è un restore di dati, non un intero progetto Nhost funzionante.

Cleanup finale confermato: nessun container del collaudo/restore rimasto,
gli otto container preesistenti ancora presenti; copie cifrate preservate,
dati in chiaro temporanei rimossi. Chiavi/segreti del progetto Nhost non sono
inclusi nel dump dei ruoli e restano gestiti separatamente dal provider.

Dopo la manutenzione, il controllo Nhost mostrava originale integralmente
configurato con una replica richiesta, ma nessuna replica effettiva. È stata
rinnovata una sola richiesta `replicas:1`, senza modificare altri campi.
Successiva verifica indipendente: Run `Running`, replica pronta alle
02:18:16 UTC, configurazione intera esattamente originale (release `66e2b24`),
healthcheck 200 con `ok`, frontend 200, API protetta anonima 401. Questa
sequenza non prova che l'aggiornamento minimo abbia causato la ripartenza;
la latenza della riconciliazione Run resta un punto operativo da osservare
al prossimo aggiornamento, con timeout e recovery espliciti.

Il gate **copia reale + restore isolato** è chiuso. Restano fuori: storage
remoto gestito di produzione, perdita fisica dell'iMac, restore completo del
progetto Nhost, nuovo candidato AMR e collegamento M2. Per il prossimo gate
si può preparare l'aggiornamento staging e il worker M2 separato, inizialmente
solo stato/compatibilità; nessuna ricerca live M2 prima del coordinamento
delle pause sull'IP condiviso. Nessun aggiornamento della produzione M2,
nessun nuovo servizio, volume, deploy applicativo o chiamata ai portali in
questa acquisizione.

## Avanzamento verso il collegamento M2 — 6 ottobre

L'utente autorizza i passi fino al collegamento isolato dell'M2 e i commit
verificati. Il primo collegamento resta `--solo-stato`: nessuna ricerca,
catalogo remoto o modifica del servizio M2 di produzione. SSH in sola lettura
con host key verificata e agent forwarding disabilitato: arm64, processo
di produzione PID 849 in ascolto su 47321, impronta di `fonti-salute.js`
`b3d33bd2adafbabe5c2046d763e72c89632e86fb38adad8b0ea583b766f19648`.
Il PATH della sessione SSH non contiene Node: non modificare il PATH o
l'installazione della produzione per avviare il worker.

La review indipendente riproduce un difetto operativo preesistente: dopo
401/403 il worker ritenta indefinitamente heartbeat/poll. La revoca è efficace,
ma lascia traffico inutile. Correzione circoscritta: 401/403 terminano il ciclo;
il POST heartbeat annulla anche il controller del lavoro attivo. 503 resta
riprovabile e il precedente header di nodo obsoleto resta terminale.

Test di regressione sul sorgente precedente: tre tentativi invece di uno;
dopo il fix 25/25 test pertinenti passano, compresi entrambi i percorsi e
la controprova 503. Review in sola lettura: finding chiuso, 10 scenari VM
aggiuntivi confermano abort durante/dopo il lavoro e nessuna consegna tardiva.
Sono prove controllate, non revoche effettuate su nodi remoti reali.

Preflight cloud: configurazione integrale uguale all'originale, Run pronto
con replica avviata alle 02:18:16 UTC. Alcune prime letture Nhost restituiscono
`cloud_rifiutato`; le letture bounded successive riescono senza mutazioni.
Il runtime ARM64 già preparato è stato ricontrollato contro SHASUMS ufficiali
Node, prima di qualsiasi trasferimento M2. Il collaudo della nuova immagine,
l'aggiornamento staging e il collegamento remoto restano da eseguire.

Riferimenti: [deploy Nhost multiarch](https://docs.nhost.io/products/run/cli-deployments),
[healthcheck Nhost](https://docs.nhost.io/products/run/health-checks),
[OpenSSH](https://man.openbsd.org/ssh.1). Il healthcheck verifica il listener,
non sostituisce login, compatibilità e mancata assegnazione.

### Arresto del processo e artefatto candidato

Il giro seriale completo prima dell'ultima correzione termina con 1.484 test:
1.475 pass, zero failure/cancelled, nove skip opt-in. L'immagine `ddea8a9`
passa il collaudo locale PostgreSQL 18.6, Auth/MFA, permessi, ricerca simulata,
riavvio e restore Restic. L'upload successivo riesce per entrambe le
architetture; il primo fallimento di upload non ha una causa dimostrata.
Nessun aggiornamento remoto è stato eseguito con questa immagine.

La review indipendente trova un difetto ulteriore, confermato con processi
reali: dopo la fine del ciclo, l'IPC del launcher mantiene vivo il worker.
Quattro controprove falliscono sul codice precedente: heartbeat 401, 403,
409 con header obsoleto e SIGTERM; nessuna uscita entro quattro secondi.
Correzione: il main chiude l'IPC nel `finally` di `avvia()`, dopo aver terminato
il lavoro. La funzione esportata e la gestione di 503 restano invariate.
Le stesse quattro prove passano senza SIGKILL, insieme alle suite centro,
worker e launcher: 42/42. Review indipendente in sola lettura: nessun finding
bloccante residuo sul fix e sul test. Serve un nuovo artefatto dello stesso
commit per centro e worker; l'immagine precedente non verrà distribuita.

La procedura operativa temporanea è stata corretta dopo controprove su
interruzione, drift concorrente, piano alterato e ricevute senza identità.
Il piano intero viene ricostruito con il produttore dell'artefatto; il gate
richiede ID immutabili presenti e concordanti. Nel launcher diagnostico,
cleanup e segnali precedono lo spawn: un errore successivo di lettura o
scrittura chiude il solo figlio creato. Queste prove non attestano ancora
l'esecuzione su Nhost o M2.

### Candidato verificato e blocco dell'ingresso staging

Il candidato definitivo è `8c396f98f6d2ec5b0c8784fb03a2cf694555b3ce`.
Immagine caricata nel registry Nhost e manifest multiarch verificato:
`sha256:f5b5dba7b8ea5a04221e9a9d523c3302e886b3fd2cdb4ef23d52ec237c715f43`.
Entrambe le architetture eseguono Node 24.21.0 come UID 1000 e verificano
il manifest del candidato. L'immagine è caricata, **non distribuita**.

Collaudo locale sull'identità immutabile dell'immagine: PostgreSQL 18.6,
Auth/MFA, autorizzazioni, ricerca simulata, riavvio sul volume e
backup/restore isolato passano. Un job simulato di 16 secondi supera il timeout
di 15 secondi del proxy locale; le 16 consultazioni GET restano brevi,
massimo 64 ms. La risoluzione
del tag viene vincolata all'ID immutabile anche dentro il runner: controllare
il tag soltanto prima e dopo lascerebbe scoperto un cambio temporaneo.
Suite completa sul candidato: 1.489 test, 1.480 pass, nove skip, zero
failure/cancelled; esecuzione seriale con dati e log temporanei.
Sono prove locali; non sostituiscono il collaudo del deploy remoto.

Il preflight remoto blocca l'aggiornamento con
`originale_non_disponibile`. La configurazione intera è ancora identica
all'originale `66e2b24`; Run risulta pronto. Il 6 ottobre alle 04:15:36 UTC
inizia una nuova controprova anonima di quattro giri, senza cookie,
credenziali o richieste ai portali:

| Giro | `/healthz` | `/` | `/api/admin` |
| --- | --- | --- | --- |
| 1 | 200 | 403 | 403 |
| 2 | 200 | 200 | 403 |
| 3 | 200 | 403 | 401 |
| 4 | 200 | 403 | 401 |

I 403 hanno body standard `Forbidden` e gli header `no-store`, `nosniff`
e `no-referrer`, coerenti con il controllo di trasporto AMR. Il healthcheck
lo esclude intenzionalmente: 200 non prova che frontend, login o API siano
raggiungibili. Il difetto di disponibilità è **verificato**; la causa precisa
resta **non dimostrata**. Peer proxy fuori dall'allowlist o differenze negli
header sono ipotesi da misurare, non motivi per estendere la fiducia.
Il campione precedente di due IP espliciti non garantisce stabilità futura.

La [documentazione Express](https://expressjs.com/en/guide/behind-proxies/)
richiede che la fiducia corrisponda al proxy effettivo e segnala il rischio
di header falsificati. La [pagina networking Nhost](https://docs.nhost.io/products/run/networking)
descrive rete interna e pubblicazione HTTPS; nella pagina consultata non è
presente una garanzia di IP/CIDR stabili per il proxy. Non è stata applicata
alcuna fiducia globale, CIDR aggiuntiva o modifica degli header accettati.

Preparato un piano diagnostico distinto, ancora da autorizzare: sei
configurazioni esatte per arrestare l'originale, avviare la sonda sullo
stesso servizio e ripristinare l'originale. Usa l'immagine immutabile `8c`,
stesse risorse/porta/volume, environment vuoto nella sonda. Massimo 20 minuti
di sonda e 12 richieste brevi pianificate; nessuna chiamata Auth, PostgreSQL,
nodo o portale. Il volume è preservato e il codice della sonda non lo legge.
I log contengono soltanto IP privati del peer e classi degli header;
la risposta pubblica non espone quei dati. Non modifica l'allowlist.

Review indipendente del piano e controprove VM sulla privacy passano.
Prova sull'immagine reale, senza rete esterna, volumi o porte pubblicate:
risposta minima 200, UID 1000, SIGTERM/uscita 0 e cleanup confermati.
**Limite:** il piano JSON non esegue la manutenzione. Il futuro executor
deve applicare deadline, verifica dei pod arrestati, drift guard e ripristino
anche su errore. La scadenza interna della sonda lascia `/healthz` acceso:
non equivale all'arresto Run. La scelta è stata sottoposta all'utente prima
di qualsiasi nuova pubblicazione diagnostica.

### Preparazione del collegamento M2

La procedura temporanea di collegamento è pronta ma **non eseguita**.
Richiede prima la ricevuta del nuovo staging verificato, al momento assente.
Verifica i byte di ogni membro dell'archivio contro l'artefatto pubblico,
runtime ARM64 contro SHA ufficiale, origine e schema della credenziale,
quattro campi del manifest centro/worker e marker produzione prima/dopo.
Usa SSH con host key già verificata e senza agent forwarding; scrive soltanto
in una nuova directory isolata. Non modifica Node, launchd, app o dati della
produzione M2 e non installa dipendenze per il primo gate `--solo-stato`.

Review indipendente: chiusi i finding sulle guardie di preparazione,
ricevuta parziale e identità dei processi. Il collaudo vincola OBSERVE al PID
restituito da START; STOP verifica la coppia launcher/worker attesa, uscita 0,
assenza di segnale e scomparsa di entrambi; la riconnessione richiede nuovi
PID per entrambi. Il launcher invia soltanto SIGTERM al proprio figlio.
Le controprove sono locali con stub/VM, non un collegamento M2 riuscito.

**Prossimo gate:** diagnosticare e risolvere il 403 senza indebolire i
controlli, aggiornare/verificare lo staging, poi collegare e collaudare
l'M2 soltanto per stato/compatibilità, arresto e riconnessione. Nessun file
trasferito né worker avviato sull'M2 in questo incremento. Le prove live M2
restano successive al coordinamento delle pause e dei limiti sull'IP condiviso.
