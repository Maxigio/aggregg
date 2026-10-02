# Preparazione del centro AMR — incrementi del 2 ottobre 2026

Richiesta: implementare i quattro passi successivi alla review `fce9319`, con prove,
controprove, review indipendente e commit separati. Nessun deploy, servizio cloud
attivato, accesso M2 o prova live degli scraper impliciti. Lo stack manuale con
l'azienda del proprietario resta intatto. Le modifiche backend richiedono un nuovo
avvio prima di comparire in quel processo.

## 1. Difetti locali del prototipo

### Login — completato

- R01: il contesto browser registra il tentativo prima del provider; logout e
  revoca lo invalidano. Controlli prima e dopo la lettura asincrona dei permessi.
- R05: un login respinto chiude la sessione provider appena ricevuta; il fallimento
  di questo cleanup non sostituisce l'errore originale.
- R06: quota piena ammette la rotazione di una sessione esistente valida.
- Review indipendente: trovata e corretta la cancellazione tardiva del cookie MFA
  di un nuovo login. Test completa il nuovo tentativo dopo la risposta obsoleta.
- Prove: 14/14 test Auth con provider sintetico, preload anti-dotenv; review
  indipendente ripetuta senza altri finding. Nessun uso di credenziali reali.
- Limite: sessioni ancora RAM/loopback; questo fix non realizza il login cloud.

### Coordinamento — completato

- R02: fonte registrata nel job dettaglio; pausa ferma gli accodati, non gli avviati.
- R04: heartbeat serializzati e attesi prima del cambio job. La controprova ha
  mostrato che il timeout locale non impedisce l'elaborazione remota tardiva:
  aggiunto handshake esplicito con epoca del centro, boot del worker e sequenza.
  CAS sul boot precedente; retry registrazione idempotente, senza reset sequenza.
  Poll/esiti del boot sostituito rifiutati. Nessuno storico illimitato dei boot.
- Compatibilità locale: fixture legacy ammesse finché il nodo non è registrato;
  l'entrypoint pubblico dovrà rifiutare il protocollo legacy. Non è un gate cloud.
- R03: composizione nel centro approvata dopo confronto mantenibilità/prestazioni/
  sicurezza. Stessa funzione pura, controllo destinatari, nessun job di composizione.
  La perdita del primario dopo risposta non elimina la porzione recuperata.
- Review indipendente ha individuato e corretto due regressioni del handshake:
  riconferma boot dopo l'await permessi; un 409 di esito scaduto non arresta il worker.
- Suite prototipo: 94/94 test passati, zero skip, provider simulati e preload
  anti-dotenv. Review indipendenti e controprove di composizione senza nuovi finding.

### Lifecycle e Admin — completati

- R07/R08: stop cancella startup e figli; segnali installati prima del primo await;
  cleanup indipendenti e Docker down non cancellato dal segnale di stop.
- R09: elenco distingue azienda scaduta da attiva, coerentemente con autorizzazione.
- R10: refresh conserva focus del pulsante senza spostarlo da input/navigazione.
- Prove lifecycle: 9/9 configurazione e launcher, più review VM indipendente.
- Prova UI: browser headless, un test completo passato; controprove indipendenti
  su focus input, focus esterno e cambio focus durante fetch. Collaudo automatico
  PostgreSQL separato passato: stato scaduta e ricerca negata, oltre alle precedenti
  prove login/MFA, quote, privilegi e inviti. Stack manuale non riavviato.

### Cache — completata

C01: scope aziendale conservato case-sensitive e delimitato come JSON, mentre
la normalizzazione dei filtri resta invariata. Test con `ACME` / `acme` verifica
richieste distinte e riuso nello stesso scope. La review ha trovato anche collisioni
fra delimitatori presenti nei filtri: ora la chiave serializza coppie campo/valore
JSON, senza eccezioni sui surrogate Unicode isolati. 10/10 baseline passati.
R11: autorizzazioni dettagli firmate approvate dall'utente e implementate in un
modulo dedicato. HMAC con chiave per sessione, URL/modulo/azienda e scadenza della
sessione; controllo dei permessi correnti resta prima e dopo il lavoro del nodo.
Nessun elenco URL in RAM, nessuna autorizzazione nei dati persistiti del job.
Copie per destinatario impediscono che una firma modifichi la risposta condivisa.
Il frontend invia la firma soltanto aprendo il dettaglio, con retry esplicito.
Review ha trovato una regressione: la sequenza della paginazione invalidava anche
le card ancora visibili. Ora il completamento è legato alla card connessa: nuove
ricerche/logout rimuovono la card, una pagina fallita invece non la invalida.
Prove: 301 risultati su HTTP, 500 firme unitarie, URL e sessione alterate,
revoca in volo, scadenza esatta, XSS e paginazione durante dettaglio in browser.

## 2. Ciclo commerciale PostgreSQL

Rinnovo/revoca azienda implementati nel collaudo PostgreSQL: default un anno dalla
scadenza futura, altrimenti dalla conferma, con data esplicita modificabile. Revoca
separata incrementa le epoche dei membri: riattivare non resuscita vecchie sessioni.
Operazioni atomiche e idempotenti; retry con parametri diversi rifiutato.
Collaudo PostgreSQL automatico passato, senza riavviare lo stack manuale.
Review UI: corretto riuso di ID dopo revoca/riattivazione/revoca; una mutazione
confermata con elenco fallito ritenta soltanto la lettura. Focus ha un ripiego
stabile quando il controllo scompare. Test browser della sequenza passato.
Ulteriore controprova: commit con risposta persa viene riconciliato usando una
lettura Admin del registro operazioni PRIMA dell'elenco aggiornato. Questo evita
sia riuso di vecchie revoche sia un doppio rinnovo dopo una lettura obsoleta.

