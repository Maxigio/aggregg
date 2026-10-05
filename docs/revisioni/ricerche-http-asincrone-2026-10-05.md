# Ricerche del centro: avvio breve e consultazione — 5 ottobre 2026

## Direzione e perimetro

Baseline diagnostica `2917d91`, branch `feat/nodi-residenziali-prototipo`.
Approvato nell'interview: «Avvio breve + ID + consultazione esito».
Questo incremento modifica centro e frontend del prototipo; riusa `ricerca()`
e il coordinatore. Non cambia query dei portali, composizione, cursor,
numero di richieste agli scraper o criteri commerciali. Nessuna attivazione
remota, prova live, lettura delle credenziali o modifica dell'M2.

Riferimento: [Microsoft, asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply),
verificato sulle fonti ufficiali il 5 ottobre. Avvio con 202, endpoint di
stato autorizzato, chiave per riuso dell'operazione, retention e abbandono.
Il pattern non richiede un nuovo broker. La [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2)
spiega perché una richiesta HTTP può essere ripetuta dopo un guasto;
l'ID applicativo protegge anche quando si perde la risposta di ammissione.
Queste fonti sostengono la scelta del protocollo, non certificano i nostri
limiti numerici né il comportamento del proxy Nhost.

## Contratto implementato

- `POST /api/ricerche`: JSON `{id, input}`, UUID v4 generato dal browser e
  filtri stringa validati dal parser esistente. Risponde 202 con `id`,
  `stato`, `Location` e `Retry-After: 1` prima della conclusione del lavoro.
  Il body di avvio è limitato a 8 KiB; non contiene risultati.
- Lo stesso ID, nella stessa sessione e azienda, con gli stessi filtri
  ammessi restituisce il registro esistente. Filtri diversi: 409;
  altra sessione, anche della stessa persona: 404. L'ID non è una credenziale.
  Le due ammissioni concorrenti ricontrollano la mappa dopo i permessi.
- `GET /api/ricerche/:id`: restituisce lo stato o `{id, stato, esito:
  {status, body}}`. L'HTTP 200 attesta la consultazione; lo status interno
  descrive la ricerca, anche quando termina con errore. Esito scaduto o
  abbandonato: 410 senza annunci; ID assente, anche dopo restart: 404.
  Nessuna consultazione crea lavori o rinnova il budget della ricerca.
- `DELETE /api/ricerche/:id`: ritira il destinatario, cancella l'esito in
  RAM, conserva una tombstone. I job in coda vengono ritirati; quelli già
  partiti possono terminare, senza consegna né nuovi recuperi. Un retry
  del DELETE non prolunga la retention.
- Permessi correnti verificati all'avvio, nei passaggi del coordinatore e
  a ogni consultazione/abbandono. Azienda e modulo devono essere ancora
  validi. `accessoDettagli` viene emesso per la sessione destinataria;
  le porzioni condivise non vengono mutate.

Il vecchio `/api/search` resta nei collaudi locali come baseline di
compatibilità. Nell'ingresso HTTPS risponde 405 senza creare lavori.
L'app AMR monolitica e il suo GET non vengono modificati: questa chat lavora
sul centro. Il frontend principale dovrà adottare il contratto nella sua
integrazione; non basta collegare una vecchia build al centro HTTPS.

## Tempi, memoria e riavvio

Il budget del lavoro rimane **60 secondi**, comprensivo dell'ammissione e
dei controlli del coordinatore. Il 202 non libera il posto: massimo due
ricerche pendenti per persona e 60 complessive, configurabili come prima.
La consultazione del risultato già concluso è distinta dal budget del job.
Le verifiche delle letture hanno quota separata 2/60 e timeout di 10 s;
un controllo non cancellabile mantiene occupato il proprio posto fino alla
conclusione effettiva. Anche l'ammissione HTTP ha questa attesa massima.

Esiti normalizzati serializzati **solo in RAM**, disponibili per 60 s dalla
conclusione. Controllo della scadenza su ogni accesso e pulizia periodica
ogni massimo 10 s: l'eliminazione passiva può avvenire al tick successivo,
mai una consegna dopo la scadenza. I riferimenti alla Promise dell'operazione
vengono rilasciati al completamento. Registro massimo 1.000 ID e 64 MiB di
esiti serializzati complessivi: una nuova ammissione oltre il primo limite
è rifiutata; un esito oltre lo spazio disponibile viene sostituito da un
errore esplicito, senza annunci troncati. Questi sono limiti iniziali del
registro, non limiti nuovi ai body dei portali né una misura del picco totale
di memoria del processo. Non è stato fatto un benchmark di carico reale.

Gli ID senza risultati restano per 10 minuti dalla conclusione/abbandono.
La protezione dal riuso non è eterna e non sopravvive al restart. Il browser
non ripete il POST: se perde la risposta iniziale consulta lo stesso ID.
Se l'ID non c'è o è scaduto, si ferma con avviso e chiede un retry esplicito.
I GET transitori vengono ripetuti senza avviare altre ricerche; pausa 1 s,
10 s per connessione e attesa complessiva browser di 75 s, che lascia un
margine di trasporto al minuto del job. Il riavvio perde coda e risultati,
coerentemente con la decisione precedente; non c'è replay automatico.

