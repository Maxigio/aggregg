# Staging: immagine e ricerca asincrona — 5 ottobre 2026

## Perimetro

Branch `feat/nodi-residenziali-prototipo`. Runtime della ricerca da `63c60e3`,
strumento di collaudo aggiornato in `bb7b7d1`. Build e prove locali: nessun
upload, configurazione cloud, migrazione remota, M2 o chiamata ai portali.
Credenziali e account della fixture sono sintetici e temporanei. Checkout,
file non tracciati e collaudi manuali preesistenti preservati.

## Effetto sul prodotto

Filtri, query dei portali, composizione e annunci non cambiano. Il browser
del prototipo avvia un'operazione con POST, poi consulta l'ID con GET brevi.
Le consultazioni non eseguono scraping. Una risposta iniziale perduta non
provoca un nuovo POST automatico. Rimane il budget del lavoro di 60 secondi.
Il polling può aggiungere circa un intervallo alla consegna: non accelera
lo scraping e aggiunge richieste brevi al centro. Risultati solo in RAM,
scadenza e restart sono descritti nel [registro del protocollo](ricerche-http-asincrone-2026-10-05.md).
Il frontend AMR principale deve ancora adottare questo contratto nella sua
integrazione: la produzione M2 non è cambiata.
Verifica attuale: `scripts/frontend-parts/search.js:268,431` usa ancora GET
`/api/search`; `backend/nodi/centro.js:948` serve la pagina del prototipo,
non il frontend completo dell'app. Questo è un gate APP concreto, non una
funzione completata implicitamente dal nuovo centro.

## Nhost verificato in sola lettura

Dashboard del progetto AMR, Frankfurt: servizio `amr-centro-staging` con
immagine vuota, zero repliche, 0,062 vCPU/128 MiB, nessuna variabile, porta,
volume o health check. Form chiuso con Cancel, senza Update. Non c'è un
prototipo pubblico da aprire; la precedente sonda non equivale al centro AMR.
La dicitura «No Deployments» nella overview non è la prova dello stato Run:
la verifica è stata fatta nel form del servizio.

Il dominio e Netlify disponibili non completano l'integrazione delle API.
La direzione concordata per il primo staging resta un servizio Run che serve
frontend del prototipo e backend, con Auth/PostgreSQL dello stesso progetto.
Una separazione del frontend AMR su Netlify richiede il proprio contratto
per origine, cookie, API e CSP; non è stata implementata in questo incremento.

## Gate ampliato e review

Riutilizzati launcher e helper esistenti, senza nuove dipendenze:

- Manifest dell'immagine confrontato con il commit atteso; build context
  materializzato dai blob Git, senza checkout vivo, `.env` o database reali.
- TLS verificato, login/MFA con Auth locale e permessi PostgreSQL 18.
- Admin gestionale senza ricerca; referente Moto con Auto negato.
- POST breve e replay della stessa chiave, worker simulato con un solo job.
- Lavoro ritardato per almeno 16 s, oltre il timeout di 15 s del proxy
  della fixture; heartbeat attivo e GET di stato brevi durante l'attesa.
- Esito completo, firma dettaglio, byte della consegna, replay dopo il
  completamento senza nuovi job. Admin riletto dopo replay e poll: totale 1,
  stesso ID e zero lavori attivi.
- Vecchio GET `/api/search` negato anche al referente autenticato: 405,
  `Allow: POST`, codice previsto e zero lavori prima del nuovo avvio.
- SIGTERM, restart sullo stesso volume, vecchie sessioni negate,
  sospensione/revoca persistite e cleanup delle sole risorse del gate.

Il primo tentativo del nuovo gate è fallito: la fixture inviava un heartbeat
libero senza ID durante il lavoro. Il runtime interpretava correttamente
questa incoerenza come riavvio del worker. Corretto il helper per inviare
`occupato` e `idLavoroAttivo`, come il worker reale; runtime invariato.

La review indipendente ha riprodotto due lacune del collaudo: il conteggio
prima dell'ultimo replay poteva perdere un nuovo record interrotto; il GET
legacy era provato soltanto anonimo. Aggiunti i controlli sopra. Controprove
in memoria della review finale rifiutano tre violazioni legacy e quattro di
unicità; nessun finding concreto residuo nel diff, cleanup preservato.

Test mirati finali: **29 pass, zero fail/cancelled/skip**, Node 24.21.0,
ambiente esplicito, dotenv disabilitato, dati e log temporanei. Nessuna nuova
suite completa: il runtime non è stato modificato in questo incremento.

## Evidenze del candidato

Prima prova positiva sull'immagine `63c60e3`: avvio 17 ms, 16 consultazioni
con massimo 26 ms, lavoro simulato 16.000 ms; un solo job. Exit 0 e cleanup
verificato. Queste sono misure locali, non SLA Nhost o prestazioni dei portali.
La build definitiva è materializzata dal commit
`bb7b7d12077482ce24edeb1033b76ef5dff0b385`:

- codice: `616cdf8457d1056190551fad8f0281d307a69c771b2e3a9e7dfdb926cd9b94f0`;
- cataloghi: `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`;
- tag locale: `amr-centro:staging-bb7b7d1`;
- ID Docker: `sha256:9ba82fd3e5ff784d12416548ff8283ca80dcea6592a720d7c773a1d044964949`;
- Linux amd64, utente `node`, 116.663.606 byte; non è il digest del registry.

