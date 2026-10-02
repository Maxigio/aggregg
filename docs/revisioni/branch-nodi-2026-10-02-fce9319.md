# Review del branch nodi — 2 ottobre 2026

## Perimetro e verdetto

Base verificata nel reflog: `81e25ab`. Commit esaminato: `fce9319` (`feat(nodi): integra aziende e aree del collaudo`), realizzato su richiesta del proprietario prima della review. Branch `feat/nodi-residenziali-prototipo`: 16 commit dopo la base; diff complessivo di 61 file, 7.854 aggiunte e 727 rimozioni. Il numero di righe non misura la qualità.

Il prototipo locale dimostra il percorso centro–worker e un primo percorso commerciale con Nhost/PostgreSQL. **Non è ancora il backend distribuibile ai clienti.** La review conferma la direzione architetturale, trova undici difetti di comportamento e un rischio condizionato di isolamento delle cache. I gate di produzione mancanti sono descritti separatamente: non sono automaticamente regressioni.

Review in sola lettura del codice: nessun fix o deploy; nessuna operazione sull'M2 o chiamata ai portali. Tre reviewer indipendenti hanno esaminato autenticazione/commerciale, coordinamento/worker e lifecycle/produzione. I finding principali sono stati controverificati nell'ambiente principale con risposte sintetiche. Il collaudo manuale aperto e l'azienda attivata dal proprietario sono rimasti intatti.

## Percorsi ricostruiti

| Percorso | Implementazione attuale | Limite |
| --- | --- | --- |
| Login | `login-nhost-prova` → `nhost-auth-client` → Nhost → identità PostgreSQL → cookie opaco server-side | Sessioni RAM, origine loopback; race R01 |
| Azienda | Admin MFA → invito con impronta token → verifica email → accettazione → attivazione manuale annuale | Primo referente soltanto nel percorso PG reale |
| Ricerca | frontend prototipo → centro → permessi/modulo → coda → worker → `operazioni` → coordinatore estratto → scraper | UI del prototipo, non ancora frontend AMR commerciale collegato |
| Failover | 429/indisponibilità della singola fonte → un alternativo → composizione sul primario | R03/R04; solo trasporto locale collaudato |
| Pagine/retry | Parametri e cursori esistenti, scope azienda, affinità per fonte; nessun replay degli incerti | R03 e C01; dettagli limitati dalla registrazione degli URL |
| Dettaglio | URL già ricevuta nella sessione → fonte ricavata dall'host → job al nodo disponibile → router reale | R02/R11; non copre tutti gli accessori di AMR |
| Diagnostica | SQLite: stati, tempi, filtri ammessi, eventi; UI con liste/pagine/espansioni; export esplicito | Stato locale, non ancora persistenza cloud e audit commerciale completo |
| Arresto | Worker con abort; centro conserva metadata degli incerti; launcher dedicati | R07/R08; entrypoint di produzione da costruire |

Il coordinatore mantiene la traduzione dei cataloghi e riusa gli scraper esistenti. Il centro non normalizza nuovamente gli annunci: assegna i lavori e verifica l'autorizzazione anche prima della consegna. Nei metadata SQLite la composizione conserva i nomi delle fonti, il dettaglio l'impronta dell'URL: non i body degli annunci.

## Difetti verificati

### R01 — Alta: autenticazione pendente sopravvive a logout/revoca

- Percorso: `backend/nodi/login-nhost-prova.js:57–68, 80–102, 122–139`.
- Prova indipendente: login MFA → richiesta MFA lasciata pendente nel provider simulato → logout nello stesso browser → completamento del provider → nuovo cookie Admin; `/me` risponde 200. Anche `revocaPersona` durante la chiamata al provider non impedisce la successiva sessione.
- Causa: la generazione di revoca viene letta solo dopo la risposta del provider; il challenge MFA è già eliminato quando il logout dovrebbe invalidare il tentativo in corso.
- Controprova: revoca durante `identita()` e logout di una sessione già creata sono coperti e funzionano. Il problema è la finestra precedente, non ogni logout.
- Proposta: registrare e invalidare esplicitamente i tentativi pendenti; verificarli prima di creare sessione/cookie. La revoca della persona deve prevalere anche su autenticazioni iniziate prima della sua registrazione. Non limitarsi a spostare il controllo dopo un altro `await`.
- Prova: `/private/tmp/amr-branch-review-20261002/auth-race.cjs`.

