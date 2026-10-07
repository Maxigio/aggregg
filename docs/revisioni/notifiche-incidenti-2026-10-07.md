# Punto 4 — incidenti e notifiche

Stato corrente: email e push Better Stack scelte per centro, nodi e fonti.
Integrazione locale implementata; configurazione provider e consegna reale
ancora da collaudare. Le sezioni iniziali ricostruiscono le proposte storiche;
le decisioni e le prove più recenti sono in fondo.
Baseline: `3828e89`, branch `feat/nodi-residenziali-prototipo`.
Nessun deploy, collegamento M2, acquisto o invio autorizzato da questo registro.

## Decisioni ricevute il 7 ottobre

- Avviso dopo 30 secondi continuativi di nodo offline. L'esclusione dalle
  assegnazioni mantiene la soglia attuale, senza attendere la notifica.
- Notificare anche stop manuale, sospensione dall'Admin e manutenzione globale.
- Chiudere l'episodio del nodo dopo 15 secondi di heartbeat regolari; una
  ricaduta prima della chiusura resta lo stesso episodio.
- Fonte: resta la riapertura dopo la sonda valida già concordata.
- Preferire un monitor esterno gestito di valore, anche a pagamento, rispetto
  a un osservatore dipendente dall'iMac/hotspot. Provider ancora da scegliere.
- Better Stack interessa all'utente, che chiede prima un debunking approfondito
  di pro, contro e alternative. Questo non autorizza acquisto o integrazione.

Restano valide le decisioni precedenti: WhatsApp/openWA principale, email se
l'invio è fallito o incerto; possibile avviso su entrambi i canali in caso
d'incertezza. Un avviso per episodio, senza promemoria o messaggio al ripristino
automatico. Caduta del nodo: un avviso con le conseguenze sulle fonti, senza
tre nuovi incidenti causati soltanto dalla mancanza di heartbeat. Guasti delle
fonti indipendenti restano distinti. Contatti e segreti sono configurazione
protetta, mai parte di questi documenti.

## Codice e prove della baseline

- `backend/nodi/centro.js`: `statoNodo` usa l'ultimo heartbeat ricevuto e la
  supervisione. La vista non conserva la durata di salute continua necessaria
  per chiudere un episodio dopo 15 secondi. La prima risposta positiva non
  costituisce, da sola, quella prova di stabilità.
- `evento` e le rotte manutenzione/sospensione registrano comandi ripetuti:
  non si può tradurre ogni riga del registro in un nuovo messaggio.
- `backend/fonti-salute.js:fermo`: la scadenza della pausa non prova la
  disponibilità; con le sonde abilitate la fonte resta ferma fino alla verifica.
- `backend/nodi/worker.js`: gli heartbeat trasportano lo stato delle fonti;
  in modalità solo stato ciò non attesta una richiesta riuscita ai portali.
- `/healthz` nel centro remoto è deliberatamente una sonda di processo:
  non interroga PostgreSQL, Auth o portali. Da solo non certifica il servizio.
- Le `notification` PostgreSQL del backup in `centro-run.js` sono segnali
  interni del worker backup, non messaggi WhatsApp/email all'operatore.

