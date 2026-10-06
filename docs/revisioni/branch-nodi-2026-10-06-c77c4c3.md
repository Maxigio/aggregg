# Review del branch centro–nodi — 6 ottobre 2026

## Verdetto e perimetro

Il prototipo ha un percorso completo di accesso, autorizzazione, ricerca distribuita e diagnostica. Non è ancora pronto al rilascio clienti né al collegamento M2: resta il blocco intermittente dell'ingresso staging e questa review identifica due difetti nei flussi invito, un difetto nei filtri dell'interfaccia e due problemi di accessibilità. Altri comportamenti richiedono una decisione o misure; non sono automaticamente vulnerabilità.

Baseline: branch `feat/nodi-residenziali-prototipo`, creato il 29 settembre da `81e25ab`; HEAD esaminato `c77c4c3`. Dalla base: 106 commit, 186 file modificati, +30.465/−728 righe. All'inizio e prima della documentazione, nessuna modifica tracciata e 22 percorsi non tracciati preesistenti, preservati. Questo incremento aggiunge soltanto documentazione: non corregge il runtime, non pubblica immagini, non modifica Nhost, non accede all'M2 e non interroga i portali.

La review attraversa i percorsi critici e il loro diff, con tre analisi indipendenti in sola lettura su accessi/SQL, backup/deploy e frontend. Non è una lettura certificata di ogni riga dei 186 file né una garanzia contro difetti futuri. Commenti, documenti storici e test passanti sono stati confrontati con chiamanti, funzioni SQL e comportamento controllato.

## Mappa del comportamento attuale

| Percorso | Codice e comportamento verificato | Limite della prova |
| --- | --- | --- |
| Login | `login-nhost-prova.js`, `nhost-auth-client.js`, `accessi-postgres-prova.js`: password/MFA attestati dal provider; token Nhost nel backend; sessione AMR opaca in RAM, cookie protetto, finalizzazione distinta dal login lento. | Le nuove riproduzioni usano Auth sintetico e PostgreSQL reale. Non ripetuto il login Nhost remoto. |
| Aziende e persone | Migrazioni `schema-*-prova.sql`, adapter e rotte: appartenenza unica, quote, moduli Auto/Moto indipendenti, inviti, referente, attivazione, rinnovo e revoca. Permessi correnti controllati prima dell'ammissione e della consegna. | Le prove sui nuovi difetti esercitano le otto migrazioni attuali con ruoli di lettura/scrittura limitati. |
| Avvio e consultazione ricerca | `ricerche-http.js`, `limiti-ricerca.js`, `centro.js`: POST breve con ID, GET brevi dello stesso esito; il retry della risposta di avvio persa non crea un nuovo lavoro. Budget ricerca 60 s, massimo 2 pendenti per persona e 60 complessive. | Limiti iniziali concordati, non capacità produttiva misurata. |
| Risultato temporaneo | Esito in RAM, TTL risultato 60 s, ID conservato 10 minuti, capacità 1.000 registri/64 MiB. Permessi ricontrollati anche nella consultazione. | Riavvio e replica concorrente non conservano sessioni/risultati. Una replica è un requisito operativo. |
| Coordinamento | `centro.js`, `componi-ricerca.js`, `operazioni.js`: preferenza per un nodo capace di servire tutte le fonti; composizione nel centro con funzione pura condivisa; retry della sola fonte fallita e un solo nodo alternativo per operazione. | Questa composizione centrale supera la decisione iniziale di assemblare sul nodo principale. |
| Cache e pagine | `ricerca-coordinatore.js`, cursori e UI: scope della ricerca, affinità alla fonte/nodo, condivisione autorizzata della sola prima pagina identica; le porzioni riuscite non sono ripetute nel retry. | Una pagina remota non è una fotografia immutabile del portale; cambiare nodo può cambiare copertura e va dichiarato. |
| Nodo | `worker.js`, `compatibilita-nodo.js`, launcher staging: connessioni in uscita, credenziale del nodo, protocollo e manifest di codice/cataloghi confrontati; credenziale rifiutata termina il worker. | Il manifest dimostra compatibilità dei file dichiarati, non integrità di una macchina ostile. |
| Salute | Pause locali per nodo/fonte e vista centrale; sospensione manuale blocca nuove assegnazioni, lascia finire richieste partite e non anticipa la fine di una pausa 429. | Due processi sullo stesso IP non sono coordinati soltanto perché usano lo stesso catalogo. |
| Disconnessione | Browser chiuso: chiamate già partite terminano, risposta scartata. Collegamento nodo–centro perso: annullamento tentato, esito incerto, nessun replay automatico. | L'annullamento non dimostra che il portale non abbia ricevuto la richiesta. |
| Menu e dettagli | `centro.js`, `dettaglio-route.js`, `scrapers/detail.js`: autorizzazione corrente e autorizzazione firmata per risultato; menu/dettagli remoti attendono ancora dentro GET lunghe. | La ricerca breve non ha eliminato tutte le attese HTTP del prodotto. |
| Diagnostica | Eventi, tempi, lavori e filtri; niente body o annunci nel registro SQLite. Conservazione dei filtri 7 giorni; export su richiesta. | Il tempo residuo include serializzazione/trasporto, non è latenza pura tra orologi diversi. |
| Backup e deploy | Journal ordinati, copie Restic, ripristino isolato, manifest immutabili e guardie di aggiornamento. | Backup temporaneo sull'iMac documentato; storage gestito e ripristino funzionale completo Nhost ancora da collaudare. |

