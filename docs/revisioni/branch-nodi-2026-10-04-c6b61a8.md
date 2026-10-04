# Review del branch centro–nodi — 4 ottobre 2026

## Verdetto e perimetro

Branch `feat/nodi-residenziali-prototipo`, origine `81e25ab`, candidato
`c6b61a8`: 65 commit, 139 file interessati, 21.829 aggiunte e 727 rimozioni.
Questi conteggi includono documenti, test e modifiche dell'app: non equivalgono
a una lettura esaustiva di ogni riga dell'intero branch.

Review mirata ai percorsi del centro, worker, Admin, accessi, aziende,
backup/recovery e preparazione dello staging, con due review indipendenti in
sola lettura. I finding sono stati ricontrollati nel codice e con controprove.
Le riproduzioni degli agenti su Node 26.4 sono state ripetute dal main su
Node 24.21.0. Credenziali reali, portali, M2 e mutazioni cloud esclusi.

Il nuovo incremento SQL è verificato localmente e committato. **Sei finding
del branch restano aperti**, tre con condizioni specifiche. Nessuno dei sei è
stato corretto durante questa review. Non dichiarare il centro pronto per i
clienti o sostitutivo dell'intera app AMR sulla base dei PASS locali.

## Incrementi completati

- `cba704d`: profilo PostgreSQL 18, inventario e prove di restore del candidato.
- `c6b61a8`: pacchetto SQL atomico da un solo HEAD, preflight, tre ruoli runtime
  NOLOGIN e collaudo attraverso un installatore senza CREATEROLE.

Il [registro SQL](staging-schema-2026-10-04.md) documenta implementazione,
controprove e limiti. La review indipendente ha rilevato e fatto correggere
una divergenza possibile tra SQL dal checkout e pacchetto da HEAD: ora il
collaudo confronta tutte le impronte prima del primo comando SQL. Nessun
finding residuo confermato nell'incremento dopo questa correzione.

## Decisioni ricontrollate

- Centro e scraper restano separati. Preferenza per una ricerca su un nodo;
  composizione delle porzioni nel centro tramite funzione esistente, senza
  richiedere di nuovo porzioni riuscite né archiviare annunci su disco.
- Salute locale per fonte/nodo e vista centrale; sospensioni manuali additive.
  Failover e retry non devono moltiplicare chiamate già riuscite. Un cambio
  nodo non garantisce una fotografia immutabile del portale.
- Autenticazione centrale Nhost, sessione opaca server-side; autorizzazioni
  correnti da PostgreSQL per azienda e moduli Auto/Moto. Login e validità
  della sessione non sostituiscono il controllo prima della consegna.
- Aziende, inviti, rinnovi e colleghi hanno funzioni e privilegi separati.
  I comandi commerciali già ammessi prima del logout possono concludersi:
  è la policy concordata, non un nuovo difetto di revoca.
- Replay ordinato e completo dei journal, con stop sulle dipendenze mancanti.
  Le prove PG18 confermano il caso di revoca nel dump, audit vuoto e outbox
  eliminata: un journal vecchio non ripristina membership o epoca precedenti.
- Coda e sessioni in memoria: il riavvio perde lo stato secondo la scelta
  concordata. Non sono alta disponibilità. Una replica configurata non è un
  lock distribuito; arresto prima di avvio e rollback restano prove necessarie.
- `/healthz` minimale attesta la risposta del processo, non il funzionamento
  di Auth, PostgreSQL, backup, nodi o ricerche.

La [mappa delle funzionalità AMR](amr-centro-mappa-funzionalita.md) mantiene
separate ricerca/menu/dettagli già collegati e rotte accessorie ancora da
integrare. Il prototipo non va distribuito come app completa senza il gate APP.

## Finding verificati

### L01 — P2: JSON malformato può finire su stderr

Percorso: `backend/nodi/centro.js:534`, parser Express di `/_nodo` senza
gestore dedicato degli errori del body.

**Prova:** richiesta autenticata da nodo sintetico, JSON malformato con
marker di prova: HTTP 400 e marker nello stack su stderr anche in production.
**Controprova:** heartbeat valido, HTTP 200 e nessun log del marker.
Il registro diagnostico SQLite filtrato non è il canale coinvolto; non è
dimostrato un accesso anonimo o un bypass dell'autenticazione del nodo.

**Impatto:** un frammento del body malformato può essere esposto nei log del
processo/provider. Non sono stati usati dati personali reali.
**Proposta:** intercettare gli errori di parsing/dimensione con codici generici
400/413, senza body, `err.message` o stack; verificare anche gli altri parser.
Preservare il trattamento degli errori non appartenenti a questa categoria.

### R03 — P2: assegnazione a un poll già disconnesso

Percorso: `backend/nodi/centro.js:620` fino alla consegna a 652;
`backend/nodi/worker.js:91` interrompe il poll dopo quattro secondi.

