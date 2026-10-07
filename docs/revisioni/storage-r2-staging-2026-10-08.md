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

Nessuna modifica ai bucket `amr-collaudo-backup-*`, cancellazione, lifecycle
o nuova esposizione pubblica. Lo stato 0 B sopra riguarda la creazione;
l'inizializzazione restic descritta sotto ha poi scritto i propri metadati.
Endpoint per questi bucket: `https://88508b25fc92046c93f7a33eaac1bc2c.eu.r2.cloudflarestorage.com`.
La giurisdizione EU è distinta da un semplice suggerimento geografico.

Prova UI privata: `/private/tmp/amr-r2-staging-20261008-ZeYPy7/journal-privato.png`.

## Credenziale creata e accesso verificato

Form pronto per un Account API Token, nome `AMR staging backup - 2026-10-08`:
Object Read & Write, soltanto i due bucket sopra, TTL sei mesi.
Nessun permesso amministrativo sui bucket né scope su bucket futuri.
La conferma finale è stata fornita dall'utente: questi permessi consentono anche
cancellazioni di oggetti via S3. Nessuna cancellazione è autorizzata o prevista
in questo incremento. La scadenza richiederà rotazione prima del termine;
una credenziale valida non prova che la rotazione sia implementata.

Prova del form, senza segreti:
`/private/tmp/amr-r2-staging-20261008-ZeYPy7/scope-token-staging.png`.
Predisposto `/Users/aincrad/.config/automotoradar/staging/r2-backup.env`,
0600 in directory 0700, fuori dal repository. L'utente ha poi inserito
`AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`; formato e permessi verificati,
senza mostrare i valori. Questa custodia temporanea non è un vault.
La chiave restic e la ricevuta trusted sono componenti separati.

Dopo il consenso esplicito, eseguito un solo clic di creazione. La pagina
di successo conferma nome, Object Read & Write sui soli due bucket EU e
validità **8 ottobre 2026 — 8 aprile 2027**. Nessuna lettura dei valori
Token value, Access Key ID o Secret Access Key. La pagina è lasciata aperta
per la copia da parte dell'utente nel file privato predisposto.
Prova ritagliata prima dei campi segreti, verificata visivamente:
`/private/tmp/amr-r2-staging-20261008-ZeYPy7/token-creato-senza-segreti.png`.
L'utente ha confermato l'inserimento. Il preflight S3, alle **01:29:36
Europe/Rome dell'8 ottobre**, ha eseguito soltanto quattro `HEAD`:

| Bucket | Risposta HTTP |
| --- | --- |
| `amr-staging-backup-db` | 200 |
| `amr-staging-backup-journal` | 200 |
| `amr-collaudo-backup-db` | 403 |
| `amr-collaudo-backup-journal` | 403 |

HEAD riuscite sui due bucket staging e rifiutate sui due bucket di collaudo.
Il preflight non verifica altre operazioni sui bucket di collaudo.
Nessun body, upload o cancellazione nel preflight; questa prova
non dimostra l'assenza di permessi di cancellazione sugli oggetti autorizzati.
Ricevuta privata: `/private/tmp/amr-r2-staging-preflight-QQoNLd/esito.json`.

## Repository cifrati inizializzati; zero snapshot

Creato esclusivamente il file chiave
`/Users/aincrad/.config/automotoradar/staging/restic-password`, con casualità
crittografica e apertura esclusiva senza seguire symlink. File 0600 in
directory 0700; sincronizzati file e directory prima dell'inizializzazione.
Una nuova esecuzione non deve sovrascrivere questa chiave.

Usato il binario restic 0.19.1 già verificato, SHA-256
`b2b553b402b9971b0c3f673d880397a421526f55a08f21fe5b82b5dd9e049a08`,
tramite il wrapper `backup-restic.js`, senza installazioni o dipendenze nuove.
Inizializzati in sequenza due repository, prefisso `restic`, sui soli bucket
staging autorizzati. Verificati ID distinti, `check --read-data` riuscito per
entrambi e zero snapshot database/journal. Nessun dato vivo trasferito.

Controprova: una chiave errata non apre il repository database; la chiave
corretta lo riapre e restituisce la stessa identità dopo il tentativo fallito.
Non sono state cancellate copie, eseguito prune o attivata retention.
Ricevuta privata: `/private/tmp/amr-r2-staging-repository-2VkCwz/esito.json`.
La seconda copia offline della chiave è stata richiesta all'utente, ma
non è ancora confermata. La ricevuta del punto di recovery verrà prodotta
con un backup attestabile: gli ID dei repository non la sostituiscono.

Review indipendente in sola lettura: corretto un finding documentale che
generalizzava i 403 delle HEAD a tutte le operazioni. Nessun altro finding
confermato nel perimetro. Limite delle ricevute: è registrato il rifiuto della
chiave errata, ma non il doppio ID del confronto prima/dopo eseguito nella
controprova. La review non può ricostruire da quella sola ricevuta la sequenza
completa e non certifica backup o restore vivi.

## Gate non concluso

Il runtime `backend/nodi/centro-run.js` istanzia ancora il worker backup
senza repository o dump: i bucket da soli **non collegano** il backup vivo.
Restano seconda copia offline della chiave, configurazione e prova del
backup staging con restore isolato e ricevuta del punto di recovery.
Il collaudo locale del nuovo indice non sostituisce questa prova.
Nessun deploy, connessione M2 o modifica della console effettuati qui.

Fonti verificate:
- [Creazione bucket](https://developers.cloudflare.com/r2/buckets/create-buckets/): privati per default.
- [Token R2](https://developers.cloudflare.com/r2/api/tokens/): scope per bucket, token account, endpoint per giurisdizione.
