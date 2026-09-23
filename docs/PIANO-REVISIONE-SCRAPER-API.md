# Revisione degli scraper API di Auto Moto Radar

## Obiettivo e perimetro

Rendere affidabile il percorso di ricerca via endpoint API prima di distribuire
AMR a clienti. La revisione procede **una fonte alla volta**: Subito, poi
AutoScout24, infine Moto.it. Le ricerche più larghe eseguite sulla stessa API
restano nel perimetro; i fallback HTML/Playwright sono fuori dalla ricerca
standard Auto e Moto. Ogni modifica deve preservare il comportamento delle
ricerche API che oggi funziona.

Auto, Moto, Ricambi e Competitor sono quattro moduli acquistabili separatamente.
La verifica di una fonte comprende tutti i moduli che ne riusano il client:
un errore condiviso può incidere su più prodotti. Prezzi previsti: primo modulo
Auto 50 € + IVA, Moto 20 € + IVA, Ricambi e Competitor 10 € + IVA ciascuno;
un cliente può partire da un solo modulo e aggiungerne altri.

## Metodo per ogni fonte

1. Ricostruire la ricerca completa: controlli e stato del frontend AMR,
   validazione della richiesta, costruzione delle query, endpoint e fallback
   sulla stessa API, paginazione, normalizzazione, cache, stato per fonte,
   risultati mostrati ed export. Identificare tutti i chiamanti del client
   condiviso, inclusi Ricambi e Competitor.
2. Capire il frontend del portale e le chiamate API che produce: categorie,
   filtri, ordinamento, pagine, struttura delle risposte ed errori. Confrontare
   ogni filtro che AMR invia con il comportamento effettivo del portale.
   Una differenza osservata non è automaticamente un bug: valutarne l'effetto
   sui risultati e su ciò che AMR dichiara all'utente.
3. Riprodurre in locale, con risposte controllate, i casi valido, vuoto,
   parziale, bloccato, formato cambiato, timeout e connessione interrotta.
   Distinguere sempre «nessun annuncio» da «non siamo riusciti a leggere la
   fonte». Usare pochi controlli mirati sulla fonte reale solo per le ipotesi
   che non si possono verificare localmente.
4. Nelle prove reali non cercare più volte lo stesso veicolo sulla stessa
   piattaforma e lasciare **almeno 15 secondi** tra due ricerche sulla stessa
   piattaforma. Registrare query, orario, numero di richieste, risposta e
   limiti della prova; non interpretare un blocco dell'ambiente di test come
   un errore del portale.
5. Per ogni difetto sospetto, presentare **in chat prima della correzione**:
   prova, impatto sui moduli, ciò che resta incerto e soluzione proposta.
   Dopo il confronto, correggere un problema alla volta con una modifica
   circoscritta, un test di regressione e i test dei moduli coinvolti. Non
   committare o distribuire sull'M2 senza richiesta esplicita.

## Carico e distribuzione ai clienti

Misurare il numero di chiamate, i burst, i retry e gli eventuali blocchi per
fonte e per modulo. Un'installazione privata su ogni computer distribuisce
il traffico fra IP residenziali, ma non impedisce a una singola installazione
di generare troppe richieste. Non introdurre limiti o code che tronchino una
ricerca funzionante sulla base di una soglia immaginata: prima misurare il
comportamento, poi decidere con prove quali protezioni servono. Tenere
separata questa revisione dalla futura gestione di licenze, postazioni e
aggiornamenti delle installazioni clienti.

## Criterio di uscita per una fonte

Il contratto delle risposte è esplicito; gli errori non diventano risultati
vuoti; i filtri e i conteggi mostrati sono spiegabili; i percorsi che usano
la fonte sono collaudati; i limiti delle prove live sono registrati. Solo
allora passare alla fonte successiva. Nessuna prova puntuale garantisce che
un portale non cambierà in futuro.
