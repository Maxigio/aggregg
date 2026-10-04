# Sonda isolata dell'ingress Nhost — 4 ottobre 2026

## Stato verso il deploy

Baseline `2d59ae8`, candidato del centro `7b7d881` già collaudato localmente
con PostgreSQL 18/Auth/MFA/HTTPS/worker simulato/restart/restic. Il centro
e il pannello del prototipo condividono un servizio; la UI diagnostica non
sostituisce il frontend commerciale completo dell'app.

| Area | Stato verificato | Prova ancora necessaria |
| --- | --- | --- |
| Centro, account e aziende | Implementati e collaudati localmente: moduli, inviti, quote, scadenza/revoca e MFA Admin | Auth/SMTP/reset/recovery e permessi sull'ambiente Nhost effettivo |
| Assegnazione e diagnostica nodi | Centro/worker, salute per fonte, sospensioni, affinità, retry e composizione provati con risposte controllate | Collegamento remoto dell'iMac, latenza/carico; M2 in un gate separato |
| Backup e recovery | Restic reale verso repository locali, dump/replay e revoche provati | Storage esterno operativo e restore anche dello stato SQLite |
| Pacchetto Run | Immagine locale, SQL e configurazioni preparati | Registry, ingress, installazione remota, volume, arresto e rollback |
| App per clienti | Auto/Moto e integrazione seguiti anche dalla chat APP | Percorso completo nel browser commerciale attraverso centro e nodi |

Non assegnare una percentuale di completamento: i gate remoti possono
cambiare le decisioni. La produzione M2 resta quella precedente; qui non è
stata aggiornata. L'ultima osservazione della console Nhost è il
[precedente inventario](staging-inventario-2026-10-04.md), non una nuova
verifica di stato remoto in questo incremento.

## Piano verificato e implementazione

Il controllo anonimo dell'app non può vedere il socket dentro Run. Si prepara
quindi una sonda **separata dall'app**, eseguita tramite `command` alternativo
documentato da Nhost. Nessun nuovo framework o refactoring dei guard.

- `scripts/nhost/sonda-proxy-staging.js`: server `node:http`, senza import di
  AMR, dotenv, Auth, PostgreSQL, cataloghi o scraper e senza rete in uscita.
- `scripts/nhost/misura-proxy-staging.js`: client `node:https` verso un'origine
  HTTPS esplicita. Cinque richieste brevi; con `--attese`, sette in totale.
- `scripts/nhost/sonda-proxy-staging.toml`: template distinto dalla
  configurazione del centro, fermo (`replicas=0`, `publish=false`), senza
  ambiente, segreti o storage. Origine e digest sono placeholder deliberati.

Il template non può essere distribuito così com'è. Prima dell'uso occorrono
immagine approvata nel registry, digest effettivo, origine del servizio e
approvazione della configurazione pubblica e dell'avvio. I valori 500 millicpu
e 1.024 MiB riprendono il candidato esistente: non sono una nuova misura del
fabbisogno o un preventivo del dashboard.

### Dati e risorse

Il server risponde con un JSON fisso per la rotta e un ID casuale del processo;
non restituisce peer, header o contenuti del client. Nei log compaiono solo
nome della prova, sequenza, ID, durata/esito, classificazioni finite degli
header e IP del socket **solo se privato/loopback**. Peer pubblico: categoria,
senza indirizzo. Mai URL/query/header/body arbitrari, cookie, token o errori
grezzi. Nessuna copia su disco viene creata dal server.

Si distinguono assenza, duplicati e valori noti da `rawHeaders`: il solo
oggetto `headers` potrebbe nascondere duplicati. Gli indirizzi falsificati
sono sentinelle della rete di documentazione, non dati di persone.

Limiti del server: 32 connessioni, header 16 KiB, ricezione entro cinque
secondi, due attese simultanee, massimo 200 richieste diagnostiche in una
finestra di 15 minuti. Metodi, query, body e rotte estranee sono rifiutati.
Alla scadenza non vengono ammesse nuove prove (410); quelle partite possono
completarsi dopo la finestra, con attese nominali di 55/65 secondi.
`/healthz` resta 200: la scadenza non chiede al provider
un restart che azzererebbe la quota. Questo **non spegne Run né il costo**:
serve comunque riportare le repliche a zero e verificare l'arresto.

Disconnessione del client cancella il timer e libera lo slot una sola volta.
SIGTERM/SIGINT chiudono listener, connessioni e timer. Limite socket e timeout
di ricezione proteggono anche le richieste con header incompleti; l'attesa
della risposta è distinta dalla ricezione della richiesta.

### Misura esterna

```sh
node scripts/nhost/misura-proxy-staging.js --origine https://ORIGINE-SONDA
node scripts/nhost/misura-proxy-staging.js --origine https://ORIGINE-SONDA --attese
```

TLS verificato; SNI legato all'origine anche quando Host viene falsificato.
Nessun redirect, retry, cookie ricevuto reinviato o credenziale caricata.
Deadline: cinque secondi per prova breve, 75 per attesa, 160 complessivi;
header fino a 16 KiB e body fino a 64 KiB. Output solo codici, status, ID
del processo e tempi, senza body o header.

Le prove lente attendono 55 e 65 secondi **prima degli header**, non inviano
keep-alive applicativi o un body anticipato. Il client misura tempo agli
header e risposta completa: header anticipati falliscono, con tolleranza
massima di 100 ms. Un proxy che conserva le sentinelle non fa fallire la
misura tecnica: è un'osservazione da confrontare col log, non un PASS di
sicurezza. Il report lascia sempre `fiducia_proxy` non verificata.

