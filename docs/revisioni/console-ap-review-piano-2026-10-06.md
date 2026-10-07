# Console AP: review e ordine di lavoro — 6 ottobre 2026

## Baseline e confini

Branch `feat/nodi-residenziali-prototipo`, base `81e25ab`, HEAD esaminato
`3d9bc75`: 121 commit, 198 file, +33.416/−728 righe. La review riprende
[lo stato precedente](branch-nodi-2026-10-06-8cf9430.md), verifica i percorsi
che servono alla console e comprende due review indipendenti in sola lettura.
Non è una nuova lettura integrale di tutte le righe del branch.

Il [brainstorming](brainstorming-console-amr-ap.md), locale non tracciato,
fornisce requisiti e proposte: non prova comportamenti implementati e non
autorizza da solo cambi remoti, invii, configurazione di servizi o credenziali.
Il file originale e gli altri lavori locali sono preservati. Il frontend
non è stato modificato. Nessun deploy, accesso M2 o richiesta ai portali.

Decisione aggiornata in questa chat: la futura console, compresa la ricerca,
è riservata al proprietario. Non serve mantenere al suo interno il collaudo
del referente. Le API clienti e il lavoro APP restano distinti; non si
trasforma l'Admin in un cliente e non si impersonano persone o aziende.

## Stato verificato e gate aperti

- Coordinatore estratto, composizione pura centrale, protocollo ricerca
  POST/ID/GET, quote, affinità e autorizzazioni prima della consegna sono presenti.
  Retry e disconnessione incerta non autorizzano un replay automatico.
- Auth/PostgreSQL locale: il giro completo dell'ultimo runner precedente passa;
  le ricevute e il suo SHA sono nel [registro CHECK/Auth](branch-nodi-check-auth-2026-10-06.md).
  Non è un nuovo giro Auth cloud né un collaudo del nuovo frontend.
- La causa dei CHECK storici `23514` resta non dimostrata. Le funzioni attuali
  campionano il wall clock dopo i lock: la sola attesa del lock non ne spiega
  il rifiuto. Non rimuovere i CHECK o falsificare timestamp per far passare il test.
- Nuovo campione anonimo staging: tre GET, `/healthz` 200, `/` 403,
  `/api/admin` 401. Nessun body, login o dato personale acquisito. Il campione
  conferma l'ostacolo di accesso, non la sua causa né la frequenza intermittente.
  Non ampliare `trust proxy` per eliminare il sintomo senza un contratto provato.
- Backup cifrato staging e restore isolato già documentati: non equivalgono
  a storage gestito configurato o a un nuovo restore funzionale di Auth.
- M2 non collegato in questo incremento. Prima il gate staging, poi worker
  separato solo stato; prima del live, pause e ammissione sullo stesso IP devono
  essere coordinate anche con il servizio di produzione esistente.

## Difetti attuali confermati

### D1 — Un guasto diagnostico può impedire consegna e arresto del centro

`backend/nodi/centro.js:213–229, 250–284, 678–704, 970–983`:
`registra()` scrive SQLite senza protezione. Dopo un esito, il job è rimosso
dalla RAM prima della scrittura e della risoluzione della Promise. Un errore
diagnostico può quindi perdere un risultato già ricevuto; nei callback di
annullamento può uscire dal gestore e terminare il processo. In `close()`
può interrompere il cleanup dopo che `chiuso` è già impostato.

Prove indipendenti VM/SQLite con `FULL`: consegna 500, nuova consegna 409,
client 504; chiusura incompleta, intervalli e job residui. Controprove senza
guasto: consegna 200 e cleanup completo. Un errore sulla sola tabella eventi
non perde il risultato. Review indipendente: Node 24.19.0, SQL in memoria,
HTTP loopback, nessun filesystem o sistema remoto interessato.

Controprova principale su Node 24.21.0 e SQLite reale temporaneo: un trigger
`BEFORE INSERT ON lavori` provoca un errore sintetico. Il callback di abort
chiama `interrompiAccodati` → `registra`; Node termina con exit 1. Non è una
simulazione di disco realmente pieno, ma prova il percorso della stessa eccezione.

Correzione minima: rendere non fatali soltanto le scritture diagnostiche;
segnalare in RAM una raccolta incompleta senza log ricorsivi o ripetuti per ogni
evento; completare consegna, rifiuto e cleanup. Token revocati, sospensioni,
Auth e transazioni commerciali restano obbligatori: il guasto di quelle
scritture non viene assorbito come semplice errore di logging.

### D2 — La pulizia periodica può terminare il processo

`centro.js:93–101`: il timer esegue istruzioni SQLite senza catch.
Prova indipendente con `BUSY` e `FULL`: l'eccezione esce dal callback;
il processo figlio con `FULL` termina exit 1. Senza guasto termina exit 0;
rimossa la causa, la pulizia torna a riuscire. La pulizia deve segnalare il
fallimento senza abbattere il centro. Non si considera riuscita né si nasconde
una retention fallita.

## Condizioni e requisiti che non sono nuovi bug dimostrati

