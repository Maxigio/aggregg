# Subito: problemi verificati da riprendere

I primi quattro problemi sono stati riprodotti con risposte Hades controllate
e risolti separatamente dal flusso Versione. Il quinto resta aperto.

1. **Risolto localmente — richiesta superflua e falso avviso 429.** La pagina standard
   di Subito ora legge 50 annunci grezzi con una sola chiamata; `fetta: 1` chiede
   `start=50` solo dopo «Carica altri annunci». Anche un giro esplicitamente piu'
   profondo si ferma quando `count_all` e' stato raggiunto. Il totale assente o
   incoerente non autorizza a scartare annunci. Test di regressione in
   `test/subito-429.test.js`; resta da verificare il comportamento sul dev server.
2. **Risolto localmente — recupero duplicato nelle ricerche simultanee.** Due chiamate
   identiche a `paginaRecupero()` attendevano entrambe una risposta Hades separata.
   Ora condividono la richiesta in corso per chiave e la liberano su successo o errore;
   i dati grezzi mantengono la scadenza di dieci minuti. Un 429 non avvia altri tentativi;
   se viene annullata soltanto la ricerca che ha aperto la connessione, un'altra ricerca
   ancora attiva puo' riprovare. Prove controllate in `test/subito-recupero-cache.test.js`.
   La cache resta condivisa fra account, come prima: l'isolamento per cliente andra'
   affrontato insieme alle altre cache quando si prepareranno le installazioni dedicate.
3. **Risolto localmente — piu' 403 contati come uno solo.** Il freno anti-blocco
   vedeva solo il riepilogo della ricerca Moto e lasciava interrogare altre
   famiglie dopo due risposte Hades 403. Gli errori delle singole chiamate ora
   arrivano al freno subito; una risposta valida con annunci azzera i colpi,
   una pausa locale non conta come risposta del portale e il ciclo dichiara le
   famiglie non interrogate. Prove controllate in `test/subito-429.test.js`.
4. **Risolto localmente — l'ultimo errore nasconde un blocco precedente.** In una ricerca Moto
   su piu' famiglie, se una chiamata Hades riceve 403, la successiva 503 e un'altra
   famiglia risponde, l'unione conserva `bloccoParziale: 403` ma restituisce
   `erroreTipo: transient` e `erroreHttp: 503`. Ora la risposta contiene l'elenco
   distinto degli errori effettivi, con famiglia, fase, pagina e codice HTTP; il
   frontend lo mostra e decide se riprovare leggendo l'intero elenco. I campi
   singoli restano per compatibilita', ma non guidano la riprova quando c'e'
   l'elenco. `fonti-salute` continua a contare gli errori originali delle
   singole chiamate, senza contarli di nuovo quando si mostra il riepilogo.
   Prove controllate in `test/subito-429.test.js`, `test/paginazione-ricerca.test.js`
   e `test/fonti-pausa-ui.test.js`, senza interrogare il portale.
5. **Aperto — una famiglia senza prezzi fa fallire anche quella valida.** Se una
   famiglia Moto restituisce un annuncio realmente senza prezzo e una seconda
   famiglia restituisce un annuncio con prezzo, `sospetto` della prima viene
   propagato all'unione e l'intera fonte esce con `status: error`. Riprodotto
   con due risposte Hades controllate, una senza prezzo e una con prezzo.
   Occorre distinguere il singolo annuncio senza prezzo, gia' marcato
   `prezzoSuRichiesta`, dal caso in cui il parser non riconosce piu' i prezzi
   di una risposta, e non scartare
   l'esito valido dell'altra famiglia.

Queste riproduzioni non richiedono interrogazioni ripetute al portale reale.
