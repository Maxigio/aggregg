# Sonde automatiche delle fonti — 7 ottobre 2026

Punto 2 dell'ordine concordato, su `feat/nodi-residenziali-prototipo`, base
`9728469`. Implementazione e prove locali. Nessun deploy, collegamento M2 o
richiesta reale ai portali; `.env`, credenziali e dati applicativi preservati.

## Decisioni

- Alla scadenza della pausa il centro avvia una sonda anche senza ricerche
  degli utenti. Attende il primo heartbeat con nodo libero, online,
  compatibile e autorizzato. Manutenzione e sospensioni manuali la impediscono.
- Una sola query Auto per le fonti condivise Subito e AutoScout24:
  Alfa Romeo / Giulietta / Veloce. Per Moto.it: Fantic / Caballero 500 / Rally.
  Una risposta valida basta, anche vuota. La sonda riapre la fonte sul nodo;
  non certifica tutti i filtri, modelli o i due percorsi Auto/Moto.
- Conservate le pause 15 minuti, un'ora e sei ore per blocchi reiterati.
  Un timeout/errore generico conserva almeno 15 minuti; `Retry-After`
  più lungo prevale. Cinque tentativi per episodio, poi intervento.
- Credenziale rifiutata o formato strutturalmente incompatibile: intervento
  immediato. Un errore GraphQL generico non prova un cambio di schema.
- Per decisione già concordata, Subito senza `ads` resta un elenco vuoto.
  Non viene introdotta una validazione che contraddica quel contratto.

## Percorso implementato

`worker.js` abilita questa policy soltanto per i worker reali operativi.
Il monolite conserva la verifica su richiesta; worker simulato e `soloStato`
non annunciano né eseguono sonde automatiche.

`fonti-salute.js` conserva il tentativo e l'intervento in due colonne tecniche
append-only del database locale della salute. Prima della rete scrive il
tentativo consumato e una pausa di sicurezza: un arresto non azzera il budget.
Un guasto nella scrittura impedisce la sonda. Un solo contesto in volo può
verificare quella fonte; le ricerche ordinarie attendono la verifica.

Il centro usa il percorso esistente heartbeat → coda → poll → esito, senza
nuove API pubbliche o scheduler esterni. La sonda è legata a quel nodo e non
viene riassegnata a un altro IP. Un heartbeat identico non replica il lavoro;
una sonda mai consegnata può essere riaccodata dopo la sospensione. I lavori
consegnati seguono il trattamento già previsto per gli esiti incerti.

`sonde-scenari.js` contiene solo i tre preset; `sonde-fonti.js` risolve i
cataloghi locali e chiama il parser reale della fonte. Una pagina, senza
recupero «Altro modello», retry cache, menu remoti o altre fonti. Le sei
versioni annuali Rally sono risolte localmente e filtrate nella stessa query
Moto.it, senza scegliere arbitrariamente un anno o fare sei chiamate.

La sonda ha il budget residuo dei 30 secondi del job, con un secondo riservato
all'invio dell'esito. Si misura con clock monotono centrale, trasferendo una
durata; non si confrontano gli orologi di due macchine. Il worker annulla alla
deadline o alla disconnessione. La salute ricontrolla l'annullamento prima
di riaprire: un parser che termina tardi non può dichiarare il successo.

Al centro arrivano solo fonte, stato, tentativi, motivo tecnico dell'intervento
ed eventuale status HTTP. Nessun annuncio, body o descrizione viene conservato
in questa diagnostica. I lavori/eventi riusano retention e cap esistenti.
Il frontend attuale distingue attesa, sonda in corso e intervento necessario,
con eventi di riuscita/fallimento; questa è osservabilità dell'incremento,
non l'avvio del redesign del punto 8.

## Review, prove e controprove

- Risposta valida vuota, unicità della prova, query native corrette e una
  sola chiamata per ognuna delle tre fonti con trasporti simulati.
- Cinque fallimenti e sesta chiamata negata; due processi figli arrestati
  alla prima/quinta ammissione provano il recupero del budget dal disco.
- 403 senza doppio incremento, timeout e `Retry-After` lungo, auth/formato,
  rifiuto locale distinto da una nuova risposta del portale.
- Manutenzione/sospensione prima della consegna, completamento già avviato,
  simulato/solo stato esclusi, heartbeat duplicato e nessun utente presente.
- Percorso reale centro → codice worker → operazione → parser Hades simulato
  → esito → heartbeat della riapertura, senza invocare i portali.
- Test UI headless su HTTP loopback: attesa/in corso/intervento distinti e
  `soloStato` senza disponibilità inventata. Nessuna preview aperta all'utente.

Finding verificati e corretti durante la review:

1. Risposta tardiva dopo abort riapriva la fonte: aggiunti deadline della sonda
   e controllo del segnale prima dello sblocco.
2. Errori GraphQL generici classificati come formato: rimossa l'inferenza;
   restano errori, con prove distinte per errore di esecuzione e schema invalido.
3. Un 429 concorrente invalidava il token ma l'esito dichiarava riuscita:
   la risposta ora dichiara la pausa ancora attiva.
4. Lo stesso caso durante la quinta prova permetteva la sesta senza riavvio:
   budget verificato anche all'ammissione e intervento nel ritorno normale.

Review indipendente finale in sola lettura: nessun altro finding confermato,
13/13 prove mirate e controprove sul budget. La successiva prova completa
centro/worker porta il file dedicato a 14 casi. Ricevute del gate pertinente
in `/private/tmp/amr-sonde-gate-20261007-p5sptjtz/finale.tap`; ambiente minimo,
Node 24.21.0, dati/log temporanei, dotenv escluso e guard delle richieste HTTPS.
Gate pertinente di 39 file: **486/486 pass**, zero skip/cancelled/fail.
UI headless mirata: **2/2 pass**. I gruppi sono distinti; non è la suite completa.

## Limiti e passi successivi

Non è una prova live di ripartenza né il collaudo Auth completo del candidato.
Il circuito è locale al processo/database: non coordina ancora i due processi
che condividerebbero l'IP dell'M2. Quello resta un gate prima del live M2.
La verifica si rimanda se il nodo è occupato o scollegato; non opera senza un
worker disponibile. Per il rilascio servono centro e worker della release
compatibile, un backup aggiornato e il gate remoto già concordato.

Il frontend non aggiunge un comando per cancellare le pause automatiche.
L'intervento non scompare con un restart: richiede correggere la causa e
riabilitare esplicitamente la fonte. Il comando CLI `azzera` preesistente
resta invariato nel ruolo; eventuali controlli UI appartengono al punto 6.

Prossimo punto: definire tramite interview i restart automatici dei worker.
CHECK storico, gate remoto/M2 e frontend nuovo restano nell'ordine concordato.

Riferimenti verificati: [Microsoft, Circuit Breaker](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)
per verifica limitata e distinzione dei fallimenti;
[RFC 9110, Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)
per l'attesa richiesta dal server. Cinque prove e preset sono decisioni AMR,
non valori prescritti da queste fonti.
