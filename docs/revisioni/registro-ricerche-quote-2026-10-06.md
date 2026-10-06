# Quote del registro ricerche — 6 ottobre 2026

Baseline `2267237`, branch `feat/nodi-residenziali-prototipo`.
Segue la [diagnosi CHECK e il collaudo Auth](branch-nodi-check-auth-2026-10-06.md).
Incremento locale: nessun deploy, accesso M2 o richiesta ai portali.

## Problema verificato e controprova

Il limite delle richieste pendenti non limita gli ID delle operazioni già
terminate. Una persona autorizzata può generare errori rapidi, liberare ogni
posto pendente e occupare il registro globale fino a 1.000 ID. Le nuove
ricerche di altre aziende ricevono quindi 503 `esiti_non_disponibili`.

Riproduzione sul modulo HTTP reale con Node 24.21.0, ricerca sintetica e cap
globale ridotto a tre per rendere il caso breve: tre errori dell'azienda A,
poi B rifiutata. Il retry dello stesso ID non aggiunge esecuzioni. DELETE e
scadenza del body non liberano il registro; la scadenza dell'ID lo libera.
Ricevuta: `/private/tmp/amr-cap-aziende-6nDQQC/esito.txt`.
È un problema di disponibilità, non una lettura degli annunci di un'altra azienda.

## Decisione e implementazione

Valori approvati dall'utente: **50 ID per persona, 100 per azienda**, massimo
globale 1.000. La retention degli ID resta dieci minuti dal termine; un lavoro
in corso occupa già un posto. Il risultato ha il TTL separato esistente di
60 secondi. Errori, abbandoni e ID senza body continuano a contare, preservando
l'idempotenza anche dopo DELETE. Un retry valido dello stesso ID è ammesso
a quota piena e non crea un altro lavoro.

`backend/nodi/ricerche-http.js` conta il registro già limitato, senza aggiungere
contatori o dipendenze. Identità dalla sessione server, azienda dall'esito
verificato dei permessi: il body non sceglie il destinatario della quota.
Due sessioni della stessa persona condividono la quota. Dopo l'autorizzazione
asincrona, cleanup, riconciliazione dell'ID, controlli e inserimento avvengono
senza ulteriori `await`. Anche gli ID scaduti durante la verifica vengono rimossi.

I parametri `maxRegistriPersona` e `maxRegistriAzienda` sono opzioni server-side
del costruttore e richiedono interi positivi; non sono controlli del frontend
né nuove variabili Nhost. Gli altri limiti restano separati: 2 richieste pendenti
per persona, 60 complessive, budget ricerca 60 secondi e 64 MiB globali di body.
Le quote degli ID non dimostrano da sole equità nel consumo dei byte.

Il frontend distingue 429 `troppe_ricerche_registrate` dal limite dei lavori
pendenti e dalle pause dei portali. Avviso:

> Limite temporaneo delle nuove ricerche raggiunto. Attendi prima di avviarne altre; puoi ancora consultare quelle già avviate.

Nessun retry automatico, polling dell'operazione rifiutata o modifica di
`fonti-salute`. Consultazione e retry degli ID ammessi conservano i controlli
correnti dei permessi e l'appartenenza alla sessione originale.

## Prove

- Node 24.21.0, `.env` escluso, dati/log temporanei. Gruppo HTTP/centro/limiti/
  permessi asincroni: **84 test, 84 pass, zero fail/cancelled/skip**,
  `/private/tmp/amr-quote-integrazione-Q1rnFK/test.tap`.
- Casi nuovi: 50 ID della stessa persona fra due sessioni, 100 della stessa
  azienda fra colleghi, nuova azienda ancora ammessa; errori/DELETE/TTL/retry;
  due autorizzazioni concorrenti con ID diversi o uguali; scadenza durante
  autorizzazione lenta; configurazioni invalide. Il cap globale resta operativo.
- Chromium isolato con API simulate: nuovo caso dell'avviso, un POST rifiutato,
  zero GET di polling, nessun annuncio o errore JavaScript. **Un test, un pass**,
  `/private/tmp/amr-id-quote-ui-WSIu7L/test.tap`; non è l'intera suite browser.
- La prima prova nuova falliva perché il verificatore della fixture restituiva
  sempre l'azienda sintetica iniziale. Corretto per usare la sessione passata,
  senza cambiare l'autorizzazione applicativa. Il gruppo mirato è stato ripetuto.
- Review indipendente in sola lettura: nessun finding residuo confermato.
  Controprove su 17 casi VM e due casi UI simulati; il processo principale ha
  poi verificato HTTP reale e il nuovo caso Chromium, con le ricevute sopra.
  I conteggi delle verifiche indipendenti non sono sommati alla suite principale.

## Fondamento e limiti

[OWASP API4, consumo di risorse](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/)
raccomanda limiti delle risorse e delle interazioni per client adeguati al
prodotto. Non prescrive i numeri 50/100: sono valori iniziali approvati per
il collaudo, da misurare nello staging.

Il registro resta in RAM di un solo processo. Il riavvio perde gli ID;
più repliche richiederebbero un coordinamento diverso, non attestato qui.
Queste prove non chiudono la diagnosi CHECK storico, l'ingress remoto,
il restore remoto, il gate APP o il collegamento M2.
