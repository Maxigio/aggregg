# Review del branch centro–nodi — 2 ottobre 2026

## Perimetro e verdetto

Branch `feat/nodi-residenziali-prototipo`, baseline `81e25ab`, candidato runtime
`646fcbe6eb576f354de8dd675c30d330dc8941c9`: 44 commit, 116 file, 17.794 aggiunte e
727 rimozioni. Il successivo `75207a7` aggiunge il pacchetto di staging; non
cambia il runtime, ma cambia l'inventario della release. Centro e worker devono
comunque provenire dalla stessa release verificata: non combinare l'immagine
`646fcbe` con il checkout aggiornato presumendo equivalenza del manifest.

Il prototipo dispone di ricerca coordinata, diagnostica, Auth/MFA Nhost,
autorizzazioni PostgreSQL, aziende, rinnovi, colleghi e gestione delle sessioni.
La composizione è nel centro; gli scraper restano sui worker. L'immagine del
centro è stata verificata localmente con HTTPS e servizi reali di collaudo.
Questo non completa il gate clienti: restano difetti e prove cloud, storage,
carico e integrazione del frontend AMR completo.

Review indipendenti in sola lettura: scheduler/protocollo, account/UI,
backup/ripristino e pacchetto Run. I finding sono stati confrontati con i
chiamanti e, dove indicato, riprodotti nuovamente dal coordinatore della review.
Non sono stati applicati fix ai finding di questa review.

Nessun accesso a credenziali, dati dei clienti, portali o M2. Prove HTTP solo su
loopback con dati sintetici. Nessun push o distribuzione remota.

## Percorsi verificati

| Percorso | Responsabilità e prova |
| --- | --- |
| Login → sessione | `nhost-auth-client.js`, `login-nhost-prova.js`, `accessi-postgres-prova.js`: esito provider verificato dal server, MFA Admin, cookie opaco, controllo corrente dell'epoca e dell'azienda |
| Ricerca → nodo → composizione | `centro.js`, `worker.js`, `worker-esecutore.js`, `ricerca-coordinatore.js`: budget, assegnazione, compatibilità, fonti, composizione e risposta; nessun browser nascosto introdotto |
| Pagine, retry e 429 | Affinità per fonte, cursori Subito separati, retry della porzione fallita, fonte in pausa per nodo, massimo un nodo alternativo; prove sintetiche e due difetti scheduler sotto |
| Revoca e scadenza | Verifica del destinatario prima della consegna, logout AMR immediato e stato separato della revoca provider; nessun risultato consegnato al destinatario revocato nelle controprove |
| Aziende e colleghi | Rotte e helper SQL ristretti, quote in transazione, idempotenza delle operazioni, rinnovo modificabile e trasferimento a collega attivo |
| Dettagli | Autorizzazione firmata legata a sessione, URL e modulo; verifica permessi correnti prima della richiesta al nodo |
| Copie e restore | Trigger commerciale → outbox → worker → repository separati → restore offline; confine Auth esplicito e numerazione da correggere sotto |
| Diagnostica e riavvio | SQLite per metadati, eventi, sospensioni e fingerprint revocati; sessioni/risultati/coda in RAM; lavoro già iniziato incerto dopo perdita del processo, senza replay automatico |
| Entrypoint Run | `config-centro-run.js`, `centro-run.js`, `trasporto-prova.js`, manifest e immagine da Git: HTTPS/Host espliciti, ruoli PG distinti, Node 24, SIGTERM e volume |

## Finding confermati e proposte

### B01 — Alta: numerazione dei journal dopo un restore

**Percorso:** `ripristino-journal.js:137–180`,
`schema-backup-prova.sql:12,69`, finalizzazione tramite
`amr_backup.invalida_accessi_ripristinati()`.

Il replay conserva la massima sequenza recuperata in `amr_ripristino`, ma non
riallinea `amr_backup.sequenza`, da cui il trigger assegna le nuove operazioni.
La procedura di invalidazione degli accessi non effettua il riallineamento.

**Riproduzione:** dump a 10, replay fino a 12, nuova operazione numerata 11:
il replay la classifica `superato`; una nuova operazione a 12 entra in conflitto.
Con numerazione 13 l'operazione viene applicata. Il replay originale resta
idempotente e il vecchio journal 9 resta correttamente superato.

