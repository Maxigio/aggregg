# Correzioni successive alla review del candidato 6655950

Registro della lavorazione autorizzata il 3 ottobre 2026 sul branch
`feat/nodi-residenziali-prototipo`. Commit iniziale dei finding: `c34d361`.
Scope: centro, accessi, scheduler, backup e UI; nessun deploy, M2 o portale reale.
Le modifiche APP e i file preesistenti non tracciati restano separati.

## A02 — Autorizzazione Admin dopo il body

Risolto: entrambe le mutazioni dei nodi ricontrollano la sessione dopo il parser.
Prima: body incompleto, logout, completamento → revoca 200.
Ora: 401, zero scritture; una nuova sessione autorizzata esegue il comando.
Regressioni HTTP durabili per revoca token e sospensione. Review indipendente:
logout, revoca persona e scadenza durante il secondo await, più DELETE lavori;
nessuna mutazione dopo perdita dell'accesso.
Suite centro/protocollo e casi A02: 18/18. Nessun finding residuo confermato.

La verifica segue OWASP: autorizzare sul server ogni richiesta e prima della
mutazione; l'ordine rispetto al parser deriva dal nostro percorso riprodotto.
[OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## A01 — Disponibilità delle revoche

Budget separati: pubblico, letture per persona e mutazioni per persona, 30/min
ciascuno. La persona proviene dalla sessione server; il body non decide la chiave.
Massimo quattro operazioni attive per famiglia di rotte; massimo tre letture o
operazioni pubbliche, riservando un posto alle mutazioni. Conti RAM limitati a
201 chiavi (100 persone × due budget, più pubblico), scadenza 60 secondi.
Nessun timer o persistenza dei contatori; pulizia all'ingresso, nessuna espulsione
che azzeri i limiti delle persone ancora nella finestra.
Le autorizzazioni di ruolo, tenant, epoca e MFA rimangono nei handler e in SQL.

Review indipendente: trovato e corretto un flag pubblico mancante nella
consultazione inviti colleghi; regressione senza cookie aggiunta. I test verificano
trenta richieste anonime/letture seguite da revoca ammessa, indipendenza fra
persone, saturazione, scadenza e recupero degli slot solo al settlement.
I numeri sono limiti iniziali del prototipo, non una capacità di produzione
certificata da [OWASP API4](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/).

## S01/S02/S03 — Selezione e affinità dello scheduler

Risolti insieme perché condividono assegnazione e record del lavoro. A parità
di copertura il carico include coda e lavoro attivo; una pagina mantiene il suo
nodo sano, ma può usare un nodo idoneo se la fonte è in pausa. Affinità, avvisi
e esclusione dopo 429 usano l'esecutore effettivo del record centrale, verificato
da token/boot/epoca e settlement del job, senza fidarsi del body del worker.
Menu e dettagli rivalutano anche il carico dopo l'attesa dei permessi.

Review indipendente: trovato un nuovo 503 quando il precedente owner rientrava
durante i permessi. Regressione rossa e controprova verde sul codice intermedio;
corretto ricalcolando nodo, porzione e query insieme, sincronicamente prima della
coda, dai parametri originali. I cursori non sono ricostruiti dalla prima pagina.
Dodici regressioni, suite scheduler/centro/permessi **35/35**, seconda review
indipendente conclusa senza finding residui. Nessuna prova su portali reali;
il cambio nodo continua a dichiarare che la copertura può variare.

## U02 — Disponibilità persistente dell'invito

SQL distingue operazione confermata e invito ancora pending: retry identico e
recupero dopo reload possono riconsegnare il link soltanto prima della scadenza
e dell'accettazione. La copia RAM richiede anche azienda e attore corrispondenti;
viene eliminata quando il DB dichiara il token non disponibile. Nessun nuovo
invito o azienda è creato dal retry. Dopo riavvio la copia RAM rimane persa.

Nuove installazioni e patch `schema-inviti-consegna.sql` hanno la medesima
funzione; la patch è transazionale e non cambia dati, token o privilegi.
Prove SQL reali PostgreSQL 16 e HTTP **9/9**, incluso invito scaduto e accettato.
Review indipendente di route, UI e SQL senza finding confermati. Il link può
diventare obsoleto dopo la risposta se un'altra richiesta consuma l'invito:
il successivo lookup continua a negarlo; non si promette validità futura.

## U01/U03/U04 — Focus e stato della persona

I pulsanti sessione hanno identità stabile: il polling conserva il focus oppure
lo sposta al refresh disponibile se la voce scompare. Non ruba il focus spostato
dall'utente durante la richiesta. Perdita dei permessi non invoca `.focus()` su
`false`: sceglie un controllo effettivo ancora visibile.

Il draft, gli UUID di operazione e le mappe locali sono ripuliti al cambio o
alla perdita della persona verificata. Refresh della stessa persona e guasto
transitorio 503 conservano il draft; perdita di ruolo non equivale da sola a
cambio persona. Nessuna cancellazione delle operazioni confermate nel DB.
Sette regressioni inizialmente rosse; test browser headless con API loopback
simulate **13/13**, review indipendente senza finding. Il collaudo manuale
del proprietario sul frontend aggiornato non è ancora eseguito.

Riferimenti: [W3C focus order](https://www.w3.org/WAI/WCAG22/Understanding/focus-order.html)
e [MDN optional chaining](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Optional_chaining).