Host estraneo può essere rifiutato dal routing (403/404/421), senza dimostrare
il guard AMR. Cookie inatteso, istanza cambiata, redirect, body interrotto,
TLS errato o timeout fermano la sequenza; nessun tentativo automatico.

## Debunking del piano

1. **Misurare dall'esterno non basta.** Confermato: il client non riceve peer
   o classificazioni; occorre correlare il report con i log della medesima
   istanza. Nessun IP osservato viene scritto nei proxy attendibili.
2. **Esito positivo non dimostra un proxy sicuro.** Controprova con header
   falsificati preservati: misura completata ma log diverso e trust aperto.
3. **Body completo non prova l'attesa senza flush.** Verificato: risposta
   anticipata o flush iniziale potevano falsare la misura; il client ora
   verifica anche il tempo agli header. Controprove dedicate.
4. **Scadenza del processo potrebbe provocare restart e nuove quote.** Rischio
   condizionato al lifecycle remoto; finestra scaduta con liveness ancora
   valida evita di usare l'arresto automatico come limite di sicurezza.
5. **Peer privato non significa proxy autorizzato.** Distinzione preservata;
   se il peer è pubblico non se ne registra l'IP. In quel caso serve un
   contratto equivalente del provider, non un allargamento alle reti private.
6. **Due riavvii non provano stabilità futura.** Rimane condizionato: il
   campione va integrato con una policy/garanzia del provider prima dei clienti.

## Verifiche locali

Node 24.21.0, ambiente vuoto, dati/log temporanei, dotenv disabilitato.
Test e proxy TLS sintetico non raggiungono Nhost, M2 o portali.

- Ingress esistente + nuova sonda: 17 pass, zero failure, una prova lenta
  opt-in eseguita separatamente.
- Attese reali 55/65 secondi: **1/1 PASS**, circa 120 secondi; nessun flush
  anticipato. Log `/private/tmp/amr-sonda-lenta-20261004.log`.
- CLI Nhost 1.51.2: template con `command` alternativo valido, exit 0;
  comando del tipo errato e rapporto CPU/RAM errato respinti, exit 1.
  Root/HOME temporanei e file `.secrets` vuoto; nessun `service-id`, overlay
  remoto o accesso alle credenziali. La CLI richiede il file anche senza
  riferimenti a segreti: il primo rifiuto non era un bug del template.
- Controprove: privacy con sentinelle, peer pubblico/mapped IPv6, duplicati,
  GET con body, quota/finestra, slot concorrenti, abort/arresto, TLS, redirect,
  cookie, risposta grande/interrotta, istanza diversa e falsa attesa.

Suite completa: **1.353 casi, 1.347 pass, zero failure, sei skip opt-in**.
La prova lenta nuova è stata eseguita separatamente; gli altri gate opt-in non
sono compresi in questo conteggio. Log `/private/tmp/amr-sonda-suite-20261004.log`.

Review indipendente in sola lettura: due imprecisioni documentali confermate
e corrette. Un timer non garantisce un limite superiore preciso; un timeout
del client non attribuisce automaticamente la causa all'ingress. Nessun
ulteriore difetto di sicurezza confermato nel nuovo codice. Il conteggio della
suite è una prova del main, non una suite indipendente duplicata dal reviewer.
Controllo dell'immagine/entrypoint da registrare dopo la conclusione.

## Prossimo gate remoto da autorizzare

Usare il servizio staging fermo per la sola sonda, senza DB/Auth/volume/nodi.
Prima: ricontrollare stato e costo nel dashboard, registrare digest e
configurazione reversibile. Poi avvio temporaneo con una replica e sola porta
3000 HTTPS; misura breve/lenta, raccolta dei soli log filtrati, pausa completa,
nuovo avvio e confronto. Infine tornare a zero repliche e verificare arresto.
Se il servizio contiene già un'app, segreti o volumi, fermarsi e rivalutare
il perimetro anziché sostituirlo automaticamente.

Stop se cambiano istanza durante la sequenza, peer/header restano ambigui,
non si riesce a confermare l'arresto o si perde la risposta lenta. Il fallimento
della prova `attesa_65` va interpretato usando durata, status e codice:
distinguere la deadline client di 75 s dal comportamento dell'ingress e
correlare i log. Non certifica o invalida da solo le ricerche, che hanno una
deadline end-to-end di 60 s. Il poll worker (4 s) va
collaudato separatamente prima di collegare un nodo reale.

Nessun avvio cloud, upload, migrazione, cambiamento dei guard, produzione M2,
scraper, credenziale o processo manuale sono parte di questo incremento.

## Fonti autorevoli

- [Nhost Run e command](https://docs.nhost.io/products/run/local-development):
  comando alternativo e configurazioni separate; validazione locale non deploy.
- [Nhost networking](https://docs.nhost.io/products/run/networking): porta
  HTTP pubblicata distinta dal collegamento privato dello stack.
- [Nhost risorse](https://docs.nhost.io/products/run/resources): pausa a zero
  repliche e storage; scadenza della sonda non equivale a pausa del servizio.
- [Express reverse proxy](https://expressjs.com/en/guide/behind-proxies/):
  trust coerente col percorso reale, header client non presunti attendibili.
- [Node 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html):
  rawHeaders, timeout di ricezione, abort client, close e closeAllConnections.
- [Node sicurezza](https://nodejs.org/learn/getting-started/security-best-practices):
  limiti alle risorse e timeout espliciti. Non richiede un nuovo framework.

Le fonti motivano i criteri, non garantiscono i tempi o il peer nel nostro
servizio remoto. La misura Nhost effettiva resta da eseguire e autorizzare.