## Stato del deploy: tre identità distinte

- **Checkout della review:** `c77c4c3`.
- **Candidato preparato:** `8c396f98f6d2ec5b0c8784fb03a2cf694555b3ce`, immagine multiarch `sha256:f5b5dba7b8ea5a04221e9a9d523c3302e886b3fd2cdb4ef23d52ec237c715f43`, caricata nel registry ma non distribuita.
- **Staging, ultima verifica precedente a questa review:** originale `66e2b24`, con ingresso intermittente 403. Non ricontrollato da remoto in questo incremento.

La suite precedente dell'immagine candidata aveva 1.480 pass e nove skip su 1.489 test. È una prova storica del candidato, non la suite completa eseguita oggi e non una prova del suo deploy. I dettagli delle ricevute sono nel [registro M2](/Volumes/MAIN/BananaChePrezzi-main/docs/revisioni/m2-collegamento-solo-stato-2026-10-05.md).

## Problemi confermati

### F1 — Media: accettare l'invito referente può lasciare una sessione incoerente

**Scenario:** una persona già esistente e attiva, senza appartenenza corrente, effettua il login; poi accetta l'invito referente e l'Admin attiva l'azienda. Il caso è ammesso dallo schema, per esempio dopo la revoca di un precedente collega.

**Evidenza:** [accettazione SQL](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/schema-aziende-prova.sql:248) aggiunge la membership senza incrementare `persone.epoca`; la sessione conserva l'azienda originale [alla creazione](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/login-nhost-prova.js:158). `/me` espone l'azienda corrente, ma il [controllo del centro](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/centro.js:154) rifiuta la differenza con l'azienda memorizzata nella sessione.

**Prova:** PostgreSQL 18.6 e otto migrazioni attuali: epoca 3 → 3; login e `/me` attraversano rotte HTTP reali, `/me` risponde 200 con la nuova azienda. Il controllo `verificaSessione` del centro, eseguito dal sorgente corrente in VM, rifiuta la ricerca con status 403; dopo un nuovo login lo stesso controllo la ammette. In questa riproduzione non è stata chiamata la route HTTP di ricerca.

**Controprova e impatto:** non concede accesso a un'altra azienda; il centro rifiuta correttamente. Il difetto è l'incoerenza dell'accesso presentato e il recupero non esplicito. Non riguarda un referente appena registrato che non ha sessioni AMR precedenti.

**Proposta:** applicare all'accettazione referente la stessa invalidazione delle sessioni già presente [nell'accettazione collega](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/schema-colleghi-prova.sql:279), comunicando la necessità di un nuovo login. Migrazione nuova, senza riscrivere quelle già applicate; provare anche il tentativo di login pendente e il retry, per non creare una nuova finestra di incoerenza.

