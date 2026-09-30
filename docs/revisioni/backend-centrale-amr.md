# AMR: preparazione dell'app al backend centrale

Registro della prima analisi, 30 settembre 2026. Stato: **piano da discutere e approvare; nessuna modifica applicativa autorizzata in questa fase**.

## Baseline e vincoli

- Checkout analizzato: `feat/nodi-residenziali-prototipo`, HEAD `41ef1e63b874e1a5da55dbd2fa96b7a9471edaea`, Node v26.4.0. Il worktree è il riferimento effettivo, non il solo commit.
- Modifiche parallele preesistenti: `backend/nodi/{centro.js,prototipo.html,worker.js}`, `frontend/nodi-prototipo.{css,js}`, `scripts/avvia-nodi-prototipo.js`, `test/nodi-centro.test.js`, `docs/NODI-RESIDENZIALI-ARCHITETTURA.md`. Preservarle; il prototipo viene sviluppato nella chat dedicata.
- Documenti letti e confrontati con le implementazioni: `docs/PIANO-BACKEND-CENTRALE-PRODUZIONE.md`, `docs/NODI-RESIDENZIALI-ARCHITETTURA.md`. Sono proposte/decisioni di prodotto, non dimostrazioni del comportamento.
- Nessun commit, deploy, accesso all'M2 o lettura delle credenziali. Nessuna modifica ai cataloghi o alle funzionalità accantonate. Nessuna prova sui portali reali.
- Perimetro attivo: Auto, Moto e servizi raggiungibili dalle relative interfacce. Ricambi, Competitor, Aste e bot WhatsApp accantonati non vanno riattivati. Il collegamento WhatsApp di assistenza è distinto dal bot.
- Prime pagine identiche condivisibili fra aziende secondo la decisione più recente; stato di continuazione, permessi, preferenze e diagnostica restano separati. I vecchi piani installer/product key non sono la specifica di questa fase.

## Mappa dell'app effettiva

`backend/server.js` compone le rotte; il coordinatore non vive più in questo file. `/api/search` chiama direttamente `runSearch`, quindi pubblicare questo server nel cloud senza un adattatore farebbe ancora uscire le richieste dal cloud (`server.js:11,43,56`).

Il browser non è descritto dal solo `frontend/app.js`: `scripts/build-frontend.js:18` assembla i frammenti di `scripts/frontend-parts/` in ordine, con stato condiviso. Occorre preservare questa composizione.

