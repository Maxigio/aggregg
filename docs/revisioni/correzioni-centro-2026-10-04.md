# Correzioni della review centro–nodi — 4 ottobre 2026

Origine: [review del candidato c6b61a8](branch-nodi-2026-10-04-c6b61a8.md),
committata in `3b728e5`. L'utente autorizza le sei correzioni, con verifiche e
controprove e commit separati. Solo sviluppo locale, nessun cloud/M2/portale.

## L01 — chiuso

Gestore finale per gli errori dei parser HTTP: codici 400/413/415 generici,
senza body, messaggio del parser o stack. Registro con solo codice/status.
Gli errori non appartenenti ai parser continuano al percorso Express corrente.
Guard Host/Origin, Admin e token nodo restano precedenti ai parser.

Test HTTP reale su localhost: JSON malformato su nodo/login/Admin, body oltre
8 MiB, heartbeat valido e nodo anonimo. Nessun marker sintetico su stderr,
risposta o registro. 7/7 test HTTP/trasporto, Node 24.21.0, dotenv disabilitato.
Review indipendente: nessun finding residuo; altre 25 prove centro/Admin/
trasporto passate su Node 24.19.0. Nessun contenuto reale usato nei test.

Fonti: [Express error handling](https://expressjs.com/en/guide/error-handling/)
e [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html).
Le indicazioni sostengono la minimizzazione, non dimostrano da sole il PASS.

## R03 — chiuso

Poll disconnesso prima/dopo il controllo dei destinatari: nessun dequeue,
nessuno stato iniziato. Il lavoro rimane in coda. I destinatari già negati
con 401/403 vengono rimossi dal Set di verifiche; i 503 non li eliminano.
La verifica corrente del chiamante prima della risposta resta obbligatoria.

Controprova HTTP: A revocato/B valido, poll interrotto durante i permessi,
retry dello stesso job senza chiamate alle fonti. A riceve 403, B 200;
nessun avvio fantasma. Suite HTTP/accessi/scheduler: 32/32, zero skip.
La prima fixture aveva un involucro sources vuoto, correttamente respinto
con 502: corretta la fixture, non indebolito il validatore dei risultati.
Review indipendente: nessun finding residuo, permessi e isolamento preservati.

Il timeout del worker resta quattro secondi. Permessi validi più lenti
possono ancora impedire la consegna fino alla deadline, ma non producono
un falso lavoro iniziato/incerto. Prestazioni del provider remoto da collaudare.
Fonte: [Node HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html), ciclo
di vita della risposta distinto da quello della richiesta.

## B05 — chiuso

Audit del restore identificato da `(dominio, id)`, come i writer aziende e
colleghi. `dominio` deriva dal journal, con vincolo NOT NULL e allowlist.
La sequenza aziendale resta unica: due UUID uguali in domini diversi sono
ammessi solo con sequenze diverse. Fingerprint e watermark non cambiano.

Migrazione dell'audit legacy nella stessa transazione/advisory lock del
replay, senza cancellare righe. Audit malformato: rollback e riconciliazione
manuale, senza ricreare identità Auth. Nessun database reale modificato.

27/27 test unitari; PostgreSQL 18.6 isolato: migrazione popolata e riapplicata,
UUID tra domini, conflitto fingerprint, dump/restore post-migrazione e
rollback del legacy senza dominio. Review indipendente: nessun difetto
applicativo residuo. Un errore nella fixture cross-domain usava un ID invito
come persona Auth: corretta la fixture, preservata la guardia sull'identità.
Fonte: [PostgreSQL generated columns](https://www.postgresql.org/docs/18/ddl-generated-columns.html).

## B06 — chiuso

La copia indicata dalla manutenzione può trovarsi fra gli snapshot scaduti:
viene conservata spostandola da remove a keep, dopo aver validato l'intero
piano originale. Non si aggirano categoria, timestamp, unicità e copertura
90 giorni / 14 giorni DB. Al massimo una copia aggiuntiva per manutenzione.
Assenza del marker o check fallito: nessun forget. Check/prune restano
necessari anche quando un retry non ha più snapshot da eliminare.

42/42 prove, compresi repository restic 0.19.1 reali cifrati separati:
restore della copia protetta, eliminazione successiva quando il marker
cambia, preservazione della categoria estranea. Review indipendente:
49 PASS simulati e 14 controprove supplementari, nessun finding residuo.
La manutenzione resta seriale nella singola istanza concordata; non è un
protocollo HA per processi multipli sul medesimo repository.
Fonte: [restic retention](https://restic.readthedocs.io/en/stable/060_forget.html).

## U05 — chiuso

Il frontend del prototipo espone ampliamenti della query, cataloghi parziali,
versioni ignorate/non verificate e dichiarazioni dell'annuncio. Gli avvisi
di copertura restano associati ai risultati già pubblicati, anche quando
una pagina successiva della stessa fonte non ripete il metadato o fallisce.
Gli errori del tentativo corrente vengono sostituiti al retry; nuova ricerca,
cambio identità e logout azzerano il contesto. Nessuna nuova chiamata fonte.

Avvisi testuali, senza HTML attivo; dettagli dell'annuncio separati dai
controlli di lettura. Review indipendente: risolti due finding iniziali
(perdita su stessa fonte e su errore), nessun finding residuo. Prove headless
con API simulate: ampliamento, elenco versioni monco con payload HTML,
append stessa/altra fonte, errore/retry e reset della ricerca. Il primo giro
UI dedicato è 10/10; fixture aggiornate per lo script bootstrap C03.
Collaudo manuale dell'utente e staging remoto non ancora eseguiti.

## C03 — in lavorazione, decisione finale pendente

Confermato dall'utente: logout comune alle schede dello stesso browser;
un nuovo login dopo il logout deve poter riuscire, altri browser indipendenti.

Nel worktree: POST bootstrap esplicito coordinato tramite Web Locks, nessuna
creazione di cookie su pagina/me/logout, handle monouso del tentativo legato
al contesto (tre minuti, massimo 50), logout che ritira anche le sessioni
del contesto già emesse. Tentativi preparati prima ma recapitati dopo il
logout: 401, zero chiamate al provider. Bootstrap ordinario non sostituisce
un login o MFA pendente. Chiamanti API devono seguire il protocollo.

Controprova ulteriore: accumulare handle su finestre diverse aggirava il
limite al provider nella prima implementazione. Corretto: due contatori
separati, 20 preparazioni/min e limite originale 20 login/MFA/min; massimo
quattro operazioni contemporanee. Test dedicato: 40 handle preparati,
20 login effettivi, 21esimo negato 429 senza chiamare Nhost.

40/40 prove mirate finali (HTTP, headless due schede + browser indipendente,
login successivo, scadenza/replay/contesto estraneo, browser senza Web Locks).
Review indipendente backend 34/34, ma finding residuo confermato: una risposta
login già emessa prima del logout e consegnata dopo un nuovo login può
sovrascrivere il cookie nuovo. Il vecchio cookie è revocato: nessun accesso
riaperto, ma /me torna 401. C03 NON chiuso e non committato.

Proposta in interview: separare verifica provider e finalizzazione breve dei
cookie, serializzando quest'ultima con logout fra schede. Attendere la scelta
prima di implementare; tenere la verifica password/MFA fuori dal lock.
Fonti: [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API),
[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Verifica trasversale provvisoria

Suite completa locale: 1309 PASS, 0 failure, 5 gate opzionali esclusi (1314
casi), Node 24.21.0, dotenv disabilitato, dati/log temporanei. Successivamente
aggiunta e superata la controprova del limite provider; il conteggio completo
precedente non viene attribuito a un futuro commit ancora da completare.

Primo gate integrato PG18/Auth/restic fermato alla fixture che leggeva il
contesto da GET me. Aggiornato il chiamante al POST bootstrap con handle e
rilanciato il gate: completato con cleanup verificato. Include Auth reale,
PostgreSQL locale, restic e restore; non include il gate dell'immagine del
centro. Gli errori iniziali delle fixture non sono PASS.
Nessuna prova su cloud, portali o M2, nessun deploy/upload. Collaudo manuale
utente e immagine finale da verificare dopo chiusura del protocollo C03.

## C03 — ricerca autorevole prima della decisione

Richiesta dell'utente: verificare prove e controprove della finalizzazione
separata, senza implementarla prima della discussione. Ricerca del 4 ottobre.

- Verificato nello standard: RFC 6265, §4.1.1, descrive la race fra risposte
  concorrenti con Set-Cookie; §4.1.2 descrive la sostituzione del cookie con
  stesso nome, dominio e path. La revoca server nega il vecchio accesso ma
  non impedisce al browser di sostituire il cookie nuovo con quello revocato.
  Questo corrisponde alla riproduzione locale residua, non a un bypass auth.
- Verificato nella specifica W3C: Web Locks coordina gli agenti che condividono
  lo storage bucket; il lock dura fino al settlement della callback. Il signal
  della richiesta di lock vale prima dell'acquisizione, non cancella il lavoro
  già dentro la callback. Un lock mantenuto solo per bootstrap non ordina le
  risposte di login/MFA/logout inviate dopo il suo rilascio.
- Controprova alla garanzia universale: si tratta di coordinamento cooperativo.
  Non autentica il chiamante e non vincola chiamanti API che saltano il frontend.
  Sicurezza e revoca devono restare sul server. Inoltre le porte separano le
  origin ma non i cookie: il collaudo su più porte dello stesso host richiede
  namespace distinti o host distinti. Rischio condizionato, non nuova collisione
  osservata su una configurazione attiva.
- OWASP richiede invalidazione server al logout e un nuovo identificatore di
  sessione all'autenticazione. Non promuovere il cookie anonimo a credenziale,
  né aggirare la rotazione con una sessione autenticata fissa. Le difese CSRF
  devono coprire anche il login; restano necessari i controlli Origin/Host e
  i controlli del tentativo sul server.
- Nhost documenta password → ticket MFA → sessione. La finalizzazione AMR è
  distinta: non sostituisce MFA e non deve esporre i token Nhost al browser.

Raccomandazione (inferenza progettuale, non ricetta prescritta dagli standard):
verificare password/MFA fuori dal lock, conservare solo temporaneamente sul
server l'esito collegato al tentativo, poi finalizzare tramite un identificatore
opaco monouso. Il server ricontrolla scadenza, contesto, revoca, identità e
permessi prima di creare una sessione nuova. Logout invalida anche gli esiti
non ancora finalizzati. Limiti, scadenza e cleanup coprono gli esiti abbandonati.
Coordinare nello stesso frontend tutte le operazioni che scrivono o cancellano
cookie, comprese MFA, bootstrap, rotazione e revoca della sessione corrente.

Non dimostrato: comportamento completo della proposta con timeout, chiusura
della scheda e perdita della risposta. Un errore del fetch non prova un rollback
sul server e non annulla un cookie già ricevuto. Prima della chiusura servono
prove con header ritardati, risposta persa dopo creazione della sessione,
logout durante provider/finalizzazione, replay, due schede e browser indipendenti.
Non introdurre un reset automatico o un lock `steal` come presunta soluzione.
La finalizzazione resta sospesa; nessuna modifica applicativa in questa ricerca.

## C03 — chiuso nel protocollo locale dopo l’autorizzazione successiva

Il commit `35c83bc` fissa la preparazione già verificata. Il successivo
intervento separa login/MFA da `/api/auth/finalizza`: le risposte lente del
provider non scrivono cookie; restituiscono solo una conferma casuale monouso.
Il backend conserva l’esito per il tentativo corrente, vincolato al contesto
HttpOnly, all’origine e alla scadenza di tre minuti. La finalizzazione rilegge
identità, epoca e revoche dopo l’attesa; nessun token Nhost arriva al browser.

Bootstrap, finalizzazione, logout e revoca della sessione corrente usano lo
stesso Web Lock nel frontend. La verifica provider resta fuori dal lock.
Timeout della fetch reale, senza `Promise.race` o `steal`: non si finge che
una risposta non ricevuta equivalga a rollback. Il successivo login ritira
anche sessioni del contesto il cui cookie non è stato consegnato.

La review indipendente ha riprodotto e fatto correggere due problemi:

- cleanup Nhost sul diniego tratteneva il lock: ora prosegue separatamente,
  conservando l’esito di revoca pendente senza ritardare la risposta locale;
- a quota 100 il recupero del cookie perso era negato: la quota considera
  prima le sessioni dello stesso contesto da sostituire, senza ammettere
  nuovi browser oltre il limite.

Controprove: conferma estranea/riusata/scaduta, logout durante provider e
identità asincrona, MFA, socket chiuso, due schede e risposta finalizzata
ritardata/annullata. Chromium headless sintetico verifica l’ordine dei cookie
e il timeout effettivo. Il reviewer ripristina i due bug solo in memoria:
ricompaiono, poi le correzioni superano 57 test mirati. Nessun finding
residuo confermato nel diff Auth. Il gruppo Auth/HTTP/nodi è 101/101;
suite generale e gate dell’immagine aggiornati nella review finale.

Limiti: Web Locks coordina il nostro frontend, non è una difesa server contro
client arbitrari; origine, handle e revoche sono verificati separatamente.
Il controllo PostgreSQL della finalizzazione può ancora ritardare il lock;
l’attesa per acquisirlo è limitata a cinque secondi. Cleanup provider bounded
e best effort, non garanzia di revoca remota. Quattro chiamate provider già
pendenti possono ancora negare temporaneamente un nuovo bootstrap con 429:
è il limite preesistente, non un cookie tardivo. Sessioni in RAM, una replica;
nessun collaudo manuale o staging remoto eseguito per deduzione.

Fonti primarie:
- [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html), §1, §4.1.1, §4.1.2.
- [W3C Web Locks](https://www.w3.org/TR/web-locks/), §2.4, §2.6, §3.2.
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), rotazione e invalidazione.
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), login CSRF e controlli di origine.
- [Nhost MFA](https://docs.nhost.io/products/auth/mfa), ticket e verifica TOTP.
- [WHATWG Fetch](https://fetch.spec.whatwg.org/), §3.1.2, elaborazione Set-Cookie; ulteriori aperture della pagina sono fallite per timeout dello strumento, non del servizio AMR.
