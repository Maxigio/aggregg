# Recovery: inviti e replay ordinato — 4 ottobre 2026

## Decisione e contratto

Il proprietario ha approvato il replay completo ordinato dei journal
disponibili dopo il dump. Non si tenta di dedurre l'accettazione di un invito
da un rinnovo successivo, né si inventano date o token per ricostruirlo.

`applicaJournalOrdinati({client,journals})` valida l'intero input, lo copia e
ordina per sequenza `BigInt`, poi usa il medesimo client dedicato offline.
Blocca l'uso concorrente del client da batch e helper singolo. Ogni journal
resta atomico e idempotente; **il batch non è una transazione unica**.
Se fallisce, gli elementi precedenti possono essere applicati: mantenere il
DB offline, risolvere la causa e ripetere il batch completo. Nessun writer
web o processo pubblico deve usare questa credenziale di restore.

`applicaJournal` resta la primitiva per verifiche singole e casi idempotenti,
non sostituisce la procedura ordinata. Script di collaudo e gate PG esistente
sono collegati al nuovo entrypoint.

## Correzione verificata

Prima della membership, riconcilia soltanto l'invito **già presente** nel dump
e identificato dal journal `accetta` o `revoca_invito`. Verifica dominio,
ID/azienda, persona, corrispondenza email Auth tramite SQL, scadenza e intervallo
della conferma. Nessuna email è aggiunta al journal o restituita dai controlli.

- Accettazione: stessa persona e timestamp della conferma; per il collega
  converte anche `stato` da pending ad accettato.
- Revoca invito collega: marca come revocata quella prenotazione, conservando
  riga, impronta e metadati precedenti.
- Invito estraneo: invariato. Riga assente: non ricreata, perché mancano i
  dati operativi e non si deve rigenerare un token accettabile.
- Conflitto di identità/stato/azienda/scadenza: `ripristino_invito_in_conflitto`
  e rollback dell'intero journal.
- Membro con prenotazione attiva della stessa azienda ancora pending:
  `ripristino_accettazione_mancante`, senza avanzare audit o membership.
  Una prenotazione di altra azienda è un conflitto di appartenenza.

Il collaudo ha trovato anche un difetto preesistente: per `colleghi/revoca_invito`
`destinatario` è l'ID dell'invito, non un UUID di `auth.users`. Il controllo Auth
ora esclude soltanto quel destinatario; tutte le vere identità restano richieste.
Il caso reale falliva con `ripristino_identita_mancante`, ora completa la revoca.

La finalizzazione già esistente resta obbligatoria dopo il replay:
invalidazione sessioni/token, epoche incrementate e sequenza riallineata.
La patch sequenza va applicata dopo il restore di un dump storico. Questo
incremento non cambia i writer live, le quote o le autorizzazioni commerciali.

## Prove e controprove

- Prima: PostgreSQL 16 reale, dump con referente/collega pending → accettazioni
  successive → restore in altro DB → entrambi falliscono con
  `appartenenza_esistente`. Invito estraneo e membri precedenti preservati.
- Dopo: nuova regression opt-in `test/nodi-ripristino-inviti-pg.test.js`, Node
  24.21.0, PG16 temporaneo, Auth con tabella sintetica dei soli campi coinvolti.
  Dump e restore reali; input volutamente invertito; due accettazioni, rinnovo,
  idempotenza, prenotazione estranea e revoca invito verificati. **1/1 pass**.
- Controprove: rinnovo senza accettazione necessaria rifiutato con errore
  esplicito e membership invariata; email Auth incompatibile produce conflitto
  e rollback. Nessuna quota disabilitata o limite allargato.
- Unit test del journal: **26/26 pass**; ordinamento, validazione prima di SQL,
  stop al primo errore, client occupato e UUID invito distinto dall'utente.
- Gate precedente con **Auth, PostgreSQL e restic reali locali: 6/6 pass**,
  compresi restore in altro cluster, revoca da journal, finalizzazione,
  watermark/sequence e privilegi. Non è il provider cloud.
- Review indipendente del diff: nessun ulteriore finding confermato.
- Suite completa finale, Node 24 e dati temporanei: **1.298 test, 1.293 pass,
  zero failure, cinque skip opt-in**. Il nuovo gate PG16 e quello
  PostgreSQL/Auth/restic sono stati eseguiti separatamente e sono passati.

Log: `/private/tmp/amr-restore-unit-20261004.log`,
`/private/tmp/amr-restore-inviti-pg-20261004.log`,
`/private/tmp/amr-restore-auth-restic-20261004.log`,
`/private/tmp/amr-restore-final-full-20261004.log`.
Fixture dedicate eliminate; nessun dato/stack manuale, Nhost, M2 o portale usato.

## Limiti del recovery

L'ordinamento non dimostra da solo che lo storage contenga ogni operazione
confermata: le sequenze globali hanno anche buchi legittimi da rollback e
comprendono aziende diverse. Non si usa una sequenza contigua come prova.
La dipendenza mancante sopra è rilevata quando una prenotazione attiva
confligge con il membro da recuperare; non è un certificato universale di
completezza di tutte le copie. Servono ancora inventario verificato dello
storage reale, eventuali avvisi di copia non confermata e restore prima del
gate clienti. Una modifica di formato con catena esplicita sarebbe un altro
incremento da discutere, non una promessa di questo helper.

Fonti: [PostgreSQL: SQL dump](https://www.postgresql.org/docs/16/backup-dump.html),
[transazioni](https://www.postgresql.org/docs/16/tutorial-transactions.html) e
[sequenze](https://www.postgresql.org/docs/16/functions-sequence.html).
