# Gestione aziende in PostgreSQL — preparazione del prossimo incremento

1 ottobre 2026. Baseline: `8d6e4cc`, login Nhost e lettura dei permessi nel centro, 75/75 test locali superati. Nessuna implementazione di questo incremento ancora eseguita.

## Percorso verificato

- `backend/nodi/account-prova.js`: creazione/configurazione azienda, inviti, accettazione, revoca e cambio referente esistono soltanto nel modello SQLite sintetico.
- `backend/nodi/account-prova-route.js`: le scritture usano quel modello e una sessione sintetica. Non si possono collegare queste rotte al provider PostgreSQL semplicemente sostituendo il nome del modulo: le chiamate diventano asincrone e l'identità della sessione cambia.
- `backend/nodi/schema-accessi-prova.sql`: tabelle reali di persone, aziende e membri; appartenenza unica, ma nessun referente, invito, registro delle operazioni o quota globale applicata alle scritture.
- `backend/nodi/accessi-postgres-prova.js`: ruolo di sola lettura tramite funzione SQL. Non assegnargli permessi di scrittura o lettura dei dati Auth per comodità.
- `backend/nodi/login-nhost-prova.js`: MFA verificata dal provider e controlli correnti di persona/epoca. Le future scritture devono usare questa sessione, mai persona/ruolo dichiarati nel body.

## Incremento proposto

Primo percorso: Admin con MFA crea un'azienda, indica referente, moduli Auto/Moto e scadenza; il referente verificato accede solo ai moduli acquistati. Gestione colleghi, rinnovi, revoche e backup esterno seguono in incrementi distinti. Non attivare cloud, SMTP Aruba o M2.

1. Definire come arriva il primo referente: persona già registrata e verificata, oppure invito dell'Admin seguito da scelta della password e verifica email. La sicurezza non determina questa scelta di prodotto; attendere la risposta del proprietario prima di implementare l'onboarding.
2. Usare PostgreSQL reale e una transazione sullo stesso client. Serializzare l'ammissione alla quota globale di dieci aziende su una riga dedicata; bloccare la persona scelta e preservare il vincolo di appartenenza unica. Un semplice `count` seguito da `INSERT` non protegge due transazioni concorrenti.
3. Rileggere l'autorizzazione Admin nel percorso transazionale e richiedere la prova MFA della sessione. Non attribuire MFA a un booleano ricevuto dal browser; una revoca verificata dopo l'avvio della richiesta deve prevalere prima della modifica quando osservabile.
4. Registrare l'operazione confermata nella stessa transazione, con identificativo stabile per retry/idempotenza. Nessuna password, token o annuncio nel registro. L'esito della copia esterna è distinto dal commit SQL: fino al collaudo OneDrive non dichiararla eseguita.
5. Provare utenti non Admin, Admin senza MFA, persona disabilitata/non verificata, appartenenza esistente, concorrenza sul decimo posto, rollback e retry. Ripetere ingresso/coda/consegna del centro per verificare l'effetto dei nuovi permessi. Review del diff e prove di regressione prima di dichiarare completato il percorso.

## Debunking

- La transazione SQLite precedente non prova la concorrenza PostgreSQL: confermato dal percorso dei driver, richiede due connessioni reali.
- Bloccare un'azienda inesistente non serializza la creazione del decimo posto: occorre una risorsa comune già presente. È un problema verificabile della soluzione ingenua, non un difetto nuovo attribuito al codice di lettura.
- Dare al processo una connessione superuser farebbe funzionare i test ma annullerebbe la prova del minimo privilegio: usare un ruolo limitato e prove negative.
- Scrivere DB e copia OneDrive in due passaggi non è atomico. Registro transazionale e stato di copia rendono il fallimento rilevabile; non garantiscono sopravvivenza a perdita totale del DB prima dell'upload.
- Il percorso d'invito richiede uno stato azienda non ancora attivata e gestione di scadenza/prenotazione del referente; non improvvisarlo come variante dell'inserimento di un membro già verificato.

