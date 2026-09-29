# Web app centrale e nodi residenziali — analisi iniziale

29 settembre 2026. Bozza di lavoro; non autorizza un deploy e non modifica l'M2. Prima coppia di nodi prevista: iMac di sviluppo e M2 già in produzione. Futuri nodi fisici, eventualmente Raspberry Pi.

## Vincolo e obiettivo

L'ipotesi operativa è che le ricerche verso Subito, AutoScout24 e Moto.it debbano uscire da reti residenziali. La web app deve essere unica per i clienti e i nodi devono essere gestibili da una UI. Il frontend, gli account e l'autorizzazione dei moduli possono stare al centro; l'uscita verso i portali deve restare sui nodi. Una VM locale in NAT non crea un nuovo IP pubblico residenziale.

## Punto di taglio verificato nel codice

- `backend/server.js` espone `GET /api/search` e `runSearchCore`: risolve cataloghi, famiglie, versioni e fallback all'interno delle API, richiama le tre fonti, filtra e costruisce la risposta per il frontend. `backend/ricerca-auto.js` e `backend/ricerca-moto.js` preparano parti dei parametri.
- `backend/scrapers/subito-api.js`, `autoscout-graphql.js` e `motoit.js` fanno le richieste dal processo Node. Per Moto.it la ricerca legge HTML; le altre due usano endpoint JSON/GraphQL.
- `backend/fonti-salute.js` conserva per macchina le pause delle fonti in memoria e in SQLite. Una pausa Subito sull'iMac non deve fermare per errore Subito sull'M2, né essere ignorata dallo scheduler centrale.
- `backend/server.js` usa cache e lavori in volo locali al processo; la paginazione Subito, i retry AutoScout e il recupero di pagine parziali dipendono anche da stato temporaneo nel browser e nel processo. Spostare un clic successivo su un altro nodo può cambiare il significato dei cursori o ripetere richieste.
- `backend/accesso-route.js` e `backend/utenti-db.js` sono costruiti per un'installazione con file auth e database locali. Non sono ancora identità, licenze e isolamento multi-azienda della web app centrale.

## Prima architettura da provare

Browser -> web app centrale -> coda di richieste -> nodo residenziale -> fonti. Il nodo restituisce risultati normalizzati, stato per fonte e cursori; il centro li inoltra al browser. I nodi aprono **solo connessioni in uscita** verso il centro per ricevere lavori e consegnare risposte. Il centro non invia ai portali alcuna ricerca. Il centro non conserva body grezzi o annunci come archivio; il proprietario ha confermato il transito temporaneo dei risultati attraverso il centro.

**Primo taglio proposto:** assegnare l'intera ricerca Auto/Moto a un nodo, mantenendo insieme risoluzione cataloghi, chiamate alle tre fonti, filtri e normalizzazione. Dividere subito per singola fonte aumenterebbe i cambiamenti proprio nelle regole di corrispondenza già collaudate. Il nodo deve usare la stessa revisione dei cataloghi e un protocollo compatibile con la UI; una versione incompatibile non riceve lavori.

Lo scheduler centrale autorizza azienda, persona e modulo prima di accodare il lavoro. Il proprietario ha scelto un **pool condiviso** per i primi nodi; la scelta usa disponibilità, capacità e salute delle fonti **di quel nodo**. Tutti i clienti su uno stesso nodo condividono il suo IP e i suoi limiti: separare le code per account non elimina il limite della fonte sull'IP. Il primo prototipo può ammettere una sola ricerca completa per nodo alla volta, da aumentare solo dopo misure.

Il proprietario ha scelto il **failover controllato**. Pagine successive e retry restano assegnati allo stesso nodo finché il contesto della ricerca è vivo. Se quel nodo sparisce dopo aver consegnato pagine, non si finge una continuazione su un altro nodo: occorre dichiarare l'interruzione e ripartire esplicitamente, salvo prova che un failover preservi cursori e copertura. Prima della prima pagina, un lavoro non iniziato può essere riassegnato; un lavoro iniziato richiede prova di idempotenza prima di essere ripetuto altrove.

