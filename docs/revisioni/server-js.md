# Revisione di `backend/server.js`

Stato: lettura integrale e rimozione dei commenti originali completate il 28 settembre 2026. **Non è la fase di ricommento**: i commenti nuovi arriveranno soltanto quando il proprietario dichiarerà concluso il lavoro su questa pagina. Nessun deploy sull'M2.

## Confini effettivi

| Responsabilità | Proprietario attuale | Dipendenze da seguire |
| --- | --- | --- |
| Avvio, header HTTP, middleware finale | `server.js` | `auth.js`, `logger.js`, `accesso-route.js` |
| Accesso, sessioni e limiti per persona | `accesso-route.js`, montato qui | `auth.js`, `utenti-db.js`, `limite-richieste.js` |
| Bundle, Guida e static | `frontend-route.js`, montato qui | `scripts/build-frontend.js`, `scripts/build-guida.js` |
| Menu marche/modelli/versioni | `menu-ricerca-route.js`, montato da `server.js` | `catalogo-ricerca.js`, `menu-gemelli.js`, `versioni-menu.js`, `motoit-models.js`, cataloghi `data/` |
| Dettaglio annuncio | `dettaglio-route.js`, montato da `server.js` | `scrapers/detail.js`, `fonti-salute.js`, `limite-richieste.js` |
| URL pubblico del login | `public-url-route.js`, montato da `server.js` | Tailscale CLI, `qrcode-generator` |
| Ricerca Auto/Moto | coordinamento in `server.js`; regole specifiche in `ricerca-auto.js` e `ricerca-moto.js` | `scrapers/subito-api.js`, `autoscout-graphql.js`, `motoit.js`, ponti catalogo, `fonti-salute.js`, `annullo.js`, `budget-richieste.js` |
| Superficie interna di test | export con prefisso `_`, in particolare `_amrSearchFn` | test di paginazione, accesso e fonti |

Il file è stato letto per intero, prima per blocchi di 200 righe e poi attraverso le dipendenze dei punti sospetti. Dopo le tre estrazioni delle rotte restano 820 righe. La parte più estesa è `runSearchCore`, che intreccia risoluzione cataloghi, richieste alle tre fonti, filtri e metadati della risposta. Spostarla tutta insieme avrebbe un rischio di regressione alto: modifica `params` per fasi, e le chiavi di cache e i retry dipendono dal loro ordine.

## Verifiche concluse

- Rimozione dei commenti con parser TypeScript: 597 intervalli individuati sui nodi, altri undici commenti interni rimossi dopo controllo lessicale e due commenti finali sui token. Il controllo su tutti i token non trova commenti residui; AST JavaScript prima/dopo identico. Le stringhe contenenti `//`, come l'URL di avvio, sono rimaste codice.
- Tre test estraevano una funzione usando **un commento come delimitatore**. Dopo la rimozione fallivano per `require is not defined`, pur senza cambiamenti del programma. Il limite è ora la funzione successiva. Suite completa: 918/918 con dati e log temporanei, `.env` disabilitato per i test.
- `getBrandModels` non interpreta un errore della fonte come menu vuoto in cache: l'errore viene rilanciato per la rotta `/api/models`, e il modulo usa il catalogo locale quando disponibile. Il sospetto di una cache vuota permanente qui non è confermato.
- Il gate di accesso non è definito in questo file: `accesso-route.js` legge lo stato corrente di `auth.js` a ogni richiesta e risponde 503 se il file di accesso è illeggibile. Una revisione del solo `server.js` avrebbe descritto male questo caso.

## Decisione e fix: limite del dettaglio

Il proprietario ha scelto di contare **solo le richieste HTTP effettive alle piattaforme**. Il limite di 30 per minuto è ora consumato immediatamente prima dell'HTTP: validazione URL, risposta in cache, attesa condivisa e pausa locale della fonte sono gratuite. I redirect contano perché aprono una nuova richiesta. Se la quota locale finisce, `/api/detail` risponde 429 con `limiteDettaglio` e attesa; il frontend mostra un avviso, senza attribuire il blocco alla piattaforma. Una verifica di ripartenza negata dal limite non aggiorna la salute della fonte. Prova con trasporto simulato: cache, concorrenza, URL non consentito, fonte in pausa, verifica successiva; suite completa 920/920. Nessun deploy sull'M2.

## Punti da discutere prima di modificarli

1. **Dimensione delle risposte dettaglio: risolta con una misura per fonte e soglia tripla, su richiesta del proprietario.** La cache di `scrapers/detail.js` contiene solo i dati estratti, non l'HTML, dunque pulirla non riduce il picco del body durante il download. Il probe ripetibile in `scratchpad/probe-detail-size.js` (stessi header del trasporto, nessun body conservato) ha misurato HTTP 200, 202.032 byte per Subito e HTTP 200, 537.021 byte per AutoScout24. Un primo annuncio AutoScout24 ha risposto 410, quindi i suoi 442.680 byte non sono entrati nel calcolo. I cap per le rispettive fonti sono 606.096 e 1.611.063 byte. Oltre soglia la richiesta è interrotta e `/api/detail` risponde 502 con un errore distinto: nessun dettaglio troncato viene presentato come completo. Il frontend attuale interroga questa rotta solo per Moto.it, il cui trasporto aveva già un cap: non esiste oggi un avviso UI Subito/AutoScout da aggiungere. Un solo campione per fonte non dimostra la dimensione massima futura; la soglia va rivista se respinge dettagli validi.
2. **Parsing numerico della UI: problema verificato e corretto.** In un campo `type="number"` Chrome accetta `1e3` come valore valido e la UI invia proprio la stringa `1e3`; `parseInt` la trasformava in **1** anziché 1000. Il test sul percorso `_amrSearchFn` falliva prima della correzione (attuale 1, atteso 1000). Ora i valori vuoti restano `null`, mentre `Number` più `Number.isSafeInteger` interpreta il valore intero effettivo del campo e rifiuta le stringhe tronche. Il test di paginazione e cursori passa 14/14. Questo intervento non nasce dall'accesso diretto all'API: la premessa che la UI non potesse produrre il problema è stata falsificata da Chrome headless.

