# Intermittenza PostgreSQL e preparazione staging — 5 ottobre 2026

## Perimetro

Richiesti diagnosi del fallimento intermittente, staging completo del prototipo
e commit. Solo progetto Nhost AMR a Frankfurt; M2, clienti, portali reali e
frontend principale AMR restano fuori da questo incremento.

## Diagnosi verificata

Baseline `3dfb509`. Un gate integrato fresco con PostgreSQL 18.6 e Auth 0.49.1
è passato. Una seconda istanza isolata ha eseguito dieci volte consecutive la
fixture colleghi, con worker backup attivo, poi completato il gate e il cleanup.
Ogni giro pulisce i propri dati commerciali; il journal backup cresce durante
le ripetizioni. Non è una prova di carico della produzione.

Non si è riprodotto il fallimento storico nell'accettazione del referente.
L'osservatore temporaneo di `pg.Pool.query` ha intercettato soltanto il rifiuto
`P0001 invito_non_valido` previsto dal test. Non sono stati aumentati timeout,
quote o retry per ottenere il PASS. **La causa storica resta non dimostrata.**

La review indipendente ha verificato controprove per quota, trigger backup,
CHECK temporali e transazioni della fixture. Nessun difetto deterministico
confermato in quei percorsi. Timeout/connessione, contesa e clock restano
ipotesi da distinguere tramite un errore effettivamente osservato.

## Correzione della capacità diagnostica

Il collaudo automatico ora osserva soltanto il proprio writer pool per
`aziende_invita`, `aziende_accetta` e `aziende_attiva`, prima della mappatura
dell'adapter al messaggio pubblico. Registra SQLSTATE, durata monotona,
classificazione dei timeout client, contatori del pool e contesto funzione
da allowlist. Non registra parametri, SQL, email, token, stack, `detail` o
messaggi arbitrari. Il collaudo manuale e il runtime Run non vengono modificati.

La review ha trovato e fatto riprodurre un errore nella prima versione del
diagnostico: `EPIPE` soddisfa la regex di cinque caratteri ma è un errore di
socket. Ora un SQLSTATE richiede anche `pg.DatabaseError`; la controprova
impedisce quella falsa classificazione. Promise/callback, errore originale,
reporter fallito e sentinelle sensibili sono verificati: **9/9 test mirati**.

Limite esplicito: saturazione dell'adapter e risposta SQL senza `risultato`
non rigettano `pool.query`; questo osservatore non li identifica. Nella fixture
storica il percorso documentato passa dall'accettazione, ma non si inferisce
la causa da un codice di dominio generico. Questa modifica non è presentata
come risoluzione del guasto intermittente.

Evidenze locali senza credenziali:

- `/private/tmp/amr-pg-diagnosi-giro1-20261005.log`;
- `/private/tmp/amr-pg-diagnosi-ripetizioni-20261005.log`.

## Verifica remota preliminare

Inventario SQL in sola lettura nel progetto AMR: PostgreSQL **18.6**, database
`muwqbjnpgdfnghdqxvmk`, installatore `nhost_hasura`, possibilità di assumere
`postgres`, `auth.refresh_tokens` presente, nessuno schema o ruolo `amr_`.
Servizio `amr-centro-staging` ancora fermo, senza immagine/configurazione
applicativa al momento dell'inventario. Nessun dato di account letto.

All'inventario preliminare il proprietario aveva scelto la propria email per il primo Admin cloud. Password
e enrollment MFA saranno configurati direttamente da lui, senza copiarli
dal collaudo locale. Gli altri prerequisiti sono digest remoto, schema atomico,
tre login PostgreSQL limitati, segreti Run, volume UID 1000, proxy espliciti,
Auth/MFA e worker simulato. `/healthz` non sostituisce queste prove.

## Riferimenti autorevoli

- [PostgreSQL: SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html):
  distinguere i codici dai messaggi localizzati; un errore client non diventa
  un errore PostgreSQL solo per il formato della stringa.