**Impatto:** dopo una riapertura e un secondo recupero, le nuove operazioni
possono essere ignorate o impedire il replay. Non dimostra perdita durante il
normale commit commerciale o nel solo primo restore.

**Proposta:** finalizzazione offline obbligatoria prima della riapertura:
riallineare la sequenza globale almeno al massimo recuperato e corrente, senza
abbassarla. Conservare durante il replay il checkpoint del dump originale.
Provare restore → replay → riapertura → nuova operazione → secondo restore,
inclusi più tenant, buchi da rollback e invalidazione degli accessi.

**Evidenze:** helper reale con adapter SQL sintetico e successiva riproduzione
su PostgreSQL 16 reale: dopo replay 9, il nuovo rinnovo riceve 8 e non viene
recuperato nel secondo restore. Riallineando prima della riapertura, il nuovo
journal 10 viene recuperato con la scadenza esatta. Il test completo passa
3/3; configurazione e dettagli sono nell'aggiornamento finale sotto.

### A01 — Media: richieste anonime consumano la quota di gestione account

**Percorso:** `sessioni-prova-route.js:8–23`,
`aziende-prova-route.js:13–17`, `colleghi-prova-route.js:24–28`.

La quota di 30 richieste/minuto è globale per gruppo di rotte e viene consumata
prima di verificare la sessione. Letture e scritture condividono la quota.

**Riproduzione:** 30 GET anonimi dell'elenco sessioni ricevono 401; la successiva
revoca autenticata riceve 429 e la sessione da revocare resta attiva. Dopo la
finestra la stessa revoca riesce e l'accesso è negato. Logout corrente resta
disponibile. Stessa prova su elenchi aziende e colleghi: 30 richieste anonime
401, elenco autorizzato 429, poi 200 dopo la finestra, senza accessi al DB falso
prima dell'autorizzazione.

Il polling UI ogni 30 secondi può consumare il limite anche con uso legittimo:
il budget globale non è dimensionato come quota personale per 30 persone.
Questo è un problema di disponibilità; non conferisce accessi non autorizzati.

**Proposta:** rifiuto economico delle sessioni inesistenti prima del budget di
gestione; quote legate alla persona autenticata, letture separate dalle revoche,
e limite globale di concorrenza per proteggere il DB. Mantenere una difesa
distinta per chiamate anonime e inviti pubblici, con mappe limitate e cleanup.
Non limitarsi ad alzare 30 né fidarsi di identificatori forniti dal client.

**Prove:** `http-proof.cjs` e `route-budgets.cjs` nella directory
`/private/tmp/amr-review-account-646fcbe.50d65R`, rieseguiti sul codice attuale.

### S01 — Media: nodo libero ignorato a parità di copertura

**Percorso:** `centro.js:279–282` e assegnazione/poll del worker.

La selezione confronta la copertura e la lunghezza della coda; non conta il
lavoro già in esecuzione. Con A occupato e B libero, entrambe code vuote e
stesse fonti disponibili, la seconda ricerca finisce su A; B risponde 204.
Quando A termina, entrambe le ricerche completano: non è perdita di risultati.

**Proposta:** a parità di copertura considerare coda e lavoro attivo; preservare
prima l'affinità valida delle pagine. Verificare anche le selezioni dei dettagli
e delle porzioni di fonte per non introdurre regole divergenti. Il conteggio
dei lavori è una stima del carico, non una misura della durata futura.

### S02 — Media: fonte in pausa sul nodo preferito impedisce la pagina

**Percorso:** `centro.js:347–356`, successivo failover e avvisi `:373–405`.

Prima pagina servita da A; richiesta successiva solo Subito; A è online ma
Subito in pausa, B può servire Subito. Il primario resta A perché si controlla
la disponibilità del nodo senza quella della fonte. La rotta risponde 503
prima di usare B. Controprova: sospendendo l'intero A, B viene usato e risponde
200. Quindi il difetto riguarda la pausa della fonte, non qualsiasi failover.

**Proposta:** preferire A soltanto se può eseguire almeno una delle porzioni
richieste; altrimenti selezionare un primario disponibile. Preservare cursori,
permessi, budget e avviso di cambio nodo. Il nuovo IP non garantisce una
fotografia identica del portale: il limite già concordato resta esplicito.

