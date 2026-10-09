# Auto Moto Radar (AMR)

Comparatore di annunci di auto e moto usate per professionisti. Una ricerca
interroga Subito, AutoScout24 e Moto.it e mostra i risultati in un'unica
lista; ogni annuncio rimanda al portale d'origine.

Software proprietario: vedi [LICENSE](LICENSE).

## Le parti del sistema

| Parte | Cosa è | Dove sta |
|---|---|---|
| Frontend AMR | L'app dei clienti: ricerca, risultati, scheda veicolo, guida | `frontend/`, frammenti in `scripts/frontend-parts/` |
| Backend dell'app | Server Express che serve il frontend e le API di ricerca | `backend/server.js` e `backend/*-route.js` |
| Scraper | Client delle tre fonti | `backend/scrapers/` |
| Centro | Backend in cloud (Nhost Run): login Nhost, aziende, colleghi, coda delle ricerche, backup | `backend/nodi/centro.js`, avvio da `backend/nodi/centro-run.js` |
| Laboratorio nodi | Console del proprietario per amministrare centro e nodi | `backend/nodi/prototipo.html`, `frontend/nodi-*` |
| Nodi | Processi su reti residenziali che eseguono le ricerche per conto del centro | `backend/nodi/worker.js`, `backend/nodi/worker-supervisore.js` |
| App desktop | Electron attorno al backend locale | `electron/` |

L'organizzazione del codice è descritta in
[docs/ORGANIZZAZIONE-CODEBASE.md](docs/ORGANIZZAZIONE-CODEBASE.md),
l'architettura centro/nodi in
[docs/NODI-RESIDENZIALI-ARCHITETTURA.md](docs/NODI-RESIDENZIALI-ARCHITETTURA.md).

## Requisiti

- Node.js 24 (versione esatta in [.nvmrc](.nvmrc)): il centro rifiuta di
  partire con un'altra versione principale.
- npm. `npm ci` esegue anche `scripts/bundle-vendor.js`, che genera
  `frontend/vendor/`.
- Per i test dell'interfaccia: Chromium di Playwright
  (`npx playwright install chromium`) oppure `AMR_TEST_CHROMIUM` con il
  percorso di un Chromium già installato.

```sh
npm ci
```

## Avviare l'app in locale

L'app non parte senza la password del proprietario. La prima volta:

```sh
node scripts/set-password.js "<password>"
npm start            # http://localhost:3000
```

In alternativa, l'elenco degli accessi può stare nel `.env`
(`AMR_ADMIN_PASSWORD`, `AMR_UTENTE_NN`) e va applicato con
`node scripts/utenti-da-env.js`. In sviluppo i dati restano in `data/`;
`USER_DATA_PATH` li sposta altrove. Il frontend viene composto all'avvio da
`scripts/build-frontend.js`.

## Centro e nodi in locale

```sh
node scripts/avvia-nodi-prototipo.js     # http://127.0.0.1:47360
```

Avvia il centro di prova con il Laboratorio nodi e due worker locali, con
dati in una cartella temporanea e token generati al momento. Non serve
Nhost né Postgres. Attenzione: il worker `imac-reale` interroga davvero i
portali; `imac-simulato` risponde in modo simulato, senza contattarli.

Il centro vero (`backend/nodi/centro-run.js`) richiede la configurazione
completa descritta in `.env.example` e viene distribuito come immagine Docker
(`scripts/docker/centro.Dockerfile`). Lo staging su Nhost è documentato in
[docs/revisioni/staging-nhost.md](docs/revisioni/staging-nhost.md).

## Configurazione

Tutte le variabili d'ambiente lette dal codice sono in
[.env.example](.env.example), divise per componente. Il file `.env` è
ignorato da Git e non va mai committato.

## Test

```sh
npm test
```

Usa il test runner di Node con un timeout di 120 secondi per test e non carica
il `.env` locale. I test che richiedono Docker, restic o R2 sono opt-in e
vengono saltati se le relative variabili `AMR_TEST_*` non sono impostate.
La stessa suite gira su GitHub Actions a ogni push
([.github/workflows/test.yml](.github/workflows/test.yml)).

## App desktop

```sh
npm run electron         # avvio in sviluppo
npm run build:mac-arm64  # pacchetto macOS Apple Silicon
```

Dettagli in [docs/BUILD_MAC_GUIDE.md](docs/BUILD_MAC_GUIDE.md).

## Documentazione

- [docs/guida/](docs/guida/): la Guida per chi usa l'app (è anche dentro l'app).
- [docs/revisioni/](docs/revisioni/): registri delle revisioni, dello staging
  e delle decisioni tecniche.
- [docs/problemi/](docs/problemi/): problemi confermati dalle analisi del codice.
