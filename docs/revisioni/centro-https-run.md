# Centro HTTPS e Nhost Run — gate locale

## Decisione e perimetro

Il proprietario ha confermato un solo servizio AMR su Nhost Run che serve
frontend e backend. Auth e PostgreSQL restano servizi separati nello stesso
progetto; gli scraper restano sui nodi residenziali. Il presente incremento
prepara l'avvio e ne prova i confini localmente, senza attivare Nhost o toccare M2.

L'entrypoint è `backend/nodi/centro-run.js`. Serve attualmente l'interfaccia del
prototipo, non tutte le funzionalità dell'app principale: il passaggio del
frontend AMR completo è un gate distinto, descritto nella
[mappa delle funzionalità](amr-centro-mappa-funzionalita.md).

## Configurazione esplicita

`config-centro-run.js` non carica `.env`. Riceve variabili dal processo:

| Variabile | Vincolo |
| --- | --- |
| `AMR_CENTRO_ORIGINE` | Una sola origine HTTPS canonica, senza percorso |
| `AMR_NHOST_AUTH_URL` | Endpoint Auth HTTPS con prefisso `/v1`, senza query o credenziali |
| `AMR_CENTRO_PROXY_IP` | IP esatti dei proxy effettivi, separati da virgola; nessun trust universale |
| `AMR_CENTRO_REPLICHE` | `1`: un solo scheduler; scaling non implementato |
| `AMR_NODI_RELEASE_FILE` | Percorso assoluto del manifest prodotto dal commit candidato |
| `AMR_NODI_DATA_DIR` | Percorso assoluto del registro SQLite, su volume persistente nello staging |
| `AMR_NODI_TOKENS` | Oggetto ID nodo → chiave distinta casuale; segreto, mai nei documenti o log |
| `AMR_PG_HOST`, `AMR_PG_PORT`, `AMR_PG_DATABASE` | Database esplicito; TLS verificato fuori dalla rete privata |
| `AMR_PG_RETE_PRIVATA` | La deroga TLS è limitata a `postgres-service` Nhost o `postgres` della fixture |
| `AMR_PG_LETTURA_USER/PASSWORD` | Ruolo di lettura delle funzioni autorizzate, pool massimo 4 |
| `AMR_PG_COMMERCIALE_USER/PASSWORD` | Ruolo commerciale distinto, pool massimo 4 |
| `AMR_PG_BACKUP_USER/PASSWORD` | Ruolo outbox distinto, pool massimo 2, connessione LISTEN separata |
| `PORT` | Porta HTTP interna; default 3000 |
| `AMR_NODI_RICERCA_TIMEOUT_MS` | Default 60000 |
| `AMR_NODI_RICERCHE_MAX_PERSONA/TOTALE` | Default 2/60 richieste pendenti |

Runtime scelto: **Node 24 LTS**. L'entrypoint rifiuta major differenti; il minimo
generico del `package.json` dell'app non prova la disponibilità di `node:sqlite`.
L'entrypoint non applica migrazioni né crea utenti o ruoli automaticamente.

## Confini verificati nel codice

- Host, Origin, TLS e duplicati degli header vengono controllati prima degli
  handler. Il proxy autorizzato deve sovrascrivere `X-Forwarded-Proto`.
- Cookie Secure in HTTPS, HttpOnly e SameSite; guard indipendenti sulle rotte di
  login, sessioni, aziende, colleghi e backup. Il controllo della sessione e dei
  permessi resta server-side anche quando il trasporto è valido.
- I metodi diversi da GET/HEAD richiedono Origin; soltanto le rotte `/_nodo/`
  possono ometterlo con credenziale nodo valida. GET/HEAD senza Origin restano
  ammessi dal trasporto, soggetti alle autorizzazioni della singola rotta.
  Una credenziale nodo non concede accesso alle operazioni account.
- La revoca della credenziale è persistita come fingerprint. Un riavvio non
  riabilita la vecchia chiave; occorre una chiave nuova, distribuita fuori dalla UI.
- I lavori accodati del nodo revocato sono interrotti; quelli già assegnati hanno
  esito incerto e non vengono ripetuti automaticamente.
- Registrazione, boot, epoca centrale e compatibilità sono obbligatori nel
  percorso remoto. La modalità locale storica resta separata.
- SIGTERM/SIGINT durante inizializzazione o ascolto chiudono le risorse possedute;
  nessun annuncio tardivo di servizio avviato. I pool vengono chiusi anche dopo
  inizializzazione fallita.

## Persistenza e limiti deliberati

