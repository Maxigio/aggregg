# Runtime R2 del centro staging — 8 ottobre 2026

Segue [provisioning del ruolo e secrets](runtime-backup-preflight-2026-10-08.md).
Immagine `d632f50` invariata; commit host `18c3a2f`. Sono autorizzati
backup nel centro web e restore locale isolato. M2, portali e invio
notifiche restano esclusi da questo incremento.

## Piano verificato

Solo tre variabili aggiunte: `AMR_COPIE_SEGRETI`,
`AMR_COPIE_REPOSITORY` come riferimenti Run e `AMR_COPIE_PG_USER=amr_dump`.
Confronto integrale di image, comando, volume, risorse, porta, health check
e altre variabili; nuovo runtime validato dal medesimo validatore del
pacchetto di aggiornamento. La retention resta dry-run.

Il ruolo NOLOGIN viene abilitato dopo l'arresto del centro. OID,
attributi, membership e default sono verificati nella transazione che
modifica il ruolo. Lock sul catalogo e advisory lock serializzano queste
operazioni. Un marcatore non riservato di stato impedisce che un LOGIN
arrivato tardi possa seguire il suo annullamento. Nessuna password cambia.

## Review e controprove preparatorie

Finding confermati nell'executor temporaneo, corretti prima dell'avvio:

- Recovery applicava NOLOGIN prima di verificare il ruolo: ora guard
  transazionale prima della modifica, OID e attributi legati al piano.
  Un ruolo estraneo non viene modificato; il recupero della configurazione
  web originale non dipende dal poter modificare quel ruolo.
- ACK SQL perso non era dichiarato incerto: ora flag esplicito e nessun
  retry del LOGIN; annullamento con marcatore impedisce un LOGIN tardivo.
- L'arresto verificava soltanto i tre pool: aggiunto `amr_dump`, due
  osservazioni a zero prima del recovery.
- Un errore di salvataggio dopo il postflight saltava il recovery: successo
  deciso dopo la conferma durevole del journal.
- Segnali durante lettura o fsync finali potevano lasciare il runtime attivo
  pur dichiarando failure: controlli prima/dopo fsync e stabilizzazione
  nel finally. Un segnale successivo al completamento confermato viene
  registrato senza annullare retroattivamente l'operazione.

Review indipendente: 17 casi del validatore e 13 controprove finali sui
segnali PASS, esclusivamente in RAM. Prova nativa PG 18.6 senza rete o
porte: LOGIN/recovery passati, LOGIN tardivo negato, ruolo omonimo estraneo
negato e invariato. Container della prova chiuso; volumi preesistenti
invariati. Non costituiscono prove del comportamento cloud in caso di
ACK perso né di un backup dello staging.

Preflight remoto delle 15:03:31 UTC PASS; configurazione esatta, ruolo
NOLOGIN, riferimenti presenti e manifest autenticato corrispondente.
Otto job storici non completati, quattro database e quattro journal;
nessun tentativo o backoff azzerato.

## Esito runtime e restore

Attivazione completata alle 15:17:55 UTC: ruolo LOGIN con identità e
marcatore esatti; tre variabili R2 presenti; replica pronta. Configurazione
originale preservata per il recovery; nessun nuovo artefatto, porta, volume
o webhook. Manifest autenticato `d632f50`, ingress 16/16 PASS. Arresto
precedente confermato con due campioni, quattro pool a zero.

Alle 15:22:44 UTC: configurato=false, otto copie pending/fallite, nessuna
copia database o journal confermata. Alle 15:25:29 UTC entrambe le identità
R2 risultano leggibili dall'iMac; alle 15:26:53 UTC riferimenti risolti del
cloud, credenziali R2 e chiave restic coincidono con quelli locali. Queste
prove non attestano l'accesso R2 dal runtime cloud. Backoff e tentativi
storici preservati; causa ancora in diagnosi, gate backup non chiuso.