**Prove S01/S02:**
`/private/tmp/amr-nodi-review-646fcbe-NeTFd5/centro-probes.cjs`, rieseguito.
La controprova di revoca del token durante l'attesa del poll non consegna il
lavoro: vecchio poll 204, successivo 401, ricerca 503. Non è un finding aperto.

### B02 — Media: retention oltre il budget dell'output restic

**Percorso:** `backup-restic.js:27,81`, `backup-postgres-prova.js:109–117`.

Ogni operazione produce uno snapshot; `forget --json --dry-run` restituisce
il piano completo. Il wrapper interrompe qualsiasi output oltre 1 MiB.
100 snapshot sintetici nel formato restic reale passano; 2.500 producono circa
1,7 MB e falliscono. Cambiando solo il cap nella VM temporanea a 8 MiB lo stesso
piano passa. Le copie non sono automaticamente perse: si blocca la manutenzione,
con errore persistente e retry che riproduce lo stesso guasto.

**Proposta:** distinguere i piccoli output dal piano di retention e dimensionare
il budget sul volume operativo ammesso; mantenere validazione, timeout e
protezione dello snapshot corrente. Scegliere parsing progressivo o limite
esplicito verificato dopo misura; 8 MiB è una controprova, non la soluzione
definitiva. Non eliminare snapshot per aggirare il parser.

**Prova:** `retention-capacity.cjs` in `/private/tmp/amr-review-646fcbe-backup`,
rieseguita. Repository/copia/formato reali; cronologia da 2.500 snapshot
simulata. Nessuno storage remoto o archivio reale esteso interrogato.

### U01 — Media: aggiornamento account perde il focus delle sessioni

**Percorso:** `frontend/nodi-aziende-prova.js:64–86,114–132,330`.

L'elenco sessioni ricrea tutti i pulsanti ad ogni aggiornamento; il ripristino
del focus gestisce soltanto i pulsanti azienda. La prova UI indipendente con
dati identici e polling porta il focus da «Revoca sessione» a BODY; il pulsante
«Revoca accesso azienda» conserva invece il focus. La lettura del codice
conferma la differenza. Non è stata eseguita una prova manuale del proprietario.

**Proposta:** identificativo stabile per sessione/azione e conservazione del
focus durante il refresh, senza rubarlo se la persona nel frattempo lo ha
spostato. Se la sessione sparisce, fallback a un controllo disponibile.

### U02 — Bassa: retry mostra un invito già consumato

**Percorso:** `aziende-prova-route.js:38–42`,
`schema-aziende-prova.sql:171,231`. Il percorso colleghi già controlla lo stato
pending prima di riesporre il link; la rotta aziende usa la sola copia RAM.

Retry di un invito pending recupera correttamente il link. Dopo l'accettazione,
retry della stessa operazione restituisce ancora quel link; la consultazione
lo rifiuta 403. Non c'è bypass di accesso, ma una consegna presentata come valida
che non funziona. Harness HTTP con dominio account simulato, SQL reale letto:
la stessa sequenza end-to-end su PostgreSQL non è ancora stata provata.

**Proposta:** prima di riconsegnare il token controllare lo stato pending nel
dominio, come per colleghi. Conservare il recupero degli inviti ancora validi
e comunicare un invito accettato/scaduto senza creare nuove operazioni.

## Rischio condizionato, distinto dai flussi UI

**C01 — Login tardivo dopo logout senza contesto browser.**
`login-nhost-prova.js:33–38,155`: login iniziato senza cookie di contesto e
logout concorrente creano contesti diversi; il login successivo può ancora
produrre una sessione valida. Prova HTTP: login/me 200. Controprova con bootstrap
`/api/auth/me`, usato dal frontend: login/me 401 e provider ripulito.

È riprodotto per un chiamante API privo di bootstrap, **non nel flusso normale
dell'interfaccia**. Non è stato dimostrato un bypass MFA o l'accesso senza
password. Proposta di hardening: richiedere un contesto già stabilito prima di
iniziare la verifica Auth, preservando il normale bootstrap. Non presentarlo
come un logout normalmente inefficace né come un difetto critico dimostrato.

## Decisioni mantenute e limiti

- Un solo scheduler/processo; pausa con repliche zero e conferma dell'arresto
  prima dell'aggiornamento. Nessuna garanzia provider di assenza di overlap
  viene presunta dal solo `replicas=1`.
