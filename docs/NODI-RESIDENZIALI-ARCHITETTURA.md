# Web app centrale e nodi residenziali — analisi iniziale

29 settembre 2026. Bozza di lavoro; non autorizza un deploy e non modifica l'M2. Prima coppia di nodi prevista: iMac di sviluppo e M2 già in produzione. Futuri nodi fisici, eventualmente Raspberry Pi.

## Vincolo e obiettivo

L'ipotesi operativa è che le ricerche verso Subito, AutoScout24 e Moto.it debbano uscire da reti residenziali. La web app deve essere unica per i clienti e i nodi devono essere gestibili da una UI. Il frontend, gli account e l'autorizzazione dei moduli possono stare al centro; l'uscita verso i portali deve restare sui nodi. Una VM locale in NAT non crea un nuovo IP pubblico residenziale.

## Punto di taglio verificato nel codice

- `backend/server.js` espone `GET /api/search`, valida i parametri e applica i limiti. `backend/ricerca-coordinatore.js` risolve cataloghi, famiglie e versioni, richiama le tre fonti, filtra e costruisce la risposta per il frontend. `backend/ricerca-auto.js` e `backend/ricerca-moto.js` preparano parti dei parametri.
- `backend/scrapers/subito-api.js`, `autoscout-graphql.js` e `motoit.js` fanno le richieste dal processo Node. Per Moto.it la ricerca legge HTML; le altre due usano endpoint JSON/GraphQL.
- `backend/fonti-salute.js` conserva per macchina le pause delle fonti in memoria e in SQLite. Una pausa Subito sull'iMac non deve fermare per errore Subito sull'M2, né essere ignorata dallo scheduler centrale.
- `backend/ricerca-coordinatore.js` usa cache e lavori in volo locali al processo; la paginazione Subito, i retry AutoScout e il recupero di pagine parziali dipendono anche da stato temporaneo nel browser e nel processo. Spostare un clic successivo su un altro nodo può cambiare il significato dei cursori o ripetere richieste.
- `backend/accesso-route.js` e `backend/utenti-db.js` sono costruiti per un'installazione con file auth e database locali. Non sono ancora identità, licenze e isolamento multi-azienda della web app centrale.

## Prima architettura da provare

Browser -> web app centrale -> coda di richieste -> nodo residenziale -> fonti. Il nodo restituisce risultati normalizzati, stato per fonte e cursori; il centro li inoltra al browser. I nodi aprono **solo connessioni in uscita** verso il centro per ricevere lavori e consegnare risposte. Il centro non invia ai portali alcuna ricerca. Il centro non conserva body grezzi o annunci come archivio; il proprietario ha confermato il transito temporaneo dei risultati attraverso il centro.

**Primo taglio scelto:** assegnare l'intera ricerca Auto/Moto a un nodo quando questo puo' servirne tutte le fonti. Quel nodo resta il coordinatore e assembla filtri, conteggi e avvisi. Se nessun nodo puo' servire tutte le fonti, il centro affida le fonti mancanti ad altri nodi e ne riporta l'esito al coordinatore; lo stesso vale per una sola fonte che risponda 429, con al massimo un nodo alternativo per operazione. Questa composizione richiede un contratto per i risultati di singola fonte e una prova di equivalenza con la risposta attuale: non basta concatenare gli annunci. I nodi devono usare la stessa revisione dei cataloghi e un protocollo compatibile con la UI; una versione incompatibile non riceve lavori.

Lo scheduler centrale autorizza azienda, persona e modulo prima di accodare il lavoro. Il proprietario ha scelto un **pool condiviso** per i primi nodi; la scelta usa disponibilità, capacità e salute delle fonti **di quel nodo**. Tutti i clienti su uno stesso nodo condividono il suo IP e i suoi limiti: separare le code per account non elimina il limite della fonte sull'IP. Il primo prototipo può ammettere una sola ricerca completa per nodo alla volta, da aumentare solo dopo misure.

