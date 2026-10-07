# Storage operativo dello staging — 8 ottobre 2026

Segue [indice di recovery verificato](recovery-indice-2026-10-08.md).
Perimetro autorizzato: staging Nhost; nessun dato o processo M2.

## Operazioni effettivamente completate

Login Cloudflare eseguito dall'utente; pannello R2 verificato.
Creati tramite dashboard due bucket **nuovi**, separati dal collaudo:

| Bucket | Giurisdizione | Classe | Accesso pubblico | Contenuti alla creazione |
| --- | --- | --- | --- | --- |
| `amr-staging-backup-db` | EU | Standard | Disabled | 0 B |
| `amr-staging-backup-journal` | EU | Standard | Disabled | 0 B |

Nessuna modifica ai bucket `amr-collaudo-backup-*`, nessuna copia,
cancellazione, lifecycle o nuova esposizione pubblica.
Endpoint per questi bucket: `https://88508b25fc92046c93f7a33eaac1bc2c.eu.r2.cloudflarestorage.com`.
La giurisdizione EU è distinta da un semplice suggerimento geografico.

Prova UI privata: `/private/tmp/amr-r2-staging-20261008-ZeYPy7/journal-privato.png`.

## Credenziale creata; custodia da completare

Form pronto per un Account API Token, nome `AMR staging backup - 2026-10-08`:
Object Read & Write, soltanto i due bucket sopra, TTL sei mesi.
Nessun permesso amministrativo sui bucket né scope su bucket futuri.
La conferma finale è stata fornita dall'utente: questi permessi consentono anche
cancellazioni di oggetti via S3. Nessuna cancellazione è autorizzata o prevista
in questo incremento. La scadenza richiederà rotazione prima del termine;
una credenziale valida non prova che la rotazione sia implementata.

Prova del form, senza segreti:
`/private/tmp/amr-r2-staging-20261008-ZeYPy7/scope-token-staging.png`.
Creato solo il file vuoto `/Users/aincrad/.config/automotoradar/staging/r2-backup.env`,
0600 in directory 0700, fuori dal repository. Contiene i nomi
`AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`, senza valori; non è un vault.
La chiave restic e la ricevuta trusted sono componenti separati.

Dopo il consenso esplicito, eseguito un solo clic di creazione. La pagina
di successo conferma nome, Object Read & Write sui soli due bucket EU e
validità **8 ottobre 2026 — 8 aprile 2027**. Nessuna lettura dei valori
Token value, Access Key ID o Secret Access Key. La pagina è lasciata aperta
per la copia da parte dell'utente nel file privato predisposto.
Prova ritagliata prima dei campi segreti, verificata visivamente:
`/private/tmp/amr-r2-staging-20261008-ZeYPy7/token-creato-senza-segreti.png`.
L'inserimento delle due credenziali e l'accesso S3 non sono ancora verificati.

## Gate non concluso

Il runtime `backend/nodi/centro-run.js` istanzia ancora il worker backup
senza repository o dump: i bucket da soli **non collegano** il backup vivo.
Restano custodia/verifica della credenziale, seconda copia offline della
chiave, configurazione e prova del backup staging con restore isolato.
Il collaudo locale del nuovo indice non sostituisce questa prova.
Nessun deploy, connessione M2 o modifica della console effettuati qui.

Fonti verificate:
- [Creazione bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/): privati per default.
- [Token R2](https://developers.cloudflare.com/r2/api/tokens/): scope per bucket, token account, endpoint per giurisdizione.
