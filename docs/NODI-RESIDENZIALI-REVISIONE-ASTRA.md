# Revisione della risposta di Astra sui nodi residenziali

29 settembre 2026. Questa nota conserva la revisione del piano in
`docs/NODI-RESIDENZIALI-ARCHITETTURA.md` e il successivo controllo critico della
risposta di Astra. È contesto per la discussione, non un'autorizzazione a
modificare AMR o a intervenire sull'M2.

## Decisioni dell'utente già confermate

- Una web app centrale in un cloud separato; provider ancora da scegliere.
- Pool di nodi residenziali gestiti da noi: prima iMac, M2 solo dopo collaudo
  isolato, in futuro eventualmente Raspberry Pi.
- I risultati possono transitare temporaneamente dal centro al browser, senza
  diventare un archivio centrale.
- Failover controllato. Nessuna pagina già consegnata va ripetuta in silenzio.
- M2 fuori dal traffico dei clienti nel primo prototipo e nessuna modifica alla
  sua produzione senza istruzione esplicita.

## Verifica punto per punto della risposta

1. **Percorso Auto/Moto — verificato, ma il confine è più ampio di `/api/search`.**
   Il frontend operativo è in `scripts/frontend-parts/`; `backend/server.js`
   valida la ricerca, consulta cataloghi e ponti, chiama le tre fonti, filtra e
   costruisce il contratto. Alcuni menu Moto.it possono chiamare la rete e
   `/api/detail` chiama le fonti. I job sul nodo devono comprendere anche questi
   percorsi, oppure il centro deve servirli da dati locali completi e verificati.
   Riferimenti: `scripts/frontend-parts/catalog-ui.js`,
   `scripts/frontend-parts/search.js`, `backend/server.js:295,390,523,706`,
   `backend/scrapers/motoit-models.js:154`, `backend/dettaglio-route.js:8`.

2. **Ricerca completa su un nodo — vantaggio strutturale verificato, risultato
   futuro condizionato.** Cataloghi, equivalenze fra fonti, riallargamento e
   risposta sono accoppiati nel percorso attuale. Mantenere quel coordinamento
   nello stesso processo riduce i nuovi contratti tra processi. Questo NON prova
   che estrarlo da `server.js` sia facile, né che la ricerca distribuita abbia
   già la stessa copertura. `_amrSearchFn` non è il contratto di `/api/search`:
   cambia la validazione della regione e omette campi della risposta
   (`backend/server.js:767-779`). Serve un confronto fra richieste e risposte
   serializzate del monolite e del prototipo.

3. **Una ricerca non è una richiesta upstream — verificato.** AutoScout può
   eseguire chiamate parallele per più grafie e tentativi successivi quando la
   versione non trova risultati (`backend/server.js:54-95,557-574`). Anche
   Moto.it può interrogare più famiglie durante la preparazione della versione
   (`backend/ricerca-moto.js:40-78`). Una sola operazione per nodo non è quindi
   un limite sufficiente di chiamate per fonte. Capacità e ritmo vanno misurati
   sul traffico effettivo, non inferiti dal numero di job.

4. **Salute condivisa per macchina — smentito nell'implementazione attuale.**
   Lo stato operativo è una Map per processo caricata dal database SQLite
   (`backend/fonti-salute.js:131-167`). Prova con due processi e lo stesso DB
   temporaneo: dopo un 429 nel processo A, il processo B già avviato non vedeva
   la pausa; una nuova istanza la leggeva. Questo non invalida il funzionamento
   del singolo processo. Sul medesimo IP pubblico, produzione M2 e agente nuovo
   necessitano di una sola autorità di ammissione per fonte, o di una separazione
   dell'uscita verificata. Due Raspberry sullo stesso router possono avere lo
   stesso problema. Non è dimostrato che i portali limitino sempre e solo l'IP.

5. **Pool e throughput — condizionati.** Due nodi possono aumentare la capacità
   se le loro uscite e le risorse sono indipendenti e la fonte le tratta in modo
   utile. Due macchine non provano né due IP indipendenti né il raddoppio del
   throughput. Con un nodo occupato o in pausa, assegnare l'intera ricerca a
   un altro nodo è semplice solo se il suo stato è noto e il job non è già
   partito.

6. **Failover senza duplicare chiamate — non dimostrato per lavori iniziati.**
   ID del lavoro e del tentativo possono impedire una doppia pubblicazione.
   Dopo la chiamata alla fonte e prima della consegna del risultato, la caduta
   del collegamento lascia il centro incerto se la fonte sia già stata chiamata.
   Un replay automatico può produrre una seconda chiamata. Pagine già
   consegnate e tentativi incerti vanno dichiarati; riassegnare è sicuro solo
   quando è accertato che l'esecuzione non è iniziata. Il vincolo allo stesso
   nodo aiuta a riusare cache e porzioni riuscite, ma non congela l'ordine degli
   annunci del portale.

