# Moto.it — review del 28 settembre 2026

## Perimetro e baseline

Obiettivo: individuare ostacoli al rilascio sull'M2, senza modificare codice o distribuire.

Base: `ef0fa55`, branch `feat/ui-redesign-rating-grouping`, **più i fix Moto.it locali non ancora committati**, inclusa `backend/scrapers/motoit-ritmo.js`. I riferimenti di riga valgono per questo albero di lavoro. Non è una review della sola HEAD.

Percorsi letti: ricerca Moto (UI → parametri → catalogo/famiglie/versioni → trasporto → parser → filtri → metadati/cache → UI/paginazione), vetrine e parco Competitor, dettagli annuncio e schede tecniche Moto.it. Esaminati `fonti-salute`, deduplica in volo, pausa/ripartenza, timeout, limiti delle risposte, avvisi e cache. Moto.it non alimenta direttamente la ricerca Auto o Ricambi; i difetti della sua salute coinvolgono le diverse funzioni che interrogano Moto.it sulla stessa macchina. `detail.js` è condiviso anche con le altre fonti, ma le nuove prove riguardano Moto.it.

Non letti `.env` o archivi di autenticazione; dati/log di prova isolati. Nessuna modifica a cataloghi, WhatsApp o produzione. Nessun commit. Questo documento è l'unico file aggiunto dalla review nel repository.

## Findings confermati

### M01 — Alta: una richiesta in attesa parte dopo il 429 di un'altra

**Dove:** `backend/scrapers/motoit.js:50`, `backend/scrapers/motoit-models.js:37`, `backend/scrapers/motoit-ritmo.js:6`.

Il controllo della pausa precede `await ritmo.attendi()`. Due operazioni vengono ammesse quando la fonte è libera; la prima riceve 429; la seconda, dopo 1.501 ms nella prova, invia ugualmente la richiesta con la pausa attiva. Non era ancora una richiesta di rete in volo quando è arrivato il blocco.

**Prova:** `probe.cjs queue429`: due chiamate effettive, prima rigettata, seconda riuscita, pausa attiva. Controprova: una terza operazione nata dopo il 429 è correttamente fermata con `FONTE_IN_PAUSA` senza rete.

**Impatto:** ricerca Moto, menu, Competitor concorrenti. La pausa viene registrata ma non protegge il traffico già ammesso alla coda.

**Proposta:** ricontrollare l'ammissione attraverso `salute.richiesta` dopo l'attesa e immediatamente prima di `https.get`, preservando il contesto del solo tentativo di ripartenza. Contare solo le chiamate effettivamente inviate. Non basta controllare `fermo` manualmente: si rischia di rifiutare anche la richiesta che possiede la verifica.

### M02 — Media: 403 di menu, vetrine e dettagli non incrementano il blocco

**Dove:** `backend/scrapers/motoit-models.js:61`, `backend/competitor.js:391`, `backend/scrapers/detail.js:286`, `backend/fonti-salute.js:416`.

`erroreHttp` registra immediatamente il 429, non il 403. Il wrapper della ricerca principale registra anche il 403, mentre questi altri percorsi non lo fanno. `richiesta` registra il 403 soltanto durante una verifica di ripartenza.

**Prove:** `probe.cjs 403-menus`, `403-vetrina`, `403-detail`: tre rifiuti 403 consecutivi, tre richieste consentite, fonte ancora libera. Controprova `403-main-control`: la ricerca principale si ferma dopo due 403 e non manda la terza richiesta.

**Impatto:** menu/risoluzione Moto, parco Competitor, dettagli. La stessa fonte ha una protezione diversa a seconda dell'azione dell'utente.

**Proposta:** registrare ogni rifiuto HTTP nel punto che riceve lo status, prima di alterare o nascondere l'errore, come nel client Subito. Riutilizzare lo stesso oggetto Error: il WeakSet già presente evita doppio conteggio nel wrapper superiore. Per le risposte riuscite, conservare la validazione del contenuto prima di attestare la ripartenza.

