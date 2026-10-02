# Immagine del centro — collaudo locale del 2 ottobre 2026

## Perimetro

Prossimo incremento del [gate HTTPS](centro-https-run.md): provare il centro
effettivamente installato in un container Linux. Nessuna attivazione cloud,
distribuzione dell'immagine, modifica dell'M2 o chiamata ai portali.
Il frontend servito rimane quello del prototipo; il frontend AMR completo
ha un [gate separato con APP](amr-centro-mappa-funzionalita.md).

## Decisione sulla sonda

Il proprietario ha scelto `/healthz` sulla stessa porta interna 3000.
Solo GET e HEAD della URL esatta rispondono prima dei controlli Host, HTTPS
e Origin. Il body è `ok`, senza dati, sessioni o chiamate a PostgreSQL,
Auth e portali. Dopo la chiusura del centro risponde 503. Query, varianti
del percorso e altri metodi passano dai controlli ordinari.
La deroga esiste soltanto nell'avvio con trasporto remoto configurato;
non apre rotte o identità sintetiche nel servizio remoto.

È una sonda di liveness: non certifica il funzionamento delle dipendenze
né la capacità di completare una ricerca. Nhost richiede HTTP 200 entro
5 secondi e può riavviare il container dopo tre sonde fallite.

## Build riproducibile

`scripts/prepara-contesto-centro.js` materializza esclusivamente i blob
del commit identificato da `prepara-release-nodi.js`: inventario del codice
e cataloghi pubblici. Anche la ricetta `scripts/docker/centro.Dockerfile`
proviene da quel commit. Il checkout vivo, `.env`, `auth.json` e i database
locali non vengono copiati. Il manifest viene ricontrollato dopo la copia;
un contesto incompleto viene eliminato senza toccare altre directory.

La ricetta usa Node 24.21.0 bookworm-slim ufficiale, bloccato per digest,
e `npm ci --omit=dev --ignore-scripts`. Il postinstall dell'app genera vendor
da dipendenze dev: viene escluso per preservare i file Git e non installare
Electron. Le dipendenze di produzione sono ancora quelle del lockfile
condiviso con APP: la loro presenza non significa che il centro le utilizzi
tutte. Non sono stati modificati package.json o package-lock.json.

Il processo usa l'utente `node` (UID 1000), codice e dipendenze non scrivibili;
solo `/var/lib/amr` ospita il registro operativo SQLite. I segreti vengono
forniti al runtime, mai al build. Il comando principale avvia direttamente
Node, così SIGTERM raggiunge l'entrypoint già provato.

Preparazione, dopo avere approvato il commit candidato:

```sh
node scripts/prepara-contesto-centro.js
docker build -t amr-centro:<release> <directory-restituita>
```

Non usare il checkout condiviso come build context. La preparazione non
pubblica immagini e non avvia servizi.

## Collaudo dell'immagine

Il launcher sintetico `scripts/collauda-nhost-locale.js` accetta il gate
opt-in `AMR_TEST_CENTRO_IMAGE`. Il gate automatico non legge il file delle
credenziali del collaudo manuale. Auth reale, email locale, MFA e schema
PostgreSQL vengono preparati dalla fixture esistente; non si importano
account o dati di produzione.

Il centro nell'immagine deve funzionare attraverso un proxy TLS di prova
con certificato locale esplicitamente fidato. La prova non disattiva la
verifica TLS e non decide gli IP da autorizzare sull'ingress Nhost reale.
I dati operativi sono su un volume separato; le risorse del gate devono
essere eliminate senza arrestare gli altri collaudi Docker.

La rete interna collega centro, PostgreSQL, proxy e fixture email/Auth. Solo
il proxy ha anche una rete di ingresso, con porta pubblicata su 127.0.0.1;
il centro non ha porte pubblicate. La sonda interna è provata nel container.
Certificato, chiave e script del proxy vengono copiati tramite Docker in un
volume temporaneo: non si presume che la VM Docker condivida il TMPDIR macOS.
Il proxy di prova usa destinazioni fisse, senza inoltro verso URL arbitrarie.
Le richieste worker sono completate dalla fixture, senza avviare scraper.

## Evidenze e stato

- Test mirati su Node 24: pass, inclusi avvio, cleanup, sonda e inventario.
- Suite completa finale Node 24.21.0: **1.212/1.216 pass, 4 gate opzionali
  esclusi, 0 errori**. Il gate immagine/Auth/PostgreSQL è eseguito separatamente.
- Review indipendente di sonda e context: nessun finding confermato; ulteriori
  controprove hanno verificato zero chiamate Auth/SQL durante la sonda.
- Review indipendente del helper finale: nessun finding concreto aperto;
  cinque controprove in memoria su rete, diagnostica e cleanup.
