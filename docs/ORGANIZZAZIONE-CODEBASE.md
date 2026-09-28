# Organizzazione della codebase AMR

## Perimetro attivo

L'interfaccia principale offre Auto e Moto. La ricerca passa per `backend/server.js` e per gli scraper API Subito, AutoScout24 e Moto.it. Le aree Ricambi, Competitor e Aste e il bot WhatsApp sono accantonati; i loro archivi locali verificati si trovano in `.amr-feature-backups/2026-09-28/` e sono ignorati da Git. I dati storici in `data/` non sono stati cancellati. I link WhatsApp dell'assistenza umana nell'interfaccia restano attivi.

## Confini separati

- `backend/catalogo-ricerca.js` possiede la risoluzione di marche e gruppi di modelli usata dalla ricerca.
- `backend/report-route.js` monta segnalazioni e PDF; il PDF è disegnato da `backend/report-pdf.js`.
- `backend/veicolo-dati-route.js` monta liquidità ACI, passaggio di proprietà e prezzi carburante.
- `backend/fonti-route.js` conserva le fonti indipendenti dai Ricambi. Le rotte Ricambi OE e il client Bilstein sono nell'archivio locale.
- `frontend/parts/icons.js` contiene le icone; `scripts/build-frontend.js` lo unisce a `frontend/app.js` nello stesso `/app.js`, in quest'ordine. Il server controlla le modifiche a entrambi i file e il fallback serve il sorgente composto.

## Confini ancora da riorganizzare

`backend/server.js` contiene ancora il coordinamento Auto/Moto e l'accesso. `frontend/app.js` contiene ricerca, risultati, scheda veicolo, confronto, esportazione e preferenze nello stesso file; `frontend/style.css` ne mescola gli stili. Alcuni test leggono porzioni di `app.js` e `server.js` come testo: prima di spostare quei blocchi bisogna far esercitare ai test il nuovo proprietario del codice, senza mantenere copie nel file originario per compiacere la suite. L'helper interno `_amrSearchFn` non ha più un chiamante di produzione dopo l'accantonamento del bot, ma è usato da test di ricerca: va sostituito con una superficie di test che eserciti il percorso HTTP o il servizio condiviso prima di rimuoverlo.

Per ogni estrazione: identificare chiamanti e stato condiviso, spostare un confine, verificare bundle/rotte e suite, poi aggiornare i commenti alla struttura effettiva. Non cambiare comportamento dello scraper per ottenere una divisione più facile. Dopo la riorganizzazione, rivedere file per file quali commenti spiegano davvero vincoli e quali raccontano funzioni ormai accantonate.
