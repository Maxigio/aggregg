# Preparazione dello staging Nhost — 3 ottobre 2026

## Incremento completato e confini

Preparazione locale del pacchetto, sul candidato `fc1b7f2`, dopo le
[correzioni precedenti](correzioni-nodi-2026-10-03.md). Nessuna mutazione del
progetto remoto, upload, creazione di credenziali o avvio Run. Il checkout
condiviso e i file non tracciati di APP sono preservati.

Si riusano `scripts/prepara-contesto-centro.js`, il manifest esistente e
`scripts/nhost/centro-staging.toml`: nessun nuovo builder o formato di deploy.
Il prossimo avvio remoto richiede il gate distinto nel
[registro staging](staging-nhost.md), compreso il costo effettivo.

## Identità del pacchetto locale

Contesto materializzato dai blob Git, non dai file di lavoro:

- release: `fc1b7f2110c03a0bdda71981c4c7fcbdb251819f`;
- codice: `c5a7870b798d3ceb4dc1390a0307f6ccca67d5a11d2af7d94a0f0270f8b6ce65`;
- cataloghi: `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.

Queste due impronte coincidono con quelle dell'immagine locale
`amr-centro:staging-a05d45a` già collaudata; la release è diversa. Non è stata
costruita né collaudata un'immagine `fc1b7f2`. Centro e worker devono comunque
condividere il medesimo manifest, compresa la release. L'ID Docker locale
non sostituisce il digest del registry. Dopo ogni modifica runtime, rigenerare
contesto e manifest dal commit approvato, ricostruire e ripetere il gate.

Metadati temporanei, senza valori segreti:
`/private/tmp/amr-staging-next-context-20261003.json` e
`/private/tmp/amr-staging-next-pacchetto-20261003.json`. I percorsi temporanei
non sono un repository durabile di artefatti: il contesto è rigenerabile dal commit.

## Migrazioni e ruoli da verificare prima dell'applicazione

Su **nuovo database**, dopo aver verificato schema/versione Auth e assenza
di dati applicativi, ordine del pacchetto:

| File in `backend/nodi/` | SHA-256 |
| --- | --- |
| schema-accessi-prova.sql | cc02efe06bcb84b388b735d826ad9861d794f69e4f7c588dfca9967244995566 |
| schema-aziende-prova.sql | b5dbf733cbed04bd9c329c2807b2285d23351ee2999e9a6765ef24abd648877f |
| schema-inviti-consegna.sql | efd2ce549185fbeec772a8daa4a2a303d3d3ecc79d86528886fe4affb4428a23 |
| schema-rinnovi-prova.sql | 541b2f681e08f190e9e1d9064e146d32c9683e538806e4951efe56b41006d29b |
| schema-rinnovi-datestyle.sql | b2fe9d0a83e6da286130398334c984508df9695f42cacd5cec1048e7c69b7d94 |
| schema-colleghi-prova.sql | 57c576201c0ef4c27909a7cc0472da0910d68aaa075e6988660c1e6be5eaabfa |
| schema-backup-prova.sql | 65369d51648fd28a399897e95626eed4b3e156c6fd4d71a595ca65c259fe890d |
| schema-ripristino-sequenza.sql | ba07b6452bd50d0dc3b309f62fb7de2f4c60532c980b95db7eb40d2f1e68d9a9 |

La patch inviti è già incorporata nella definizione nuova; la sua applicazione
serve anche a esplicitare l'allineamento. Le patch DateStyle e sequenza sono
riapplicabili. Gli script di creazione di ruoli, schemi e tabelle **non sono
migrazioni idempotenti**: su un database esistente verificare prima lo stato
e applicare soltanto le patch necessarie. Nessun automatismo all'avvio Run.
In recovery applicare la patch sequenza **dopo `pg_restore`**, perché un dump
storico può sovrascrivere la funzione corrente.

Membership dei tre login runtime, distinti dalle credenziali dell'installatore:

- `amr_gateway`: soltanto `amr_accessi_lettore`;
- `amr_commerciale`: `amr_aziende_scrittore` e `amr_colleghi_scrittore`;
- `amr_copie`: soltanto `amr_backup_esecutore`.

Prima dell'uso remoto provare privilegi effettivi, divieto di lettura dei dati
Auth riservati e dell'outbox, MFA Admin, isolamento aziende e quote. `pg_dump`
del database non comprende i ruoli globali: ricrearli dalla procedura fidata,
senza usare il login installatore nel processo web.

## Prove e controprove di questo incremento

- Node 24.21.0; test Run/configurazione/avvio/compatibilità/HTTPS: **54/54 pass**,
  zero skip. Dati e log temporanei, dotenv disabilitato.
- CLI ufficiale Nhost 1.51.2 già verificata: `run config-validate`, ambiente
  isolato e segreti esclusivamente sintetici, senza `service-id` o overlay remoto.
- TOML candidato: exit 0. Campo sconosciuto, CPU 501 e riferimento a segreto
  assente: ciascuno exit 1. Nessun allargamento delle regole per far passare la prova.
- Configurazione rimasta `replicas=0`, porta non pubblicata. Validazione e
  materializzazione del contesto non costituiscono un deploy.

Evidenze: `/private/tmp/amr-staging-next-check-20261003.log`,
`/private/tmp/amr-staging-next-cli-20261003.log` e i tre log
`/private/tmp/amr-staging-next-cli-{campo-sconosciuto,cpu-errata,segreto-assente}.log`.

## Gate ancora necessari

Non riaprire il gate clienti finché restano finding di recovery confermati.
Per il cloud rimangono: versione e permessi PostgreSQL, digest remoto,
volume UID 1000, origine/peer proxy misurati, SMTP/email/MFA, ingress e deadline,
worker simulato con manifest identico, arresto verificato prima del nuovo
scheduler e restore separato di PostgreSQL **e SQLite**. Il backup esterno resta
non configurato nel runtime Run: due repository separati richiedono il proprio
incremento, non si presumono attivi perché esiste un volume.

Lo stato remoto resta l'ultima osservazione registrata: in questo incremento
non era presente una sessione browser Nhost da ricontrollare. Nessun costo
o funzionamento cloud è stato confermato di nuovo.

## Fonti ufficiali ricontrollate

- [Run: configurazione](https://docs.nhost.io/products/run/configuration),
  [CLI deployments](https://docs.nhost.io/products/run/cli-deployments) e
  [registry](https://docs.nhost.io/products/run/registry).
- [Run: networking](https://docs.nhost.io/products/run/networking),
  [risorse](https://docs.nhost.io/products/run/resources) e
  [health checks](https://docs.nhost.io/products/run/health-checks): `/healthz`
  è liveness; pausa conserva il volume, cambiarne il nome può eliminarlo.
- [PostgreSQL 16: SQL dump](https://www.postgresql.org/docs/16/backup-dump.html)
  e [Docker build best practices](https://docs.docker.com/build/building/best-practices/).
- [OWASP: Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  controllo corrente dei permessi, default deny e privilegi minimi.
