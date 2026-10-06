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

## F3 — Filtri e continuazioni di contesti superati

Implementazione: cataloghi, filtri, scenari e aggiornamento dell'identità
verificano il contesto dopo ogni attesa prima di modificare il frontend.
Una risposta identica dei filtri non ricrea i controlli; una risposta aggiornata
conserva le scelte ancora valide e segnala quelle invalidate, impedendo la
paginazione della vecchia ricerca. Logout e cambio account invalidano le
continuazioni precedenti; non vengono aggiunte chiamate alle fonti.

Review indipendente: due regressioni confermate e corrette prima del commit.
Un login sintetico fallito scartava una sessione iniziale valida; due login
sintetici concorrenti potevano lasciare UI e cookie di aziende differenti.
Il bootstrap ora attende il login e conserva la sessione dopo il fallimento;
il login sintetico è seriale e usa il coordinamento cookie quando disponibile.

Prove: gruppo browser precedente 46 pass su Node 24.21.0; dopo le correzioni,
dieci casi mirati ripetuti in Chromium reale, zero skip. Coperti cookie HTTP,
bootstrap nei due ordini, successo/reset, cataloghi pendenti e risposte tardive
200/503. Seconda review con otto controprove VM e backend cookie reale: nessun
finding residuo confermato. Il bottone del solo login sintetico resta bloccato
durante il caricamento dell'identità e dei cataloghi. Prove manuali non eseguite.

## F5 — Annuncio accessibile dello stato ricerca

Implementazione: `ricercaStato` ha `role="status"` e `aria-atomic="true"`.
Le sette transizioni esistenti passano da una funzione che non riscrive testi
identici. Griglia, avvisi, query, retry e focus mantengono il comportamento
precedente; non si rende live l'intera lista degli annunci.

Prove: nuovo test Chromium su Node 24.21.0, 1 pass, verifica markup, mutazioni
per attesa, zero/nonzero risultati, errore, retry, pagina incompleta e reset.
Conservato il focus su un controllo attivo, senza mutazioni per testi identici.
Review indipendente: quindici aggiornamenti controllati producono sette
scritture; nessun finding confermato. Corretto un prerequisito della fixture:
il form deve essere visibile prima di verificare il focus. Non è un difetto
dell'app. MutationObserver non dimostra gli annunci effettivi di uno screen
reader; la prova manuale con tecnologia assistiva resta da eseguire.

Fondamento: [WCAG 2.2, status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).

## Collaudo integrato — Barriera della prova di contesa

La suite generale del candidato `3c82b02` passa, ma il primo collaudo integrato
Auth/PostgreSQL 18 si ferma nella barriera `contesa non osservata`. Il precedente
log `aziende_invita` in `colleghi_quota` è un rifiuto atteso della fixture, non
la prova della causa del fallimento. Non sono stati modificati SQL, quote o
timeout applicativi per far passare il test.

Prova isolata: il monitor tramite Docker impiega 713 ms e osserva il lock;
introducendo 1.600 ms di ritardo prima del monitor, il contendente scade a
1.514 ms con SQLSTATE `55P03` e il monitor fallisce con `P0001`, pur essendoci
stata una contesa. Il pool osserva invece il lock in 67/16/11 ms in tre prove
reali, con ruolo non privilegiato e timeout di 1.500 ms invariato. Senza lock
il risultato resta falso. Non è stato cronometrato l'avvio del monitor nel
primo collaudo fallito: il meccanismo è riprodotto, quel singolo episodio non
è attribuito con certezza al tempo di avvio Docker.

Correzione circoscritta alla fixture: terzo client preparato prima del
contendente; avvio dei poll per un secondo/massimo 100 verifiche, asserzione
di lock reale conservata. Una query già inviata mantiene i timeout del pool:
non si promette una durata totale massima di un secondo. Il cleanup scarta
l'holder se rollback fallisce, attende comunque il contendente prima di
rilasciarlo e copre acquisizioni parziali dei client. Non aggiunge diagnostica
o query periodiche al servizio AMR. Il cluster della prova è stato rimosso e i
container estranei sono rimasti invariati.

Review indipendente: corretto il cleanup del rollback fallito; rettificato il
significato della deadline dei poll. Dopo le correzioni, la prova PostgreSQL
18 completa referente/colleghi passa in 27,7 secondi, con contesa reale, ruoli,
quote, epoch, rollback e journal. Auth e worker sono sintetici in questa prova.