### M03 — Media: un menu non valido riapre la fonte

**Dove:** `backend/scrapers/motoit-models.js:37`, `:71`, `:208`, `:256`.

Il tentativo sorvegliato da `salute.richiesta` termina dopo il parsing JSON. La verifica `result === 'OK'` e `Array.isArray(data)` arriva dopo. Alla scadenza di una pausa, `{result:'KO',data:null}` è JSON valido e riapre Moto.it; subito dopo il chiamante rifiuta lo stesso menu.

**Prova:** `probe.cjs menu-restart`, con orologio controllato: pausa scaduta → menu non riconoscibile → errore al chiamante, ma `fermo:false` e nessuna verifica residua. Non è una prova su un blocco reale del portale.

**Impatto:** tutte le funzioni Moto.it che condividono la salute; la risoluzione del catalogo può liberare prematuramente le ricerche.

**Proposta:** racchiudere anche la validazione semantica del menu nello stesso tentativo sorvegliato, come già fatto per ricerca e vetrina. `{result:'OK',data:[]}` deve restare un vuoto valido; dati malformati non devono sbloccare né entrare in cache. Preservare deduplica del menu e ammissione di una sola verifica concorrente.

### M04 — Media: un menu con involucro valido ma elementi cambiati diventa vuoto per 12 ore

**Dove:** `backend/scrapers/motoit-models.js:210`, `:258`, `:94`.

La nuova guardia valida l'involucro, non gli elementi. Un array non vuoto di oggetti con campi rinominati viene filtrato in `[]`, poi memorizzato come successo. Può significare «nessuna versione» o «nessun modello» pur avendo ricevuto elementi illeggibili.

**Prova:** `probe.cjs menu-partial`: risposta `{result:'OK',data:[{id:'code-nuovo',label:'Versione nuova'}]}`; due consultazioni restituiscono `[]` con una sola chiamata. Il TTL di questa cache è 12 ore. La modifica dello schema è simulata, non osservata sul portale oggi.

**Impatto:** risoluzione modelli/versioni Moto, anche nelle schede tecniche. Possibile ricerca più larga o incompleta basata su un catalogo apparentemente vuoto.

**Proposta:** distinguere opzioni segnaposto note, elementi utilizzabili ed elementi non riconosciuti. In caso di schema incompatibile, restituire un errore dichiarato e non memorizzare un elenco apparentemente completo. Non rendere illegali i segnaposto che il menu legittimamente contiene. Con elenco parziale, evitare di applicare silenziosamente un filtro versione ricavato soltanto dai superstiti.

### M05 — Media: l'avviso specifico per body troppo grande non arriva alla schermata

**Dove:** `backend/server.js:2311`, `frontend/app.js:4048`, `test/fonti-pausa-ui.test.js:198`.

Il trasporto produce `MOTO_BODY_TOO_LARGE` e `runSource` lo conserva. La costruzione di `sources.moto` omette però `erroreCodice`. Il frontend attende proprio quel campo per l'avviso specifico e per il motivo della pagina fallita. Nella prima ricerca rimane la pastiglia generica di errore.

**Prove:** `probe.cjs body-ui`, `ui-probes.cjs`: esecuzione della ricerca interna AMR, poi della funzione reale `renderSourceStatus` in VM. La risposta ha `status:'error'` ma nessun codice; il contenuto degli avvisi è vuoto. Il test esistente passa perché costruisce direttamente una risposta UI con il campo già presente, saltando il server.

**Impatto:** ricerca Moto, prima pagina e successive.

**Proposta:** inoltrare il codice in `sources.moto`, come per Subito/AutoScout; aggiungere una prova completa da errore del trasporto alla UI. Per gli altri errori Moto.it, mostrare una causa controllata e utile nell'area avvisi, senza riportare indiscriminatamente il testo remoto o dettagli interni.

### M06 — Media: risposte scartate continuano a scaricare