Cambio account e `pagehide` annullano la consultazione e tentano il DELETE.
La sua consegna è best effort: se la rete o la sessione sono già perse,
resta la deadline del centro. Il ritiro non attesta la cancellazione di una
chiamata al portale già inviata. Una tab sospesa abbastanza a lungo può
trovare l'esito scaduto: non viene ricostruito da un archivio.

## Prove e review

HTTP reale su localhost, centro reale, protocollo del worker reale e
risposte controllate; nessun caricamento degli scraper nelle nuove prove:

- Auto/Moto: POST concorrenti e ripetuti, GET ripetuti, un solo job consegnato.
- Risposta del POST perduta nel proxy dopo il 202: ricerca ritrovata dal GET,
  senza secondo job. Non simula o identifica la policy privata Nhost.
- Due aziende condividono la sola esecuzione identica; ID e firme separati.
- Isolamento fra sessioni/aziende, 409 per filtri cambiati, modulo negato,
  revoca dopo conclusione, quota ancora occupata dopo il 202.
- Abbandono in coda e dopo l'avvio; nessun nuovo recupero; esito tardivo dopo
  la deadline rifiutato, GET e replay non generano nuovi job.
- Scadenza, cap RAM/ID, errori sincroni e non serializzabili, rilascio quota.
- Headless: perdita POST e GET 503 senza un altro avvio, restart con ID assente,
  cambio contesto; regressioni di paginazione e retry della sola fonte.
- HTTPS: Origin prima di POST/DELETE, Admin gestionale senza modulo, vecchio
  GET disabilitato. Sonda anonima e script immagine adattati al nuovo contratto.

La review indipendente in sola lettura ha trovato tre problemi. Riproduzioni
fallite prima del fix e riuscite dopo:

1. Rileggere R1 su A dopo R2 su B riscriveva l'affinità: paginazione su A.
   Registrazione una sola volta e sequenza dei completamenti nel coordinatore:
   la prima consegna tardiva non sovrascrive un'affinità più recente, anche
   con timestamp uguali. L'ordine non dipende dalla precisione del clock.
2. DELETE ripetuto spostava la scadenza e teneva pieno il registro.
   Conservato il timestamp terminale originale.
3. Permessi lenti potevano terminare su un oggetto già eliminato/sostituito.
   GET, DELETE e riuso POST ricontrollano l'identità del registro dopo await.

Nell'ultimo passaggio sono stati riprodotti e corretti altri due casi:
timestamp uguali aggiravano il primo guard dell'affinità (ora usa la sequenza),
e un 401/403/404/410 testuale perdeva lo status nel parsing JSON e proseguiva
il polling. Il trasporto conserva lo status anche senza un body JSON; un
body di successo non interpretabile rimane un errore, mai un elenco vuoto.

Corretti durante l'implementazione anche il throw sincrono del coordinatore,
il riferimento alla Promise oltre la retention e il controllo esplicito del
modulo nell'adattatore; test dedicati per i primi due comportamenti di errore
e per il modulo negato. Non dichiarare assenza universale di vulnerabilità.

Suite completa `npm test`, prima degli ultimi fix di review: **1.401 pass,
zero fail/cancelled, 7 skip** su 1.408
test, Node 24.21.0; `.env` disabilitato, dati e log temporanei. Gli skip sono
prove opt-in di PostgreSQL/restore, restic e sonda con attese lunghe.
Giro mirato successivo: **79 pass, zero fail/skip**, inclusi headless e ingresso
TLS sintetico. L'ultimo adattamento del browser considera anche un 502 sulla
risposta del POST come ammissione non confermata: consulta lo stesso ID, non
avvia un altro lavoro. Giro finale sul candidato dopo entrambi i fix della
seconda review: **99 pass, zero fail/cancelled/skip**. Include tutti i test di
`nodi-ricerche-http`, `nodi-limiti-ricerca`, `nodi-prototipo-ui`,
`nodi-centro-run`, `nodi-ingress-staging`, `nodi-centro` e `nodi-cursori-fonti`.
La review indipendente conclusiva ha ricontrollato i due ultimi fix senza
trovare ulteriori problemi verificati; non ha rieseguito i test.
Controllo sintattico e `git diff --check` superati. Il collaudo Docker completo
della nuova immagine non è eseguito qui: lo script è aggiornato, ma il precedente
PASS sull'immagine `6a9b314` non attesta questo candidato.
Il collaudo manuale dell'utente non è ancora eseguito.

## Gate successivo

Preparare un artefatto da commit, rieseguire il collaudo dell'immagine e
concordare una prova HTTPS controllata del nuovo protocollo. Il centro completo
non è stato avviato su Nhost; la precedente sonda è ferma. Non è ancora provato
il trasferimento dei risultati reali entro i timeout del provider, né un carico
multiutente. Anche cataloghi e dettagli hanno richieste HTTP proprie: questo
incremento non certifica tutti i flussi remoti o l'intera app pronta al deploy.

Collaudo manuale previsto, dopo riavvio del prototipo aggiornato con worker
di prova: ricerca Moto, pagina successiva, retry della sola fonte e cambio
account durante un lavoro. Attesi un POST per azione, GET sullo stesso ID,
nessun annuncio del contesto precedente e avvisi espliciti sugli errori.
Una verifica live o un deploy richiedono il rispettivo perimetro concordato.
