# Aggiornamenti ripetibili dello staging — 5 ottobre 2026

## Risultato e perimetro

`scripts/nhost/prepara-aggiornamento-staging.js` prepara localmente il
pacchetto di aggiornamento e rollback. Non esegue build, upload, deploy,
migrazioni, connessioni ai nodi o chiamate ai portali. Nhost e M2 non sono
stati modificati in questo incremento. Non è una pipeline CI già attiva.

Riusa `prepara-contesto-centro` e `prepara-release-nodi`: il codice e i
cataloghi provengono dal commit HEAD catturato una volta, non dai file
modificati o non tracciati del checkout. Il contesto contiene il manifest
completo e la ricetta Docker dello stesso commit. Credenziali e database
locali non sono sorgenti del pacchetto.

## Comando e input

```sh
node scripts/nhost/prepara-aggiornamento-staging.js \
  --stato /percorso/privato/stato-staging.json \
  --immagine registry.eu-central-1.nhost.run/40f9c208-5e1b-49ac-afcd-54e56d70de8b@sha256:DIGEST
```

`DIGEST` deve essere sostituito dal digest SHA-256 reale del registry, non
dall'ID Docker locale né da un tag. Il comando rifiuta argomenti extra e
non ha un'opzione per distribuire. Prima del comando verificare che HEAD
sia il candidato approvato; un commit successivo non cambia quel contesto.

Lo stato è JSON con i soli campi:

- `progetto`, `servizio`: identificatori del solo staging AMR;
- `manifest`: `protocollo`, `release`, `codice`, `cataloghi` della versione
  precedente effettivamente distribuita;
- `config`: configurazione Run corrente **non risolta**, completa di
  `name`, `command`, `image`, `environment`, `ports`, `resources`, `healthCheck`.

Lo stato va acquisito e confrontato con il provider prima di ogni uso.
Il comando non lo scarica né ne attesta la provenienza. Non usare un
template storico o un'esportazione di credenziali risolte. Per PostgreSQL,
database e token sono accettati soltanto riferimenti `{{ secrets.NOME }}`
al nome previsto. Origine, Auth e proxy possono restare riferimenti oppure
contenere i rispettivi valori non sensibili ammessi. I valori dei segreti
non fanno parte del backup di configurazione; la gestione/rotazione dei
segreti resta separata e il rollback non deve revocarla.

Il comando è intenzionalmente limitato alla configurazione dello staging
conosciuta: un nuovo campo, variabile, volume, porta, risorsa o comando
richiede una review, senza essere ignorato. L'accesso remoto ai dati di
configurazione e l'uso dei relativi strumenti restano nel gate autorizzato.

## File prodotti

Due nuove directory private, senza overlay Nhost ereditati:

- contesto Docker dal commit, con `release.json` completo;
- pacchetto con `piano.json`, impronte SHA-256 dei TOML e cinque configurazioni.

| File | Immagine | Repliche | Utilizzo |
| --- | --- | --- | --- |
| `01-arresto.toml` | precedente | 0 | Richiedere l'arresto del servizio attuale |
| `02-candidato-fermo.toml` | candidata | 0 | Impostare la candidata dopo l'arresto verificato |
| `03-candidato-avvio.toml` | candidata | 1 | Avviare dopo tutti i prerequisiti |
| `04-rollback-arresto.toml` | candidata | 0 | Fermare una candidata non valida |
| `05-rollback-avvio.toml` | precedente | 1 | Ripristinare dopo arresto e compatibilità verificati |

La quinta configurazione coincide integralmente con quella precedente.
Le altre cambiano soltanto immagine e repliche. Mount, capacità, compute,
porte, ambiente e health check restano invariati. Questo preserva la
configurazione del mount; l'identità del volume fisico va verificata su Run.
Le directory riuscite restano disponibili per la review; in caso di errore
si tenta di eliminare solo quelle appena create dal comando. Le due pulizie
sono indipendenti: se una fallisce si tenta comunque l'altra e si segnala
esplicitamente la pulizia incompleta.

## Procedura remota, ancora da collaudare e autorizzare

Non applicare i cinque file in una sequenza automatica senza verifiche.

1. Verificare le impronte dei file e del contesto; costruire e collaudare
   l'immagine con il gate esistente. Dopo l'upload autorizzato, confrontare
   il manifest contenuto nell'immagine con quello candidato e fissare il
   digest. Un digest formalmente valido non prova che contenga quel codice.
2. Confrontare la configurazione fresca del servizio con `precedente.config`;
   non procedere se c'è drift, nemmeno dei peer proxy. Provare backup e
   restore separati di PostgreSQL e SQLite Run, e compatibilità di schema
   e stato sia per aggiornamento sia per rollback. Il pacchetto non applica SQL.
3. Avvisare della manutenzione: restart perde sessioni/coda RAM, richiede
   nuovo login e non ripete lavori dall'esito incerto.
