# Subito: problemi verificati da riprendere

I due problemi sono stati riprodotti con risposte Hades controllate e affrontati
separatamente dal flusso Versione.

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

Nessuna prova di questi due casi richiede interrogazioni ripetute al portale reale.
