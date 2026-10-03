# Correzioni successive alla review del candidato 6655950

Registro della lavorazione autorizzata il 3 ottobre 2026 sul branch
`feat/nodi-residenziali-prototipo`. Commit iniziale dei finding: `c34d361`.
Scope: centro, accessi, scheduler, backup e UI; nessun deploy, M2 o portale reale.
Le modifiche APP e i file preesistenti non tracciati restano separati.

## A02 — Autorizzazione Admin dopo il body

Risolto: entrambe le mutazioni dei nodi ricontrollano la sessione dopo il parser.
Prima: body incompleto, logout, completamento → revoca 200.
Ora: 401, zero scritture; una nuova sessione autorizzata esegue il comando.
Regressioni HTTP durabili per revoca token e sospensione. Review indipendente:
logout, revoca persona e scadenza durante il secondo await, più DELETE lavori;
nessuna mutazione dopo perdita dell'accesso.
Suite centro/protocollo e casi A02: 18/18. Nessun finding residuo confermato.

La verifica segue OWASP: autorizzare sul server ogni richiesta e prima della
mutazione; l'ordine rispetto al parser deriva dal nostro percorso riprodotto.
[OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html).

## A01 — Disponibilità delle revoche

Budget separati: pubblico, letture per persona e mutazioni per persona, 30/min
ciascuno. La persona proviene dalla sessione server; il body non decide la chiave.
Massimo quattro operazioni attive per famiglia di rotte; massimo tre letture o
operazioni pubbliche, riservando un posto alle mutazioni. Conti RAM limitati a
201 chiavi (100 persone × due budget, più pubblico), scadenza 60 secondi.
Nessun timer o persistenza dei contatori; pulizia all'ingresso, nessuna espulsione
che azzeri i limiti delle persone ancora nella finestra.
Le autorizzazioni di ruolo, tenant, epoca e MFA rimangono nei handler e in SQL.

Review indipendente: trovato e corretto un flag pubblico mancante nella
consultazione inviti colleghi; regressione senza cookie aggiunta. I test verificano
trenta richieste anonime/letture seguite da revoca ammessa, indipendenza fra
persone, saturazione, scadenza e recupero degli slot solo al settlement.
I numeri sono limiti iniziali del prototipo, non una capacità di produzione
certificata da [OWASP API4](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/).