7. **Annullamento remoto — lavoro nuovo verificato.** `runSource` crea un nuovo
   AbortController (`backend/server.js:219-228`). In una prova controllata il
   segnale esterno è stato annullato senza annullare il lavoro interno; il
   timeout interno ha invece funzionato. Il protocollo dovrà definire la
   scadenza dell'intero job e propagare il segnale fino alle richieste di rete.
   Non si può ritirare una richiesta già arrivata al portale.

8. **Cache temporanee — distinzione verificata.** La cache delle ricerche non
   riutilizza una voce dopo tre minuti, ma una voce scaduta e inattiva può
   restare in memoria fino a nuova attività/espulsione; la Map è limitata a 50
   voci (`backend/server.js:330-380`). Questo non prova una crescita illimitata.
   Il prodotto deve distinguere validità, rimozione effettiva, stato necessario
   ai retry e log. Il requisito di non creare un archivio centrale riguarda
   anche backup, log e strumenti di osservazione del centro.

9. **Isolamento — base locale verificata, multi-azienda ancora da costruire.**
   `_cacheScope` usa l'utente (`backend/server.js:302`); la persistenza per
   persona filtra per identità. Mancano però un'autorità centrale per azienda,
   moduli acquistati e job, e un collegamento server-side tra job e tenant.
   Un ID azienda presente nel payload non deve essere accettato come prova di
   autorizzazione. L'agente deve ricevere solo comandi tipizzati verso fonti
   consentite, non URL liberi o istruzioni di shell.

10. **Connessioni in uscita — vantaggio condizionato.** Evitano una porta
    pubblica sul nodo. Non rendono sicuro da sole il canale: autenticazione
    revocabile del nodo, TLS, validazione dei job, limiti, risposta legata al
    tentativo assegnato e rotazione delle credenziali sono ancora da progettare.

11. **Tre tagli architetturali — verdetto provvisorio.** Motore completo sul
    nodo richiede meno confini semantici nuovi, ma un nodo lento trattiene
    l'intera operazione. Una fonte per nodo permette di sfruttare meglio salute
    e capacità specifiche, ma richiede di separare con prove i ponti, i
    riallargamenti, i cursori e gli stati parziali. App completa per nodo
    conserva meglio l'attuale installazione locale, ma duplica UI, accesso,
    dati e distribuzione proprio mentre si vuole una web app centrale. Non ci
    sono misure di costi o prestazioni sufficienti per dichiarare ottimale una
    delle tre nel lungo periodo. Motore completo è il primo esperimento.

12. **Compatibilità e versioni — requisito condizionato.** Codice, cataloghi,
    mappature e protocollo vanno versionati come una release compatibile. Un
    nuovo job non deve essere assegnato a un nodo incompatibile. L'aggiornamento
    di un nodo con job e pagine in corso richiede drain, prova di rollback e
    regole sui contesti già avviati. Il funzionamento su Raspberry Pi resta da
    verificare sulla CPU/OS reali.

## Prima prova in grado di smentire il taglio scelto

Eseguire centro e agente come due processi sull'iMac, usando risposte HTTP
controllate delle fonti e una vera serializzazione dei messaggi. Confrontare
col monolite query effettive, ID, ordine, risultati, metadati per fonte,
versioni, cursori e numero di chiamate. Includere menu che richiedono rete,
dettagli, pagina successiva, riallargamenti, 429, retry parziale, due aziende
fittizie, risposta tardiva, riavvio del nodo e caduta del collegamento prima
e dopo l'inizio della chiamata upstream. L'esperimento fallisce se diverge la
ricerca senza motivo dichiarato, si ripete una chiamata in silenzio, una pausa
viene aggirata o un risultato passa all'azienda sbagliata.

Solo dopo: poche prove live dall'iMac, almeno 15 secondi fra ricerche sulla
stessa piattaforma e nessuna ricerca ripetuta inutilmente dello stesso
veicolo. Nessun coinvolgimento operativo dell'M2 senza collaudo isolato,
coordinamento della salute sul suo IP, backup/rollback verificati e istruzione
esplicita del proprietario.

## Punti ancora da decidere insieme

1. Dove far risiedere l'autorità che ammette le richieste a ciascuna fonte
   quando due processi condividono la stessa uscita.
2. Comportamento visibile all'utente per un job iniziato con esito incerto e
   per una pagina successiva impossibile da recuperare.
3. Confine e contratto del primo prototipo: motore puro estratto dal server,
   job separati per menu/dettaglio e rappresentazione del contesto temporaneo.
4. Dati e durata minimi dei log operativi, compatibili con l'assenza di un
   archivio di annunci al centro.
5. Misure che giustificherebbero in futuro la divisione per fonte e quelle
   necessarie prima di aggiungere l'M2.

Prove locali del 29 settembre: 50 test selezionati di paginazione/retry/fonti
passati; riproduzioni controllate in
`/private/tmp/amr-nodi-review-20260929/prove.cjs` e `prove.json`. Queste prove
non includono traffico live, cloud né M2. Gli script in `/private/tmp` non sono
parte permanente del repository; le conclusioni e i loro limiti sono salvati
qui per i prossimi giri di compact.
