# Integrazione AMR, centro–nodi e Nhost Pro

30 settembre 2026. Review senza modifiche applicative, commit, attivazioni o accesso all'M2. Riferimento: HEAD `155d295` e **worktree modificato**, non il solo commit. Le modifiche già presenti sono preservate. Fonti web consultate in questa data; le capacità pubblicizzate non equivalgono a un collaudo del nostro backend.

## Verdetto

Nhost Pro + Run è un candidato coerente, ma il prototipo non è pronto a essere esposto e 25 USD non rappresentano il costo completo. Rimanere sotto 50 EUR è **condizionato** a dimensionamento, cambio, trattamento fiscale, traffico e add-on. Nessuna approvazione all'acquisto.

Classificazioni: **verificata** = percorso letto o prova riprodotta, oppure capacità/prezzo documentato; **condizionata** = effetto dipendente da un impiego/configurazione specifici; **non dimostrata** = servono implementazione, misura o conferma del fornitore. Un requisito commerciale concordato è verificato come requisito, non come comportamento già implementato.

## Percorso effettivo

- Frontend commerciale: `scripts/frontend-parts/search.js` → `/api/search` in `backend/server.js:43` → parser e `ricerca-coordinatore.js` nello stesso processo. Il monolite continua a eseguire la ricerca localmente: non diventa un centro distribuito cambiandogli hosting.
- Prototipo: frontend `nodi-prototipo.js` → cookie aziendale fittizio → `centro.js:460` → `ricerca`/scheduler → polling autenticato del worker → `operazioni.js:28` → parser, cataloghi e coordinatore esistenti → tre fonti → risposta del worker → centro → browser.
- Il coordinatore usa scope aziendale sul nodo, cache normalizzate temporanee, cursori e salute locale. La ricerca ordinaria Subito passa `senzaRecupero: true` (`ricerca-coordinatore.js:74`): i documenti storici sul recupero non descrivono necessariamente la ricerca corrente.
- Il centro preferisce un nodo che copre le fonti. Per una fonte mancante o 429 prova un solo alternativo; il primario ricompone tramite `componi`. Nessuna ripetizione delle altre fonti nei casi controllati.
- Cataloghi e dettagli attraversano il worker. Non attraversano questo protocollo schede tecniche, richiami, prove, carburanti, targa e preferenze. Le rotte esistono nel monolite (`server.js:34–76`): il prototipo non copre tutta l'app Auto/Moto.
- SQLite centrale registra filtri e metadati; risultati restano nelle promise/RAM. La composizione persiste solo i nomi delle fonti, il dettaglio solo hash URL (`centro.js:115`). Al riavvio le assegnazioni in memoria si perdono; con DB conservato, i lavori pendenti diventano interrotti/incerti. Non vengono ripetuti automaticamente.

## Nhost: verifiche ufficiali e limiti

### Identità e posta

**Verificata documentalmente:** Auth email/password, verifica email e recupero; TOTP con challenge prima della sessione. MFA deve essere abilitata nel progetto e attivata per la persona. Non è automaticamente obbligatoria per il nostro admin. La API permette di disattivarla: AMR deve impedire che l'admin resti autorizzato senza il requisito. Fonti: [email/password](https://docs.nhost.io/products/auth/sign-in-email-password), [MFA](https://docs.nhost.io/products/auth/mfa), [gestione MFA](https://docs.nhost.io/reference/auth/post-user-mfa).

