# Policy ingress dopo la diagnosi del 403 — 8 ottobre 2026

Branch `feat/nodi-residenziali-prototipo`, baseline `39b7ee0`.
Segue il [checkpoint e la diagnosi](checkpoint-staging-2026-10-08.md).
L'utente ha scelto la modalità Nhost esplicita per lo staging. Implementata
e collaudata localmente; nessuna configurazione cloud modificata.

## Percorso originale e confine scelto

Prima del fix `config-centro-run.js` richiede almeno un IP esplicito. `centro-run.js`
crea un listener HTTP su `0.0.0.0`; passa la stessa configurazione di
trasporto al centro e alle rotte login/aziende/colleghi/backup.
`trasporto-prova.js` accetta il protocollo inoltrato soltanto da un peer
autorizzato. `/healthz` è l'unica esenzione iniziale del centro.

La misura remota precedente ha osservato due peer con fiducia differente
nella stessa istanza; non viene ripetuta in questo incremento. Il replay
del modulo originale spiega 403/200. Non prova che tutti i 403 storici
dipendano da quel solo controllo, né quali reti siano isolate dal provider.

I cookie del login derivano `Secure` dall'origine configurata, non da
`req.secure`. La ricerca verifica identità, azienda/modulo e revoche;
i nodi hanno un token distinto. Ammettere il trasporto non concede questi
permessi. Host e Origin da soli non autenticano un chiamante non browser.

## Fonti ufficiali consultate oggi

