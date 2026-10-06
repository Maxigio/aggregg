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

## Lavoro restante

- F3: risposte tardive dei filtri e continuazioni della vecchia identità.
- F5: annuncio accessibile del conteggio risultati.
- C1: implementare e collaudare la politica dei login pendenti concordata.
- C2/C3: misurare retry menu/dettagli e traffico idle del worker con fonti simulate.
- Ingress staging: diagnosi remota e aggiornamento conservano il proprio gate.
- M2: collegamento solo stato successivo al collaudo staging; produzione esclusa.

Gli altri file locali, compreso il lavoro APP, restano fuori dai commit AP.