Da completare: inviti colleghi con prenotazione dei posti, revoca membri/inviti
pending, cambio referente riservato al proprietario e gestione sessioni. Non dichiarare i metodi
SQLite sintetici come implementazione commerciale. Riutilizzare funzioni atomiche
con ruoli ristretti, controllo identità/epoca dentro la transazione e quote esistenti.

## 3. Backup

Decisione dell'utente: backup open source + storage gestito, sostituisce OneDrive.
Candidato: restic + endpoint S3 separato (R2 Standard in giurisdizione UE).
Prima verificare restore locale; poi collaudo storage reale con configurazione del
proprietario, senza leggere credenziali in chat. Nessun account/bucket attivato.

Primitiva restic collaudata con binario ufficiale 0.19.1 verificato SHA256, due
repository locali separati e dati sintetici: copia, check con lettura dei dati,
restore verificato byte per byte. Output del processo e percorsi sensibili non
propagati all'API. Restore in directory nuova, mai sopra il database vivo.
Questo non prova ancora pg_dump/pg_restore, outbox transazionale, retention e S3.
Non configurare lifecycle di cancellazione sugli oggetti del repository restic.

- restic cifra repository lato client; password va custodita fuori dal repository.
- R2: 10 GB-mese / 1 milione operazioni A / 10 milioni B inclusi; oltre soglia
  costi a consumo. Standard, non Infrequent Access. Gratuità non garantita.
- S3 compatibile non significa tutte le operazioni S3 supportate; prova sul provider
  necessaria. Backup riuscito non significa ripristino provato.
- Da implementare: journal 90 giorni e 14 copie DB giornaliere separati; errore persistente Admin,
  senza annullare l'operazione commerciale già confermata.

Fonti ricontrollate: [restic](https://restic.net/),
[cifratura](https://restic.readthedocs.io/en/stable/070_encryption.html),
[retention](https://restic.readthedocs.io/en/stable/060_forget.html),
[R2 listino](https://developers.cloudflare.com/r2/pricing/),
[R2 S3](https://developers.cloudflare.com/r2/api/s3/api/),
[R2 giurisdizioni](https://developers.cloudflare.com/r2/reference/data-location/).

## 4. Entrypoint e staging

Ancora da implementare/collaudare: persistenza, HTTPS, compatibilità release/cataloghi,
revoca credenziali nodo, deadline, riavvio e restore. Nessun coinvolgimento M2.
Le prove locali non certificano proxy, SMTP o prestazioni remote.

## Verifica complessiva corrente

100/100 test `nodi-*` passati, zero skip, con provider sintetici, repository restic
temporanei e preload anti-dotenv. I test SQLite commerciali restano prove sintetiche;
non sostituiscono il collaudo PostgreSQL né il gate cloud.

Comando della run (binario restic di prova esplicito, nessuna configurazione reale):

```sh
AMR_TEST_RESTIC=/private/tmp/amr-restic-0.19.1/restic NODE_OPTIONS=--require=./test/no-dotenv-preload.cjs node --test test/nodi-*.test.js
```

Log locale: `/private/tmp/amr-incrementi-suite4.log`. Collaudo PostgreSQL automatico
separato: `/private/tmp/amr-rinnovi-pg2.log`. Questi log temporanei non sono un
artefatto di rilascio permanente. Il binario esplicito evita skip restic; il suo
SHA256 è stato verificato nell'approvvigionamento, non dal wrapper runtime.

## Review successiva del branch, senza fix — HEAD 30a1f12

La [review del 2 ottobre](branch-nodi-2026-10-02-30a1f12.md) ricostruisce i 26
commit dalla base, verifica decisioni e percorsi, e registra 13 difetti riprodotti
e due limiti operativi prima del remoto. Le etichette “completato” sopra descrivono
gli incrementi e i loro casi verificati; non significano che l'intera area sia
priva di altri difetti o pronta alla produzione.

Nuove prove: suite intera 1.025/1.025, nodi 100/100, PostgreSQL/Nhost locale
separato, browser con API simulate e fault injection, tre review indipendenti.
Nessun commit, deploy, accesso M2, riavvio del collaudo manuale o nuova chiamata
ai portali. Rimangono da completare ciclo commerciale, backup integrato,
entrypoint pubblico e integrazione di tutte le funzionalità Auto/Moto dell'app.
# Incrementi successivi alla review del 2 ottobre

## F01 — cursori per fonte, risolto

Il centro rimuove i cursori Subito dal payload del primario quando non gli assegna
Subito; il worker fa altrettanto per le operazioni `fonte` delle altre piattaforme.
Il parser resta invariato e i cursori Subito richiesti sono conservati.
Il nuovo test distribuito falliva con HTTP 400 prima del fix; dopo il fix passano
entrambi gli ordini delle fonti. Suite pertinente: 18/18. Review indipendente:
nessun finding confermato aperto. Prove simulate, nessun portale o M2 interrogato.