### R02 — Media: sospendere una fonte lascia partire dettagli accodati

- Percorso: `backend/nodi/centro.js:233–245, 427–450, 574–583, 656–662`.
- Prova via HTTP reale locale: dettaglio Subito accodato → sospensione manuale Subito → poll → dettaglio comunque consegnato al worker.
- Causa: `fontiDelLavoro()` restituisce un elenco vuoto per `dettaglio`; il job non registra la fonte benché la rotta l'abbia già identificata.
- Controprova: la sospensione di tutto il nodo e delle ricerche accodate funziona; una pausa automatica ha anche la protezione locale del worker. Questo non rende efficace la sospensione manuale del dettaglio.
- Proposta: associare la fonte al job dettaglio e includerla nelle verifiche prima della consegna. Lasciare finire i lavori già iniziati, secondo la decisione concordata.

### R03 — Media: composizione fallita perde una porzione riuscita e conserva affinità incoerente

- Percorso: `backend/nodi/centro.js:338–366`.
- Prova: A restituisce Subito 429 e AutoScout riuscito; B recupera Subito; la composizione su A risponde 503. Il browser riceve 200 con la sola base, senza il recupero e senza avviso di composizione. Il reviewer ha inoltre verificato in memoria l'affinità Subito già assegnata a B.
- Causa: il ramo non 200 non aggiunge un avviso; `termina(base.body)` registra comunque le assegnazioni del recupero non consegnato.
- Controprova: una composizione riuscita preserva le altre fonti; una composizione che lancia un errore aggiunge un avviso. Il buco riguarda l'esito non 200 e la coerenza dello stato finale.
- Proposta: dichiarare il fallimento anche per non 200, conservare temporaneamente le porzioni riuscite e rendere riprovabile la sola composizione. Aggiornare l'affinità coerentemente con ciò che viene consegnato. Non ripetere gli scraper già riusciti.
- Scelta da discutere: mantenere la composizione sul primario o usare nel centro la stessa funzione pura già esistente. La seconda elimina un passaggio di rete ma cambia la decisione architetturale concordata; non applicarla implicitamente.

### R04 — Media: un heartbeat precedente rende incerto il lavoro successivo

- Percorso: `backend/nodi/worker.js:60–72`; `backend/nodi/centro.js:409–415`.
- Prova lato worker: A termina e B inizia mentre un heartbeat di A è ancora pendente. Prova lato centro: dopo la consegna di B arriva l'heartbeat con ID A; B viene dichiarato incerto e rimosso.
- Causa: `clearInterval` non attende le richieste già partite; il centro interpreta qualsiasi ID differente come riavvio del worker.
- Controprova: un riavvio reale deve continuare a dichiarare incerto il lavoro; non si deve eliminare indiscriminatamente questa verifica.
- Proposta: serializzare heartbeat e transizioni dei lavori, aggiungendo un ordinamento/identificatore di avvio del worker che permetta al centro di ignorare messaggi precedenti. Provare ritardi e riordino, senza ripetere automaticamente job già iniziati.

### R05 — Media: login AMR negato non chiude la sessione provider appena emessa

- Percorso: `backend/nodi/login-nhost-prova.js:57–80, 93–102`.
- Prova: provider emette una sessione, `identita()` nega l'accesso, AMR risponde 403; zero chiamate a `client.logout`.
- Controprova: nessun token viene consegnato al browser; non è stato dimostrato accesso AMR non autorizzato. Il problema riguarda cleanup e sessioni residue presso il provider.
- Proposta: tentare la revoca della sessione provider quando AMR ne rifiuta la creazione, conservando l'errore originale anche se il cleanup fallisce.

### R06 — Media: il cap delle sessioni rifiuta anche una sostituzione valida

- Percorso: `backend/nodi/login-nhost-prova.js:67–68`.
- Prova: 100 sessioni attive; nuovo login con cookie valido da sostituire → 503. Il limite viene controllato prima della rimozione della vecchia sessione.
- Controprova: sotto il cap la rotazione avviene; non è dimostrato che trenta clienti raggiungano necessariamente il cap.
- Proposta: distinguere un nuovo posto dalla sostituzione di una sessione valida, mantenendo il limite. Non cancellare la vecchia sessione prima che il nuovo login sia stato autorizzato.

### R07 — Media: il launcher del prototipo può avviare worker dopo lo stop

