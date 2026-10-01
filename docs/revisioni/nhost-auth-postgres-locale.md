# Collaudo Nhost Auth e PostgreSQL locale — 1 ottobre 2026

## Perimetro e baseline

Commit di partenza `f2faf73`: collaudo delle autorizzazioni sintetiche e diagnostica localhost, 51 test passati sulla copia esatta preparata per il commit. Il lavoro estraneo della chat APP, gli export e i file di dati non sono entrati nel commit.

Questo incremento verifica il provider reale prima di progettare il collegamento al centro. **Non introduce autenticazione Nhost nel centro**, non migra i dati e non certifica le autorizzazioni commerciali su PostgreSQL. Il launcher ordinario resta invariato. Nessun cloud acquistato/attivato, nessun portale, SMTP reale, OneDrive o M2 coinvolto; nessuna lettura di `.env`.

## Fonti e piano sottoposto a verifica

- [Nhost sviluppo locale](https://docs.nhost.io/platform/cli/local-development): usare componenti reali locali prima del cloud.
- [Esempio Docker ufficiale](https://github.com/nhost/nhost/blob/main/examples/docker-compose/docker-compose.yaml): dipendenze dei servizi; non presumere che il tag Auth dell'esempio sia il rilascio scelto per produzione.
- [Auth 0.49.1](https://github.com/nhost/nhost/releases/tag/auth@0.49.1), commit sorgente `56b6ab7920c9acc5c14e242bb22052c4ad173684`: sorgenti del tag confrontati per hashing, JWT, TOTP, ticket e configurazione. Non attribuire automaticamente al cloud Nhost la versione locale.
- [Contratto registrazione](https://docs.nhost.io/reference/auth/post-signup-email-password): massimo password 50 caratteri nella versione consultata; rifiuto esplicito, mai troncamento.
- [MFA Nhost](https://docs.nhost.io/products/auth/mfa): il login richiede ticket e challenge; attivazione sul profilo distinta dal completamento della challenge nella sessione.
- [Logout Nhost](https://docs.nhost.io/reference/auth/post-signout): invalidazione dei refresh token, non revoca istantanea garantita di ogni access JWT.
- [OWASP autenticazione](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) e [sessioni](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): hashing, MFA, invalidazione server-side, cookie e riautenticazione; il solo JWT valido non basta a implementare la policy commerciale concordata.
- [Lock PostgreSQL](https://www.postgresql.org/docs/16/explicit-locking.html) e [isolamento](https://www.postgresql.org/docs/16/transaction-iso.html): contare e modificare i posti sotto lo stesso lock e transazione; vincolo univoco per persona. La prova non sostituisce il futuro schema commerciale completo.

Piano minimo: runtime Docker separato → PostgreSQL e posta di prova → Auth con migrazioni e GraphQL pronto → verifica email/MFA/logout → concorrenza SQL → review e controprove → pulizia. Nessuna sostituzione del provider sintetico con chiamate asincrone prima di aver riesaminato tutti i punti d'autorizzazione del centro.

## Implementazione ripetibile

- `scripts/collauda-nhost-locale.js`: comando esplicito, nessun effetto all'importazione. Richiede il socket Unix del profilo `amr-auth`; passa il daemon esplicitamente a ogni comando Docker, senza cambiare il contesto globale. Nessun import del monolite o dotenv.
- Compose generato in directory temporanea 0700 e file 0600. Password utente, segreto DB, firma JWT e cifratura MFA distinti. Solo identità `.invalid`, token mai stampati. PostgreSQL in tmpfs; container e file temporanei rimossi a fine prova. Se la pulizia fallisce, conservare la configurazione protetta per poterla ripetere.
- Solo porte loopback per Auth e Mailhog; DB e GraphQL non pubblicati, nessun bind mount di file del computer. Auth condivide la rete di Mailhog perché il client SMTP consente il test senza TLS su `localhost`: non disattivare la protezione contro SMTP remoto non cifrato. Non è una configurazione SMTP di produzione.
- `test/fixtures/nhost-quote.sql`: schema SQL usa-e-getta, non migrazione di produzione. Dimostra l'ultimo posto sotto lock, l'unicità di appartenenza e il rifiuto del ruolo senza permessi. Non contiene ancora inviti commerciali con scadenza, accettazione o ruoli completi.
- `test/nodi-nhost-config.test.js`: protezione dei confini della configurazione e generatore TOTP verificato contro RFC 6238; il generatore è solo una fixture di test, non un'autenticazione custom AMR.

Runtime creato con profilo Colima separato, senza montaggi host, senza attivarlo come contesto Docker e senza modificare il profilo CRM. Il tentativo di usare `COLIMA_HOME` non ha spostato il profilo: la directory effettiva del socket è `~/.colima/amr-auth`. Non documentare il runtime come interamente contenuto in `/tmp`; il profilo e le immagini restano locali, i dati Auth del test no.

```sh
colima start amr-auth --activate=false --ssh-config=false --mount none --template=false --vm-type qemu --cpu 2 --memory 3 --disk 10
AMR_NHOST_DOCKER_HOST=unix:///Users/aincrad/.colima/amr-auth/docker.sock node scripts/collauda-nhost-locale.js
colima stop amr-auth
```

Il percorso socket è specifico di questo iMac. Non puntare al daemon CRM. Le immagini sono fissate anche per digest in `IMMAGINI`, non soltanto per tag:

| Componente | Versione | Digest osservato |
|---|---|---|
| Auth | 0.49.1 | `3365cb4c3f50018f88cb723133bd498a15a7975d8d7644ab199613360bb15976` |
| PostgreSQL | 16 | `1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54` |
| GraphQL | v2.46.0-ce | `bfc3e5fd51e87f99dc0894976f16c14165d9c0fbd1fe503a3ebfbaf02600fed0` |
| Mailhog | v1.0.1 | `f35c05c5e7bd005020a7865838c198c0fcb2ce1a64c5497c4c9c72dec5050cc9` |

## Esiti reali e controprove

1. **Verificato — Email**: registrazione sintetica consentita; login negato prima della verifica. Mail catturata localmente, link con base Auth effettiva verificato, conferma senza seguire il redirect contenente token; login poi consentito e `emailVerified=true`.
2. **Verificato — Password**: DB contiene bcrypt costo 10, diverso dal segreto. L'hash non viene stampato. Coerente con `services/auth/go/controller/secrets.go` del tag; non sono password cifrate reversibilmente. Il limite di 50 caratteri è un vincolo reale del provider e va dichiarato nella futura UI, non nascosto troncando l'input. Questo esperimento non verifica HIBP né tutti i requisiti di password della produzione.
3. **Verificato — Challenge MFA**: attivazione TOTP; login restituisce ticket senza sessione. Codice errato negato; dopo nuova challenge un codice valido produce la sessione. Il ticket del tentativo errato non è riutilizzabile: la prima fixture presumeva il contrario e falliva con `invalid-ticket`; corretta per rispettare il comportamento osservato.
4. **Verificato — MFA e access JWT**: il JWT ottenuto prima di attivare TOTP passa ancora `/token/verify` dopo l'attivazione. I claim Hasura prima e dopo il login MFA sono identici; top-level solo `sub`, `iss`, `iat`, `exp` e namespace Hasura. Non c'è attestazione MFA della sessione in questi token/configurazione. Controprova: il nuovo login richiede realmente la challenge, quindi il problema non è che MFA non funzioni; è inferire la prova della sessione dal profilo o dalla sola firma JWT.
5. **Verificato — Logout**: `/signout` riesce, il refresh token successivo è negato, ma `/token/verify` sul precedente access JWT risponde ancora 200. Non è un difetto rispetto al contratto Nhost; sarebbe un errore della nostra integrazione se lo usassimo per dichiarare revoca immediata della sessione. Non è stato dimostrato accesso ad annunci di AMR: il provider non è ancora collegato.
6. **Verificato — PostgreSQL**: una connessione trattiene il lock aziendale; `pg_stat_activity` conferma che la seconda attende un lock. Dopo il commit della prima, una sola prenotazione ottiene l'ultimo posto. Una seconda appartenenza della stessa persona è rifiutata dal vincolo primario. Un ruolo senza privilegi non può leggere i membri. Non equivale a un test multi-tenant completo di Hasura/RLS o dell'API commerciale.

Log finale depurato: `/private/tmp/amr-nhost-collaudo-20261001.log`. Nessun body delle fonti, token, password o hash integrale nel report.

## Review del lavoro: problemi del test risolti

- Avvio della versione scelta: chiave di cifratura MFA obbligatoria e schema `auth` da predisporre prima delle migrazioni; GraphQL atteso sano. Corrette assunzioni tratte dal vecchio esempio, senza modificare AMR.
- Password sintetica iniziale di 64 caratteri: rifiuto 400 conforme all'API, non un bug di login. Utente di test ora usa un segreto casuale di 40 caratteri, distinto dal DB.
- SMTP locale: il cambio PLAIN→LOGIN da solo non risolveva `unencrypted connection`. La rete condivisa rende il test veramente loopback, senza un bypass del controllo Nhost. SMTP Aruba/TLS resta un gate distinto.
- Email: il primo test ricostruiva il link con una porta host diversa da quella configurata nel provider, quindi non provava il link generato. Configurazione `AUTH_SERVER_URL` aggiornata prima dell'avvio e base del link ricevuto verificata. Redirect locale richiesto dal contratto; non seguito automaticamente.
- Concorrenza: `Promise.allSettled` da solo non prova sovrapposizione delle transazioni. Il test finale osserva prima la connessione A con lock trattenuto e poi B bloccata. Non dichiara prova di concorrenza se l'attesa non viene osservata.
- Pulizia: non cancellare il compose se Docker `down` fallisce; mantenere il file protetto permette il recupero. Nessuna logica nuova entra nel launcher ordinario.
- Controprova MFA rafforzata: un input alfabetico malformato non dimostrava il rifiuto di un TOTP numerico errato. Il collaudo finale invia sei cifre errate, poi il codice valido sullo stesso ticket e verifica `401 invalid-ticket`; con un nuovo ticket il codice valido riesce. Le verifiche dei vecchi JWT ora richiedono esplicitamente HTTP 200, senza limitarsi a stampare il risultato.

Verifica conclusiva: **54/54** test account, HTTP, centro, baseline e configurazione Nhost; log `/private/tmp/amr-nhost-regressioni-20261001.log`. Collaudo reale ripetuto dopo la review, con esito positivo e attesa del lock osservata. Container del daemon isolato rimossi; profilo `amr-auth` arrestato. Le immagini e il profilo riutilizzabile restano sul computer, senza database del collaudo. Il contesto Docker globale non è stato cambiato.

## Limiti e prossimo intervento

Per l'adapter reale servono sessioni applicative server-side e autorizzazioni commerciali aggiornate in PostgreSQL. Un JWT fornito dal browser non deve poter creare autonomamente una sessione Admin con prova MFA né riaprire una sessione revocata. Una bandiera client, `activeMfaType` o un custom claim ricavato solo dallo stato dell'utente non risolvono la prova della challenge.

Prima di implementare il login definitivo, confrontare due percorsi: sessione server-side creata dopo una risposta Auth/MFA ricevuta direttamente dal backend centrale, oppure OIDC con prova di autenticazione effettivamente verificabile. [OIDC Nhost](https://docs.nhost.io/products/auth/oauth2-provider) richiede configurazione e pagina login/consenso: non è una pagina hosted pronta e non è stato collaudato da questo esperimento. Non presumere che OIDC aggiunga automaticamente prova MFA o revoca istantanea.

Il centro oggi invoca `accountProva.contesto()` e i controlli dei destinatari **in modo sincrono**. Sostituirli con Promise senza rivedere ingresso, poll, assegnazione, composizione e consegna farebbe proseguire operazioni prima del controllo: rischio condizionato alla futura modifica, non bug dimostrato del provider sintetico attuale. Il prossimo incremento deve preservare i gate e la condivisione tra destinatari mentre introduce controlli asincroni.

Rimangono aperti: percorso del login/MFA reale e sessioni, schema commerciale completo e concorrenza delle sue operazioni, integrazione del centro, recupero MFA, SMTP Aruba, OneDrive/restore, configurazione effettiva Nhost Pro, TLS e collaudo cloud. Nessun nuovo commit o deploy di questo incremento senza richiesta.