| Percorso attivo | Chiamanti e implementazione | Funziona localmente / collocazione proposta |
|---|---|---|
| Boot, navigazione, accesso | `init-ui.js`, `navigation.js`; `/api/me`, `/login`, `/logout`, `accesso-route.js` | Identità locale full/demo e owner; manca identità commerciale azienda/moduli. Nel centro mantenere URL dell'app e caricare permessi prima di avviare ricerche/default Auto/Moto. |
| Configurazione filtri | `/api/filtri-auto`, `frontend-route.js`; `init-ui.js` | Dati locali/configurazione: centro, senza scraping. |
| Marche, modelli, versioni | `catalog-ui.js:94,121`; `menu-ricerca-route.js:11,40,86`; `motoit-models.js` | Cataloghi e ponte locale; il menu modelli può anche interrogare Moto.it. Conservare lo stesso resolver/versione dati. Non trasformarlo indiscriminatamente in un menu solo statico. Prima fase: operazione menu sul nodo, con possibile estrazione centrale della parte pura solo dopo prova d'equivalenza. |
| Ricerca Auto/Moto | `search.js:381`; `/api/search`; `ricerca-parametri.js`, `ricerca-coordinatore.js` | Validazione, risoluzione dei cataloghi, tre fonti, ampliamenti API autorizzati, filtri, normalizzazione/versione. Esecuzione completa sul nodo; autorizzazione e ammissione al centro. Auto esclude Moto.it; Moto usa tutte e tre. |
| Fonti | `subito-api.js`, `autoscout-graphql.js`, `motoit.js`, resolver e moduli ponte | Riutilizzare le implementazioni e l'ordinamento. Nessun nuovo fallback browser. Una ricerca UI non equivale necessariamente a una sola chiamata HTTP: resolver, unioni AS24 e ampliamenti possono aggiungere chiamate. |
| Paginazione e retry | `search.js:172,251,268`; `ricerca-coordinatore.js:378–441` | Un pulsante; non richiede fonti esaurite; conserva porzioni riuscite e riprova solo quelle mancanti. Stato temporaneo browser da preservare anche se una cache server scade. Failover e risultato incerto richiedono nuovi avvisi espliciti. |
| Avvisi, lista, schede, confronto | `results.js`, `search-status.js` | Filtri di visualizzazione, ordinamento, IVA/prezzi/ricarichi, versione/corrispondenza, confronto massimo 10: browser. Nessun elenco remoto aggiuntivo per ricostruire la vista. |
| Dettagli/foto | `results.js:140`, `search-status.js:345,481`; `/api/detail`, `dettaglio-route.js`, `scrapers/detail.js` | Cache RAM e allowlist/redirect delle tre fonti. Download sul nodo; nel centro autorizzare l'annuncio e il modulo prima del dispatch. La cache pubblica per URL non sostituisce l'autorizzazione. |
| Scheda tecnica e generazioni | `vehicle-sheet.js`; `/api/scheda-veicolo`, `/annuncio`, `/specs`; `scheda-veicolo-route.js:913–954` | Resolver cataloghi, selezione generazione/motorizzazione e richieste Moto.it, auto-data.net, UltimateSpecs. Nodo per il lavoro di rete; risposta/rendering browser. Non è coperto dalle sole operazioni ricerca/dettaglio del prototipo. |
| Richiami | `/api/richiami/cerca`, `/rdw/cerca`, `/omologazione`; `richiami-route.js` | Safety Gate e indice richiami RDW: consultazione locale, centro con archivi versionati. Omologazione: chiamate RDW, nodo nella prima integrazione conservativa. |
| Prove/rilevamenti | `/api/prove/auto`, `/moto`, `/moto/prova`; `prove-route.js:51,82,104` | Indice locale + pagine auto.it/inSella, cache accessoria. Download sul nodo; conservare stato incompleto/assente/errore e link. |
| Liquidità | `/api/liquidita`, `veicolo-dati-route.js:14` | Elaborazione cataloghi ACI: centro, nessuna uscita necessaria verso portali. |
| Passaggio di proprietà | `/api/passaggio`, `veicolo-dati-route.js:48,73` | Calcolo IPT locale; può consultare Motornet solo se configurato. Calcolo centrale, eventuale lookup remoto nodo; non chiamarlo sempre scraper né sempre funzione pura. |
| Carburanti | `/api/carburanti`, `carburanti.js` | Download periodico MIMIT + filtro/calcolo. Nodo inizialmente per preservare l'uscita; eventuale centralizzazione della fonte ufficiale richiede scelta e prova distinta. |
| Cerchi/pneumatici | `/api/fonti/cerchi/calzate`, `/pneumatici/cerca`; `fonti-route.js:187` | Wheel-Size/EPREL con cache e stati propri: nodo. Le funzionalità integrate negli annunci sono attive anche se le vecchie aree autonome sono state accantonate. |
| Targa | `targa.js` frontend; `/api/targa/sfida`, POST `/verifica`; `backend/targa.js:107,138,255,315` | CAPTCHA/sessione portale in RAM sul processo che crea la sfida. Entrambe le fasi sullo stesso nodo, associato a persona/azienda. Niente targa, cookie o CAPTCHA nella diagnostica ordinaria. |
| CSV | `export.js`, set di righe visibili e pricing | Browser; preservare vista e rettifiche. Non richiede worker. |
| PDF annunci | `/api/report-pdf`, `report-route.js:44`, `report-pdf.js` | Rendering temporaneo al centro, senza archivio annunci. Limiti body/righe già presenti; autorizzazione e capacità totale da aggiungere. |
| Export scheda tecnica | `vehicle-sheet.js:1509–1535` | Copia, CSV e PDF con jsPDF nel browser; conservare specifiche selezionate ed evidenze. Non aggiungere un renderer centrale per un percorso già locale. |
| Preferenze | `frontend/app.js:112,129`; `/api/miei`, PUT preferenze; `dati-utente.js` | Quattro impostazioni per persona. DB già filtra utente; il boot browser va corretto per cambio identità e fallimenti PUT. |
| Supporto | `search-status.js:513`, `/api/report`, `report-route.js:21` | Segnalazioni persistenti, filtri facoltativi. Nel centro richiedono identità azienda/persona verificata, schema consentito e retention distinta; non fanno parte del transito annunci. |
| URL pubblico, guida, registrazioni, salute/log | `public-url-route.js`, `frontend-route.js`, `registrazioni-route.js`, `accesso-route.js` | Guida/statici al centro; URL HTTPS configurato invece di eseguire Tailscale. Registrazione/inviti locali non equivalgono all'onboarding commerciale. Health del servizio distinto da pause dei portali; log admin protetti e minimizzati. |