Ogni nodo ha un'identità propria e una credenziale revocabile, comunica su TLS e accetta solo lavori emessi dal centro. Il centro associa ogni risposta all'ID del lavoro e al nodo assegnato, scarta risposte tardive o duplicate e non concede al nodo il potere di dichiarare i moduli acquistati dall'utente. Il payload verso il nodo contiene solo i parametri necessari alla ricerca, senza password o dati di fatturazione.

## Sequenza di implementazione proposta

1. Baseline su iMac e M2 con dati di prova: versione Node, architettura CPU, memoria, IP pubblico d'uscita, tempo e numero di richieste per una ricerca rappresentativa. Nessuna modifica al servizio M2.
2. Definire e testare un contratto `lavoro -> risultato` che preservi esattamente la risposta attuale di `/api/search`, inclusi stati delle fonti e cursori. Prima prova con processo coordinatore e processo nodo entrambi sull'iMac, senza rete pubblica.
3. Aggiungere registrazione e heartbeat dei due nodi, coda minima, assegnazione di una ricerca intera, timeout, identità del nodo e gestione del risultato tardivo. Usare richieste sintetiche per verificare doppioni, caduta del nodo e pause 429.
4. Collegare l'iMac come primo nodo remoto in test. Il proprietario ha deciso di **tenere l'M2 fuori dal traffico clienti nel primo prototipo**: affiancarlo solo dopo isolamento, backup e possibilità di spegnere il nuovo agente senza toccare il servizio esistente.
5. Creare la web app centrale multi-azienda con login, diritti per modulo e UI operatore per vedere disponibilità, versione, salute e carico dei nodi. Nessun cliente entra finché isolamento, backup e rollback non sono provati.
6. Solo dopo due nodi stabili, preparare immagine/installer per Raspberry Pi con OS a 64 bit, Node e dipendenze testati sulla CPU reale; aggiornamenti progressivi e rollback per nodo.

## Decisioni ancora aperte

- Collocazione del centro: **cloud separato dall'M2** (decisione confermata); provider ancora da scegliere.
- **Transito temporaneo** dei risultati attraverso il centro autorizzato, senza archivio centrale (decisione confermata).
- Failover controllato autorizzato; il contratto preciso per un lavoro iniziato e per pagine già consegnate resta da provare.
- Pool dei primi nodi **condiviso fra aziende** (decisione confermata); le cache e le risposte devono comunque restare isolate per account/azienda.
- M2 **fuori dal traffico clienti durante il primo prototipo**; ingresso solo dopo collaudo isolato (decisione confermata).
- Capacità per nodo, numero di ricerche simultanee, intervallo di heartbeat, durata del contesto di ricerca e politica di conservazione dei soli metadati operativi: scegliere con misure, non numeri inventati.

## Criterio del primo prototipo

Una stessa ricerca di prova sul processo monolitico e sul nodo locale produce lo stesso contratto di risposta, senza chiamate ulteriori alle fonti; 429 e pause restano per nodo; una risposta ritardata non sostituisce una ricerca più recente; nessun lavoro ripete in silenzio una pagina già consegnata. In seguito si prova iMac e M2 senza interrompere la produzione.

## Decisioni dell'intervista prima della fase 2

- Iniziare con un'estrazione **interna** del coordinatore, mantenendo invariati `/api/search` e la risposta del frontend. Verificare ogni sotto-task prima di proseguire. Il primo prototipo a due processi dovrà poi coprire ricerca Auto/Moto, menu e dettagli; non basta dimostrare solo la ricerca.
- Se un nodo si disconnette dopo che una richiesta potrebbe essere partita, dichiarare l'esito incerto e richiedere un nuovo tentativo esplicito. Non ripetere automaticamente una chiamata di cui non si conosce l'esecuzione.
- Se un nodo riceve 429 da una fonte mentre le altre riescono, provare brevemente **solo quella fonte** su un nodo idoneo. Poi mostrare il risultato completo, oppure le altre fonti con un avviso di parzialità. Il tempo d'attesa va misurato e definito durante il prototipo.
- Il primo pannello Admin mostra lo stato di ciascuna fonte per nodo e i lavori in corso. Durante il prototipo gira solo su localhost, con identità di prova e nessuna porta pubblica.
- La diagnostica può conservare filtri della ricerca e metadati operativi, mai risultati o annunci. Cancellare i filtri automaticamente dopo sette giorni; la struttura esatta dei metadati va definita prima di registrarli.
