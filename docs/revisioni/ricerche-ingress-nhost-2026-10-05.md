# Ricerca del centro dietro ingress — 5 ottobre 2026

## Perimetro e risultato

Baseline `3e1b89b`, branch `feat/nodi-residenziali-prototipo`.
Incremento locale successivo alla [sonda Nhost](sonda-nhost-diagnostica-2026-10-05.md):
riprodurre l'effetto di una disconnessione con retry sul centro reale, prima
di scegliere la modifica del protocollo. Nessun runtime modificato, centro
remoto avviato, portale interrogato o intervento sull'M2. File preesistenti
delle altre lavorazioni preservati. Commit richiesto dall'utente.

**Verificato nel laboratorio:** una sola richiesta del browser, inoltrata
due volte da un proxy controllato dopo l'abbandono del primo destinatario,
può produrre due lavori identici consegnati al nodo. Riprodotto per Auto e
Moto, anche con un solo nodo: il secondo lavoro aspetta il primo e poi parte.
**Non dimostrato:** due chiamate effettive ai portali o una policy universale
di retry Nhost. La sonda remota resta un indizio sostenuto di retry a monte;
questa prova impone esplicitamente il taglio e il retry, non scopre né
replica la configurazione privata del provider.

## Percorso verificato nel codice

- `backend/nodi/centro.js:827`: il GET ammette il destinatario, prima dei
  controlli asincroni; alla chiusura HTTP interrompe il suo budget.
- `centro.js:496`: la condivisione riguarda soltanto la prima pagina
  esattamente identica, senza cursori o selezione di fonti.
- `centro.js:524`: l'ultimo destinatario ritirato interrompe l'operazione;
  `centro.js:510` rimuove la condivisione e i lavori ancora in coda.
- `centro.js:659`: il poll ha già consegnato il lavoro; il ritiro del
  destinatario non invia un annullamento al worker. È coerente con la
  decisione di lasciar terminare le richieste già partite.
- Il GET ripetuto non ha un identificatore dell'operazione originaria:
  `centro.js:507` crea un nuovo lavoro se la vecchia condivisione è assente.
- `centro.js:672`: un esito del vecchio lavoro può ancora essere registrato
  se arriva prima del suo timer; non viene consegnato al destinatario perso
  né usato per avviare nuovi recuperi. Dopo la scadenza è rifiutato.
- `centro.js:862`: la risposta al browser richiede un nuovo controllo dei
  suoi permessi; le firme `accessoDettagli` appartengono alla sua sessione.

Il default è 60.000 ms in `backend/nodi/config-centro-run.js:47` e
`backend/nodi/limiti-ricerca.js:3`. Il controllo finale precede la
serializzazione e la consegna HTTP (`centro.js:868`): non garantisce che il
browser riceva l'intera risposta entro quel tempo. La sonda ha osservato
una chiusura intorno a 60 secondi: manca un margine operativo dimostrato.

## Prove e controprove

Sette casi aggiunti al file esistente `test/nodi-limiti-ricerca.test.js`.
Il proxy usa HTTP reale su localhost e un solo retry esplicito, in punti
di taglio controllati; sessioni sintetiche, protocollo poll/esito reale,
risposte del nodo simulate. Non carica né chiama i motori di scraping.

| Caso | Esito osservato |
| --- | --- |
| Auto, taglio dopo il poll, due nodi disponibili | Due ID lavoro diversi, input e azienda uguali, entrambi avviati |
| Moto, stesso ordine degli eventi | Stesso risultato; al browser arrivano solo le righe del secondo lavoro |
| Taglio prima del poll | Primo lavoro interrotto e ritirato; solo il secondo viene eseguito |
| Un solo nodo, taglio dopo il poll | Retry accodato; prima termina il vecchio lavoro, poi il nuovo viene consegnato |
| Un'altra azienda attende la ricerca identica | Un solo lavoro, condivisione mantenuta; firme dettagli distinte per le sessioni |
| Deadline applicativa, lavoro in coda, senza taglio imposto | HTTP 504 esplicito attraverso il proxy, nessun lavoro consegnato al nodo |
| Deadline reale breve, lavoro già avviato | HTTP 504 con `incerto: true`, nessun annuncio; esito tardivo rifiutato con 409 |

La prova di deadline in coda usa il clock monotono iniettato, senza
aspettare un minuto; quella sul lavoro avviato usa un timer reale di
500 ms. Nessuna delle due misura il margine HTTP in produzione o dimostra
che un proxy reale non ritenti anche una risposta 504 completa.
I test diagnostici che osservano due lavori descrivono il difetto attuale:
il loro PASS conferma la riproduzione, **non certifica un fix**. Quando il
protocollo cambierà, dovranno verificare l'assenza della seconda esecuzione.

Ultimo giro locale: **63 pass, zero failure/cancelled/skip**, Node 24.21.0.
File: `nodi-limiti-ricerca`, `nodi-centro`, `nodi-cursori-fonti`,
`nodi-autorizzazioni-dettagli`, `nodi-baseline`, `nodi-worker-processo`.
Ambiente `env -i`, dati/log temporanei e preload `no-dotenv-preload.cjs`.
La sandbox iniziale non consentiva il listener; prove valide ripetute con
i permessi necessari. Corretto nel test un nome di campo firma sbagliato;
aggiunta la scadenza esplicita alle sessioni sintetiche perché il controllo
delle firme fosse reale, invece di confrontare due valori assenti.
La suite completa e il browser non sono stati collaudati in questo incremento.

## Debunking: due lavori non implicano due chiamate ai portali