Fondamento: [PostgreSQL, pg_blocking_pids](https://www.postgresql.org/docs/18/functions-info.html)
e [node-postgres, pool e rilascio dei client](https://node-postgres.com/features/pooling).
La frequenza limitata è solo del test: la documentazione avverte che interrogare
il lock manager frequentemente può influire sulle prestazioni del database.

## Collaudo integrato — Contratto del retry nel runner

Superata la barriera di contesa, il runner invia ancora l'accettazione del
referente senza `operazione`. Il backend la rifiuta correttamente con 400:
è una fixture precedente a F2, non un nuovo difetto della route. Il runner
ora genera un UUID e lo conserva prima/dopo verifica email e nel retry;
richiede la conferma `giaEseguita` e rifiuta una nuova operazione sull'invito
consumato. Nessuna modifica al comportamento applicativo o al provider.

La controprova sul frammento reale del runner fallisce togliendo l'UUID.
La review indipendente rileva inoltre due asserzioni negative troppo larghe:
un 503 poteva passare per rifiuto della verifica email o dell'invito consumato.
Corrette con coppie status/codice esplicite; le controprove 503 ora falliscono.
Ripetuti 25 test mirati, tutti passati. La seconda review verifica nove scenari
VM, inclusi codici errati con 401/403, senza finding residui confermati.

Il collaudo Nhost Auth/PostgreSQL 18 passa già con l'UUID e il retry corretti:
login/MFA, isolamento, quote concorrenti, revoca in volo, rinnovi e accettazione
sono esercitati con provider e database reali locali, worker simulato. Questa
esecuzione precede le ultime asserzioni negative più strette. Il giro successivo
supera quelle asserzioni ma si ferma in una seconda barriera, quella della
quota aziende: `55P03` dopo 1.598 ms nel contendente; il monitor Docker non
osserva il lock. È lo stesso punto debole di sincronizzazione del test, senza
prova di un errore nelle quote. Il messaggio `HTTP 200` era una diagnosi della
fase Auth precedente, ora azzerata all'ingresso della fase SQL.

Correzione: tre client del pool già acquisiti prima di `BEGIN`; osservazione
della relazione `pg_blocking_pids` fra i due PID esatti e cleanup che attende
il contendente, scartando l'holder se rollback fallisce. Restano invariati
`lock_timeout`, rifiuto `quota_aziende` e asserzioni sul numero di aziende.
La prova VM usa il frammento verbatim e il vero adattatore; verifica successo,
lock assente, PID invertiti, rollback fallito e acquisizioni parziali. Gruppo
mirato aggiornato: 26 pass. Il controllo del modulo completo ha rilevato una
collisione di nome nella patch intermedia, corretta prima del collaudo.
La nuova esecuzione integrata si ferma prima, su un CHECK nell'accettazione
del referente, descritto sotto. Nessun conteggio di test sovrapposti.

Review indipendente della patch commerciale: nessun finding residuo; syntax,
diff check e sette test cleanup passano. Non è stata cronometrata la latenza
Docker nel singolo fallimento. La causa temporale è riprodotta nella prova
isolata precedente; qui sono verificati contesa terminata con `55P03` e
osservazione mancata, senza attribuire con certezza tutta la lentezza a Docker.

All'inizio della review l'ultima fixture legacy restava un rischio condizionato:
`pg_sleep(4)` e poll Docker potevano perdere la finestra, ma mancava un
fallimento reale. Le connessioni legacy non ereditavano il timeout di
1.500 ms del writerPool. La successiva prova strumentata riproduce il limite,
documentato qui sotto, senza attribuirlo a un errore delle quote.

## Ultima fixture di concorrenza — Finestra di osservazione

La prova Auth/PostgreSQL 18 strumentata supera login/MFA, lifecycle colleghi,
accettazione e retry del referente, rinnovi/revoche e nuova barriera della
quota commerciale. Si ferma infine su `attendiStato` del secondo contendente,
`collauda-nhost-locale.js:752`: sovrapposizione non dimostrata. Non è un PASS
del collaudo completo. Non compare `23514` né una NOTICE temporale; questo
non spiega il CHECK precedente. Cleanup concluso, otto container estranei
invariati. Ricevuta: `/private/tmp/amr-check-auth-finale-amKjwC/probe.log`.

Correzione della sola fixture: password PostgreSQL sintetica conservata nella
variabile già usata per generare il compose; pool amministrativo separato,
solo sulla porta loopback verificata del DB usa-e-getta. Tre client pronti
prima di `BEGIN`, primo invito in transazione, contendente bloccato e coppia
di PID osservata prima del commit. Nessun GRANT ai ruoli AMR, modifica di
funzioni o timeout applicativi. La seconda chiamata deve fallire esattamente
con `P0001` / `quota raggiunta`, non con un errore generico. Conservati un
invito, due membri, appartenenza univoca e ruolo senza permessi negato.
Il cleanup attende il contendente e chiude il pool anche con rollback o
acquisizione parziale falliti; il client holder difettoso viene scartato.

Prove VM sul frammento reale: successo, lock assente, PID invertiti, errore
diverso dalla quota, rollback fallito e tre acquisizioni parziali. Gruppo
mirato aggiornato: 32 pass, senza conteggi sommati ai 31 precedenti.
`test/nodi-quote-pg.test.js`, opt-in, esegue lo stesso frammento e la fixture
SQL originale su PostgreSQL 18 reale: PASS in 28,6 secondi. Verifica le quote
e ACL, respinge PID invertiti, chiude i client e preserva i container estranei.
Nel test l'adattatore SQL riproduce le connessioni separate di psql tramite
`RESET ROLE`; gestisce anche l'array dei risultati dei multi-statement di pg.
Le due controprove finali ora richiedono `23505` per l'appartenenza duplicata
e `42501` per il ruolo senza permessi, anziché accettare qualsiasi errore.
Ripetuta la prova PostgreSQL sull'ultima patch: 1 pass in 18,9 secondi;
ricevuta `/private/tmp/amr-quote-pg-strict-kACp6Q/risultato.tap`.
Ultimo gruppo automatico: 33 test, 32 pass e lo skip esplicito della prova PG
opt-in, che è stata eseguita separatamente. Nessun totale derivato sommando
esecuzioni sovrapposte.
Non è una nuova esecuzione dell'intero collaudo Auth con l'ultima patch.
Review indipendente finale della fixture e dei due test: nessun finding
residuo confermato. Il test PG18 usa `trust` soltanto nel container isolato:
prova lock, quote, ACL e cleanup, non l'autenticazione del nuovo pool tramite
password. La verifica Auth completa con l'ultima patch resta un gate aperto.

## CHECK intermittente — Diagnosi aperta

La nuova prova Auth/PostgreSQL si ferma nel ciclo delle aziende extra della
fixture colleghi: `aziende_accetta(uuid,text)`, SQLSTATE `23514`, 45 ms, riga
32 del corpo PL/pgSQL. Non è un timeout della barriera commerciale. Cleanup
concluso e gli otto container preesistenti restano identici. La sorgente
runner/test coincide con l'hash preso all'avvio.

Il precedente episodio in `aziende_attiva` è documentato nel registro M2,
sezione del gate immagine del 6 ottobre. In entrambi i casi una violazione
CHECK è verificata, la causa non è attribuita: mancano il nome del vincolo e
la relazione dei valori al momento del rifiuto. Non sono dimostrati clock
arretrato, NTP, contesa o difetto PostgreSQL. Nessun CHECK o funzione applicativa
viene modificato per ottenere un PASS.

La diagnostica locale ora include solo quattro nomi di vincolo da allowlist;
gli altri nomi e il detail restano omessi. Cinque test diagnostici passano,
anche con sentinelle in error/message/detail; gruppo complessivo mirato 31
pass. Preparato un esperimento temporaneo con due trigger della sola fixture:
NOTICE filtrate segnalano esclusivamente tre booleani di ordine/scadenza/stato,
senza cambiare `NEW`, chiamate al clock, CHECK, epoche o journal. È una prova
strumentata, non la certificazione di un artefatto non strumentato. Il parser
passa una prova positiva e cinque rifiuti di payload non previsti.

Il microprobe PostgreSQL 18 verifica i nomi effettivi: `aziende_prova_stato`,
`aziende_inviti_check`, `aziende_inviti_check1`, `aziende_inviti_check2`.
La allowlist usa confronti esatti, non un prefisso. Sei aggiornamenti invalidi
producono `23514` e la NOTICE prevista; due validi non producono NOTICE.
Funzioni invoker con EXECUTE limitato al ruolo della fixture; rollback lascia
i dati iniziali e il cleanup preserva gli otto container preesistenti.
Sono tabelle minime con le stesse espressioni CHECK, non l'intero lifecycle AMR.

Il primo tentativo strumentato si fermava prima del lifecycle per un errore
del wrapper temporaneo: `String.replace` interpretava `$$` nel testo sostitutivo.
Corretto usando un callback e verificando i byte dell'inserimento; nessuna
funzione SQL applicativa è stata cambiata. La prova delle NOTICE viene
completata sul database prima di ripetere il collaudo integrato.
Un campione locale di 2.500 letture dell'orologio non rileva salti all'indietro:
non prova né esclude la causa del precedente errore. Il trigger di attivazione
osserva ordine, scadenza e assenza dell'accettazione; non copre tutte le parti
di `aziende_prova_stato`. L'assenza della NOTICE non basta a chiudere la diagnosi.

Fondamento: [PostgreSQL, funzioni temporali](https://www.postgresql.org/docs/18/functions-datetime.html)
distingue tempo reale, inizio statement e inizio transazione; sostituirli senza
verificare scadenze e attese cambierebbe il contratto.
[PostgreSQL, campi degli errori](https://www.postgresql.org/docs/18/protocol-error-fields.html)
permette di identificare il vincolo senza pubblicare il dettaglio con i valori.

Review indipendente finale dei sei file: nessun finding residuo confermato.
Limite esplicito: `osservaPool` avvolge `pool.query`, non i `client.query`
della nuova barriera quota. Gli errori di quella barriera restano verificati
dalle asserzioni, ma non ricevono automaticamente la diagnostica SQLSTATE.
Il percorso `aziende_accetta` della fixture colleghi usa ancora `pool.query`
ed è coperto dall'osservatore. Non viene esteso il logging applicativo.

## Suite generale e limiti

Sul candidato applicativo `3c82b02`, Node 24.21.0: 1.547 test, 1.537 pass,
10 skip espliciti, zero fail/cancelled, durata 803 secondi. Ambiente pulito,
`no-dotenv-preload`, dati e log temporanei. Le modifiche successive riguardano
fixture, runner e registri; non sono una nuova esecuzione della suite completa.
La prova PostgreSQL 18 e il collaudo Auth locali sono verifiche distinte;
non trasformano i gate opzionali saltati in prove eseguite.

Non vengono attestati da questo incremento: nuova immagine AMR eseguita,
backup/restore remoto, ingress Nhost, SMTP reale, comportamento dei portali o
collegamento M2. Restano necessari anche i controlli manuali del frontend.

## Lavoro restante

Stato aggiornato nella [review dopo i fix](branch-nodi-2026-10-06-8cf9430.md),
compresa la nuova [protezione del registro ricerche](registro-ricerche-quote-2026-10-06.md).
I conteggi precedenti conservano il proprio candidato e non attestano il nuovo.

- Gate locale: completare la diagnosi del `23514` intermittente. Il collaudo
  Auth completo sull'ultimo runner è ora passato, come documentato nel
  [nuovo registro CHECK/Auth](branch-nodi-check-auth-2026-10-06.md);
  non identifica la causa del precedente CHECK.
- C2: rivalutare menu/dettagli nel collaudo staging; C3 costo idle noto.
- Ingress staging: diagnosi remota e aggiornamento conservano il proprio gate.
- M2: collegamento solo stato successivo al collaudo staging; produzione esclusa.

Gli altri file locali, compreso il lavoro APP, restano fuori dai commit AP.

## Collaudo manuale successivo

Prerequisito: ambiente con le undici migrazioni e il candidato corrispondente,
non lo staging precedente. Nessun test live automatico è autorizzato da questa
lista; evitare inviti o revoche di aziende reali.

1. Referente di prova: accettazione, nuovo login e solo moduli assegnati.
   Un'accettazione già conclusa non deve creare membership o journal aggiuntivi.
2. Due schede: login iniziato prima di revoca+rinnovo negato; login nuovo
   consentito dopo rinnovo. Logout deve invalidare le continuazioni pendenti.
3. Regione/filtri: modificare le scelte durante l'attesa del catalogo e
   cambiare account. Risposte del contesto precedente non devono riscriverle.
4. Tastiera e tecnologia assistiva: dopo revoca di un collega il focus resta
   utilizzabile; esito e conteggio della ricerca sono annunciati senza lettura
   della griglia intera o ripetizioni causate dal solo refresh diagnostico.

La sonda ingress e l'aggiornamento remoto restano gate distinti. Il pacchetto
`prepara-schema-staging.js` è solo per prima installazione: non va applicato
di nuovo al database esistente. L'aggiornamento richiede le tre nuove migrazioni
append-only, backup/restore e verifica dei ruoli, senza reimpostare utenti,
epoche o membership.