## Fonti primarie consultate

- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): negazione predefinita, controlli per richiesta e minimo privilegio.
- [PostgreSQL 16: blocchi](https://www.postgresql.org/docs/16/explicit-locking.html): blocchi di riga e loro durata transazionale.
- [node-postgres: transazioni](https://node-postgres.com/features/transactions): stesso client per BEGIN, query e COMMIT/ROLLBACK; non `pool.query` per ogni passaggio.
- [Transactional outbox, autore del modello](https://microservices.io/patterns/data/transactional-outbox.html): modifica e record da inviare nella stessa transazione; consegna successiva e duplicazioni da gestire.
- [Nhost: registrazione email/password](https://docs.nhost.io/reference/auth/post-signup-email-password): registrazione distinta dall'autorizzazione AMR. La documentazione corrente non sostituisce il collaudo della versione Auth 0.49.1 usata localmente.

## Decisione aperta

Decisione ricevuta: il primo referente arriva tramite invito dell'Admin. Il proprietario ha indicato un proprio indirizzo come destinatario del collaudo; non viene riportato nel registro o inserito nel codice. Nessuna migrazione o scrittura commerciale eseguita.

## Verifica del percorso d'invito

Il client `nhost-auth-client.js` implementa attualmente login, TOTP e logout, non registrazione. Il collaudo `collauda-nhost-locale.js` registra le fixture direttamente contro Nhost e intercetta le email in Mailhog; non esiste ancora un invito aziendale reale né un invio SMTP esterno. L'indirizzo indicato non implica che un messaggio sia già stato consegnato.

Proposta circoscritta: Admin autenticato con MFA crea azienda in preparazione e invito del referente; il destinatario sceglie la propria password tramite il flusso Nhost locale, verifica l'email e accetta l'invito. Il backend lega il token all'indirizzo verificato ricevuto dal provider e converte la prenotazione in appartenenza, in transazione. Un'azienda in preparazione non autorizza ricerche. Non creare una password al posto del destinatario né concedere il ruolo Admin al referente.

Per token casuali, monouso, con scadenza e conservazione protetta si riutilizzano i principi di [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html), adattandoli agli inviti: la fonte non specifica le regole commerciali AMR. Invito pending: sette giorni, come già concordato. La visita GET del link non consuma l'invito: scanner email o prefetch non devono attivare un'azienda.

Controprove da includere: token rubato con identità di un'altra email, accettazione doppia/contemporanea, invito scaduto/revocato, persona già membro di un'altra azienda, email non verificata, autoassegnazione Admin, riavvio tra signup e accettazione, mancata consegna email e retry senza nuovo consumo di quota. Se l'indirizzo scelto coincide con quello dell'Admin del collaudo, non trasformare implicitamente quell'identità in cliente: dichiarare il conflitto e concordare un destinatario distinto, senza leggere le credenziali del file per diagnosticare.

Domande aperte, presentate insieme al proprietario: nome azienda di collaudo, moduli, decorrenza annuale (attivazione Admin successiva all'accettazione oppure creazione dell'invito). Finché manca la risposta non implementare una scelta commerciale arbitraria. Nessuna email reale inviata, nessun servizio cloud o M2 coinvolto.

## Decisioni confermate e incremento avviato

Il proprietario ha scelto **AMR collaudo**, **solo Moto**, validità annuale dalla sua attivazione Admin **dopo** l'accettazione. L'invito non avvia la validità. L'azienda deve essere negata sia in attesa dell'invito sia dopo l'accettazione, fino all'attivazione esplicita.

Implementazione in corso nel solo stack locale. L'indirizzo destinatario si inserisce nel form Admin, non nel codice, nei test o nel registro. L'invito locale viene presentato con link temporaneo e dicitura esplicita «non inviato»; la verifica email Nhost è intercettata da Mailhog. Il collaudo non configura un SMTP esterno e non dimostra consegna a Gmail.

Debunking aggiuntivo: il redirect Nhost senza PKCE può contenere un refresh token. La registrazione dell'invito richiede `codeChallenge`; il verificatore non viene scambiato perché la verifica email non crea la sessione AMR: il referente esegue un login separato dopo la verifica. L'esperimento reale controlla l'assenza di refresh token nel redirect. Il link invito usa un frammento, rimosso dal browser con `history.replaceState`; il segreto resta temporaneamente nella pagina e nel server di consegna locale, non nel registro SQL.

## Esito dell'incremento locale

Implementati schema SQL aggiuntivo, dominio PostgreSQL e rotte/interfaccia del collaudo. Ruolo web scrittore può eseguire soltanto le funzioni pubbliche del dominio; il loro proprietario è un ruolo senza login con colonne Auth limitate. Query parametrizzate, errori depurati, massimo 32 operazioni nel dominio e quattro nelle rotte. Un'unica funzione SQL esegue atomicamente ciascuna operazione; non vengono distribuiti BEGIN/COMMIT fra client differenti del pool.

Percorso: Admin con MFA → azienda inattiva e invito monouso di sette giorni → registrazione Nhost/PKCE → email verificata → accettazione legata alla stessa email → attivazione Admin → un anno di calendario secondo PostgreSQL, solo moduli assegnati. Retry di invito/attivazione con identificativo e parametri coerenti non duplica l'operazione né prolunga la licenza. Il database conserva solo l'impronta del token, il link di prima consegna rimane temporaneamente in RAM.

Prove:

- **80/80** test `test/nodi-*.test.js`, dati temporanei e provider/fonti simulati; `/private/tmp/amr-aziende-regressione-finale.log`.
- Nhost 0.49.1 e PostgreSQL 16 reali: `/private/tmp/amr-aziende-nhost-reale.log`. Email non verificata negata, invito monouso, attivazione prematura negata, sola Moto dopo attivazione, retry con scadenza identica, SQL writer senza lettura Auth/tabelle AMR. Due creazioni sul decimo posto con contesa del lock osservata: una confermata, seconda annullata. Token valido con persona estranea non consumato; invito scaduto negato e stato «scaduto» in elenco; funzione SQL Admin senza MFA negata.
- Il primo test PKCE ricostruiva erroneamente la URL senza codeChallenge e aveva escape sbagliati nel parser dell'email. Corretto il test conservando quel parametro e ripetuto il percorso reale; il controllo dell'assenza di refresh token nel redirect è rimasto attivo.
- Review indipendenti delle rotte/UI e del dominio SQL: nessun ulteriore finding riproducibile nel perimetro corrente. Non costituiscono una garanzia di assenza di difetti.
- Ultimo avvio manuale ripete le prove reali (compreso anno di calendario dalla data di attivazione), poi elimina **solo le aziende/membership/operazioni delle fixture nel DB temporaneo** per non lasciare la quota occupata. Pagine login/aziende HTTP200; elenco senza sessione HTTP401. Nessuna prova in browser del percorso manuale del referente ancora eseguita dall'agente: sarà collaudato dal proprietario.

Correzioni emerse dalla review: rendere visibile l'invito scaduto; svuotare le fixture prima dell'uso manuale, altrimenti i dieci posti di test impedirebbero di invitare il referente; aggiungere il reinvio della verifica email; impostare timeout anche sul server PostgreSQL per scritture/lock, oltre al timeout del driver.

### Limiti dichiarati

- **Nessuna email inviata a Gmail**: invito disponibile tramite link di collaudo; verifica email Nhost solo Mailhog. SMTP reale, template di invio esterno e consegna effettiva richiedono il gate dedicato. Il form non dichiara mai invio riuscito.
- Un destinatario con MFA già attiva riceve un errore esplicito: questa variante dell'accettazione non è implementata. Admin proprietario e referente cliente rimangono identità distinte; la stessa email dell'Admin viene rifiutata come referente.
- Aggiornando il processo locale, TOTP del collaudo viene rigenerato; configurazione precedente non vale sul nuovo stack. Password dal file dedicato conservata, mai visualizzata o cambiata dall'agente.
- Token della consegna perso al riavvio o visita ricaricata senza link: riaprire il link iniziale; riemissione/revoca inviti e cancellazione delle aziende scadute non ancora implementate. Le aziende draft rimangono nel limite globale di dieci fino al successivo incremento di gestione; non descrivere l'intero ciclo commerciale come pronto.
- Registro operazioni SQL con stato backup pending/non_configurata; **nessuna copia OneDrive o ripristino verificato**. Schema completo di rinnovi/revoche/pagamenti e informazioni necessarie al loro reinserimento restano nel gate commerciale/backup.
- Nessun commit, cloud, deploy o M2. Modifica parallela di backend-centrale-amr.md preservata.


## Integrazione nel frontend del prototipo — 1 ottobre 2026

Richiesta: unire la gestione account al centro diagnostico. Implementata la sezione
**Account e aziende** nel prototipo Nhost: stato sessione, logout, creazione invito,
elenco e attivazione annuale. La pagina separata rimane per il destinatario.
Il pannello incorpora il medesimo markup servito dalla pagina aziende e usa lo
stesso script con selettori confinati al proprio contenitore. Nessuna copia delle
regole commerciali, nessun cookie/token provider accessibile a JavaScript.
Il prototipo sintetico precedente continua a usare la selezione Azienda A/B.

Il browser non decide i permessi: `/api/auth/me` determina cosa mostrare e le
rotte delle aziende ricontrollano Admin/MFA per ogni operazione; SQL resta
l'autorità per scritture e quote. Il logout invalida anche contesto di ricerca,
pagine pendenti, diagnostica e link temporaneo di consegna nel browser.
L'autorizzazione viene aggiornata ogni 30 secondi e su comando; le risposte di
ricerca/diagnostica precedenti al cambio di contesto vengono scartate.

### Problemi verificati e corretti

- UI/polling della diagnostica anche per cliente Nhost: backend negava con 403,
  ma UI mostrava comandi Admin e interrogava il centro ogni tre secondi.
  Ora solo un contesto Admin abilita pannello e polling; il logout li disabilita.
  Controprova: la modalità sintetica locale mantiene la diagnostica precedente.
- L'identificativo di attivazione era legato al bottone ricreato dopo ogni elenco.
  Ora resta associato all'azienda per la durata della pagina: la prova simula
  scrittura confermata e lettura dell'elenco fallita, poi aggiornamento e retry,
  verificando che sia inviato lo stesso identificativo.

### Prove e limiti

- `test/nodi-aziende-ui.test.js`: Chromium/Chrome headless, account e provider
  sintetici, vere rotte HTTP AMR. Invito, Admin/cliente, logout, idempotenza,
  assenza di collisioni DOM e interpolazione HTML, risposta diagnostica tardiva,
  assenza polling cliente e viewport mobile. Nessuna preview aperta all'utente.
- Risorse HTML/JS del collaudo già acceso HTTP200, senza riavviarlo, leggere
  credenziali/cookie o cambiare il QR MFA. Controllati solo status HTTP della
  casella locale, nessun messaggio letto.
- Verifica email ancora intercettata da Mailhog: **nessun invio reale a Gmail**.
  Configurare SMTP esterno richiede un incremento separato. Il link della casella
  viene comunicato all'utente per aprire la verifica in un'altra scheda.
- Non implementati nuovi flussi per colleghi, rinnovi, revoche, OneDrive o cloud;
  restano i limiti già dichiarati del dominio aziende.
- Controlli coerenti con [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
  e [Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
  Nessun commit o deploy richiesto in questo incremento; lavoro parallelo preservato.

Regressione finale integrazione: **81/81**, nessun fallimento o skip, inclusa la
prova headless; `/private/tmp/amr-account-integrazione-finale.log`.

Decisione confermata dopo l'integrazione: completare prima il collaudo con la
casella locale. SMTP reale e consegna Gmail restano al prossimo gate dedicato.

## Correzioni UX e collegamento worker — 1 ottobre 2026

Segnalazione: messaggio generico alla creazione invito, login MFA senza ingresso
immediato nel prototipo, ricerca non disponibile. Decisioni confermate:
**Admin solo gestionale**, referente per le ricerche; collegare il worker reale
solo iMac, nessun M2.

Verificato nel codice: login completato mostrava un link; ora usa un redirect
fisso `/`, anche quando una sessione valida apre la pagina login. Nessun
`returnTo` controllato dal browser. La risposta `/me` tardiva non prevale su un
logout. Verificato con test in memoria e percorso completo nel browser.

Verificato sul collaudo attuale con soli conteggi aggregati: un'azienda, un invito
pending, nessuna azienda attiva e zero membri. L'Admin non ha membership/licenza.
La ricerca non viene abilitata implicitamente all'Admin; la UI dichiara il
percorso richiesto: referente accetta, Admin attiva, referente accede.

Il messaggio generico nascondeva diversi codici del dominio, incluso
`invito_esistente`. Prova con Nhost/PostgreSQL reali in stack indipendente:
secondo invito per la stessa email, operazione diversa -> 409/invito_esistente.
Non è stato letto il body del tentativo dell'utente: quel codice è una causa
compatibile col sintomo, non attribuita con certezza al suo singolo tentativo.
Ora i codici sono espliciti. Nel caso di invito esistente, la UI cerca una sola
azienda pending con lo stesso nome e identificativo `azienda-UUID`, riusa la
sua operazione e richiede il link già in RAM. SQL verifica email, nome, moduli,
azienda e Admin originale: dati diversi vengono rifiutati; nessuna nuova
impronta/token o azienda viene creata. Test browser: refresh, nuova operazione,
409 e recupero dello stesso link. Resta non recuperabile il token se il processo
che lo conserva è già terminato.

Il launcher Nhost non lasciava un worker attivo dopo le prove: ora in modalità
manuale avvia il worker reale con ambiente minimo e cartella temporanea propria,
verifica l'heartbeat prima di dichiararlo pronto e chiude il figlio prima del
centro. La modalità automatica mantiene soltanto lavori simulati.

Review: riprodotto il rischio di eseguire un lavoro dopo SIGTERM/disconnessione
arrivati durante il poll. Corretto con controlli di attività dopo ogni attesa
prima dell'esecuzione; IPC assicura lo stop anche se cade il launcher. Prove
controllate per SIGTERM/disconnect e heartbeat reale senza lavori/portali.

Esito: **84/84**, nessuno skip; log
`/private/tmp/amr-login-invito-worker-finale.log`. Collaudo reale provider/SQL
indipendente riuscito, log `/private/tmp/amr-login-invito-ux-nhost-reale.log`.
Nessuna credenziale reale letta, nessun commit/deploy o intervento M2.

Riavvio autorizzato dal proprietario e completato: collaudo manuale disponibile
su `http://127.0.0.1:61378`, posta locale su `http://127.0.0.1:32813`.
Le prove provider/SQL del launcher sono riuscite e l'heartbeat del worker reale
iMac è stato verificato prima della dichiarazione di disponibilità. Nessuna
ricerca sui portali eseguita durante questa verifica. L'M2 resta escluso.
Il riavvio ha eliminato DB/inviti temporanei e rigenerato MFA, come esplicitato
prima dell'autorizzazione: occorre configurare il nuovo autenticatore e ricreare
l'invito. Il collaudo mantiene questo limite anche al prossimo arresto.