La review indipendente del solo strumento di restore ha verificato e fatto
correggere: chmod prima del rifiuto symlink, ACK Docker perso dichiarato
come cleanup certo, ricevuta positiva residua dopo fsync fallito e prefisso
SQL `pg_%` non letterale. Ulteriore review della ricevuta in sola lettura:
interruzione tra link e flag locale e collisione O_EXCL potevano lasciare
una ricevuta positiva non confermata o rimuovere una precedente; ora
rollback limitato all'inode creato dalla medesima invocazione. Controprove
in RAM passate, nessun finding residuo nel perimetro. Non è una prova di
restore reale: resta da eseguirla su copie confermate.

Directory privata di evidenze:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-runtime-backup-preflight-20261008-me172a0h/`.

Fonti: [secrets Nhost](https://docs.nhost.io/platform/cloud/secrets),
[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html),
[pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html),
[restore restic](https://restic.readthedocs.io/en/stable/050_restore.html).

## Finding runtime: trust store TLS assente

Riprodotto nell'immagine esatta `d632f50` su amd64 nativo: entrambe le
letture di identità R2 falliscono con classe TLS. La stessa prova restic
fuori dal container riesce. Ispezione offline dell'immagine: assenti sia
`/etc/ssl/certs/ca-certificates.crt` sia `/etc/ssl/cert.pem`.

Controprova delle 15:38:53 UTC: medesima immagine e codice, unica differenza
il bundle CA copiato dallo stage restic ufficiale già fissato per digest;
entrambe le identità R2 passano. TLS non disabilitato, nessun upload, dump o
accesso al database; file riservati effimeri chiusi e container rimosso.
Volumi invariati nella controprova. La prima prova ometteva la tmpfs sul
VOLUME ereditato `/var/lib/postgresql` e ha lasciato un volume Docker
anonimo; non è stato eliminato senza un'identità verificabile. Nessun
contenuto letto. Corretto il perimetro della controprova.

Fix della ricetta del centro: copia del bundle CA dal medesimo stage
restic e verifica del bundle non vuoto/PEM interpretabile durante la build.
Non aggiunge pacchetti o dipendenze host e mantiene le immagini base
fissate per digest. Causa locale verificata; la diagnosi remota è
sostenuta dall'immagine e dalla configurazione identiche, ma richiede il
postflight sul candidato corretto. Il backup cloud e il restore non sono
ancora confermati.

Fonti ulteriori: [TLS e CA di restic](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html),
[Dockerfile ufficiale restic 0.19.1](https://github.com/restic/restic/blob/v0.19.1/docker/Dockerfile),
[Dockerfile PostgreSQL](https://github.com/docker-library/postgres/blob/master/18/bookworm/Dockerfile).

### Verifica della correzione locale

Review indipendente in sola lettura: nessun nuovo finding confermato nella
ricetta. Controprova CA sopra eseguita dopo la review statica; entrambi i
repository raggiunti con le CA ufficiali. Build nativa dell'istruzione di
validazione X509 PASS, 21 test pertinenti backup/secrets/avvio PASS con
dati e log temporanei, nessuna credenziale reale nei test automatici.

Il controllo X509 non garantisce completezza o aggiornamento futuro delle
CA. Il builder legge solo un commit e include la ricetta nell'hash codice:
il candidato definitivo richiede un nuovo manifest, build immutabile e
worker compatibili. L'immagine della controprova è solo diagnostica,
non un candidato da distribuire. `d632f50` resta deployed; R2 ancora non
operativo dal centro remoto.

## Checkpoint prima del candidato con CA

Nuova copia iniziata alle 16:00:27 UTC, con la baseline `d632f50` e runtime
R2 attivo: 245.760 byte PostgreSQL e 90.112 byte di volume. Cifratura
restic, restore PostgreSQL isolato senza rete e cleanup confermati;
servizio originale ripristinato con configurazione esatta. Finestra di
manutenzione: 280.243 ms, entro i venti minuti. Copia privata conservata
in `/Users/aincrad/AMR-backup-staging/copia-sWRPIa`; precedenti preservate.
Ricevuta `checkpoint-ca/esito-execute.json` nella directory di evidenze.

La review ha rilevato due errori nel wrapper temporaneo, corretti prima
dell'esecuzione: controllo `amr_dump` una sola volta dopo il polling, che
poteva impedire anche il recovery; loader della nuova baseline non
collegato dopo il riuso del controller. Ora tutte e quattro le connessioni
sono considerate nello stesso polling, con due campioni a zero; loader
esplicito. Core preservato in una copia che differisce dall'originale
soltanto nelle due query dei pool. Controprove `1→0→0`, `0→1→0→0`, timeout,
conflitto di configurazione e recovery PASS; review finale senza finding
residui nel perimetro. Due arresti cloud confermati anche tramite endpoint.

Candidato immutabile `3870675`: build Linux amd64 e manifest non
privilegiato verificati; entrambe le identità R2 leggibili dalla stessa
immagine nel test nativo. Digest root riletto dal registry:
`sha256:f6377bd6be04b3237ca2d6177ccbded9b85cd8da6ea826c60c3052944e115b04`.
L'immagine ha amd64 e attestazione, non un secondo target arm64.

Il preflight del pacchetto ha impedito l'aggiornamento a causa del
confronto canonico: il pacchetto aggiunge contesto e impronte e l'opzione
`ingress=nhost` riordinava le variabili di un ingress già Nhost. Corretti
entrambi i confronti senza modificare il piano: estensioni validate
esplicitamente, ambiente preservato. Secondo preflight remoto delle
16:07:38 UTC PASS. Solo l'immagine differisce dalla baseline; rollback
identico all'originale e cinque impronte TOML verificate.

Cinque controprove locali del controller di aggiornamento PASS: successo,
ACK perso senza retry della mutazione, manifest errato, fsync finale
fallito e segnale prima della conferma; i fallimenti richiedono il recovery
esatto. Sono prove con mock, non fault injection sul cloud. Aggiornamento
remoto e restore delle copie R2 non ancora completati in questa sezione.

Ulteriore review del controller: due rischi condizionati di riuso, non
riprodotti sul pacchetto corrente, sono stati corretti. Le impronte ora
supportano anche il suffisso `.toml` del produttore standard, rifiutando
alias e collisioni. Il checkpoint appena verificato è vincolato a path,
SHA-256, inizio e release; qualsiasi altra ricevuta di esecuzione nella
stessa directory blocca il prerequisite, anche se indica failure.
Review indipendente finale: 35 mock RAM PASS, nessun finding residuo nel
perimetro. Terzo preflight remoto delle 16:15:46 UTC PASS.

### Primo aggiornamento remoto non riuscito

Il candidato amd64 `3870675` non ha confermato l'avvio nei 420 secondi del
controller. Run osservato in `Updating`, una replica non pronta e health
503; successivamente `Error`. Recovery concluso alle 16:29:10 UTC:
configurazione originale esatta, replica pronta e health applicativo
confermati. Nessuna modifica a schema, ruolo, secrets, token, M2 o portali.
Ricevuta `candidato-ca-execute.jsonl`; il candidato non è deployed.

Questo non smentisce la prova TLS nativa e non dimostra da solo una causa
nel codice applicativo. Metadati dei log del periodo: nessun errore di
avvio del candidato trovato; un messaggio del servizio originale avviato
alle 16:28:45 UTC. Nessun body di log mostrato o conservato. Introspezione
ufficiale API: gli errori di container sono disponibili in
`ReplicaStatus.errors.lastError`, ma il controller li ometteva prima del
rollback. Il servizio originale osservato successivamente è `Running`,
ready, senza errori di container.

Preparate acquisizione di sole classi/codici, ricevuta distinta, budget di
avvio ridotto e recovery identico. L'eventuale messaggio remoto resta solo
transitorio in RAM; anche il ritorno in caso ready viene proiettato su
stato e readiness, senza errori grezzi. Preflight diagnostico delle
16:38:44 UTC PASS; prova remota ancora da eseguire.

Riferimenti di comportamento Run:
[health check](https://docs.nhost.io/products/run/health-checks),
[build e deploy CLI](https://docs.nhost.io/products/run/cli-deployments).
L'esempio ufficiale costruisce amd64 e arm64; non attesta quale architettura
abbia la replica attuale. Non assumere amd64 dalla sola prova locale.
