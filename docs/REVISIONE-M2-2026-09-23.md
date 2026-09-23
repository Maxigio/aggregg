# Revisione AMR per l'M2 — 23 settembre 2026

Riferimento: branch `feat/ui-redesign-rating-grouping`, HEAD iniziale
`2e8dbbd1ad183b2d0f8b11f3db99686fb3152d30`. Questo registro riguarda
l'aggiornamento del servizio esistente sull'M2. Installer, licenze e client
commerciali hanno un rilascio distinto. Nessun commit o deploy è stato eseguito
durante questa revisione.

## Baseline e isolamento

- Il dev server usa la porta 47350 e una copia di `git archive HEAD` sotto
  `/private/tmp/amr-dev-E2AikL/app`, con `USER_DATA_PATH` e log separati. La
  password della copia è sintetica. Il codice dell'M2 non è stato cambiato.
- L'M2 risponde via SSH; `com.automotoradar.m2` risponde 401 sulla rotta
  protetta `/api/brands`. Questo dimostra soltanto che il gate HTTP è attivo.
- Il confronto `rsync -acn` da HEAD verso l'M2 trova 54 file differenti o
  assenti su 641 nel perimetro. Include `backend/whatsapp/{bot,webhook}.js`:
  appartengono a un lavoro parallelo e non sono stati modificati qui. Il
  confronto è una misura dello scarto, non un trasferimento.
- Nessun contenuto di `.env`, `auth.json`, database, password, chiave o token è
  stato letto nel registro o pubblicato nell'output.

## Difetti e verifiche

| Punto | Prova prima | Stato del codice locale | Rilevanza M2 |
|---|---|---|---|
| B02, auth semanticamente invalida | JSON `null` era trattato come file assente | `load()` rifiuta valori privi di salt/hash/secret; test negativo e riparazione | Alta: chiude il gate in caso di file presente ma rotto |
| B02, file valido poi sparito | Test nuovo: `stato()` tornava `assente` | Il percorso già configurato resta in stato `illeggibile`; prova HTTP 401 → 503 → 401 | Alta: evita apertura runtime dopo cancellazione |
| B03, risposta dettaglio interrotta | Promise appesa e retry riutilizzava l'in-flight | Gestiti error/aborted/close del body; test fa partire un secondo fetch | Alta per disponibilità del dettaglio |
| B01, collisione credenziali | `utenti-da-env` poteva copiare owner con la password di un iscritto web remoto | Preflight delle password e degli ID web prima di scrivere localmente; test conserva byte identici su errore | Script amministrativo, non invocato dal deploy ordinario. **Resta la corsa** fra lettura remota e `scp`; non usare lo script per sincronizzazione concorrente finché non è coordinato sul destinatario |
| Aste sperimentali | Rotte e scheduler erano montati anche sul servizio M2; una prima soluzione nascondeva l'HTML solo su `/` | Opt-in `AMR_ASTE_LOCALE=1`, UI inserita solo dinamicamente, API/scheduler spenti per default. Test su `/`, `//index.html`, `/%69ndex.html`, due API e opt-in positivo | Alta per il perimetro richiesto: sul servizio M2 il flag deve restare assente |
| B05, timeout Ricambi | Il timeout di `Promise.race` interrompe l'attesa ma non necessariamente il produttore | **Aperto**: la prova non dimostra un leak permanente per ogni fonte. Richiede misure e cancellazione per fonte prima di dichiararlo risolto | Media, da valutare prima del gate se i timeout sono frequenti |
| B04/B06/B07 | Readiness Electron, revisione Chromium, Node 20 nel manifest | **Non affrontati in questo giro** | Fuori dal servizio launchd M2; gate separato del prodotto clienti |

## Prove funzionali eseguite

La suite completa è stata eseguita sulla copia isolata con dati sintetici:
**886 test passati, 0 falliti, 0 saltati**. `git diff --check`, `bash -n`
e i controlli sintattici dei moduli modificati sono verdi.
I test coprono anche stati vuoti, parziali, bloccati e risposte interrotte delle
fonti con fixture. Non equivalgono a una garanzia sui portali live.

| Area | Campione controllato | Limite |
|---|---|---|
| Auto | `Fiat 500`: 211 righe; Subito e AutoScout `ok` | Un campione, non tutte le marche/fallback |
| Moto | `Ducati Monster`: 700 righe; Subito, AutoScout e Moto.it `ok`; Subito dichiara il limite di 8 famiglie su 15 | Parzialità nota, non risultati completi |
| Ricambi | `faro ducati monster`: 48 righe da Subito; eBay ha risposto `ok` con 10 articoli in una prova, ma nella ricerca UI successiva ha dichiarato `error` per HTTP 403 | Fonte eBay intermittente; nessun successo garantito. Modi OEM/prodotto e dettagli lazy non collaudati qui |
| Competitor | Un venditore Subito sintetico: 357 veicoli, nessun troncamento dichiarato; secondo giro da cache | Non valida tutti i portali e i gruppi |
| Interfaccia | Login sintetico; Auto Fiat 500 (211 risultati, dettaglio apribile); Moto Ducati Monster 821 (239 risultati); Ricambi (48 e avviso eBay 403); Competitor (357 veicoli dopo «Scarica il parco»); Aste assente per default | Campioni, non tutte le combinazioni e i fallback |
| PDF | `/api/report-pdf` su una riga sintetica: HTTP 200, PDF a una pagina | Impaginazione dei dati reali non verificata visivamente |

Nel campione Fiat 500 la UI mostra anche titoli di ricambi, altri modelli e
prezzi simbolici (per esempio €1). L'aggregazione riflette i dati delle fonti:
il conteggio di 211 non equivale a 211 veicoli comparabili né a un prezzo di
mercato. Prima di usare quei numeri per confronti commerciali occorre decidere
come segnalare le righe dubbie senza cancellare annunci che hanno un titolo
generico ma metadati corretti.

## Backup e rilascio

Il blocco di backup in `scripts/deploy-m2.sh` ora include `node_modules` e
fotografa ogni `data/*.db` con `sqlite3 .backup`, controllando
`PRAGMA integrity_check`. I WAL/SHM nell'archivio sono vuoti. Il blocco è stato
provato su due database sintetici e poi eseguito **da solo** sull'M2, senza
trasferimento di codice: archivio
`/Users/massimo/AutoMotoRadar-backup-20260923-0408.tar.gz`, 217 MB. Una
riestrazione separata sull'M2 ha verificato presenza di auth e dipendenze e
integrità del database ripristinato (`RESTORE_OK`). Non è stata sostituita
l'installazione viva.

**Gate ancora chiuso.** Lo script di deploy sincronizza file nell'installazione
in esecuzione, aggiorna `node_modules` sul posto e conclude soprattutto con un
401 e hash dei file. Il backup ora è completo, ma la procedura non prova la
compatibilità dei flussi autenticati né effettua rollback automatico se
installazione o smoke test falliscono. Prima del rilascio occorrono:

1. revisionare e congelare un commit candidato senza incorporare il lavoro
   WhatsApp parallelo per errore;
2. collaudare codice e dipendenze del **commit** candidato in un ambiente
   pulito, inclusi browser, moduli Auto/Moto/Ricambi/Competitor ed export;
3. definire ed esercitare il passaggio a servizio fermo, con ripristino di
   codice, dipendenze e dati dallo stesso backup se fallisce un controllo;
4. dopo il rilascio, provare autenticazione autorizzata e negata, ricerche
   rappresentative e identità dei file effettivamente distribuiti.

Fino a quel punto la suite verde e il backup ripristinabile **non** autorizzano
da soli l'aggiornamento dell'M2.
