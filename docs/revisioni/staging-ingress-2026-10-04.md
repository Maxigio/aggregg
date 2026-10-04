# Staging Nhost: preparazione del controllo ingress — 4 ottobre 2026

## Perimetro e direzione

Baseline `43c4511`, candidato applicativo precedente `b1d9d6d` già collaudato.
Il prossimo gate è l'ingress remoto, non un altro refactoring del runtime.
Questo incremento prepara il controllo esterno riutilizzabile e lo inserisce
nel gate dell'immagine esistente. Non configura né avvia Nhost.
Checkout condiviso e modifiche preesistenti preservati; M2 e portali esclusi.

La verifica del piano ha distinto due osservazioni diverse:

1. Il client può verificare TLS, risposta delle rotte, dinieghi, cookie e
   comportamento rispetto a header falsificati.
2. Il client non può conoscere `req.socket.remoteAddress` dentro Run, né
   dimostrare la stabilità di quel peer dopo un aggiornamento del provider.

Un controllo esterno superato non autorizza quindi a inventare gli IP
attendibili. Il runtime HTTP richiede una lista esplicita in
`backend/nodi/config-centro-run.js`; `trasporto-prova.js` confronta il socket,
Host e un solo `X-Forwarded-Proto: https`. `/healthz` aggira intenzionalmente
questi guard ed è soltanto liveness.

## Implementazione

[`scripts/nhost/collauda-ingress-staging.js`](../../scripts/nhost/collauda-ingress-staging.js)
usa `node:https`, senza nuove dipendenze. La CLI richiede un'origine HTTPS
esplicita, senza credenziali, percorso, query o fragment:

```sh
node scripts/nhost/collauda-ingress-staging.js --origine https://INDIRIZZO-STAGING-NHOST
```

Il comando è da eseguire soltanto contro lo staging autorizzato e disponibile.
Non segue redirect, non fa retry, non carica `.env` e non legge account locali.
Non invia password, MFA, token del nodo o cookie precedenti; il cookie di
bootstrap ricevuto non viene reinviato. Il bootstrap usa `{}`, non
`{login:true}`, e non prepara un login o interroga il provider.

Sono al massimo **15 richieste sequenziali**. Stop al primo controllo fallito;
deadline di cinque secondi per richiesta e 60 secondi complessivi. Header fino
a 16 KiB, body fino a 64 KiB, TLS sempre verificato. Sono limiti della sonda,
non modifiche ai limiti di ricerca, detail o trasporto dei nodi.

| Controllo | Condizione richiesta |
| --- | --- |
| `/healthz` | 200, `ok`, no-store, nessun cookie |
| `/api/test/config` | 200, modalità Nhost, nessun cookie |
| Identità, Admin, backup e ricerca anonimi | 401 esatto, nessun cookie |
| Registrazione nodo senza token | 401 esatto, nessun cookie |
| Login sintetico con Origin/body corretti | 404, nessun cookie |
| Header forwarded falsificati | Config positiva e Admin anonimo ancora negato |
| Bootstrap con Origin corretto | Un solo cookie di contesto, Secure/HttpOnly/Strict, Path=/, senza Domain |
| Bootstrap senza Origin, estraneo o null | 403, nessun cookie |
| Host estraneo | 403/404/421, nessun cookie; può essere un diniego del proxy |

Le risposte ordinarie dei guard devono mantenere no-store, nosniff e HSTS.
La sonda accetta un solo max-age intero positivo (anche quoted), con gli
eventuali flag includeSubDomains/preload univoci; altri formati richiedono
revisione del controllo, non un presunto difetto del runtime.
Un 403 alla config ordinaria è un **FAIL**, non un successo di sicurezza:
potrebbe nascondere un routing o una configurazione del proxy non funzionanti.
Analogamente, un 403 con header falsificati richiede di comprendere il contratto
dell'ingress: non è automaticamente una vulnerabilità o motivo per indebolire
il guard. Il controllo non prova quali header il provider abbia sovrascritto.

L'output JSON contiene solo nomi di controlli, PASS/FAIL, status HTTP,
codici diagnostici fissi e durate. Mai body, header, cookie, URL restituiti o
Error grezzi. Exit 1 per configurazione non valida o prova fallita.

`scripts/collauda-centro-immagine-locale.js` richiama la medesima funzione
prima del login reale della fixture. Conserva le prove di UI, TLS diretto,
Auth/MFA, ricerca, riavvio e backup: non sostituisce il gate con la sonda.

## Verifiche e controprove

`test/nodi-ingress-staging.test.js` collega un proxy TLS locale ai moduli
reali `centro` e `login-nhost-prova`. Identità/provider sintetici registrano
ogni chiamata; la sonda ne produce zero e non crea lavori. Verifica anche CLI
e assenza di sentinelle riservate nell'output.

- Origini HTTP/implicite o URL contenenti credenziali rifiutate prima della rete.
- Certificato non fidato rifiutato; nessuna modalità TLS insicura.
- Redirect non seguito, anche se la destinazione contiene una sentinella.
- Falso 404, cookie non Secure, duplicati o Domain estraneo: FAIL.
- Proxy che sovrascrive Origin del client: FAIL, non falsa prova CSRF.
- Body/header troppo grandi, socket interrotto, deadline e abort: FAIL,
  nessuna prosecuzione o retry.

