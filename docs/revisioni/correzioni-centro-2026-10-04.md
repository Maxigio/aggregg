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