Altre rotte backend montate (territorio/costi ecc.) non sono prova di funzionalità Auto/Moto raggiungibili dall'UI corrente: classificarle nell'inventario di autorizzazione, senza riattivare le vecchie aree o eliminarle in questo lavoro.

## Contratto da preservare

- `parseSearchParams` e risoluzione cataloghi/alias/codici nativi rimangono il riferimento, non una nuova traduzione nel centro.
- La risposta completa comprende `risultati`, `totale`, `versioneChiesta`, `versioneConto`, `versionePerFonte`, `subitoStatus/Reason` e tutti i `sources`, con errori, totali grezzi, `hasMore`, cursori, parzialità, ampliamenti e pause (`ricerca-coordinatore.js:558`). Non usare `_amrSearchFn` come scorciatoia: restituisce un sottoinsieme diverso dal contratto HTTP (`server.js:82`).
- Il recupero Subito è **disabilitato nella ricerca ordinaria**: `senzaRecupero:true`, `recuperoStart:null` (`ricerca-coordinatore.js:72`). Compatibilità e test dei due cursori non autorizzano a ripristinarlo.
- La salute dei tre portali resta autorevole sul nodo e conta chiamate effettive. Scadenza pausa non significa fonte sicuramente disponibile: resta la verifica singola. Il centro coordina ammissione/sospensioni senza accorciare un blocco.
- Cache ricerca RAM: 3 minuti/50 voci; porzioni riuscite: 3 minuti/30; dettagli: 12 ore/500, vuoti 15 minuti. Validità TTL non implica rimozione fisica immediata. Cache di dati tecnici/fonti ufficiali su disco sono diverse da un archivio annunci.
- Identità e contesto aziendale derivano dal server, mai da input del browser. Chiavi commerciali opache devono preservare il case: `searchCacheKey` oggi normalizza anche lo scope (`ricerca-coordinatore.js:187`). Gli ID locali sono minuscoli: non è una fuga fra account locali dimostrata, ma un rischio verificabile introducendo identità esterne case-sensitive.

## Finding verificati e controprove

### A. Gap di collegamento, priorità alta

L'app attiva esegue localmente gli scraper. Il prototipo ha UI/API distinta: `/api/test/me`, `/api/filtri`, ricerca/menu/dettagli, mentre AMR usa `/api/me`, `/api/filtri-auto` e gli accessori sopra. `backend/nodi/operazioni.js:31` ammette un insieme finito di operazioni e non implementa gli accessori.

Controprova: coordinatore, ricomposizione delle risposte, token nodo e rifiuto di esiti tardivi esistono già. Non occorre riscrivere lo scraping né sostituire l'app con la UI diagnostica. Si tratta di completare un confine di esecuzione, non di un difetto locale dello scraper.

### B. Preferenze tra account, riprodotto

Con account B senza preferenze e localStorage di A, `mieiCarica` invia a B i valori residui. Prova sul testo reale della funzione: `/private/tmp/amr-app-centro-review-20260930/preferences-proof.cjs`; importa `amr_price_v` e `amrPassProvincia` senza rete reale. I PUT ignorano gli errori HTTP (`frontend/app.js:112`).

Controprova: SQL filtra correttamente per utente; non è una contaminazione nel database. Proposta: nessuna importazione automatica delle vecchie chiavi comuni nel centro; inizializzazione dal server/default dell'account, aggiornamento coerente della UI e avviso se il salvataggio fallisce.

### C. Esito incerto e avvisi nodo non rappresentati, verificato con risposta simulata

