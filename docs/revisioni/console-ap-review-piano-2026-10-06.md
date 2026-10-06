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

## Interview ancora aperte

- Confine della manutenzione: proposta di lasciare completare l'intera ricerca
  dopo la prima consegna al worker, compresi i recuperi previsti. Richieste mai
  consegnate interrotte e nuovi avvii negati. Non implementata in attesa di risposta.
- Ricerca owner: proposta di verificare l'ID Nhost del proprietario oltre a
  Admin/MFA e di usare un contesto diagnostico separato dai clienti, preservando
  i limiti globali. Non creare un'azienda commerciale né mutare la sessione.
  La semplice sostituzione del guard commerciale con `admin:true` romperebbe
  ownership degli ID e cataloghi; il riuso deve coprire anche questi chiamanti.
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
