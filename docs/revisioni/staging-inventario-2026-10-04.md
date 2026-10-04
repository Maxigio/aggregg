# Staging Nhost: candidato e inventario del 4 ottobre 2026

## Perimetro e candidato

Commit richiesto eseguito: `9ed5479bb30e7a0d863daf549eac59e060ef1386`,
`fix(staging): vincola il gate al candidato e verifica cleanup`.
Preservati branch e file preesistenti della chat APP. Nessun upload, avvio Run,
migrazione remota, lettura di credenziali, richiesta ai portali o intervento M2.

Immagine rigenerata esclusivamente dai blob di quel commit:

- tag locale `amr-centro:staging-9ed5479`;
- codice `76a3d00b2b5dbeea0e6bc3b9aff2e7db248f925d5efe1618bb40a54a57ef3ea8`;
- cataloghi `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`;
- ID Docker locale `sha256:09e2a1593892541d05b807bd50eaa50b6c59d0089ab78b0efcc507972b85aa7f`;
- Linux amd64, utente `node`, 116.628.329 byte. Non è un digest del registry.

Gate dell'immagine passato con manifest atteso da HEAD, Auth 0.49.1,
PostgreSQL 16, HTTPS locale, identità sintetiche e worker simulato. Verificati
login/MFA, moduli, quote e revoche, risposta, SIGTERM, persistenza e invalidazione
delle sessioni dopo riavvio. Cleanup completato: gli otto container dei due
collaudi manuali preesistenti rimangono attivi, nessun container del gate residuo.
Non è una prova dell'ingress Nhost, del carico clienti o dei backup esterni.

Evidenze temporanee: `/private/tmp/amr-staging-context-9ed5479-20261004.json`,
`/private/tmp/amr-staging-build-9ed5479-20261004.log`,
`/private/tmp/amr-staging-image-gate-9ed5479-20261004.log`.
La diagnostica del pool usa soltanto codici allowlisted; errori SQL di permesso
sono previsti nelle controprove negative. Il precedente fallimento intermittente
della fixture colleghi resta a causa non dimostrata: questo giro passato non
dimostra che sia stato corretto.

## Inventario remoto verificato in sola lettura

Progetto AMR, regione Frankfurt, organizzazione Pro. Il servizio
`amr-centro-staging` usa il registry Nhost ma ha immagine vuota, zero repliche,
0,062 vCPU/128 MiB, nessuna variabile, porta, volume o health check.
Il form stima zero costi compute per questo stato; non è un preventivo del
candidato completo né della fattura dell'organizzazione. Il form è stato
chiuso con Cancel, senza Update.

Eseguita la query di [inventario](../../scripts/nhost/inventario-staging.sql)
nell'editor con `Read only=true`, `Track this=false`: soltanto cataloghi di
sistema e nomi/tipi di colonne, nessuna riga applicativa o Auth.

| Dato | Esito osservato | Limite |
| --- | --- | --- |
| PostgreSQL | `18.6` | Gate locale 18.6 passato; non equivale a migrazioni o restore sul servizio remoto |
| Schemi/ruoli AMR cercati | Nessuno presente | Non dimostra che l'intero database sia vuoto |
| Auth users | `id` uuid; email public.citext; email_verified/disabled boolean | Presenza dei quattro campi, non attestazione dell'intera versione Auth |
| Tabelle per revoca recovery | refresh_tokens, oauth2_refresh_tokens | refresh_token_sessions assente; il codice la tratta come opzionale |
| Ruolo editor | nhost_hasura, senza superuser/createrole | Attributi propri, non tutti i privilegi disponibili |
| Possibilità SET ROLE postgres | `pg_has_role(...,'SET') = true` | Nessun SET ROLE o comando privilegiato eseguito |
| Attributi del ruolo postgres | superuser, createrole, createdb e bypassrls true | Solo metadati; nessuna modifica di ruolo o grant |

