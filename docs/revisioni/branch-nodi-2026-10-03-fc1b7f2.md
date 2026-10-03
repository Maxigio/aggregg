# Review del branch centro–nodi — candidato fc1b7f2

## Perimetro ed esito

3 ottobre 2026. Branch `feat/nodi-residenziali-prototipo`, base `81e25ab`,
candidato `fc1b7f2`: 58 commit, 128 file cambiati. Il conteggio comprende
documenti e test; non misura la qualità del runtime. La preparazione staging
successiva è registrata in [questo pacchetto](staging-pacchetto-2026-10-03.md).

Tre review indipendenti in sola lettura: account/SQL, centro/worker/UI e
backup/recovery. I percorsi e i finding sono ricontrollati dal main contro
codice, caller ed evidenze. Nessuna nuova prova sui portali, Nhost o M2.
File locali preesistenti e lavoro APP preservati.

**Tre nuovi difetti confermati nella review iniziale** sul candidato: due nel
coordinamento, uno nel recovery. Il collaudo del recovery ha poi confermato
un quarto difetto sull'ID dell'invito revocato. Tutti e quattro sono corretti;
la chiusura sotto registra prove e commit. Il comportamento commerciale
dopo logout è verificato e coerente con la policy scelta dal proprietario.
Le [correzioni precedenti](correzioni-nodi-2026-10-03.md)
restano valide per i casi provati; non coprivano questi scenari.

## Decisioni e percorsi ricontrollati

| Percorso | Esito e limite |
| --- | --- |
| Centro/nodi | Scraper sui nodi; composizione pura nel centro e risultati transitori. Non occorre introdurre un altro motore o duplicare il coordinatore |
| Moduli e aziende | UUID/azienda/moduli dal server, funzioni SQL con ruoli limitati; quota 10 aziende/30 persone, tre posti per azienda. I test locali non attestano i privilegi Nhost |
| Login/revoca | Password e MFA verificati via provider; sessione opaca RAM. Epoca SQL revocata durante l'attesa impedisce la mutazione; logout RAM ha il limite C02 sotto |
| Ricerca/pagine | Cursori separati e retry delle porzioni mancanti; affinità per azienda/query/release. Nuova ricerca segue disponibilità e carico. R01/R02 coprono rami ancora mancanti |
| 429/disconnessione | Pause locali comunicate al centro, una sola alternativa per fonte; risultati tardivi rifiutati. Nessuna prova che il cambio IP garantisca copertura immutabile o aggiri i limiti |
| Privacy/diagnostica | Annunci non scritti nel registro lavori/eventi; solo metadati e filtri ammessi. Backup commerciale separato dai risultati |
| Backup/recovery | Restic e journal separati dal dump, sequenza e finalizzazione protette. B04 dimostra che un restore già passato non copriva gli inviti pending |
| Deployment | Un solo scheduler, manutenzione con arresto verificato e volume stabile. Una replica configurata non è un lock distribuito |
| APP completa | [Mappa delle funzionalità](amr-centro-mappa-funzionalita.md): il prototipo non monta ancora tutti i servizi dell'app principale. L'integrazione resta coordinata con APP |

Il riavvio perde sessioni e coda; non ripete automaticamente lavori incerti.
È il comportamento concordato del prototipo, non una soluzione di alta
disponibilità. L'immagine locale e il servizio Run fermo non provano il gate clienti.

## Finding e controprove

### B04 — P1, confermato: invito pending nel dump impedisce il replay

`backend/nodi/ripristino-journal.js:172–173` sostituisce i membri ma non
riconcilia le prenotazioni degli inviti. Il controllo in
`backend/nodi/schema-colleghi-prova.sql:89–96` vieta correttamente un invito
pending per una persona già membro. Scenario:

1. identità Auth presente e invito pending;
2. `pg_dump -Fc` del database;
3. accettazione dell'invito e journal confermato dopo il dump;
4. `pg_restore` in un altro database, replay del journal prima della scadenza.

Su **PostgreSQL 16 reale**, Node 24.21.0 e schemi/adattatori correnti,
referente e collega falliscono entrambi con SQL `appartenenza_esistente`;
l'helper restituisce `ripristino_non_disponibile` e fa rollback. Il membro
precedente e l'invito estraneo rimangono invariati. Auth è una tabella sintetica
con i campi usati da questi percorsi, non il provider reale; dump, restore,
vincoli e funzioni commerciali sono reali.