- [Express: behind proxies](https://expressjs.com/en/guide/behind-proxies/):
  la fiducia deve riflettere la topologia; `true` e il conteggio degli hop
  richiedono condizioni precise. Fidarsi del proxy influenza anche IP,
  hostname e protocollo, non soltanto l'HTTPS.
- [Nhost Run: networking](https://docs.nhost.io/products/run/networking):
  stack e Run comunicano sulla rete condivisa; i servizi pubblici HTTP
  hanno URL HTTPS. La pagina non fornisce gli IP stabili dei proxy né una
  garanzia che soltanto l'ingress possa raggiungere il listener interno.
  Questo non dimostra l'assenza di tali garanzie da ogni fonte Nhost.
- [Nhost Run: configuration](https://docs.nhost.io/products/run/configuration):
  configurazione di porte, repliche e risorse. Nessun meccanismo per
  autenticare l'ingress è stato identificato in questa pagina.
- [OWASP: TLS](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html):
  TLS protegge riservatezza/integrità e verifica il server; per identificare
  anche il client occorre un controllo distinto, per esempio mTLS.
- [Cloudflare Tunnel, applicazioni pubbliche](https://developers.cloudflare.com/tunnel/):
  connector con connessioni in uscita e servizio locale. È una possibile
  alternativa, non un'integrazione Nhost già provata. Il fatto che Tunnel
  sia disponibile su tutti i piani non quantifica il costo del deployment AMR.

## Prove e controprove locali

Ambiente pulito, Node 24.21.0, nessun `.env`, provider, dato cliente,
scraper o M2. Prima del fix sono state confrontate le alternative.

Quattordici casi puri distinguono il guard originale da un modello
permissivo che autorizza il peer della richiesta soltanto per falsificare
la proposta. Il modello non viene integrato né proposto come codice.

| Caso | Esito |
| --- | --- |
| Guard originale, peer fidato e header https | 200 |
| Guard originale, peer nuovo/header https | 403 |
| Guard originale, chiamante interno non fidato/header forgiato | 403 |
| Modello permissivo, peer legittimo nuovo | 200 |
| Modello permissivo, chiamante interno/header forgiato | 200 |
| Modello permissivo, Host/Origin/protocollo errati o header duplicato | 403, sei casi |
| Guard originale con socket TLS, senza header inoltrato | 200 |
| Guard TLS con solo header https su socket HTTP | 403 |
| Guard TLS con header inoltrato da peer non fidato | 403 |

La controprova conferma che rimuovere il controllo del peer cambia il
confine di trasporto. Non dimostra che un aggressore possa raggiungere
quel listener Nhost o superare login/MFA/token. Non chiamarlo bypass
dell'autenticazione né vulnerabilità remota già sfruttabile.

I test esistenti del trasporto e dell'HTTPS sono **9/9 pass**, zero skip,
con TLS locale reale, cookie, login/MFA sintetici, revoca e guard delle
rotte aziendali. Primo tentativo fermato da `listen EPERM` della sandbox;
riesecuzione autorizzata sulle sole porte casuali di `127.0.0.1` passata.
Nessuna prova browser o live Nhost in questo incremento.

Ricevute private:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-ingress-confine-20261008-cr9mgm2u/`
(`prova.cjs`, `esito.json`, `test.tap` negativo, `test-locale.tap` positivo).

## Alternative sottoposte a debunking

1. **Modalità esplicita per Nhost, proposta per lo staging.** Dichiarare
   che il provider termina il TLS pubblico e che la rete del progetto è
   parte del confine fidato. Evitare la dipendenza dagli IP campionati e
   non usare `trust proxy=true` per derivare l'identità del client.
   Conservare origine canonica, Host/Origin, cookie Secure, controllo degli
   header ambigui, login/MFA, autorizzazioni commerciali e token dei nodi.
   Riduce configurazione e manutenzione, senza nuovi componenti.
   **Condizionata:** un chiamante interno può riprodurre gli header di
   trasporto. Non è equivalente alla policy degli IP e va accettato
   esplicitamente come confine, poi collaudato. Non certifica l'isolamento
   della rete privata o la sicurezza del provider.
2. **Ingresso autenticato e app non raggiungibile direttamente.** Un
   connector locale, per esempio Cloudflare Tunnel, evita di identificare
   l'ingress tramite IP mutevoli. Il listener applicativo deve essere
   realmente limitato al loopback; lasciare `0.0.0.0` vanificherebbe questa
   parte della proposta. Servono deployment del connector, DNS, gestione
   delle credenziali, healthcheck distinto, restart e prove dei timeout.
   Nhost Auth/PostgreSQL e gli scraper resterebbero nei rispettivi ruoli.
   **Condizionata:** compatibilità e costo complessivo su Run non collaudati;
   non installare o attivare nulla prima della scelta. Tunnel non sostituisce
   automaticamente login e MFA AMR; non introdurre Access per gli utenti
   senza una decisione separata.
3. **Altro IP esatto nello staging.** Può riammettere il peer appena
   osservato preservando il guard, ma non protegge dalla prossima rotazione.
   **Verificato come limite della proposta:** non risolve stabilità e
   manutenzione; resta un workaround da autorizzare, non una policy duratura.
4. **TLS direttamente nel processo.** Il guard già lo supporta, come provano
   i test locali, ma l'entrypoint Run attuale è HTTP. Non è stata verificata
   la possibilità di terminare il TLS pubblico nel container attraverso la
   configurazione Run adottata. Non presentarla come alternativa immediata
   solo perché un server HTTPS locale funziona.

Scelta confermata dall'utente: alternativa 1, «Modalità Nhost esplicita
(consigliata per lo staging)», dopo aver dichiarato il limite del chiamante
interno con header falsificati. Il supporto Nhost resta escluso.

## Implementazione locale della scelta

- `AMR_CENTRO_INGRESS=nhost` abilita la modalità; `AMR_CENTRO_PROXY_IP`
  deve essere assente. Valori ignoti, vuoti, HTTP o configurazione mista
  vengono rifiutati. Senza la nuova variabile resta la modalità precedente.
- `trasporto-prova.js` richiede Host canonico e un solo header
  `X-Forwarded-Proto: https`; continua a negare header ambigui e Origin
  non valido. Ammette peer validi senza lista IP. `trustProxy` è sempre
  falso in questa modalità: Express non deriva IP, hostname o protocollo
  dagli header inoltrati. I cookie Secure derivano dall'origine configurata.
- `centro-run.js` passa la stessa policy a centro, login, aziende,
  colleghi e stato backup. Sessioni, MFA Admin, autorizzazioni commerciali,
  token e registrazione dei nodi non cambiano. `/healthz` resta l'eccezione.
- La manutenzione backup supporta `AMR_BACKUP_INGRESS=nhost`, con
  `AMR_BACKUP_PROXY` assente. Restano hash del bearer temporaneo,
  scadenza, GET su categorie fisse, Origin assente e una sola acquisizione
  anche con retry. Non sono stati letti database reali.
- `prepara-aggiornamento-staging.js --ingress nhost` prepara soltanto
  il candidato con la nuova policy; arresto originale e rollback mantengono
  l'esatta configurazione precedente, riferimenti compresi. Lo script non
  fa deploy. Il template originale non viene convertito automaticamente.
  Un nuovo aggiornamento da una configurazione già Nhost la preserva.

Il flag non autentica il provider e non prova l'isolamento della rete.
Un processo interno che conosce gli header può superare il controllo di
trasporto: la rete del progetto rientra nel confine fidato concordato.
Le controprove senza sessione o token sono negate. La scelta di staging
non costituisce una certificazione dell'ingress per la produzione.
Il rollback riporta anche il limite noto della vecchia lista IP; preservare
l'originale non equivale a correggerlo.

### Verifica del fix

Gate mirato: **67 pass, 0 fail, 2 skip** in cinque file, inclusi due nuovi
test puri del trasporto e prove HTTP di login/MFA, revoca, rotte aziendali,
token nodo, entrypoint e manutenzione backup. Le prove negano l'Admin senza
MFA; il falso X-Forwarded-For/Host non modifica i getter di Express.
Il piano candidato è riletto e validato, il rollback confrontato interamente
con l'originale; nessun overlay del checkout o segreto risolto nel pacchetto.

Gli skip sono i gate opzionali sul vero HEAD e sulla CLI ufficiale Nhost.
Il test di pacchetto usa blob Git sintetici. Non confondere questi esiti con
la build dell'immagine del commit candidato o il collaudo remoto.
I primi run hanno rilevato aspettative errate nelle nuove fixture: un GET
nodo senza token e l'avvio anonimo restituiscono 401, non 403; la simulazione
del Host dell'ingress per il backup richiede il client HTTP nativo.
Correzioni limitate ai test, verificate contro i guard reali.
Ricevute `test-fix.tap`, `test-fix-r2.tap`, `test-fix-r3.tap` nella directory
privata sopra.

Gate di compatibilità: **107/107 pass, zero skip**, nove file esistenti:
avvio/arresto del centro, login Nhost simulato, invalidazione dei login per
epoca, sessioni/revoche, API aziende/colleghi e backup HTTP/runtime/segreti.
Nessun provider, database o storage remoto interrogato. Ricevuta
`test-compatibilita.tap`. Totale dei due gate: **174 pass, zero fail**.

Review indipendente in sola lettura conclusa: nessun finding concreto
verificato nel diff. Il reviewer ha seguito propagazione della policy,
sessioni/MFA/token, configurazioni ambigue e rollback; non ha rieseguito
i test né interrogato il cloud. Conferma il limite interno accettato,
senza attestare isolamento della rete o prontezza alla produzione.
La review dell'intero branch e il gate remoto restano separati.

## Passi prima del frontend

1. Policy ingress scelta e fix locale verificato. Preparare l'immagine
   manutenzione con la stessa policy; acquisire un checkpoint fresco
   PostgreSQL + volume Run, cifrarlo e verificare il restore isolato
   prima dell'aggiornamento.
2. Preparare il candidato per le piattaforme necessarie, verificare digest,
   manifest, avvio non root, Auth e stato; distribuire solo nello staging
   concordato con rollback verificabile. Verificare accesso e rifiuti remoti:
   il 403 dello staging non è ancora dimostrato risolto.
3. Collaudare runtime backup R2 e notifiche Better Stack: backup vivo,
   restore, retry/riavvio e stato diagnostico. La copia offline della chiave
   e il recapito push sono già confermati dall'utente; non richiederli di
   nuovo. La risoluzione automatica senza notifica resta da provare.
4. Collegare M2 isolato solo per connessione, stato e compatibilità.
   Nessuna modifica della produzione. Il live richiede prima coordinamento
   di pause/limiti dei processi sullo stesso IP.
5. Misurare le ricerche autorizzate e collaudare paginazione, retry,
   failover e diagnostica. Auto Giulietta/Veloce e Moto Caballero 500/Rally,
   senza richieste aggiuntive e almeno 15 secondi fra ricerche per fonte.
6. Review del branch e correzione dei finding confermati. Il CHECK storico
   resta distinto dall'ingress: l'utente ha autorizzato staging/M2 solo stato
   con il finding aperto, non la produzione. Nuove evidenze possono cambiare
   l'ordine o fermare il gate.
7. Solo allora: frontend owner (punto 8 del piano originale) secondo il brainstorming concordato,
   compresi limiti, log e bug report; non una nuova interfaccia per clienti.

Nessuna nuova domanda di prodotto necessaria per il gate successivo.
La policy ingress è decisa; i gate remoti sopra restano da eseguire.
Le scelte già confermate su moduli, pause, quote, retention e M2 solo stato
non vengono riaperte.
Il mancato collaudo di una scelta non è una nuova domanda di prodotto.