**Prova:** due destinatari di una ricerca condivisa, prima verifica revocata
e seconda valida, 2,2 secondi ciascuna. Il poll si chiude prima della fine
delle verifiche, ma il centro toglie il lavoro dalla coda e lo marca iniziato.
Non viene consegnato; il heartbeat successivo lo rende incerto e il
destinatario valido riceve 504. Nessuna chiamata al portale nella prova.
**Controprova:** poll ancora connesso, consegna e risposte HTTP 200.

**Proposta:** verificare la connessione della risposta prima di rimuovere il
lavoro dalla coda e marcarlo iniziato; coordinare il budget delle verifiche
con il timeout del poll. Non usare indiscriminatamente `req.destroyed` come
prova di disconnessione, non eliminare i controlli dei permessi e non
assegnare automaticamente a un altro nodo un lavoro dall'esito incerto.
Verificare anche il rischio di attese ripetute senza avanzamento della coda.

### U05 — P2: ampliamento del filtro versione non dichiarato nella UI

Percorso: `frontend/nodi-prototipo.js:375`; metadati dal coordinatore a
`backend/ricerca-coordinatore.js:596`, 613 e 615. Il frontend principale li
considera già in `scripts/frontend-parts/search-status.js:76` e 172.

**Prova:** renderer originale con DOM sintetico: AutoScout `status: ok`,
`allargato: versione` e reason non produce avviso; ignorati anche segnali
Moto.it sulla verifica incompleta e dichiarazioni delle righe.
**Controprova:** lo stesso reason con status error viene mostrato.

**Impatto:** risultati più larghi possono apparire come se rispettassero
tutti i filtri. Non dimostra una query errata né un nuovo bug dello scraper.
**Proposta:** mostrare i metadati esistenti negli avvisi sulla ricerca e sugli
annunci, riusando i contratti dell'app; nessuna nuova chiamata o modifica ai
filtri. Il collaudo browser dell'utente resta necessario.

### B05 — P2 condizionato: UUID condiviso fra domini blocca il replay

Percorso: `backend/nodi/ripristino-journal.js:126` e 218. L'audit recovery
usa UUID come chiave unica; i writer invece hanno registri distinti
`aziende_operazioni` e `colleghi_operazioni` nei rispettivi SQL.

**Prova:** due journal sintetici validi, sequenze diverse, domini aziende e
colleghi, stesso UUID: il primo passa, il secondo termina con
`ripristino_operazione_in_conflitto`. Cambiando soltanto il secondo UUID
entrambi passano. L'ammissibilità nei due registri è verificata nel codice SQL;
la collisione non è stata eseguita contro PostgreSQL reale in questa review.

**Condizione:** riuso esplicito dell'identificatore fra domini. Non è stata
osservata una collisione casuale né un riuso normale dal frontend.
**Proposta:** identità recovery `(dominio, operazione)`, coerente con i writer,
con compatibilità/migrazione dei registri di restore già creati. Imporre una
nuova unicità globale ai writer sarebbe un cambiamento più ampio. Discutere
la migrazione prima di correggere; non ignorare un conflitto d'impronta reale.

### C03 — P2 condizionato: logout e bootstrap concorrente di contesti diversi

Percorso: `backend/nodi/login-nhost-prova.js:33` e 234.

**Prova:** due bootstrap senza cookie producono contesti A/B; login A in
attesa, cookie B diventato corrente, logout B, risposta provider A: login 200
e nuova sessione valida. Controprova sullo stesso contesto A: login 401,
nessuna sessione, cleanup provider eseguito.

**Limiti:** harness delle rotte con provider sintetico, non browser con MFA
reale. Il normale ingresso prepara il cookie nella pagina di login; la UI
disabilita i comandi durante l'invio. La condizione riguarda bootstrap
concorrente/multiple schede o chiamanti API, non un fallimento generalizzato
del normale logout. Non è un bypass di password, MFA o ruoli.

**Proposta da discutere:** stabilizzare il bootstrap e identificare il
tentativo cancellabile anche tra contesti concorrenti. Il solo cookie non
dimostra che due contesti anonimi provengano dallo stesso browser. Confrontare
coordinamento fra schede e protocollo del tentativo prima di scegliere; mai
cancellazione globale dei login di altri utenti.

### B06 — P2 condizionato: copia tardiva vecchia blocca la retention

Percorso: `backend/nodi/schema-backup-prova.sql:143`,
`backend/nodi/backup-postgres-prova.js:99`,
`backend/nodi/backup-restic.js:90`.

La manutenzione conserva l'ultimo snapshot completato, mentre la data del
journal resta quella dell'operazione. **Prova:** copia vecchia oltre 90 giorni
completata dopo una recente; il piano forget la eliminerebbe e la guardia
risponde `backup_retention_non_sicura`. Anche il retry non procede al prune.
**Controprova:** marker recente, forget/prune autorizzati.

