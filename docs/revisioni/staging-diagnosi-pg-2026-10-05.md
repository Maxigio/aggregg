# Intermittenza PostgreSQL e preparazione staging — 5 ottobre 2026

## Perimetro

Richiesti diagnosi del fallimento intermittente, staging completo del prototipo
e commit. Solo progetto Nhost AMR a Frankfurt; M2, clienti, portali reali e
frontend principale AMR restano fuori da questo incremento.

## Diagnosi verificata

Baseline `3dfb509`. Un gate integrato fresco con PostgreSQL 18.6 e Auth 0.49.1
è passato. Una seconda istanza isolata ha eseguito dieci volte consecutive la
fixture colleghi, con worker backup attivo, poi completato il gate e il cleanup.
Ogni giro pulisce i propri dati commerciali; il journal backup cresce durante
le ripetizioni. Non è una prova di carico della produzione.

Non si è riprodotto il fallimento storico nell'accettazione del referente.
L'osservatore temporaneo di `pg.Pool.query` ha intercettato soltanto il rifiuto
`P0001 invito_non_valido` previsto dal test. Non sono stati aumentati timeout,
quote o retry per ottenere il PASS. **La causa storica resta non dimostrata.**

La review indipendente ha verificato controprove per quota, trigger backup,
CHECK temporali e transazioni della fixture. Nessun difetto deterministico
confermato in quei percorsi. Timeout/connessione, contesa e clock restano
ipotesi da distinguere tramite un errore effettivamente osservato.

## Correzione della capacità diagnostica

Il collaudo automatico ora osserva soltanto il proprio writer pool per
`aziende_invita`, `aziende_accetta` e `aziende_attiva`, prima della mappatura
dell'adapter al messaggio pubblico. Registra SQLSTATE, durata monotona,
classificazione dei timeout client, contatori del pool e contesto funzione
da allowlist. Non registra parametri, SQL, email, token, stack, `detail` o
messaggi arbitrari. Il collaudo manuale e il runtime Run non vengono modificati.

La review ha trovato e fatto riprodurre un errore nella prima versione del
diagnostico: `EPIPE` soddisfa la regex di cinque caratteri ma è un errore di
socket. Ora un SQLSTATE richiede anche `pg.DatabaseError`; la controprova
impedisce quella falsa classificazione. Promise/callback, errore originale,
reporter fallito e sentinelle sensibili sono verificati: **9/9 test mirati**.

Limite esplicito: saturazione dell'adapter e risposta SQL senza `risultato`
non rigettano `pool.query`; questo osservatore non li identifica. Nella fixture
storica il percorso documentato passa dall'accettazione, ma non si inferisce
la causa da un codice di dominio generico. Questa modifica non è presentata
come risoluzione del guasto intermittente.

Evidenze locali senza credenziali:

- `/private/tmp/amr-pg-diagnosi-giro1-20261005.log`;
- `/private/tmp/amr-pg-diagnosi-ripetizioni-20261005.log`.

## Verifica remota preliminare

Inventario SQL in sola lettura nel progetto AMR: PostgreSQL **18.6**, database
`muwqbjnpgdfnghdqxvmk`, installatore `nhost_hasura`, possibilità di assumere
`postgres`, `auth.refresh_tokens` presente, nessuno schema o ruolo `amr_`.
Servizio `amr-centro-staging` ancora fermo, senza immagine/configurazione
applicativa al momento dell'inventario. Nessun dato di account letto.

Il proprietario ha scelto la propria Gmail per il primo Admin cloud. Password
e enrollment MFA saranno configurati direttamente da lui, senza copiarli
dal collaudo locale. Gli altri prerequisiti sono digest remoto, schema atomico,
tre login PostgreSQL limitati, segreti Run, volume UID 1000, proxy espliciti,
Auth/MFA e worker simulato. `/healthz` non sostituisce queste prove.

## Riferimenti autorevoli

- [PostgreSQL: SQLSTATE](https://www.postgresql.org/docs/current/errcodes-appendix.html):
  distinguere i codici dai messaggi localizzati; un errore client non diventa
  un errore PostgreSQL solo per il formato della stringa.
- [node-postgres: pool](https://node-postgres.com/features/pooling): rilascio
  dei client e distinzione tra acquisizione del pool ed esecuzione della query.
- [Nhost Run: deploy CLI](https://docs.nhost.io/products/run/cli-deployments),
  [rete](https://docs.nhost.io/products/run/networking) e
  [MFA](https://docs.nhost.io/products/auth/mfa): artefatto, configurazione,
  collegamento privato e enrollment sono verifiche distinte.

Lo staging non certifica la produzione; causa dell'intermittenza e backup
esterno/restore rimangono gate prima dei clienti.