- [node-postgres: pool](https://node-postgres.com/features/pooling): rilascio
  dei client e distinzione tra acquisizione del pool ed esecuzione della query.
- [Nhost Run: deploy CLI](https://docs.nhost.io/products/run/cli-deployments),
  [rete](https://docs.nhost.io/products/run/networking) e
  [MFA](https://docs.nhost.io/products/auth/mfa): artefatto, configurazione,
  collegamento privato e enrollment sono verifiche distinte.

Lo staging non certifica la produzione; causa dell'intermittenza e backup
esterno/restore rimangono gate prima dei clienti.

## Aggiornamento: artefatto e installazione cloud

Candidato `66e2b24ee6499c282fc7565ea2eb29175978eeee`, immagine AMD64/ARM64
nel registry privato Nhost, digest remoto verificato:
`sha256:c936de03451ae2e7fc562f64010552f54ef26b4a97cefdabe4922a5abdc597fe`.
Il contesto deriva dai blob del commit e dai cataloghi pubblici, senza
credenziali o dati commerciali. Manifest: codice
`e105da91e8d7a4b0d0331585905f0916100806f80cd7a8288eee34a486336041`,
cataloghi `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.

Applicate otto migrazioni in una transazione sul solo progetto AMR:
schema accessi e backup, tre login PostgreSQL ristretti. L'installatore usa
internamente l'admin secret tramite CLI ufficiale e soltanto in memoria,
secondo l'autorizzazione esplicita; l'admin secret Hasura non entra nei file,
argomenti o output. Il token del solo worker simulato è in un file temporaneo
0600 dedicato. Nove segreti Run aggiunti, senza leggerne o mostrarne i valori. Non sono stati
copiati account o cookie del collaudo locale.

Un nuovo fallimento controllato, diverso da quello storico, ha prodotto
SQLSTATE `55P03` dopo circa 1,56 s nell'invito: timeout nell'acquisizione del
lock sulla riga di quota, durante build ARM e gate eseguiti contemporaneamente. La fixture
tratteneva un writer fino all'osservazione tramite Docker. Il successivo gate
isolato sulla stessa immagine è passato. **Non è dimostrato che la contesa
spieghi l'intermittenza storica**; timeout e retry non sono stati aumentati.

Gate locale dell'immagine: Auth/MFA e permessi, quota, richiesta ritardata di
15 s attraverso proxy HTTPS mediante POST breve e consultazione esito, un solo
lavoro, arresto SIGTERM e riavvio con stato persistente/sessione respinta.
Dodici test mirati centro/trasporto passati; gli errori EPERM di bind nel
sandbox sono scomparsi rieseguendo gli stessi test con permessi di rete.

## Aggiornamento: Auth e primo Admin

Auth cloud effettivo **0.52.0**, mentre il collaudo locale usa **0.49.1**:
il PASS locale non dimostra equivalenza completa fra versioni.
Nel progetto cloud sono confermati verifica email obbligatoria, password
minima di 15 caratteri e TOTP abilitato. SMTP e configurazioni non interessate
sono stati preservati.

Il proprietario ha completato direttamente signup, verifica email, enrollment
TOTP e una seconda autenticazione MFA. La preparazione avviene su localhost;
password e codici vanno direttamente al servizio Auth e non al server locale.
Token e QR sono temporanei in RAM e rimossi a fine procedura. La review ha
chiuso due difetti della pagina temporanea: messaggi grezzi del provider e
pulizia dei token ritardata da un signout fallito.

L'assegnazione SQL dell'unico Admin è confermata: identità autorizzata,
email verificata, TOTP presente e Admin attivo. Non sono stati letti hash,
seed o refresh token. **Il login attraverso il backend AMR in Run resta
da collaudare**; la preparazione Auth riuscita non prova l'accesso via AMR.

## Aggiornamento: ingress e blocco del volume

Sonde senza Auth/DB/scraper sulla stessa immagine: peer osservati
`10.110.2.4` e `10.110.23.18`; `X-Forwarded-Proto` e `X-Forwarded-Host`
sovrascritti dal proxy anche se falsificati dal client. `Origin` è preservato;
`Forwarded` arbitrario è preservato ma non usato da AMR per autorizzare HTTPS.
I due IP sono in allowlist esatta, **non una garanzia di stabilità**: un peer
diverso viene rifiutato. Il campione non autorizza una rete privata intera.

Una sonda privata con il mount effettivo ha verificato configurazione,
manifest e `SELECT 1` nei tre pool. Come UID/GID 1000, la creazione di un
file di prova nel volume fallisce con **EACCES**. Questo conferma il diniego,
non l'ownership precisa del filesystem. Il percorso predisposto nel
Dockerfile viene coperto dal mount: il chown durante la build non basta.

La manutenzione separata, autorizzata dal proprietario, non ha prodotto un
esito nel primo tentativo senza porte. Il confronto successivo autorizzato,
con sola porta TCP interna dichiarata e nessun listener, ha confermato
1000:1000 e 0700. Stesso volume, nessuna modifica ricorsiva, app e segreti
assenti dalla manutenzione. Arresto e configurazione del centro ripristinati;
AMR resta UID 1000. Evidenze e limiti nel
[registro volume](staging-volume-2026-10-05.md); incremento `ea8a3c6`.

Primo avvio dopo la manutenzione: `/healthz` 200, ma app, asset e API 403,
anche con Origin corretto. Le richieste anonime non hanno interrogato portali.
Questo non dimostra un nuovo peer: Host, protocollo e peer sono controlli
distinti, e `/healthz` li precede intenzionalmente.

Le successive sonde del proxy non hanno prodotto osservazioni utilizzabili:
503 e nessun nuovo evento nei log filtrati entro le finestre di 180 e 360
secondi. La seconda procedura ha confermato il ripristino integrale del centro
e del disco. Il comando della sonda nell'esatta immagine locale, senza rete
esterna o mount, risponde correttamente; l'immagine risolta in Nhost coincide
con il digest candidato. Queste controprove non identificano la causa remota.
La review rileva un limite della sonda nel candidato `66e2b24`: non emette un
marker di boot e non registra `/healthz`, quindi i log assenti non provano che
il processo non parta. Il successivo incremento locale aggiunge al CLI un
evento `avvio` dopo il bind, con sola istanza sintetica e UID/null. La factory
e le risposte HTTP non cambiano; l'immagine cloud `66e2b24` non include questa
modifica. Per la diagnosi su quel candidato è stato usato un marker inline.

Un ENOTFOUND locale è stato distinto dal problema remoto: Google e Cloudflare
restituiscono lo stesso CNAME e due IP pubblici; una richiesta HTTPS a uno di
quegli IP, con hostname/SNI e verifica TLS originali, riceve ancora 503 nginx.
Il DNS locale può ostacolare singoli tentativi, ma non spiega tutte le risposte.
Nessuna fiducia indiscriminata ai proxy o disabilitazione TLS.

Un confronto con il digest indicato direttamente, dopo una pausa di 60 s,
mantiene disco, risorse, 22 environment e comando AMR invariati. Anche qui è
stato osservato 503. Il sorgente ufficiale della CLI 1.51.2 e dell'API vendorizzata
risolve i secret prima dei plugin e conserva i riferimenti: l'ipotesi che solo
la CLI supporti l'immagine tramite secret non è sostenuta. La configurazione
non equivale allo stato effettivo dei pod.

## Aggiornamento: boot e causa del 403

Il marker privato del 5 ottobre, ore 16:27:26 UTC, conferma il listener della
sonda come UID 1000 nello stesso candidato e sullo stesso volume. Cambiando
la sola pubblicazione mentre il servizio è attivo, entro la finestra di 150 s
non è stata ottenuta una risposta pubblica utile. Ripristino AMR fermo e disco
conservato confermati. Non è dimostrato un problema RWO o RollingUpdate:
l'implementazione del plugin che costruisce i pod non è esposta nel vendor
ufficiale CLI 1.51.2 analizzato dalla review.

Avviando la configurazione AMR pubblica rimasta ferma senza cambiarla di
nuovo, `/healthz` è tornato 200 con TLS verificato, ma `/` ancora 403.
Il campione supporta il percorso di manutenzione con arresto prima della
modifica; non dà una durata universale di provisioning o prova la fine dei pod.

La sonda pubblica configurata prima dell'avvio, dopo la pausa, ha finalmente
misurato sette richieste: proxy `10.110.6.3` e `10.110.4.24`, Host atteso e
`X-Forwarded-Proto: https` singolo, anche dopo header client falsificati.
Questi peer sono fuori dall'allowlist iniziale: il controllo di trasporto
spiega il 403. Sonda poi fermata, comando AMR ripristinato, volume conservato.
`AMR_CENTRO_PROXY_IP` aggiornato ai **soli due IP osservati**, senza reti/CIDR
o fiducia globale. La stabilità futura di questi IP resta da provare.

La misura ha usato il primo record A ottenuto via DNS pubblico per aggirare
il problema di risoluzione locale, mantenendo URL, Host, SNI e verifica TLS.
Non modifica DNS del sistema, browser o AMR; non dimostra equivalenza di ogni
percorso del bilanciatore. La review indipendente ha confermato queste proprietà.

## Stato finale: centro raggiungibile e worker simulato

Centro avviato: una replica AMR UID 1000, comando predefinito, stesso volume
`amr-centro-dati` da 1 GiB e digest candidato `66e2b24` indicato sopra.
L'immagine è ora configurata tramite il digest esplicito identico: il confronto
non ha dimostrato un difetto del riferimento al secret. Nessuna promozione
automatica degli incrementi locali successivi.

Frontend dello staging:
[AMR centro staging](https://fashsekadydbcdkedqqx-3000.svc.eu-central-1.nhost.run/).
Accesso con l'account Admin preparato dal proprietario e la **nuova voce MFA
dello staging**, senza riusare il precedente autenticatore locale. Questo
Admin resta gestionale, senza azienda o moduli di ricerca assegnati.

Gate HTTP anonimo: **13/13 controlli PASS**, oltre a `/healthz` 200. Verificati
frontend, asset e pagina login; Admin e `auth/me` 401; registrazione del nodo
401 senza token; POST breve di ricerca valido ma anonimo 401; bootstrap con
Origin estraneo 403 e con Origin corretto 200; Origin estraneo sul frontend
403; Host estraneo 404 dal proxy. GET `/api/search` restituisce intenzionalmente
405 e `Allow: POST`: il percorso HTTPS non ammette il vecchio GET lungo.
Confermati `no-store` sulle risposte dell'app e assenza di Set-Cookie nei
rifiuti; solo il bootstrap riuscito crea il cookie anonimo di contesto.
`X-Forwarded-Proto` e `X-Forwarded-Host` falsificati dal client vengono
sovrascritti dal proxy nel campione. `Forwarded` resta preservato e non viene
usato da AMR per autorizzare HTTPS.

La review indipendente ha verificato una lacuna del helper iniziale: status
corretto bastava per il PASS anche senza `no-store` o con un cookie inatteso.
Corretto il predicato e ripetuto il gate; controprove offline: 13 casi nominali
accettati, 42 regressioni respinte. Non è un difetto backend dimostrato.
Corrette anche le aspettative obsolete GET 401 e `brand` invece di `marca`,
verificando il codice; nessuna modifica all'autorizzazione per far passare il test.

Il gate usa risoluzione DNS pubblica diagnostica per il solo hostname staging,
con hostname/SNI e certificato verificati e redirect allo staging vietati;
la richiesta DNS Google è separata e usa il client HTTPS standard. Una controprova
separata con `fetch` Node e DNS nativo ha ricevuto `/healthz` 200. Non sono
stati modificati DNS di sistema, runtime AMR o browser.
Ulteriore campione sui due record A pubblici del bilanciatore: **6/6 PASS**,
`/healthz` e frontend 200, Admin anonimo 401 su entrambi. Questo non rende
immutabile l'insieme dei peer interni ai futuri deploy.

Worker `imac-staging-simulato` avviato dal contesto esatto del candidato
`66e2b24`, con manifest verificato e dati locali temporanei isolati. Confermati
registrazione, due heartbeat 200 e poll 204; rilascio e cataloghi coincidono
con il centro. L'osservatore temporaneo IPC registra solo percorso consentito
e status delle chiamate già eseguite, senza aggiungerne o alterare fetch/DNS/TLS.
Il processo è legato al launcher: arresto o caduta del launcher interrompono
il worker. **Simulato non significa ricerca live verificata**: questa modalità
restituisce porzioni vuote dichiarate simulate e non serve menu o dettagli.
Heartbeat/poll provano il canale, non il risultato di una ricerca commerciale.
La review indipendente ha corretto due difetti del launcher temporaneo:
callback per gli errori della telemetria IPC e verifica/lettura della
configurazione sullo stesso descriptor. Controprove locali: un errore IPC
simulato non cambia fetch/Response; una sostituzione del pathname non cambia
il contenuto letto dal descriptor. Le dipendenze condivise via `NODE_PATH`
restano fidate: uguaglianza del lockfile non attesta `node_modules` installato.
Worker corretto riavviato e registrazione/heartbeat/poll ripetuti con successo.
Confermato l'arresto del precedente worker e del suo launcher; rimane un solo
worker simulato locale. I PID sono diagnostica temporanea, non configurazione.

Marker di boot della sonda: 21 test pertinenti passati, un test opt-in sulle
attese lunghe saltato; CLI corrente verificato in Docker UID 1000 senza rete
esterna, `/healthz` corretto e SIGTERM con exit 0. Il primo tentativo tramite
bind mount temporaneo è fallito perché il file non era disponibile in Colima;
la controprova ha passato solo sorgente pubblico via stdin, senza mount.
Il marker corrente resta un incremento locale, non presente nel digest cloud.

Restano aperti: login AMR completo e navigazione manuale da parte del
proprietario; SMTP effettivo; backup esterno e restore; stabilità degli IP del
proxy fra futuri deploy; ricerca live e gate commerciale. La causa del vecchio
fallimento PG rimane non dimostrata. Nessun M2 o portale coinvolto.