| Tema | Fatto e controprova | Conseguenza per il piano |
| --- | --- | --- |
| Proprietario e ricerca | `adminDiProva` usa `admin:true`; la ricerca richiede azienda valida, e SQL vieta all'Admin di diventare referente. Il comportamento attuale segue la vecchia decisione gestionale. | Definire una ricerca diagnostica autorizzata per il proprietario, senza cambiare le API clienti o bypassare limiti e permessi. Se in futuro ci saranno altri Admin, il booleano da solo non distingue il proprietario. |
| Sessioni | Il login elenca/revoca le proprie sessioni RAM; revocare un collega rimuove membership ed epoca. Non è un comando generico per scollegare un cliente. | Distinguere invalidazione sessioni, revoca account e revoca commerciale prima di esporre comandi. |
| Configurazione | Limiti nella closure; condivisione prima pagina senza revisione delle impostazioni. Il browser usa 75 s, il backend accetta fino a 300 s. Nello staging attuale il budget è 60 s. | Per impostazioni modificabili: snapshot all'ammissione, revisione nella condivisione, deadline comunicata; preservare i contatori del carico già ammesso. Il conflitto 75/300 è condizionato a una configurazione diversa da quella corrente. |
| Manutenzione | `avviati` descrive job attualmente consegnati, non la storia della ricerca; il recupero può accodare una fonte dopo la prima risposta. | Non svuotare tutte le code indistintamente. Distinguere ricerche mai consegnate da continuazioni già ammesse; persistere la manutenzione e il suo esito esplicito. |
| Restart AMR | Worker interrompe il lavoro su SIGTERM; un'epoca centrale cambiata lo arresta. Il launcher locale ferma i figli se uno esce. | Un processo non può verificare il proprio riavvio. Serve un responsabile esterno e un target AMR esplicito; nessun comando del sistema operativo o restart automatico implicito. |
| Release | Manifest include anche frontend/scripts, e confronta release e hash esatti. | Una modifica UI richiede inizialmente aggiornamento coordinato dei worker. Allentare il confronto senza un nuovo contratto sarebbe una regressione. |
| Retention | I cap attuali sono 10.000 righe; possono tagliare dati prima dei sette giorni. `DELETE` libera pagine SQLite riutilizzabili, non riduce necessariamente il file. | La prova indipendente in RAM passa da 738 pagine/729 libere a 9 dopo VACUUM: non prova saturazione reale. Decidere budget e completezza prima di cambiare cap o introdurre compattazione sul DB misto. |
| Notifiche | Il processo centrale fermo non può inviare il proprio allarme. openWA non è collegato o provato da questo documento. | Episodi correlati, invio confermato/incerto, fallback email ed osservatore esterno richiedono contratti e configurazione protetta; niente messaggi o nuovi servizi autonomi. |

## Ordine di lavoro e condizioni di completamento

1. **Affidabilità della diagnostica.** Correggere D1/D2, provare scrittura,
   timer, annullamento, consegna e cleanup con errori controllati. Esporre lo
   stato tecnico nelle API Admin; la nuova rappresentazione UI arriverà dopo.
   Verificare separatamente che le scritture operative continuino a fallire
   esplicitamente. Review indipendente del diff e commit dedicato.
2. **Contratti della console.** Concordare autorizzazione della ricerca owner,
   gestione sessioni e comandi; implementare manutenzione/configurazione con
   snapshot e persistenza. Prima di ogni scelta significativa, interview.
3. **Misure e risorse.** Fasi della prima ricerca misurate con clock monotono
   locale; distinguere trasporto stimato e latenza browser. Inventario di
   DB, pagine libere, WAL e output runtime; capacità, baseline del fattore tre
   e destinazione del backup diagnostico richiedono decisioni esplicite.
4. **Incidenti e notifiche.** Correlazione nodo/fonti e un episodio per guasto;
   prove simulate senza invii. Collegamento openWA/email, osservatore esterno
   e prove live solo nel perimetro concretamente autorizzato.
5. **Gate distribuito.** Diagnosi CHECK/ingress, artefatto e migrazioni append-only,
   aggiornamento/rollback staging e collaudo del candidato. Poi M2 solo stato;
   live dopo coordinamento pause e limiti. Non eseguire un deploy perché è
   semplicemente elencato in questo piano.
6. **Frontend owner.** Solo dopo i contratti verificati e le decisioni precedenti:
   console organizzata per operazioni reali, ricerca proprietario, prestazioni,
   incidenti e diagnostica incompleta. Nessuna pagina cliente duplicata. Prove
   automatiche, review indipendente, collaudo nel dev server dell'utente e commit.

Le dipendenze remote non impediscono i fix locali già autorizzati, ma non
possono essere dichiarate completate da una suite locale. Le nuove funzionalità
non sostituiscono il gate di produzione dell'app APP Auto/Moto.

## Ricevute nuove e fonti

Baseline principale: Node 24.21.0, dati/log temporanei, dotenv escluso,
HTTP(S) loopback. `nodi-centro`, `nodi-ricerche-http`, `nodi-pg-diagnostica`,
trasporto HTTP/HTTPS, sonda e ingress: **72 test, 71 pass, uno skip opt-in,
zero fail/cancelled**, `/private/tmp/amr-console-baseline-CJwjph/test.tap`.
Lo skip riguarda le attese reali di 55/65 s della sonda; non è una prova Nhost.

- [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html):
  protezione dei dati, correlazione, prove dei guasti di logging e risorse.
  È il fondamento del fail-soft diagnostico, non del fail-open autorizzativo.
