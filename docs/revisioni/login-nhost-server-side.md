# Login AMR centrale con sessione server-side — 1 ottobre 2026

## Decisione e perimetro

Il proprietario ha scelto la pagina AMR centrale: il backend inoltra email/password e TOTP a Nhost, non li salva e crea una sessione soltanto dopo la risposta diretta del provider. OIDC rimandato; nessun JWT fornito dal browser può creare una sessione Admin. Il commit precedente richiesto è `f2faf73`; questo incremento resta non committato.

Questo è un **collaudo separato su loopback**, non l'autenticazione commerciale già attiva nel centro. Nessuna modifica al launcher normale, agli scraper o ai gate del centro; nessun cloud, account reale, `.env`, OneDrive o M2. Il DB commerciale PostgreSQL e il collegamento delle sessioni alle ricerche costituiscono il prossimo incremento.

## Best practices e verifica del piano

- [OWASP sessioni](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): identificatore opaco casuale, stato server-side, cookie HttpOnly/SameSite, rotazione e invalidazione server-side. Non inferire revoca dalla sola verifica JWT.
- [OWASP autenticazione](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): autenticatore verificato dal provider, errori generici e throttling, niente segreti nei log. Non realizzare un secondo verificatore di password o TOTP nell'app.
- [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): per le modifiche controllare Origin rispetto a un'origine configurata, non a Host arbitrario. SameSite è una difesa aggiuntiva, non l'unico controllo.
- [Nhost MFA](https://docs.nhost.io/products/auth/mfa) e sorgenti Auth 0.49.1: la challenge completata direttamente dal backend è la prova utilizzata; `activeMfaType` e JWT precedente non lo sono. Limiti osservati del provider nel [collaudo locale](nhost-auth-postgres-locale.md).

Debunking iniziale: cookie opaco da solo non impedisce ruoli client, challenge concorrenti o revoche durante un await. Piano corretto: ruolo risolto dal server sullo UUID Nhost; challenge conservata solo sul server e consumata prima dell'await; sessione riletta dopo il controllo asincrono e revisione di revoca controllata prima di crearla. Nessuna inferenza di prontezza cloud dal test locale HTTP.

## File e flusso

- `backend/nodi/nhost-auth-client.js`: client con URL Auth loopback fissata dal processo, timeout, redirect vietati, classificazione HTTP prima del parsing e risposte d'errore depurate.
- `backend/nodi/login-nhost-prova.js`: rotte `/api/auth/login`, `/mfa`, `/me`, `/logout`; pagina `/pagina` e risorse dedicate. Non monta automaticamente le rotte nel centro.
- `backend/nodi/login-nhost-prova.html`, `frontend/nodi-login-prova.js`, `frontend/nodi-login-prova.css`: email/password, codice MFA, stato e uscita. Password e codice cancellati dopo il tentativo, nessun localStorage/token provider.
- `scripts/collauda-nhost-locale.js`: stack sintetico reale e verifica HTTP del nuovo percorso; avvio e arresto automatico della pagina durante il test.
- `test/nodi-login-nhost.test.js`: prove negative, revoche, CSRF, ruoli, concorrenza e trasporto.

Il login restituisce soltanto `{ok:true}` oppure `{mfa:true}`. Il cookie di challenge identifica un ticket custodito nel backend; il browser non può fornire il ticket Nhost. L'Admin ottiene una sessione solo dopo MFA; il ruolo arriva dalla funzione server `identita`, mai da metadata o parametri del browser. Le identità del collaudo sono sintetiche, senza ancora autorizzazioni commerciali PostgreSQL.

Le sessioni sono temporanee in RAM: 15 minuti, massimo 100; challenge 3 minuti, massimo 50. Identificatori casuali da 32 byte, chiavi delle mappe derivate SHA-256. Logout invalida localmente prima di contattare Nhost, anche se il provider è irraggiungibile; l'esito della revoca remota viene distinto. Riavvio perde tutte le sessioni. Il throttling locale del test è globale (20 tentativi/minuto, massimo 4 chiamate contemporanee), non una policy commerciale approvata per trenta clienti.

HTTP senza cookie Secure è consentito **solo nel modulo di prova vincolato a 127.0.0.1**. Non basta cambiare URL e pubblicarlo: prima servono TLS, cookie Secure, confini proxy/origine e persistenza/gestione delle sessioni per il servizio reale. Il cookie è deliberatamente limitato al percorso `/api/auth`; il collegamento alle ricerche richiederà una revisione del suo ambito.

## Finding verificati e controprove durante la review

1. **Revoca durante creazione**: dopo un controllo asincrono una sessione poteva essere creata nonostante una revoca appena avvenuta. Revisione server-side della persona confrontata dopo l'await; test riproduce la sovrapposizione e verifica assenza del cookie.
2. **Controprova — revoca durante lettura**: l'implementazione già rilegge oggetto e scadenza dopo l'await. Il test indipendente conferma il rifiuto; non è un nuovo bug corretto durante la review.
3. **403/5xx indistinti**: il client iniziale descriveva anche 5xx come accesso negato. Ora servizio indisponibile e credenziali rifiutate rimangono distinguibili senza body del provider.
4. **429 reale non JSON**: il client iniziale eseguiva `json()` prima del controllo HTTP. Il rate limit Nhost restituiva testo semplice: il collaudo falliva 503/SyntaxError anziché 429. Correzione al trasporto e regressione con risposta testuale. `Retry-After` numerico, se disponibile e valido, viene propagato; in assenza non inventare una scadenza del blocco del provider.
5. **Controprova — sovrapposizione MFA**: il ticket era già tolto prima dell'await. Il contatore conferma una sola chiamata con due invii simultanei; non è un finding ancora aperto né una correzione successiva.

Il 429 del test era conforme al provider: la fixture superava i dieci tentativi del budget anti-bruteforce. Per completare in un giro tutte le controprove, la sola fixture imposta 30 tentativi/5 minuti; il rate limiter rimane attivo. Non applicare questo valore al cloud per deduzione e non confonderlo con i limiti dei portali automotive. Il rischio del traffico aggregato dal backend AMR sul rate limit Auth va misurato nella configurazione cloud reale.

## Risultati e limiti

- **63/63** test account/HTTP/centro/baseline/configurazione/login: `/private/tmp/amr-nhost-regressioni-20261001.log`.
- Stack reale: verifica email, bcrypt, TOTP, ticket consumato dopo codice numerico errato, comportamento JWT/logout, **AMR → Auth → sessione MFA → logout → cookie riusato negato**, quota SQL con seconda transazione osservata in attesa del lock: `/private/tmp/amr-nhost-collaudo-20261001.log`.
- Chrome headless con provider simulato: email/password → MFA → uscita, campi sensibili cancellati e nessun errore JavaScript. Script ripetibile del collaudo browser: `/private/tmp/amr-login-browser-check.cjs`. La prova browser non è stata eseguita con password reali né con Nhost cloud; il provider reale è collaudato via HTTP nel percorso precedente.
- Nessun test afferma che PostgreSQL commerciale, password reset, recovery MFA, SMTP Aruba, sessioni fra repliche, revoca centrale provider, OneDrive o UI finale siano completi.

Prossimo passo: integrare questo esito autenticato con lo schema commerciale PostgreSQL e i gate asincroni di ingresso/coda/poll/failover/consegna del centro. Ripetere le prove di revoca e scadenza durante la ricerca e di isolamento fra aziende prima di sostituire il provider sintetico. Non basta inserire Promise dove il centro oggi si aspetta controlli sincroni.