**Dove:** `backend/scrapers/motoit.js:69`, `backend/scrapers/motoit-models.js:56`, `backend/scrapers/detail.js:56`, `backend/scrapers/motoit-specs.js:57`.

Il redirect del nuovo trasporto usa `res.resume()` e toglie il timer della risposta precedente: il suo body può continuare mentre si segue la destinazione. I percorsi dettaglio/scheda usano ancora `resume()` anche dopo il rigetto del 429.

**Prove su server locale:** `local-transports.cjs redirect`: richiesta risolta sul target, ma oltre 5 MiB trasferiti dal body del redirect e socket ancora aperto. `detail-429`: 589.824 byte trasferiti dopo il rigetto osservato, socket ancora aperto e pausa correttamente attiva. Le prove interrompono esplicitamente i server dopo la misura; non dimostrano un accumulo in memoria dei body scartati.

**Impatto:** ricerca/menu/vetrine per i redirect; dettagli e schede per le risposte rifiutate. Banda e connessioni restano occupate da dati inutili.

**Proposta:** chiudere richiesta/risposta abbandonata prima del salto o dopo aver fissato l'errore HTTP, mantenendo `Retry-After` e deadline della catena. Gli eventi causati dalla chiusura volontaria non devono sostituire il risultato del target né registrare due rifiuti.

### M07 — Media: dettagli e schede tecniche restano fuori da ritmo, limite body e deadline assoluta

**Dove:** `backend/scrapers/detail.js:38`, `backend/scrapers/motoit-specs.js:37`, `frontend/app.js:4409`.

Le nuove protezioni sono in ricerca e menu, mentre questi due trasporti restano separati. Hanno un timeout di inattività, ma nessuna scadenza assoluta e nessun tetto al body. La tabella di confronto può avviare dettagli diversi in parallelo.

**Prova locale:** `local-transports.cjs detail-limits`: due dettagli partono a distanza di 13 ms; dettaglio e scheda accettano corpi da 3.145.728 byte. Il rischio di scarichi arbitrariamente lunghi è condizionato al comportamento della fonte; non è stato provocato un esaurimento memoria.

**Impatto:** dettagli e confronti nella ricerca Moto/Competitor, schede tecniche. Anche questi percorsi usano lo stesso IP e la stessa salute Moto.it.

**Proposta:** riusare la disciplina HTTP Moto.it anche per questi accessi, mantenendo i contratti dei chiamanti e la decompressione delle schede. Il tetto deve coprire i byte decompressi; va verificato su pagine di dettaglio/listino prima di trasferire automaticamente una misura fatta sulle liste. Un adattamento della sola fonte Moto.it evita di cambiare tutti gli scraper insieme.

### M08 — Media: prezzi legittimamente riservati diventano errore e fermano la paginazione

**Dove:** `backend/scrapers/motoit.js:359`, `backend/server.js:1199`, `frontend/app.js:2350`.

`sospettoPrezzi` considera illeggibile qualsiasi pagina con almeno tre prezzi nulli, compreso il caso esplicito `T.RISERVATA`. `runSource` la marca `error`; `fontiConAltri` non ammette fonti in errore, anche se `hasMore` è vero.

**Prova:** `ui-probes.cjs`: tre annunci validi con `T.RISERVATA`, totale 20 → tre righe conservate, `status:error`, `hasMore:true`, zero fonti caricabili. Controprova: un solo prezzo numerico nella stessa pagina ripristina `status:ok`. La pagina interamente a trattativa riservata è controllata, non osservata nella singola prova live.

**Impatto:** ricerca Moto, navigazione delle pagine, etichette del risultato.

**Proposta:** distinguere prezzo numerico, prezzo esplicitamente riservato/su richiesta, dato assente e dato illeggibile, analogamente agli stati preservati per Subito. Segnalare una vera anomalia di parsing senza trattare l'assenza legittima di prezzo come fallimento del download. Conservare annunci e possibilità di proseguire, senza inventare un prezzo.

### M09 — Media: nel confronto un dettaglio vuoto viene segnato come completato

