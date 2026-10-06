# Sonda ingress dello staging — 6 ottobre 2026

## Perimetro ed esito

Sola sonda temporanea autorizzata sul servizio `amr-centro-staging`, progetto
Nhost AMR. Il processo della sonda non carica Auth, PostgreSQL, nodi o scraper;
ambiente vuoto, volume preservato e non letto. Dodici GET brevi, nessuna
credenziale o dato di annunci nei report. Non coinvolto l'M2.

La sonda ha concluso le misurazioni, ma il primo executor **non ha confermato
l'arresto** entro il proprio limite interno di 150 secondi. Ha registrato
`ok:false`, `ripristino:false`, `arresto_non_confermato`, senza dichiarare
un rollback riuscito. Il limite esterno di 240 secondi non allungava quello
interno. Non è dimostrata la causa del ritardo del provider.

Una lettura successiva ha verificato configurazione esatta a zero repliche,
nessun pod e indisponibilità dell'endpoint. Un recupero separato e vincolato
alla configurazione della sonda ha poi ripristinato l'originale `66e2b24`.
Ricevuta del **6 ottobre, 21:53:26 UTC**: configurazione originale esatta,
una replica Running/ready, `/healthz` 200, `/` 200, `/api/admin` anonima 401.
È un campione di ripristino effettivo, non un collaudo login/MFA.

Ricevute temporanee, entrambe 0600:

- `/private/tmp/amr-sonda-ingress-esito-20261006.json`;
- `/private/tmp/amr-ripristino-sonda-esito-20261006.json`.

## Evidenza del 403

Le dodici risposte, dalla stessa istanza della sonda, mostrano due peer TCP
privati: `10.110.6.3` (sette) e `10.110.18.147` (cinque). La precedente lista
pubblica della procedura comprendeva `10.110.6.3` e `10.110.4.24`.
Il valore attuale del segreto non è stato nuovamente letto.

Controprova locale con il modulo `trasporto-prova.js` di `66e2b24`, Host
corretto e `X-Forwarded-Proto:https`: con quella vecchia lista il primo peer
passa e il secondo riceve 403. La sonda separata non applicava questa guard.
È quindi verificato un meccanismo compatibile con l'intermittenza; **non**
è attribuito ogni 403 storico, né dimostrato che il valore runtime fosse
ancora identico alla vecchia lista.

Host e proto risultano attesi anche nelle prove con header sentinella.
`Forwarded` sentinella sopravvive in quattro richieste, ma AMR non lo usa
per questa guard. Le classificazioni `altro` di XFF/X-Real-IP non distinguono
sostituzione da append: non attestano un contratto sicuro per quei campi.
Nessun valore grezzo di tali header è registrato.

## Decisione ancora necessaria

La documentazione [Nhost networking](https://docs.nhost.io/products/run/networking)
consultata non fornisce una lista stabile di IP/CIDR dell'ingress. Il campione
non autorizza ad allargare la fiducia a tutta la rete privata. [Express](https://expressjs.com/en/guide/behind-proxies/)
richiede che la configurazione proxy corrisponda al percorso reale e agli
header gestiti dal proxy.

Proposta sottoposta all'utente: lista esplicita provvisoria **solo nello
staging**, aggiungendo il peer osservato senza togliere Host/Origin, HTTPS,
MFA o i guard. Alternativa: attendere il contratto Nhost prima di proseguire.
Nessuna modifica della lista, dei segreti o delle guard eseguita in questo
incremento. Un eventuale via provvisorio non chiude il gate produzione.

La review indipendente ha confrontato executor, ricevute, identità del
servizio e controprova della guard: nessun ulteriore finding confermato.
Resta necessaria la verifica dell'intero candidato di staging prima dell'M2
`--solo-stato`. Il CHECK storico resta aperto secondo la decisione dell'utente.
