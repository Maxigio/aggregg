# Correzioni successive alla review del branch, 6 ottobre 2026

Riferimento: `branch-nodi-2026-10-06-c77c4c3.md`. Questo registro distingue
implementazione locale, prove controllate e gate remoti; non attesta un deploy.

## F1 — Sessione precedente all'accettazione del referente

Implementazione: nuova migrazione `schema-referente-sessioni.sql`, successiva
alle otto già applicate. L'accettazione incrementa l'epoca della persona nella
stessa transazione di membership e journal. Le migrazioni storiche e le epoche
preesistenti non vengono riscritte; owner e ACL della funzione restano invariati.
Una sessione nata senza azienda viene negata; il referente effettua un nuovo login.

Prova: `test/nodi-referente-pg.test.js` usa un container PostgreSQL 18.6 già
disponibile, isolato e pubblicato solo su loopback. Prima della migrazione la
vecchia sessione passa `/api/auth/me`; dopo, una nuova accettazione la invalida
anche su `POST /api/ricerche`. Rollback, contesa SQL osservata, singolo incremento,
journal coerente e ricerca HTTP dopo nuovo login coprono le controprove.
Auth e worker sono sintetici; nessun portale o servizio remoto interrogato.
Il lifecycle colleghi esistente viene riusato con le epoche reali iniziali.

Review indipendente: nessun difetto della migrazione confermato. Due problemi
del test corretti: errore concorrente troppo generico e cleanup omesso dopo un
`docker run` di esito incerto. La prova verifica il codice del rifiuto e rimuove
solo il container della fixture, controllando che i container estranei restino.

Fondamento: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
per i cambi di privilegi; [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html)
per la conservazione di owner/ACL con `CREATE OR REPLACE`.

Gate: migrazione collaudata localmente, non applicata allo staging né all'M2.
Il pacchetto di prima installazione include ora nove migrazioni. Il guard del
collaudo rifiuta anche un candidato privo di uno dei file prima di contattare SQL.

## F4 — Focus dopo modifica dei colleghi

Implementazione: il fallback avviene nel `finally` dell'azione, dopo la
riabilitazione dei controlli. Richiede controllo originario rimosso, focus sul
body, stessa versione/azienda e destinazione visibile; non sottrae il focus
spostato dall'utente. Tolto il precedente tentativo su un pulsante disabilitato.

Prove: test in Chromium reale con backend sintetico, revoca riuscita e fallback
su Aggiorna; controprova con focus spostato su un input durante l'attesa e risposta
tardiva dopo logout. Review indipendente senza finding confermati. Il polling
iniziale del test attende anche la presenza del template, evitando un errore
intermittente della fixture. Nessuna prova manuale con tecnologia assistiva.

