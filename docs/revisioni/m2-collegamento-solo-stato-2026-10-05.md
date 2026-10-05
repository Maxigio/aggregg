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