- Percorso: `scripts/avvia-nodi-prototipo.js:21–38`.
- Prova in VM del sorgente reale: SIGTERM anticipato oppure centro terminato con codice 1; i timer creano successivamente due worker senza inviare loro lo stop.
- Controprova: i figli già esistenti ricevono SIGTERM; il problema riguarda i timer non cancellati e l'assenza di un controllo in `avvia()`.
- Proposta: cancellare i timer, impedire nuovi avvii durante la chiusura e attendere i figli; cleanup idempotente.

### R08 — Media: SIGTERM durante il collaudo Nhost può saltare il cleanup

- Percorso: `scripts/collauda-nhost-locale.js:97–137, 572–576, 597–614`.
- Evidenza: gli handler dei segnali vengono installati solo alla fine della modalità manuale, dopo la creazione delle risorse. La modalità automatica non li installa. Il comportamento standard di Node su SIGTERM termina il processo e non svolge il cleanup asincrono nel `finally`.
- Controprova: il collaudo automatico completato in questa review esegue correttamente la procedura finale; gli errori applicativi ordinari passano dal `finally`. Non si tratta di un fallimento di ogni cleanup.
- Proposta: installare la gestione dei segnali prima di creare risorse e convergere su una sola procedura di arresto/cleanup idempotente. SIGKILL e crash della macchina richiedono comunque una procedura successiva di recupero, non una promessa di cleanup garantito.

### R09 — Media: l'elenco presenta come attiva una licenza scaduta

- Percorso: `backend/nodi/schema-aziende-prova.sql:327–331`; `frontend/nodi-aziende-prova.js:90–93`.
- Evidenza deterministica: con `a.attiva=true`, il primo ramo del `CASE` restituisce `attiva` senza valutare la data; la UI usa quell'etichetta.
- Controprova decisiva: `schema-accessi-prova.sql:34` controlla la scadenza e nega il modulo. **Non è un bypass dell'autorizzazione.** Il nuovo collaudo PostgreSQL ha verificato il diniego alla scadenza, non un caso aggiuntivo dell'elenco.
- Proposta: distinguere stato amministrativo e validità della licenza nell'elenco, allineando etichette e azioni.

### R10 — Bassa: refresh account distrugge il controllo focalizzato

- Percorso: `frontend/nodi-aziende-prova.js:84–103, 190`.
- Prova del reviewer con browser e rete simulata: pulsante Attiva focalizzato → refresh dell'elenco → focus sul body. `replaceChildren()` elimina il pulsante; i nuovi nodi non ne ripristinano il focus.
- Controprova: l'ID dell'operazione resta stabile, quindi non è il precedente problema di duplicazione dell'attivazione. La lista dei lavori usa già una logica diversa che conserva i dettagli aperti.
- Proposta: riusare i controlli per ID azienda o ripristinare il focus sul controllo equivalente, senza sottrarlo a un altro campo durante il refresh.

### R11 — Media, già noto: URL ancora visibili perdono l'autorizzazione al dettaglio

- Percorso: `backend/nodi/centro.js:610–613, 640–643`.
- Prova via HTTP locale: dopo la consegna di 301 URL nella sessione, il dettaglio della prima restituisce 403; il dettaglio dell'ultima viene accodato. Il harness consegna righe sintetiche insieme per isolare il cap; nell'uso reale il limite si raggiunge accumulando più pagine/fonti.
- Causa: registro degli URL limitato agli ultimi 300, mentre il frontend può conservare più risultati. Era già dichiarato nella review precedente e non è stato risolto dal commit corrente.
- Proposta: autorizzazione al dettaglio collegata a risultati/ricerche ancora disponibili, con scadenza e limite coerenti. Non rimuovere la verifica dell'URL e non trasformare il dettaglio in un proxy arbitrario.

## Rischio condizionato verificato

### C01 — Cache: ID azienda differenti soltanto per maiuscole collidono

`backend/nodi/operazioni.js:45` passa l'ID azienda come `_cacheScope`; `backend/ricerca-coordinatore.js:190–193` converte in minuscolo l'intera chiave. Le aziende `ACME` e `acme` sono distinguibili nei domini/schema ammessi, ma nel test della cache reale del coordinatore la seconda pagina esegue una sola ricerca e riusa la risposta della prima azienda.

Controprova: la UI commerciale attuale genera ID `azienda-UUID` in minuscolo; non è dimostrata una collisione fra le aziende create normalmente attraverso quella UI. Né è stata dimostrata una fuga di dati personali: il test usa annunci sintetici/publici. Resta una violazione condizionata del requisito di non condividere pagine successive fra aziende.