### F2 — Media: risposta persa nell'accettazione referente non riconciliabile

**Scenario:** l'accettazione viene confermata nel database, ma la risposta HTTP non arriva al browser. Lo stesso invio viene ripetuto.

**Evidenza:** [la route](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/aziende-prova-route.js:52) rilegge l'invito prima dell'autenticazione; il [lookup](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/schema-aziende-prova.sql:239) ammette soltanto inviti non consumati. L'accettazione registra [un UUID generato nel database](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/schema-aziende-prova.sql:288), non un ID riutilizzabile dal browser.

**Prova:** su PostgreSQL reale, prima risposta 200, risposta ignorata dal chiamante, retry 403 `invito_non_valido`; una sola accettazione registrata. Il browser non può distinguere questa riuscita da un invito realmente invalido tramite lo stesso percorso.

**Controprova e impatto:** non crea una seconda azienda né perde la membership; l'Admin può comunque vedere il referente e procedere. È un difetto di riconciliazione e UX nelle interruzioni, non un bypass.

**Proposta:** riusare il protocollo degli [inviti collega](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/schema-colleghi-prova.sql:258): ID operazione stabile, identità verificata, scope dell'invito e risultato già confermato. Il token consumato non deve da solo autenticare, riaprire l'invito o concedere dati personali. Provare risposta persa, retry paralleli, ID riutilizzato con altra identità/invito, scadenza e revoca successiva.

### F3 — Media: filtri tardivi sostituiscono quelli dell'interfaccia corrente

**Scenario:** il caricamento `/api/filtri` del contesto A è lento. B carica i propri menu, la persona seleziona una regione; poi arriva A e ricostruisce il select, cancellando la selezione senza generare eventi di modifica.

**Evidenza:** [caricamento e scrittura dei filtri](/Volumes/MAIN/BananaChePrezzi-main/frontend/nodi-prototipo.js:174) non verificano il contesto dopo l'attesa; [applicaIdentita](/Volumes/MAIN/BananaChePrezzi-main/frontend/nodi-prototipo.js:679) ha altre continuazioni asincrone da controllare insieme.

**Prova:** esecuzione del sorgente corrente in VM con fetch controllate: la regione di B passa da selezionata a vuota dopo la risposta di A, senza `input/change`. Il caricamento ordinato di un solo contesto conserva il comportamento atteso.

**Controprova e impatto:** i filtri sono cataloghi condivisi, non dati riservati di A: non è provata una fuga tra aziende. Cambiano però i parametri che l'utente vede e può inviare; non è un semplice difetto estetico. La frequenza nel browser reale non è misurata.

**Proposta:** vincolare ogni scrittura DOM e avviso al contesto corrente, includendo la continuazione di `applicaIdentita`; preservare selezioni ancora valide. Il completamento può aggiornare una cache di catalogo condivisa senza aggiornare una vista ormai diversa. Abort da solo non basta contro una risposta già completata.

### F4 — Bassa: dopo la revoca collega il focus può andare perso

