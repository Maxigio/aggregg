# Collaudo staging e nodi reali — 5 ottobre 2026

## Perimetro concordato e stato

Lavorare nel solo staging Nhost AMR, prima con l’iMac. Il successivo worker M2
deve avere codice, dipendenze, dati e processo separati dall’AMR di produzione.
Prima prova M2: connessione, stato e compatibilità, senza richieste ai portali.
Le prove live M2 richiedono coordinamento delle pause e dei limiti con la
produzione sullo stesso IP. Commit dopo ciascun punto completato; niente push
o aggiornamento del servizio di produzione impliciti.

Il primo punto **non è ancora completato**: login Admin ed email reale provati;
accettazione dell’invito, attivazione e ricerca completa del referente ancora
da completare. Nessun finding sul flusso cloud è dichiarato risolto dai soli
test locali. Il centro distribuito usa ancora `66e2b24`, il checkout è sul branch
`feat/nodi-residenziali-prototipo`, baseline `ac72458`.

## Prove effettive del primo punto

- Rotte anonime HTTPS: `/healthz`, `/` e `/api/auth/pagina` rispondono 200;
  `/api/auth/me` e registrazione nodo senza token rispondono 401.
- L’utente conferma login Admin riuscito con MFA dello staging.
- Configurazione Auth remota letta con la CLI ufficiale: verifica email
  obbligatoria, TOTP abilitato, redirect di aziende e colleghi ammessi sull’origine
  Run corretta. Password, seed MFA e token non letti né riportati.
- L’utente conferma ricezione della verifica nella casella reale del referente.
  MailHog appartiene esclusivamente al precedente Auth locale; non è la casella
  dello staging. Questa prova non certifica la consegna a ogni destinatario.
- Lettura SQL aggregata, senza email/nomi/ID personali: due inviti non scaduti,
  due referenti registrati, una email verificata, zero inviti accettati, zero
  persone AMR per quei referenti, zero aziende attivate. È una fotografia del
  momento della diagnosi, non lo stato definitivo dopo azioni successive.

L’iMac usa ora un worker reale con l’artefatto esatto del centro `66e2b24`, dati
nuovi in directory privata e ambiente minimo; non eredita `.env`, Auth o SMTP.
Il nome storico del nodo contiene «simulato», ma il processo è avviato in modo
live: il nome non attesta la modalità. Registrazione autenticata 200, boot
presente e manifest compatibile; token sintetico errato 401. Queste prove non
equivalgono a heartbeat osservato nell’Admin o a ricerca dei tre portali riuscita.
L’artefatto iMac usa dipendenze locali tramite symlink, con lockfile confrontato:
non estendere questa prova a un’installazione indipendente su M2.

## Finding confermati e correzioni locali

1. **Istruzioni email errate nello staging.** HTML e JS descrivevano MailHog,
   mancato invio reale e cancellazione dei dati alla chiusura del processo.
   Quest’ultima affermazione non rappresenta PostgreSQL e il volume cloud.
   Corretto il testo: invito consegnato come link nell’Admin, verifica inviata
   separatamente da Auth, casella reale con Nhost. Nessun bypass della verifica.
2. **Il diniego AMR attribuito impropriamente a MFA.**
   `login-nhost-prova.js` nega sia un’identità AMR assente/inattiva sia un Admin
   senza MFA, con lo stesso codice. Il frontend interpretava ogni diniego come
   «Per l’Admin serve MFA». SQL `aziende_accetta` crea la persona AMR solo dopo
   accettazione; verificare l’email non basta. Corretto il messaggio generale e
   le istruzioni sul percorso invito. Test riprodotto fallente prima del fix,
   passato dopo. Autenticazione, SQL e permessi invariati.
3. **Il launcher poteva dichiarare successo dopo morte del figlio per segnale.**
   Un exit code `null` veniva trattato come zero. Corretto con `code ?? 1`;
   controprova con SIGKILL del figlio sintetico: launcher exit 1, nessuna
   credenziale in output. Arresto idempotente limitato al suo figlio.

Le correzioni UI sono ancora **locali, non distribuite**. Non ricaricare o
chiudere la scheda originale dell’invito prima di accettarlo: il suo token resta
solo nella RAM della scheda dopo rimozione del frammento. La verifica email apre
un’altra scheda; il redirect non accetta l’invito e non recupera quel token.
Non riavviare il centro durante questa consegna incompleta.

