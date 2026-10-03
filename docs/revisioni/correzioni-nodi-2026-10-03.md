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
