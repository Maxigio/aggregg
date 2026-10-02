# Staging Nhost del centro — 2 ottobre 2026

## Perimetro e stato

Il proprietario ha scelto di **attivare uno staging Nhost separato**. Questa
autorizzazione non riguarda produzione, M2, portali reali o invii ai clienti.
Il primo servizio serve il prototipo, Auth e autorizzazioni commerciali;
il frontend AMR completo rimane il successivo lavoro coordinato con APP.

La console disponibile è alla pagina di login. È stato chiesto al proprietario
di accedere senza comunicare credenziali in chat. **Progetto e servizio remoto
non ancora creati**; nessuna spesa attivata da questa lavorazione.

Baseline committata: `646fcbe6eb576f354de8dd675c30d330dc8941c9`.
La [configurazione Run](../../scripts/nhost/centro-staging.toml) è inizialmente
ferma (`replicas=0`) e non pubblicata (`publish=false`). Non è un comando di
deploy e non contiene segreti o riferimenti al database dell'M2.

## Prove della configurazione

CLI ufficiale Nhost **1.51.2**, scaricata dalla release `cli@1.51.2` e verificata
contro il checksum pubblico SHA-256 dell'archivio macOS amd64:
`76a0f085a2dfc4e682a1a8966bdde99f2e5c92258e5626167b77646b72f7b9d9`.
Binario solo temporaneo; nessuna installazione globale o modifica a dipendenze.

`nhost run config-validate` eseguito in una cartella nuova, con `.secrets`
sintetico, root e directory CLI esplicite, ambiente dedicato, senza `service-id`
né overlay remoto. Non è stato avviato il config server della CLI.

| Controprova | Esito |
| --- | --- |
| Configurazione ferma e privata | Accettata |
| Stessa configurazione con una replica e porta pubblicata | Accettata |
| Campo sconosciuto | Rifiutata |
| CPU non valida | Rifiutata |
| Segreto richiesto mancante | Rifiutata |
| Variabili risolte inviate a `config-centro-run.configura` | Accettate: deadline 60 s, limiti 2/60, tre ruoli distinti |

Immagine costruita dai blob del **commit reale `646fcbe`**, senza fixture Git
intermedia: tag locale `amr-centro:staging-646fcbe`, ID Docker
`sha256:88cc599c8c8947c95f29e601c4547fc358a63cbc5d9677cfd8be41a7c9715a49`,
Linux amd64, 116.614.464 byte. Il gate con Auth/PostgreSQL della fixture ha
completato login/MFA, permessi distinti, ricerca Moto sintetica, SIGTERM con
uscita 0 e riavvio con sospensione e revoca persistite; i vecchi cookie sono
rifiutati. Nessuna ricerca ai portali. La sonda non è stata usata come prova
di funzionamento del login. Questo ID locale non è ancora un digest del registry
Nhost e non attesta l'esecuzione cloud.

Evidenze temporanee: `/private/tmp/amr-staging-image-gate.log` e
`/private/tmp/amr-staging-config-info.json`. Il primo non contiene credenziali;
il secondo contiene soltanto esiti e percorsi delle fixture sintetiche.

La coppia candidata **500 millicpu / 1024 MiB** è accettata dal validatore,
non dimostra capacità per 60 richieste pendenti. Prima di avviare il servizio
vanno verificati il preventivo del dashboard e il tipo di compute applicato.
Il canone Pro, i crediti condivisi fra progetti, compute Run, volume ed egress
vanno conteggiati separatamente; non si riutilizzano i crediti già consumati dal
progetto base. Nessun tetto di spesa automatico viene presunto.

Il volume `amr-centro-dati`, 1 GiB, ha percorso stabile `/var/lib/amr`.
Non rinominarlo né ridurne la capacità durante gli aggiornamenti. Il file
mantiene `AMR_CENTRO_REPLICHE=1` anche durante la pausa: è il vincolo del
processo, distinto dal numero di processi che Run deve avviare.

## Attivazione, un gate alla volta

1. **Progetto isolato.** Dopo il login, verificare organizzazione, piano,
   regione, preventivo e progetto di staging. Usare l'indirizzo Nhost; nessuna
   integrazione GitHub con deploy automatici. Non cambiare il progetto esistente.
2. **Artefatto.** Preparare i soli blob del commit approvato con
   `scripts/prepara-contesto-centro.js`, costruire e collaudare l'immagine.
   Pubblicare nel registry privato e fissare `AMR_RUN_IMAGE` al digest remoto
   verificato: un tag modificabile o l'ID Docker locale non sono quel digest.
