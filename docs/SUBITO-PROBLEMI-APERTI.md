# Subito — problemi verificati e stato

Le verifiche usano risposte Hades controllate: i test non fanno richieste al portale.
La regola approvata per Auto e Moto è una famiglia nativa per voce univoca;
quando la voce AMR corrisponde a più famiglie Subito si usa `q=marca+modello`.

## Risolti

1. **Richiesta superflua alla pagina successiva.** La prima pagina chiede 50 annunci;
   la seguente parte solo quando l'utente sceglie «Carica altri annunci» e
   `count_all` arresta una pagina profonda già completa. Prova in
   `test/subito-429.test.js`.
2. **Recupero duplicato nelle ricerche simultanee.** `paginaRecupero()` condivide
   la richiesta in corso e conserva i dati grezzi solo per il TTL previsto.
   Prove in `test/subito-recupero-cache.test.js`. L'isolamento delle cache per
   installazione cliente resta un lavoro separato.
3. **Più famiglie Moto, conteggi e blocchi parziali.** Le vecchie sequenze Hades
   per più famiglie e le unioni di ID Auto sono state rimosse nel commit `db5f8ac`.
   I vecchi scenari «due 403 contati come uno», «l'ultimo errore nasconde il
   precedente» e «una famiglia senza prezzo guasta l'unione» non sono più
   percorsi raggiungibili nella ricerca Auto/Moto. La gestione dei 403/429,
   delle pagine interrotte e dei prezzi mancanti resta coperta da test sulla
   singola ricerca.
4. **Una fonte esaurita interrogata ancora.** Il pulsante compare se almeno una
   fonte ha `hasMore: true`, ma prima il server chiedeva comunque la pagina a
   tutte e tre. Ora il client indica le sole fonti ancora aperte; il server
   valida l'elenco, lo include nella chiave della cache e dichiara le altre
   come non richieste. Lo schermo conserva anche lo stato `empty` delle fonti
   già esaurite. Riproduzione precedente e regressioni in
   `test/paginazione-fonti.test.js` e `test/paginazione-ricerca.test.js`.
5. **Timeout complessivo Subito classificato come errore definitivo.**
   `runSubito()` ora distingue il proprio timer dagli errori della fonte:
   restituisce `status: timeout`, `erroreTipo: transient` e registra un esito
   transitorio in `fonti-salute`. La pagina può essere riprovata; un 403, un
   429 o un body illeggibile mantengono la loro classificazione. Riproduzione
   prima del fix e regressione in `test/subito-429.test.js`.
6. **Totale Subito sconosciuto senza segnale visibile.** Se `count_all` manca,
   il backend mantiene `totale: null` e la pill di Subito mostra un'icona con
   spiegazione immediata al passaggio del puntatore o al fuoco da tastiera.
   Non inventa un totale e non cambia la paginazione. Il segnale compare solo
   con risposta valida (`ok` o `empty`), non su timeout o fonte saltata.
   Riproduzione prima del fix e regressione in `test/fonti-pausa-ui.test.js`.

## Aperti

Nessuno dei problemi elencati in questo registro resta aperto. Questo non
costituisce una verifica completa dello scraper né delle fonti reali.
