# CHECK intermittente e collaudo Auth — 6 ottobre 2026

## Esito

Segue il [registro dei fix del branch](branch-nodi-fix-2026-10-06.md).
Baseline `503fa21`, branch `feat/nodi-residenziali-prototipo`.
Il collaudo Auth completo sull'ultimo runner passa. È corretto un difetto
della fixture di heartbeat, distinto dal CHECK storico. La causa degli
episodi `23514` resta **non dimostrata**: il gate di rilascio resta aperto.

Nessun deploy, accesso M2, modifica dell'orologio/VM o richiesta ai portali.
Ambiente Node 24.21.0, PostgreSQL 18.6 e Nhost Auth 0.49.1 locali;
credenziali generate dalla fixture, dati temporanei, `.env` reale escluso.
Auth cloud 0.52.0 non è certificato da queste prove.

## Diagnosi del CHECK

La review delle funzioni effettivamente chiamate conferma che accettazione
e attivazione campionano `clock_timestamp()` dopo i lock. La scadenza
dell'invito viene ricontrollata con lo stesso istante scritto nell'UPDATE.
Il solo tempo trascorso in attesa del lock non spiega i due CHECK osservati.
Le relazioni di ordine fra creazione, accettazione e attivazione restano
sensibili a timestamp precedenti nel futuro o a un arretramento dell'orologio.
Sono condizioni possibili, **non cause attribuite ai fallimenti storici**.

Il catalogo del cluster posseduto dal collaudo conferma questi vincoli:

- `aziende_inviti_check`: scadenza successiva alla creazione;
- `aziende_inviti_check1`: persona e accettazione presenti insieme;
- `aziende_inviti_check2`: accettazione fra creazione e scadenza;
- `aziende_prova_stato`: coerenza dello stato aziendale e ordine temporale.

Un campione completo di 1.500 letture di `clock_timestamp()` non rileva
arretramenti. Un precedente campione da 40.000 letture è stato interrotto
dal cleanup prima della restituzione del riepilogo: **non è un risultato**.
Le letture dei servizi della VM mostrano timeouts NTP, senza dimostrare
un salto all'indietro nel fallimento. Nessun servizio o clock è stato cambiato.

Due trigger temporanei osservano tre booleani di ordine/scadenza/stato,
restituendo `NEW` inalterato. Il collaudo strumentato passa senza `23514`
né NOTICE temporali. Non copre tutte le parti del CHECK aziendale e modifica
la strumentazione della fixture: non sostituisce il giro non strumentato.

Per chiudere la causa serve osservare il prossimo rifiuto con il nome esatto
del vincolo e le relazioni violate, senza valori personali. Non vengono
rimosse le CHECK, falsificati timestamp con `greatest()` o aggiunti retry
automatici per trasformare un errore intermittente in un PASS.

## Difetto riprodotto della fixture

Un giro completo dell'ultimo runner precedente termina con 409, atteso 204,
nella verifica dell'azienda scaduta in coda. Durante `docker exec`/SQL il
nodo sintetico non invia heartbeat; oltre sei secondi poll e watchdog lo
considerano disconnesso. Il centro applica correttamente la propria policy.
La prima patch con solo heartbeat dopo SQL non basta: il watchdog può già
avere tolto il lavoro, rendendo l'esito 503 invece del 403 aziendale atteso.

Correzione limitata al runner: heartbeat seriali ogni 500 ms durante SQL;
timer fermato, attesa svegliata e heartbeat in corso atteso nel `finally`.
Un errore SQL resta prioritario se fallisce anche l'heartbeat; un errore del
solo heartbeat non viene ignorato. Nessuna modifica ai limiti del nodo,
alle autorizzazioni, alla query di scadenza o al runtime dell'app.

La regressione usa il centro reale via HTTP, pilotando solo il watchdog
lessicale e i timer heartbeat del frammento del runner. Il clock iniettato
avanza 3.500 + 3.500 ms; ogni heartbeat viene atteso prima del watchdog.
La versione corretta produce 204 al poll e 403/interrotto senza annunci;
togliere gli heartbeat durante SQL produce il 503 originale. Timer globali
e trasporto HTTP restano reali. Le prime fixture con salto istantaneo o
clock accelerato avevano una race di fase/carico; sono state sostituite.
Ulteriori controprove verificano cleanup e causa con errore SQL, heartbeat
e entrambi, oltre all'attesa di un heartbeat ancora pendente. Togliere
`clearTimeout` fa fallire il caso SQL interrotto prima del tick; un timer
già scattato viene invece rimosso dal mock, come nel comportamento reale.

## Ricevute

- Primo giro completo: `/private/tmp/amr-auth-check-20261006-lyrfmb/collaudo.log`,
  exit 1 per heartbeat della fixture; nessun `23514` in questo giro.
- Giro strumentato: `/private/tmp/amr-auth-check-final-8QxNvi/collaudo.log`,
  exit 0; sorgente con la sola prima patch post-SQL, non il loop finale.
- Catalogo e clock: `/private/tmp/amr-clock-campione-rEaKBy/esito.txt`.
- Regressioni finali: `/private/tmp/amr-runner-regressioni-finali-VoRNZc/test.tap`,
  16 test, 15 pass, uno skip PG opt-in. Quella contesa è esercitata anche
  dal giro Auth completo; non si sommano conteggi sovrapposti.
- **Ultimo runner, non strumentato:**
  `/private/tmp/amr-auth-runner-ultimo-vXwBjP/collaudo.log`, exit 0,
  SHA-256 sorgente `7b2d9a7524a0244f1ce19762669307a63a79e581a787bfc47f73a731a0fc9b88`
  identico prima/dopo. Login, email, MFA, ruoli, inviti, quote concorrenti,
  rinnovi, revoche e autorizzazioni del centro completati. Nessun `23514`.

Cleanup verificato dopo ciascun giro completo: gli otto container estranei
restano identici. Questo gate non include nuova immagine centro, backup,
restore remoto o ingress Nhost: sono prove distinte. La suite generale
storica e i controlli manuali rimangono nel registro precedente.
Review indipendente in sola lettura: corretta la race della prima regressione;
il loop non cambia il runtime e mantiene prioritario l'errore SQL.

## Fondamento e prossimo gate

[PostgreSQL: funzioni temporali](https://www.postgresql.org/docs/18/functions-datetime.html)
distingue wall clock, inizio statement e inizio transazione. Non documenta
`clock_timestamp()` come orologio monotono.
[Campi degli errori PostgreSQL](https://www.postgresql.org/docs/18/protocol-error-fields.html)
permette di osservare SQLSTATE e vincolo senza pubblicare il detail.

Prima del rilascio: attribuzione del CHECK; candidato immutabile e schema
append-only; gate ingress e aggiornamento/rollback staging. La diagnostica
remota richiede il suo perimetro autorizzato; le prove locali non lo ampliano.

## Decisione sul collaudo controllato — 6 ottobre, giro successivo

L'utente autorizza a proseguire con staging e M2 **solo stato**, mantenendo
aperto il finding storico del CHECK non attribuito. Non è un'autorizzazione
alla produzione né una dimostrazione che il difetto sia risolto.
L'ultimo Auth completo locale passa; un errore `23514` sul candidato deve
restare un fallimento esplicito, senza retry automatici o modifiche dei vincoli.
Ingress, identità del candidato, migrazioni append-only, backup ripristinabile
e preservazione della produzione M2 restano condizioni del collaudo remoto.