**Dove:** `frontend/app.js:4416`, `backend/scrapers/detail.js:275`.

Fuori dalla verifica di ripartenza, il dettaglio può rispondere con soli valori nulli e array vuoti. `enrichMotoSpecs` imposta comunque `_detailLoaded = true`: ridisegnare il confronto non lo richiede più, anche dopo la scadenza della cache server. La marcatura dura nella vita dell'oggetto annuncio; una nuova ricerca può rimuoverla.

**Prova:** `ui-probes.cjs`, funzione frontend reale in VM: due richiami di arricchimento, una sola fetch, nessun dato utile, flag completato vero. L'altro percorso `enrichMotoRow` ha già un controllo dei dati effettivamente ottenuti.

**Impatto:** confronto annunci Moto, anche provenienti dal parco Competitor.

**Proposta:** distinguere completato/temporaneamente vuoto/in corso e non fissare il completamento in assenza di dati utili. Allinearsi alla logica già presente nell'apertura annuncio, mantenendo un'attesa o un retry esplicito per evitare che ogni render ripeta immediatamente la fetch.

## Rischio condizionato aggiuntivo

### C01 — Media: formati prezzo con centesimi sono letti in modo discordante

**Dove:** `backend/scrapers/motoit.js:151`, `backend/scrapers/motoit-vetrina.js:58`.

`probe.cjs prezzo` conferma che `5.000,50 €` diventa 5.000 nella ricerca e **500.050** nella vetrina, perché quest'ultima elimina ogni carattere non numerico. Nella fixture vera della vetrina e nella singola pagina live della ricerca ho visto prezzi interi: **non ho dimostrato che la fonte stia producendo questo formato oggi**. Non va presentato come prezzo attualmente sbagliato in produzione.

**Proposta:** un parser monetario esplicito e condiviso fra ricerca/vetrina, con prezzo sconosciuto se la forma non è interpretabile. Verificare separatori e centesimi senza trasformare cifre di rate o altro testo nel prezzo totale. Il parser dei km rimane distinto. Questa modifica si può valutare insieme a M08.

## Prove, controprove e limiti

- Suite pertinente: **115 test, 115 pass, 0 fail**. File: `motoit-ricerca`, `motoit-catalogo-locale`, `motoit-vetrina`, `motoit-versione`, `motoit-specs`, `detail-motoit-images`, `paginazione-fonti`, `fonti-pausa-ui`, `fonti-429-trasporti`, `competitor`.
- Primo tentativo della suite nel sandbox: cinque test non potevano aprire il server localhost (`EPERM`); rieseguita con il permesso necessario, tutti passati. Non classificati come bug dell'app.
- Prove aggiuntive riproducibili in `/private/tmp/amr-moto-review-20260928/`: `probe.cjs`, `ui-probes.cjs`, `local-transports.cjs`; ogni prova usa dati/log temporanei, disabilita dotenv quando carica il server e sostituisce il traffico remoto. Nessun ascolto di produzione.
- Un solo probe remoto riuscito, 28/09/2026 circa 01:34 Europe/Rome: `GET https://www.moto.it/moto-usate/ricerca?brand=kawasaki&model=kawasaki%7Cz-900&sort=price-a`. HTTP 200; 98.173 byte trasferiti compressi, **527.920 byte dopo decompressione**, 13 card, totale 259. Non confondere la dimensione di trasporto con la memoria necessaria al parser. Il corpo grezzo è stato eliminato; resta `live-summary.json` con dimensioni, struttura e soli campi numerici pertinenti. Nessun secondo tentativo sulla stessa ricerca. Prima della richiesta riuscita il sandbox non risolveva il DNS; nessuna risposta del portale, quindi nessun giudizio sulla fonte.
- Non ho cambiato il limite di 2 MiB: questa misura è inferiore e una pagina non dimostra un limite universale. Nessuna frequenza reale misurata per 403, 429 o cambiamenti dello schema.
- Non ripropongo «pagina successiva vuota con totale positivo» come bug in sé: una pagina oltre il fondo può essere legittimamente vuota. Non ho dimostrato perdite su quel caso nel codice attuale.
- Non ho riscontrato in questa verifica un nuovo aggiramento dell'allowlist verso host esterni nel trasporto ricerca/menu. Questo non certifica ogni futura risposta del portale.