Il proprietario ha scelto il **failover controllato**. Pagine successive e retry restano di norma assegnati al nodo della rispettiva fonte. Prima di richiedere una nuova pagina, il centro ne verifica la disponibilita': se manca, prova quella pagina su un altro nodo e avvisa che lo spostamento puo' cambiare la copertura (le pagine delle fonti non sono fotografie immutabili). Una richiesta gia' partita il cui esito e' sconosciuto non viene ripetuta automaticamente. Prima della prima pagina, un lavoro non iniziato puo' essere riassegnato.

Ogni nodo ha un'identità propria e una credenziale revocabile, comunica su TLS e accetta solo lavori emessi dal centro. Il centro associa ogni risposta all'ID del lavoro e al nodo assegnato, scarta risposte tardive o duplicate e non concede al nodo il potere di dichiarare i moduli acquistati dall'utente. Il payload verso il nodo contiene solo i parametri necessari alla ricerca, senza password o dati di fatturazione.

## Sequenza di implementazione proposta

1. Baseline sull'iMac con dati di prova: versione Node, architettura CPU, memoria, IP pubblico d'uscita, tempo e numero di richieste per una ricerca rappresentativa. L'M2 resta fuori fino al collaudo del prototipo sull'iMac.
2. Definire e testare un contratto `lavoro -> risultato` che preservi esattamente la risposta attuale di `/api/search`, inclusi stati delle fonti e cursori. Prima prova con centro e nodo in due processi sull'iMac, senza rete pubblica.
3. Aggiungere registrazione e heartbeat del nodo reale e di quello simulato, coda minima, assegnazione della ricerca, timeout e gestione del risultato tardivo. Usare risposte simulate per verificare doppioni, caduta del nodo, pause 429 e composizione da piu' nodi.
4. Solo dopo il collaudo sull'iMac, preparare l'M2 come secondo nodo reale in un processo isolato, con backup e possibilita' di spegnerlo senza toccare il servizio AMR gia' in produzione.
5. Dopo il prototipo locale, creare la web app centrale multi-azienda con login effettivo, diritti per modulo e UI operatore per vedere disponibilita', versione, salute e carico dei nodi. Nessun cliente entra finche' isolamento, backup e rollback non sono provati.
6. Solo dopo due nodi stabili, preparare immagine/installer per Raspberry Pi con OS a 64 bit, Node e dipendenze testati sulla CPU reale; aggiornamenti progressivi e rollback per nodo.

## Decisioni ancora aperte

- Collocazione del centro: **cloud separato dall'M2** (decisione confermata); provider ancora da scegliere.
- **Transito temporaneo** dei risultati attraverso il centro autorizzato, senza archivio centrale (decisione confermata).
- Failover controllato autorizzato; il contratto tecnico per il passaggio di una singola fonte fra nodi e la ricomposizione della risposta resta da progettare e provare.
- Pool dei primi nodi **condiviso fra aziende** (decisione confermata); le cache e le risposte devono comunque restare isolate per account/azienda.
- M2 **fuori dal traffico clienti durante il primo prototipo**; ingresso solo dopo collaudo isolato (decisione confermata).
- Capacità per nodo, numero di ricerche simultanee, intervallo di heartbeat, durata del contesto di ricerca e politica di conservazione dei soli metadati operativi: scegliere con misure, non numeri inventati.

## Criterio del primo prototipo

Una stessa ricerca di prova sul processo monolitico e sul nodo locale produce lo stesso contratto di risposta, senza chiamate ulteriori alle fonti; 429 e pause restano per nodo; una risposta ritardata non sostituisce una ricerca più recente; nessun lavoro ripete in silenzio una pagina già consegnata. In seguito si prova iMac e M2 senza interrompere la produzione.

## Decisioni dell'intervista prima della fase 2

