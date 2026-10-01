# Collaudo locale delle autorizzazioni AMR

1 ottobre 2026. Primo incremento prima di attivare Nhost: autorizzazioni, quote, inviti, revoche e scadenze con identità e fonti sintetiche. Il collaudo non certifica ancora Auth, MFA, SMTP o PostgreSQL Nhost. M2, servizi cloud e portali esclusi. Nessun commit o deploy autorizzato da questo lavoro.

## Fonti primarie e applicazione al progetto

- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): negare per default, privilegi minimi e controlli server-side su ogni richiesta. AMR deve verificare identità, appartenenza corrente, modulo e scadenza; il ruolo dichiarato dal browser non è una prova.
- [OWASP Multi Tenant Security](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html): contesto aziendale verificato, isolamento anche nelle cache e nei lavori asincroni. La condivisione concordata della prima pagina riguarda l'esecuzione identica, non l'autorizzazione dei destinatari.
- [PostgreSQL Explicit Locking](https://www.postgresql.org/docs/current/explicit-locking.html): blocchi di riga in transazione. Per quota e inviti occorre serializzare le operazioni dell'azienda e vincolare l'appartenenza unica; contare posti e poi inserire senza protezione è insufficiente. Un test in memoria o SQLite non prova la concorrenza PostgreSQL.
- [Nhost JWT](https://docs.nhost.io/products/auth/jwt) e [Sign out](https://docs.nhost.io/reference/auth/post-signout): verificare firma/scadenza dell'identità non equivale a rileggere la licenza AMR; signout documenta invalidazione dei refresh token. Non dedurre da questo una revoca immediata di tutti i JWT già emessi.
- [Nhost MFA](https://docs.nhost.io/products/auth/mfa): attivazione per progetto e persona, challenge prima di ottenere la sessione. Il requisito del nostro Admin non è soddisfatto dal semplice flag di disponibilità MFA. Una identità simulata prova il comportamento del gate, non il protocollo MFA reale.
- [OWASP Forgot Password](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html): token casuali, protetti, monouso e con scadenza. Questi principi sono applicabili agli inviti; il documento riguarda recupero password e non costituisce una specifica dell'onboarding AMR. L'accettazione deve verificare anche l'identità email verificata del destinatario.
- [Nhost Local Development](https://docs.nhost.io/platform/cli/local-development): stack locale basato su Docker con Auth/PostgreSQL. Sull'iMac il comando Docker esiste, ma il daemon configurato non è raggiungibile (socket Colima mancante). Non avviare o riconfigurare lo stack CRM esistente per aggirarlo. Prima prova con identità simulate; verifica reale dello stack locale distinta e da completare prima di dichiarare integrato Nhost.

## Percorso letto e rischi verificati

Riferimento: worktree attuale, comprensivo delle modifiche locali preesistenti a `backend/nodi/centro.js`. Non attribuire queste modifiche a questo incremento.

1. `centro.js:449–461`: sessione di prova con azienda, moduli hardcoded e controllo soltanto prima della ricerca. Non esistono persona, appartenenza revocabile o scadenza commerciale. È un limite verificato del prototipo, non un nuovo exploit remoto: loopback e controllo Host restano attivi.
2. `centro.js:344–356`: il poll controlla disponibilità e sospensioni delle fonti, non l'autorizzazione commerciale dei destinatari. Una verifica solo nella rotta HTTP non coprirebbe un lavoro rimasto in coda durante revoca/scadenza.
3. `centro.js:465–472`: dopo l'attesa vengono registrati gli URL consultabili e consegnati gli annunci senza un nuovo controllo commerciale. Va negata anche la registrazione dei dettagli quando il destinatario ha perso l'accesso.
4. `centro.js:299–315`: prima pagina condivisa tramite una promise, mentre il lavoro fisico è intestato all'azienda che parte per prima. Un controllo di coda basato solo su quell'azienda interromperebbe anche il destinatario ancora autorizzato. Correzione progettuale: partecipanti distinti dall'esecuzione condivisa e verifica di ciascun partecipante prima dell'avvio e della consegna. Nessun annuncio al revocato; non interrompere l'esecuzione ancora necessaria a un partecipante autorizzato.
5. Inviti e quote commerciali assenti: non esiste un percorso da dichiarare già sicuro. Le fixture di login azienda A/B non dimostrano isolamento fra persone, MFA o appartenenza unica.

## Piano circoscritto, verificato prima dell'implementazione

### 1. Autorizzazione corrente

Separare autenticazione da policy AMR. Nel collaudo usare identità sintetiche assegnate dal processo di prova, mai un header di ruolo/azienda considerato attendibile. Il codice commerciale non deve accettare il login di prova come alternativa alla verifica dell'identità.

La decisione usa persona attiva, email verificata, appartenenza attiva, azienda attiva, scadenza strettamente futura e modulo acquistato. Errori o assenza di dati non autorizzano. Per Admin proprietario aggiungere requisito MFA provato dalla sessione verificata e privilegio assegnato server-side, non dal metadata modificabile dal cliente.

Ricontrollare all'ingresso, prima di consegnare ciascun lavoro fisico (compresi failover), prima della risposta HTTP e dei dettagli. Il controllo finale vale anche per risposte di errore che eventualmente contengano annunci. Alla scadenza/revoca consegnare solo esito dell'interruzione. Nessun fallback a un permesso precedente se il controllo fallisce.

### 2. Inviti e quota

Tre persone per azienda incluso referente; invito pending prenota un posto e scade dopo sette giorni. Il referente può invitare e revocare i colleghi; il collega gestisce solo le proprie sessioni. Accettazione converte una prenotazione, non consuma un quarto posto. Rinnovo annuale manuale e moduli per azienda; nessuna modifica di prezzi o acquisto cloud.

Tutte le operazioni concorrenti sulla quota devono passare dalla stessa transazione, comprese cancellazione, scadenza, accettazione e reinvito. Un vincolo univoco deve impedire due appartenenze attive per la stessa persona. Token d'invito non nei log; riuso e destinatario differente rifiutati. Invito valido non sostituisce email verificata né autorizzazione attuale dell'azienda.

Decisione ricevuta il 1 ottobre: cambio del referente soltanto con autorizzazione dell'Admin proprietario. La persona scelta deve essere già membro della stessa azienda; il precedente referente rimane collega, senza cambiare il numero di posti. Il referente non può revocare se stesso. Le best practices sostengono i controlli di privilegio, non decidono il diritto commerciale di trasferimento.

### 3. Prove sul percorso reale

Usare il centro HTTP e worker sintetici, dati e log temporanei, orologio controllato. Nessuna modifica ai cataloghi o all'autenticazione dell'AMR normale. Per ciascun caso contare i lavori realmente consegnati e verificare tutto il body, non soltanto lo status.

| Caso | Esito richiesto |
|---|---|
| Azienda solo Moto chiede Auto | Negato; nessun lavoro consegnato |
| Identità invia azienda/ruolo altrui | Nessun aumento di permessi o cambio azienda |
| Email non verificata, persona revocata o appartenenza assente | Negato |
| Scadenza esattamente uguale al tempo corrente | Negato |
| Revoca/scadenza con lavoro ancora in coda | Nessuna nuova chiamata per quel destinatario |
| Revoca/scadenza dopo l'avvio | Nessun annuncio o autorizzazione dettaglio nella risposta |
| Due destinatari condividono prima pagina, uno revocato | Un'esecuzione; annunci soltanto all'autorizzato |
| Revoca prima di un failover | Nessuna chiamata aggiuntiva per destinatari non autorizzati |
| Cataloghi e dettaglio dopo perdita dell'accesso | Negati, anche se l'URL era stato consegnato prima |
| Due inviti concorrenti sull'ultimo posto | Una sola prenotazione riuscita |
| Accettazione concorrente dello stesso invito | Una sola appartenenza |
| Invito scaduto, revocato, riusato o per email diversa | Accettazione negata |
| Accettazione per persona già in altra azienda | Nessuna seconda appartenenza |
| Collega invita/revoca o tenta di diventare referente/Admin | Negato |
| Admin senza prova MFA | Operazioni amministrative negate |
| Identità simulata con MFA | Prova della policy soltanto; MFA Nhost non certificata |

### 4. Review e uscita

Dopo ogni correzione: riproduzione e controprova; verificare tutti i chiamanti, cache, condivisione, fallimenti del controllo e assenza di risultati nei log. Eseguire test pertinenti e solo poi ampliare alle regressioni giustificate. Non considerare una fixture che imita la policy come prova di un gate applicato nel centro.

L'incremento termina quando la matrice è verificata sul percorso HTTP implementato e i limiti sono registrati. PostgreSQL concorrente, JWT/MFA/SMTP Nhost e restore reale restano gate separati da eseguire: nessuna dichiarazione di prontezza alla produzione basata sulle sole identità simulate. Acquisto, commit, deploy e coinvolgimento M2 richiedono richiesta esplicita.

## Stato

Baseline eseguita il 1 ottobre: `node --test test/nodi-centro.test.js test/nodi-baseline.test.js`, **23/23 superati**, fonti simulate e dati temporanei. Il primo tentativo nel sandbox non otteneva un indirizzo di ascolto nei 13 test HTTP (10 altri casi passati); ripetuto con accesso loopback consentito, tutti passati. Non classificare il primo fallimento come bug del centro. Log di prova in `/private/tmp/amr-account-baseline-20261001-loopback.log`; non persistono annunci reali né credenziali. Questi test sono la baseline esistente, non prove dei requisiti commerciali ancora assenti.

Ricerca ufficiale e lettura dei percorsi completate; decisione sul referente ricevuta. Implementato il collaudo locale descritto sotto. Questo aggiornamento supera lo stato precedente di sospensione; non autorizza servizi, commit o deploy.

## Implementazione dell'incremento locale

- `backend/nodi/account-prova.js`: identità esclusivamente sintetiche `.invalid`, aziende, appartenenze, moduli/scadenza, inviti monouso con solo hash persistito, prenotazione dei tre posti, revoca e cambio referente solo Admin con prova MFA sintetica nella sessione. `BEGIN IMMEDIATE` e nessun await nella transazione. Appartenenza univoca per persona. Il limite di dieci aziende e tre posti implica al massimo trenta clienti; le identità Admin non possono diventare membri.
- `backend/nodi/account-prova-route.js`: API di collaudo, separata dalla rotta di ricerca; sessione aziendale derivata dal server, gestione delle sole sessioni proprie. L'accettazione aggiorna il contesto della sessione corrente. Nessun invio email, nessuna password, nessun OAuth o MFA reale simulato come integrazione compiuta.
- `backend/nodi/centro.js`: parametro opzionale `accountProva` soltanto per il collaudo; il launcher normale non lo attiva e mantiene le identità A/B preesistenti. In modalità account prova, login sceglie una identità predisposta dal test e non accetta azienda o ruolo dal body come autorità. `/api/admin` e `/api/stato` richiedono l'Admin di prova; nella modalità precedente la diagnostica locale resta invariata.
- Controlli prima di accodare, al poll prima della consegna al worker, prima di ulteriori assegnazioni/failover e prima della risposta HTTP. Revoca/scadenza/sessione invalidata: risposta d'interruzione senza annunci, anche per cataloghi e dettagli. La perdita del provider autorizzazioni è un 503 generico, non una revoca 403; entrambi negano la consegna e non interpretano il risultato come vuoto.
- L'esecuzione condivisa conserva l'insieme dei controlli dei destinatari; se almeno uno resta autorizzato può terminare. Ogni risposta ha il proprio controllo finale. Nessuna interruzione automatica della chiamata già partita per un altro destinatario valido. Le aziende aderenti registrano separatamente l'affinità delle fonti; il limite della mappa resta cento anche con inserimenti multipli.
- Revoca del collega incrementa l'epoca della sua identità sintetica. Reinvito o successivo cambio azienda non riattiva le vecchie sessioni. Revoca della sola sessione marca anche l'oggetto trattenuto da richieste in volo. PC/telefono non creano nuovi membri.

## Review dei cambiamenti e controprove

1. **MFA globale non prova la MFA della sessione**: rilevato nel primo codice dell'incremento. Corretto richiedendo sia il requisito corrente della persona sia la prova sintetica acquisita dalla sessione; un test attiva MFA dopo il login e verifica che il vecchio login resti negato. Disattivarla nega anche la sessione nuova. Non certifica come Nhost presenterà tale prova: adapter reale ancora assente.
2. **Cookie senza azienda dopo accettazione**: review indipendente e regressione HTTP, prima `403 !== 200` sul successivo `/api/test/me`. Corretto aggiornando soltanto la sessione corrente con l'azienda restituita dall'accettazione transazionale, non dal body del browser.
3. **Affinità assente per secondo destinatario condiviso**: review indipendente e regressione HTTP, prima il carico su n1 portava la pagina successiva a n2 (`1 !== 0` sulla sua coda). Corretto propagando le assegnazioni ai destinatari ancora validi con chiavi per azienda. Fixture con soli metadati di carico; nessun portale interrogato.
4. **Revoca della sessione durante richiesta**: la cancellazione della sola voce dalla mappa non invaliderebbe un riferimento già trattenuto dalla rotta. L'oggetto è marcato revocato e ricontrollato prima della consegna. Test di dettaglio/ricerca e controprova con un'altra sessione ancora attiva.
5. **Indisponibilità scambiata per revoca in coda**: risolto preservando la classificazione del controllo. Una eccezione del provider restituisce 503 generico e zero lavori consegnati, senza esporre l'errore interno. Un destinatario diverso ancora verificabile può mantenere viva l'esecuzione condivisa.
6. **Adesione durante composizione**: dopo il primo fix dell'affinità, il ciclo registrava i destinatari prima dell'attesa di `componi`. La review indipendente e un nuovo test HTTP hanno confermato che chi aderiva durante tale attesa perdeva ancora l'affinità. Il ciclo e la pulizia della mappa ora sono eseguiti da `termina(body)` dopo l'ultima attesa in tutti i percorsi di ritorno. Test con composizione 200 e 503 superati; controprova prima del fix in `/private/tmp/amr-account-composizione-prima-20261001.log`. Verifica indipendente finale: nessun finding riproducibile nella soluzione mirata.

I log delle prove prima dei fix sono in `/private/tmp/amr-account-review-prima-20261001.log`; confronto finale in `/private/tmp/amr-account-collaudo-20261001.log`. Non contengono annunci o credenziali reali. Test di integrità eseguiti con preload che neutralizza dotenv e imposta dati/log temporanei; nessuna lettura delle password del progetto.

### Esito finale dell'incremento

**Collaudo locale completato, 1 ottobre 2026.**

- `node --test test/nodi-account.test.js test/nodi-account-http.test.js test/nodi-centro.test.js test/nodi-baseline.test.js`: **51/51 superati**, inclusi 12 casi di logica account, 16 casi HTTP account e i 23 casi preesistenti centro/baseline. Porte esclusivamente loopback, fonti sintetiche e database temporanei. Nessun portale o M2 coinvolto.
- `node --require /private/tmp/amr-account-isolamento-20261001.cjs --test test/suite-integrita.test.js`: **9/9 superati**, dotenv neutralizzato e dati/log isolati; log `/private/tmp/amr-account-integrita-20261001.log`.
- Sintassi dei moduli nuovi e centro verificata; `git diff --check` pulito. Nessun commit, deploy o servizio attivato.
- Test di inviti concorrenti dimostrano il comportamento del centro locale con transazioni SQLite; non sono una prova di concorrenza fra più connessioni PostgreSQL. MFA è una prova sintetica della policy, non un challenge TOTP Nhost. Nessun benchmark di trenta utenti.
- Il collaudo è via API e test; non è stato avviato un nuovo frontend account e il normale launcher del prototipo conserva il proprio flusso di login preesistente. Non presentare questo esito come account già disponibili ai clienti.

## Limiti e prossimo gate

Il collaudo prova API e logica locale con SQLite e identità sintetiche. Non è un sistema account pubblicabile, non configura il normale dev server con nuove password e non ha collegato il frontend commerciale a Nhost. Non verifica la concorrenza multiprocesso PostgreSQL, firma/revoca JWT, challenge/recupero MFA, SMTP, backup OneDrive o restore. Le copie dopo operazioni amministrative restano un requisito futuro, non una funzionalità realizzata in questo incremento.

Prima di Nhost in produzione: scegliere e avviare uno stack locale isolato senza modificare il CRM, implementare lo schema PostgreSQL e l'adapter di identità, ripetere i casi concorrenti e i controlli di revoca con il provider effettivo. SMTP/MFA/restore e pubblicazione del centro richiedono i rispettivi gate. Lo scheduler remoto, l'M2 e gli accessori completi Auto/Moto non sono resi production-ready da questo collaudo.