### Collaudo del referente completato

Il 5 ottobre l'utente ha confermato, nel browser dello staging: accesso del
referente, azienda attivata dall'Admin, disponibilità del solo modulo Moto e
una ricerca completata dalle tre fonti senza errori. Il worker iMac era reale
e compatibile con l'artefatto del centro. Marca/modello e ID degli annunci non
sono stati comunicati: la prova conferma il percorso operativo, non la fedeltà
di ogni filtro o il comportamento delle pagine successive. Il primo punto del
collaudo è completato; i testi corretti localmente attendono un aggiornamento
separato dello staging. Non usare questa prova per attestare il collegamento M2.

## Verifiche automatiche e review

Node 24.21.0; dati temporanei. Nessuna credenziale reale nelle fixture, nessuna
chiamata agli scraper durante i test.

- 15/15 test launcher staging e processo worker, incluso heartbeat su centro
  locale senza lavori. Il sandbox negava il listener con EPERM: ripetizione
  autorizzata fuori sandbox riuscita, senza allargare i timeout applicativi.
- 67/67 test worker staging, login, aziende HTTP, ricerche brevi e cursori.
- 29/29 test UI aziende/prototipo, browser headless con API simulate.
- 40/40 test login server/UI, incluso diniego, Admin senza MFA, revoca, due schede
  e nuova regressione sul messaggio. I conteggi si sovrappongono: non sommarli.
- Review indipendente in sola lettura completata: launcher, istruzioni email
  e messaggio login verificati. Corretta un’ambiguità del testo per chi ha già
  accettato un invito; nessuna regressione di sicurezza confermata. Il reviewer
  ha ripetuto tre test mirati e la controprova sul frontend precedente. Nessuna
  prova SMTP o M2 eseguita dal reviewer; collaudo manuale ancora da completare.

## Ostacoli confermati per M2, prima delle prove live

- Produzione M2 e checkout hanno codice diverso; cataloghi uguali non provano
  compatibilità del protocollo. Il worker dovrà usare l’artefatto esatto del
  centro e dipendenze proprie, senza sostituire il runtime della produzione.
- `worker.js` in modalità simulata esegue comunque poll e può ricevere lavori
  di fallback. «Simulato» non equivale a «solo stato»: non usarlo come gate M2
  senza traffico. Serve un vincolo di mancata assegnazione/esecuzione verificato.
- `fonti-salute.js` conserva stato autorevole in Map e carica SQLite una volta.
  La versione M2 ha inoltre uno schema e una ripartenza precedenti. Condividere
  il file SQLite non coordina due processi già attivi e può sovrascrivere stati
  più recenti. Nessuna prova live sullo stesso IP prima di una soluzione comune
  provata e di una scelta sull’intervento necessario alla vecchia produzione.
  Controprova locale con due processi e un unico database temporaneo: dopo il
  429 sintetico registrato dal secondo, il primo già avviato vede ancora la
  fonte disponibile; un terzo processo appena avviato legge invece la pausa.
  Nessuna chiamata ai portali o modifica M2 durante questa prova.
- Un nuovo token M2 va distinto dal token iMac; il centro carica la lista dei
  nodi autorizzati all’avvio. Configurazione e aggiornamento Run devono seguire
  manutenzione, gate e rollback concordati, dopo la consegna degli inviti.

Nessun worker installato/avviato su M2, nessuna scrittura o interruzione del suo
servizio. Backup esterno e stabilità dei peer proxy restano gate separati.

## Fonti ufficiali consultate

- [Nhost email/password](https://docs.nhost.io/products/auth/sign-in-email-password):
  verifica automatica alla registrazione e reinvio; non prova la consegna SMTP.
- [API reinvio verifica](https://docs.nhost.io/reference/auth/post-user-email-send-verification-email):
  contratto del servizio, distinto dall’accettazione commerciale dell’invito.
- [Nhost Run networking](https://docs.nhost.io/products/run/networking):
  ingress e connessioni, non prova di funzionamento delle ricerche.
- [Circuit Breaker Microsoft](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker):
  pause e tentativo di verifica limitato; la coordinazione fra processi va provata.
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585): 429 e Retry-After; il criterio
  di conteggio della piattaforma non è necessariamente il solo IP.
- [Node child_process](https://nodejs.org/api/child_process.html): ambiente del
  figlio, IPC, segnali e codice di uscita nullo quando termina per segnale.
