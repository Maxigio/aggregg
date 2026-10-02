# AMR completo e centro — confini prima dello staging

Stato del 2 ottobre 2026. Mappa ricostruita dalle rotte montate da
`backend/server.js`, dai moduli delle rotte e da `backend/nodi/operazioni.js`.
Non è una dichiarazione di integrazione completata: APP conserva la proprietà
dell'app principale; AP prepara centro, account e nodi. Nessuna modifica M2.

## Percorsi e destinazione

| Funzione e rotte | Comportamento attuale | Destinazione proposta | Permesso e dati |
| --- | --- | --- | --- |
| Ricerca `/api/search` | Coordinatore, tre fonti, pagine e retry | Nodo per le chiamate; composizione pura nel centro | Modulo richiesto; annunci solo RAM e transito |
| `/api/brands`, `/api/models`, `/api/versioni` | Cataloghi locali; models Moto può aggiornare il menu tramite Moto.it | Nodo, già nel prototipo | Modulo richiesto; nessun nuovo archivio di annunci |
| `/api/filtri-auto` | Definizioni statiche da `frontend-route` | Centro; adattare `/api/filtri` del prototipo al contratto APP | Auto; configurazione pubblica del prodotto |
| `/api/detail` | Trasporto verso il portale e cache transitoria | Nodo, già nel prototipo con firma risultato/sessione/modulo | Permessi correnti prima e dopo; non usare URL arbitraria |
| `/api/report-pdf` | Rendering sincrono dei dati inviati dal browser, senza interrogare fonti | Centro, riusare renderer e cap dichiarato | Account autorizzato; body e PDF transitori, nessun log annunci |
| PDF scheda veicolo | Composto nel browser con jsPDF/autoTable | Browser | Dati della scheda autorizzata; distinto dal PDF dei risultati |
| CSV | Composto dal browser | Browser | Stesso insieme di risultati visibili; nessun job nodo |
| `/api/liquidita` | Lettura archivio ACI locale | Centro | Modulo pertinente; archivio pubblico, non risultati cliente |
| `/api/carburanti` | Indice locale; cache assente/scaduta scarica prezzi e impianti MIMIT | Lettura nel centro; refresh remoto distinto, da collaudare nello staging prima di scegliere centro o nodo | Modulo pertinente; due download nel refresh, nessun archivio di annunci |
| `/api/passaggio` | Calcolo locale IPT; ramo opzionale Motornet in rete | Calcolo nel centro; verificare `motornet.ATTIVO` e separare il ramo di rete se attivo | Modulo pertinente; dichiarare stime, non salvare annunci |
| `/api/scheda-veicolo`, `/api/scheda-veicolo/annuncio`, `/api/scheda-veicolo/specs` | Criteri di ricerca, attributi dell'annuncio e URL di catalogo riconosciuta: tre contratti distinti, cache e parser dedicati | Richieste remote sui nodi; riuso dei servizi esistenti | Modulo e provenienza pertinente al flusso; validare criteri/attributi e URL riconosciute senza imporre una firma annuncio a ogni ramo |
| `/api/prove/auto`, `/api/prove/moto`, `/api/prove/moto/prova` | Fonti remote con cache e avvisi di incompletezza | Nodo | Auto/Moto; non trasformare un errore in assenza |
| `/api/richiami/*` | Safety Gate locale e ramo RDW; `omologazione` può richiedere rete | Archivi nel centro; ramo remoto da classificare sul servizio effettivo | Modulo pertinente; sola informazione pubblica |
| `/api/fonti/*` | OSM/EPREL/cerchi/costi: alcune letture locali, altre remote | Locali nel centro; remote sui nodi dopo review della fonte | Nessun inoltro generico di URL o comandi |
| `/api/targa/sfida`, `/api/targa/verifica` | CAPTCHA umano, sessione di portale RAM fino a 5 minuti, cancellata dopo uso | Stesso nodo per i due passi; nuova sfida esplicita se perso | Proprietario della sfida e modulo; targa esclusa da log e backup |
| `/api/miei` e preferenze | SQLite personale `utenti-db`, nessun salvataggio annunci/ricerche | Stato personale nel PostgreSQL centrale, isolato per UUID | Identità server; non usare `owner` come ripiego centrale |
| `/api/report` e assistenza | Segnalazioni persistite in JSONL; link umani WhatsApp | Segnalazioni nel centro con schema ammesso e retention concordata | Nessun annuncio/body automatico; log e backup separati dal journal commerciale |
| Login, inviti e aziende | Vecchio gate dell'app e nuovo collaudo Nhost distinti | Un solo sistema centrale; non montare il vecchio login nel centro | Identità verificata, ruoli e modulo dal server |
| Frontend, asset e `/guida` | `frontend-route` serve interfaccia, build e guida dell'app | Centro, preservare URL e build dell'app oltre al prototipo | Nessuna credenziale nei file pubblici; distinguere asset pubblici e API protette |
| Aste/Ricambi/Competitor/bot | Accantonati | Esclusi dal rilascio attuale | Nessuna riattivazione implicita |

Le destinazioni proposte distinguono calcoli/archivi da accessi remoti; non è
corretto inviare tutto ai nodi o montare tutte le rotte del monolite nel cloud.
Le rotte accessorie non sono ancora equivalenti nel centro e devono essere
integrate con APP prima del gate dell'app completa. Il branch non va pubblicato
come sostituto del monolite sulla base dei soli test del form di ricerca.

## Condizioni di integrazione con APP

1. Stessa revisione di codice e cataloghi per centro/nodo; cataloghi generati e
   menu dinamici vanno distinti. L'hash dei file non rende immutabile Moto.it.
2. Conservare URL, query, risposta e comportamento del frontend principale;
   adattare la sessione alla nuova identità senza duplicare la ricerca.
3. Autorizzare ogni rotta prima dell'esecuzione e prima della consegna. Revoca o
   scadenza durante il lavoro produce soltanto esito dell'interruzione, senza annunci.
4. Targa e altri flussi con stato richiedono affinità al nodo e un proprietario;
   non trasferire una sessione di portale in un job diagnostico persistito.
5. I test del browser devono esercitare CSV, PDF risultati e PDF scheda, dettaglio, dati veicolo,
   preferenze e assistenza oltre alla ricerca. Servono prove della rete nello staging.

## HTTPS e confine operativo

Il collaudo manuale resta loopback con database temporaneo. Prima di un entrypoint
pubblico servono origine HTTPS fissata, cookie Secure, proxy configurato sul
percorso effettivo, sessioni revocabili con comportamento esplicito al riavvio,
un solo scheduler attivo e
credenziali per nodo revocabili. Rimuovere il controllo localhost da solo non
completa questo lavoro. Nessun endpoint pubblico o servizio cloud attivato.

Il candidato locale mantiene le sessioni in RAM: dopo il riavvio gli utenti
devono effettuare un nuovo login e nessuna vecchia sessione viene riammessa.
La persistenza delle sessioni non è stata implementata o implicitamente
autorizzata dal gate HTTPS. Prima del lancio ai clienti va concordato e
collaudato se mantenere questo comportamento o introdurre sessioni durabili;
non presentare la persistenza come una funzione già disponibile.

Riferimenti verificati: [Express e proxy](https://expressjs.com/en/guide/behind-proxies/),
[Nhost Run networking](https://docs.nhost.io/products/run/networking),
[OWASP sessioni](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
La configurazione Nhost reale e il comportamento del proxy richiedono un gate
separato: le simulazioni non dimostrano il trasporto remoto o i limiti del servizio.
