# Staging Nhost del centro — 2 ottobre 2026

## Perimetro e stato

Il proprietario ha scelto di **attivare uno staging Nhost separato**. Questa
autorizzazione non riguarda produzione, M2, portali reali o invii ai clienti.
Il primo servizio serve il prototipo, Auth e autorizzazioni commerciali;
il frontend AMR completo rimane il successivo lavoro coordinato con APP.

Il proprietario ha completato il login e attivato autonomamente il piano Pro.
La console verificata il 2 ottobre mostra l'organizzazione `AMR` sul piano Pro
e un solo progetto `AMR`, appena creato a Frankfurt (`eu-central-1`), con zero
utenti/richieste e nessun deploy. Il proprietario ha scelto esplicitamente di
**usare questo progetto come staging**, evitando un secondo progetto attivo.
Il **servizio preliminare Run è stato creato il 3 ottobre**, dopo la conferma
esplicita del proprietario; ha zero repliche e non esegue il centro. Le metriche
della console non provano che il DB sia vuoto: prima delle migrazioni va
controllata l'assenza di dati e integrazioni da preservare.

Il dashboard Billing mostra Pro a **25 USD/mese** e una stima della prossima
fattura di **30,50 USD**. Il dettaglio mostra 25 USD di canone e zero addebiti
compute/egress/add-on; non spiega nella vista consultata la differenza fra
canone e totale. Non è una misura del futuro costo del centro Run. Il listino
e la documentazione ufficiali indicano crediti compute condivisi per 15 USD,
circa 15 USD/mese di compute base per ogni progetto aggiuntivo e addebiti Run
secondo le risorse. Un avviso di spesa non equivale a un tetto automatico.

Il proprietario riferisce inoltre l'acquisto di `automotoradar.it` su GoDaddy
e un piano Netlify da 20 EUR/mese. DNS, fatture GoDaddy/Netlify e hosting
esistenti non sono stati verificati né modificati. La configurazione concordata
resta un servizio Run con frontend e backend insieme; separare il frontend su
Netlify richiede una decisione distinta e verifiche di origine/cookie/sessione.

### Preparazione remota del 2–3 ottobre

Prima della creazione, la vista Run mostrava **nessun servizio**. Nel form sono stati
verificati `amr-centro-staging`, registry Nhost e zero repliche. Con risorse
candidate **0,5 vCPU / 1024 MiB**, la stima del form è **25 USD/mese con una
replica**, **0 USD di compute con zero repliche**. La replica a uno è stata
solo selezionata nel form per leggere il preventivo e riportata a zero, senza
avvio. Nessun volume, porta o segreto è stato creato in questa preparazione.

Un primo invio del form con immagine vuota non ha prodotto un servizio
visibile; la causa non è dimostrata. Un successivo invio, con tag esplicito,
è stato **rifiutato dalla revisione automatica**: configurazione ancora priva
di segreti, porta, volume e health check, immagine non verificata. Non è stato
ritentato con un altro canale.

