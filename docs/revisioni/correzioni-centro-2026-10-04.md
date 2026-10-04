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