Fondamento: [HTML focus](https://html.spec.whatwg.org/multipage/interaction.html#focusable-area).

## F2 — Retry dell'accettazione del referente

Implementazione: ID operazione generato nel browser e riusato nei tentativi
della stessa pagina. Nuova migrazione append-only `schema-referente-retry.sql`:
la conferma richiede identità verificata, stesso invito e stessa operazione;
non aggiunge membership, epoca o journal. Il lookup di un invito consumato
permette solo la conferma, non signup/reinvio o una nuova accettazione. Dopo
revoca dell'azienda o cambio del referente quel percorso non conferma l'invito.
Una riapertura della pagina segnala l'accettazione già avvenuta e propone login.

Prove controllate HTTP, Chromium e PostgreSQL reale: prima risposta persa dopo
commit, retry con stesso ID, retry concorrenti, ID/identità/invito differenti,
scadenza, revoca e ACL. Una sola accettazione e un solo journal; provider
sintetico. Il nuovo test browser verifica due submit con lo stesso ID e una
sola modifica. Il pacchetto di prima installazione contiene dieci migrazioni;
nessuna è stata applicata al cloud. Nessuna chiamata ai portali.

Review indipendente: nessun finding residuo confermato. Prima del collaudo
PostgreSQL è stato corretto un riferimento a una colonna inesistente individuato
durante la review. HTTP/packaging: 12 pass; nuovo test browser: 1 pass; prova PG
conclusa, con cleanup della sola fixture. Un timeout del test browser dipendeva
da una navigazione nello stesso documento: la riapertura viene ora provata con
reload, senza attribuire quell'errore all'app.

Fondamento: riuso del protocollo già presente per i colleghi e
[RFC 9110, idempotenza](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).
La garanzia del POST deriva dall'ID e dai controlli SQL, non dal metodo HTTP.

## Decisioni confermate

- C1: la revoca annulla i tentativi già creati dal backend. Il tentativo va legato
  all'email e all'epoca SQL prima di Nhost, senza adottare una nuova epoca dopo.
  L'ordine è quello del backend/SQL, non dell'arrivo dei clic in rete. Un nuovo
  login dopo revoca resta possibile; i permessi commerciali rimangono negati.
- C4: per ora accettazione senza challenge MFA. Le identità con MFA già attiva
  restano rifiutate esplicitamente; il secondo fattore non viene aggirato.
- C2: l'utente rinvia il protocollo breve per menu/dettagli al collaudo staging.
  Il comportamento attuale viene preservato, con il rischio condizionato sotto.

## C2/C3 — Misure e controprove

Esecuzione indipendente ripetuta dal processo principale con Node 24.21.0:
47 pass, nessuna chiamata esterna. Trasporto stub, HTTP loopback e istanze VM
isolate; nessuna misura del proxy Nhost o dei portali reali.

- C2: una GET fredda produce un job/una chiamata; due GET sullo stesso worker
  con esito riuscito producono due job/una chiamata grazie alla cache. Su worker
  diversi o dopo errore non memorizzato: due job/due chiamate. Quindi non è
  corretto descrivere ogni doppio job come doppio scraping.
- Tutti i 287 menu Auto e 345 su 450 menu Moto non richiedono rete nella scansione
  controllata. Per 105 marche Moto resta il fallback remoto: congelare tutto il
  catalogo al centro cambierebbe copertura, non è una correzione neutra.
- C3: in due secondi sul loopback, otto heartbeat e otto poll; introducendo 50 ms
  per risposta, sei e sei. Periodo: 250 ms più le due latenze e l'elaborazione.
  Non sono misurati sovraccarico, costo cloud o SLA di disconnessione. Timer
  invariati; ottimizzazione rinviata a una misura che giustifichi il cambiamento.

Ricevuta temporanea: `/private/tmp/amr-c2c3-20261006-t_c45yow/node24.log` e
`REPORT.md`. Gli scenari essenziali restano qui se i temporanei vengono eliminati.

## C1 — Revoca dei login già ammessi

Implementazione: migrazione append-only `schema-login-inizio.sql`; funzione
ristretta email → UUID/epoca, owner NOLOGIN e solo EXECUTE al lettore. Il
bootstrap riserva un tentativo, fotografa il DB e ne vincola l'email prima di
emettere l'handle. Login, MFA e finalizzazione confrontano quell'epoca senza
adottare quella nuova. Logout/sostituzione/scadenza durante SQL annullano anche
la risposta tardiva. La sessione conserva l'epoca iniziale; nessun lock resta
aperto durante l'attesa di Auth. Il pacchetto include undici migrazioni.

Review indipendente: verificato e corretto un canale di distinzione fra account
AMR presente/assente nel precheck. La verifica dell'epoca avviene dopo Auth;
checkpoint presente/assente/ambiguo e password errata fanno una chiamata Auth e
restituiscono lo stesso errore. Il binding email e le verifiche prima di
sessione/MFA restano. Non è una garanzia di tempi identici del provider remoto.

Prove: 22 nuovi casi controllati, 32 test del gruppo mirato ripetuti dal main,
PostgreSQL 18.6 reale con email citext e ruoli limitati. Coperti handle/provider
pendenti durante revoca+rinnovo, MFA, commit la cui ricevuta è ignorata, rollback,
ACL e login nuovo durante revoca (ricerca HTTP negata). Auth è sintetico in
queste prove; nessuna migrazione remota applicata. Aggiornati anche i due runner
di collaudo con il nuovo bootstrap e le migrazioni del percorso locale PG16.

Confine: una revoca dopo la fotografia finale può precedere la consegna di un
cookie con l'epoca vecchia. Quel cookie è negato al successivo controllo, anche
dopo rinnovo; non si promette di impedire ogni risposta tardiva sulla rete.
Una richiesta ancora in attesa della fotografia iniziale non è un tentativo
già creato. Conta l'ordine backend/SQL concordato, non l'ordine dei clic.

Fondamento: [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
per errori generici e canali di distinzione; OWASP Session Management e
PostgreSQL CREATE FUNCTION già citati per invalidazione e privilegi minimi.

## Lavoro restante

- F3: risposte tardive dei filtri e continuazioni della vecchia identità.
- F5: annuncio accessibile del conteggio risultati.
- C2: rivalutare menu/dettagli nel collaudo staging; C3 costo idle noto.
- Ingress staging: diagnosi remota e aggiornamento conservano il proprio gate.
- M2: collegamento solo stato successivo al collaudo staging; produzione esclusa.

Gli altri file locali, compreso il lavoro APP, restano fuori dai commit AP.