**Condizionata:** usare solo email/password e TOTP nella prima integrazione limita i percorsi da collaudare. Ruolo admin assegnato dal nostro backend, email verificata e MFA attiva vanno controllati server-side. Un campo metadata modificabile dal cliente non può conferire il ruolo. Il claim delle [elevated permissions](https://docs.nhost.io/products/auth/elevated-permissions) riguarda WebAuthn: non usarlo come prova implicita della TOTP. Evidenza della MFA nella sessione concreta, disattivazione, refresh e reset devono essere provati sullo stack scelto.

**Verificata documentalmente:** il logout invalida refresh token; non è una prova che ogni JWT già firmato smetta immediatamente di funzionare nel nostro backend. La verifica crittografica di un token non interroga le nuove scadenze commerciali. Fonte: [signout](https://docs.nhost.io/reference/auth/post-signout), [JWT](https://docs.nhost.io/products/auth/jwt). Non confondere `/token/verify` con una dimostrazione di introspezione delle licenze AMR.

**Condizionata:** Aruba ordinaria documenta `smtps.aruba.it`, porta 465 e TLS con autenticazione. L'esempio ufficiale Nhost espone host, porta, secure e metodo SMTP; compatibilità plausibile, invio e consegna **non dimostrati**. Non sono state lette credenziali. Fonti: [Aruba](https://guide.aruba.it/hosting-e-domini/email/configurazione-posta/parametri-configurazione-posta), [configurazione ufficiale Nhost](https://github.com/nhost/nhost/blob/main/examples/docker-compose/docker-compose.yaml). Verificare template, URL di ritorno ammessi, TLS e limiti del mittente con invio concordato. Il servizio email predefinito ha limiti differenti dal SMTP personalizzato: [rate limits](https://docs.nhost.io/platform/cloud/rate-limits).

### Database, Run e riavvio

**Verificata documentalmente:** PostgreSQL e Run condividono una rete interna; il servizio Run può pubblicare un endpoint HTTPS per HTTP. I nodi possono aprire connessioni in uscita: non serve pubblicare una porta sul computer residenziale. Fonte: [networking](https://docs.nhost.io/products/run/networking). Usare un ruolo PostgreSQL limitato alle tabelle AMR, non il superuser dell'esempio né un admin secret nel browser o nei nodi.

**Verificata documentalmente:** backup giornalieri del DB con sette giorni di retention. Non comprendono file Storage né dati dei volumi Run. PITR è un add-on. Fonte: [backups](https://docs.nhost.io/products/database/backups). Lo SQLite del prototipo non diventa coperto dal backup PostgreSQL perché è ospitato su Run.

**Condizionata:** Run ha filesystem effimero salvo volume; quindi un deploy ingenuo perde diagnostica e sospensioni. Fonte: [resources](https://docs.nhost.io/products/run/resources). Proposta: spostare in PostgreSQL aziende, appartenenze, moduli, scadenze, identità/revoche nodi, sospensioni e metadati. Non persistere annunci. Il DB non ricostruisce automaticamente le promise o le risposte perse.

**Verificata documentalmente:** Run può riavviare un container che fallisce `/healthz`; la rotta deve rispondere entro cinque secondi. Fonte: [health checks](https://docs.nhost.io/products/run/health-checks). Il centro attuale non la espone. Una fonte in pausa non deve rendere il processo unhealthy e provocare riavvii.

**Non dimostrata:** durata massima delle richieste HTTP pubblicate da Run, limiti del proxy per long polling, tempi/concorrenza degli arresti durante deploy e consegna affidabile dei nostri body. I 180 secondi delle Functions Pro non dimostrano un limite di Run. Le pagine consultate non bastano a garantire la compatibilità. Occorre prova dedicata/conferma prima dell'apertura clienti.

### Costo

Listino [Pro/Run](https://nhost.io/pricing): 25 USD per organizzazione, 15 USD di crediti compute; Run shared indicativamente 15 USD/vCPU/mese, con RAM associata. Extra possibili: traffico oltre quota, storage, dominio personalizzato del progetto e PITR (da 100 USD). Il dominio custom Nhost è un add-on della piattaforma: non è il costo di acquisto del dominio escluso dal budget.

La [fatturazione ufficiale](https://docs.nhost.io/platform/cloud/billing) dice che il progetto base consuma circa i 15 USD coperti. Non spendere gli stessi crediti nuovamente per Run. Dieci aziende AMR possono stare nello stesso progetto con isolamento; dieci progetti Nhost non sono necessari. La pagina contiene un esempio incoerente (25 + 35 indicato come 66): usare la formula, non copiarne il totale.

Stime nominali, **condizionate**, prima di imposte/cambio/extra e senza un secondo progetto cloud attivo:

| Configurazione | Totale mensile indicativo |
|---|---:|
| Pro + progetto base + Run 0,5 shared vCPU / circa 1 GiB | 32,50 USD |
| Pro + progetto base + Run 1 shared vCPU / circa 2 GiB | 40 USD |
| Prima configurazione + custom domain Nhost | 42,50 USD |
| Seconda configurazione + custom domain Nhost | 50 USD |

Compute fatturato al minuto: importi mensili arrotondati, non preventivi. CPU shared non garantisce prestazioni costanti ([risorse progetto](https://docs.nhost.io/platform/cloud/compute-resources)). Dimensionamento sufficiente per 30 persone **non dimostrato**. Al cambio ipotetico 1 USD = 1 EUR e con un'ipotetica imposta del 22%, 32,50 diventa 39,65 e 42,50 diventa 51,85: sono scenari aritmetici, non cambio o trattamento fiscale accertati. Notifiche di spesa non costituiscono un tetto: Nhost non arresta automaticamente l'uso. Sotto 50 EUR è plausibile nella prima configurazione senza add-on, non garantito.

## Finding, prove e controprove

### P1 — Alta: confine locale e autorizzazioni commerciali assenti — verificata

`centro.js:14,382,402,449,460`: aziende hardcoded, login senza password, Admin locale senza identità personale, controllo modulo soltanto all'ingresso. La prova HTTP ottiene Admin senza cookie (200). Controprova: Host esterno rifiutato (403), default Admin disabilitato e ascolto loopback; **non è una vulnerabilità remota attuale**. Diventa una vulnerabilità se si rimuovono solo i vincoli localhost per pubblicarlo.

Correzione proposta: prima dell'esposizione, identità Nhost verificata e autorizzazione AMR per persona/azienda/modulo/scadenza; Admin distinto e MFA. Tenant derivato dall'identità server-side. Controllare autorizzazione anche prima dell'assegnazione e della consegna. Vietare accesso diretto alle tabelle applicative via GraphQL salvo permessi espliciti equivalenti. Nhost da solo non applica il contratto commerciale.

### P2 — Alta: collegamento remoto e copertura app incompleti — verificata

`worker.js:42` accetta solo HTTP loopback; `centro.js:79,532` impone Host locale e ascolto loopback. `operazioni.js:28` ammette solo ricerca/fonte/composizione/menu/dettaglio. Controprova: queste restrizioni proteggono correttamente la prova locale; non vanno tolte senza sostituzione. Distribuire il monolite, invece, avvierebbe il coordinatore sul cloud (`server.js:56`).

Proposta: un solo backend AMR centrale su Run, protocollo HTTPS outbound dei nodi con credenziali separate e revocabili, collegamento delle rotte commerciali al dispatcher. Inventario degli accessori prima di promettere parità. Nessun secondo backend applicativo necessario; Auth/DB Nhost sono servizi separati dello stesso progetto.

### P3 — Media: prima pagina condivisa perde affinità per la seconda azienda — verificata e riprodotta

`centro.js:225,288,305`: solo l'azienda che avvia `ricercaSenzaCondivisione` registra l'affinità. Prova: A e B condividono prima pagina dal nodo a; aggiungendo una coda su a, A torna ad a, B passa a b senza avviso (`avvisiNodi: []`). Controprova: A mantiene correttamente il nodo e ricerche non condivise registrano l'affinità. Non dimostrata perdita effettiva di annunci sul portale; verificata la violazione dell'associazione/avviso.

Proposta: condividere l'esecuzione e il suo resoconto di assegnazione, ma registrare separatamente l'affinità per ogni destinatario autorizzato. Non copiare stato personale, scope cache o permessi del primo utente.

### P4 — Media: dettaglio negato per annunci ancora esposti — verificata e riprodotta

`centro.js:467,496`: oltre 300 hash URL vengono rimossi i primi, il dettaglio li rifiuta 403. Prova sintetica: 301 righe ricevute, dettaglio prima riga 403, ultima 200. La fixture accelera il raggiungimento del limite: non sostiene che una pagina reale abbia 301 annunci; il contatore si accumula anche su più pagine/ricerche. Controprova: URL mai consegnati sono correttamente negati. Proposta: autorizzazione temporanea legata alla ricerca attiva, con TTL e limite allineato alla quantità effettivamente consultabile; in alternativa un riferimento firmato vincolato a persona/azienda/modulo/URL e scadenza. Debunking alternativa: la firma non sostituisce revoca/scadenza controllate dal server; deve coprire anche confronto e dettagli storici ancora visibili.

### P5 — Alta per cloud: persistenza e proprietà dello scheduler — verificata/condizionata

`centro.js:41,86,149,519`: SQLite e Map locali, nessun coordinamento fra repliche; il main non collega `close()` a SIGTERM. Controprova: con lo stesso SQLite, test di riavvio marcano correttamente i pendenti e preservano sospensioni. Perdita su disco effimero è condizionata al deploy senza volume; doppi scheduler condizionati a repliche/deploy sovrapposti, non riprodotti su Nhost.

Proposta: PostgreSQL per metadati, un solo scheduler attivo e una generazione centrale associata ai lavori. Arresto controllato, stop nuove assegnazioni, stato incerto per lavori accettati senza conferma. Un semplice `replicas=1` non prova assenza di sovrapposizione al deploy: verificare il lifecycle oppure usare esclusione del proprietario dello scheduler in DB. Nessun replay dopo restore; invalidare sessioni/capacità e riconciliare revoche/scadenze prima di riaprire. Valutare perdita accettabile delle modifiche dopo l'ultimo backup: decisione aperta.

### P6 — Media: timeout locali non costituiscono un budget end-to-end — verificata/condizionata

`worker.js:17,49,57`: HTTP a quattro secondi, polling ogni 250 ms, heartbeat ogni due secondi mentre occupato; `centro.js:146` considera offline dopo sei secondi. `centro.js:244,274,292` assegna budget separati (150 s base, fino a 50 s per alternativa, altri 150 s composizione), non un tetto unico. Verificata struttura; incidenti sull'hotspot o su Run non misurati. Controprova: disconnessione/risultato tardivo sono gestiti nei test e non producono replay automatico.

Proposta: scadenza unica della ricerca, budget residuo per i rami e timeout trasporto separati; connessione outbound con long polling collaudato, backoff e heartbeat tolleranti. Come alternativa a una richiesta browser molto lunga, job breve + consultazione esito: risultati solo RAM con TTL e autorizzazione a ogni lettura. Debunking: aggiunge stato e modifica UI; al riavvio risultato perso va dichiarato incerto, non ricalcolato. Scelta da confrontare con una misura Run, non introdurre alla cieca.

### P7 — Compatibilità e pause sullo stesso IP — verificata/condizionata

`centro.js:16,146` e `worker.js:23`: stringa `imac-1`, nessun hash reale di commit/cataloghi. `fonti-salute.js:166,191` carica il DB in memoria senza una lettura fresca per ciascuna ammissione: due processi sullo stesso IP non diventano coordinati solo condividendo il file. Verificati meccanismi, effetto remoto condizionato. Controprova: worker locale consulta la salute prima di nuove chiamate e il centro non sostituisce l'autorità locale; failover 429 di una sola fonte passa i test.

Proposta: manifest di protocollo/release/cataloghi verificato, revoca per nodo e limiti per sorgente/IP; prima dell'M2 un'autorità di ammissione comune ai processi sul medesimo IP. Non usare failover come aggiramento indefinito del 429; limite un alternativo mantenuto. Nodo compromesso con la propria credenziale può mentire sul contenuto: autenticazione del nodo non certifica i risultati; restringere schema e privilegi.

### P8 — Privacy e UI commerciale: gap confermati, exploit non tutti riprodotti qui

`scripts/frontend-parts/search.js:271` rende riprovabili i 5xx senza distinguere `incerto`; non gestisce `avvisiNodi`. È verificato leggendo il percorso; non ho ripetuto il browser dell'app commerciale. `server.js:66`/`dati-utente.js` usano le vecchie identità per preferenze; il rischio di migrazione fra account resta aperto nel registro AMR. Non classificare la precedente riproduzione come un nuovo test di questa review.

Proposta: UI esplicita per incerto/avvisi e retry soltanto richiesto dalla persona; preferenze per persona/azienda, nessuna importazione automatica del localStorage di un'altra identità. Diagnostica, supporto ed export con policy di accesso/retention. Controprova: il prototipo non salva annunci in SQL e la diagnostica pubblica locale omette i filtri. In cloud anche il riepilogo nodi/lavori deve essere protetto. Backup di metadati purgati può conservare copie oltre sette giorni: distinguere retention attiva e backup, non promettere eliminazione totale immediata.

## Regole commerciali: piano corretto

Tutti i requisiti del proprietario sono confermati come requisiti; **nessuno è già implementato integralmente dal prototipo**.

1. Un progetto Nhost multi-tenant con tabelle AMR: aziende, appartenenza persona (vincolo univoco), inviti, abilitazioni Auto/Moto, validità annuale e registrazione amministrativa del pagamento. Tre persone per azienda incluso referente; fino a dieci aziende e trenta clienti. Admin proprietario distinto; stabilire se escluso dai trenta.
2. Creazione azienda e attivazione annuale dal proprietario; referente può invitare due colleghi. Prenotazioni/inviti e accettazioni concorrenti richiedono transazione e blocco della quota aziendale, non solo un conteggio letto prima dell'inserimento. Non fidarsi di `azienda`/`moduli` inviati dal browser.
3. PC e telefono sono due sessioni della stessa persona, nessun costo/posto aggiuntivo. Limiti di traffico per persona/azienda/pool separati dal conteggio utenti.
4. Email verificata; Admin con MFA obbligatoria. Prima integrazione limitata ai metodi di login effettivamente collaudati. Nessun ruolo admin autoassegnabile dalla signup.
5. Scadenza controllata dal backend anche con JWT valido, a ogni operazione, prima della consegna e quando un lavoro attende in coda. Tempo autorevole server/DB, nessuna tolleranza commerciale. Decisione del proprietario del 1 ottobre 2026: se l'abbonamento scade durante una ricerca, consegnare soltanto l'esito dell'interruzione, senza annunci, anche se alcune fonti hanno già risposto. Non avviare nuove chiamate per quel cliente dopo la scadenza. La decisione riguarda la consegna; non stabilisce se annullare fisicamente una chiamata già partita. Se l'esecuzione è condivisa con un'altra azienda ancora autorizzata, il blocco del destinatario scaduto non deve interrompere il lavoro necessario all'altra azienda. Nessuna implementazione applicativa autorizzata da questa registrazione.
6. Pagamenti manuali: nessun provider automatico necessario ora; operazioni amministrative autorizzate/idempotenti e audit senza dati di annunci. Nhost Auth non è un gestionale di fatture.

## Primo esperimento minimo proposto (non eseguito)

Prima una prova locale, senza acquistare servizi: frontend commerciale per ricerca/menu/dettaglio → centro con adapter d'identità → due worker HTTP simulati. Nhost locale e PostgreSQL con account sintetici possono verificare le API effettive, MFA e vincoli; un mock dell'identità non certifica Nhost. Niente Docker/servizi avviati da questa review.

Scenario: due aziende con moduli differenti e una ricerca identica consentita a entrambe; prima pagina condivisa, pagine successive, dettaglio della prima riga dopo più di 300 annunci. Poi solo Subito 429 sul nodo a, unico alternativo b, altre fonti contate una sola volta; disconnessione dopo accettazione, risultato tardivo, revoca persona, scadenza durante coda/lavoro, riavvio e restore. Accettazione concorrente degli ultimi inviti e tentativo di autoassegnarsi l'azienda/admin.

Successo: nessun job per modulo/azienda negati, niente risultati dopo revoca secondo la policy concordata; chiamate contate e equivalenti al monolite simulato, affinità/avvisi corretti, nessuna ripetizione delle parti riuscite, nessun replay degli incerti; DB/log/backup senza annunci e credenziali; sospensioni persistenti, MFA realmente richiesta per Admin, quote rispettate in concorrenza.

Fermarsi se: accesso cross-tenant, ruolo admin ottenibile dal cliente, fonte interrogata dal centro, perdita silenziosa di pagine, replay incerto, revoca/scadenza aggirabile, annunci nei log/DB o budget soltanto supposto. Dopo la prova locale: decisione esplicita su Pro, un solo servizio Run e prova con fonti simulate di timeout/deploy/SMTP/restore. L'M2 e i portali restano fuori fino ai rispettivi gate.

## Prove eseguite e limiti

- `node --test test/nodi-centro.test.js test/nodi-baseline.test.js`: **23/23 pass**, dati temporanei, dotenv neutralizzato dal test baseline e trasporti delle fonti simulati. Nel sandbox l'ascolto locale non era disponibile (13 test falliti per server senza indirizzo); autorizzata esecuzione loopback fuori sandbox, tutti passati. Non era una regressione applicativa.
- Harness indipendente `/private/tmp/amr-nhost-verifica-20260930/prove.cjs`: affinità A/B, limite dettaglio e confine localhost, tutti riprodotti via API reali del centro con worker sintetici. Prima controprova Host usando fetch non era valida perché l'header non era applicato come previsto dal client; ripetuta con `node:http`, Host esterno effettivo rifiutato 403. Non attribuire quel primo esito al server.
- Nessun servizio Nhost, SMTP o nodo remoto testato. Nessun benchmark di trenta utenti, nessuna misura del traffico o capacità cloud. Nessuna nuova garanzia sulle risposte future dei portali.

## Decisioni ancora aperte

Decisione chiusa il 1 ottobre 2026: alla scadenza durante una ricerca, mostrare soltanto l'esito dell'interruzione senza annunci. Anche le porzioni già ricevute non vengono consegnate al destinatario scaduto. Il trattamento fisico delle chiamate già in corso resta distinto; non annullare implicitamente un'esecuzione condivisa ancora necessaria a destinatari autorizzati.

Decisione sul recupero del 1 ottobre 2026: il proprietario accetta il ripristino dal backup giornaliero e il reinserimento manuale delle attivazioni, dei rinnovi e delle revoche successivi al backup. Richiede una copia di queste operazioni per guidare il reinserimento; non accetta implicitamente di perderle senza traccia.

Requisito da progettare: conservare il registro delle operazioni fuori dal database centrale e dal suo volume di esecuzione, con accesso ristretto e senza password, token o annunci. Deve permettere di identificare e ordinare le operazioni effettivamente confermate e distinguere quelle già presenti nel backup da quelle da reinserire; identificativi stabili devono impedire duplicazioni. Il ripristino non deve riaprire gli accessi prima di aver riconciliato soprattutto le revoche. Non presumere atomicità fra modifica al DB e copia esterna: vanno definiti e provati i casi di guasto tra i due passaggi e resi visibili eventuali errori del backup operativo. Le copie complete del DB, a differenza del registro operativo, possono comprendere hash e altri dati sensibili dello schema Auth: richiedono cifratura e accessi ristretti e non devono essere presentate come prive di dati d'autenticazione. Nessuna implementazione o configurazione di backup eseguita.

Destinazione concordata il 1 ottobre 2026: **OneDrive personale già disponibile al proprietario**, separato dal backend centrale. Tipo di account confermato; protocollo e permessi ancora da verificare. Non chiedere credenziali nella chat né presumere autenticazione app-only disponibile per account personale. Non attivare un altro storage a pagamento implicitamente.

Prima verifica ufficiale: Microsoft Graph documenta upload di file e cartella applicativa con permessi limitati. Candidato: upload dal backend alla cartella dedicata, senza dipendere dalla sincronizzazione dell'iMac. Autenticazione, rinnovo/revoca del consenso e permessi effettivi dipendono dal tipo di account: non presumere accesso app-only al OneDrive personale né richiedere accesso all'intero drive senza necessità. La cartella applicativa rimane modificabile/cancellabile dal proprietario e usa la quota del drive; non è un backup immutabile. Compatibilità e recupero non ancora collaudati. Fonti: https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder ; https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0 . Nessun accesso all'account eseguito.

Modalità di interview aggiornata dal proprietario il 1 ottobre 2026: presentare insieme tutte le domande necessarie, anziché una domanda per turno. Trasporto e dimensionamento richiedono prima esperimenti, non preferenze senza misure. Nessuna risposta va dedotta dalla raccomandazione proposta.

### Risposte complete del proprietario — 1 ottobre 2026

1. OneDrive ospiterà **entrambi, separati**: registro attivazioni/rinnovi/revoche e copia del backup giornaliero completo DB.
2. Copia delle operazioni dopo ogni operazione confermata, con stato visibile nell'Admin. Non confondere conferma del commit e conferma della copia esterna.
3. Se OneDrive è indisponibile, le operazioni continuano con avviso persistente; copia da ritentare. Il rischio di perdere operazioni non ancora copiate in caso di guasto del DB resta dichiarato, non risolto dal solo avviso.
4. Conservare operazioni per 90 giorni e 14 backup giornalieri. Distinguere retention della copia esterna dalla retention di sette giorni dei backup Nhost e dei filtri diagnostici. Il registro operativo non deve includere filtri o annunci.
5. Cifrare le copie prima dell'upload; chiave di recupero conservata dal proprietario anche fuori dal backend e da OneDrive. La gestione delle chiavi e il restore devono essere collaudati. Per le password, chiarimento tecnico: usare hash adattivi con salt tramite il servizio d'identità, non cifratura reversibile né una seconda autenticazione custom AMR. Riferimento: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html . L'hashing non sostituisce isolamento per azienda, permessi e revoche. Algoritmo/configurazione effettivi della versione Nhost scelta ancora da verificare; non dichiararli certificati da questa decisione.
6. 50 EUR/mese è indicativo, non un tetto rigido; priorità al rilascio AMR. Non è autorizzazione a sostenere spese o attivare servizi senza richiesta.
7. Usare inizialmente l'indirizzo HTTPS fornito da Nhost; niente add-on per dominio personalizzato in questa fase. Collegamento con frontend e redirect Auth ancora da provare.
8. Trenta persone indica i clienti; Admin del proprietario escluso.
9. Gestione degli accessi interni dall'area account client-side, comprese revoche; inviti pending scadono dopo sette giorni. I posti sono persone, non PC/telefono. Chiarimenti successivi confermati: solo il referente invita e revoca i colleghi; ciascun collega gestisce le proprie sessioni. Ogni invito pending prenota uno dei tre posti aziendali e lo libera alla scadenza senza accettazione. L'accettazione converte la prenotazione in appartenenza senza consumare un secondo posto. Quote e autorizzazioni vanno applicate dal backend in transazione, anche con richieste concorrenti; non sono ancora implementate.
10. Predisporre un secondo dispositivo autenticatore e una procedura d'emergenza verificata prima del lancio. Non presumere disponibilità di recovery code o duplice enrollment TOTP nativi: verificare i meccanismi Nhost reali senza bypass permanente della MFA.

Interview completata anche su ruoli e prenotazioni. Le altre decisioni operative vanno elaborate e verificate contro il codice prima di implementare; questa interview non ha attivato servizi né autorizzato deploy.

Avvio del primo incremento, 1 ottobre: [collaudo-autorizzazioni-amr.md](collaudo-autorizzazioni-amr.md). Fonti autorevoli consultate, percorso centro/coda/consegna/condivisione letto e baseline simulata 23/23 superata. Nessuna implementazione commerciale ancora eseguita. Nuova decisione emersa dalla verifica del ciclo dei ruoli: autorizzazione al cambio del referente; non assegnare quel diritto implicitamente. Il registro distingue questo chiarimento dalle regole già confermate su colleghi e inviti.

Decisione successiva: cambio referente inizialmente autorizzato solo dall'Admin proprietario. Realizzato incremento locale con `account-prova` opzionale, identità sintetiche e transazioni SQLite; controlli ingresso/coda/consegna, inviti e quote, revoche, proprie sessioni e destinatari delle ricerche condivise. Review e prove nel registro del collaudo. Il launcher normale non attiva questo esperimento; nessuna integrazione reale Nhost, email, MFA o OneDrive, nessun commit/deploy/M2.

Esito finale locale: **51/51** test account/HTTP/centro/baseline e **9/9** di integrità. Risolti i finding verificati dell'incremento, compresa l'affinità di chi aderisce durante la composizione; review indipendente mirata della correzione conclusa senza nuovi finding riproducibili. Non equivale a collaudo Nhost/SMTP/backup o prontezza cloud. Prossimo gate: stack Auth/PostgreSQL locale isolato e adapter reale, con ripetizione delle prove di revoca, MFA e quote concorrenti.

Commit richiesto successivamente: `f2faf73`, verificato su copia esatta dei file preparati (51/51). Primo collaudo del provider reale completato su stack locale isolato: [nhost-auth-postgres-locale.md](nhost-auth-postgres-locale.md). Verifica email, bcrypt, TOTP e vincolo PostgreSQL con lock osservato; logout nega il refresh ma non il vecchio JWT, e i claim del JWT non attestano la challenge MFA. Non confondere questi comportamenti conformi al provider con accessi illegittimi già dimostrati nel centro: l'adapter reale resta da implementare dopo la verifica del percorso di sessione. Nessun cloud/M2/SMTP reale, nessuna migrazione commerciale eseguita.

Decisione e incremento successivi: pagina AMR centrale con sessione server-side, collaudata contro Nhost locale. [Registro login](login-nhost-server-side.md): 63/63 test, percorso Auth reale e pagina in Chrome headless simulato; corretti revoca durante creazione e classificazione 5xx/429, verificate le challenge concorrenti. Rotte ancora separate dal centro e schema commerciale reale non integrato. Nessun nuovo commit/deploy automatico.

### Incremento locale: login e permessi reali collegati al centro — 1 ottobre 2026

Login server-side precedente committato in `ae33f5f`; successivo incremento non ancora committato. Registro con implementazione, review, prove e limiti: [centro-accessi-postgres.md](centro-accessi-postgres.md). Nhost e PostgreSQL locali verificano identità, moduli, scadenza e revoca durante coda/lavoro; il ruolo lettore non accede a hash o tabelle Auth. Quote SQL collaudate separatamente: non ancora CRUD commerciale del nuovo schema. Predisposta modalità manuale con password scelta dal proprietario nel proprio terminale; nessuna password permanente creata per lui. Nessun cloud o M2 coinvolto.

### Aggiornamento di riferimento — 2 ottobre 2026

Le sezioni precedenti descrivono incrementi storici, non lo stato corrente.
La review e gli incrementi successivi sono registrati in
[branch-nodi-2026-10-02-30a1f12.md](branch-nodi-2026-10-02-30a1f12.md).
Colleghi e trasferimento del referente usano ora PostgreSQL reale; journal
commerciale e database hanno backup cifrati separati nel collaudo restic locale,
con replay e restore verificati. OneDrive è stato sostituito dalla decisione
**backup open source e storage gestito**: lo storage remoto resta da attivare e
collaudare; non esiste ancora una copia esterna garantita dalle prove locali.

Il proprietario ha confermato un solo servizio AMR su Nhost Run per frontend e
backend, con Auth e PostgreSQL separati nello stesso progetto. Il
[gate HTTPS locale](centro-https-run.md) e la
[mappa di integrazione con APP](amr-centro-mappa-funzionalita.md) distinguono
preparazione, integrazione dell'app completa e prove cloud ancora necessarie.
Nessun servizio, spesa, deploy o intervento M2 è stato autorizzato da questo gate.

### Staging e nuova review — 2 ottobre 2026

Decisione successiva: il proprietario ha autorizzato **Nhost staging separato**.
Il [pacchetto e la procedura](staging-nhost.md) sono committati in `75207a7`;
il servizio preliminare `amr-centro-staging` è stato creato il 3 ottobre con
zero repliche, senza porte, volumi o segreti. Non esegue ancora il centro;
configurazione completa e avvio restano gate separati. Il gate locale
dell'immagine `646fcbe` ha completato
HTTPS, Auth/PostgreSQL, SIGTERM e persistenza; resta distinto dalla prova cloud.

La [nuova review del branch](branch-nodi-2026-10-02-646fcbe.md) registra finding
con prove e controprove su scheduler, account e ripristino. Quei finding non
sono stati corretti né autorizzati implicitamente dall'attivazione dello staging.
M2 e produzione restano esclusi. Le sezioni precedenti sono storico delle
decisioni e non attestano automaticamente lo stato corrente.
