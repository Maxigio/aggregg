# Pausa condivisa e ripartenza delle fonti — 23 settembre 2026

## Perimetro concordato

Prima destinazione: il servizio esistente sull'M2. Nessun deploy autorizzato in questo intervento.
Fonti: Subito, AutoScout24, Moto.it nei moduli Auto, Moto, Ricambi e Competitor. eBay, Autodoc e CMSNL restano alla propria revisione.
Checkpoint iniziale: `0332a0e` (precedenti correzioni 429 di Subito nei quattro moduli).

## Comportamento

- Il primo HTTP 429 sospende le nuove richieste alla fonte per questa istanza del server. Le richieste già partite possono ancora terminare: un loro successo non cancella la pausa.
- Il limite viene registrato agli header, senza aspettare il body di errore.
- Pausa progressiva già esistente: 15 minuti, un'ora, sei ore. `Retry-After`, in secondi o data HTTP, può prolungarla; non si riparte prima del termine indicato dalla fonte.
- La scadenza non certifica la disponibilità. La successiva richiesta effettiva alla fonte ammette un solo tentativo di verifica; le altre attendono una nuova azione dell'utente. Non esiste un processo che interroghi periodicamente la fonte.
- Se quel tentativo riesce, la pausa viene rimossa. Se fallisce, resta chiusa; un nuovo 429 aumenta la pausa. La validazione dei risultati resta responsabilità dei singoli parser.
- Pausa e scadenza `Retry-After` sopravvivono al riavvio in `amr-fonti.db`. La nuova colonna tecnica `retry_dopo` non contiene query, utenti, header grezzi o risultati.
- Annunci già ricevuti e risultati in cache restano consultabili. I fallimenti successivi sono dichiarati come risultati parziali. Le risposte della ricerca servite dalla cache espongono lo stato attuale della pausa.

## Percorsi controllati

Hades (ricerca, accessori, parchi), GraphQL AS24 (ricerca, parchi, conteggi), HTTP Moto.it (ricerca e vetrine), menu e schede tecniche Moto.it, dettagli degli annunci delle tre fonti, risoluzione delle vetrine Subito/AS24.
Gli script manuali di manutenzione dei cataloghi non vengono trasformati in job del server e non rientrano in questo intervento.

Gli errori delle piattaforme non vengono confusi con il limite imposto da AMR all'utente: dove serve un codice HTTP di gateway si usa 502, con origine e pausa nel corpo della risposta.

## Difetti verificati e correzioni

1. Un 429 non fermava subito la fonte; un successo tardivo poteva cancellare la pausa. Registrazione immediata e sblocco riservato al tentativo successivo alla scadenza.
2. Dettagli, menu e schede competitor avevano porte HTTP separate: la pausa della ricerca non fermava quel traffico. Controllo comune anche in questi percorsi e nei redirect.
3. Un errore successivo a pagine riuscite poteva perdere gli annunci già letti su AS24/Moto.it. Conservazione e segnalazione dell'errore; distinzione fra errore e tetto di paginazione.
4. Lo stato della pausa poteva essere vecchio sulle risposte in cache. Metadati aggiornati senza nuove richieste alla fonte.
5. Il dettaglio nascondeva il 429 in un generico risultato non disponibile. Errore tipizzato propagato alla rotta e avviso nell'interfaccia.
6. La revisione indipendente ha riprodotto quattro problemi: gestori degli errori agganciati dopo l'uscita sul 429; riapertura prima della validazione; cache completa sostituita da una parziale; aggiornamento forzato che scartava la cache durante la pausa. Gestori anticipati, parser dentro la verifica, cache completa conservata e servita con avviso senza estenderne il TTL.
7. Un errore locale della verifica ricreato dall'unione AS24 perdeva il codice e veniva contato come respinta della piattaforma. Conservato l'errore originale, anche nell'unione Subito.
8. Il motivo sconosciuto di una fonte saltata era interpolato senza escape nel frontend. Trattato come testo, come gli altri messaggi della fonte.
9. Una pagina Moto.it di manutenzione con HTTP 200 ma senza card né contatore sbloccava ancora la verifica. Durante la ripartenza si richiede contenuto riconoscibile: annunci o contatore per la ricerca, annunci o struttura della vetrina per il parco, struttura dei contatti per l'anagrafica. Tre prove negative fallivano prima della correzione; restano valide le prove positive dello zero esplicito e della vetrina senza annunci.

## Prove

Test riproducibili senza traffico alle piattaforme:

- `test/fonti-ripartenza.test.js`: primo 429, risposta tardiva, scadenza, concorrenza, redirect, retry, persistenza.
- `test/fonti-429-trasporti.test.js`: porte HTTP effettive con risposte simulate, arresto trasversale e conservazione dei risultati.
- `test/fonti-429-dettagli.test.js`: dettagli, schede tecniche, cache, redirect, allowlist.
- `test/competitor-pausa-cache.test.js`: snapshot completo, aggiornamento forzato, scadenza e mancato addebito durante la pausa.
- `test/fonti-pausa-ui.test.js`: avvisi, date, stati e contenuti non affidabili nell'interfaccia.
- Suite esistenti aggiornate dove il requisito passa esplicitamente da due 429 a uno.

Eseguire con `USER_DATA_PATH` e `AMR_LOG_DIR` temporanei e dotenv disabilitato. I test che aprono server locali necessitano del permesso di ascoltare su loopback. Non usare dati o credenziali di produzione.

Verifica finale, dopo le correzioni e il controllo indipendente: **975 test passati, zero fallimenti, zero saltati** (`node --test test/*.test.js`). Esito del processo: 0. Log locale: `/private/tmp/amr-fonti-gate-finale.log`. Nessuna richiesta alle piattaforme reali e nessun deploy sull'M2.

Limiti: i test controllati non certificano che i portali manterranno il proprio contratto. Il riconoscimento Moto.it durante la ripartenza usa i marcatori HTML già presenti nelle fixture; non certifica la completezza della risposta. Fuori dal tentativo di ripartenza, questo controllo aggiuntivo non cambia il comportamento del parser. Il controllo della concorrenza riguarda una singola istanza del server, come l'attuale servizio sull'M2.

## Pagine: implementazione sospesa per decisione dell'utente

L'utente richiede una sola richiesta di annunci per fonte e vuole discutere prima come mantenere la copertura. Non è stato sostituito «Carica altri».

Nel codice attuale:

- Subito Auto usa un elenco di codici `cm` nella stessa chiamata.
- AS24 usa una lista `classification` per l'OR di codici modello.
- Moto.it usa più slug nel parametro `model`.
- Subito Moto interroga separatamente le famiglie; AS24 interroga separatamente alcune grafie testuali. Subito ha inoltre il recupero «Altro modello» e AS24 il riallargamento dopo una risposta vuota.

Prima di rimuovere queste richieste aggiuntive va verificato se le API consentono la medesima unione in una sola chiamata. I commenti con vecchie misure non sostituiscono una verifica del contratto attuale. Se non è possibile, serve una scelta esplicita fra restringere la ricerca e leggere una pagina nativa più ampia filtrandola localmente (che può contenere pochi o nessun annuncio pertinente). Nessuna equivalenza di copertura viene presunta.