Proposta: separare la normalizzazione dei testi dalla codifica esatta dello scope, oppure imporre un identificatore canonico univoco a tutti i livelli. Preservare lo scope esatto è il cambiamento più circoscritto, senza diminuire la precisione delle altre chiavi.

## Decisioni che restano fondate e limiti

- Centro cloud con scraper residenziali: separa accesso commerciale ed esecuzione; il prototipo dimostra il percorso. Non dimostra che tutte le fonti funzionino esclusivamente da IP residenziali, né quanti clienti sostenga ogni IP.
- Riutilizzare il coordinatore: le prove simulate confrontano filtri, chiamate, porzioni, cursori e composizione Auto/Moto. Coprono scenari scelti, non tutte le combinazioni dei cataloghi o risposte future dei portali.
- Salute locale + vista centrale: evita di dipendere dalla connessione al centro per fermare la fonte. **Processi sullo stesso IP devono ancora condividere la pausa/ammissione**: cartelle isolate non garantiscono coordinamento con l'AMR già attivo sull'M2.
- Nessun replay degli incerti: preserva il limite sulle richieste che potrebbero essere già partite; R04 va corretto per non produrre falsi incerti.
- Autorizzazione prima di assegnazione e consegna: confermata con scadenza e revoca durante lavori condivisi. La revoca del destinatario non autorizza a interrompere il risultato destinato a un'altra persona ancora ammessa.
- Nhost per password/MFA, cookie server-side per AMR: evita un secondo sistema di password; R01 deve essere risolto. Il reset password futuro deve invalidare anche le sessioni AMR; oggi quel percorso non esiste e non è stato provato.
- Log diagnostici senza body degli annunci: scelta mantenuta. L'audit commerciale e di sicurezza va completato senza introdurre token, password o dati personali superflui.

## Gate di produzione ancora aperti

1. **Un solo percorso commerciale definitivo.** SQLite sintetico dimostra colleghi/revoche/sessioni; PostgreSQL reale integra il primo referente e l'attivazione. Mancano equivalenti PG di rinnovi, revoche, colleghi e gestione sessioni. Non sommare i due esperimenti come se fossero un'unica implementazione.
2. **Persistenza e riavvio.** Il collaudo Auth/PG è in tmpfs e viene eliminato alla chiusura; cookie e stato in volo sono in Map. Scegliere sessioni e metadata persistenti, un unico scheduler iniziale e arresto controllato; mai ripetere automaticamente lavori incerti dopo restart/restore.
3. **Backup OneDrive.** Stato SQL limitato a `pending/non_configurata`: non esiste ancora copia esterna. Servono cifratura, upload dopo operazioni confermate, retry con avviso persistente, 90 giorni di journal, 14 backup giornalieri e restore con riconciliazione delle revoche. Nhost Pro documenta backup DB giornalieri per sette giorni; file Storage e dati dei volumi Run sono esclusi dal backup PostgreSQL. I dati che un servizio Run scrive nel PostgreSQL coperto restano invece inclusi. Il backup DB non copre da solo lo SQLite del centro.
4. **Entrypoint e trasporto remoti.** `npm start` avvia ancora il monolite. Il main del centro non monta l'adapter commerciale; login, Auth client, centro e worker impongono loopback. Servono configurazione validata, HTTPS/proxy/cookie Secure, servizi interni Nhost configurati, versione Node supportata e immagine applicativa. `node >=20` non garantisce `node:sqlite`.
5. **Identità dei nodi.** `imac-1` è una stringa fissa, non un'impronta del codice/cataloghi. Servono protocollo/release/cataloghi verificabili e revoca/rotazione delle credenziali distinta dalla sospensione manuale.
6. **Tempi e capacità.** I budget sono per singolo lavoro: ricerca, alternative e composizione non hanno una deadline complessiva. Definire quella deadline sulla base delle misure e del proxy reale; misurare equità fra aziende, coda e polling. Non è dimostrata una saturazione con trenta persone né un limite del provider sulle richieste lunghe.
7. **Frontend AMR e integrazioni.** Le prove del prototipo non certificano gli accessori/export/supporto del frontend AMR finale. Il report AutoScout Adventure è un handoff alla chat APP: l'ID è corretto; il confronto ufficiale è stato rifiutato 401 e non dimostra la causa del risultato vuoto. Non correggere qui i cataloghi sulla base di quel solo campione.
8. **SMTP e recupero Admin.** Oggi la posta è locale; SMTP reale e recovery MFA devono essere collaudati prima di clienti, senza bypass permanente dell'autenticazione.

