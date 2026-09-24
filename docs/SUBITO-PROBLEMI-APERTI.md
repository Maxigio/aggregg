# Subito: problemi verificati da riprendere

Priorita' attuale: completare e provare la scelta obbligatoria della versione in Auto/Moto.
Questi due problemi sono stati riprodotti con risposte Hades controllate; non correggerli
insieme al flusso Versione, per poter valutare separatamente la copertura delle ricerche.

1. **Richiesta superflua e falso avviso 429.** In `backend/scrapers/subito-api.js`,
   con 50 annunci e `count_all: 50` la ricerca chiede anche `start=50`. Se quella
   richiesta superflua riceve 429, AMR dichiara incompleti i 50 annunci gia' ricevuti
   e registra un blocco della fonte. Fermare il ciclo quando il totale dichiarato e'
   raggiunto, verificando anche il caso di totale assente e le pagine filtrate.
2. **Recupero duplicato nelle ricerche simultanee.** Due chiamate identiche a
   `paginaRecupero()` prima che la prima finisca trovano entrambe la cache vuota e
   inviano due richieste Hades. Riproduzione: due Promise contemporanee per la stessa
   chiave producono due chiamate. Condividere la Promise in corso per chiave, poi
   rimuoverla sia su successo sia su errore; mantenere la scadenza dei dati grezzi.

Nessuna prova di questi due casi richiede interrogazioni ripetute al portale reale.