Il prototipo restituisce `incerto:true`/`avvisiNodi`; la UI commerciale non li interpreta. `search.js:271` marca ogni HTTP >=500 come riprovabile. Controprova: non c'è reinvio automatico; serve un clic. Proposta: contratto esplicito per esito noto/non iniziato/incerto e messaggi coerenti. Un generico 504 non prova che il portale non abbia ricevuto richieste; non permettere retry trasparente in quel caso.

### D. Targa stateful, verificato nel percorso

La mappa delle sfide contiene cookie/azione/HTML/tempo, senza proprietario (`targa.js:138`); `/verifica` consuma la sfida prima dell'invio (`:255`). Spostare il secondo passo su un altro worker perde la sessione. Controprova: ID casuale, TTL/cap, host HTTPS e `no-store` già presenti; nessuna dimostrazione che gli ID siano indovinabili. Proposta: affinità nodo e associazione azienda/persona, TTL effettivo, nuova sfida se persa; nessun replay automatico dopo invio incerto.

### E. Autorizzazione commerciale e capacità condivisa mancanti

Il gate locale full/demo e owner non verifica acquisto Auto/Moto; limiter 60/min per identità e tetto demo 50/giorno non sono capacità del pool (`server.js:42`, `accesso-route.js:153`). PDF è sincrono, con limiti ma senza ammissione globale. Controprova: revoca delle sessioni e isolamento locale sono reali; non vanno cancellati senza sostituzione. Proposta: identità centrale mantenuta, membership/moduli server-side, quote e coda per azienda/nodo/fonte; soglie da concordare, non inventare.

### F. Diagnostica/supporto e destinazioni cloud

`logger.js:96,127` stampa gli argomenti originali su console prima della redazione di ring/file. È un difetto della garanzia di redazione, non la prova che oggi siano stati registrati segreti. `/api/report` non associa persona/azienda e accetta `searchParams` arbitrario; supporto non ha retention applicativa. Proposta: redazione prima di tutte le destinazioni e eventi con schema consentito; supporto autenticato distinto dai filtri diagnostici conservati sette giorni. Mai inserire input targa/cookie/body in un job generico persistente.

### G. Cancellazione remota non automaticamente estesa agli accessori

Il coordinatore principale ora combina il segnale esterno con i timeout: la vecchia affermazione che non propaghi l'abort è superata. `scrapers/detail.js:41` usa invece `signal:null` per Moto.it e `https.get` senza segnale per Subito/AS24. Non promettere che interrompere il job interrompa ogni download accessorio. Proposta: classificare le operazioni e collegare la cancellazione dove sicuro; per fetch pubblici condivisi non far annullare da un solo utente il lavoro atteso da altri. Prima riprodurre ogni caso con trasporto controllato, poi intervento separato.

## Contratti da concordare con la chat del prototipo

Non sono stati modificati i file del prototipo. Due condizioni vanno riferite e provate sul suo stato definitivo: le prime pagine condivise devono assegnare anche ai destinatari successivi l'affinità di continuazione; il limite di 300 hash URL per autorizzare dettagli può escludere righe ancora visibili o nel confronto. Sono rischi d'integrazione derivati dal codice corrente (`centro.js:225,288,305,467,496`), non prove live né autorizzazione a cambiarlo qui.

## Piano corretto dopo debunking

