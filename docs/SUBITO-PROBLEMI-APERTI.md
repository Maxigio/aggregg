# Subito: problemi verificati da riprendere

I due problemi sono stati riprodotti con risposte Hades controllate e affrontati
separatamente dal flusso Versione.

1. **Risolto localmente — richiesta superflua e falso avviso 429.** La pagina standard
   di Subito ora legge 50 annunci grezzi con una sola chiamata; `fetta: 1` chiede
   `start=50` solo dopo «Carica altri annunci». Anche un giro esplicitamente piu'
   profondo si ferma quando `count_all` e' stato raggiunto. Il totale assente o
   incoerente non autorizza a scartare annunci. Test di regressione in
   `test/subito-429.test.js`; resta da verificare il comportamento sul dev server.
2. **Aperto — recupero duplicato nelle ricerche simultanee.** Due chiamate identiche a
   `paginaRecupero()` prima che la prima finisca trovano entrambe la cache vuota e
   inviano due richieste Hades. Riproduzione: due Promise contemporanee per la stessa
   chiave producono due chiamate. Condividere la Promise in corso per chiave, poi
   rimuoverla sia su successo sia su errore; mantenere la scadenza dei dati grezzi.

Nessuna prova di questi due casi richiede interrogazioni ripetute al portale reale.