Prova locale isolata con Node 24.21.0 e blocco di credenziali/rete esterna:
tre asserzioni passate, ricevuta in
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-notifiche-baseline-xe8iu5b4/esito.txt`.
Il caso verifica cambio online/offline, fonte assente e due POST manutenzione
uguali. Sono evidenze della baseline, non test delle future notifiche.

## Proposta da concordare prima dell'integrazione

1. AMR determina gli episodi dalle transizioni operative validate; mantiene
   un identificatore stabile per episodio e lo stato di invio indipendente
   dalla pulizia dei lavori/eventi. Nessun filtro, annuncio o dato cliente
   viene spedito al monitor esterno.
2. Invio asincrono, fuori dal percorso di ricerca. Stato registrato e invio
   non possono essere trattati come una singola operazione di rete riuscita:
   crash e risposta persa richiedono ricevute e riconciliazione. Un invio
   dall'esito incerto non autorizza un nuovo messaggio WhatsApp alla cieca.
3. Monitor esterno del centro, indipendente da Nhost e dai nodi, con una
   notifica che funzioni anche se centro e bridge WhatsApp sono indisponibili.
   La frequenza del controllo non è una promessa di consegna entro 30 secondi.
4. Riutilizzare le sonde esistenti; il monitor non avvia ricerche ai portali.
   Distinguere processo raggiungibile, dipendenze disponibili e salute per
   fonte/nodo. Non inviare eventi sintetici di fonte durante una disconnessione.
5. Collaudo simulato: soglie 30/15, flapping, comandi ripetuti, riavvio,
   retention, risposte tardive, guasto del registro, consegna incerta e
   fallback. Poi prove reali strettamente autorizzate per ciascun canale.

## Confronto dei servizi, fonti ufficiali

| Candidato | Dato verificato | Valutazione per AMR |
| --- | --- | --- |
| Better Stack | [Listino](https://betterstack.com/pricing): un responder 34 USD/mese mensile oppure 29 USD/mese con pagamento annuale; 10 monitor inclusi, controlli fino a 30 s. | Primo candidato per il centro e gli incidenti. Alert ID non prova integrazione openWA né consegna reale. |
| UptimeRobot | [Listino](https://uptimerobot.com/pricing/): Solo 10 EUR/mese mensile, 60 s; Team 41 EUR/mese mensile oppure 35 EUR/mese annuale, 100 monitor e 30 s. | Solo resta un'alternativa per monitor URL/email se 60 s sono accettabili. Il webhook richiede Team/Scale e ha un solo tentativo, senza avviso di consegna fallita. |
| Checkly Detect | [Listino](https://www.checklyhq.com/pricing/): Starter 24 USD/mese con fatturazione annuale, 60 s; Team 64 USD/mese con fatturazione annuale, 30 s. | Contratto consultato esplicito per firma e retry dei webhook; utile per prove API più estese. Team aumenta il costo, ma non è obbligatorio se bastano 60 s. |
| Uptime Kuma | [Progetto ufficiale](https://github.com/louislam/uptime-kuma): open source MIT, self-hosted, intervalli di 20 s. | Licenza senza canone; hosting, aggiornamenti, backup e canali restano a nostro carico. Sullo stesso iMac o centro condivide il guasto che dovrebbe osservare. |

Fonti aperte il 7 ottobre:

- [Better Stack — prezzi](https://betterstack.com/pricing).
- [Better Stack — frequenza](https://betterstack.com/docs/uptime/check-frequency/).
- [Better Stack — conferma e ripristino](https://betterstack.com/docs/uptime/confirmation-and-recovery-period/).
- [Better Stack — incoming webhook](https://betterstack.com/docs/uptime/incoming-webhooks/):
  Alert ID documentato per evitare duplicati e regole di risoluzione. Non è
  una prova di invio esattamente una volta né di consegna al destinatario.
- [Better Stack — creazione incidente](https://betterstack.com/docs/uptime/api/create-a-new-incident/):
  nel contratto consultato non è documentata una chiave di idempotenza del POST.
  Non usare retry indiscriminati di questo endpoint.
- [UptimeRobot — prezzi](https://uptimerobot.com/pricing/).
- [Checkly — prezzi](https://www.checklyhq.com/pricing/).
- [Google SRE — monitoring](https://sre.google/sre-book/monitoring-distributed-systems/):
  regole comprensibili, avvisi azionabili e controllo del rumore.
- [AWS — transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html):
  registrazione atomica dello stato e del messaggio da consegnare; consumatori
  idempotenti perché possono esserci duplicati. Il pattern non fornisce da solo
  garanzie di consegna del canale finale.

Canone e opzioni sono dati di listino, non un ordine né un preventivo fiscale.
Non abilitare automaticamente chiamate telefoniche, SMS, escalation ripetute,
session replay o acquisizione di log contenenti dati clienti.

## Gate ancora aperti

- Scelta del provider e configurazione concreta di monitor e canali.
- Stato e disponibilità del bridge openWA: il brainstorming descrive un
  esperimento che richiedeva nuovo pairing dopo il riavvio, non un servizio
  di produzione già verificato. Non modificare il CRM per deduzione.
- Tempi e ricevute per distinguere invio accettato, consegna e incertezza.
- Disabilitazione verificata dei messaggi di ripristino e dei promemoria sul
  provider scelto; i default del servizio non equivalgono alle decisioni AMR.
- Frequenza esterna del centro da concordare: i 30 s decisi riguardano il nodo,
  non impongono automaticamente un piano cloud con controlli ogni 30 s.
- Dettaglio delle soglie nodo: origine dei 30 s, gap massimo degli heartbeat
  nei 15 s di recupero e trattamento del riavvio. Proposta: 30 s dall'ultimo
  heartbeat accettato, esclusione operativa ancora a 6 s; recupero nuovo di
  15 s con gap inferiore a 6 s e senza attribuire stabilità al periodo non
  osservato. Questi dettagli non sono ancora una decisione confermata.
- Episodi intenzionali: proposta di mantenerli aperti fino alla rimozione
  confermata di sospensione/manutenzione; stop fino alla ripresa stabile.
  Non applicare il semplice recupero heartbeat a una sospensione ancora
  attiva. Correlare stop confermato e successivo offline prima degli invii.
- Review indipendente eseguita in sola lettura e controverificata sotto;
  implementazione, review del diff e collaudo dei canali ancora da eseguire.

Il punto 4 resta aperto. La console del punto 8, CHECK storico e gate remoto/M2
mantengono l'ordine concordato.

## Debunking Better Stack — 7 ottobre 2026

Verdetto: primo candidato per il monitoraggio esterno del centro. Non basta
per rendere affidabili gli episodi AMR e il canale WhatsApp. La raccomandazione
è condizionata al collaudo delle impostazioni e del percorso di consegna;
non è una prova di superiorità nella disponibilità reale dei provider.

### Vantaggi, prove e controprove

| Affermazione | Evidenza e tentativo di falsificazione | Esito |
| --- | --- | --- |
| Può avvisare anche con il centro AMR fermo. | Il monitor e i canali del provider sono esterni. Il vantaggio scompare se per notificare deve richiamare proprio il centro caduto. Non provata ancora una consegna reale senza AMR. | Capacità documentata; indipendenza della nostra integrazione condizionata. |
| Riduce manutenzione rispetto a un monitor self-hosted. | Gestisce verifiche e incidenti; Kuma richiederebbe un host indipendente e manutenzione nostra. Non elimina la gestione di regole AMR, segreti, ricevute e bridge. | Vantaggio architetturale condizionato, non misura di ore risparmiate. |
| Riduce falsi allarmi di rete. | Il [monitor multi-location](https://betterstack.com/docs/uptime/locations-and-regions/) verifica di default almeno quattro località e richiede fallimenti in almeno tre. Non copre necessariamente un disservizio locale a uno specifico cliente. | Verificato nel contratto; efficacia reale da misurare. |
| Può rispettare l'assenza di messaggi al ripristino. | Le [email in uscita](https://betterstack.com/docs/uptime/integrations/integrating-with-better-uptime/outgoing-emails/) e i webhook consentono la selezione degli eventi. Le impostazioni personali del responder e le escalation vanno controllate separatamente. | Configurabilità verificata; configurazione AMR non provata. |
| Permette episodi identificabili e integrazione protetta. | Incoming webhook con Alert ID; outgoing webhook con Basic Auth o header personalizzati. Non equivalgono a firma HMAC, deduplicazione eterna o consegna esattamente una volta. | Capacità verificata; garanzie più forti non dimostrate. |

### Limiti concreti e correzioni alla proposta

1. **Controlli ogni 30 s non significano messaggio entro 30 s.** Fase della
   schedulazione, timeout, conferma multi-location e invio aggiungono attesa.
   Il periodo di conferma decorre dal guasto osservato. Il recupero di 15 s
   degli heartbeat AMR resta nel centro: un controllo HTTP ogni 30 s non
   dimostra quella continuità. [Conferma e recovery](https://betterstack.com/docs/uptime/confirmation-and-recovery-period/).
   Anche gli heartbeat del provider sono un contratto diverso: l'[API](https://betterstack.com/docs/uptime/api/create-a-hearbeat/)
   dichiara un periodo minimo di 30 s; la risoluzione pubblicizzata di 1 s
   non equivale a un heartbeat ogni secondo. Prima del primo ping lo stato
   resta pending e non rileva una mancata partenza: va verificato l'arming.
   [Comportamento degli heartbeat](https://betterstack.com/docs/uptime/cron-and-heartbeat-monitor/).
2. **`/healthz` verde non significa ricerca funzionante.** Il codice restituisce
   solo la disponibilità HTTP del processo. Non verifica Auth, PostgreSQL,
   assegnazioni o portali. Mantenerlo semplice; usare le evidenze dei lavori,
   sonde esistenti e stati tecnici per gli altri incidenti. Non monitorare
   `/api/search` con chiamate periodiche né cercare annunci da IP cloud.
3. **WhatsApp principale ed email condizionata non sono un'integrazione pronta.**
   Nei contratti consultati non è dimostrato un percorso nativo openWA né
   una decisione sul fallback basata sulla sua ricevuta. Un HTTP 2xx del
   webhook può attestare la presa in carico senza attestare la consegna.
   Se il relay risiede soltanto nel centro, l'avviso di centro caduto fallisce.
   Serve una via esterna che raggiunga il destinatario anche senza AMR; la
   collocazione del relay e la configurazione del fallback restano da scegliere.
4. **Retry e duplicati richiedono un contratto preciso.** L'[incoming webhook](https://betterstack.com/docs/uptime/incoming-webhooks/)
   documenta Alert ID; il POST di creazione incidente non documenta una chiave
   di idempotenza nel contratto consultato. Le pagine degli outgoing webhook
   non chiariscono il comportamento con risposta persa o timeout. Non
   trasferire qui la policy di retry delle sottoscrizioni alle status page:
   sono API differenti. Preferire ID stabili; provare invio ripetuto e ack
   perso prima di abilitare retry automatici.
5. **Default dei webhook e manutenzione possono violare le nostre regole.**
   Il [contratto outgoing](https://betterstack.com/docs/uptime/api/create-outgoing-webhook-integration/)
   include normalmente contenuto della risposta e URL; usare un template
   minimo con episodio, nodo/fonte, codice e orario, senza filtri, annunci,
   clienti o credenziali. Se il comando di manutenzione pausa il monitor,
   può sopprimere proprio l'avviso intenzionale concordato: l'azione Admin
   deve avere una transizione distinta. Chiudere un incidente e notificare
   il ripristino sono due operazioni differenti.
6. **Sicurezza dichiarata non certifica l'integrazione.** Il provider dichiara
   TLS, cifratura a riposo, SOC 2 Type 2 e storage UE predefinito; il report
   di audit non è stato acquisito. Il DPA contempla anche trasferimenti USA
   e subprocessori: non affermare che tutto il trattamento resta soltanto UE.
   [Sicurezza](https://betterstack.com/security), [DPA §7](https://betterstack.com/dpa).
   Usare token di team invece di globali ove sufficiente, segreti separati
   da sessioni/clienti, destinatari protetti e ricevute con deduplica. Le
   regole nel provider non devono poter modificare salute o autorizzazioni AMR.
   [Scope API](https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/).
7. **Il canone responder non copre ogni prodotto opzionale.** Telemetry a
   consumo, AI SRE, personalizzazioni delle status page ed extra sono voci
   distinte. La proposta iniziale usa solo monitoraggio/incidenti, senza
   esportare i log applicativi o attivare session replay. Cambi, imposte e
   checkout effettivo restano da verificare prima dell'ordine.

### Controverifica delle alternative

- **UptimeRobot Team:** controlli 30 s e selezione Down/Up, header di
  autenticazione e API sono documentati. Tuttavia il [webhook](https://help.uptimerobot.com/en/articles/14498593-webhook-integration)
  ha un solo tentativo e non avvisa se fallisce. Il fatto che la dashboard
  abbia l'incidente non prova che openWA lo riceva. Inoltre header oltre i
  limiti documentati vengono scartati tutti: il ricevitore deve negare
  richieste prive di autenticazione. La proposta a pagamento non elimina
  questa debolezza. Solo costa meno e controlla ogni 60 s: resta plausibile
  per URL ed email se questa frequenza è accettabile. I 30 s scelti per il
  nodo non autorizzano a escluderlo automaticamente dal monitor del centro.
- **Checkly Detect Team:** [webhook](https://www.checklyhq.com/docs/integrations/alerts/webhooks/)
  con firma HMAC e fino a cinque retry per status HTTP maggiori di 399,
  distanziati di 20 s. Questo è un vantaggio documentale concreto rispetto
  a garanzie non trovate per Better Stack. Non generalizzarlo a ogni timeout:
  la condizione consultata è quella sugli status. Richiede comunque deduplica
  e gestione delle consegne tardive. Diventa preferibile se queste garanzie
  e le prove sintetiche di flusso sono requisiti immediati; non perché
  abbiamo misurato una sua disponibilità superiore. Il browser sintetico
  del monitor non sarebbe un fallback dei nostri scraper. Starter va valutato
  se bastano controlli esterni da 60 s; non confondere questo parametro con
  la soglia di assenza del nodo.
- **Uptime Kuma:** soluzione tecnicamente plausibile su un host separato;
  open source non significa gestione gratuita. Installarlo nel centro o
  sull'iMac osservato ricrea una dipendenza comune. Un host diverso risolve
  parte del problema, ma introduce aggiornamenti, backup e reperibilità
  dell'osservatore a nostro carico. Non consigliato come prima scelta nel
  vincolo attuale di ridurre manutenzione; non è stato installato.

## Review indipendente e controprove sul codice

Review in sola lettura su `3828e89`, seguita da rilettura dei chiamanti e
controprove. Questi risultati riguardano l'integrazione degli incidenti AMR,
non vulnerabilità dimostrate dei provider.

| Risultato verificato | Evidenza / controprova | Intervento necessario per il punto 4 |
| --- | --- | --- |
| Offline operativo e recupero non rappresentano le nuove soglie di episodio. | [centro.js:891](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/centro.js:891) usa 6 s e torna online al primo heartbeat. Il controllo a [393](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/centro.js:393) percorre lavori, non tutti i nodi. Duplicati heartbeat sono già scartati. | Timer indipendente dai lavori, durata offline e recupero continuo, episodio persistente. Dopo un riavvio non inventare osservazioni durante il vuoto. |
| Fonte non in pausa non equivale a fonte verificata sana. | [operazioni.js:63](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/operazioni.js:63) pubblica `fermo`; [fonti-salute.js:356](/Volumes/MAIN/BananaChePrezzi-main/backend/fonti-salute.js:356) restituisce lo stesso stato anche senza osservazioni. Una pausa/intervento espliciti sono invece distinguibili. | Non usare `fermo:false` per chiudere un incidente senza evidenza di riapertura; fonte mancante o mai osservata resta sconosciuta. |
| Evento diagnostico non è una ricevuta affidabile dell'avviso. | [centro.js:104](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/centro.js:104) assorbe errori di logging. I due POST manutenzione uguali producono due eventi; stato Admin salvato prima dell'evento. Retention elimina eventi. | Registrare atomici transizione, episodio e avviso pendente; invio fuori dal percorso ricerca e stato per canale. Non deduplicare usando soltanto gli eventi rimasti. |
| Uno stop può restare solo nel registro locale. | [worker-supervisore.js:38](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/worker-supervisore.js:38) rinvia uno stato se un invio è in corso; [53](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/worker-supervisore.js:53) non riparte dopo `close`. Prova controllata: invio precedente pendente → nessuno stop al centro; senza invio pendente → stop inviato. | Ricevuta locale riconciliabile e tentativo finale limitato; se non confermato, il centro non deve attribuire la caduta a uno stop manuale certo. Non ritardare indefinitamente l'arresto. |
| Non assegnabile e offline non sono sinonimi. | [centro.js:298](/Volumes/MAIN/BananaChePrezzi-main/backend/nodi/centro.js:298) include compatibilità, sospensione, solo stato e coda piena. La perdita del nodo non genera già tre errori fonte automaticamente. | Usare cause esplicite; episodio fonte per nodo/fonte e sopprimere solo conseguenze provate della caduta, preservando errori indipendenti. |

Ricevuta della controprova di stop, Node 24.21.0 con invio/processo simulati e
blocco della rete esterna:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-notifiche-stop-EtfFHq/esito.json`.
Entrambi i casi conservano lo stop nel file locale; cambia soltanto la
consegna al centro. Nessun processo reale o canale esterno è stato avviato.