Un errore verificato nella sonda iniziale derivava dal comportamento Node:
falsificando Host si cambiava anche il `servername` usato per TLS, quindi il
test si fermava al certificato prima di raggiungere il guard. Corretto
fissando SNI all'hostname dell'URL (vuoto per IP), mantenendo la verifica del
certificato. La controprova ora raggiunge il guard Host e il certificato
non fidato continua a fallire. Nessuna modifica ai guard applicativi.

Due fallimenti iniziali non erano bug del runtime: bind localhost vietato
dal sandbox e manifest assente nella nuova fixture. Usata l'approvazione
per i listener locali e aggiunto il manifest sintetico; nessuna regola runtime
allargata. Test mirati ingress/trasporto/Run: **26/26 pass**, zero skip,
Node 24.21.0, dotenv disabilitato, dati/log temporanei.

Le due review indipendenti hanno riprodotto un falso PASS nella prima
validazione HSTS: `max-age=1.5`, un suffisso testuale o max-age duplicati
venivano accettati. Corretto nella sonda, con controprove TLS e numeri
validi/quoted; il runtime emetteva già il valore corretto. Non è una nuova
vulnerabilità dimostrata dell'app. La suite completa e il gate immagine sono
registrati nella sezione finale dopo il loro completamento; non vanno dedotti
dal PASS mirato.

## Passo remoto da concordare

La preparazione client è completa, **il gate ingress remoto è ancora aperto**.
La configurazione pubblicata corrente di Nhost documenta rete/porte HTTPS,
ma non un insieme stabile di peer proxy, la riscrittura degli header o una
deadline ingress garantita per AMR.

Raccomandazione: una prova temporanea, separata dall'app, nello stesso percorso
Run→ingress previsto per il centro, senza PostgreSQL/Auth, account, volume,
token di nodi o scraper. La sonda lato server dovrebbe riportare soltanto
peer del socket e classificazioni finite degli header, mai dump delle richieste;
poi una misura prima/dopo riavvio e una richiesta sintetica ritardata.
Si può riusare l'immagine esistente con un comando alternativo Node/HTTP:
la disponibilità dell'override Run va verificata prima della configurazione.
Questa sonda server **non è stata implementata o avviata in questo incremento**.
Alternativa: ottenere dal provider un contratto equivalente sugli IP e sugli
header. La scelta e l'avvio remoto restano da discutere; nessuna apertura di
fiducia automatica ai peer osservati o a tutte le reti private.

Prima della prima esecuzione dell'app servono anche digest registry, SQL
approvato, login PG minimi, configurazione dei segreti e volume UID 1000.
Il preventivo Run storico era 25 USD/mese per 0,5 vCPU/1 GiB: va riletto nel
form attuale, distinguendo compute, storage, Pro e crediti. Il servizio
preliminare a zero repliche non costituisce autorizzazione a queste modifiche.

Per i tempi, il gate immagine attuale usa 12 secondi al client e 15 al proxy
della fixture: non prova attese di 55/65 secondi nel cloud. Il poll del worker
ha a sua volta un timeout di quattro secondi. Misurare i due contratti,
senza dedurre da una sonda lenta la deadline della ricerca.
Le prove lente proposte sono separate (55 e 65 secondi), con un client capace
di attendere risposta completa e durata; questa sonda da cinque secondi
non le esegue. Peer uguale in due campioni non prova stabilità futura: serve
anche una decisione sulla gestione delle variazioni o un contratto del provider.

## Esiti finali dell'incremento

Review indipendenti concluse: il solo finding confermato nel nuovo controllo
era HSTS, corretto e controverificato. Follow-up: 8/8 test della sonda e
17 controprove indipendenti in memoria, nessun finding residuo.
Suite finale: **1.343 casi, 1.338 pass, zero failure, cinque skip opt-in**,
ambiente vuoto, dotenv disabilitato e dati temporanei. I controlli opt-in non
sono coperti da questo conteggio. Log
`/private/tmp/amr-ingress-suite-finale-20261004.log`; gruppo mirato
`/private/tmp/amr-ingress-focused-20261004.log`.
Il gate immagine aggiornato resta da eseguire dal commit del nuovo strumento;
non lo si deduce dal precedente PASS `b1d9d6d`.

## Fonti ufficiali ricontrollate

- [Express: reverse proxy](https://expressjs.com/en/guide/behind-proxies/):
  fiducia coerente con il proxy effettivo e header sovrascritti.
- [Node 24: HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html):
  timeout non equivale ad abort, limiti e lifecycle del client.
- [RFC 6797](https://www.rfc-editor.org/rfc/rfc6797.html#section-6.1):
  max-age intero e direttive HSTS univoche, non confronto di un prefisso.
- [Nhost Run networking](https://docs.nhost.io/products/run/networking):
  rete privata e pubblicazione HTTP sono configurazioni distinte.
- [Nhost health checks](https://docs.nhost.io/products/run/health-checks):
  sonda `/healthz`, indipendente dalla pubblicazione della porta.
- [Nhost risorse](https://docs.nhost.io/products/run/resources): pausa conserva
  il volume; rinominarlo può distruggerlo e lo storage rimane a pagamento.
- [Nhost CLI](https://docs.nhost.io/products/run/cli-deployments) e
  [listino](https://nhost.io/pricing): configurazione/avvio e costi da verificare
  distintamente, non dalla validazione locale.
