# Organizzazione della codebase AMR

## Perimetro attivo

L'interfaccia principale offre Auto e Moto. La ricerca passa per `backend/server.js` e per gli scraper API Subito, AutoScout24 e Moto.it. Le aree Ricambi, Competitor e Aste e il bot WhatsApp sono accantonati; i loro archivi locali verificati si trovano in `.amr-feature-backups/2026-09-28/` e sono ignorati da Git. I dati storici in `data/` non sono stati cancellati. I link WhatsApp dell'assistenza umana nell'interfaccia restano attivi.

## Confini separati

- `backend/catalogo-ricerca.js` possiede la risoluzione di marche e gruppi di modelli usata dalla ricerca.
- `backend/accesso-route.js` possiede gate, login, sessione esposta alla UI, limite giornaliero e chiavi dei limitatori. È montato prima delle rotte protette; `backend/server.js` conserva i riferimenti necessari alla ricerca e ai test.
- `backend/frontend-route.js` monta bundle versionati, pagina iniziale, filtri da mostrare, Guida e file statici, in quest'ordine e dopo il gate. I sorgenti dei bundle restano in `scripts/frontend-parts/`, fuori dalla cartella statica.
- `backend/report-route.js` monta segnalazioni e PDF; il PDF è disegnato da `backend/report-pdf.js`.
- `backend/veicolo-dati-route.js` monta liquidità ACI, passaggio di proprietà e prezzi carburante.
- `backend/fonti-route.js` conserva le fonti indipendenti dai Ricambi. Le rotte Ricambi OE e il client Bilstein sono nell'archivio locale.
- `frontend/app.js` contiene DOM e stato iniziale. I sorgenti in `scripts/frontend-parts/` hanno blocchi ordinati per responsabilità: `controls.js` (prezzi, tema, toast), `init-ui.js` (inizializzazione e filtri), `catalog-ui.js` (selezione marca/modello/versione), `search.js` (richiesta e pagine), `results.js` (righe e dettagli), `search-status.js` (stato fonti, confronto e UI), `vehicle-sheet.js`, `export.js`, `navigation.js`, `targa.js` e `icons.js`. I frammenti sono fuori dalla cartella statica: il browser riceve soltanto `/app.js`. `scripts/build-frontend.js` li unisce nell'ordine dichiarato in `JS_FILES`; il fallback serve lo stesso sorgente composto. I test e la Guida leggono il sorgente composto, così l'estrazione non lascia copie di codice nel vecchio file.

## Confini ancora da riorganizzare

`backend/server.js` contiene ancora il coordinamento Auto/Moto. Il frontend è diviso per blocchi funzionali nello stesso scope di esecuzione; non sono moduli ES e non vanno caricati singolarmente nel browser. Anche il CSS è composto in ordine da `frontend/style.css` e dai frammenti `scripts/frontend-parts/*.css`, senza cambiare la cascata. Alcuni test leggono porzioni del bundle o di `server.js` come testo: prima di spostare quei blocchi bisogna far esercitare ai test il nuovo proprietario del codice, senza mantenere copie nel file originario per compiacere la suite. L'helper interno `_amrSearchFn` non ha più un chiamante di produzione dopo l'accantonamento del bot, ma è usato da test di ricerca: va sostituito con una superficie di test che eserciti il percorso HTTP o il servizio condiviso prima di rimuoverlo.

Per ogni estrazione: identificare chiamanti e stato condiviso, spostare un confine, verificare bundle/rotte e suite, poi aggiornare i commenti alla struttura effettiva. Non cambiare comportamento dello scraper per ottenere una divisione più facile. Dopo la riorganizzazione, rivedere file per file quali commenti spiegano davvero vincoli e quali raccontano funzioni ormai accantonate.