## Ordine suggerito

Prima M01–M03 (blocco/ripartenza), poi M06–M07 (chiusura e risorse), M04–M05 (schema e avvisi), M08–M09 (correttezza della navigazione e del confronto). C01 può accompagnare M08, mantenendo distinta l'incertezza sul formato reale. Ogni intervento richiede prova prima/dopo e verifica della mancata regressione sui chiamanti della fonte.

## Risoluzione e seconda review — 28 settembre 2026

I finding sopra descrivono la baseline della review. La tabella seguente registra i fix **nell'albero di lavoro**, non ancora committati o distribuiti. Le modifiche Moto.it già presenti prima di questo intervento sono state conservate.

| Punto | Verifica della proposta e intervento | Prova di regressione |
|---|---|---|
| M01 | Confermata. Doppio controllo `salute.richiesta`: prima della coda e subito prima dell'invio; stesso contesto per la verifica di ripartenza. Attesa annullabile e compresa nella deadline. | Due richieste concorrenti, primo 429: una sola uscita HTTP; la seconda riceve `FONTE_IN_PAUSA`. Cancellazione durante l'attesa: nessun invio. |
| M02 | Confermata, completata con registrazione degli esiti validi dopo il parser. Gli errori HTTP Moto.it vengono registrati dal trasporto usando lo stesso Error, senza doppi incrementi nei chiamanti. | Menu, vetrine e dettagli si fermano dopo due 403. La sequenza 403 → menu valido → 403 non deve mettere in pausa: prova fallita prima del completamento del fix e passata dopo. |
| M03 | Confermata. La verifica comprende la validazione del menu. Estesa allo stesso difetto verificato nella pagina foto/versioni del listino. | Menu KO e pagina di manutenzione mantengono la pausa; menu vuoto valido e pagina modello riconoscibile la chiudono. Dedup delle chiamate al menu preservata. |
| M04 | Confermata. Gli elementi malformati invalidano il menu, senza conservare una lista parziale per 12 ore. Il segnaposto con `value` esplicitamente vuoto resta ammesso. | Un menu misto valido/malformato fallisce due volte con due chiamate, poi accetta il menu corretto. Il menu locale non cambia. |
| M05 | Confermata. `sources.moto` inoltra `erroreCodice`. La UI mostra il limite superato e cause controllate per gli altri errori Moto.it. | Ricerca interna del server → risposta reale → funzione frontend: avviso del body presente. Non basta più una fixture UI con il campo aggiunto a mano. |
| M06 | Confermata. Chiusura della risposta e della richiesta abbandonate, prima di seguire il redirect o dopo aver fissato l'errore HTTP; preservata la deadline della catena. | Server locali mantengono aperti body 302/429: il client chiude le connessioni. `Retry-After` e status non vengono sovrascritti dagli eventi della chiusura. |
| M07 | Confermata dopo misura su dettaglio e scheda. Riutilizzato il trasporto in `motoit-http.js` per ricerca, menu, vetrine, dettagli e listino. Limite di 2 MiB sui byte decompressi, deadline di 30 s, ritmo condiviso, allowlist a ogni salto. | Dettagli/schede attraversano la coda; gzip valido letto; 3 MiB decompressi rifiutati; stream attivo interrotto dalla deadline. I fetch condivisi di menu/dettagli non ereditano l'annullamento di un singolo consumatore. |
| M08 | Confermata. Prezzi numerici, riservati, assenti e illeggibili rimangono distinti. Gli ultimi producono avvisi senza trasformare una pagina ricevuta in un download fallito. Stessi campi già usati da Subito. | Tre prezzi `T.RISERVATA`: stato `ok`, righe preservate e fonte ancora ammessa a «Carica altro». Prezzi illeggibili: avviso e navigazione preservati. |
| M09 | Confermata. Completamento solo con dati utili; dedup in volo per riga, attesa di 15 minuti per il vuoto (TTL server) e di 30 secondi per il fallimento. Nessun timer avvia rete automaticamente. | Due render concorrenti fanno una sola fetch; il vuoto non completa la riga; dopo l'attesa un risultato valido la arricchisce. |
| C01 | Parser monetario condiviso tra ricerca e vetrina, applicato insieme a M08. Rimane condizionata l'affermazione sulla presenza reale dei centesimi nella fonte. | `5.000,50 €` produce 5000.5 in entrambi i percorsi; `4.300 euro` preserva il formato della fixture reale; rate/testo incompatibile non diventano prezzi numerici. |