- Review indipendente finale del launcher: nessun finding verificato;
  105 suddivisioni dei chunk SQLSTATE, old-fail/new-pass, frame ammessi e
  cleanup preservato; 3/3 test mirati pass.
- Build locale dell'immagine riuscito; installazione dal lockfile e verifica
  del manifest effettivamente eseguite nel container.
- Identificativo dell'immagine di prova:
  `sha256:d148d385bde073ec7833300c1e5b7b86636854f96280c7aad7b8bf3910f62ef7`.
  Linux amd64, 116.594.964 byte. Non è una misura di RAM o di capacità.

Il build iniziale usa una fixture Git privata del candidato, derivata da
HEAD `5a6e0d8` e dalle modifiche AP al centro e alla ricetta. Il commit
`786d70a8f9b986462ec5cf5fc559089efa7b0907` appartiene solo a quella fixture:
non è un commit del branch condiviso né un artefatto approvato per deploy.
Prima di distribuire occorre rigenerare e collaudare dal commit approvato.

Il gate completo sull'immagine è passato: `/healthz`, guard HTTPS e UI;
password e MFA attraverso Auth reale; cookie Secure/HttpOnly/SameSite;
Admin gestionale senza ricerca, referente Moto senza Auto né Admin;
registrazione worker con manifest, rifiuto di release/token errati;
ricerca Moto/Subito sintetica con autorizzazione firmata del dettaglio e
conteggio dei byte; sospensione e revoca del nodo via Admin; SIGTERM con
exit code 0 senza OOM, riavvio sullo stesso volume e nuova epoca;
sospensioni, revoche e relativi eventi conservati, vecchie sessioni negate.
Backup non configurato dichiarato dall'Admin prima e dopo il riavvio.
Cleanup finale verificato: nessun container, rete o volume con label del gate
rimasto; i due stack manuali preesistenti sono ancora attivi.

Il controllo del container ha inoltre verificato UID 1000, codice e
dipendenze non scrivibili, assenza di `.env`/`auth.json`, Electron ed esbuild.
L'immagine contiene il candidato runtime; il launcher aggiornato gira
sull'host e collauda quel candidato. Occorre ripreparare l'intero artefatto
dal futuro commit approvato prima di un deploy.

### Problemi trovati e controprove

- La rete Docker `internal` non pubblicava la porta TLS: riprodotto con un
  server costante, corretto con ingresso del solo proxy e verificato nel
  gate completo. Centro e database restano sulla rete interna.
- Il bind mount presumeva un TMPDIR visibile alla VM: controprova negativa;
  copia Docker nel volume verificata con file sintetici e nel gate TLS.
- Il cleanup del launcher poteva cancellare i temporanei conservati dal
  gate figlio: corretto; controprove con annullamento e cleanup incompleto.
- SQLSTATE spezzato fra due chunk poteva andare perso: buffer limitato a
  64 caratteri, controprova sui chunk e nessun messaggio SQL raw nei log.

Una precedente esecuzione si è interrotta nel test colleghi PostgreSQL,
prima del gate immagine, senza evidenza sufficiente per attribuirne la causa.
Il successivo gate completo è passato senza allargare timeout o privilegi:
non è dimostrato un difetto del backend né è stata esclusa ogni instabilità
della fixture. La diagnostica ora conserva anche il punto del test, senza
messaggi o dati sensibili.

La prova HTTPS usa richieste rapide. Non dimostra il timeout di 60 secondi
dell'ingress Nhost, né carico sostenuto, browser umano o disponibilità cloud.

## Gate ancora separati

- Ingress Nhost reale: IP del proxy, header, cookie e timeout.
- Configurazione e accessibilità del volume con UID 1000 sul provider.
- Capacità, CPU/RAM e costo della configurazione realmente attivata.
- Backup esterno cifrato e restore separato; SMTP reale.
- Sessioni al riavvio e integrazione dell'intera app Auto/Moto.

## Fonti autorevoli confrontate

- [Nhost health checks](https://docs.nhost.io/products/run/health-checks).
- [Nhost networking](https://docs.nhost.io/products/run/networking) e
  [risorse/storage](https://docs.nhost.io/products/run/resources).
- [Docker build best practices](https://docs.docker.com/build/building/best-practices/):
  base affidabile, digest, build context ristretto e utente non root.
- [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/): installazione dal
  lockfile, dipendenze dev omesse e lifecycle script esplicitamente esclusi.
- [Node Docker best practices](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md):
  utente non root e gestione del processo principale.

Le fonti sostengono le scelte; solo il collaudo misura il candidato locale.
Il risultato locale non attesta il futuro ambiente Nhost.
