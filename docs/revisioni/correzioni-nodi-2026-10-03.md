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

La suite completa ha individuato anche un'aspettativa legacy O01: imponeva
alla nuova ricerca il nodo A ancora occupato da un job abbandonato, anziché B
libero. Riprodotta isolatamente, poi aggiornata senza cambiare il runtime.
Il test continua a provare che il 429 tardivo di A non avvia recuperi, il nuovo
job ha ID distinto e nessuna operazione `fonte` viene creata per l'abbandonato.
Suite limiti/scheduler **33/33**, controprova indipendente O01 **3/3**.

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

## B02 — Capacità del piano di retention

Limiti confermati dal proprietario: **10.000 snapshot e 16 MiB** per il piano,
**1 MiB** per gli altri comandi. Conta i byte prima di decodificare UTF-8;
timeout e overflow scartano il buffer e ignorano i chunk successivi. Superata
la capacità, manutenzione fallita visibile, nessuna copia non validata eliminata.
Il cap limita l'output acquisito, non tutta la memoria di Node o restic.

Il piano completo è validato prima delle eliminazioni; ID, repository, categoria,
tempo e copia corrente conservata restano controllati. Batch di massimo 1.000
ID evitano un unico argv sproporzionato. Dodici regressioni rosse prima del fix;
suite con restic reale locale **31/31**, senza skip. Review indipendente senza
regressioni B02: ha confermato un difetto preesistente nel retry di `prune`,
affrontato nel passo successivo. Un batch riuscito non è annullato se fallisce
il successivo; la manutenzione non viene confermata come completata.