**Evidenza:** [l'operazione disabilita i pulsanti](/Volumes/MAIN/BananaChePrezzi-main/frontend/nodi-colleghi-prova.js:54); dopo aver rimosso il collega, [chiama `aggiorna.focus()`](/Volumes/MAIN/BananaChePrezzi-main/frontend/nodi-colleghi-prova.js:98) prima del `finally` che riabilita il pulsante.

**Prova:** VM con comportamento dei controlli disabilitati: il vecchio pulsante focalizzato viene rimosso, il focus sul nuovo controllo disabilitato è ignorato; abilitarlo successivamente non ripristina il focus. Lo stesso controllo abilitato accetta il focus.

**Proposta:** ripristinare il focus dopo la riabilitazione, soltanto se è realmente andato perso e il contesto è ancora lo stesso, senza sottrarlo a una persona che nel frattempo si è spostata altrove. Da completare con prova manuale di tastiera nel browser.

### F5 — Bassa: completamento e conteggio ricerca fuori dalla regione annunciata

**Evidenza:** il [conteggio](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/prototipo.html:64) è uno span senza ruolo/live region; [la ricerca riuscita](/Volumes/MAIN/BananaChePrezzi-main/frontend/nodi-prototipo.js:444) aggiorna quel testo. Gli avvisi hanno invece `role="status"`; una ricerca riuscita senza avvisi non vi scrive l'esito.

**Prova:** markup e VM confermano che il messaggio di completamento, anche a zero risultati, viene scritto soltanto fuori dalla regione annunciata. Non è stata eseguita una prova con screen reader; non si sostiene che ogni tecnologia assistiva si comporti allo stesso modo.

**Proposta:** rendere annunciabile il breve stato della ricerca, senza trasformare l'intera griglia in live region. Verificare un solo annuncio del completamento, vuoto/errore e aggiornamenti periodici non ridondanti.

## Comportamenti e rischi condizionati

### C1 — Revoca aziendale e login già in corso: serve chiarire il contratto

**Comportamento verificato:** un login preparato prima della revoca può finalizzarsi dopo, adottando l'epoca SQL nuova. [La finalizzazione](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/login-nhost-prova.js:138) legge l'identità corrente; [la route di revoca](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/aziende-prova-route.js:40) non usa la barriera RAM `revocaPersona`.

Su PostgreSQL reale e rotte HTTP di login: il vecchio cookie è rifiutato e la conferma pendente crea una sessione. La verifica diretta dell'autorizzazione alla ricerca la nega durante la revoca e la ammette dopo un rinnovo entro la durata della sessione, senza nuovo login. Non è un collaudo della route HTTP ricerca. Il tentativo scade dopo 3 minuti e la sessione dopo 15 minuti.

**Debunking:** non è un bypass di password, MFA, moduli o isolamento. La revoca aziendale lascia l'identità attiva: anche un login nuovo durante la revoca può diventare operativo dopo il rinnovo. Il difetto esiste se vogliamo che la revoca annulli anche autenticazioni già iniziate; non basta assumere questo requisito.

**Decisione proposta:** discutere se adottare quel vincolo. In quel caso servirebbe una revisione persistente letta prima dell'attesa Auth e aggiornata atomicamente dalla revoca, confrontata prima di creare la sessione. Una sola barriera RAM dopo un callback SQL riuscito non copre un commit con risposta persa; leggere l'epoca soltanto dopo Auth non copre la revoca durante quell'attesa. La soluzione richiede migrazione e collaudo, non è ancora implementata né provata.

### C2 — GET lunghe di menu/dettagli possono creare un altro lavoro sul retry

[Le rotte del centro](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/centro.js:903) creano un lavoro per ogni GET e attendono l'esito; il timeout generale predefinito è 150 s. La cancellazione di un destinatario rimuove la coda non iniziata e lascia finire il lavoro già partito.

**Prova locale:** GET menu consegnata al nodo, connessione browser chiusa, seconda GET identica prima del completamento: due ID di lavoro. Controllo con una sola GET: un ID. Nessuna chiamata ai portali nella prova.

**Debunking:** due lavori non dimostrano due richieste al portale; `scrapers/detail.js` usa cache e deduplica in volo. RFC 9110 ammette retry di richieste idempotenti in alcune interruzioni, ma non dimostra che Nhost abbia ripetuto queste rotte. Non è provata una vulnerabilità perché il GET registra diagnostica.

**Proposta da valutare:** estendere avvio breve + ID alle operazioni che attendono realmente il nodo, oppure servire al centro i cataloghi immutabili compatibili. Prima contare le chiamate effettive nel caso di cache fredda/errore e misurare il proxy; preservare autorizzazione firmata, deduplica e semantica del dettaglio.

### C3 — Heartbeat del worker ordinario legato al polling a vuoto

[Il ciclo](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/worker.js:96) invia heartbeat e poll, poi attende 250 ms sul 204. In due secondi simulati, con rete a latenza zero: nove heartbeat e otto poll; `--solo-stato`: due heartbeat e zero poll. Le chiamate iniziale/finale incidono sul conteggio.

È un costo operativo misurato in simulazione, non una prova di sovraccarico o di spesa reale. Valutare un intervallo heartbeat distinto o polling adattivo soltanto con misure di assegnazione, disconnessione e carico; non allungare le soglie di disponibilità senza quelle prove.

### C4 — Accettazione inviti con un'identità che ha già MFA

L'accettazione referente [rifiuta esplicitamente il challenge MFA](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/aziende-prova-route.js:57) con 409; limite analogo per il collega. Riprodotto con provider sintetico. MFA è obbligatoria per il nostro Admin, che non può diventare referente: il percorso cliente previsto non prova che questo limite blocchi oggi il lancio.

Decidere se supportare già identità cliente con MFA. Se sì, riusare il challenge senza degradare la verifica; non disabilitare MFA per aggirare l'accettazione. Non collaudato su Auth Nhost remoto in questa review.

## Blocco noto e gate ancora aperti

1. **Ingress staging intermittente:** il campione precedente del 6 ottobre ha `/healthz` sempre 200, ma root 403/200/403/403 e Admin 403/403/401/401. Problema di disponibilità verificato allora, causa non dimostrata; non ripetuto oggi. Healthcheck escluso dal controllo di trasporto non prova accessibilità del prodotto. Non ampliare `trust proxy` né rimuovere Host/HTTPS per rendere verde la sonda.
2. **Sonda diagnostica remota:** piano e prova locale esistono; manca l'autorizzazione specifica alla nuova pubblicazione. Non eseguita. Servono deadline, arresto Run verificato e ripristino dell'originale; la sola scadenza interna del listener non arresta la replica.
3. **M2:** preparazione archivio/runtime/launcher disponibile; nessun collegamento eseguito. Primo gate solo stato, compatibilità, arresto e riconnessione in directory separata. Live solo dopo il coordinamento delle pause e dei limiti con l'AMR già attivo sullo stesso IP.
4. **Backup:** il registro contiene la ricevuta di una copia cifrata reale PostgreSQL/Run e di restore isolato. I repository e la chiave temporanei sullo stesso iMac non coprono la perdita di quella macchina. Storage gestito separato, automazione e ripristino funzionale di Auth/configurazione Nhost restano gate di produzione. L'Admin segnala la copia non configurata: non è stato dimostrato un nuovo difetto in backup/deploy dalle controprove indipendenti.
5. **Integrazione APP:** ricerca/menu/dettagli del prototipo non attestano automaticamente export e tutti i flussi del frontend AMR aggiornato. Il gate APP va coordinato con la chat dedicata e provato sull'artefatto effettivamente distribuito.
6. **Una replica e riavvio:** lo stato temporaneo in RAM è coerente con la scelta concordata; una seconda replica o un rolling update concorrente non sono supportati soltanto perché una variabile indica `1`. Verificare il comportamento reale del deploy, perdita delle sessioni e lavori interrotti/incerti.

## Prove eseguite e controprove

- Node 24.21.0; dati/log temporanei e preload `no-dotenv-preload.cjs`. Suite mirata seriale su centro, Run, ricerche HTTP, limiti, cursori, compatibilità, trasporto HTTPS, menu/dettagli, polling, worker e UI: **172 test, 172 pass, zero failure/cancelled/skip**, circa 143 s. Non è la suite completa del repository.
- Sette casi aggiuntivi accessi rieseguiti dal processo principale; controprove VM su filtri, focus e stato di completamento rieseguite indipendentemente. Non sommati ai conteggi delle suite degli agenti, che possono sovrapporsi.
- PostgreSQL 18.6 reale, immagine già disponibile vincolata al digest; `--pull=never`, porta localhost temporanea, nessun volume di produzione. Otto migrazioni attuali, ruoli limitati, Auth sintetico: F1, F2 e comportamento C1 riprodotti. Login, `/me` e accettazione F2 esercitano HTTP; F1/C1 verificano l'autorizzazione senza eseguire la route HTTP ricerca, come precisato sopra. Container di prova rimosso; elenco dei container estranei identico prima/dopo.
- Prova loopback su rotte reali per C2; simulazione dell'orologio/trasporto per C3. Zero chiamate ai portali e zero operazioni cloud/M2.
- Review indipendente backup/deploy: controprove su errori di prune/restore, esaurimento spazio, cleanup, collisioni e conservazione del materiale necessario al rollback; nessun nuovo difetto confermato. Queste prove non sostituiscono una nuova copia o un restore dell'ambiente remoto.
- Escluse conclusioni troppo ampie: C1 non annulla i controlli commerciali; C2 non prova doppio scraping; i filtri condivisi non costituiscono automaticamente leakage; una simulazione con più errori Subito non dimostra il comportamento dell'attuale ricerca a un solo ramo.

Ricevute locali di questo incremento, temporanee e senza credenziali reali: `/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-review-20261006-kowe_k2p/{test.log,esito.json,esito-pg.json}`. Riproduzioni accessi: `/private/tmp/amr-auth-review-c77c4c3.KHtRnc/residual.test.cjs`; UI: `/private/tmp/amr-frontend-review-c77c4c3-2qjpTv/`. I file temporanei possono sparire: scenari, output essenziali e limiti sono riportati sopra.

## Confronto con fonti autorevoli

- [OWASP Multi Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html): autorizzazione sul percorso effettivo, ruolo DB della richiesta e classificazione delle cache. Sostiene le prove con ruoli limitati e il controllo corrente del tenant; non impone una riscrittura con RLS di funzioni SQL già ristrette senza un finding.
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): invalidazione/rotazione dopo cambi di privilegi. È coerente con F1; non decide da sola se la revoca commerciale debba annullare ogni login pendente.
- [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/) e [Nhost networking](https://docs.nhost.io/products/run/networking): la fiducia deve corrispondere al proxy reale. Nella pagina Nhost consultata non c'è una garanzia di CIDR stabili del proxy; questa assenza non prova che il provider non possa offrirne una.
- [Nhost health checks](https://docs.nhost.io/products/run/health-checks): distingue la sonda HTTP dalle dipendenze dell'app. La conclusione che il nostro `/healthz` non provi login/ricerca deriva anche dal codice che lo esclude dal controllo di trasporto.
- [RFC 9110, 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2): semantica del retry idempotente; applicata come rischio condizionato in C2, non come prova di comportamento specifico Nhost.
- [HTML focus](https://html.spec.whatwg.org/multipage/interaction.html#focusable-area) e [WCAG 2.2, status messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html): fondamento di F4/F5. Rimane necessario il collaudo manuale con tastiera e tecnologia assistiva.

## Prossimo lavoro raccomandato

1. Correggere F1 e F2 separatamente, riusando il protocollo già presente per i colleghi; prima prova che fallisce sul codice corrente, poi controprove di concorrenza e isolamento. Discutere C1 senza introdurre in silenzio una nuova politica di revoca.
2. Correggere F3 e i due problemi di accessibilità; test automatici controllati e collaudo manuale conciso, senza un refactoring generale del frontend.
3. Chiudere la diagnosi ingress con la sonda autorizzata o un contratto del provider; verificare richiesta anonima, login/MFA e API, non soltanto healthcheck. In parallelo decidere il perimetro di C4 e misurare C2/C3.
4. Preparare un nuovo candidato immutabile contenente le correzioni, suite completa e gate locale dell'immagine; backup/rollback e deploy staging solo nel perimetro autorizzato. Verificare il commit realmente in esecuzione.
5. Collegare l'M2 in `--solo-stato`, con arresto e riconnessione provati e produzione invariata. Prima delle ricerche live coordinare pause/limiti sull'IP; poi collaudare pagine, retry della sola fonte, failover e diagnostica tra host reali.
6. Chiudere storage/restore remoto e integrazione APP Auto/Moto, quindi gate clienti. Non aggiungere ora Kubernetes, un broker o un framework di orchestrazione: non risolvono i difetti riprodotti e manca una misura che giustifichi quel costo operativo.

Ogni passaggio conserva il criterio concordato: prova, controprova, review indipendente sui cambi delicati, commit ordinato. Un documento aggiornato o una suite locale verde non costituiscono da soli autorizzazione né prova di produzione.
