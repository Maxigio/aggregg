# Centro con login Nhost e permessi PostgreSQL — 1 ottobre 2026

## Perimetro e stato

Il lavoro precedente è committato in `ae33f5f` (`feat(auth): collauda login Nhost server-side`). Questo incremento collega il centro al login e alla lettura dei permessi in PostgreSQL reale, **soltanto nel collaudo locale**. Resta non committato in attesa della richiesta del proprietario.

Aggiornamento finale: il proprietario ha confermato il successo del login manuale con autenticatore. Su richiesta di commit, ripetuti i test `test/nodi-*.test.js`: **75/75 superati**, zero fallimenti e nessun test saltato (log `/private/tmp/amr-nodi-precommit-20261001.log`). La prima esecuzione nel sandbox non poteva aprire le porte HTTP locali; la ripetizione autorizzata con ascolto loopback è riuscita. Questa prova non estende il collaudo a produzione, cloud o recupero MFA.

Non modifica il launcher normale né l'AMR in produzione. Nessun provider cloud attivato, nessun M2, `.env`, utente reale o richiesta ai portali. Le ricerche nei test ricevono risposte sintetiche attraverso il protocollo HTTP dei nodi. Il file `docs/revisioni/backend-centrale-amr.md` aveva modifiche parallele già presenti: lasciate intatte.

Non è ancora il sistema commerciale completo: gestione aziende/inviti/quote/rinnovi/revoche in PostgreSQL, registrazione dei pagamenti e backup OneDrive richiedono un incremento distinto. La vecchia prova delle quote SQL resta eseguita in uno schema separato; **non dimostra che le quote siano applicate nel nuovo schema di lettura**.

## Piano verificato e fonti

1. Riutilizzare il login server-side già collaudato; niente password verificate dal centro o JWT forniti dal browser come autorità.
2. Risolvere UUID, stato della persona, verifica email, disabilitazione Nhost, azienda, moduli e scadenza nel database. Non fidarsi di metadata o azienda inviata dal browser.
3. Attendere i controlli all'ingresso, prima di accodare, al poll, nei percorsi alternativi e prima della consegna; ricontrollare stato del centro/nodo/lavoro dopo ogni attesa che li può cambiare.
4. Disabilitare `/api/test/login` nel collaudo Nhost; proteggere stato e Admin, senza attribuire al proprietario una licenza cliente automatica.
5. Provare SQL/Nhost reali, sovrapposizioni controllate e UI; predisporre accesso manuale con password scelta localmente dal proprietario.

Fonti ufficiali:

- [OWASP autorizzazione](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): negazione predefinita, minimo privilegio, verifica per ogni richiesta e prove negative.
- [PostgreSQL SECURITY DEFINER](https://www.postgresql.org/docs/current/sql-createfunction.html): `search_path` controllato e revoca del privilegio PUBLIC nella creazione della funzione.
- [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html): un superuser/proprietario può eludere RLS. Una connessione amministrativa che passa i test non prova isolamento dei client.
- [node-postgres transazioni](https://node-postgres.com/features/transactions): le future scritture transazionali devono usare lo stesso client. L'incremento attuale esegue una lettura parametrizzata, senza simulare transazioni dal pool.

Debunking: rendere asincrona una funzione non basta. Il nodo può essere sospeso durante la query; due poll possono prendere lo stesso record; il timeout o l'arresto possono eliminare il lavoro mentre il permesso è in lettura. Controprove dedicate sono state aggiunte e passano. La risposta positiva del DB è una lettura nel tempo, non un blocco distribuito: non promettiamo atomicità fra una revoca appena committata e una risposta già consegnata in rete.

## Implementazione

- `backend/nodi/schema-accessi-prova.sql`: schema minimale collegato a `auth.users`; appartenenza univoca, moduli Auto/Moto, scadenza secondo `statement_timestamp()` PostgreSQL. Funzione `amr_accessi.identita(uuid)` con `SECURITY DEFINER`, nomi qualificati e `search_path=pg_catalog`. Il ruolo lettore non può leggere le tabelle Auth o AMR.
- `backend/nodi/accessi-postgres-prova.js`: UUID validato, parametro SQL separato, ritorno limitato ai permessi. Errori depurati e 503, mai autorizzazione implicita. Massimo 32 letture in corso/attesa nel collaudo, senza una coda custom.
- `backend/nodi/login-nhost-prova.js`: sessione opaca, epoca di revoca, azienda legata alla sessione; ruolo corrente letto a ogni controllo. Cookie sul percorso `/` soltanto nel collegamento al centro. Identità, appartenenza e moduli non arrivano dai parametri client.
- `backend/nodi/centro.js`: provider opzionale di accesso, controlli asincroni, un poll in corso per nodo, ricontrolli dopo l'attesa e arresto idempotente. Compatibilità del modo precedente mantenuta.
- `frontend/nodi-prototipo.js`: in modo Nhost sparisce la selezione di aziende fittizie; link al login, moduli dalla sessione. Admin senza azienda può osservare la diagnostica ma non cercare.
- `scripts/collauda-nhost-locale.js`: PostgreSQL/Nhost/Mailhog isolati, DB temporaneo, driver `pg` 8.23.1, connessione lettore, max 4 connessioni, attesa connessione 2 s e query 3 s. Porta DB pubblicata soltanto su loopback casuale per il driver, GraphQL non pubblicato. Nessuna password interpolata nella verifica SQL dell'hash.

## Problemi verificati durante l'implementazione e review

1. **Promise attese come controlli sincroni**: il centro avrebbe proseguito prima dell'esito o ignorato il rigetto. Gate convertiti e attesi nei chiamanti.
2. **Doppio poll durante attesa**: protezione per nodo e verifica del record/coda dopo l'await.
3. **Lavoro scaduto/sospeso durante attesa**: record e disponibilità riletti prima della consegna; nessun record scaduto inviato.
4. **Coda piena non scaricabile**: il cap di ammissione non deve essere usato per consegnare lavori già ammessi. Prova con dieci lavori.
5. **Arresto durante attesa**: flag di chiusura, svuotamento coda e nessuna nuova assegnazione dopo chiusura; prova sovrapposta.
6. **Regressione del percorso sincrono precedente**: un wrapper `async` rendeva differita l'ammissione delle chiamate dirette e introduceva una Promise non osservata nella prova di riavvio. Corretto mantenendo il ritorno della Promise originale quando non c'è controllo asincrono.
7. **Pool limitato, attese illimitate**: cap di 32 controlli; il trentatreesimo è rifiutato e il budget si libera dopo il completamento.
8. **UI login aggiornata da risposta iniziale tardiva dopo logout**: versione del contesto verificata; controprova DOM esegue il JavaScript reale.
9. **Password manuale in SQL del test hash**: eliminata l'interpolazione. La prova legge solo formato/lunghezza hash per UUID, senza inserire la password nella query.

La verifica email della nuova fixture cliente falliva senza il redirect richiesto da Auth; corretta la richiesta del test, non alterato il comportamento del provider.

## Prove e limiti

- **72/72** test di nodi/login/account/centro/configurazione, compresi i nuovi gate asincroni e UI: risultato finale nel log `/private/tmp/amr-nhost-integrato-tests-20261001.log`.
- Nhost 0.49.1, PostgreSQL 16 e driver reali: `/private/tmp/amr-nhost-centro-finale-20261001.log`. Verifica email e MFA, logout/cookie invalidato, Admin autenticato, modulo negato senza lavori, scadenza in coda senza consegna, revoca dell'epoca in volo senza annunci, destinatario condiviso ancora autorizzato servito, appartenenza univoca, lettore impossibilitato ad accedere a hash/tabelle. Quota SQL precedente provata separatamente con contesa osservata.
- Chrome headless, provider sintetico: `/private/tmp/amr-centro-login-browser.log`; script `/private/tmp/amr-centro-login-browser.cjs`. Login → MFA → diagnostica → logout; nessuna chiamata al login fittizio o errore JS, ricerca nascosta per Admin senza licenza.
- Non certifica TLS/proxy cloud, sessioni fra repliche, reset password/recovery MFA, SMTP Aruba, RLS GraphQL per clienti, quote CRUD, backup o capacità commerciale.
- Sessioni in RAM per 15 minuti; riavvio richiede nuovo login. Hash/password gestiti da Nhost. Revoche della sessione applicativa richiedono incremento dell'epoca AMR o disabilitazione: un logout/reset effettuato direttamente sul provider non è già collegato automaticamente al nostro registro delle sessioni.

## Accesso manuale richiesto dal proprietario

Non esiste una password permanente fornita dall'agente. Dal proprio terminale, nella directory del progetto:

```sh
AMR_NHOST_DOCKER_HOST=unix:///Users/aincrad/.colima/amr-auth/docker.sock node scripts/collauda-nhost-locale.js --manuale
```

Il profilo Colima isolato `amr-auth` è avviato. Se in un giorno successivo fosse spento:

```sh
colima start amr-auth --activate=false --ssh-config=false --mount none --template=false --vm-type qemu --cpu 2 --memory 3 --disk 10
```

1. Prima di avviare, modifica `.env.collaudo-nhost` nella radice del progetto: `AMR_COLLAUDO_EMAIL` e `AMR_COLLAUDO_PASSWORD`. Password dedicata al collaudo, 15–50 caratteri, massimo 72 byte. Il file viene creato con password vuota: nessuna password scelta dall’agente. Non inviarla in chat. Il file è escluso da Git e richiede permessi 600; non modifica il `.env` AMR e non popola `process.env`.
2. Il comando esegue i test e poi resta aperto. Stampa soltanto il link locale di preparazione.
3. La pagina di preparazione mostra l’email configurata nel file e il segreto TOTP sintetico da inserire nell'autenticatore; nessun segreto in console o log. La pagina è solo loopback e scompare premendo il pulsante di completamento. Non è un flusso di onboarding da pubblicare online.
4. Accedi con la password scelta e il codice dell'autenticatore. Il link porta alla diagnostica del centro, non all'AMR commerciale.
5. Alla chiusura con Ctrl+C, dopo che il collaudo è pronto, account, database e container vengono rimossi. Il file `.env.collaudo-nhost` resta sul computer per i collaudi successivi. Le immagini e la VM isolata restano disponibili per il collaudo successivo; nessun servizio CRM viene cambiato.

La modalità interattiva deve essere provata personalmente: l'approvazione automatica ha rifiutato che l'agente inserisse una password, anche sintetica, al posto del proprietario. Le prove automatiche non vengono presentate come una prova già eseguita della scelta manuale della password. Nella prova di annullamento al prompt, nessun container del collaudo manuale è stato creato.

### Aggiornamento: credenziali da file dedicato

Su richiesta del proprietario, eliminato il prompt del terminale. `--manuale` legge esclusivamente `.env.collaudo-nhost` tramite `dotenv.parse`, senza eseguire comandi né espandere variabili. Validazione prima dell’avvio dei container; file assente, credenziali vuote/non valide o chiavi estranee vengono rifiutati con messaggi senza valori. Il collaudo automatico continua a generare credenziali sintetiche e non legge questo file. L’email visualizzata nella preparazione usa lo stesso valore validato della registrazione; non è più fissa. Test con file temporanei e credenziali esclusivamente sintetiche.

### Avvio manuale con file compilato — 1 ottobre 2026

Il proprietario ha compilato il file dedicato. Avvio manuale riuscito al secondo tentativo; processo lasciato aperto e pagine di preparazione/login verificate con GET, senza leggere il body della preparazione. Admin senza sessione rifiutato con 401. Nessuna credenziale nel transcript. Il primo tentativo aveva restituito 400 `invalid-request` alla verifica del JWT precedente; la fase diagnostica rimasta su MFA era fuorviante ed è stata corretta. Nel secondo giro la stessa chiamata e l'intero collaudo sono riusciti: causa del primo 400 non dimostrata, non dichiarata risolta. La verifica temporanea con HEAD veniva respinta dal controllo Origin (metodo diverso da GET); non era una mancata disponibilità della pagina nel browser.

### Ripristino della preparazione MFA — 1 ottobre 2026

Il proprietario non aveva salvato la configurazione dell'autenticatore prima di chiudere la pagina. Riavviato soltanto il collaudo temporaneo: credenziali dal file dedicate conservate, segreto TOTP rigenerato. Pagina migliorata con QR `otpauth` generato dalla libreria già presente, senza servizi esterni; `img-src data:` consentito soltanto nella preparazione. Chiusura subordinata a una conferma esplicita anche sul server; richieste senza conferma ritornano alla preparazione. Una preparazione già chiusa rimanda al login. Nessun segreto visualizzato nel transcript. La conferma è un aiuto UX, non una prova della registrazione: MFA viene verificata dal provider durante il login.
