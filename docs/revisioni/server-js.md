# Revisione di `backend/server.js`

Stato: lettura integrale e rimozione dei commenti originali completate il 28 settembre 2026. **Non è la fase di ricommento**: i commenti nuovi arriveranno soltanto quando il proprietario dichiarerà concluso il lavoro su questa pagina. Nessun deploy sull'M2.

## Confini effettivi

| Responsabilità | Proprietario attuale | Dipendenze da seguire |
| --- | --- | --- |
| Avvio, header HTTP, middleware finale | `server.js` | `auth.js`, `logger.js`, `accesso-route.js` |
| Accesso, sessioni e limiti per persona | `accesso-route.js`, montato qui | `auth.js`, `utenti-db.js`, `limite-richieste.js` |
| Bundle, Guida e static | `frontend-route.js`, montato qui | `scripts/build-frontend.js`, `scripts/build-guida.js` |
| Menu marche/modelli/versioni | tre rotte ancora in `server.js` | `catalogo-ricerca.js`, `menu-gemelli.js`, `versioni-menu.js`, `motoit-models.js`, cataloghi `data/` |
| Dettaglio annuncio e URL pubblico | due rotte ancora in `server.js` | `scrapers/detail.js`, `fonti-salute.js`, `limite-richieste.js`, Tailscale CLI |
| Ricerca Auto/Moto | `parseSearchParams`, `runSearch`, `runSearchCore`, wrapper delle tre fonti | `scrapers/subito-api.js`, `autoscout-graphql.js`, `motoit.js`, ponti catalogo, `fonti-salute.js`, `annullo.js`, `budget-richieste.js` |
| Superficie interna di test | export con prefisso `_`, in particolare `_amrSearchFn` | test di paginazione, accesso e fonti |

Il file è stato letto per intero, prima per blocchi di 200 righe e poi attraverso le dipendenze dei punti sospetti. Restano circa 1.000 righe di codice dopo aver tolto commenti e righe vuote; la parte più estesa è `runSearchCore`, che intreccia risoluzione cataloghi, richieste alle tre fonti, filtri e metadati della risposta. Spostarla tutta insieme avrebbe un rischio di regressione alto. I confini più piccoli da valutare sono le tre rotte del menu, la rotta dettaglio e l'URL pubblico; i test che leggono il testo di `server.js` vanno aggiornati sul nuovo proprietario prima di estrarre.

## Verifiche concluse

- Rimozione dei commenti con parser TypeScript: 597 intervalli individuati sui nodi, altri undici commenti interni rimossi dopo controllo lessicale e due commenti finali sui token. Il controllo su tutti i token non trova commenti residui; AST JavaScript prima/dopo identico. Le stringhe contenenti `//`, come l'URL di avvio, sono rimaste codice.
- Tre test estraevano una funzione usando **un commento come delimitatore**. Dopo la rimozione fallivano per `require is not defined`, pur senza cambiamenti del programma. Il limite è ora la funzione successiva. Suite completa: 918/918 con dati e log temporanei, `.env` disabilitato per i test.
- `getBrandModels` non interpreta un errore della fonte come menu vuoto in cache: l'errore viene rilanciato per la rotta `/api/models`, e il modulo usa il catalogo locale quando disponibile. Il sospetto di una cache vuota permanente qui non è confermato.
- Il gate di accesso non è definito in questo file: `accesso-route.js` legge lo stato corrente di `auth.js` a ogni richiesta e risponde 503 se il file di accesso è illeggibile. Una revisione del solo `server.js` avrebbe descritto male questo caso.

## Decisione e fix: limite del dettaglio