1. Congelare i contratti AMR con fixture di Auto/Moto, cataloghi, versioni, metadati, filtri, pagine e accessori. Asserire equivalenza della risposta completa, non solo numero di annunci. Registrare revisioni codice/cataloghi effettivi e preservare modifiche parallele.
2. Introdurre nella sola app un confine di esecuzione locale/remoto iniettato nelle rotte. Il centro autentica, autorizza e ammette; il nodo esegue operazioni nominate/validate con il coordinatore esistente. Vietato un generico proxy URL/metodo arbitrario. L'esecutore locale resta riferimento delle prove.
3. Collegare cataloghi e ricerca, mantenendo stesso URL e contratto del frontend. Integrare esiti incerti/avvisi/failover prima di dichiarare il percorso usabile. Preservare stato del retry nel browser e fonte già riuscita; non aggiungere retry invisibili o recuperi rimossi.
4. Collegare dettagli e scheda tecnica una operazione per volta; poi prove, richiami remoti, cerchi/pneumatici e dati carburante. Conservare allowlist, parser/privacy, salute e callback di conteggio effettivo. Calcoli e indici puri rimangono al centro; nessun routing basato su un nome di file.
5. Integrare separatamente targa con affinità e contesto utente, senza logging degli input sensibili. Prove di nodo perso, scadenza, doppio invio e risposta tardiva.
6. Correggere preferenze/supporto/log e predisporre il confine di identità/autorizzazione. La scelta del provider identità, del cloud/database e delle soglie commerciali richiede una decisione esplicita. Non sostituire il login AMR con le identità fittizie del prototipo.
7. Provare l'app completa con esecutore simulato e rete esterna vietata al centro: cataloghi, tre fonti, accessori, export, cache hit/miss, pause, retry, revoca, due aziende, cambio account, nodo offline/incerto e riavvio. Nessun annuncio/body nei dati durevoli o backup centrali. Fonti tecniche/cache ufficiali e supporto hanno politiche distinte.
8. Solo dopo esiti e approvazione, concordare pochi probe live. Gate di pubblicazione separato: autenticazione reale, HTTPS/proxy verificato, restore, persistenza, capacità, diagnostica e rollback. Nessun coinvolgimento M2 in questo lavoro.

Debunking delle alternative: inoltrare solo gli annunci perde metadati/versioni/pause; invocare una fonte per nodo indiscriminatamente duplica traduzioni e retry; sostituire AMR col prototipo elimina accessori e login reale; spostare tutti i menu su disco perde il completamento Moto.it; condividere ogni cache cross-tenant non equivale alla sola prima pagina autorizzata; cancellare qualsiasi cache su disco eliminerebbe anche dati ufficiali/tecnici consentiti. Il taglio conservativo preserva la ricerca completa su un nodo e tratta gli accessori come operazioni distinte.

## Prove e limiti

- 246 test mirati passati, zero falliti/skipped, con dotenv neutralizzato, USER_DATA_PATH/log temporanei e preload che vieta rete esterna. File esito: `/private/tmp/amr-app-centro-review-20260930/tests-authorized.tap`. Copertura: paginazione, retry, metadata/UI, fonti, cataloghi/versioni, PDF, targa, preferenze, build e baseline. Non è una suite completa di pubblicazione.
- Prima esecuzione nel sandbox: listen localhost EPERM; rieseguita con permesso per loopback e blocco applicativo della rete esterna. Non classificare quella limitazione come bug dell'app.
- Prova indipendente del cambio account eseguita sul testo reale di `mieiCarica`, senza dati personali.
- Lettura incrociata di chiamanti/frontend/backend e seconda analisi critica; test verdi non certificano identity provider, cloud, compatibilità remota o fonti reali.
- Nessuna misura live, prova di carico commerciale, verifica browser remota end-to-end, audit completo del prototipo parallelo o validazione del ripristino produzione.

Comando della suite mirata (preload e directory sono nello scratch temporaneo):

```sh
AMR_LOG_DIR=/private/tmp/amr-app-centro-review-20260930/logs \
USER_DATA_PATH=/private/tmp/amr-app-centro-review-20260930/data \
NODE_OPTIONS=--require=/private/tmp/amr-app-centro-review-20260930/offline.cjs \
node --test test/nodi-baseline.test.js test/paginazione-ricerca.test.js \
test/paginazione-fonti.test.js test/frontend-build.test.js test/campi-fonte.test.js \
test/metadati-fonte-ui.test.js test/fonti-pausa-ui.test.js test/fonti-ripartenza.test.js \
test/fonti-429-dettagli.test.js test/subito-retry-integrazione.test.js \
test/subito-per-id.test.js test/autoscout-graphql.test.js test/as24-modelli.test.js \
test/motoit-ricerca.test.js test/motoit-protezioni.test.js test/motoit-catalogo-locale.test.js \
test/versione-verifica.test.js test/veicolo-dati-route.test.js test/prove-route.test.js \
test/report-pdf-limite.test.js test/targa.test.js test/dati-per-persona.test.js
```

## Prossimo passo

Presentare mappa/finding/piano al proprietario e attendere approvazione dell'intervento iniziale. Aggiornare questo registro dopo ogni intervento con riproduzione prima, modifica, controprove, regressioni, limiti e decisione. Non dichiarare AMR deployable sulla sola base di questa analisi.