Un secondo passaggio indipendente sul registro ha rilevato tre lacune reali
nella proposta: chiusura degli episodi intenzionali, dettaglio delle soglie
temporali e indebita esclusione dei piani esterni da 60 s. Le prime due sono
ora gate espliciti con una proposta da discutere; il confronto dei provider
è stato corretto. Non sono modifiche runtime. Listini e documentazione web
sono verificati dall'agente principale; il reviewer ha verificato codice,
coerenza del piano e ricevuta della prova, senza rieseguire il riproduttore.

## Proposta corretta e prova minima per falsificarla

- **AMR:** determina gli episodi nodo/fonte/comando usando evidenze valide e
  stato persistente. Mantiene le regole concordate dei 30/15 s, la riapertura
  tramite sonda e le pause; non invia richieste aggiuntive agli scraper.
- **Better Stack, candidato:** controlla indipendentemente il centro e può
  ricevere episodi tecnici con ID stabile. Non renderlo necessario per
  assegnare ricerche né creare un nuovo coordinatore della salute.
- **Consegna:** definire una sola autorità di invio per tipo di episodio,
  separando deduplica incidente, presa in carico e ricevuta del canale. Per il
  centro irraggiungibile il percorso non deve richiedere l'AMR caduto. Il
  fallback email deve poter funzionare anche senza il relay WhatsApp.