**Controprova:** concludere «le migrazioni sono impossibili perché CREATEROLE
è false» sarebbe errato. La membership consente SET ROLE postgres; la guida
Nhost documenta questa modalità. Resta da collaudare la procedura di installazione
autorizzata, con owner/grant corretti e tre login runtime senza tale membership.

## Pacchetto da preparare prima della mutazione remota

Si mantiene il TOML esistente, inizialmente `replicas=0` e `publish=false`.
Le risorse candidate sono 500 millicpu/1.024 MiB e 1 GiB nel volume
`amr-centro-dati` su `/var/lib/amr`. Non applicarlo finché mancano i controlli
seguenti e l'autorizzazione sul pacchetto concreto:

1. Allineare il collaudo locale a PostgreSQL 18.6, usando la stessa major per
   dump/restore. Provare schema, ruoli, quote e recovery senza cambiare il DB
   remoto. Non assumere che la sola differenza di versione sia un bug.
2. Verificare la versione Auth effettiva e installare le migrazioni nell'ordine
   del [pacchetto](staging-pacchetto-2026-10-03.md), dopo l'autorizzazione.
   Non usare nhost_hasura/postgres nel processo web e non tracciare le tabelle
   AMR in GraphQL implicitamente. Testare letture vietate e funzioni consentite.
3. Caricare l'immagine approvata, registrare il digest remoto e verificare che
   il worker simulato usi il medesimo manifest. Configurare i segreti per nome,
   senza esportarli nei report o nella configurazione Docker personale.
4. Verificare il volume come UID 1000 e gli header/peer dell'ingress. Se il peer
   cambia al riavvio, risolvere il contratto del proxy prima dell'accesso clienti;
   non allargare indiscriminatamente la fiducia a qualunque rete.
5. Provare arresto completo prima di avviare un nuovo scheduler; rollback con
   stesso volume e schema compatibile. Una variabile REPLICHE=1 non è un lock
   distribuito. Il collaudo locale non attesta il rollout del provider.
6. Configurare e ripristinare copie esterne separate di PostgreSQL e SQLite
   prima del gate clienti. Il runtime Run dichiara ancora backup non configurato.

`/healthz` è intenzionalmente una liveness minimale: può rispondere 200 mentre
login/API falliscono per proxy o dipendenze. Non ampliarla automaticamente con
chiamate Auth/PG: la verifica funzionale va mantenuta separata.
La pausa Run conserva il volume, che continua a costare; rinominarlo può
distruggerlo. Restano da misurare costo completo e tempi reali dell'ingress.

## Fonti e review

Review indipendente in sola lettura, finding ricontrollati nelle dipendenze:
nessun nuovo difetto runtime dimostrato; confermati i gate operativi sopra.