Controprova indipendente: eliminata nella fixture soltanto la prenotazione
conflittuale, lo stesso replay riesce. Non è una proposta di cancellazione in
produzione. La finalizzazione successiva randomizza le impronte dei token,
ma non elimina la prenotazione e non può correggere un replay già fallito.

**La patch limitata al journal `accetta` non basta per il contratto attuale.**
È ammesso applicare uno snapshot recente prima di quelli vecchi, poi segnare
i vecchi come superati. Un rinnovo può contenere il membro appena accettato
senza i dettagli dell'invito collega. Non si può inventare la sua data di
accettazione né cancellare indiscriminatamente gli inviti pending.

Proposta in interview: replay completo in ordine di sequenza dopo il dump,
riconciliazione mirata delle accettazioni prima delle membership successive,
errore esplicito se manca un journal necessario. Alternativa: snapshot più
completi/versionati per mantenere il recupero fuori ordine. **Nessuna delle
due politiche è stata implementata senza la decisione del proprietario.**

Prove: `/private/tmp/amr-pending-pg-probe.cjs`,
`/private/tmp/amr-pending-pg-before-20261003.log` e
`/private/tmp/amr-pending-pg-before-both-20261003.log`.
Un tentativo intermedio è fallito durante il riavvio iniziale del container;
la fixture è stata corretta per aspettare il listener TCP definitivo.
La ripetizione ha concluso entrambi i casi, senza modificare vincoli runtime.

### R01 — P1, confermato: fonte delegata fallita viene dichiarata esaurita

`backend/nodi/centro.js:416–423` conserva la fonte `skipped/hasMore=false`
del primario che non l'ha eseguita, quando l'alternativo fallisce. Topologia:
A può AutoScout, B può Subito; A consegna AutoScout, B restituisce timeout.
La risposta 200 contiene l'avviso ma Subito risulta esaurito. Il caller reale
in `frontend/nodi-prototipo.js:177–198,453–467` nasconde retry e ulteriori pagine.

Riproduzione HTTP e caller UI con API simulate; controprova alternativa
completa: entrambe le fonti disponibili. Proposta: per una fonte omessa sul
primario, propagare uno stato fallito e recuperabile; preservare le fonti già
riuscite, non avanzare i cursori di una porzione non consegnata. Stato 429/pausa
e incertezza vanno mantenuti quando realmente presenti. Non sostituire una
porzione primaria parziale già utile con un errore dell'alternativa.

### R02 — P2, confermato: retry pagina zero perde l'affinità

`backend/nodi/centro.js:350–363` impone l'owner solo per `fetta>0`.
La UI usa invece `fetta=0&fonti=autoscout` per riprovare una prima pagina
fallita. A è owner sano ma occupato; B è libero: il retry passa a B.
Con `fetta=1` resta su A. Il cambio è segnalato, non è un passaggio nascosto.

Proposta: estendere il vincolo al retry esplicito a pagina zero con `fonti`,
preservando la scelta per carico delle nuove ricerche e il failover quando
l'owner o la fonte sono indisponibili. Non sono state misurate doppie chiamate
ai portali o perdita di annunci reali: è verificata l'assegnazione.

Evidenze R01/R02: `/private/tmp/amr-review-fc1b7f2-429qwqkv/review.md`,
`probes.cjs`, `probes.log`, `ui-probes.cjs`, `ui-probes.log` nella medesima
directory. 91/91 test mirati, 5/5 riproduzioni HTTP e 2/2 caller UI: attestano
il comportamento del candidato prima del fix, non la risoluzione.
Le prove indipendenti usano Node 26.4.0; il collaudo dei fix deve usare Node 24.

### C02 — comportamento verificato, difetto condizionato: comando già autorizzato dopo logout

La rotta aziende deriva `{persona,epoca,mfa}` dalla sessione valida, poi
l'adattatore SQL esegue una funzione con commit implicito. Query bloccata
sulla quota → logout RAM → rilascio lock: creazione invito 200 e azienda
persistita. Nuovo comando con il vecchio cookie e `/me` dopo logout: 401.
Revoca dell'epoca PostgreSQL durante lo stesso lock: 403 `sessione_revocata`
e nessuna azienda creata. Non è accesso anonimo o bypass MFA.

Il fatto è riprodotto su PG16 e route/adattatore correnti; chiamare la
persistenza un bug richiede decidere se il logout annulla anche i comandi
commerciali già ammessi. È diverso dalla richiesta Admin il cui body non
era ancora completo (A02, già corretta) e dalla revoca dei permessi SQL.