- L'estrazione **interna** del coordinatore e' stata eseguita unitariamente in `backend/ricerca-coordinatore.js`, mantenendo invariati `/api/search` e la risposta del frontend. Il primo prototipo a due processi dovra' coprire ricerca Auto/Moto, menu e dettagli; non basta dimostrare solo la ricerca. La precedente indicazione di spostare il codice per piccole porzioni e' superata.
- Se un nodo si disconnette dopo che una richiesta potrebbe essere partita, dichiarare l'esito incerto e richiedere un nuovo tentativo esplicito. Non ripetere automaticamente una chiamata di cui non si conosce l'esecuzione.
- Se un nodo riceve 429 da una fonte mentre le altre riescono, provare brevemente **solo quella fonte** su un nodo idoneo. Poi mostrare il risultato completo, oppure le altre fonti con un avviso di parzialità. Il tempo d'attesa va misurato e definito durante il prototipo.
- Il primo pannello Admin mostra lo stato di ciascuna fonte per nodo e i lavori in corso. Durante il prototipo gira solo su localhost, con identità di prova e nessuna porta pubblica.
- La diagnostica può conservare filtri della ricerca e metadati operativi, mai risultati o annunci. Cancellare i filtri automaticamente dopo sette giorni; la struttura esatta dei metadati va definita prima di registrarli.

## Decisioni dell'intervista sul prototipo centro–nodo

- Primo collaudo sull'iMac: centro e un nodo reale come processi separati, secondo nodo simulato per assegnazione e failover. Interfaccia minima su localhost con filtri liberi e scenari di prova; due aziende fittizie con moduli diversi e identita' di test locali. Per provare anche la condivisione di una ricerca identica, entrambe devono avere almeno un modulo in comune (per esempio Auto+Moto e solo Moto). L'M2 entra soltanto dopo il collaudo sull'iMac; nessun cambiamento al suo servizio durante il prototipo iniziale.
- Il centro autorizza il modulo e assegna i lavori. Una chiamata della **prima pagina** puo' essere condivisa fra aziende solo quando la ricerca e' identica in tutti i parametri effettivi; pagine successive e retry non sono condivisi. Ogni azienda riceve comunque una risposta e uno stato di lavoro separati.
- Ogni nodo mantiene lo stato della propria fonte e lo comunica al centro, che usa la vista aggregata per assegnare i lavori. L'Admin mostra fonti per nodo e lavori in corso e puo' sospendere manualmente nodo o fonte. La sospensione ferma nuove assegnazioni e lascia terminare le chiamate gia' partite; non annulla anticipatamente una pausa automatica da 429.
- Se il browser si chiude, le chiamate gia' partite terminano e la risposta viene scartata. Se cade il collegamento nodo–centro dopo l'accettazione di un lavoro, il nodo tenta di interromperlo: l'annullamento non prova che il portale non abbia ricevuto la richiesta. Il centro dichiara l'esito incerto e non ripete automaticamente il lavoro. Un eventuale risultato tardivo serve solo alla diagnostica; la persona puo' chiedere un nuovo tentativo esplicito.
- Se il centro si riavvia, la coda non viene ripresa automaticamente. I lavori non ancora assegnati risultano interrotti e quelli gia' iniziati risultano incerti; non devono sparire senza un esito comprensibile all'utente. La diagnostica conserva soltanto i metadati operativi e i filtri per sette giorni, mai annunci o body delle fonti.
- Restano da misurare timeout, capacita' e frequenza degli aggiornamenti di stato. Il collaudo deve provare anche il rifiuto di un modulo non abilitato, la risposta tardiva, il riavvio del centro e la continuita' della paginazione dopo riassegnazione con avviso.

## Decisioni del 30 settembre sulla diagnostica e sul collegamento M2