- [Nhost networking](https://docs.nhost.io/products/run/networking): rete privata
  dello stack e pubblicazione della porta HTTP come azione distinta.
- [Nhost health checks](https://docs.nhost.io/products/run/health-checks):
  `/healthz`, 200 entro cinque secondi, riavvio dopo tre fallimenti.
- [Nhost risorse](https://docs.nhost.io/products/run/resources): persistenza,
  pausa e conseguenze della rinomina del volume.
- [Nhost estensioni](https://docs.nhost.io/products/database/extensions):
  membership nhost_hasura/postgres, distinta dai ruoli runtime minimi.
- [PostgreSQL 18, pg_has_role](https://www.postgresql.org/docs/18/functions-info.html):
  SET indica la possibilità di assumere il ruolo, senza assumerlo nella query.
- [PostgreSQL 18, pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html):
  un client di major precedente non può esportare un server più recente.

La compatibilità locale 18.6 è stata verificata nel gate descritto sotto.
Le operazioni remote che configurano segreti, permessi, volume o accesso pubblico
richiedono approvazione distinta: la creazione preliminare fermata non le copre.

## Incremento locale per PostgreSQL 18

Il launcher accetta ora `AMR_TEST_POSTGRES_VERSIONE=18`; il default 16 resta
invariato. L'immagine 18.6-bookworm è fissata al digest dell'indice ufficiale
`sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`.
La CLI ha confermato il manifest amd64
`sha256:9e73daeb439141c2b11eea2463f5f1a3b269fd90d897b41cddb7cb440f21aa5d`,
coincidente con i metadati pubblicati da Docker Library.

Per 18 la fixture monta tmpfs su `/var/lib/postgresql`, perché l'immagine usa
`/var/lib/postgresql/18/docker`. Il restore riusa il tmpfs della stessa compose,
invece di mantenere il vecchio percorso 16. Il launcher verifica versione e
data_directory dal server, prima delle migrazioni e dentro il cleanup protetto.
Valori del selettore diversi da 16/18 vengono respinti prima di creare risorse.

Controprova nuova: sul sorgente precedente, chiedere il profilo 18 restituiva
ancora la fixture 16; sul nuovo la configurazione rispetta immagine, mount e
pubblicazione solo loopback. Test pertinenti **66/66 pass**, zero skip,
dotenv disabilitato e directory temporanee. Il mock del test listen è stato
aggiornato alla nuova lettura metadata: il test continua a raggiungere davvero
l'errore listen e a verificare cleanup e rimozione dei listener.

Review indipendente del diff, inclusa la propagazione al restore: nessun nuovo
finding bloccante confermato. Questo è un collaudo della configurazione;
la prova integrata 18.6/backup non va dedotta dai test unitari o dal digest.
Evidenze: `/private/tmp/amr-staging-pg18-regression-before-20261004.log`,
`/private/tmp/amr-staging-pg18-final-unit-20261004.log`,
`/private/tmp/amr-staging-pg18-manifest-20261004.json`.

Fonti aggiuntive:
[immagine PostgreSQL ufficiale](https://hub.docker.com/_/postgres) e
[metadati 18.6-bookworm](https://github.com/docker-library/repo-info/blob/master/repos/postgres/remote/18.6-bookworm.md).

### Esito integrato 18.6, immagine e restic

Eseguito con dotenv disabilitato, ambiente esplicito, directory temporanee,
`AMR_TEST_POSTGRES_VERSIONE=18`, immagine `amr-centro:staging-9ed5479` e restic
0.19.1. **Exit 0, cleanup verificato**. Versione effettiva osservata dal server:
`18.6 (Debian 18.6-1.pgdg12+2)`.

Verificati schema e ruoli, login/email/MFA, quote sotto contesa, appartenenza,
revoche e scadenza, rinnovo idempotente, ricerca sintetica e autorizzazione alla
consegna. L'immagine corrisponde al manifest del commit candidato; SIGTERM,
riavvio con volume persistente e invalidazione delle vecchie sessioni passano.

Il collaudo restic ha creato due repository locali separati, ripristinato il
dump PostgreSQL in un secondo cluster 18.6 temporaneo e verificato replay
ordinato/idempotente, revoca prevalente sui journal vecchi, accessi invalidati
e permessi. Gli strumenti pg_dump/pg_restore provengono dalla stessa immagine
18.6. Non è un backup dello staging Nhost: la fixture usa il ruolo postgres
per il dump e repository locali, non il futuro login backup minimo e uno
storage esterno. Il backup esterno di SQLite non è attestato da questo giro.

Verifica Docker finale: gli otto container manuali e le loro due reti rimangono
presenti; nessun container/rete/volume Compose del collaudo automatico residuo.
Evidenza: `/private/tmp/amr-staging-pg18-image-restic-gate-20261004.log`.

Le modifiche al launcher, alla fixture restore, ai test e questo registro
restano non committate. Nessuna modifica al runtime applicativo. Il prossimo
gate remoto richiede ancora versione Auth, migrazioni e login minimi, digest
registry, segreti, volume/ingress, arresto/rollback e backup esterni. Non sono
stati applicati né autorizzati implicitamente dal PASS locale.