- [Google SRE Monitoring](https://sre.google/workbook/monitoring/):
  distribuzioni, segmenti confrontabili e correlazione degli alert.
  Non prescrive la soglia AMR del triplo o una baseline specifica.
- [OpenTelemetry: context propagation](https://opentelemetry.io/docs/concepts/context-propagation/):
  correlazione fra processi; non impone SDK, collector o nuovi servizi.
- [PostgreSQL: clock](https://www.postgresql.org/docs/18/functions-datetime.html)
  e [campi degli errori](https://www.postgresql.org/docs/18/protocol-error-fields.html):
  limiti del wall clock e osservazione del vincolo senza esportare il detail.
- [Nhost Run networking](https://docs.nhost.io/products/run/networking):
  confini fra rete interna e porte pubbliche; la pagina non attesta un
  insieme stabile di IP proxy per la nostra allowlist.

Questi riferimenti sostengono le scelte; non provano da soli AMR o il provider.

## Incremento 1 — guasti della diagnostica

D1/D2 corretti nel backend. Le scritture di lavori/eventi, il riallineamento
della sola storia al boot e la pulizia sono best effort; i job e le risposte
restano governati dalle strutture in RAM. Il fallimento lascia uno stato
`diagnostica.incompleta` fino al termine del processo, con contatore limitato,
fase e istante dell'ultimo errore; nessun messaggio SQLite o dato arbitrario.
Una sola segnalazione stderr evita un log per ogni tentativo fallito.

Lo stato è incluso nelle risposte Admin/stato/export. La rotta
`GET /api/admin/diagnostica` espone lo stato RAM anche se le tabelle diagnostiche
non sono più leggibili. L'incremento 3 aggiunge misure opzionali di risorse:
un fallimento di queste letture non impedisce la risposta con lo stato RAM.
Usa il guard Admin esistente, che nel centro Run richiede sessione, MFA ed
epoca valide. La rappresentazione nel nuovo frontend è ancora da realizzare.
Il warning RAM non è una nuova persistenza: dopo un restart non può ricostruire
automaticamente tutte le lacune avvenute quando il registro non scriveva.

Inizializzazione dello store, sospensioni, token, Auth e transazioni commerciali
non sono trasformati in operazioni facoltative. Retention, cap e compattazione
non sono cambiati. L'export diagnostico resta un download, non un backup server
che promette di cancellare il file scaricato dal computer del proprietario.

Prove principali Node 24.21.0, SQLite reale temporaneo, `query_only` e trigger
locali, dotenv escluso e HTTP loopback:

- Cinque regressioni nuove: risultato consegnato e job liberato con registro
  non scrivibile; pulizia fallita senza eccezione dal timer e successivo recupero;
  abort/close con job attivo, DB e intervalli chiusi; tabella illeggibile ma
  stato RAM accessibile; errore eventi con una sola segnalazione, senza assorbire
  i rifiuti delle scritture operative.
  `/private/tmp/amr-console-fix-vfT8so/test.tap`: **5/5 pass**.
- Gate pertinente centro, quote, budget, autorizzazione asincrona, body,
  Run, poll, protocollo e affinità:
  `/private/tmp/amr-console-gate-jsKrAr/test.tap`: **128/128 pass**, zero skip.
- Guard del nuovo endpoint: anonimo 401, referente 403, Admin con MFA 200,
  logout seguito da 401; insieme alle controprove di body tardivo e sessioni.
  `/private/tmp/amr-console-admin-jBc9lX/test.tap`: **4/4 pass**.
  I gruppi si sovrappongono e non vengono sommati.
- Ultime versioni delle due regressioni nuove/mirate, dopo la revisione dei test:
  `/private/tmp/amr-console-diagnostica-finale-fm8GKM/test.tap`: **9/9 pass**.

Review indipendente in sola lettura del diff: nessun nuovo finding bloccante;
catch limitati alla diagnostica e guard dell'endpoint preservati. La review
non ha rieseguito questi gruppi di test e non è sommata alle loro ricevute.

Non è un riempimento del disco reale, una suite completa o una nuova prova
cloud. Il frontend non è stato modificato; non sono stati inviati messaggi,
collegati nodi M2, eseguiti deploy o richieste ai portali.

## Incremento 2 — sospensioni coerenti con la persistenza

Nuovo finding D3, P2, preesistente: il comando di sospensione mutava RAM prima
della conferma SQL. Controprova principale su SQLite reale temporaneo: blocco
200, ripresa con DB in sola lettura 500, nodo già riabilitato in RAM ma riga
di sospensione ancora presente. Review indipendente: in quel caso un poll
poteva consegnare un job. Il rifiuto HTTP, da solo, non provava fail-closed.

Correzione: confermare prima la scrittura, poi aggiornare RAM e coda senza
`await` fra le due operazioni. Un rifiuto mantiene lo stato in memoria e la
coda precedenti; niente successo fittizio. Sospensione e revoca token
restituiscono 503 con `controllo_nodo_non_confermato`, senza stack SQL.
La revoca token aveva già l'ordine corretto; è allineata solo la risposta
di errore. In caso di I/O non si promette una certezza del contenuto durevole
dedotta dal solo errore: il comando non è confermato e richiede verifica.

Controprove: ripresa globale e per fonte rifiutata con RAM/DB ancora sospesi,
poll senza consegna, successiva ripresa riuscita; sospensione rifiutata di un
nodo disponibile senza perdita della coda. I guard Admin/MFA, trasporto e
ricontrollo dopo il body sono preservati.

Ricevuta Node 24.21.0, SQLite/HTTP loopback, dotenv escluso:
`/private/tmp/amr-console-controlli-MfXmOQ/test.tap`: **30/30 pass**, zero skip,
comprendendo le regressioni diagnostiche, il centro, i guard, poll e boot.
Review indipendente del diff: nessun nuovo finding bloccante; test ispezionati
e non rieseguiti dal reviewer. Nessun frontend o stato remoto modificato.

## Decisioni confermate il 6 ottobre

- Confine della manutenzione: lasciare completare l'intera ricerca
  dopo la prima consegna al worker, compresi i recuperi previsti. Richieste mai
  consegnate interrotte e nuovi avvii negati. Approvato esplicitamente dall'utente.
- Ricerca owner: verificare l'ID Nhost del proprietario oltre a
  Admin/MFA e di usare un contesto diagnostico separato dai clienti, preservando
  i limiti globali. Non creare un'azienda commerciale né mutare la sessione.
  Approvato esplicitamente dall'utente. La semplice sostituzione del guard commerciale con `admin:true` romperebbe
  ownership degli ID e cataloghi; il riuso deve coprire anche questi chiamanti.

## Scelte per incrementi successivi
- Capacità/completezza dei sette giorni, destinazione del backup diagnostico,
  baseline prestazioni, policy delle sonde e integrazione notifiche restano
  scelte da affrontare nei rispettivi incrementi.

## Incremento 3 — misure del registro, senza manutenzione implicita

`backend/nodi/diagnostica-risorse.js` aggiunge un campione alla rotta Admin
diagnostica: byte del database e degli eventuali WAL/SHM/journal; modalità,
pagine allocate e pagine riutilizzabili SQLite; spazio disponibile e totale
del filesystem. Sono grandezze diverse, non un limite già concordato o una
misura dello spazio usato esclusivamente da AMR. Il campione non è atomico
rispetto a scrittori esterni e non attribuisce tutta l'occupazione ad AMR.

File ausiliari assenti sono dichiarati assenti. Errori e misure non attendibili
diventano `null` con stato `parziale`, senza esportare percorsi o messaggi grezzi.
File non regolari o non verificabili impediscono anche i PRAGMA: una lettura
SQLite può accedere ai journal. La prima prova con un WAL simbolico falliva;
la correzione è controprovata con zero interrogazioni e target immutato.
Il controllo non promette protezione assoluta da sostituzioni concorrenti dei
file da parte di un processo locale con accesso alla directory.

L'endpoint conserva gli stessi guard Admin/MFA; non modifica contatori o stato
del logging. Nessun cambio di retention, soglie, journal mode, VACUUM, backup
o frontend. Una misura parziale non viene confusa con una lacuna già registrata
dal logging: i due stati restano distinti.

Inventario dei punti di scrittura esaminati, da completare nel gate operativo:

| Risorsa | Responsabile e limite della verifica |
| --- | --- |
| `lavori-prototipo.db` e ausiliari | Il centro scrive storia ed eventi, ma anche sospensioni e token revocati. Le misure coprono questo store; una pulizia indiscriminata distruggerebbe stato operativo. |
| `amr-fonti.db` e WAL del worker | `fonti-salute.js` conserva stato delle fonti. È distinto dalla storia centrale; nessun campione sul worker reale o M2 in questo incremento. |
| stdout/stderr centro e worker | Il centro emette messaggi fissi di avvio/errore; gli scraper possono emettere warning. I launcher esaminati ereditano le pipe o le scartano. Retention del runtime/provider e file aperti restano da verificare sull'ambiente distribuito. |
| PostgreSQL e journal commerciale | Accessi, aziende, operazioni e outbox backup hanno contratti separati. Non sono log da cancellare dopo sette giorni; questa API non misura il database remoto. |
| Export e copie temporanee | L'export diagnostico HTTP è un download; i backup staging usano directory private temporanee con cleanup. Le copie cifrate deliberate sono una risorsa distinta. Il download del browser non è gestibile dal server. |

Ricevuta principale Node 24.21.0, file SQLite temporanei e HTTP loopback,
dotenv escluso: `/private/tmp/amr-console-risorse-finale-SByWzy/test.tap`,
**32/32 pass**, zero skip; comprende misure, guasti, guard e centro.
Prova di lettura: hash del DB invariato; DELETE aumenta le pagine libere
senza ridurre il file; errori SQL/FS e valori fuori precisione restano parziali.
Gate aggiuntivo di avvio Run e compatibilità locale:
`/private/tmp/amr-console-risorse-run-bN0W0C/test.tap`, **52/52 pass**, zero skip.

Review indipendente in sola lettura: nessun nuovo finding confermato.
Controprove aggiuntive su Node 24.19.0 con SQLite in RAM e FS simulato,
12 scenari e guard HTTP con zero misure prima dell'autorizzazione.
Non è la suite completa, un WAL operativo sotto carico o la misura dello staging.

Fonti verificate: [SQLite PRAGMA](https://www.sqlite.org/pragma.html) per pagine
e modalità; [SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html) per la
differenza fra riuso delle pagine e riduzione del file. VACUUM può richiedere
spazio aggiuntivo e fallire con attività concorrente: non è stato introdotto
come rimedio automatico. Capacità e completezza dei sette giorni restano da
decidere prima di cambiare cap o compattazione.

## Incremento 4 — letture diagnostiche e logger finale Express

Nuovo finding D4, P2, confermato: con una tabella diagnostica illeggibile,
le letture di `/api/stato`, `/api/admin` e `/api/admin/esporta` arrivavano
al gestore finale Express. Anche in ambiente production lo stack era
registrato su stderr per ogni richiesta. Il primo fix limitava gli errori
di scrittura, non questo percorso. La crescita su disco resta condizionata
alla cattura e rotazione delle pipe; non è stato riempito un disco reale.

Prova prima della correzione: Node 24.21.0, SQLite temporaneo con tabella
`lavori` rimossa, ambiente Express production e console intercettata.
`/private/tmp/amr-console-letture-prima-GRAZ21/test.tap`: il caso fallisce
perché lo stack SQL viene effettivamente registrato. Nessun errore sensibile
è stampato nella ricevuta.

Correzione circoscritta: i tre endpoint e la pulizia manuale rispondono 503
con `diagnostica_non_disponibile` e stato RAM quando il registro fallisce.
Nessun risultato vuoto inventato, export fittizio o cancellazione confermata.
L'header di download viene rimosso sull'errore. La segnalazione usa lo stesso
contatore e warning unico del logging; Auth, sospensioni e token non sono
assorbiti da un handler generico. Il contratto delle risposte riuscite resta
invariato. Questo non elimina tutti i log del runtime o del resto dell'app.

Prove dopo: quattro letture rifiutate senza stack aggiuntivi, un solo warning,
stato incompleto consultabile; cancellazione manuale rifiutata con righe
ancora presenti, poi riuscita una volta riabilitata la scrittura. Gate
principale diagnostica, risorse, guard e centro:
`/private/tmp/amr-console-letture-dopo-kHGEhW/test.tap`, **34/34 pass**.
Parser/body e avvio Run:
`/private/tmp/amr-console-letture-gate-qMOe33/test.tap`, **11/11 pass**.
Tutto su Node 24.21.0, dotenv escluso, SQLite/HTTP locali; nessuna prova cloud.

Confronto aggiornato con [Express: error handling](https://expressjs.com/en/guide/error-handling/)
e [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
Il comportamento stderr è verificato anche nel codice delle dipendenze
installate; la sola assenza dello stack nella risposta production non prova
che il runtime non lo registri.

Review indipendente in sola lettura del diff finale e delle ricevute:
nessun nuovo finding né blocco al commit nel perimetro verificato.
Auth e controlli operativi restano fuori dal catch; il reviewer non ha
rieseguito le due suite principali.

## Incremento 5 — manutenzione globale delle ricerche

Decisione approvata: una ricerca inizia alla prima consegna al worker, non
al POST del browser né all'inserimento in coda. La manutenzione nega nuovi ID
e nuove pagine, interrompe le operazioni mai consegnate e lascia terminare
l'intera operazione già iniziata, inclusi recuperi e failover. Le pause della
fonte e le sospensioni dei nodi conservano i propri vincoli: la manutenzione
non le rimuove e non prolunga la deadline di 60 secondi.

`GET/POST /api/admin/manutenzione`, con i guard Admin/MFA e Origin esistenti,
espone e modifica il controllo persistito in `controlli_centro`. Il comando
ricontrolla la sessione dopo la lettura del body. Una scrittura rifiutata
restituisce 503 `manutenzione_non_confermata` senza cambiare RAM o coda.
Il riavvio conserva la manutenzione; la disattivazione non resuscita lavori.
Il backup del volume copia l'intero SQLite: la nuova tabella vi rientra,
ma non è stato eseguito un nuovo backup remoto o un rollback dello staging.

Il parent conserva la prima consegna anche quando non ha job attivi fra due
passaggi. Il controllo copre coordinatori non condivisi, verifiche ancora
pendenti, accodamento e poll. I POST ripetuti dello stesso ID e le consultazioni
restano disponibili e non producono un'altra chiamata. L'esito delle operazioni
interrotte è `ricerca_manutenzione`, senza annunci né falsa incertezza.
Menu e dettagli restano al contratto precedente: questo controllo riguarda
le ricerche, non spegne il centro o la diagnostica e non aggiunge sonde automatiche.

Ricevuta Node 24.21.0, HTTP/SQLite temporanei, dotenv escluso:
`/private/tmp/amr-manutenzione-chiusura-c40IeK/test.tap`: **67/67 pass**, zero skip.
Prove: mancata consegna, failover dopo 429, permessi lenti prima del POST e
durante poll/accodamento, errore SQL, riavvio, retry dello stesso ID, logout
durante body Admin e gate preesistente di scheduler/Run/diagnostica.

La review indipendente ha riprodotto un P2 non coperto dalla prima ricevuta:
un ID già accettato 202, ma ancora nella verifica precedente al coordinatore,
poteva partire dopo ON/OFF. Corretto interrompendo anche i budget degli ID
mai consegnati e conservando l'epoca della loro ammissione. Il controtest
verifica l'esito interrotto mentre il provider è ancora in attesa, il mancato
replay dopo OFF e l'ammissione di un nuovo ID dopo la riapertura.

Riferimenti: [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
per autorizzazione su ogni richiesta e deny-by-default;
[Google SRE: Handling Overload](https://sre.google/sre-book/handling-overload/)
per ammissione e limiti. Il confine dell'intera ricerca è una decisione di
prodotto verificata dal test, non una prescrizione di quelle fonti.
Nessuna modifica frontend, deploy, portale live o collegamento M2.

Review finale indipendente dei cinque file nell'indice Git: P2 chiuso, nessun
altro finding confermato. Tre controprove sul codice staged, Node 24.19 con
SQLite in RAM/HTTP: 202 interrotto prima del ritorno del provider e non
rilanciato dopo ON/OFF; ricerca condivisa già iniziata con failover 200;
UPDATE SQLite rifiutato senza cambiare ammissione o stato persistente.
La ricevuta principale resta quella Node 24.21.0 citata sopra.

## Incremento 6 — ricerca diagnostica personale, API senza impersonazione

L'utente ha approvato ID Nhost personale + Admin/MFA, separato dalle aziende.
`backend/nodi/ricerca-proprietario.js` verifica l'identità corrente tramite
lo stesso provider (`admin:true`, senza attivare il requisito commerciale del
parametro `tipo`), confronta la persona restituita con la configurazione e
ammette soltanto Auto/Moto. Errori del provider negano l'accesso senza
trasmetterne messaggi grezzi. Nessuna modifica alla sessione originale né
inserimento in aziende/membri commerciali.

Contratti preparati, ancora senza frontend:

- `POST /api/admin/ricerche`: avvio con ID, GET/DELETE sul relativo ID;
- `/api/admin/ricerca/filtri`, `/brands`, `/models`, `/versioni`, `/detail`:
  stessi handler del percorso clienti, con verificatore personale prima
  dell'accodamento, al poll e alla consegna;
- il risultato mantiene formato, cataloghi, filtri e scraper esistenti.
  L'ID appartiene alla sessione originale e al suo contesto; il ruolo corrente
  viene verificato anche alla rilettura di un risultato concluso.

Un'unica istanza del registry e dei limiter conserva cap globale, quote per
persona, 50/100 ID, deadline e TTL. I due ingressi non raddoppiano RAM o posti.
Le prime pagine dei clienti continuano a condividere il lavoro identico fra
loro; quelle personali hanno un contesto distinto. Il campo tecnico `azienda`
del job contiene `diagnostica:<UUID>`, trasmesso a `_cacheScope`: non è una
licenza o una riga commerciale. Affinità/cursori restano separati. Le firme
dei dettagli includono anche il contesto, impedendo l'attraversamento fra i
due ingressi perfino quando una sessione è autorizzata su entrambi.

Configurazione opzionale `AMR_CENTRO_PROPRIETARIO_ID`: se assente l'ingresso
personale resta negato; un valore malformato impedisce l'avvio. Il pacchetto
staging accetta soltanto il riferimento `{{ secrets.AMR_CENTRO_PROPRIETARIO_ID }}`,
lo preserva in aggiornamento e rollback e valida con UUID sintetico senza
risolverlo. Nessun identificatore reale letto, richiesto in chat o configurato
remotamente. Prima dell'attivazione servirà inserirlo nell'ambiente autorizzato.

Debunking progettuale indipendente: ownership, chiavi di condivisione e
verificatori hardcoded impedivano una semplice sostituzione del guard con
`admin:true`. Tutti e tre i passaggi sono stati adattati. Il rischio condizionato
di attraversamento delle firme nella stessa sessione è coperto dal contesto
firmato. Questo non cambia le autorizzazioni commerciali delle API clienti.

Ricevuta del gate esteso, Node 24.21.0, SQLite/HTTP locali e provider simulato,
dotenv escluso: `/private/tmp/amr-proprietario-gate-Z2rmhm/test.tap`,
**164 pass, 2 skip**, zero fail/cancelled. Gate finale degli endpoint, quote,
firme, login/logout, avvio Run e pacchetto:
`/private/tmp/amr-proprietario-finali-vWVIf4/test.tap`, **79 pass, 2 skip**.
Gli skip sono i gate opt-in del pacchetto sul vero HEAD e della CLI Nhost:
non dimostrano build o deploy del nuovo candidato.

Prove e controprove: Admin senza azienda autorizzato solo sul nuovo percorso;
cliente, altro Admin, MFA assente e revoca negati; ID/DELETE/retry isolati per
sessione e contesto; RAM/ID/TTL condivisi; cap personale e globale condivisi
anche con l'ingresso clienti; stessi menu/dettagli; firme non trasferibili;
failover 429 e pagina successiva con stessi cursori e affinità. Login/MFA
sono il modulo reale AMR con provider sintetico, non un login Nhost remoto.

Riferimento: [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
per least privilege, controllo su ogni richiesta e proprietà delle risorse.
L'ID personale configurato è un vincolo aggiuntivo, non una credenziale e non
sostituisce sessione, ruolo attuale o MFA. Nessuna nuova dipendenza, richiesta
ai portali, modifica frontend, deploy o connessione M2.

Review finale indipendente rispetto a `b270694`: nessun finding confermato.
33/33 prove mirate su Node 26.4.0, inclusi controtest temporanei senza modifiche:
revoca dopo il primario impedisce il recupero; recupero autorizzato mantiene
lo scope; revoca dopo il poll impedisce la consegna di cataloghi/dettagli;
ID e firme non attraversano contesti/sessioni. Il reviewer ha letto la
ricevuta Node 24.21.0 del gate esteso; Node 26 non sostituisce tale gate.

### Prossimo confine operativo

Manutenzione e ricerca personale sono contratti backend implementati e
verificati localmente. La console attuale non li usa ancora. Prima della UI:
preparare il candidato e il backup ripristinabile, chiudere ingress/login/MFA
e compatibilità nello staging, poi collegare M2 **solo stato** con processo
isolato. Le prove live M2 richiedono ancora pause e limiti coordinati con la
produzione dello stesso IP. Il solo routing simulato non chiude questo gate.
Capacità diagnostica, storage e policy delle sonde/notifiche restano incrementi
distinti; nessuna delle due nuove funzioni autorizza un deploy implicito.

## Incremento 7 — evidenza del taglio della storia

Decisioni esplicite dell'utente: conservare i cap attuali di 10.000 lavori
e 10.000 eventi; segnalare i tagli che accorciano la finestra di sette giorni.
Backup diagnostico mediante download manuale, con conservazione gestita
dall'utente. AMR non può cancellare dal suo computer il file già scaricato.
La decisione non riguarda backup e journal commerciali.

`backend/nodi/diagnostica-retention.js` applica la stessa retention e gli
stessi cap precedenti, preservando l'eccezione per i lavori ancora attivi.
Il taglio del cap e la sua evidenza aggregata vengono confermati nella
stessa transazione SQLite. I metadati persistono al riavvio e spariscono
quando il taglio non riguarda più la finestra dei sette giorni.
La cancellazione ordinaria di record scaduti non è una troncatura anticipata.
Nessun annuncio, filtro o identificativo personale è aggiunto a questi metadati.

Le API diagnostiche Admin e il download JSON espongono
`diagnostica.storia`: cap, durata, `troncata`, istanti e numero di righe
dell'ultimo taglio per area. `troncata:false` significa che non risulta
un taglio osservato ancora nella finestra; non certifica la completezza
della storia precedente all'aggiornamento o di raccolte fallite.
Se la prima lettura dei metadati non riesce, `conosciuta:false` e
`troncata:null` dichiarano lo stato sconosciuto.
Il frontend non è modificato in questo incremento: l'avviso visivo rientra
nella console owner dopo il gate distribuito. Nessun file di backup viene
creato automaticamente dal nuovo codice.

Guasti di lettura/scrittura restano segnalati dalla diagnostica fail-soft;
un errore nel registrare il taglio fa rollback della cancellazione. Non si
assorbono errori dei controlli operativi o delle autorizzazioni. Non viene
eseguito VACUUM: il cap logico non promette la riduzione del file sul disco.

Ricevuta Node 24.21.0, SQLite temporaneo/HTTP loopback, dotenv reale escluso:
`/private/tmp/amr-retention-review-7ntFfw/test.tap`: **57/57 pass**, zero skip.
Prove: entrambi i cap, restart, scadenza, guasto sul secondo taglio dopo
il primo, DB in sola lettura, stati attivi, Admin/export e nessun nuovo file.
Include le regressioni dei guasti diagnostici, i guard Admin e la manutenzione.
Il precedente giro 35/35 è sovrapposto e non viene sommato.

La review indipendente ha riprodotto due regressioni: creazione della nuova
tabella fuori dalla protezione diagnostica (`SQLITE_FULL`), e taglio già
persistito nascosto al riavvio quando la pulizia fallisce. Correzioni:
costruttore senza SQL; preparazione dentro `pulisci`, protetto dal centro;
lettura dei metadati confermati prima della transazione di pulizia.
Due regressioni dedicate provano guasto iniziale e restart con pulizia
rifiutata. I test non simulano la saturazione del filesystem vivo.
Seconda review indipendente: stessa controprova del centro in VM con
SQLite reale in RAM e `SQLITE_FULL`, ora avvio riuscito con stato sconosciuto
e recupero nello stesso processo. Confermati restart, rollback su secondo
taglio, stati attivi e scadenza; nessun nuovo finding confermato.
Il test dedicato al restart è stato poi semplificato senza alterarne il caso
(riga scaduta inserita direttamente, nessuna modifica del clock).

Fondamento: [SQLite transactions](https://www.sqlite.org/lang_transaction.html)
per atomicità e rollback; [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
per risorse, retention e comportamento in caso di guasto. Nessun dato vivo
o filesystem riempito artificialmente, nessun deploy o collegamento M2.

## Avanzamento del gate staging — 7 ottobre

L'utente autorizza staging e M2 solo stato con il CHECK storico aperto,
senza autorizzare la produzione. Il [registro del gate](staging-build-permessi-2026-10-07.md)
documenta il difetto di permessi dell'immagine, la correzione nel commit
e90b88a, la review indipendente, il PASS Auth/PostgreSQL/HTTPS locale e
le prove delle migrazioni append-only e della recovery del launcher M2.

Il candidato e90b88a è ora materializzato dai blob Git e costruito localmente
per linux/amd64 senza overlay; nuovo manifest e costruttore sono verificati.
Resta da scegliere la lista esplicita provvisoria dei proxy dello staging,
aggiornare il backup prima della manutenzione e verificare il candidato
nello staging remoto. Solo dopo: M2 isolato per stato e compatibilità,
arresto/riconnessione e marker di produzione invariati. Nessun M2 collegato
né frontend modificato in questo incremento. L'avviso visivo sulla storia
incompleta e il brainstorming della console restano nel gate frontend.

## 7 ottobre — decisione proxy applicata e ordine successivo

Il proprietario approva l'aggiunta del peer osservato solo nello staging.
Applicata come append al riferimento esistente, senza leggere o modificare
il segreto: [prove e limiti](staging-proxy-aggiunta-2026-10-07.md).
Readback esatto, servizio ready e 16/16 controlli ingress anonimi PASS;
nessun nuovo candidato distribuito né M2 collegato. La decisione proxy è chiusa
per questo collaudo provvisorio; il contratto ingress produzione resta aperto.

L'ordine richiesto è 2–7 con interview e commit per punto, CHECK storico,
collaudo remoto del candidato/collegamento M2, review del branch e correzioni,
poi 8 frontend. Il vecchio via a procedere con CHECK aperto non equivale a
chiusura del finding: prima della console il proprietario chiede di affrontarlo.

## 7 ottobre — punto 2: sonde automatiche implementate e verificate localmente

Policy concordata: avvio alla scadenza anche senza ricerche, una sonda Auto
Alfa Romeo/Giulietta/Veloce per Subito e AutoScout24, una Moto
Fantic/Caballero 500/Rally per Moto.it; risposta valida sufficiente anche
vuota, pause attuali e `Retry-After`, massimo cinque prove persistenti,
poi intervento. Auth/formato incompatibile richiedono intervento immediato.

Il centro accoda un lavoro interno al primo heartbeat idoneo del worker
libero. Sospensioni e manutenzione lo impediscono; simulato e `soloStato`
sono esclusi. Il monolite conserva il comportamento precedente. Una pagina
senza recuperi/cache, nessun archivio di annunci, nessun failover delle sonde.
Il frontend attuale espone solo gli stati/eventi necessari a questo incremento;
il redesign del punto 8 non è iniziato.

Corretti e controverificati annullamento tardivo, falsa classificazione degli
errori GraphQL, successo dichiarato nonostante un blocco concorrente ed
esaurimento alla quinta prova invalidata. Review indipendente finale senza
altri finding confermati. Gate pertinente Node 24.21.0: **486/486 pass**,
39 file, zero skip/cancelled/fail; UI headless mirata **2/2 pass**.
Prove, percorso e limiti nel [registro dedicato](sonde-fonti-2026-10-07.md).

Nessun nuovo candidato distribuito, portale live o M2 collegato. Il punto 2
è chiuso per implementazione e collaudo locale; quello remoto resta al gate
concordato. Il prossimo punto è l'interview sui restart automatici dei worker.
Restano nell'ordine 3–7, CHECK storico, gate remoto/M2, review e punto 8.

## 7 ottobre — punto 3: restart limitati dei worker

Policy approvata: crash e problemi temporanei possono riavviare il worker;
stop manuale, revoca e incompatibilità richiedono intervento. Cinque restart
con backoff e jitter, poi stop. Il supervisor esterno riusa i launcher
esistenti e non riavvia il centro o ripete lavori incerti. Budget azzerato
solo dopo cinque minuti di heartbeat stabili; un nuovo avvio manuale del
supervisor apre un nuovo ciclo. Nessun supervisor di sistema installato.

Stato tecnico locale atomico e ultimo stato persistito nel centro;
Admin esistente mostra restart e intervento. Epoca, boot, sequenza e
credenziale proteggono la consegna diagnostica. Con centro irraggiungibile
non promettiamo la consegna dell'avviso: il registro locale resta la ricevuta.

Corretti e controverificati perdita delle sospensioni nella race di startup,
falso successo del launcher in caso di guasto I/O, cleanup IPC, compatibilità
dei nodi legacy e classificazione del risultato scaduto. Review indipendente
finale PASS nel perimetro, gate pertinente Node 24.21.0 **515/515 pass**,
44 file; UI headless **2/2 pass**. Prove e limiti nel
[registro dedicato](restart-worker-2026-10-07.md).

Punto 3 chiuso per codice e collaudo locale. Nessun deploy, portale live o
M2 collegato. Prossimo punto: interview sulla policy delle notifiche (4),
poi 5–7, CHECK storico, gate remoto/M2, review e soltanto dopo punto 8.

## 7 ottobre — stato dopo i collaudi storage

I collaudi R2 di byte, PostgreSQL e recovery senza source sono registrati
in [storage R2/recovery](storage-r2-recovery-2026-10-07.md). La discovery
delle copie disponibili è provata anche dopo lo spegnimento del database
sintetico; backup vivi, completezza del punto di recovery e custodia della
chiave non sono ancora chiusi. Nessun collegamento di staging o M2.

Prima del frontend restano: configurazione/consegna Better Stack (4),
baseline prestazioni (5), intervalli e comandi delle soglie (6), gate
operativo backup (7), diagnosi CHECK, collaudo remoto del candidato e M2,
review del branch. Decisioni e prove mancanti sono elencate nel registro
recovery, senza interpretare provider acquistati o test locali come gate
di produzione. Il brainstorming del punto 8 resta da implementare dopo
questi passaggi, uno alla volta.