Confronto: [restic retention](https://restic.readthedocs.io/en/stable/060_forget.html).
I numeri scelti sono capacità iniziali, non garanzie universali della fonte.

## C01 — Contesto stabilito prima del login

Hardening del percorso API: senza cookie di contesto valido, il login risponde
401 prima del provider e non genera un altro contesto. `/me` e la pagina di
login restano il bootstrap. Il contesto collega i tentativi e il logout, non
autentica la persona. I client dei test e degli script seguono il bootstrap
HTTP reale, senza fabbricare header nella risposta del login.

Regressioni: contesto assente/malformato/duplicato, logout durante password e
MFA, rotazione e nuovo login. **56/56**, review indipendente e controprova
con cookie jar browser: nessun cookie tardivo, provider ripulito una sola volta,
nuovo accesso preservato. Provider sintetico; gate reale locale successivo.
Non era dimostrato un difetto della UI ordinaria, che aveva già il bootstrap.

## B03 — Retry della pulizia restic

Finding preesistente scoperto dalla review B02: `forget --prune` può rimuovere
gli snapshot prima che prune fallisca; il retry con remove vuoto saltava prune,
chiudeva pending e consentiva la pulizia SQL. Riprodotto anche sul commit
precedente B02, quindi distinto da una regressione introdotta dal cap.

Ora: check completo, forget degli ID approvati in batch, prune separato anche
con remove vuoto. Il pending SQL già esistente resta aperto fino al successo;
nessun nuovo schema o stato persistente. Due fallimenti mantengono avviso e
journal; il terzo successo chiude pending, poi pulisce. Review indipendente
ricontrollata anche ricreando il worker fra retry. **39/39 con restic reale**;
validazione, cap e dry-run preservati. Nessun finding residuo verificato.

Costo: check e prune possono essere onerosi anche senza nuove eliminazioni;
timeout restano espliciti, le rimozioni già riuscite non sono rollbackabili.
La separazione segue il contratto [restic forget/prune](https://restic.readthedocs.io/en/stable/060_forget.html),
non presume che un comando fallito abbia annullato ogni effetto.

## Verifica finale e prossimo gate

Commit separati per intervento, senza includere il lavoro parallelo APP:

| Commit | Intervento |
| --- | --- |
| `c34d361` | Registro dei finding iniziali |
| `8ef883e` | A02: sessione Admin dopo il body |
| `0f8441f` | A01: budget di lettura e mutazione |
| `84a4124` | S01/S02/S03: assegnazione e affinità effettive |
| `8bf8948` | U02: inviti ancora disponibili |
| `4e0d790` | U01/U03/U04: focus e draft per persona |
| `4d082c4` | B02: capacità della retention |
| `1af17e5` | C01: contesto prima del provider Auth |
| `a05d45a` | B03: prune completato prima della pulizia SQL |
| `4af66ba` | Aspettativa legacy O01 allineata allo scheduler |

Tutti i finding del candidato `6655950` trattati in questo incremento hanno
una correzione e prove circoscritte; B03 è il finding aggiuntivo confermato
dalla review indipendente. Le prove sono locali, non una certificazione del
servizio remoto o dell'intera integrazione APP.

- Suite completa sul commit `4af66ba`: **1.283 test, 1.279 pass, zero failure,
  quattro skip opt-in**. Dati e log temporanei, dotenv disabilitato, nessuna
  chiamata ai portali. Il runner Node usa concorrenza quattro.
- Gate separato restic reale: **39/39**, senza skip; validazione del piano,
  capacità, interruzione, retry di prune e pending fino al successo.
- Gate separato PostgreSQL 16/Auth/restic: **6/6**, senza skip; transazioni,
  lease/CAS e privilegi, restore in altro cluster, replay, riapertura e secondo
  restore, watermark e finalizzazione della sequenza.
- Gate completo Auth/PostgreSQL e immagine Linux: passato. Include quota
  concorrente e privilegi dei colleghi, invito pending/scaduto/accettato,
  login email/password e MFA reali locali, revoca in coda/in volo, HTTPS,
  ricerca Moto sintetica, sospensione/revoca nodo, SIGTERM e riavvio sullo
  stesso volume. Nessun risultato live o account reale nel collaudo.
- UI: prove headless simulate già registrate sopra; il collaudo manuale
  del proprietario sul frontend aggiornato rimane da eseguire.

Un primo giro del gate Auth/immagine si è fermato nella prova dell'ultimo
posto concorrente, `nodi-colleghi-pg.test.js:97`, prima di avviare l'immagine.
La diagnostica conserva il punto, ma non il valore stringa dell'asserzione:
non permette di distinguere con certezza un timeout da un'altra risposta.
Il giro successivo identico, senza il gate backup parallelo, ha completato
anche questa prova; non sono stati allargati timeout, quote o privilegi.
La causa del primo fallimento resta **non dimostrata**. Non lo si attribuisce
automaticamente al carico, né si deduce da un solo successo l'assenza di
instabilità della fixture. Il gate remoto dovrà confermare il comportamento
nella configurazione effettiva.

Artefatto locale: `amr-centro:staging-a05d45a`, release
`a05d45a61e659bb8d7a3fe93fadcc53d08d2cdab`, Linux amd64, utente `node`,
116.623.233 byte. ID Docker locale:
`sha256:dc4a0f424776aa171c7649b7d4a8d9fed8a4a972e65969689d80e5be97542daa`.
Impronta codice:
`c5a7870b798d3ceb4dc1390a0307f6ccca67d5a11d2af7d94a0f0270f8b6ce65`;
cataloghi:
`0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.
Il build context contiene esclusivamente blob committati; l'ID Docker locale
non è il digest del registry Nhost. Fra questa release e `4af66ba` cambiano
solo il registro e l'aspettativa legacy O01 del test, non l'inventario runtime.
La preparazione del manifest di `4af66ba` ha confermato le stesse impronte
codice/cataloghi, con un identificatore di release diverso.
Centro e worker remoti dovranno usare lo **stesso manifest di release**, anche
quando le impronte dei file non cambiano.

Log temporanei: `/private/tmp/amr-nodi-correzioni-full-finale-20261003.log`,
`/private/tmp/amr-prune-retry-after-real.log`,
`/private/tmp/amr-nodi-backup-pg-finale-20261003.log`,
`/private/tmp/amr-nodi-build-20261003.log`,
`/private/tmp/amr-nodi-image-gate-20261003.log` (giro interrotto),
`/private/tmp/amr-nodi-image-gate-counter-20261003.log` (gate completo).
Sono evidenze temporanee: scenari e risultati restano descritti qui e nelle
fixture durabili del repository.

Cleanup dei container automatici verificato; i due stack manuali preesistenti
sono rimasti attivi. Nessun push, upload del registry, modifica o avvio Run,
lettura di credenziali reali, collegamento M2 o traffico ai portali.

Prossimo passo: [gate staging Nhost](staging-nhost.md), con artefatto candidato
e configurazione reviewabili prima dell'attivazione remota. Restano separati
schema/ruoli e Auth/MFA/recovery Admin reali, SMTP, backup esterno e restore
SQLite, volume UID 1000, ingress/header/timeout 60 secondi, CPU/RAM e costi,
arresto e rollback senza due scheduler, integrazione completa APP. Nessuno
di questi controlli è sostituito dal solo `200` di `/healthz`.