Opzioni: lasciare concludere il comando già ammesso e consultarne l'esito,
oppure transazione esplicita sullo stesso client con controllo sessione prima
del commit. La seconda richiede gestione rigorosa di connessione, rollback,
timeout/esito incerto e test contro logout, scadenza e revoca; un controllo
dopo il commit non annullerebbe la mutazione. Nessuna patch implicita.

Evidenze: `/private/tmp/amr-review-fc1b7f2-repro.cjs` e relativo `.log`.
70/70 test mirati dell'agente account, più riproduzione/controprova PG;
Auth sintetico. Non sono una verifica SMTP o provider remoto.

## Prove main e gate ancora aperti

54/54 Run/avvio/manifest/HTTPS, zero skip, Node 24.21.0, dotenv disabilitato,
dati temporanei. CLI e contesto: [registro del pacchetto](staging-pacchetto-2026-10-03.md).
Le prove complete della sessione precedente restano evidenza storica del
relativo candidato; non sono state contate come nuovi test di questa review.

Ordine dei prossimi passi: chiudere R01/R02 e la politica B04; verificare
recovery completo e candidato ricostruito; configurare e collaudare staging
remoto; integrare la mappa APP con le autorizzazioni centrali; misurare carico
e latenza; solo poi gate clienti. M2 e fonti live rimangono separati.
Restano condizionati: volume e proxy Nhost, deadline dell'ingress, costo,
capacità 500 millicpu/1024 MiB, storage esterno reale, backup SQLite e rollout
senza due scheduler. Non vanno trasformati in difetti riprodotti né ignorati.

Fonti ufficiali: [OWASP Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html),
[PostgreSQL backup](https://www.postgresql.org/docs/16/backup-dump.html),
[Run networking](https://docs.nhost.io/products/run/networking),
[Run risorse](https://docs.nhost.io/products/run/resources) e
[health checks](https://docs.nhost.io/products/run/health-checks).
Le raccomandazioni supportano privilegi minimi e gate distinti; non decidono
da sole le regole commerciali di logout o il formato del nostro journal.

## Chiusura degli interventi — 4 ottobre 2026

R01 e R02 corretti nel commit `8379b87`, con 11 nuove regressioni/controprove.
40/40 test mirati Node 24; review statica indipendente del diff senza ulteriori
finding confermati. Due prove del caller UI dopo il fix, Chrome headless/API
simulate: retry visibile e abilitato, richiesta soltanto a Subito con pagina
zero, AutoScout preservato e nessun cursore della porzione scartata. Non è il
collaudo manuale dell'utente o una prova di portali reali.

Suite generale dopo R01/R02: 1.294 test, 1.290 pass, zero failure, quattro skip
opt-in; `/private/tmp/amr-fc1-review-full-20261003.log`. Le righe delle alternative
incomplete restano scartate come prima: il fix rende recuperabile la fonte,
non aggiunge un nuovo contratto per consegnare quelle porzioni parziali.

Il proprietario ha scelto **replay completo ordinato**. B04 è corretto e
verificato nel commit `024af78` e nel
[registro di recovery](ripristino-inviti-2026-10-04.md), compreso
l'ulteriore errore sull'ID di un invito revocato scambiato per identità Auth.
Nessuna disattivazione di vincoli o ricostruzione di token mancanti.

Suite finale sull'albero con entrambi i fix: **1.298 test, 1.293 pass, zero
failure, cinque skip opt-in**, Node 24, dotenv disabilitato e dati temporanei;
`/private/tmp/amr-restore-final-full-20261004.log`. Separatamente: recovery con
dump/inviti su PostgreSQL 16 **1/1**, gate Auth/PostgreSQL/restic **6/6**, unit
journal **26/26**. Review indipendente del diff recovery senza ulteriori finding
confermati. Restano da eseguire il collaudo manuale dell'utente e i gate remoti.

Il proprietario ha scelto di **completare i comandi commerciali già ammessi
prima del logout**, negando subito quelli nuovi. C02 è quindi coerente con la
policy concordata e non un bug da correggere. La revoca dell'epoca SQL resta
distinta: la controprova dimostra che blocca il comando in attesa. Il risultato
di un comando perso dal browser va consultato dopo il nuovo login tramite i
percorsi di elenco/stato operazione; nessun retry cieco con nuovo identificatore.

Il runtime è cambiato dopo la preparazione `fc1b7f2`: l'immagine locale
`a05d45a` non contiene questi fix. Rigenerare e collaudare il candidato dal
commit scelto prima di caricarlo nel registry. Run e M2 restano invariati.