**Limiti:** restic simulato nel caso temporale; il gate restic reale copre
backup/restore ordinari, non questo backlog. Nessuna perdita di copie
dimostrata: la guardia fallisce in sicurezza e blocca la manutenzione.
**Proposta:** proteggere esplicitamente lo snapshot appena verificato oltre
al piano temporale, preservando validazione, lease e limiti concordati.
Non rimuovere semplicemente la guardia; verificare il comportamento quando
non ci sono snapshot da eliminare e l'impatto di una copia aggiuntiva vecchia.

## Prove e limiti

- Suite generale: 1.303 casi, **1.298 pass, zero failure, cinque skip opt-in**.
  Eseguita prima dell'ultimo test unitario aggiunto per la guardia di provenienza.
- Test mirati finali: **18/18**, zero skip, includono la nuova guardia.
- Due gate integrati locali **PG18.6/Auth 0.49.1/restic 0.19.1**, exit 0 e
  cleanup verificato; secondo giro dopo la correzione di provenienza.
- Installazione atomica, rollback, privilegi runtime, login/MFA, quote,
  revoche, rinnovi e replay verificati nel gate reale locale.
- Review ricerca/trasporto/UI: 72 test pertinenti dell'agente, quattro
  riproduzioni/controprove poi ripetute su Node 24.
- Review accessi/recovery: 35 test pertinenti dell'agente, sei scenari
  sintetici ripetuti su Node 24. La review finale dell'incremento SQL chiude
  il finding di provenienza, anche alterando singolarmente ciascuno degli
  otto file: sempre zero chiamate SQL.
- Risorse Docker ricontrollate dopo il gate: restano gli otto container
  manuali dei due stack preesistenti e le rispettive due reti; nessun
  container/rete di collaudo residuo nella lista.

Evidenze locali, temporanee e senza credenziali reali:

- `/private/tmp/amr-branch-review-full-20261004.log`
- `/private/tmp/amr-schema-unit2-20261004.log`
- `/private/tmp/amr-schema-final-pg18-restic-20261004.log`
- `/private/tmp/amr-review-commerciale-node24-20261004.log`
- `/private/tmp/amr-review-wire-node24-20261004.log`

Nessuna prova live di portali, M2, UI browser, SMTP o ingress Nhost. Le copie
restic sono locali; dump come postgres non dimostra un login di backup cloud
con privilegi minimi. Non è provata la capacità sotto carico o l'adeguatezza
dei limiti iniziali di 60 secondi / due richieste per persona / 60 complessive.

L'immagine collaudata `9ed5479` è storica: **non è l'immagine del candidato
`c6b61a8`**. Prima di un upload serve rigenerare l'artefatto dal commit scelto.

## Prossimo ordine proposto

1. L01 e R03 prima dell'esposizione cloud: privacy dei log e assegnazione.
2. U05 prima del collaudo clienti: avvisi coerenti con la ricerca dell'app.
3. Decisione sul bootstrap C03; compatibilità B05 e retention B06 prima del
   gate di recovery operativo. Correzioni separate con prove e controprove.
4. Rigenerare l'immagine del candidato finale, quindi pacchetto remoto
   reviewabile: ruoli LOGIN, secrets, volume, ingress e configurazione Auth.
5. Dopo autorizzazione cloud: staging reale, SMTP, repository backup esterni
   separati, restore, UID/volume, header/peer, stop/rollback e latenza nodi.
6. Gate comune con APP sulle funzionalità ancora mancanti; nessun cliente
   finché il percorso complessivo effettivamente distribuito non è collaudato.

Questa review viene dopo il secondo commit richiesto: il presente documento
resta da includere nel prossimo commit, non implica un terzo commit o deploy.

## Best practices consultate e applicabilità

Le fonti sostengono i criteri di verifica, non dimostrano automaticamente la
correttezza di AMR o l'effettiva configurazione remota.

- [PostgreSQL SET ROLE](https://www.postgresql.org/docs/18/sql-set-role.html)
  e [GRANT](https://www.postgresql.org/docs/18/sql-grant.html): ruolo locale
  alla transazione, INHERIT e SET separati, privilegi effettivi.
- [Nhost database extensions](https://docs.nhost.io/products/database/extensions):
  percorso amministrativo SET ROLE postgres; non ruolo per il processo web.
- [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  default deny e controlli dei permessi nei percorsi protetti.
- [OWASP Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html):
  minimizzazione ed esclusione dei dati sensibili dai log.
- [Node HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html):
  ciclo di vita distinto della richiesta, risposta e connessione.
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html):
  invalidazione della sessione sul server; non identifica due browser anonimi.
- [restic forget](https://restic.readthedocs.io/en/stable/060_forget.html):
  retention temporale, keep-last e verifica del piano prima dell'eliminazione.
- [Nhost Run configuration](https://docs.nhost.io/products/run/configuration):
  risorse, repliche e sonde; non sostituisce prove di rollback e integrazione.