## Ordine di lavoro raccomandato

1. Correggere R01 e il cleanup provider; poi R02–R04. Una correzione verificata per volta, con review indipendente e commit su richiesta.
2. Chiudere i restanti difetti locali e lo scope cache; non ampliare le funzionalità mentre si correggono.
3. Completare il ciclo commerciale su PostgreSQL e il recupero dei dati. Questa è la priorità funzionale successiva: l'azienda del collaudo oggi non sopravvive all'arresto del suo ambiente.
4. Predisporre un entrypoint di staging con un solo centro, Nhost/Auth/PG e worker iMac via HTTPS. Provare restart, revoca nodi, scadenza, latenza/timeout e fallimenti con fonti simulate prima di ricerche live.
5. Collegare il frontend AMR con la chat APP; solo dopo aprire il gate M2, prima connessione/cataloghi senza portali e poi pause condivise sullo stesso IP. Nessun deploy di produzione implicito.

Non emerge la necessità di Kubernetes, un broker o una riscrittura degli scraper per questa prima versione. Introdurli prima di una misura o requisito concreto aggiungerebbe componenti da mantenere senza risolvere R01–R11.

## Prove di questa review

- 85/85 test `nodi-*` passati, zero fallimenti e zero skip, dati/log temporanei e `dotenv` disabilitato. Log: `/private/tmp/amr-branch-review-20261002/nodi-suite.log`.
- Collaudo automatico separato Nhost Auth/PostgreSQL: login, MFA, email/PKCE locale, privilegi SQL, contesa ultimo posto, invito/attivazione idempotenti, scadenza e revoca in volo; concluso con cleanup. Log privo di credenziali: `/private/tmp/amr-branch-review-20261002/nhost-automatico.log`. Il primo avvio limitato dal sandbox non è riuscito; il run autorizzato è passato. Non è stato riavviato lo stack manuale del proprietario.
- Controprove principali: `auth-race.cjs`, `centro-findings.cjs`, `worker-cache.cjs` nella stessa directory temporanea. Trasporti sintetici; server solo loopback. R07 riprodotto in VM senza processi figli reali.
- R09 verificato sul percorso SQL/renderer, non con una nuova query sull'elenco di un'azienda scaduta. R10 riprodotto dal reviewer in browser simulato, non durante il collaudo manuale dell'utente.
- Limite operativo: un reviewer ha segnalato che una prima suite importava indirettamente `dotenv`; nessun valore è stato consultato o esposto, ma è una deviazione dal perimetro. Le suite interessate sono state rieseguite con il preload che impedisce il caricamento. Le controprove principali usano provider sintetici e non importano il server con credenziali.
- Nessun test del cloud Nhost, SMTP Aruba/esterno, OneDrive, trasporto iMac–M2 o carico commerciale eseguito. Nessuna nuova misura live degli scraper.

## Fonti autorevoli ricontrollate

- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): autorizzazione server-side per ogni richiesta, deny by default. Supporta verifiche ingresso/consegna, non certifica il codice.
- [OWASP Multi-Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html): identità/tenant verificati, isolamento cache e lavori asincroni, limiti di risorse per tenant. Rilevante per C01 e capacità condivisa.
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): lifecycle e invalidazione delle sessioni. Rilevante per R01 e futura revoca dopo reset.
- [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html): correlazione degli eventi ed esclusione di password/token/chiavi dai log.
- [Nhost Run networking](https://docs.nhost.io/products/run/networking): rete interna dei servizi e pubblicazione HTTP tramite HTTPS. Non dimostra una durata massima garantita per le ricerche AMR.
- [Nhost backup](https://docs.nhost.io/products/database/backups): retention DB di sette giorni per Pro/Team; file Storage e dati dei volumi Run esclusi dal backup PostgreSQL.
- [PostgreSQL SECURITY DEFINER](https://www.postgresql.org/docs/16/sql-createfunction.html): search path sicuro e concessioni ristrette; collaudare i privilegi della versione distribuita.
- [Node signal events](https://nodejs.org/api/process.html#signal-events) e [node:sqlite](https://nodejs.org/api/sqlite.html): comportamento di arresto e requisiti runtime.