3. **Database e Auth.** Verificare versione/permessi del PostgreSQL Nhost;
   applicare in ordine accessi, aziende, rinnovi, patch DateStyle, colleghi e
   backup. I tre login devono ricevere soltanto i rispettivi ruoli ristretti.
   Verificare signup, email, MFA Admin, scadenza, quote e revoca. Non tracciare
   le tabelle applicative in GraphQL con accessi non equivalenti. Non copiare
   account, password, cookie o dump dal collaudo manuale locale.
4. **Volume.** Verificare che il volume montato sia scrivibile come UID 1000.
   I permessi del percorso nell'immagine non attestano quelli del mount remoto.
   Se la verifica fallisce, fermarsi; non passare il processo a root.
5. **Ingress.** Misurare il peer effettivo e gli header sovrascritti dal proxy
   prima di impostare gli IP attendibili. Non fidarsi di tutti i proxy o del
   solo `X-Forwarded-Proto` ricevuto da Internet. Provare cookie, origini
   estranee, header falsificati, richiesta ritardata entro 60 s e oltre deadline.
   La pubblicazione iniziale è limitata allo staging, senza nodi live o clienti.
6. **Percorso completo simulato.** Collegare un worker di staging sull'iMac
   con manifest e chiave propri, inizialmente con risposte simulate. Provare
   aziende Auto/Moto, pagina successiva, retry della sola porzione fallita, 429,
   disconnessione, risultato tardivo e riavvio. Non collegare M2 implicitamente.
7. **Backup.** Il runtime corrente mostra intenzionalmente backup non
   configurato. Collegare due repository cifrati separati e collaudare restore
   fuori dal DB vivo prima dei clienti. Il backup PG Nhost non copre lo SQLite
   del volume Run: sospensioni e fingerprint revocati richiedono una copia e
   una prova dedicate, o una migrazione deliberata. Non dichiarare il gate
   backup concluso sulla base del solo mount persistente.

## Aggiornamento e rollback con manutenzione

Un solo scheduler è un requisito: `replicas=1` non è un lock fra due processi.
La documentazione consultata non garantisce assenza di sovrapposizione durante
un aggiornamento. Non usare un rolling update non verificato.

1. Registrare commit/digest, configurazione non sensibile e identità del volume
   della versione corrente. Verificare prima il candidato e le copie ripristinabili.
2. Impostare **repliche a zero mantenendo il volume**. Attendere conferma Run
   dell'arresto del vecchio processo; `/healthz` da solo non prova l'arresto.
   Non avviare il candidato finché rimane un dubbio sull'istanza precedente.
3. Cambiare immagine/configurazione mentre il servizio è fermo. Le migrazioni
   richiedono compatibilità con il rollback verificata separatamente: tornare
   alla vecchia immagine non annulla una migrazione distruttiva.
4. Avviare una sola replica; controllare digest, volume, Auth/MFA, permessi,
   compatibilità dei nodi e ricerche simulate. Il solo 200 della sonda non basta.
5. In caso di errore, riportare prima a zero e verificarne l'arresto; ripristinare
   digest/configurazione precedente sullo stesso volume e ripetere i controlli.
   Fermarsi se schema o stato non sono compatibili, senza riabilitare credenziali
   revocate o ripetere automaticamente lavori dall'esito incerto.

Sessioni e coda sono in RAM: l'aggiornamento richiede nuovo login, perde la coda
e non ripete i lavori precedenti. Informare chi usa lo staging prima della
manutenzione. Fermare Run conserva il volume ma non elimina i costi storage.
Questa procedura deve ancora essere provata sul provider prima del gate clienti.

## Fonti e limiti

- [Configurazione Run](https://docs.nhost.io/products/run/configuration) e
  [segreti](https://docs.nhost.io/platform/cloud/secrets): TOML e riferimenti ai segreti.
- [Reference delle unità](https://docs.nhost.io/reference/configuration#computeresources)
  e [risorse Run](https://docs.nhost.io/products/run/resources): compute, mount e pausa.
- [Health checks](https://docs.nhost.io/products/run/health-checks): liveness entro
  cinque secondi, non verifica di Auth/DB.
- [Networking](https://docs.nhost.io/products/run/networking): servizi privati e porta HTTPS;
  nessuna garanzia ricavata sui nostri timeout e IP attendibili.
- [Listino](https://nhost.io/pricing) e [billing](https://docs.nhost.io/platform/cloud/billing):
  preventivo da verificare nel progetto effettivo.
- [Sorgente CLI](https://github.com/nhost/nhost/blob/cli%401.51.2/cli/cmd/run/config_validate.go):
  validazione locale distinta dalla risoluzione dei segreti remoti con service-id.

La validazione TOML non verifica raggiungibilità di Auth/DB, contenuto del
registry, permessi del volume, strategia di rollout o costo. Questi sono gate
remoti ancora aperti, non una certificazione di produzione.