## Decisioni aperte sulla struttura

`_amrSearchFn` non ha più un chiamante di produzione dopo l'accantonamento del bot, ma i test lo usano per attraversare la pipeline senza avviare una porta. Non cancellarlo solo perché sembra morto: prima serve una superficie di test equivalente. `runSearchCore` va separato per responsabilità solo dopo test che esercitino gli stessi parametri e stati delle tre fonti. Questa revisione non riattiva Ricambi, Competitor, Aste o il bot.

Verifica successiva: `os`, `fs`, `crypto`, `famigliaSubito` e `resolveMotoitVersionEntry` erano importati in `server.js` ma non letti; gli import inutilizzati sono stati rimossi. Le rotte `/api/brands`, `/api/models`, `/api/versioni` servono il menu frontend; `/api/public-url` serve il login; `/api/detail` è usata oggi dall'interfaccia per Moto.it, mentre i rami Subito e AutoScout rimangono accessibili attraverso la rotta. Il limite di 30 per minuto su `/api/detail` vale anche per proprietario e persone registrate: la chiave è `u:<id>` dopo il login (gli accessi alla demo condivisa usano lo stesso ID `demo`), oppure `ip:<indirizzo>` quando l'auth è disattivata. È distinto dal tetto giornaliero delle ricerche per ruolo `demo`.

Per un'estrazione futura, mantenere Auto e Moto nello stesso coordinatore e separare per responsabilità: interpretazione dei parametri e rotta; risoluzione dei cataloghi; esecuzione delle tre fonti e fallback API; normalizzazione e metadati di risposta. `runSearchCore` modifica `params` durante la risoluzione, quindi l'ordine dei passaggi e le chiavi di cache delle pagine sono parte del comportamento da preservare. La cache delle ricerche (50 voci, 3 minuti), le pagine complete in attesa di retry (30 voci, 3 minuti) e la deduplica in volo appartengono al coordinamento: non vanno duplicate in moduli separati per Auto e Moto.

## Separazione Auto/Moto, primo confine verificato

`ricerca-auto.js` possiede il gruppo di nomi alternativi di un modello Auto e il filtro del titolo AutoScout quando manca il codice nativo. `ricerca-moto.js` possiede la preparazione di modello/versione Moto.it, il restringimento dei modelli Moto su AutoScout e la dichiarazione della versione sulle righe Moto.it. Le chiamate restano negli stessi punti di `runSearchCore`: in particolare il ponte Subito→AutoScout precede la preparazione Moto, e i parametri di fonte restano condivisi prima di calcolare le chiavi di cache. Il coordinatore, il parsing, le tre richieste, il merge e la cache non sono stati duplicati per tipo di veicolo: separarli ora richiederebbe un cambio di contratto non necessario per questa estrazione.

Verifica: revisione del diff contro il codice precedente, `node --check` sui tre moduli, `git diff --check`, suite completa con dati e log temporanei e `.env` non caricato: **924/924**. Due test che cercavano letteralmente regole Moto in `server.js` ora leggono il modulo che le possiede; conservano le stesse asserzioni e il controllo che il banner viaggi fino alla risposta. La suite non prova che le tre piattaforme conserveranno in futuro lo stesso catalogo o la stessa API; resta necessario il controllo per fonte prima di un rilascio.

## Estrazione delle rotte indipendenti

Valutati i confini uno per volta: menu cataloghi, dettaglio e URL pubblico non condividono le variabili mutabili del coordinatore di ricerca. I relativi handler sono stati spostati rispettivamente in `menu-ricerca-route.js`, `dettaglio-route.js` e `public-url-route.js`, montati dopo il gate negli stessi punti del server. Solo `/api/versioni` precede ora le rotte distinte di `veicolo-dati-route.js`; i path non si sovrappongono. Il controllo testuale prima/dopo, ignorando soltanto l'indentazione, conferma che tutti e quattro i blocchi di codice spostati sono identici. La funzione `tailscalePublicUrl` resta esportata da `server.js` per il test della deduplica; il limitatore del dettaglio resta creato una volta al montaggio.

Verifiche per confine: menu 31/31; dettaglio 44/44; URL pubblico 27/27. La suite completa ha rilevato un test che cercava l'unione delle marche Moto nel vecchio file: ora la prova invoca davvero `/api/brands` e verifica che le marche possedute dal catalogo Moto.it siano presenti. Controllo finale dopo il fix numerico: **925/925** e smoke HTTP locale su `/api/brands` (200), `/api/models` (200), `/api/versioni` (200) e `/api/detail` con URL non valido (400), senza chiamare le piattaforme. Il coordinatore Auto/Moto rimane nello stesso file: spostarlo richiederebbe estrarre insieme stato di cache, retry e traduzione delle tre fonti, quindi non è un'estrazione chirurgica di questa fase. I nuovi commenti potranno descrivere questa struttura dopo che il proprietario dichiarerà conclusa la revisione della pagina.
