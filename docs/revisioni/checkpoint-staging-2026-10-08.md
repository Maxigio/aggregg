# Checkpoint dello staging — 8 ottobre 2026

Segue [l'aggiunta dei due IP autorizzati](staging-proxy-due-ip-2026-10-08.md).
Originale Run `66e2b24`; candidato locale verificato `b8e8050`.
Solo staging: PostgreSQL e volume Run, copia locale cifrata e restore isolato.
M2, portali, deploy del candidato e backup automatici R2 restano esclusi
da questo checkpoint.

**Esito aggiornato:** un'incompatibilità della sonda amd64 viene identificata
tramite gli errori della replica e corretta con un'immagine multiarch.
La sonda successiva misura nella stessa istanza peer fidato e non fidato,
con Host/protocollo corretti. Il middleware originale riproduce rispettivamente
200 e 403: la lista campionata non copre tutti i percorsi osservati.
L'originale è ripristinato; nessun nuovo IP o trust più ampio viene applicato.
Diagnosi verificata, correzione duratura dell'ingress ancora da definire.

## Primo tentativo e recovery

Il tentativo inizia alle 02:47:17 UTC. Dopo il preflight e l'arresto
dell'originale, viene applicata la configurazione di manutenzione con zero
repliche. Il controller si ferma prima del download. Il recovery automatico
non è confermato: nessun backup fresco acquisito, nessun PASS.

Una lettura distinta conferma immagine di manutenzione, zero repliche e
assenza di pod. Un recovery controllato ripristina l'esatta configurazione
originale prima a zero e poi a una replica, mantenendo i due IP aggiunti.
ACK e readback esatti; la nuova replica è Running/ready ma i primi HTTP
restituiscono 503. Il primo controllo non attende la propagazione HTTP e
produce correttamente una ricevuta negativa.

Il controllo successivo delle 02:56:32 UTC conferma configurazione originale
esatta, replica Running/ready e HTTP 200 su `/healthz` e `/`, 401 sull'API
protetta senza login. La configurazione di manutenzione non è più attiva.
Il frontend non è stato collaudato manualmente e questa verifica non
certifica login/MFA.

I circa 30 secondi della ricevuta fallita misurano il solo tentativo fino
all'uscita del controller: **non** attestano il ripristino né la durata
complessiva dell'indisponibilità. Fra inizio del tentativo e readback finale
passano circa nove minuti e quindici secondi, includendo anche il preflight.

## Finding e controverifiche

1. **Confermato:** l'helper emette `configurazione_concorrente`, ma il
   controller ammetteva soltanto `config_concorrente` nella whitelist.
   Il codice effettivo può quindi nascondere questa causa dietro
   `operazione_non_confermata`. La nuova copia riconosce entrambi i codici
   e i codici Cloud sicuri; non registra messaggi remoti arbitrari.
2. **Confermato:** il recovery diretto interrompe l'attesa al primo
   Running/ready anche con HTTP 503. Running e disponibilità HTTP sono
   prove distinte: si deve attendere entro deadline senza riavviare una
   replica già attiva.
3. **Confermato:** il precedente modello sostituiva `a.replace` e la
   lettura della configurazione. Non verificava l'helper reale o i default
   della rappresentazione JSON. Le nuove controprove usano l'helper reale
   con un Cloud sintetico.
4. **Confermato:** la finestra del checkpoint partiva dopo l'attesa
   dell'arresto e il controllo dei pool. Ora include il tempo precedente
   alla prima mutazione di arresto; controprova con 45 secondi simulati.

**Non dimostrata:** omissione o normalizzazione di `command` come causa
del primo fallimento remoto. Dopo il recovery, JSON grezzo e configurazione
tipizzata coincidono integralmente. Una omissione durante la manutenzione
resta un'ipotesi; nessuna evidenza di alias dannosi fra gli oggetti del piano.

La copia del controller confronta JSON grezzo e configurazione tipizzata.
Unica equivalenza ammessa: `command` omesso o null, con vista tipizzata
esplicitamente vuota. Tutti gli altri campi, anche annidati, devono
coincidere; campi sconosciuti o letture discordanti bloccano la scrittura.
Le controprove dimostrano questa tolleranza e il rifiuto degli altri casi,
non la causa del guasto remoto. Il confronto non è un CAS contro altri
writer della dashboard.

Otto scenari del controller simulati passati; sette varianti confrontate
fra vecchio e nuovo helper, quattordici esiti verificati. Nessuna rete,
Docker o acquisizione reale in queste prove. Preflight remoto successivo
senza mutazioni passato; otto container locali preesistenti ancora attivi,
nessuna fixture in corso.

Ricevute private: `amr-checkpoint-fresco-20261008-946o2zgc` per tentativo
e recovery, `amr-checkpoint-verificato-20261008-cf565ntz` per la copia del
controller e le controprove, sotto il temporaneo dell'utente macOS.
I controller temporanei non sono un nuovo strumento di deploy di produzione.

## Nuovo preflight: accesso intermittente, nessuna manutenzione

Il retry delle 03:04:01 UTC si ferma con `http_originale_non_pronto`
durante il preflight, prima di SQL, stop, mutazioni, download o avvio di
fixture. Il riferimento Run e la replica restano quelli originali.

Tre controlli successivi, separati da cinque secondi, confermano:

| Percorso | Primo controllo | Secondo | Terzo |
| --- | --- | --- | --- |
| `/healthz` | 200 | 200 | 200 |
| `/` | 403 | 200 | 200 |
| `/api/auth/backup/stato`, senza login | 403 | 403 | 401 |

Configurazione originale esatta e stessa replica Running/ready. Nessuna
credenziale acquisita; letto soltanto `ok` da `/healthz`, non i body del
frontend o dell'API in questi tre controlli. La liveness non prova l'accesso
attraverso i controlli del trasporto. Questi dati provano l'intermittenza,
non quale IP o header abbia causato ciascun 403: la rotazione dell'ingress
resta una spiegazione sostenuta dalle sonde precedenti, da verificare.

Non ritentare il checkpoint affidandosi a un preflight fortunato né
allargare automaticamente la lista fidata. Il proprietario ha escluso
l'invio al supporto: la [bozza tecnica](nhost-ingress-richiesta-2026-10-08.md)
è soltanto contesto, non un gate che richiede una risposta esterna.
L'indagine prosegue sui nostri controlli e sulle prove di trasporto.
Le due aggiunte esplicitamente autorizzate restano presenti.

Ricevute del nuovo tentativo: `esito-execute.json` e
`http-preflight-successivo.json` nella directory del controller rivisto.
Prossimo gate dopo l'accesso stabile: checkpoint, acquisizione verificata,
recovery dell'originale, cifratura e restore isolato. Il candidato remoto
e il collegamento M2 seguono soltanto dopo questi esiti.

## Controprova sugli indirizzi pubblici

Alle 03:12:18 UTC, due GET anonimi di `/api/test/config` per ciascuno dei
due indirizzi pubblici ottenuti con risoluzione limitata al processo:
entrambi alternano 200 e 403. Host, SNI e verifica TLS restano invariati.
Il 200 ha HSTS; il 403 ha `no-store`, `nosniff` e `no-referrer`, body
`Forbidden` di nove byte e nessun HSTS. Non vengono conservati annunci,
cookie o body applicativi: soltanto classificazioni e hash delle risposte.

Il middleware AMR imposta i tre header prima del controllo del trasporto
e HSTS solo dopo. Questo sostiene l'origine applicativa del diniego;
il semplice indirizzo DNS pubblico non spiega l'intermittenza.
Non distingue ancora peer non fidato, Host o header ambigui.
Il trasporto del commit distribuito `66e2b24` coincide con quello letto
nel checkout: il candidato non è necessario per riprodurre quel controllo.

Una lettura dei log della precedente sonda, filtrata per istanza, ritrova
soltanto gli otto record già registrati, senza un nono dato mancante.
Nessun nuovo contatto esterno, modifica remota o accesso a segreti in
queste due verifiche. Ricevute: `amr-ingress-diagnosi-20261008-millrxe_`.

## Controller della nuova misura

Sonda temporanea con immagine già verificata, guard reale e solo il
riferimento non risolto alla lista proxy. Nessun Auth, DB, nodo o scraper.
La review indipendente rileva due errori verificati nel controller locale:
letture di configurazione fuori dal budget e successo possibile nonostante
un'interruzione. Corretti prima dell'esecuzione remota: un unico budget
copre lettura, GET e attesa; il successo esclude qualsiasi errore.
SIGINT/TERM segnala l'interruzione senza saltare il `finally` del recovery.
Nove modelli del controller e sei casi del programma Node passati;
non equivalgono a una prova del trasporto Nhost.

La prima esecuzione della nuova misura si ferma prima dell'avvio della
sonda: config originale a zero repliche e nessun pod confermati, ma
`wait_stopped` non ottiene il proprio segnale HTTP/DNS di indisponibilità.
`arresto_non_confermato`; nessuna delle sei misure eseguita.
L'originale viene ripristinato con configurazione e processo verificati,
entro 404.739 ms dalla prima mutazione. Non attestare un gate frontend.
Ricevuta: `amr-sonda-guard-20261008-c6upxoo3/esito-execute.json`.

Nel frattempo entrambi i resolver pubblici rispondono NXDOMAIN per lo
staging; il dominio della dashboard resta risolvibile. La causa del `None`
del vecchio `http_code` non è isolata: un modello controllato del suo
ramo URLError/NXDOMAIN funziona. Non attribuire un errore specifico senza
prova. Il controller della misura viene rafforzato: anche un `dns_assente`
del vecchio helper è rivalidato con quattro NXDOMAIN espliciti (A e AAAA,
due resolver), oltre a config zero, assenza pod e due controlli distanziati.
Timeout, ENODATA, esiti misti o JSON inattesi non attestano l'arresto.
Undici controprove Python e cinque casi Node passati, tutti simulati.

La seconda esecuzione non completa ancora `wait_stopped`, pur avendo
registrato almeno un DNS NXDOMAIN concordante. Il recovery non è confermato
nella ricevuta; non dedurre che l'originale sia rimasto fermo. Una successiva
lettura delle 03:52:52 UTC attesta configurazione originale esatta, una
replica Running/ready e `/healthz` 200. Non richiede nuove mutazioni.
Nessuna misura del guard raccolta; la sonda non è stata avviata in questi
due tentativi. Ricevute: `amr-sonda-guard-v2-20261008-95f_yb8d`.

Il tentativo successivo sostituisce temporaneamente il processo mantenendo
una replica desiderata, senza il passaggio a zero. Stessa immagine della
sonda e solo riferimento proxy; nessun accesso Auth/DB nel programma della
sonda. Risorse, porte e volume invariati. Un eventuale overlap temporaneo
fra pod dipende dal provider: il controller non ne prova l'assenza.
Il budget di venti minuti e la riserva recovery rimangono invariati.

Il primo tentativo di questa procedura termina senza misure complete;
tre tentativi HTTP di readiness, errore non classificato nella ricevuta.
Recovery della configurazione e del processo originale verificato, entro
58.573 ms dalla prima mutazione. La causa precisa resta non dimostrata.
La review del controller rileva un retry che non gestiva URLError nella
readiness: corretto e verificato con errore sintetico seguito da successo.
Ritenta le sole letture e non i lavori dei portali; massimo dodici GET
di sonda complessivi, di cui sei riusciti richiesti per la misura completa.
Ricevute: `amr-sonda-rolling-20261008-skwi_ypy`.

La review indipendente rileva e corregge anche il recovery che usciva al
primo Updating/unready o errore di rete, senza utilizzare l'attesa residua.
Configurazione concorrente e schema discordante restano rifiuti immediati.
Dieci modelli del controller, otto classificazioni della risposta originale,
otto casi del recovery e sei casi del programma Node verificati localmente;
Cloud/replace simulati, nessuna equivalenza con un PASS remoto.
Il timer Node chiude la sonda dopo quindici minuti; non arresta il servizio
Run e non impedisce un restart del provider. Il ripristino remoto dipende
dal controller, non dal timer né dal solo `durataMs` della libreria.

## Correzione della readiness e pacchetto diagnostico

Il quarto tentativo, alle 04:11:39 UTC, termina con
`avvio_non_confermato`: sette letture senza risposta positiva della sonda.
Recovery dell'originale verificato; finestra complessiva 80.032 ms.
Una successiva lettura dei log filtrata per `peerFidato` restituisce zero
record: non prova che il programma non sia mai partito.

**Errore verificato nella procedura:** `wait_live` poteva accettare stato
Running e `/healthz` della replica precedente, subito dopo la modifica
della configurazione. Seguivano soltanto sette tentativi a cinque secondi;
l'esecutor poteva ripristinare l'originale prima di dimostrare che la
sonda fosse pronta. Questo finding spiega perché quelle prove non sono
conclusive; non identifica ancora la causa dell'accesso 403.

Il nuovo controller attende una replica ready con data non vuota e diversa
da quella del preflight, poi richiede una risposta `proxy-v1`. La data è
un indizio di sostituzione, non un'identità crittografica del codice.
La risposta specifica della sonda è obbligatoria; `/healthz` non basta.
Attesa massima 420 secondi entro un budget esterno di 480; massimo sette
tentativi della sonda nell'avvio e cinque misure successive, dodici totali.
La finestra di venti minuti dalla prima mutazione e la riserva recovery
restano presenti. Nessuna riapplicazione automatica del rollout durante
l'attesa. Nel recovery una risposta dell'app originale è richiesta oltre
alla configurazione esatta; il 403 riconoscibile attesta l'originale,
non accesso stabile né autenticazione funzionante.

Per eliminare una variabile non ancora spiegata, la sonda usa un file
con `CMD` nell'immagine e nessun override `command` in Run. Non attribuire
il fallimento precedente a `node -e`: non è stata provata quella causa.
Il processo serve soltanto `/healthz` e `/sonda/normale`; le richieste dei
worker/browser agli altri percorsi ricevono 404 e non consumano il budget
della misura. Non registra header arbitrari, cookie, token o IP pubblici.
L'immagine deriva dall'artefatto immutabile già verificato, senza installare
dipendenze, e usa UID 1000. Nessun Auth, SQL, catalogo o scraper viene avviato.
Il volume originale non viene letto dalla sonda né modificato.

Due prove native isolate passate: peer fidato e non fidato; cinquanta
richieste estranee per caso, poi risposta della sonda e un solo record
di richiesta. Nessuna porta pubblica o rete esterna. Container preesistenti
e lista dei volumi invariati. Quindici modelli del controller passati,
compresi replica vecchia, data vuota, risposta estranea, rete interrotta,
artefatto incoerente, interruzione e recovery fallito. Cloud e sostituzioni
simulati; non equivalgono a una prova del 403 remoto.

La review indipendente, in sola lettura, ha rilevato due errori corretti
prima della nuova esecuzione: cap diventato 17 GET anziché 12 e data vuota
ammessa come replica diversa. I test sono stati eseguiti dal processo
principale; la review statica non ne certifica l'esecuzione.

L'upload riesce, ma il primo verificatore sbaglia distinguendo digest
dell'indice OCI e digest del config della piattaforma. Docker restituisce
per questa immagine un ID di indice. Verifica corretta mediante riferimento
immutabile uguale al `Descriptor` locale provato nativamente, un manifest
Linux amd64 e un manifest con piattaforma unknown, quindi manifest della
piattaforma. Nessun supporto ARM è dichiarato. Il servizio non viene
avviato dall'upload.

Artefatto diagnostico: indice
`sha256:fc4b533afe39718c4d4df645e01b30f00d26db1476790e9e85dccbbd9a07f297`;
sorgente `08bfb77ed7dcdca2ed6f279ce2e832cd9cac9001d0d174ab5f63b3868d84b00f`.
Ricevute private: `amr-sonda-file-20261008-bzjym104` e
`amr-sonda-file-execute-20261008-bqz4hlnv` sotto il temporaneo macOS.

La [guida Express](https://expressjs.com/en/guide/behind-proxies/) richiede
che la fiducia corrisponda al proxy reale. La
[documentazione Run](https://docs.nhost.io/products/run/networking)
conferma l'esposizione HTTPS e la rete condivisa col progetto, non una lista
di IP stabili nella pagina consultata. Ampliare la fiducia a tutte le reti
private non è una correzione verificata e non viene applicato.

## Errore di compatibilità dell'immagine diagnostica

La sonda su file, solo amd64, resta Updating/non ready e termina senza
misure, dopo 465.502 ms, con ripristino originale verificato.
L'indagine ometteva un dato disponibile nell'API: `replicas.errors`.
Il solo stato ready/date non basta a diagnosticare un container che non
parte; l'assenza di log del processo non ne dimostra la causa.

La successiva prova legge `errors.lastError` senza salvare messaggi grezzi:
solo reason in whitelist, exit code, classi note e hash del messaggio.
Alle 05:05:14 UTC è confermato `ImagePullBackOff`, exit code zero e
messaggio classificato `no match for platform`. Il riferimento distribuito
contiene solo Linux amd64. **Errore nostro verificato:** compatibilità del
container remoto non verificata, pur avendo un gate locale positivo.
Non è una prova sul CHECK, sul guard né sulla causa dei 403 dell'originale.
Il tentativo viene interrotto con SIGTERM del solo controller identificato
per directory, UID e argomenti; il `finally` conferma recovery dell'originale
entro 286.605 ms dalla prima mutazione. Nessun SIGKILL o stop di altri processi.

Il parser degli errori ha quattro controprove reali con risposta GraphQL
simulata: executable vuoto, formato exec, piattaforma mancante e redazione.
Il controller finale ha diciotto scenari simulati passati. Un errore storico
della replica precedente non interrompe la nuova; un `ImagePullBackOff`
con piattaforma mancante ferma l'attesa anche se l'exit code è zero.
Il messaggio remoto non entra in file o output. La review indipendente
è statica e distingue parser reale, modelli ed esecuzione remota.

Ricevuta: `amr-sonda-errori-execute-20261008-d8rbshj9/esito-execute.json`.
Il candidato applicativo `b8e8050`, anch'esso verificato soltanto amd64,
non può essere considerato compatibile con questo staging sulla base
del suo gate locale: va preparato e collaudato per le piattaforme richieste
prima di un upload/deploy applicativo. Non viene distribuito in questa prova.

La [procedura CI ufficiale Nhost](https://docs.nhost.io/products/run/cli-deployments)
mostra una build `linux/amd64,linux/arm64`. La nuova sonda segue questa
indicazione, con la stessa base immutabile e lo stesso sorgente, senza
`RUN` o nuove dipendenze. Gate nativo amd64 passato; per arm64 sono verificati
configurazione, CMD, utente dell'immagine e copia del sorgente, senza eseguirlo
localmente. Due container di prova rimossi dopo controllo di nome, label,
immagine e assenza mount; elenchi di container e volumi preesistenti invariati.
Questi confronti non attestano il contenuto né ogni stato interno dei volumi.

Indice multiarch immutabile:
`sha256:ff797fda4381b2f7c75591aa8fee8df36209d39b226ab02c406ac130d111d8b2`.
Il registry è verificato contro quell'indice e i due manifest delle
piattaforme. In questo Docker containerd, `image inspect --platform` espone
il digest del manifest selezionato; il config digest è un terzo identificatore.
Non sono intercambiabili. Corretti i verifier che confondevano questi valori.
Ricevute: `amr-sonda-multi-20261008-y80trs5p`, native gate r4 e upload;
executor congelato `amr-sonda-multi-execute-20261008-srf23qvz`.

## Misura riuscita e causa verificata del diniego

La sonda multiarch parte alle 05:24:34 UTC; pronta alle 05:25:09.
Un solo tentativo HTTP di readiness, poi cinque GET della stessa istanza.
Sei risposte 200 della sonda, sei record unici corrispondenti nei log.
Il recovery verifica configurazione e risposta dell'originale alle
05:26:01 UTC; finestra complessiva 86.120 ms. Nessuna credenziale risolta
dal controller, SQL, dato commerciale o annuncio letto in questa prova.

| Richieste | Peer | Fidato dal guard reale | Host | Protocollo |
| --- | --- | --- | --- | --- |
| 1–2 | `10.110.1.21` | no | atteso | https |
| 3–6 | `10.110.1.249` | sì | atteso | https |

Origin assente, nessun header multiplo rilevato. Stessa istanza e
configurazione della sonda: la diversità dei percorsi esiste anche senza
un riavvio dell'app durante il campione. Il 200 della sonda non equivale
a un 200 dell'app: la sonda osserva il trasporto senza applicare il guard.

Controprova senza rete col modulo originale `creaTrasporto`: replay dei sei
record, Host/protocollo attesi e socket HTTP come quello del container.
La lista minima del replay contiene il peer fidato osservato; non legge
il segreto proxy e non pretende di ricostruire tutti gli IP della lista
originale. Per entrambi i peer, `trustProxy` coincide con il dato misurato
dal guard reale in cloud. Il middleware produce 403 senza HSTS nei primi
due casi e 200 con HSTS negli altri quattro. Sei test esistenti del trasporto
passati con ambiente pulito, senza `.env`, dati o chiamate live.

**Finding confermato:** abbiamo trattato pochi IP osservati come se
identificassero tutti i percorsi legittimi dell'ingress. Il middleware nega
correttamente il peer non fidato; la configurazione è incompleta per il
campione reale. Questo fornisce una causa concreta compatibile col 403
applicativo osservato, non soltanto un'ipotesi sul DNS o sul provider.
Non dimostra che ogni 403 storico abbia la stessa causa, che gli IP misurati
restino stabili o che una lista ampliata una volta sia esaustiva.

L'aggiunta automatica di IP, `trust proxy=true` o fiducia generalizzata alle
reti private non sono una soluzione verificata e non vengono applicate.
La correzione duratura richiede una policy coerente con la topologia e
il confine di fiducia: scelta da discutere prima di modificare il trasporto.
Un'eventuale aggiunta del solo IP nuovo è un workaround di staging,
non chiude quel requisito di produzione. Il contatto al supporto resta escluso.

Readback finale delle 05:32:54 UTC: configurazione originale esatta,
una replica Running/ready, nessun errore di avvio segnalato, `/healthz` 200
e `/api/test/config` 403. Il recovery è confermato, l'accesso applicativo
resta problematico: la diagnosi non equivale a una correzione dell'app.
Ricevuta: `amr-sonda-multi-execute-20261008-srf23qvz/originale-finale.json`.

Il candidato applicativo e il checkpoint fresco restano da collaudare;
M2 non collegato e produzione non autorizzata. I problemi del controller
e della sonda sono distinti dal CHECK storico, tuttora non spiegato.
