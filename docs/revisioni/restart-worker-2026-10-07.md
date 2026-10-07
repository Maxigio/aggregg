# Restart limitati dei worker — 7 ottobre 2026

## Decisione e perimetro

Punto 3 della sequenza concordata. Il proprietario approva restart automatici
per crash e guasti temporanei; stop manuale, credenziale revocata e release
incompatibile richiedono intervento. Massimo cinque restart consecutivi,
attese crescenti, poi stop e avviso persistente. Implementazione e collaudo
locale; nessun aggiornamento dello staging, servizio installato o M2 coinvolto.

## Implementazione

`backend/nodi/worker-supervisore.js` supervisiona soltanto il figlio creato
tramite `spawn`, senza shell. È riusato dal launcher del prototipo, dal worker
del collaudo Auth e da `scripts/avvia-worker-staging.js`. Il crash di un worker
non ferma il centro o gli altri worker. Arrestare il launcher cancella gli
avvii pendenti e termina soltanto i suoi figli; cinque secondi di grazia,
poi SIGKILL se necessario. IPC interrotto arresta il worker rimasto orfano.

Il primo avvio non è un restart. I cinque restart hanno attese base
1/2/4/8/16 secondi, più jitter positivo fino al 25%. Un heartbeat riuscito
non azzera il contatore: servono cinque minuti di heartbeat continuativi,
senza intervalli oltre dieci secondi. Sono parametri tecnici del collaudo,
non misure di affidabilità in produzione. L'avvio **manuale del supervisor**
apre un nuovo ciclo; non abbiamo installato un sistema che lo riavvii da solo.

Il worker classifica le uscite: 75 temporaneo; 77 credenziale rifiutata;
78 configurazione/release incompatibile; 79 sostituzione da un altro worker
nella stessa epoca centrale. Una nuova epoca richiede un nuovo handshake
tramite restart, mentre il fencing nella stessa epoca ferma la contesa.
SIGTERM/SIGINT e fine ordinaria non producono restart. Il normale errore di
una fonte resta gestito da `fonti-salute`, senza riavviare il processo.

Nessun replay dei lavori: il centro conserva la distinzione fra mai iniziato
e incerto. Il nuovo heartbeat invalida il lavoro della vecchia esecuzione.
Un 409 di `/_nodo/esito` relativo a un risultato già scaduto lo scarta senza
restart; il 409 con fencing è trattato separatamente. Directory, ambiente e
pause delle fonti non cambiano fra gli avvii.

## Diagnostica e sicurezza

Ogni transizione salva atomicamente `worker-supervisione.json` nella directory
privata del worker, con permessi 0600. Contiene solo stato, causa codificata,
contatore e tempi; nessun token, filtro, annuncio o messaggio remoto. Un guasto
del registro ferma il ciclo e produce un esito di intervento, non successo.
Il cleanup cancella solo il file temporaneo creato da quella scrittura.

`POST /_nodo/supervisione` richiede la credenziale del nodo e valida schema,
epoca, boot e sequenza. Stato precedente o fuori ordine non può sostituire
quello attuale. Il centro conserva l'ultimo stato tecnico in SQLite e lo
espone nell'Admin esistente, con eventi e indicazione del restart/intervento.
Non è un nuovo comando Admin per avviare processi o rimuovere pause.

Se centro o rete sono indisponibili, la consegna dell'avviso remoto non è
garantita: resta la ricevuta locale, se il filesystem è scrivibile. Una
credenziale revocata non può pubblicare nuovi stati; nell'Admin resta la
revoca già registrata dal centro. Dopo il riavvio del centro, l'ultimo stato
persistito non prova che il worker sia online: serve un nuovo heartbeat.

## Finding verificati e corretti

- **Race iniziale:** supervisione prima della registrazione perdeva stop nodo
  e fonte già salvati. Riprodotta con SQLite temporaneo; la creazione ora
  rilegge le sospensioni. Controprova nei due ordini di arrivo.
- **Falso successo dopo errore I/O:** il guasto del registro interrompeva il
  worker senza evento terminale, anche nel ramo dopo `exit`. Ora la conclusione
  è emessa una sola volta e conserva l'intervento. Regressioni dedicate.
- **Cleanup IPC:** nel processo Node 24, dopo il disconnect del launcher,
  `exit(0)` era ricevuto mentre `close` non arrivava. Aspettare solo `close`
  bloccava il cleanup. Si usa `exit` come prova di morte e `close` come
  fallback per spawn fallito, con guard contro doppie conclusioni. Un semplice
  `error` non consente un nuovo spawn.
- **Compatibilità legacy:** il confronto di due campi assenti entrava nel
  ramo supervisione e impediva assegnazioni ai vecchi chiamanti. Guard esplicito
  sull'esistenza dello stato; gate preesistente preservato.
- **409 tardivo:** la nuova classificazione generale poteva fermare un worker
  per un esito scaduto. Eccezione circoscritta alla rotta dell'esito, senza
  ripetizione del lavoro; fencing e autenticazione restano obbligatori.

## Prove e limiti

Node 24.21.0. Gate esteso con dati/log temporanei, blocco del caricamento del
`.env` reale e di richieste esterne; risposte delle piattaforme simulate.
Include scheduler, boot/epoch, compatibilità artefatti, manutenzione, pause,
sonde, paginazione/retry e scraper già modificati. Prove con processi reali:
SIGKILL, restart singolo, stop, IPC e 401/403; nessun portale interrogato.

UI headless: avviso persistente, restart programmato, aggiornamento dei lavori
senza perdita di dettagli/focus/scroll. Nessun browser dell'utente aperto.
Il collaudo manuale e quello remoto sul candidato sono ancora da eseguire.

Gate finale: **515/515 pass**, 44 file, zero fail/skip/cancelled.
Ricevuta: `/private/tmp/amr-restart-gate-finale-32ak0p/test-finale.tap`,
`exit-finale.txt` uguale a 0. UI headless mirata: **2/2 pass**.
Review indipendente in sola lettura: i due finding e la variante I/O dopo
`exit` sono riprodotti, corretti e controverificati; ultima verifica PASS,
nessun altro finding riprodotto nel suo perimetro. Corretto anche il riuso
del timer di SIGKILL durante il cleanup, con regressione dedicata.
Il CHECK storico resta un finding separato.

## Fonti autorevoli consultate

- [Node — child_process](https://nodejs.org/api/child_process.html): `error`
  non garantisce la morte, `exit` attesta la fine del processo, `kill` non
  dimostra che il figlio sia terminato; eventi distinti richiedono un guard.
  Documentazione corrente, comportamento collaudato sul runtime Node 24 scelto.
- [Google SRE — Addressing Cascading Failures](https://sre.google/sre-book/addressing-cascading-failures/):
  backoff randomizzato e retry limitati evitano ripartenze sincronizzate.
- [Google SRE — Handling Overload](https://sre.google/sre-book/handling-overload/):
  budget esplicito e una sola autorità di retry evitano moltiplicazioni fra
  livelli. Il supervisor riavvia il processo, non ripete una ricerca incerta.

Queste fonti sostengono i meccanismi, non certificano i valori scelti né il
funzionamento remoto di AMR.