4. Applicare `01-arresto`. Verificare **l'arresto dei processi**, conservando
   il volume. Una configurazione a zero, un'attesa fissa o `/healthz` non
   provano da soli l'assenza di una vecchia istanza. Se manca questa prova,
   fermarsi senza applicare la candidata.
5. Applicare `02-candidato-fermo`, rileggere e confrontare la configurazione;
   applicare `03-candidato-avvio` solo dopo i prerequisiti. Verificare digest,
   volume, UID, proxy, login/MFA, permessi correnti, worker dello stesso
   manifest e ricerca simulata. Il 200 della sonda non è il gate funzionale.
6. In caso di problema applicare `04-rollback-arresto`, verificarne l'arresto
   e la compatibilità dei dati prima di `05-rollback-avvio`. Ripetere il gate.
   Non ripristinare automaticamente vecchi dati, credenziali revocate o lavori.
   Se una risposta al comando si perde, rileggere lo stato; niente retry cieco.

La CLI ufficiale supporta `nhost run config-deploy --config FILE --service-id ID`.
Usarla solo nel perimetro autorizzato. Può applicare automaticamente
`nhost/overlays/run-ID.json`: mantenere la directory del pacchetto isolata
e verificarne l'assenza immediatamente prima dell'uso. Non eseguire
`config-show` su credenziali reali per ricavare il backup: risolve i segreti.

## Verifiche e limiti

Le prove controllano preservazione e rollback esatto, input avversi, tag
mobili, destinazione errata, segreti letterali, symlink, dimensione input,
cleanup, esclusione dei file locali e validazione TOML con CLI ufficiale
in HOME nuovo e segreti sintetici. La CLI è opt-in tramite
`AMR_TEST_NHOST_CLI`; il runner normale non scarica strumenti e non usa login.
La materializzazione completa sul Git HEAD reale è un gate separato,
`AMR_TEST_STAGING_HEAD=1`, con ambiente vuoto e directory temporanee proprie.
Ha un budget di cinque minuti per copiare centinaia di blob, distinto dai
60 secondi della ricerca. Il primo tentativo con budget di un minuto si è
fermato prima del completamento, anche fuori dal sandbox; nessun timeout
dell'applicazione è stato modificato per superare la prova.

La review indipendente ha riprodotto due problemi di cleanup: rimozione del
pacchetto fallita che impediva di tentare la rimozione del contesto; `chmod`
iniziale del helper fuori dal blocco protetto che lasciava una directory
vuota. Corretti al livello responsabile e coperti da fault injection, con
controprova di errore durante la pulizia stessa. Nessun deploy è stato usato
per verificare questi casi.

Gate finale: **79 pass, zero failure/cancelled/skip**, Node 24.21.0 e CLI
Nhost 1.51.2. File: `nodi-aggiornamento-staging`, `nodi-compatibilita`,
`nodi-centro-run`, `nodi-schema-staging`. La prova del comando completo ha
materializzato HEAD `f32be91` in circa 49,5 secondi, poi verificato il
manifest ed escluso `.env` e `data/auth.json`. Digest e stato precedente in
questa prova erano sintetici, non un'immagine pronta per Run. Le directory
di prova sono state rimosse. I test HTTP usano soltanto listener loopback;
il primo giro nel sandbox li negava con EPERM, il giro autorizzato passa.
Review indipendente conclusiva: entrambi i finding chiusi, nessun nuovo
finding concreto confermato nel cambiamento; diagnostica CLI verificata
anche con pulizia incompleta. Nessuna conclusione estesa alla produzione.

Restano distinti: pacchetto preparato, immagine collaudata, upload eseguito,
configurazione distribuita, processo osservato e gate funzionale superato.
Questo incremento non prova rollback sul provider, backup esterno, arresto
di Run o compatibilità futura dei dati. Non aggiorna l'iMac worker né M2.

## Fonti ufficiali e controprove

- [Nhost deploy CLI](https://docs.nhost.io/products/run/cli-deployments):
  build/upload e `config-deploy` sono operazioni distinte. Non dimostra
  arresto completo, compatibilità dati o rollback AMR.
- [Nhost configurazione](https://docs.nhost.io/products/run/configuration):
  risorse, volumi e segreti per riferimento. Conservare un mount dichiarato
  non certifica l'identità fisica o un backup ripristinabile.
- [Nhost overlay](https://docs.nhost.io/products/run/configuration-overlays):
  `config-deploy` può applicare un overlay con il nome del service ID;
  non basta controllare soltanto il TOML.
- [Docker digest](https://docs.docker.com/dhi/explore/security-concepts/digests/):
  digest immutabili, tag modificabili; indice multiarch e immagine della
  singola piattaforma hanno identificatori distinti.
- [Nhost health check](https://docs.nhost.io/products/run/health-checks):
  liveness su `/healthz`, non prova di login, DB, worker o arresto del precedente.

Ricontrollate il 5 ottobre 2026; CLI locale 1.51.2. Gli stessi limiti sono
verificati nel codice e nei gate esistenti, senza dedurre garanzie dal listino.