- Il pannello locale sull'iMac mostra sempre nodi, lavori, eventi e tempi operativi, senza una falsa identita' «Operatore». I comandi di sospensione e di export sono disponibili soltanto nel prototipo che ascolta su localhost; la modalita' Admin e' disattivata per impostazione predefinita. Le identita' fittizie A/B servono solo per provare i moduli della ricerca. Il selettore del nodo cambia **cosa osservare**, mai l'identita' con cui eseguire la ricerca.
- Il centro definitivo sara' ospitato separatamente; il provider non e' stato scelto. I nodi residenziali apriranno una connessione in uscita verso il centro, senza porte pubbliche sull'iMac o sull'M2. Prima di esporre il centro servono autenticazione reale dell'Admin, TLS, identita' dei nodi e autorizzazione delle aziende: il login fittizio e l'Admin locale non sono utilizzabili su Internet.
- La prima prova con l'M2 comprende soltanto connessione, stato e cataloghi; nessuna chiamata ai portali. Il processo del nodo verra' avviato manualmente via SSH, separato dal servizio AMR esistente, e fermabile subito. L'M2 resta fuori fino al collaudo dell'iMac.
- I cataloghi dell'iMac e dell'M2 sono identici, ma il codice AMR installato e' diverso. L'uguaglianza dei cataloghi non dimostra compatibilita': centro e worker devono concordare versione del protocollo e comportamento della ricerca. Un eventuale worker M2 compatibile va installato separatamente dal monolite in produzione. Prima di ricerche live sullo stesso IP dell'M2, le pause delle fonti del worker vanno coordinate con quelle dell'AMR di produzione.
- Le misure locali separano tempo di assegnazione, attesa in coda e durata del lavoro sul nodo. La differenza tra presa in carico e arrivo dell'esito al centro include trasporto, serializzazione e ritorno; non e' una misura pura della latenza di rete. Non si sottraggono orologi di macchine diverse. Servono misure tra host reali prima di scegliere timeout o valutare le prestazioni del servizio remoto.

## Stato verificato il 6 ottobre 2026

Le sezioni precedenti conservano le decisioni iniziali; alcuni punti sono stati
superati dagli incrementi successivi. La [review del branch a `c77c4c3`](/Volumes/MAIN/BananaChePrezzi-main/docs/revisioni/branch-nodi-2026-10-06-c77c4c3.md)
ricostruisce il percorso attuale, prove, controprove e gate ancora aperti.

- La composizione delle porzioni ricevute avviene **nel centro**, mediante
  `componiRicerca`, dopo la scelta approvata e le prove di equivalenza. Il nodo
  esegue la ricerca/fonti assegnate; non è più richiesto il ritorno al nodo
  principale per assemblare la risposta finale.
- Nhost Run ospita lo staging; Auth Nhost e PostgreSQL gestiscono identità e
  autorizzazioni commerciali. Le identità sintetiche e l'Admin senza login
  restano modalità locali di prova, non accessi utilizzabili su Internet.
- La ricerca usa avvio POST con ID e consultazioni GET brevi. Menu e dettagli
  possono ancora attendere il nodo dentro richieste GET lunghe. Il budget di
  ricerca è 60 secondi, con limiti iniziali concordati di due richieste pendenti
  per persona e 60 complessive; non sono misure di capacità produttiva.
- Il candidato `8c396f9` è caricato nel registry ma non distribuito. L'ultima
  verifica dello staging rileva l'originale `66e2b24` e 403 intermittenti
  sull'ingresso; `/healthz` 200 non certifica il frontend o il login.
- L'M2 non è ancora collegato. Il primo gate remoto resta solo stato e
  compatibilità, poi arresto/riconnessione; le ricerche live richiedono prima
  il coordinamento delle pause e dei limiti con la produzione sullo stesso IP.
- La copia cifrata temporanea staging sull'iMac e il restore isolato sono
  documentati nel registro. Storage gestito separato e ripristino funzionale
  completo Nhost restano gate di produzione, non risultati già ottenuti.

Questa review non modifica il runtime. I difetti negli inviti e nell'interfaccia
sono descritti con proposte; le scelte sulla revoca dei login pendenti e sulle
operazioni HTTP lunghe restano distinte dai problemi già riprodotti.
