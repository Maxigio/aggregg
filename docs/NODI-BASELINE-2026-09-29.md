# Baseline Auto/Moto per il prototipo centro–nodo

Data: 29 settembre 2026. Codice: `81e25ab`. Questa è una misura, non una promessa sulla stabilità futura dei portali.

## Metodo

Due ricerche vere sono passate dalla rotta `/api/search` del codice di sviluppo, caricata in un processo di prova sull'iMac. Il processo ascoltava soltanto su `127.0.0.1`, usava `USER_DATA_PATH` e log temporanei e non caricava `.env` o credenziali reali. Fra la conclusione della prima ricerca e l'avvio della seconda sono trascorsi 20 secondi. Il processo e i suoi dati temporanei sono stati chiusi e rimossi. Non sono stati conservati body, annunci, URL o dati dei venditori: solo metadati e SHA-256 delle identità disponibili ordinate per fonte, nel riepilogo temporaneo `/private/tmp/amr-baseline-20260929.json`. Per Subito si usa l'ID normalizzato; le righe AutoScout e Moto.it non espongono un ID e la misura usa il loro URL come ripiego. L'impronta di queste ultime cambia se cambia l'URL dello stesso annuncio.

Il listener senza `auth.json` era raggiungibile dagli altri processi locali mentre durava la misura. È stato chiuso. Il runner preparato per misure future invoca direttamente l'handler di ricerca senza aprire alcuna porta; questo preserva il comportamento dell'handler e delle fonti, ma non prova middleware HTTP, autenticazione o serializzazione Express. Produce un file nuovo con il commit effettivo, senza sovrascrivere il riepilogo storico sopra.

| Ricerca | Orario UTC | HTTP | Tempo | JSON risposta | Risultati | Chiamate effettive |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Auto, Fiat Panda | 02:11:54 | 200 | 1070 ms | 233719 byte | 100 | Subito 1, AutoScout 1 |
| Moto, Yamaha MT-07 | 02:12:15 | 200 | 794 ms | 231515 byte | 113 | Subito 1, AutoScout 1, Moto.it 1 |

| Ricerca | Fonte | Stato | Visibili | Totale dichiarato | Altre pagine | Prossimo cursore Subito |
| --- | --- | --- | ---: | ---: | --- | ---: |
| Fiat Panda | Subito | ok | 50 | 18595 | sì | 50 |
| Fiat Panda | AutoScout | ok | 50 | 8854 | sì | — |
| Yamaha MT-07 | Subito | ok | 50 | 1596 | sì | 50 |
| Yamaha MT-07 | AutoScout | ok | 50 | 391 | sì | — |
| Yamaha MT-07 | Moto.it | ok | 13 | 348 | sì | — |

Moto.it non parte per le auto; lo stato restituito nella ricerca Auto è `skipped`. Nessuna fonte era in pausa e non è stato osservato un 429. I totali sono quelli dichiarati dalle fonti, non il numero di righe che AMR mostra nella prima pagina.

## Filtri nativi: prova ripetibile senza rete

`test/nodi-baseline.test.js` chiama il vero handler di `/api/search` con risposte simulate, intercetta le richieste dove partono e verifica che i filtri rimangano questi. Non acquisisce header di autenticazione, body degli annunci o dati dei venditori.

| Ricerca | Fonte | Richiesta verificata |
| --- | --- | --- |
| Fiat Panda | Subito | categoria `2`, marca `000008`, modello `000024`, `start=0`, `lim=50`, `sort=priceasc` |
| Fiat Panda | AutoScout | `vehicleType=Car`, make `28`, model `1746`, pagina `1`, size `50`, paese Italia |
| Yamaha MT-07 | Subito | categoria `3`, marca `000015`, modello `002473`, `start=0`, `lim=50`, `sort=priceasc` |
| Yamaha MT-07 | AutoScout | `vehicleType=Bike`, make `50107`, model `70888`, pagina `1`, size `50`, paese Italia |
| Yamaha MT-07 | Moto.it | `/moto-usate/ricerca`, brand `yamaha`, model `yamaha|mt-07`, `sort=price-a` |

Queste sono le query costruite dal codice con cataloghi della revisione `81e25ab`; il test non pretende che i portali abbiano accettato tali filtri nella stessa misura live, né copre tutti i modelli. Una modifica ai cataloghi o alla traduzione deve aggiornare coscientemente questa caratterizzazione dopo averne verificato l'effetto.

## Prove controllate già eseguite

`test/paginazione-fonti.test.js` e `test/paginazione-ricerca.test.js`: 37 test superati, 0 falliti. Coprono selezione della fonte, esaurimento, cursori, pagina atomica, ripetizione dopo guasto e pausa 429 con risposte simulate. `test/nodi-baseline.test.js`: 4 test superati, 0 falliti; verifica le query native sopra, una richiesta circoscritta a Subito e una ricerca in cui Subito risponde 429 mentre le altre due fonti completano. In quel caso la risposta conserva le righe AutoScout/Moto.it, dichiara HTTP 429 per Subito e lo mette in pausa. Nove suite pertinenti (incluse quelle di ponti, versioni e costruzione richieste): 99 test superati, 0 falliti. Nessuno di questi test prova la composizione fra processi né il failover fra IP diversi.

Per ripetere le prove senza caricare `.env`, impostare `NODE_OPTIONS=--require=./test/no-dotenv-preload.cjs` prima di `node --test`; mantenere `AMR_LOG_DIR` temporanea. Un primo giro di verifica aveva caricato `.env` in una suite esistente: nessun valore è stato stampato, ma era un errore di metodo; il secondo giro da 99 test è passato con il preload che disabilita `dotenv.config()`.

## Limiti e prossima prova

Il processo era isolato dall'autenticazione ordinaria: questa prova misura la rotta di ricerca e le fonti, non login, diritti o quote. Le due ricerche non coprono versioni, regione, filtri avanzati, dettagli, menu remoti, pagine successive o errori live. Le impronte degli identificatori disponibili servono a riconoscere la misura, ma i risultati dei portali e gli URL possono cambiare fra due esecuzioni: l'equivalenza del nuovo motore va verificata soprattutto con risposte controllate identiche.

La prima prova del prototipo dovrà confrontare monolite e nodo con le stesse risposte simulate: query native già caratterizzate, numero di chiamate, identità disponibili e ordine, campi della risposta, stato per fonte e cursori. Poi simulare Subito 429 dopo il successo delle altre fonti e verificare che il nodo di riserva chieda soltanto Subito e che la pagina venga pubblicata una volta sola.

## Gate per iniziare la fase 2

È possibile iniziare l'**estrazione interna** del coordinatore: i due percorsi Auto/Moto di base hanno una misura live, un contratto ripetibile dei filtri nativi e prove sul retry per fonte; i 99 test pertinenti passano senza `.env`. L'estrazione va fatta per porzioni piccole mantenendo la rotta e la risposta attuali. Prima di spostare un ramo non caratterizzato — per esempio versione Moto.it, ponti con più codici AutoScout, riallargamenti, filtri avanzati o pagine profonde — occorre aggiungere al relativo incremento una prova controllata dell'input, delle richieste native e della risposta completa. Il gate **non** autorizza ancora la divisione fra processi, il failover reale, clienti o un deploy: equivalenza dopo la serializzazione, sicurezza dei nodi e casi di errore distribuito sono lavori successivi.