Ricetta Node 24.21.0 Bookworm slim fissata per digest, `npm ci` dal lockfile
con dev dependency e script di installazione esclusi; cache Docker riusata.
Un indice multiarch per il futuro upload richiede il proprio controllo:
questa prova locale amd64 non certifica arm64 o l'architettura assegnata da Run.

Gate integrato sul candidato `bb7b7d1`: **exit 0 e cleanup verificato**,
PostgreSQL 18.6 e Auth Nhost 0.49.1 locali. Avvio 22 ms, 17 consultazioni
con massimo 21 ms, lavoro simulato 16.034 ms, un solo job. Superati anche
login/MFA, quote, ruoli, revoche, firma dei dettagli e restart sul volume.

Il primo giro su questo candidato si è però fermato prima di avviare
l'immagine, in `test/nodi-colleghi-pg.test.js:172` → creazione azienda →
accettazione referente, con `operazione_non_disponibile`. È lo stesso
fallimento intermittente del [gate precedente](staging-immagine-2026-10-04.md).
Il secondo giro è passato. La review indipendente ha però verificato un
limite dell'osservazione temporanea su `pg.Client.query`: i callback interni
del pool e gli errori di acquisizione potevano sfuggire all'osservatore.
Non si usa quindi l'assenza di codici di quel giro come prova diagnostica.

Corretta soltanto la diagnostica temporanea, al confine `pg.Pool.query`;
controprova sintetica per Promise/callback, stesso errore conservato e
sentinella sensibile esclusa dall'output. Terzo gate completo: **exit 0 e
cleanup verificato**, avvio 26 ms, 16 consultazioni massimo 27 ms, lavoro
16.001 ms, un solo job. L'osservatore intercetta il rifiuto atteso dell'invito
non valido (`P0001`, 5 ms), ma il guasto intermittente non si riproduce.
Raccoglie soltanto SQLSTATE, tempi e nomi/righe delle funzioni da allowlist
per `aziende_accetta`; nessun parametro, query, messaggio arbitrario o
credenziale. Non sono stati modificati test, quote, timeout, schema o adapter
per ottenere il PASS.

**Causa dell'intermittenza non dimostrata e problema diagnostico ancora aperto.**
Il giro riuscito prova il percorso completo in quell'esecuzione, non la
risoluzione del giro fallito o l'affidabilità in produzione. Il limite va
risolto o spiegato con evidenze prima del gate clienti; non si inventa un
fix SQL da un errore di dominio che nasconde intenzionalmente la causa.

Evidenze temporanee senza credenziali:

- `/private/tmp/amr-image-gate-unit-final-20261005.log` (29 test);
- `/private/tmp/amr-centro-build-bb7b7d1-20261005.log` (build);
- `/private/tmp/amr-image-gate-bb7b7d1-20261005.log` (fallimento prima dell'immagine);
- `/private/tmp/amr-image-gate-bb7b7d1-diag-20261005.log` (gate completo riuscito).
- `/private/tmp/amr-image-gate-bb7b7d1-pool-20261005.log` (controprova completa con diagnostica corretta).

## Passi ancora aperti

1. Pacchetto remoto da un candidato approvato: digest registry, schema/ruoli
   minimi, Auth e segreti per nome, volume UID 1000, origine/proxy, una replica.
2. Staging HTTPS completo con fonti simulate, arresto/rollback provato, poi
   collegamento del worker iMac nel perimetro concordato. M2 resta separato.
3. Integrazione APP: frontend Auto/Moto, rotte accessorie, export, dettaglio,
   preferenze e assistenza; SMTP e backup esterno/restore prima dei clienti.

I 16 s verificano l'attesa disaccoppiata dal proxy locale; non attestano il
timeout del provider, la deadline completa sotto carico, il trasferimento
di risultati reali o la stabilità dei peer Nhost. Le prove locali non sono
un'autorizzazione al deploy né una certificazione di produzione. La build
non include una nuova analisi CVE delle dipendenze o della base fissata.

## Fonti ufficiali ricontrollate

- [Microsoft asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply):
  202, consultazione stato, chiave idempotente e limiti del polling.
- [Docker build best practices](https://docs.docker.com/build/building/best-practices/):
  base fidata/fissata, contesto ristretto, utente non root e collaudo dell'immagine.
- [Nhost registry](https://docs.nhost.io/products/run/registry),
  [deploy CLI](https://docs.nhost.io/products/run/cli-deployments),
  [networking](https://docs.nhost.io/products/run/networking) e
  [health checks](https://docs.nhost.io/products/run/health-checks):
  upload distinto dall'avvio, configurazione Run, rete dello stack e liveness.
- [Netlify DNS esterno](https://docs.netlify.com/manage/domains/configure-domains/configure-external-dns/):
  dominio registrato altrove utilizzabile senza trasferire la registrazione.

Le fonti sostengono i criteri di lavoro; le misure derivano dai nostri gate,
non da garanzie di disponibilità o latenza dei provider.