### Confronto con Subito e AutoScout

- Dal loro trasporto: fissare subito l'esito HTTP, chiudere la presa rifiutata, conservare lo stesso Error nel conteggio, usare un limite esplicito con errore riconoscibile.
- Dalla gestione Subito: stati `prezzoSuRichiesta` e `prezzoIlleggibile`, conservazione dell'annuncio, avviso distinto da una pagina non ricevuta. Le vetrine Moto.it inoltrano l'avviso anche al parco Competitor.
- Dalla risposta AutoScout: codice/tipo/status dell'errore arrivano alla UI con messaggi controllati.
- Specificità Moto.it: attesa condivisa prima dell'invio e parsing HTML/JSON da includere nella verifica di ripartenza. Un semplice HTTP 200 non basta.

Non è stata necessaria una soluzione di prodotto alternativa alle proposte approvate. La concentrazione dei quattro trasporti nello stesso modulo è il riuso previsto da M07, con adattatori limitati a Moto.it; i percorsi dettaglio delle altre fonti restano invariati.

### Controlli finali ed evidenze

- **635 test passati, 0 falliti, 0 saltati**, in 44 file pertinenti: Moto.it, Subito, AutoScout, Ricambi, Competitor, pause/ripartenza, dettagli, paginazione, cache, scheda tecnica e integrità. Esecuzione con credenziali disabilitate, dati/log temporanei e rete esterna vietata; i test HTTP usano localhost o socket in memoria.
- Regressioni aggiunte in `test/motoit-protezioni.test.js` e `test/fonti-pausa-ui.test.js`. Adeguati i mock preesistenti affinché rappresentino `destroy()` di Node; mantenute le asserzioni su errori, retry e sicurezza. Il controllo del segnale in `silenzi-fonti` segue ora il trasporto estratto.
- Review successiva: corretto il mancato reset dei 403 dopo un menu valido; validata anche la pagina foto/versioni prima della ripartenza; preservata la valuta scritta `euro` presente nella fixture della vetrina. Nessuno di questi casi è stato trattato come risolto sulla sola base della lettura del codice.
- Campioni live, distanziati di almeno 15 s, senza conservare body o dati del venditore: menu JSON riconosciuto; pagina modello leggibile; dettaglio HTTP 200 **542.336 byte decompressi** (102.876 trasferiti), scheda tecnica HTTP 200 **601.654 byte decompressi** (105.230 trasferiti). Il dettaglio ha campi riconoscibili, la scheda cinque tabelle. La scheda richiede un redirect, anch'esso distanziato. Questi campioni non garantiscono la dimensione di ogni pagina futura.
- Script e log della verifica: `/private/tmp/amr-moto-fix-20260928/`, in particolare `run-suite.cjs`, `no-network.cjs`, `suite-final2.log`, `live.cjs` e `live-summary.json` (ultimi due campioni). Il primo tentativo di autorizzazione automatica del comando esteso è scaduto; l'esecuzione separata è riuscita. Non era un esito del software.
- `git diff --check` superato. Nessun commit, deploy o accesso all'M2 effettuato in questo intervento. Nessuna certificazione dell'intera applicazione o della futura stabilità della fonte.