- **Diagnostica:** mostrare avviso pendente, accettato, fallito o incerto;
  mai etichettare consegnato un semplice HTTP 2xx del provider.

Le regole semplici e azionabili seguono [Google SRE](https://sre.google/sre-book/monitoring-distributed-systems/).
La transazione locale con avviso pendente segue il pattern outbox già citato;
non aggiungere Redis/Kafka o un secondo sistema di code senza un requisito.

Prima prova, senza portali e senza destinatari reali:

1. Soglia offline, recupero continuo e ricaduta prima dei 15 s; nodo senza
   lavori; riavvio durante episodio; scadenza diagnostica; nessun doppione.
2. Comando Admin ripetuto, stop con invio pendente e indisponibilità del DB:
   stato e avviso non possono divergere silenziosamente.
3. Simulare avviso accettato con risposta persa, riavvio durante invio,
   WhatsApp indisponibile/incerto, email fallita e consegna tardiva. Vietare
   retry alla cieca; ammettere entrambi i canali nel caso già concordato.
4. Verificare payload e separazione delle autorizzazioni: nessun dato di
   ricerca, risultato, segreto o comando remoto nel messaggio.

Solo dopo autorizzazione specifica, prova provider minima su endpoint di
collaudo nostro, senza portali: centro non raggiungibile e canale esterno
ancora funzionante; stesso Alert ID ripetuto; ack perso; recovery senza
messaggi; ricaduta come nuovo episodio. Misurare il tempo effettivo, non
dedurlo dall'intervallo commerciale. Fermarsi se duplicati non riconciliabili,
messaggi indesiderati, autenticazione insufficiente o dipendenza dal centro
caduto impediscono le regole concordate.

Stato finale: documentazione e controprove locali; nessuna prova live dei
provider, acquisto, invio, modifica runtime, commit di risoluzione o deploy.
Better Stack resta una raccomandazione condizionata. Punto 4 ancora aperto.

## Aggiornamento: account e decisioni confermate

Questa sezione aggiorna le proposte precedenti; non trasforma le prove
documentali in un collaudo di consegna.

- L'utente ha attivato l'account Better Stack e autorizzato l'accesso al
  browser per la configurazione. Il canone mensile è dichiarato dall'utente;
  non sono stati consultati dati di pagamento o modificata la fatturazione.
- Controllo esterno del centro: ogni **30 secondi**.
- Nodo: avviso dopo **30 secondi dall'ultimo heartbeat valido accettato**;
  resta distinta l'esclusione operativa dopo 6 secondi. Chiusura dell'episodio
  dopo 15 secondi di heartbeat regolari, senza ricostruire una continuità
  che non è stata osservata.
- Centro irraggiungibile: **email inviata direttamente da Better Stack**,
  indipendente dal centro AMR. L'utente accetta anche le push dell'app del
  provider. Successivamente ha confermato gli stessi canali principali per
  nodi e fonti: questa decisione sostituisce WhatsApp/openWA.

### Verifiche svolte

- Browser autenticato: area Incidents disponibile; Incoming webhooks visibile
  in Integrations → Importing data. La pagina Telemetry iniziale è un prodotto
  distinto e non è necessaria per ricevere questi incidenti.
- Form del monitor: frequenza 30 s disponibile; email, push e critical alert
  sono opzioni separate. Call e SMS disattivi; escalation senza conferma
  impostata di default su Do nothing. Non sono stati salvati nuovi monitor.
- Il form segnala di configurare il primo dispositivo push; la pagina Alerts
  invita ancora a installare l'app. Nessuna consegna push è stata provata.
- Documentazione ufficiale: [app e push](https://betterstack.com/docs/uptime/ios-and-android-mobile-apps/).
  Android: [Better Stack On-call, sviluppatore Better Stack, Inc.](https://play.google.com/store/apps/details?id=com.betteruptime.BetterStack).
  iOS: [Better Stack On-call](https://apps.apple.com/us/app/better-stack-on-call/id6739978181).
  Login con l'account Better Stack e permesso notifiche sul dispositivo sono
  prerequisiti. Critical alert e ripetizione del suono non sono richiesti e
  non vanno abilitati automaticamente.
- Un solo GET HTTPS a `/healthz` dello staging: HTTP 200 in 0,444 s. Nessuna
  autenticazione, richiesta ai portali, modifica Nhost o operazione sull'M2.
  È una misura del processo in quel momento, non un test di Auth/DB/ricerca.

### Configurazione da completare

Monitor proposto: `AMR staging — centro HTTP`, GET all'endpoint pubblico
`/healthz`, controlli ogni 30 s, verifica TLS attiva, email e push ordinarie.
Non creare un monitor delle ricerche né trasmettere filtri o annunci.

Il recovery del monitor HTTP è separato dai 15 s degli heartbeat del nodo:
il form ha un default di 3 minuti, che non è una nuova decisione concordata.
Prima dell'attivazione occorre verificare destinatario, assenza di promemoria
e messaggi di ripristino, disponibilità del dispositivo e comportamento del
canale reale. Il solo flag Push notification non dimostra l'arrivo sul telefono.

Decisione chiusa: email/push native sostituiscono WhatsApp come primo canale
anche per nodi/fonti. Non introdurre un nuovo bridge openWA in questo incremento.
Nessun nuovo monitor, webhook, messaggio di prova, deploy o commit eseguito
in questo aggiornamento.

## Implementazione locale dopo la conferma dei canali

- `backend/nodi/incidenti.js`: episodi e invii pendenti nel DB diagnostico
  esistente. Sospensione, manutenzione e supervisione vengono salvate nella
  stessa transazione del relativo avviso; un comando ripetuto non apre un
  nuovo episodio. Il registro non contiene annunci, filtri o aziende.
- Ultimo heartbeat valido persistito; verifica ogni secondo anche senza
  lavori. Soglia 30 s e recupero dopo 15 s con gap inferiori a 6 s, stesso
  boot. Al riavvio non viene inventata continuità. Un rientro oltre 30 s fra
  due controlli registra comunque l'episodio.
- Il worker invia heartbeat anche durante polling lento. Dopo stop non
  partono altri heartbeat. La supervisione scarica lo stop accodato, anche
  nel percorso terminale autonomo, e conserva localmente gli stop di cui il
  centro non ha confermato la ricezione, senza replay di boot obsoleti.
- `stato-fonti-nodo.js` trasmette solo esito e istante tecnico aggiuntivi.
  Fonte assente, pausa scaduta e worker solo stato non provano una riapertura.
  L'episodio fonte si chiude con una nuova osservazione `ok`/`vuoto` e fonte
  non ferma. Una disconnessione non inventa tre incidenti delle fonti.
- `betterstack.js`: URL opzionale da `AMR_BETTERSTACK_WEBHOOK_URL`, host HTTPS
  del provider e path webhook ammessi, niente redirect, timeout 4 s. Segreto
  e body del provider non entrano in log o ricevute. Nessuna variabile reale
  è stata letta o modificata.
- Identificatore stabile per episodio; payload `incident.id`, `status`,
  `title`, `description`, metadati di nodo/fonte e date tecniche. `alert` e
  `resolved` devono essere mappati nelle regole del webhook provider.
  La risoluzione è un comando al provider, non una notifica di ripristino
  deliberatamente inviata da AMR. La soppressione delle notifiche di ripristino
  native Better Stack resta da provare.
- Invio asincrono singolo. `accettato` significa ricevuta HTTP 2xx, **non**
  consegna email/push. Risposte perse, 5xx e crash durante invio rimangono
  `incerto`, senza retry automatico. Riconciliazione esplicita Admin permette
  di dichiarare presenza/chiusura già verificata sul provider, senza inviare
  un nuovo alert. Conservati Admin/MFA, Origin e header del comando.
- Admin: pannello incidenti, stato invii e pagine da 30 righe, indipendenti
  da quelle dei lavori. Gli episodi vecchi incerti restano raggiungibili.
  Il collaudo manuale dell'utente e la pubblicazione della UI non sono eseguiti.
- Cap 10.000 episodi: pulizia opportunistica delle sole chiusure confermate
  più vecchie di sette giorni. Episodi aperti, pendenti, falliti o incerti
  non sono eliminati per fare spazio. A capacità esaurita un nuovo episodio
  viene rifiutato con avviso esplicito; anche il comando/heartbeat che lo
  deve registrare può ricevere 503. È un limite operativo da osservare nel
  collaudo, non retention garantita di tutti gli episodi.
- Registro locale supervisore: massimo 10.000 precedenti non confermati e
  lettura fino a 3 MiB; oltre la capacità l'avvio si ferma senza sovrascrivere
  il file. La riconciliazione di questi vecchi stop resta locale, distinta
  dall'Admin centrale e dalle sue ricevute Better Stack.

### Review e controprove

Review indipendente in sola lettura. Finding riprodotti e corretti:

1. Gap heartbeat oltre 30 s nascosto dal rientro prima del timer.
2. ACK di vecchio boot che confermava nuova sequenza con lo stesso numero.
3. Rollback del comando che modificava prematuramente la stabilità in RAM.
4. Avviso con ACK perso non riconciliabile: aggiunto comando Admin esplicito.
5. Più stop non confermati che sostituivano il precedente nel registro locale.
6. Schema incidenti precedente privo della colonna di riconciliazione:
   migrazione preservando episodi e ricevute.
7. Normale rifiuto 409 che dichiarava erroneamente guasto il registro.
8. Stop terminale autonomo che attendeva un timer senza mantenere il launcher.
9. Incidente globale incerto vecchio che spariva dopo 30 nuovi episodi.
10. Gara fra timer del lavoro e deadline complessiva: il primo poteva
    rispondere 504/incerto perdendo il codice `ricerca_scaduta`. Il difetto
    esiste anche nella baseline. Riprodotto eseguendo prima il callback del
    lavoro con clock controllato; il test falliva prima del fix. Ora il timer
    conserva la causa se limitato dal budget, senza confonderla con un timeout
    locale più breve. Arrotondamento per eccesso evita di anticipare una
    scadenza frazionaria; non aumenta il budget complessivo.

Correzioni del collaudo, senza cambiare il comportamento applicativo:
la fixture dell'entrypoint deve includere la factory provider opzionale;
quella del watchdog deve pilotare entrambi i timer del centro. L'isolatore
di rete temporaneo accetta soltanto i nomi DNS sintetici delle prove TLS
con un lookup che restituisce loopback; resta vietata la rete esterna.
Il precedente isolatore rifiutava quelle richieste prima del DNS, producendo
falsi errori `rete_o_tls`. Non è una diagnosi del CHECK intermittente storico.

Il primo giro finale su 68 file ha eseguito 745 test: 733 passati, 11 saltati
e un fallimento nella deadline. La ripetizione isolata passava: questo non
è stato trattato come prova di assenza del difetto. La nuova controprova
controlla l'ordine dei callback e fallisce prima del fix; dopo la correzione
passano 70/70 casi su limiti ricerca, incidenti e supervisione del centro.
La review indipendente finale del diff non trova ulteriori finding materiali:
non ha rieseguito i test, né verificato provider, staging o M2. Il caso
frazionario è stato verificato nel codice; il contratto dei timer è descritto
nella [documentazione Node](https://nodejs.org/api/timers.html#settimeoutcallback-delay-args).

Ultimo gate dopo la correzione: **68 file, 746 test, 735 passati, zero falliti,
11 saltati**, 343,263 s, Node 24.21.0. Runner a quattro file concorrenti,
ambiente vuoto con dati/log temporanei, lettura di `.env`/`data/auth.json`
bloccata e rete limitata al loopback delle fixture. Le prove PostgreSQL/live
non abilitate restano escluse: il risultato non chiude il collaudo remoto,
la consegna Better Stack né il CHECK storico. Log temporaneo:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-incidenti-finale-tdavFf/test-finale-corretto.log`.
`git diff --check` superato; soltanto i file di questo incremento inclusi
nello staging Git, senza documenti/file preesistenti delle altre lavorazioni.

### Gate ancora aperto

Creato il webhook **AMR — incidenti nodi e fonti (staging)**, ID `60479`,
nel team Better Stack del collaudo, dopo conferma esplicita dell'utente.
Il provider lo crea attivo: è stato subito **sospeso**, prima di collegare
AMR. Verifica sull'elenco integrazioni: nome e stato `Paused` visibili.
URL segreta non estratta, mostrata in chat o salvata nel progetto.
Nessun nuovo monitor, invio di prova reale, deploy Nhost o accesso M2.
Creazione e sospensione non dimostrano configurazione delle regole,
ricezione da AMR né consegna email/push. La configurazione protetta nel
runtime richiede un intervento distinto sullo staging.

Prima di attivare: registrare il dispositivo nell'app Better Stack On-call,
verificare il destinatario, nessun promemoria/escalation ripetuta né messaggio
di ripristino, mappare lo stesso Alert ID per creazione/risoluzione. Poi
collaudo minimo senza portali né dati cliente, misurando consegna e duplicati.
Il recovery del monitor HTTP è stato concordato a **30 secondi** nella
successiva risposta dell'utente. È distinto dalla frequenza dei controlli
(30 secondi) e dalla ripresa dei nodi (15 secondi di heartbeat regolari).
La decisione è registrata; la configurazione nel provider resta da eseguire
e verificare. Il precedente default di tre minuti del form non si applica.
Punto 4 ancora aperto per il provider; punto 5 e frontend del punto 8 non avviati.

### Decisioni successive: candidati e storage

- Candidati per la baseline delle prestazioni: Auto **Alfa Romeo / Giulietta /
  Veloce** e Moto **Fantic / Caballero 500 / Rally**. Sono le ricerche già
  indicate per le sonde, non misure di prestazione già eseguite. Restano da
  definire condizioni confrontabili, filtri aggiuntivi, stato della cache e
  copertura delle fonti; nessuna nuova richiesta live è stata eseguita.
- Per lo storage l'utente preferisce un provider gestito, valutato anche per
  gli eventuali file applicativi del SaaS. Chiede costi espliciti di spazio,
  traffico e operazioni. Allora non era ancora scelto né attivato un provider;
  restava la direzione restic open source più storage gestito. Le operazioni sui
  backup e i file applicativi avranno autorizzazioni e retention separate.
- Il punto 6 è stato successivamente concordato: parametri della console
  modificabili entro intervalli collaudati, applicati soltanto alle nuove
  ricerche e con registrazione delle modifiche. Baseline: due richieste
  pendenti per persona, 60 complessive, deadline di 60 secondi. Gli estremi
  degli intervalli richiedono misure; nessun comando deve aggirare le pause
  automatiche delle fonti. Decisione confermata, implementazione non eseguita.
- Per i file applicativi l'utente ha precisato **log e bug report inviati
  dal frontend AMR**, oltre ai backup già concordati. Allegati, screenshot,
  copia degli annunci e invio indiscriminato dei payload non sono requisiti
  autorizzati. Retention dei report e modalità di archiviazione dei log
  restano da definire prima dell'integrazione.
- **R2 Standard era un candidato** nell'analisi iniziale.
  Il [debunking storage](storage-r2-debunking-2026-10-07.md) confronta
  documentazione ufficiale, costi e codice esistente. Nessuna prova R2 live,
  lettura di segreti, modifica applicativa, accesso M2 o deploy eseguito.

### Attivazione R2 e perimetro del primo collaudo

L'utente ha successivamente attivato R2 e autorizzato il solo collaudo
isolato: due bucket privati Standard EU, `amr-collaudo-backup-db` e
`amr-collaudo-backup-journal`, credenziale Object Read & Write limitata
ai due bucket e valida 24 ore, dati sintetici sotto 10 MiB.
Bucket e credenziale creati; public URL disabilitata e nessuna expiration
degli oggetti restic. Dopo il salvataggio protetto della credenziale,
collaudo R2 concluso: 262.279 byte sintetici, repository distinti,
backup/check completo/restore identico per entrambi, chiave errata respinta
con codice specifico 12, retention solo dry-run e una copia conservata
per repository. È una prova dell'integrità di byte sintetici, non del restore
PostgreSQL o dell'outbox e stato Admin dello staging. Le copie di prova
rimangono nei bucket; nessuna cancellazione remota avviata.
Staging, M2, dati cliente, archiviazione remota di log/report e produzione
non sono collegati. Evidenze e limiti nel
[registro R2](storage-r2-debunking-2026-10-07.md#collaudo-isolato-autorizzato-il-7-ottobre).

### Collaudo successivo PG/R2

Verificato anche il percorso con PostgreSQL reale ma dati sintetici:
250.245 byte, due dump e tredici journal, restore su cluster separato,
replay ordinato e idempotente dei sette journal successivi al dump.
Corretto il replay degli inviti del collega revocato, dopo prova fallente
e confronto con il writer. Stato backup e ruoli verificati nella fixture;
frontend/staging non collegati. Copie remote conservate, nessuna retention
distruttiva, accesso M2 o deploy. Procedura, prove e limiti nel
[registro PG/R2](storage-r2-postgres-2026-10-07.md).

### Decisioni e verifica provider — 8 ottobre

Risposte dell'utente, da distinguere dagli esiti già collaudati:

1. App Better Stack Android già autenticata.
2. Un solo collaudo notifiche al proprietario, email e push; niente promemoria
   o messaggi di ripristino. Nessun destinatario aggiuntivo autorizzato.
3. Due sole ricerche live di baseline attraverso staging e worker iMac:
   Alfa Romeo / Giulietta / Veloce e Fantic / Caballero 500 / Rally,
   senza altri filtri, almeno 15 secondi fra ricerche sulla stessa fonte.
4. Lentezza: solo avviso diagnostico, senza incidente Better Stack.
5. Confermati i tre parametri modificabili: deadline, pendenti per persona e
   pendenti complessive. Solo nuove ricerche, persistenza e audit; intervalli
   da verificare, nessuna deroga alle pause delle fonti.
6. Nessun password manager già scelto. Richiesta una custodia sicura dei
   segreti operativi e delle chiavi di recovery. Non autorizza una cifratura
   reversibile delle password degli utenti: resta Nhost Auth. Scelta del
   vault ancora aperta, nessuna nuova installazione effettuata.
7. Autorizzati due nuovi bucket privati EU del solo staging, con credenziale
   limitata ai bucket, distinti da collaudo sintetico e futura produzione.
   Autorizzato backup dei dati reali di staging, non dell'M2.
8. Manutenzione temporanea di staging, indicativamente 20 minuti, dopo
   backup e restore verificati e con rollback pronto; nessuna fascia esclusa.

**Configurazione provider eseguita:** nel webhook `60479`, ancora `Paused`,
apertura solo per `incident.status == alert`, risoluzione solo per
`incident.status == resolved`; entrambe estraggono `incident.id` integralmente.
Nome da `incident.title`, causa da `incident.description`. Preview dei due
payload e reload confermano regole e valori salvati. Email e push standard
attivi; chiamate, SMS e critical alert disattivati; escalation al team `Do nothing`.
Nessun collegamento al runtime AMR o invio mediante la URL webhook.

Il comando provider **Send test alert** è stato eseguito una sola volta:
la pagina conferma invio al proprio account e colleghi non notificati.
Questo comando non ha creato un incidente mediante il payload AMR: non
dimostra trasporto, deduplica o risoluzione end-to-end. Ricezione effettiva
di email e push da confermare dall'utente; nessun secondo invio effettuato.

Il primary on-call era vuoto e prevedeva fallback all'intero team.
Salvata la selezione del solo proprietario, ogni giorno; pagina risultante
mostra il proprietario attualmente on-call e conferma aggiornamento.
L'onboarding mostra ancora un avviso di gap: la presenza attuale non è
una prova di copertura futura completa. Non aggiunti membri né destinatari.
In Settings > Alerts risulta un dispositivo Android registrato.

**Incidente della lavorazione:** in una lettura della pagina non redatta,
la URL webhook è finita nel risultato dello strumento. L'errore è stato
comunicato all'utente. Non è stata copiata in repository, file, log o Nhost;
l'integrazione resta sospesa. La URL va sostituita prima del collegamento.
Non riportare il valore nella documentazione. Richiesta la conferma per
creare la sostituzione, senza cancellare definitivamente la precedente.

**Monitor HTTP non ancora creato:** `/healthz` risponde 200 alla singola
verifica senza login. Preparato il form per GET ogni 30 secondi, timeout
10 secondi, TLS verificato, senza credenziali, redirect o cookie. Il form
offre recovery immediato o da 1 minuto, ma non 30 secondi: il valore
concordato è documentato come intero in secondi nell'API ufficiale.
Richiesta una scelta fra token Uptime del solo team per configurarlo via
API e modifica esplicita del recovery a 1 minuto; nessun valore alternativo
applicato, nessun token creato. Non confondere il form preparato con un
monitor operativo.

**Verifiche locali:** 68/68 test su incidenti, avvio centro e limiti ricerca,
Node 24.21.0, ambiente senza credenziali, dati/log temporanei e guard che
nega la rete esterna. Review indipendente in sola lettura: nessun finding
materiale confermato nel contratto notifiche; 32/32 test Node 24.19.0 e
controprove SQLite su disco (concorrenza, restart, ACK perso/tardivo e
riconciliazione). Limiti: nessuna consegna provider, deduplica reale o
assenza di messaggi di ripristino provata da questi test.

Fonti ufficiali consultate: [incoming webhook](https://betterstack.com/docs/uptime/incoming-webhooks/),
[mobile app](https://betterstack.com/docs/uptime/ios-and-android-mobile-apps/),
[monitor API](https://betterstack.com/docs/uptime/api/create-a-new-monitor/),
[token del team](https://betterstack.com/docs/uptime/api/getting-started-with-uptime-api/),
[OWASP secrets management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
e [password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).

Punto 4 ancora aperto per URL sostitutiva, recovery concordato e collaudo
end-to-end; punti successivi non dichiarati completati. Nessun deploy,
accesso M2, modifica frontend o richiesta live ai portali in questo incremento.

### Custodia temporanea e controprova API — 8 ottobre

L'utente conferma ricezione dell'email del test provider e mancata ricezione
della push. Conferma anche che `Push notifications` nell'app Android e il
permesso notifiche Android sono entrambi attivi. Il dispositivo registrato
risulta collegato di recente; modalità vacanza dell'account disattivata.
Queste informazioni escludono alcune ipotesi, ma non dimostrano una causa
del mancato recapito né il funzionamento del canale push.

Autorizzati il token Uptime del solo team e il webhook sostitutivo. Per la
custodia l'utente ha scelto esplicitamente un `.env` temporaneo, rinviando
il password manager dopo il signup Bitwarden non completato. Creato fuori
dal repository `/Users/aincrad/.config/automotoradar/staging/.env`: directory
di AMR e staging `0700`, file `0600`, proprietario verificato, creazione
esclusiva senza seguire un symlink. Contiene soltanto le due nuove credenziali
Better Stack; nessuna password applicativa copiata. Valori salvati senza
output, argomenti di comando o commit; copia temporanea del token nel
clipboard del browser rimossa. È **custodia in chiaro**, non cifratura.
FileVault risulta disattivato; nessuna impostazione di sistema cambiata.

Il token consente lettura/scrittura delle risorse Uptime **del team**, non
è un token globale né un permesso limitato al singolo monitor. Non è
collegato al runtime AMR e non viene caricato nei test automatici.

**Correzione della conclusione sul recovery:** la documentazione ufficiale
descrive `recovery_period` come intero in secondi, ma l'API reale rifiuta 30
con HTTP 422. La controprova, dopo verifica che nessun monitor fosse stato
creato, conferma l'elenco ammesso: `0, 60, 180, 300, 900, 1800, 3600, 7200`.
L'utente ha quindi scelto esplicitamente **60 secondi**. Non costruita una
soluzione personalizzata per aggirare il vincolo del provider.

Creato il monitor `5036432`, `AMR — centro staging`, inizialmente sospeso:
GET del solo `/healthz`, controlli 30 s, timeout 10 s, recovery 60 s,
confirmation period 0, TLS verificato, niente redirect/cookie/credenziali,
email e push standard, nessun critical alert, SMS, telefonata o escalation
al team. Controlli aggiuntivi di scadenza dominio/certificato disattivati.
POST 201 seguito da GET: nessuna differenza sui parametri inviati.
Non modificato il monitor preesistente del team. La sonda di processo
non prova funzionamento di Auth, PostgreSQL, worker o ricerche.

Creato il webhook **`60492`**, sostituzione esplicita dello staging, con
POST 201. Rilettura API conferma:

- vecchio `60479` sospeso, nuova URL diversa e corrispondente al file privato;
- nuovo webhook sospeso, apertura `incident.status == alert`, risoluzione
  `incident.status == resolved`, match esatto; acknowledgment manuale;
- titolo/causa da `incident.title`/`incident.description`; Alert ID integrale
  `incident.id` in entrambi i rami;
- email e push standard, nessun critical alert, SMS, telefonata o escalation.

Non spedito alcun payload alla nuova URL, né collegata allo staging.
La sostituzione evita il riuso della URL precedentemente esposta;
non equivale a revoca definitiva della vecchia credenziale, che rimane
sospesa e non va usata.

Impostati a `Never` i promemoria di turno del team, prima a 24 ore;
reload conferma il valore salvato. Non modificata la grouping policy:
il suo switch `Notify about all incidents in a group` è attivo, quindi
la sola presenza del raggruppamento non prova che gli alert siano soppressi.
Assenza di notifiche di risoluzione e consegna push ancora da dimostrare
con un incidente reale di collaudo: configurazioni e HTTP 2xx non bastano.
Richiesta autorizzazione per una sola nuova prova end-to-end, perché il test
provider precedente aveva già consumato l'invio inizialmente autorizzato.

Ricevuta redatta di configurazione e controverifiche:
`/private/tmp/amr-betterstack-20261008-ovJ72P/provider.json`.
La ricevuta include le regole e gli estrattori effettivamente riletti,
non soltanto booleani di verifica. Review indipendente in sola lettura
conferma compatibilità con il payload e nessun nuovo finding tecnico nel
perimetro; il finding documentale iniziale è risolto dalla presente sezione.
Non dimostra la consegna al telefono. Prova visiva senza segreti in
`/private/tmp/amr-betterstack-20261008-ovJ72P/monitor-configurato.jpg`.
Fonti ufficiali aggiuntive: [API incoming webhook](https://betterstack.com/docs/uptime/api/create-incoming-webhook/),
[parametri di estrazione](https://betterstack.com/docs/uptime/api/incoming-webhooks-response-params/),
[promemoria on-call](https://betterstack.com/docs/uptime/getting-started-with-oncall-v2/).
Punto 4 ancora aperto per consegna e percorso completo; nessun nuovo deploy,
accesso M2, richiesta ai portali o modifica del codice applicativo.

### Preparazione dei prossimi gate — 8 ottobre

Nuova lettura API, senza invii: webhook `60492` e monitor `5036432`
ancora sospesi; email/push abilitate, critical alert, SMS e telefonate
disabilitati, escalation al team assente. Monitor: 30 s, timeout 10 s,
recovery 60 s. Nessuna nuova notifica o modifica del provider in questo giro.

La pagina Alerts mostra il dispositivo Android registrato. Features conferma
promemoria `Never`; anche Advanced settings non espone un controllo dei
messaggi di risoluzione nativi. Questo non dimostra che il provider non lo
supporti: la soppressione resta da verificare, prima di promettere un test
senza messaggi di ripristino. L'API di risoluzione documenta `resolved_by`,
non un'opzione di soppressione. Le regole Outgoing e-mails non provano il
comportamento delle notifiche native email/push.

La review indipendente ha confermato un rischio **condizionato** nel piano
del test unico: `incidenti.scarica()` prende tutti gli episodi pendenti,
anche quelli già chiusi. Una controprova su SQLite in memoria con due episodi
accumulati produce due alert e un resolved. È comportamento previsto,
non un difetto della deduplica; il backlog reale non è stato letto.
La nuova prova, se autorizzata, deve quindi usare un registro sintetico nuovo
e un solo episodio, senza collegare il sender al registro vivo dello staging.

Separati due gate prima confusi nell'ordine dei lavori:

1. Configurazione provider e collaudo isolato del trasporto AMR/webhook.
2. Integrazione nel runtime staging, solo dopo backup/restore e aggiornamento
   del candidato. La release remota documentata `66e2b24` non contiene il
   nuovo sender: pretendere questa integrazione prima dell'aggiornamento
   creerebbe una dipendenza circolare. L'ordine degli incrementi 4–7 resta
   valido; non certifica da solo il funzionamento remoto.

Domande presentate insieme all'utente, **ancora senza risposta** in questo
giro: nuovo test unico di notifica; seconda copia della chiave di recovery;
limiti Admin inizialmente entro i default o collaudo degli aumenti;
collocazione dell'archiviazione log/report R2; indice cifrato del punto di
recovery con ricevuta separata e stop in caso di copie mancanti.
Restano già approvate le sole due ricerche live, il `.env` privato temporaneo,
i nuovi bucket dello staging e la manutenzione successiva al backup.

Review in sola lettura: 21/21 prove mirate Node 26.4.0, più controprova del
backlog in memoria; nessuna chiamata esterna o lettura di dati vivi da parte
del reviewer. Non è un nuovo gate Node 24, né una prova di recapito Android.
Corretta la checklist recovery da 30 a 60 s; nessun nuovo difetto applicativo
confermato nel perimetro. I punti 4–7, CHECK e gate remoto/M2 non sono
dichiarati completati. Il brainstorming frontend resta successivo ai gate.

Fonti ricontrollate: [push standard e critical alerts](https://betterstack.com/docs/uptime/ios-and-android-mobile-apps/),
[timeline degli incidenti](https://betterstack.com/docs/uptime/api/list-of-incident-timeline-events/),
[risoluzione API](https://betterstack.com/docs/uptime/api/resolve-an-ongoing-incident/)
e [threat model restic](https://restic.readthedocs.io/en/stable/100_references.html#threat-model).

### Decisioni confermate e incidente unico — 8 ottobre

L'utente ha risposto alle cinque domande del giro precedente:

1. Autorizzato un nuovo incidente sintetico, solo al proprietario, email e
   push standard. Non autorizzati nuovi incidenti automatici di prova.
2. Approvata una seconda copia offline della chiave di recovery, custodita
   dall'utente. Non ancora attestata la sua effettiva preparazione.
3. Limiti Admin entro i default già approvati (60 s, 2/persona, 60 totali);
   aumenti oltre questi valori richiedono un collaudo separato di capacità.
4. Log e bug report su R2 saranno affrontati durante il lavoro sulla console,
   senza trasformarli in un prerequisito dei backup o del collegamento M2.
5. Approvato indice di recovery cifrato con ricevuta separata e stop in caso
   di copie necessarie mancanti o indice non verificabile.

Usato un registro SQLite sintetico nuovo, un solo episodio di sospensione
del nodo fittizio `collaudo-notifica-20261008`; nessun registro vivo letto.
Il primo controllo preliminare si è fermato prima di aprire il registro o
spedire payload: il confronto richiedeva uguaglianza anche dei campi
aggiunti dal provider (`created_at`, campi opzionali null). Corretto il
confronto sui soli parametri attesi, mantenendo numero esatto delle regole.
Artefatti e marcatori esclusivi precedenti conservati, non cancellati.

Il trasporto effettivo `creaIncidenti` → `creaInvio` ha spedito **un solo
payload alert** e ottenuto HTTP 200. GET provider conferma incidente
`1028713720`, ancora aperto, email/push abilitate, altri canali disabilitati.
Nessun payload `resolved`, nuovo incidente o retry del payload.

**Finding verificato nel collaudo, non nel codice AMR:** risospendere
subito il webhook dopo HTTP 200 interrompe l'elaborazione asincrona delle
notifiche. La timeline registra esplicitamente l'escalation interrotta
perché l'integrazione era sospesa. Il test deve attendere evidenza della
notifica o dichiarare esito incerto prima della pausa; HTTP 200 non basta.

Riattivato lo stesso webhook e richiesta una sola escalation dello stesso
incidente al proprietario via API, con email/push e nessun critical alert,
SMS o chiamata. La timeline registra ripresa automatica dopo la riattivazione,
escalation API, **una email e una push** inviate al dispositivo Android.
Osservate sia la ripresa automatica sia l'escalation API; non è determinabile
quale abbia prodotto gli invii. Non adottare questa combinazione come
procedura ordinaria: in altre condizioni potrebbe duplicare l'avviso.
La prova osservata non registra due invii per canale.
Risospensione effettuata solo dopo questa evidenza e confermata con GET.
Non cambiati monitor HTTP, runtime staging o nodi; nessuna richiesta ai portali.

Ricevuta e prove redatte:
`/private/tmp/amr-notifica-unica-20261008-gnHoeb/` (`ricevuta.json`,
`provider.json`, `timeline-notifica.json`, `notifica-esistente.json`).
La conferma di ricezione sul telefono resta richiesta all'utente: la
timeline dimostra l'invio del provider, non il recapito visibile.
La soppressione delle notifiche di ripristino resta non provata; incidente
lasciato aperto, senza risoluzione o cancellazione. Non dichiarato chiuso il
punto 4 o il gate remoto.

Review indipendente: confermati il rischio della pausa anticipata e un
controllo insufficiente dell'exit code nel solo script temporaneo; nessun
nuovo difetto applicativo provato. Test incidenti sintetici **21/21 Node 24**,
fetch disabilitato, nessuna credenziale o rete per il reviewer.
Fonti: [elaborazione alert](https://betterstack.com/docs/uptime/processing-alerts-for-integrations/),
[timeline](https://betterstack.com/docs/uptime/api/list-of-incident-timeline-events/),
[escalation su incidente esistente](https://betterstack.com/docs/uptime/api/escalate-an-ongoing-incident/).

### Verifica della chiusura dello stesso incidente — 8 ottobre

L'utente ha autorizzato la chiusura del solo incidente sintetico, accettando
che il provider potesse notificare il ripristino. Il controllo preliminare
ha trovato l'incidente **già risolto** alle 23:07:35.212 UTC del 7 ottobre
(01:07:35.212 locali dell'8 ottobre), da un utente secondo la timeline.
Il marcatore esclusivo registra **zero POST di risoluzione**: non ripetuta
un'operazione già completata, non riaperto l'incidente e nessun altro alert.
Il webhook rimane sospeso, verificato con GET.

La timeline successiva contiene la risoluzione e i precedenti invii email e
push delle 22:48:44 UTC; non registra altri invii al ripristino. Questo è un
campione osservato con chiusura manuale e integrazione sospesa, **non prova
di soppressione universale** nelle future chiusure automatiche del runtime.
La conferma della ricezione sul dispositivo e il collegamento operativo
staging restano aperti. Non dichiarato concluso il punto 4.

Prove private redatte: `risoluzione.json`,
`timeline-risoluzione-redatta.json` nella stessa directory del collaudo.
La documentazione [Resolve incident](https://betterstack.com/docs/uptime/api/resolve-an-ongoing-incident/)
espone `resolved_by`, senza un parametro di silenziamento degli invii.
