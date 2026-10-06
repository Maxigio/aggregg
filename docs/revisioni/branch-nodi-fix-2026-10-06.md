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

## Lavoro restante

- F2: retry idempotente dell'accettazione del referente, senza nuova membership.
- F3: risposte tardive dei filtri e continuazioni della vecchia identità.
- F5: annuncio accessibile del conteggio risultati.
- C1/C4: politica dei login pendenti durante revoca e accettazione con MFA;
  interview aperta, nessuna decisione presunta.
- C2/C3: misurare retry menu/dettagli e traffico idle del worker con fonti simulate.
- Ingress staging: diagnosi remota e aggiornamento conservano il proprio gate.
- M2: collegamento solo stato successivo al collaudo staging; produzione esclusa.

Gli altri file locali, compreso il lavoro APP, restano fuori dai commit AP.