Il proprietario ha scelto di contare **solo le richieste HTTP effettive alle piattaforme**. Il limite di 30 per minuto è ora consumato immediatamente prima dell'HTTP: validazione URL, risposta in cache, attesa condivisa e pausa locale della fonte sono gratuite. I redirect contano perché aprono una nuova richiesta. Se la quota locale finisce, `/api/detail` risponde 429 con `limiteDettaglio` e attesa; il frontend mostra un avviso, senza attribuire il blocco alla piattaforma. Una verifica di ripartenza negata dal limite non aggiorna la salute della fonte. Prova con trasporto simulato: cache, concorrenza, URL non consentito, fonte in pausa, verifica successiva; suite completa 920/920. Nessun deploy sull'M2.

## Punti da discutere prima di modificarli

1. **Dimensione delle risposte dettaglio: risolta con una misura per fonte e soglia tripla, su richiesta del proprietario.** La cache di `scrapers/detail.js` contiene solo i dati estratti, non l'HTML, dunque pulirla non riduce il picco del body durante il download. Il probe ripetibile in `scratchpad/probe-detail-size.js` (stessi header del trasporto, nessun body conservato) ha misurato HTTP 200, 202.032 byte per Subito e HTTP 200, 537.021 byte per AutoScout24. Un primo annuncio AutoScout24 ha risposto 410, quindi i suoi 442.680 byte non sono entrati nel calcolo. I cap per le rispettive fonti sono 606.096 e 1.611.063 byte. Oltre soglia la richiesta è interrotta e `/api/detail` risponde 502 con un errore distinto: nessun dettaglio troncato viene presentato come completo. Il frontend attuale interroga questa rotta solo per Moto.it, il cui trasporto aveva già un cap: non esiste oggi un avviso UI Subito/AutoScout da aggiungere. Un solo campione per fonte non dimostra la dimensione massima futura; la soglia va rivista se respinge dettagli validi.
2. **`parseSearchParams` accetta numeri con suffissi**, per esempio `prezzoMin=100abc` diventa 100 per via di `parseInt`. La UI invia numeri regolari, quindi il percorso normale non è dimostrato rotto; i chiamanti diretti dell'API ricevono una ricerca diversa da quella scritta. Prima di irrigidire la validazione bisogna verificare tutte le query costruite dalla UI e dai test interni.

## Decisioni aperte sulla struttura

`_amrSearchFn` non ha più un chiamante di produzione dopo l'accantonamento del bot, ma i test lo usano per attraversare la pipeline senza avviare una porta. Non cancellarlo solo perché sembra morto: prima serve una superficie di test equivalente. `runSearchCore` va separato per responsabilità solo dopo test che esercitino gli stessi parametri e stati delle tre fonti. Questa revisione non riattiva Ricambi, Competitor, Aste o il bot.

Verifica successiva: `os`, `fs`, `crypto` e `famigliaSubito` sono importati in `server.js` ma non letti nel file. Questi quattro import sono inutilizzati; non è una prova che ogni altro percorso sia vivo. Le rotte `/api/brands`, `/api/models`, `/api/versioni` servono il menu frontend; `/api/public-url` serve il login; `/api/detail` è usata oggi dall'interfaccia per Moto.it, mentre i rami Subito e AutoScout rimangono accessibili attraverso la rotta. Il limite di 30 per minuto su `/api/detail` vale anche per proprietario e persone registrate: la chiave è `u:<id>` dopo il login (gli accessi alla demo condivisa usano lo stesso ID `demo`), oppure `ip:<indirizzo>` quando l'auth è disattivata. È distinto dal tetto giornaliero delle ricerche per ruolo `demo`.

Per un'estrazione futura, mantenere Auto e Moto nello stesso coordinatore e separare per responsabilità: interpretazione dei parametri e rotta; risoluzione dei cataloghi; esecuzione delle tre fonti e fallback API; normalizzazione e metadati di risposta. `runSearchCore` modifica `params` durante la risoluzione, quindi l'ordine dei passaggi e le chiavi di cache delle pagine sono parte del comportamento da preservare. La cache delle ricerche (50 voci, 3 minuti), le pagine complete in attesa di retry (30 voci, 3 minuti) e la deduplica in volo appartengono al coordinamento: non vanno duplicate in moduli separati per Auto e Moto.