Sessioni web e risultati restano in RAM: un riavvio invalida le sessioni e perde
la coda. Il registro SQLite conserva sospensioni, revoche delle chiavi e
diagnostica, senza annunci. Richiede un volume persistente; più repliche o due
scheduler sullo stesso registro non sono autorizzati da questa configurazione.
Prima del lancio ai clienti va concordato il comportamento delle sessioni al
riavvio: mantenere il nuovo login obbligatorio oppure introdurre persistenza
con revoca e scadenza collaudate. Questo gate locale non decide quella scelta.

Il worker backup è collegato, ma il repository esterno non viene configurato
implicitamente dal nuovo entrypoint: fino al gate storage, l'Admin mostra un
avviso persistente. Le prove restic locali non attestano una copia su R2/S3.

Il manifest serve a prevenire incompatibilità accidentali fra release e
cataloghi; non è un'attestazione crittografica di un computer compromesso. Un
nodo resta una macchina fidata gestita dal proprietario. Le dipendenze richiedono
installazione dal lockfile e collaudo dell'immagine candidata.

La verifica riguarda l'avvio: l'artefatto va reso **immutabile e non scrivibile
durante verifica ed esecuzione**, con cache/dati operativi in cartelle separate.
Modifiche ai cataloghi o al codice richiedono una nuova release e un riavvio;
il heartbeat non ricalcola gli hash. I controlli sui symlink rifiutano link già
presenti, ma non sono una protezione da sostituzioni concorrenti dei genitori
da parte di chi può modificare l'artefatto. Anche file codice aggiunti possono
cambiare la risoluzione di `require`: l'inventario deve coincidere esattamente.
La verifica rifiuta anche `node_modules` annidati nelle directory del codice;
soltanto quello alla root rimane affidato all'installazione dal lockfile.

## Gate prima dell'attivazione cloud

1. Preparare l'artefatto dal commit approvato, con dipendenze bloccate e manifest;
   non distribuire il checkout condiviso o `.env`/database locali.
2. Validare immagine e configurazione con Nhost Run: porta HTTP pubblicata 3000,
   una replica, volume persistente. Scegliere CPU/RAM e budget sulla configurazione
   realmente accettata dal servizio, non su valori di esempio del documento.
3. Misurare IP/header dell'ingress Nhost prima di fissare il trust proxy. Provare
   richieste HTTPS normali, header falsificati, cookie, riavvio e timeout di 60 s.
4. Applicare lo schema e i ruoli nel progetto di staging, verificare la compatibilità
   del PostgreSQL reale. Provare Auth, MFA, inviti e revoca sotto i ruoli ristretti.
5. Configurare i due repository esterni cifrati e provarne copia, retention e restore
   in un ambiente separato. Verificare recupero dei ruoli e invalidazione accessi.
6. Collegare solo iMac inizialmente; verificare risposta, retry per fonte, 429,
   compatibilità e perdita della connessione. Nessun coinvolgimento M2 implicito.
7. Integrare e collaudare con APP tutte le funzionalità Auto/Moto prima del rilascio.

## Evidenze locali del candidato

Incremento backend/release: `e5b26b3`; integrazione Admin: `d09606f`.
Suite completa Node 24.21.0: **1.209/1.211 pass, 2 gate Docker opt-in esclusi,
0 errori**. I gate opt-in sono stati eseguiti separatamente con Auth,
PostgreSQL 16 e restic locali. Le prove comprendono rifiuto del codice aggiunto
e di dipendenze annidate, controllo del manifest prima delle operazioni,
revoca persistente, riavvio, guard HTTPS e cleanup durante init/listen.
Le review indipendenti hanno ripetuto le controprove dei difetti confermati.

Artefatto da blob Git del commit `d09606f`: 192 file di codice e 474 cataloghi
pubblici, gate positivo sulla copia reale. Modulo aggiunto rifiutato; rimosso
il modulo, stesso manifest nuovamente accettato. Nessun `.env` o `auth.json`
locale incluso. Prova dell'inventario, non ancora dell'immagine installata.

Il collaudo browser automatico usa risposte simulate; l'accettazione manuale
delle nuove funzioni e il trasporto Nhost reale rimangono da eseguire.

## Fonti autorevoli

- [Nhost networking](https://docs.nhost.io/products/run/networking): DNS privato e pubblicazione delle porte.
- [Nhost configurazione](https://docs.nhost.io/products/run/configuration): configurazione del servizio.
- [Nhost risorse](https://docs.nhost.io/products/run/resources): repliche, risorse e storage; filesystem ordinario effimero.
- [Express dietro proxy](https://expressjs.com/en/guide/behind-proxies/): fiducia limitata al percorso reale.
- [OWASP sessioni](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) e
  [autorizzazioni](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): cookie sicuri e permessi su ogni richiesta.

Queste fonti sostengono i criteri; le prove locali e la documentazione del provider
non dimostrano comportamento, capacità o costo della futura installazione cloud.