La [guida ufficiale del registry](https://docs.nhost.io/products/run/registry)
prevede di creare prima il servizio a zero repliche con registry Nhost e
immagine vuota: il percorso privato è generato alla creazione, poi si carica
l'immagine e si completa la configurazione. Questa è una fase preliminare,
non un deploy funzionante. Il proprietario ha poi autorizzato specificamente
questa sola creazione ferma, senza porte, volumi o segreti; l'avvio, il costo
Run effettivo e la pubblicazione rimangono controlli successivi. La
configurazione completa in TOML resta il candidato del servizio prima dell'avvio.

### Servizio preliminare verificato il 3 ottobre

Creato **un solo** servizio `amr-centro-staging`, ID
`40f9c208-5e1b-49ac-afcd-54e56d70de8b`. Dopo l'invio del form è stata confermata
la schermata `Confirm Resources`: zero repliche, 0,062 vCPU / 128 MiB e
stima compute **0 USD/mese**. La vista Run mostra un servizio; la sua
configurazione salvata, riaperta tramite `View Service`, conferma:

- registry Nhost generato:
  `registry.eu-central-1.nhost.run/40f9c208-5e1b-49ac-afcd-54e56d70de8b`;
- zero repliche, autoscaler disattivato;
- nessuna porta, volume o variabile aggiunti; health check non attivato;
- nessuna immagine caricata da questa lavorazione, nessun digest remoto
  ancora verificato e nessun aggiornamento successivo inviato.

CPU/RAM minime sono soltanto il valore preliminare del servizio fermo, non il
dimensionamento del centro. Il candidato completo resta 0,5 vCPU / 1024 MiB,
con il preventivo di 25 USD/mese sopra verificato. Lo staging applicativo non
è ancora avviato né collaudato nel cloud; nessun accesso M2 o ai portali.

Il proprietario ha chiesto se eliminare in futuro lo staging dopo aver creato
la produzione e quale utilità avrebbe conservarli entrambi. La raccomandazione
è mantenere un ambiente di collaudo separato, eventualmente in pausa fra prove,
per aggiornamenti, Auth/MFA, autorizzazioni, migrazioni e restore. È una proposta:
non autorizza un secondo progetto, cancellazioni o costi aggiuntivi. Migrazioni,
configurazione e artefatti collaudati sono riutilizzabili; account di prova,
credenziali e stato operativo non vanno promossi implicitamente in produzione.

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

1. **Progetto isolato.** Usare il progetto `AMR` a Frankfurt come staging,
   secondo la scelta del proprietario. Verificare preventivo delle risorse Run
   prima di avviarle. Usare l'indirizzo Nhost; nessuna integrazione GitHub con
   deploy automatici e nessun cambio al servizio M2 o a un ambiente clienti.
2. **Artefatto.** Preparare i soli blob del commit approvato con
   `scripts/prepara-contesto-centro.js`, costruire e collaudare l'immagine.
   Pubblicare nel registry privato e fissare `AMR_RUN_IMAGE` al digest remoto
   verificato: un tag modificabile o l'ID Docker locale non sono quel digest.
3. **Database e Auth.** Verificare versione/permessi del PostgreSQL Nhost;
   applicare in ordine accessi, aziende, rinnovi, patch DateStyle, colleghi e
   backup. I tre login devono ricevere soltanto i rispettivi ruoli ristretti.
   Su un DB esistente con la vecchia funzione inviti, applicare anche
   `backend/nodi/schema-inviti-consegna.sql` dopo aziende; la nuova installazione
   ha già la stessa definizione. Verificare un invito pending, accettato e
   scaduto senza copiare account dal collaudo locale.
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

### Incremento di recovery prima del candidato successivo

B01 della review è affrontato nel [registro della numerazione journal](ripristino-journal-sequenza.md).
Prima di riaprire un database ripristinato, applicare dal manifest fidato la
migrazione `backend/nodi/schema-ripristino-sequenza.sql` dopo `pg_restore`,
quindi eseguire la finalizzazione offline. Un dump storico può contenere la
vecchia funzione. La prova locale del nuovo incremento non aggiorna l'immagine
`646fcbe`, non applica migrazioni Nhost e non avvia il servizio Run fermo.

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

## Candidato locale aggiornato — 3 ottobre 2026

Le [correzioni successive alla review](correzioni-nodi-2026-10-03.md) sono
state implementate, sottoposte a review indipendente e verificate. Nuovo
artefatto locale `amr-centro:staging-a05d45a`, release
`a05d45a61e659bb8d7a3fe93fadcc53d08d2cdab`; il registro riporta ID Docker,
impronte e rapporto con i commit successivi di soli test/documenti.

Suite completa: 1.279 pass, zero failure, quattro gate opt-in separati.
Restic reale 39/39, backup PostgreSQL/Auth/restic 6/6; il gate completo del
container con Auth/PostgreSQL locali è passato, incluse HTTPS, MFA, permessi,
ricerca sintetica e riavvio. Un primo giro si era fermato prima dell'immagine
nella prova concorrente dei colleghi: causa non dimostrata, limiti non
allargati. Il confronto e l'incertezza rimangono nel registro.

Questo incremento non ha modificato la console o configurazione remota,
caricato un'immagine, creato segreti/volumi o avviato Run. Lo stato remoto
riportato nelle sezioni precedenti resta l'ultima osservazione della console,
non una nuova verifica. Per il collegamento, centro e worker devono ricevere
il medesimo manifest. Occorre ancora completare i gate di attivazione sopra,
con autorizzazione della configurazione e dell'avvio effettivi.

## Pacchetto preparato e nuova review — 3 ottobre 2026

Il [pacchetto locale](staging-pacchetto-2026-10-03.md) registra il contesto
`fc1b7f2`, le impronte delle migrazioni, i ruoli runtime e le controprove CLI.
Run/configurazione/compatibilità/HTTPS passano 54/54. Configurazione positiva
accettata; campo sconosciuto, CPU errata e segreto mancante rifiutati.
Non è stata creata una nuova immagine né aggiornato il servizio remoto.

La nuova review ha riprodotto un conflitto di recovery non coperto dal gate
precedente: dump con invito pending, accettazione post-dump e replay fallito.
È verificato su PostgreSQL 16 per referente e collega. La proposta era in
discussione in questa fase; l'approvazione e la chiusura sono registrate sotto.
La prova precedente superata non dimostrava copertura di questo scenario.

## Chiusura della review e recovery — 4 ottobre 2026

Il proprietario ha scelto il replay completo ordinato e la conclusione dei
comandi commerciali già ammessi prima del logout, negando quelli nuovi.
La [review del branch](branch-nodi-2026-10-03-fc1b7f2.md) distingue quest'ultima
policy dai quattro difetti confermati e corretti: retry/affinità (`8379b87`),
inviti pending e UUID invito nel recovery (`024af78`).

Suite finale locale: 1.298 test, 1.293 pass, zero failure, cinque skip opt-in.
Recovery PG16 con dump/inviti 1/1 e gate Auth/PostgreSQL/restic 6/6 eseguiti
separatamente e passati; review indipendente senza ulteriori finding confermati.
Il [registro recovery](ripristino-inviti-2026-10-04.md) documenta atomicità per
journal, idempotenza, stop al primo errore e limiti sulla completezza delle copie.

L'immagine `a05d45a` e il contesto `fc1b7f2` sono ora evidenze storiche: non
contengono questi fix runtime. Prima dell'upload serve rigenerare e collaudare
l'immagine dal commit candidato scelto. Nessun servizio remoto è stato
modificato o avviato. Backup su storage reale, proxy/volume, SMTP, ingress,
carico e integrazione completa APP restano gate da chiudere prima dei clienti.

## Immagine aggiornata e gate locale — 4 ottobre 2026

Costruita `amr-centro:staging-468b79c` dai blob del commit, con manifest e
impronte aggiornati; il [registro dell'immagine](staging-immagine-2026-10-04.md)
riporta ID Docker, prove, correzioni degli strumenti e limiti.
Gate reale locale HTTPS/Auth/PostgreSQL/worker simulato **passato con exit 0**;
65/65 test pertinenti, zero skip. Verificati riavvio sullo stesso volume e cleanup.

La review ha corretto due difetti del collaudo: immagine non vincolata al
candidato atteso e cleanup fallito non necessariamente segnalato come failure.
Un primo giro si è fermato prima dell'immagine nella fixture delle quote;
il giro diagnostico è passato senza modificare quote o timeout. La causa
del primo fallimento resta non dimostrata, non dichiarata risolta.

Le correzioni degli strumenti restano non committate. Prima di un upload
rigenerare l'artefatto dal prossimo commit che le includerà. Nessun upload,
segreto, volume o avvio Run remoto effettuato; M2 e portali esclusi.
## Aggiornamento 4 ottobre: candidato committato e inventario remoto

Il gate dell'immagine del commit `9ed5479` è passato con manifest atteso e
cleanup reale. Inventario Nhost effettuato in sola lettura: servizio ancora
fermo senza immagine/porte/volumi; PostgreSQL remoto 18.6, nessuno schema o
ruolo AMR cercato. Il gate storico usa PostgreSQL 16: non estenderne il PASS
alla versione remota. Il ruolo editor può assumere postgres; nessun ruolo è
stato assunto o modificato.

Dettagli, controprove e prossimo gate nel
[registro di inventario](staging-inventario-2026-10-04.md), incluse le modifiche
al solo collaudo locale per il profilo 18. Restano separate l'autorizzazione
preliminare a zero repliche e l'autorizzazione al pacchetto cloud completo.

Il gate aggiuntivo PostgreSQL **18.6** è poi passato con l'immagine `9ed5479`
e restic reale: dump, restore in secondo cluster e replay dei journal, exit 0
e cleanup verificato. Il default locale 16 resta disponibile; la fixture 18
usa il mount corretto anche nel restore. Test pertinenti 66/66, review
indipendente senza nuovi finding bloccanti. Prove e limiti nel registro sopra:
repository restic locali, nessun backup esterno o mutazione Nhost, nessun M2.
L'incremento degli strumenti 18 e i nuovi documenti restano non committati.

## Pacchetto SQL locale — 4 ottobre, incremento successivo

Profilo 18 e inventario committati in `cba704d`. Preparato il
[pacchetto di installazione](staging-schema-2026-10-04.md): otto definizioni da
HEAD in una transazione, preflight e tre runtime NOLOGIN. Il collaudo prova
il percorso installatore senza CREATEROLE → SET LOCAL ROLE, rollback e ACL,
vincolando le impronte del checkout a quelle del candidato prima del primo SQL.
Nessuna migrazione remota; password/LOGIN e configurazione Run restano separate.

## Preparazione del controllo ingress — 4 ottobre, dopo la review finale

La [review finale del candidato](branch-nodi-2026-10-04-finale.md) ha chiuso il
gate locale `b1d9d6d`, incluso PG18/Auth/MFA/HTTPS/restic. Il
[nuovo controllo ingress](staging-ingress-2026-10-04.md) riusa quel percorso
per una CLI anonima, senza modificare il runtime o il TOML Run.

Il test esterno non può conoscere il peer del socket visto dal container.
Il gate remoto resta aperto: prima dell'avvio dell'app occorre concordare una
misura lato server o un contratto equivalente del provider, senza indovinare
gli IP attendibili. Nessun upload, migrazione, segreto, volume o avvio Nhost,
M2 o chiamata ai portali in questo incremento. Il nuovo script cambia
l'inventario del manifest: prima di un futuro upload rigenerare l'artefatto
dal candidato approvato, senza promuovere implicitamente la vecchia immagine.

Il nuovo candidato **`7b7d881`** è stato poi costruito e collaudato localmente:
1.338 test passati, zero failure, cinque skip opt-in; gate immagine reale con
PG18/Auth/MFA/HTTPS/restart/restic **PASS, exit 0 e cleanup verificato**.
Il [registro ingress](staging-ingress-2026-10-04.md) riporta impronte e
controprove. Nessuna mutazione remota: il gate Nhost peer/header/tempi rimane
aperto e richiede la scelta della misura lato server prima dell'app reale.

## Preparazione della sonda lato server — 4 ottobre, incremento successivo

Preparata una [sonda isolata](sonda-proxy-staging-2026-10-04.md) senza import
AMR, Auth/DB, storage o scraper e con template Run separato ancora fermo e
non pubblico. Misura peer privati/header solo nei log filtrati e risponde
senza esporli; client HTTPS senza credenziali, retry o redirect. Controprove
anche su header anticipati e attese effettive 55/65 secondi (PASS locale).
Il comando alternativo è documentato e validato dalla CLI ufficiale.
Nessun upload/avvio remoto: questo chiude la preparazione della misura,
non il gate ingress Nhost o il deploy ai clienti. Il registro distingue
stato del prototipo/centro, gate dell'app commerciale e verifiche remote.

Incremento committato in `bc4444e`: 1.347 test passati, zero failure, sei skip
opt-in; attese 55/65 s eseguite separatamente (1/1 PASS). Review indipendente
9/9 e controprove, due imprecisioni documentali corrette. Immagine locale
dallo stesso commit: entrypoint della sonda PASS con UID 1000/Node 24.21.0,
SIGTERM exit 0 e cleanup verificato. Non è il gate Auth/DB completo né una
prova dell'ingress Nhost. Nessuna mutazione remota o M2.

## Staging avviato — 5 ottobre 2026

I gate successivi e lo stato cloud effettivo sono nel
[registro della diagnosi e dello staging](staging-diagnosi-pg-2026-10-05.md),
sezione finale. Il centro e il frontend sono ora pubblicati su Run dal
candidato `66e2b24`; Auth/PG configurati, volume preparato separatamente e
AMR UID 1000. Gate anonimo 13/13 PASS e collegamento dell'iMac simulato
verificato. I precedenti paragrafi «nessuna mutazione remota» descrivono
i rispettivi incrementi storici, non questo stato finale.

Login e navigazione manuali restano da collaudare; non è una promozione ai
clienti né la verifica delle ricerche live. M2 escluso, backup esterno e
stabilità del proxy ancora gate separati.