`backend/ricerca-coordinatore.js:214` può riusare una ricerca completa
positiva per tre minuti o una ricerca identica ancora in volo. La chiave
comprende lo scope aziendale (`:195`); le cache sono locali al processo.
Risposte vuote, errori, timeout, pause e diverse forme di parzialità non
entrano nella cache completa (`:197`). Le cache specifiche degli scraper
possono offrire ulteriori protezioni.

Controprova eseguita: i test baseline del coordinatore reale usano fonti
simulate e confermano riuso nello stesso scope e separazione fra scope
distinti. Non sono eseguiti dentro il proxy controllato. Due lavori su
nodi diversi non hanno la stessa cache RAM; su un solo nodo il secondo
può invece riusare la risposta del primo. L'impatto sulle richieste live
rimane condizionato a cache, tempi, risposta e fonte: non quantificato.

Non è dimostrato che una ricerca ordinaria debba durare 60 secondi: le
fonti iniziali hanno timeout di 45 secondi (`ricerca-coordinatore.js:22`),
ma coda, preparazione, allargamenti, controlli di accesso e altri nodi
consumano il budget complessivo. Il sistema non impone una conclusione
entro 45 secondi a tutte queste fasi.

## Fonti ufficiali e alternative

Consultate il 5 ottobre 2026:

- [Nhost Run networking](https://docs.nhost.io/products/run/networking):
  documenta rete interna e porte pubbliche, non una garanzia sul timeout
  o sui retry del servizio osservato. La reference di configurazione
  consultata non dà una regolazione pubblica di quel timeout. Non prova
  che una configurazione diversa sia impossibile: resta da chiedere al provider.
- [NGINX proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout):
  documenta un timeout predefinito di lettura di 60 secondi fra letture,
  non un limite universale sulla durata totale. `proxy_next_upstream`
  permette retry su errori e timeout; i metodi non idempotenti già inviati
  non vengono normalmente ritentati senza l'opzione apposita. Compatibile
  col campione, **non prova che Nhost usi quel proxy o quei default**.
- [RFC 9110, idempotenza](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2):
  prevede ripetizioni dei metodi idempotenti dopo guasti di comunicazione.
  Gli effetti accessori di un GET non lo rendono automaticamente illecito;
  il punto per AMR è non assumere che un ingresso HTTP equivalga a una
  sola esecuzione. Il solo cambio di metodo non garantisce la consegna.
- [Microsoft, asynchronous request-reply](https://learn.microsoft.com/en-us/azure/architecture/patterns/asynchronous-request-reply):
  propone avvio con 202 e consultazione dello stato; indica autorizzazione
  dell'operazione, retention e chiave di idempotenza per non accodare due
  lavori quando si perde la risposta iniziale. Non richiede di adottare
  Azure, un broker o persistenza dei risultati per questo prototipo.

| Alternativa | Vantaggio | Limite verificato o condizionato |
| --- | --- | --- |
| Accorciare la deadline | Configurazione minima, lascia margine al proxy | Riduce il budget concordato per coda/recuperi; non protegge da ogni replay o perdita di risposta |
| POST sincrono | Evita i retry automatici conformi alla semantica non idempotente | Resta la connessione lunga; trasferire anche limiter e controlli Origin; comportamento ingress ancora da verificare |
| POST breve + ID + GET esito | Mantiene il budget del lavoro e separa la consegna dalle connessioni lunghe | Gestire proprietà, idempotenza, TTL, cap RAM, quote e abbandono; più lavoro nel frontend |
| Modificare il proxy Nhost | Potenzialmente nessun cambio nell'app | Controllo e policy del provider non dimostrati; non basta presumerli configurabili |

## Raccomandazione e gate successivo

Propongo il POST breve con ID logico dell'operazione e consultazione
autorizzata dell'esito; mantenere i 60 secondi e riusare `ricerca()` e il
coordinatore esistente. Direzione approvata dall'utente nell'interview:
«Avvio breve + ID + consultazione esito». Non è l'unica scelta valida.

Prima dell'implementazione definire e verificare:

1. ID e idempotenza scoped alla sessione/persona, azienda e tutti i parametri;
   parametri diversi con la stessa chiave devono essere rifiutati. La proprietà
   dell'esito resta distinta dalla condivisione della sola esecuzione.
2. Controlli correnti di sessione, azienda e modulo all'avvio, al poll del
   nodo e prima di ogni consegna; firme dettagli emesse per il destinatario.
3. Quota occupata fino alla conclusione, non liberata dal 202; consultare
   l'esito non rinnova la deadline né invia richieste ai portali.
4. Esiti solo temporaneamente in RAM con scadenza e cap espliciti; nessun
   archivio centrale degli annunci. Conservare cursori, stati e avvisi.
5. Abbandono esplicito distinto dalla perdita di una singola connessione;
   jobs già partiti terminano senza nuovi recuperi per destinatari ritirati.
6. Restart senza replay automatico, coerente con la perdita della coda
   concordata; distinguere esito non disponibile da ricerca da eseguire.

Review indipendente in sola lettura: analizzate le tre alternative e i
vincoli di revoca, quote e restart; corretti il titolo troppo ampio della
prova 504, la mancata verifica dell'ACK del primo esito e lo stato della
decisione dopo l'interview. Il numero di chiamate live resta condizionato.
Il budget più breve può essere una mitigazione, non è stato adottato come
soluzione definitiva. Questo commit fissa solo la diagnosi; il protocollo
approvato viene sviluppato nel successivo incremento. Gate remoto aperto.

Aggiornamento: implementazione e controprove del protocollo nel
[registro dell'avvio breve](ricerche-http-asincrone-2026-10-05.md).
I test diagnostici precedenti restano riferiti al GET locale di compatibilità;
le nuove prove verificano un solo lavoro sul percorso POST/GET.