- Prima pagina parziale visibile con retry della sola fonte; revoca/scadenza
  del destinatario interrompe la consegna e restituisce solo l'esito.
- Ricerca condivisa solo per la prima pagina realmente identica; scope e
  filtri separati, pagine/retry non implicitamente condivisi fra aziende.
- Sessioni e risultati in RAM, coda persa al riavvio senza replay automatico.
  SQLite conserva metadati, sospensioni e revoche delle chiavi dei nodi.
- Persistenza del volume non è backup. I repository restic remoti non sono
  configurati nell'entrypoint Run; PG e SQLite richiedono gate separati.
- Nhost reale cloud, SMTP Aruba, recupero Admin, trusted proxy, capacità,
  timeout ingress e storage gestito restano da provare prima dei clienti.
- Il frontend servito dall'immagine è quello del prototipo; non certifica
  l'integrazione di tutte le funzioni del frontend AMR aggiornato da APP.

## Prove e prossimo ordine di lavoro

L'immagine Linux amd64 del commit `646fcbe` ha completato il gate locale con
Nhost Auth/PostgreSQL reali e TLS: login/MFA, ruoli, aziende e revoche, ricerca
Moto simulata, SIGTERM e riavvio sul volume. Non ha interrogato portali.
Suite precedente sullo stesso runtime: 1.216 test, 1.212 pass, quattro prove
opzionali saltate, zero failure; i conteggi non sono una prova cloud.
I test PG, restic e immagine specifici sono documentati separatamente.

La configurazione staging è stata validata dalla CLI ufficiale 1.51.2 con
segreti sintetici e controprove negative. Review indipendente del TOML e della
procedura non ha trovato difetti confermati che impediscano il commit.

Ordine proposto, da autorizzare per i fix:

1. B01 e A01: recupero coerente e disponibilità dei comandi di revoca.
2. S02 e S01: failover della pagina e assegnazione senza attese evitabili.
3. B02, U01, U02 e C01, con prove calibrate sui limiti indicati.
4. Completare lo [staging Nhost](staging-nhost.md), poi prove di ingress,
   volume, storage esterno, carico e integrazione APP sul candidato reale.

Alla chiusura iniziale della review, la console richiedeva ancora login.
Aggiornamento del 3 ottobre: il proprietario ha scelto il progetto `AMR` come
staging; il servizio preliminare Run è creato con zero repliche. Stato e prove
sono nel [registro staging](staging-nhost.md). La creazione del servizio fermo
non equivale all'esecuzione del centro né al gate produzione.

## Aggiornamento della controprova PostgreSQL

Prova conclusa **3/3 pass, zero skip e failure**, PostgreSQL 16/Auth reali,
tre stack Docker temporanei e un secondo database per la controprova. Il test
esistente viene compilato con un incremento in memoria: nessun file di runtime
o test del repository è stato modificato.

1. Restore dal dump e replay del journal 9 nel primo cluster di recovery.
2. Dump della base così recuperata, prima del nuovo rinnovo confermato 8.
3. Restore di quella base nel terzo cluster e replay del journal 8:
   `superato`; la nuova scadenza non è recuperata.
4. Riallineamento controllato della sequenza nella fixture, dump della base
   prima del rinnovo 10, restore in un database separato e replay 10:
   `applicato`; scadenza nuova recuperata esattamente.

Harness `/private/tmp/amr-review-646fcbe-backup/real-pg-resume.cjs`, log finale
`/private/tmp/amr-review-646fcbe-backup/real-pg-resume.log`. L'impostazione del
secondo restore è stata revisionata indipendentemente in sola lettura.

Le prime due esecuzioni dell'incremento fallivano perché la controprova tentava
il replay sul DB che aveva appena confermato il rinnovo: lì il checkpoint lo
considerava correttamente già presente. Era un errore della prova, corretto
prima di registrare un PASS; non una regressione del repository. La versione
finale usa davvero una copia precedente al rinnovo e un database distinto.

Tutti gli stack creati dalla prova sono stati rimossi. Le due istanze manuali
preesistenti sono rimaste attive. Nessun database, account o servizio remoto
è stato coinvolto. B01 è ora confermato anche sul percorso PostgreSQL reale;
la proposta richiede ancora implementazione e collaudo dedicati.
