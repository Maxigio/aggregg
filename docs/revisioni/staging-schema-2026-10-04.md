# Staging: pacchetto SQL e ruoli — 4 ottobre 2026

## Perimetro

Primo commit richiesto: `cba704d`, profilo PostgreSQL 18 e inventario remoto.
Questo incremento prepara e collauda **localmente** la prima installazione
degli schemi AMR. Nessuna migrazione Nhost, credenziale cloud, upload, avvio Run,
M2 o richiesta ai portali. I file della chat APP rimangono invariati.

## Implementazione e motivazione

`scripts/nhost/prepara-schema-staging.js` legge gli otto SQL del pacchetto
precedente da un solo commit HEAD e produce SQL su stdout, con release e
impronte SHA-256. Non apre connessioni. Non duplica le definizioni né introduce
un framework di migrazione. Un artefatto da un commit diverso va rigenerato.

Gli script fidati hanno wrapper BEGIN/COMMIT espliciti: il generatore verifica
il loro numero, li rimuove e mantiene inalterate tutte le definizioni all'interno
di una sola transazione. Questo controllo riguarda gli otto file concordati,
non è un parser generale o una sandbox per SQL arbitrario. Una modifica alle
migrazioni richiede una nuova review e la ripetizione del gate.

La transazione assume `postgres` con **SET LOCAL ROLE**, limita le attese e
rifiuta versioni diverse da PostgreSQL 18, ruoli AMR preesistenti, schemi
accessi/backup/recovery esistenti e un contratto Auth diverso dai quattro tipi
osservati (UUID, public.citext, due boolean), con refresh_tokens presente.
Non è una migrazione incrementale: non usarla su un DB già installato.

Prepara `amr_gateway`, `amr_commerciale`, `amr_copie` senza LOGIN/password e
senza superuser, creazione ruoli/database, replica o bypass RLS. Ricevono
soltanto i gruppi già previsti, con INHERIT e senza SET a quei gruppi.
Password e attivazione LOGIN rimangono un'operazione separata, non autorizzata
implicitamente. Il processo web non deve usare l'identità dell'installatore.

## Prove e controprove

`scripts/collauda-schema-staging-locale.js` è richiamato dal profilo 18 del
launcher esistente. La fixture usa un installatore sintetico senza CREATEROLE
e con la sola possibilità di SET a postgres. Il profilo 16 conserva il percorso
precedente. I segreti della fixture sono casuali e temporanei.

- Creazione ruolo senza SET: 42501; il pacchetto dopo SET LOCAL riesce.
- Errore prima del COMMIT finale: nessuno schema/ruolo AMR residuo.
- Schema AMR già presente: rifiuto, nessun nuovo ruolo; non viene eliminato
  dal pacchetto. Soltanto la fixture elimina lo schema vuoto che ha creato.
- Dopo COMMIT l'identità corrente torna all'installatore.
- Tutti e tre i runtime sono inizialmente NOLOGIN; letture dirette Auth,
  persone e outbox, CREATE e SET ai ruoli privilegiati sono negati.
- Le funzioni per lettore, writer e backup sono accessibili ai rispettivi
  gruppi; nessuna funzione AMR ha EXECUTE PUBLIC.
- La fixture abilita LOGIN soltanto con password sintetiche per proseguire
  il gate Auth, aziende e backup esistente.

La review indipendente ha rilevato una lacuna reale nel collaudo iniziale:
SQL dal checkout e pacchetto da HEAD non erano vincolati alla stessa versione.
Corretto: impronte confrontate **prima del primo comando SQL**, release reale.
Controprova con checkout alterato: rifiuto e zero chiamate al database.
Review finale: finding chiuso, nessun altro difetto verificato nell'incremento.

Test mirati finali **18/18**, zero skip, Node 24.21.0 e dotenv disabilitato.
Entrambi i gate integrati PG18/Auth/restic passati, exit 0 e cleanup verificato,
compresa la ripetizione dopo la guardia di provenienza. Suite generale durante
l'incremento: 1.303 test, 1.298 pass, zero failure e cinque skip opt-in; il terzo
test sulla guardia aggiunto successivamente è incluso nei 18/18 mirati finali.
Log: `/private/tmp/amr-schema-unit2-20261004.log`,
`/private/tmp/amr-schema-pg18-restic-20261004.log`,
`/private/tmp/amr-schema-final-pg18-restic-20261004.log`.

Artefatto locale da `cba704d`:
`/private/tmp/amr-schema-staging-cba704d-20261004.sql`, 78.320 byte,
SHA-256 `4ade64bd9916360c74c93552d21297da6e8003a58b9cc0fec0b5c8f5fd8e2c8c`.
È rigenerabile; non è stato applicato al cloud. Gli otto SQL sono invariati.

## Limiti e prossimo gate

Auth locale è 0.49.1; quattro colonne compatibili non dimostrano l'intera
versione/configurazione del provider remoto. Né il ruolo sintetico riproduce
ogni policy del provider. La fixture prova i privilegi SQL effettivi del nostro
pacchetto, non l'ingress, SMTP o le connessioni cloud.

La copia restic usa repository locali e dump come postgres; il login backup
minimo per esportare il DB remoto e il backup esterno SQLite restano aperti.
Prima del cloud occorrono anche digest registry, volume UID 1000, peer/header
ingress e prova arresto/rollback. Nessuna replica o healthz risolve questi gate.
L'immagine `9ed5479` resta la prova storica del relativo commit: il nuovo
pacchetto non la trasforma in un'immagine di HEAD.

## Fonti ufficiali

- [Nhost estensioni](https://docs.nhost.io/products/database/extensions):
  percorso SET ROLE postgres e separazione dai login runtime.
- [PostgreSQL SET ROLE](https://www.postgresql.org/docs/18/sql-set-role.html)
  e [GRANT](https://www.postgresql.org/docs/18/sql-grant.html): LOCAL,
  membership INHERIT/SET e controllo dei privilegi effettivi.
- [PostgreSQL privilegi](https://www.postgresql.org/docs/18/ddl-priv.html):
  REVOKE nella stessa transazione di creazione, evitando finestre PUBLIC.
- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  default deny, privilegi minimi e prove delle autorizzazioni.
