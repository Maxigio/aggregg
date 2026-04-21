# Briefing per Claude Code sul Mac — Setup build DMG

> **Leggi questo file per intero prima di iniziare qualsiasi azione.**
> È stato scritto dalla sessione Windows per passare il testimone a te su macOS.

## Contesto veloce

Il progetto è **BananaChePrezzi** (repo: https://github.com/Maxigio/AGG.git) —
aggregatore di annunci auto/moto usati da Subito/Autoscout/Moto.it, pensato
per l'uso quotidiano del padre (non tecnologico) dell'utente, che ha un
**MacBook Air Intel pre-2020** (quindi target x64, NON universal).

Il lavoro fatto finora su Windows:

- ✅ Scraper funzionanti su Win + fix cross-platform Chromium path (in `backend/scrapers/utils.js::resolveChromiumExecutable`).
- ✅ `package.json` configurato per `electron-builder --mac --x64` con publish su GitHub Releases `Maxigio/AGG`.
- ✅ Script `scripts/prepare-mac-chromium.js` per scaricare Chromium x64-Mac.
- ✅ Script `scripts/make-mac-icon.sh` per generare `electron/icon.icns` da `electron/icon.svg`.
- ✅ Modulo auto-update in `electron/auto-update.js` già integrato in `electron/main.js` (attivo solo se `app.isPackaged`).
- ✅ Documenti: `docs/BUILD_MAC_GUIDE.md` (per l'utente), `docs/GUIDA_PAPA.md` (stampabile).

**Tutto girava correttamente su Windows (smoke test passato dopo i fix cross-platform).**

## Cosa serve fare su Mac

L'utente è su **iMac Intel** (stessa arch del target, semplifica tutto). Il
flusso è documentato in `docs/BUILD_MAC_GUIDE.md` — seguilo, **non
reinventare**. In sintesi:

```bash
# 1. Clone e dipendenze (se primo avvio)
git clone https://github.com/Maxigio/AGG.git
cd AGG
npm install

# 2. Download Chromium x64-Mac
npm run prepare:mac

# 3. Genera icona (se manca electron/icon.icns)
chmod +x scripts/make-mac-icon.sh
./scripts/make-mac-icon.sh

# 4. Build DMG
npm run build:mac
```

Output atteso: `dist/Auto Moto Radar-1.0.0.dmg` (~300-400 MB).

## Checklist per te (Claude sul Mac)

Esegui questi passaggi in ordine e riporta all'utente ciò che trovi.

### Fase 1 — Verifiche ambiente

```bash
node -v          # Deve essere ≥ 20
git --version    # Qualsiasi versione recente va bene
sw_vers          # Verifica macOS (qualsiasi versione recente va bene)
uname -m         # Deve essere x86_64 (iMac Intel) — se "arm64" avvisa l'utente
which rsvg-convert || echo "librsvg non installato"
```

Se l'iMac dell'utente è **Apple Silicon** (`uname -m` = `arm64`), **avvisalo**:
la build in quel caso deve scaricare esplicitamente Chromium x64-Mac (lo
script `prepare-mac-chromium.js` lo gestisce, ma Playwright CLI di default
installerebbe la variante arm64 — il fallback scarica direttamente dalla CDN
la versione x64). **Non dare per scontato** che l'iMac sia Intel: verifica.

Se `librsvg` manca, suggerisci `brew install librsvg` ma **non bloccarti**:
lo script `make-mac-icon.sh` ha un fallback su `qlmanage`.

### Fase 2 — Setup repo

**Situazione probabile**: il progetto è stato trasferito dalla macchina Windows
all'iMac via AirDrop / Dropbox / USB — quindi è una cartella **senza `.git`**
(non è un clone). Il repo GitHub https://github.com/Maxigio/AGG.git potrebbe
essere vuoto o vecchio.

Chiedi all'utente quale dei due casi:

**Caso A) Cartella trasferita da Windows (nessun .git)**

```bash
# L'utente ti dice dove l'ha copiata, tipo ~/Desktop/BananaChePrezzi-main
cd ~/Desktop/BananaChePrezzi-main

# Rimuovi artefatti Windows-specific che non servono sul Mac
rm -rf node_modules/ pw-browsers/ dist/

# Init git e primo push al repo Maxigio/AGG
git init
git branch -M main
git remote add origin https://github.com/Maxigio/AGG.git
# Se il repo ha già commit (es. è stato clonato altrove), fai prima:
#   git fetch origin
#   git reset --soft origin/main   (per ereditare la history)
git add .
git commit -m "Initial commit: porting da Windows a Mac"
git push -u origin main --force   # --force solo al primo push
```

**Caso B) Repo già clonato da GitHub**

```bash
cd ~/dove/sta/il/repo
git pull
```

Poi in entrambi i casi:
```bash
npm install
```

⚠️ **Electron scarica ~150 MB** in `node_modules`. Può richiedere 2-5 minuti
in base alla connessione.

⚠️ **Chiedi all'utente se il repo su GitHub è pubblico o privato**: se
privato, l'auto-update scritto in `electron/auto-update.js` NON funzionerà
senza un token (oggi usa l'API non autenticata). Avvisalo: per ora deve
essere pubblico, oppure va aggiunta l'auth nel modulo auto-update.

### Fase 3 — Chromium x64-Mac

```bash
npm run prepare:mac
```

Verifica:
```bash
ls pw-browsers/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium
```

Deve stampare **un** path (non "no matches"). Se manca, ispeziona `pw-browsers/`
per capire cosa Playwright ha scaricato — potrebbe aver preso la variante
arm64 (cartella `chrome-mac-arm64/`). In quel caso:

```bash
# Forza download x64 dalla CDN
REV=$(node -p "require('./node_modules/playwright-core/browsers.json').browsers.find(b=>b.name==='chromium').revision")
curl -L "https://playwright.azureedge.net/builds/chromium/${REV}/chromium-mac.zip" \
  -o "pw-browsers/chromium-${REV}/chromium-mac.zip"
cd "pw-browsers/chromium-${REV}" && unzip -o chromium-mac.zip && rm chromium-mac.zip
cd -
chmod +x "pw-browsers/chromium-${REV}/chrome-mac/Chromium.app/Contents/MacOS/Chromium"
```

### Fase 4 — Smoke test scraper su Mac (CRITICO)

**Non saltare questo passaggio.** Prima di buildare il DMG, verifica che
Playwright parta davvero con il Chromium appena scaricato:

```bash
node -e "
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'pw-browsers');
const { chromium } = require('playwright');
const { resolveChromiumExecutable } = require('./backend/scrapers/utils');
(async () => {
  const exe = resolveChromiumExecutable(path.join(__dirname, 'pw-browsers'));
  console.log('Exe:', exe);
  const b = await chromium.launch({ executablePath: exe, headless: true });
  const p = await b.newPage();
  await p.goto('https://example.com');
  console.log('Title:', await p.title());
  await b.close();
})();"
```

Deve stampare `Title: Example Domain`. Se errore tipo "cannot execute", è
permesso eseguibile mancante (`chmod +x` sul binario) o Gatekeeper sul
Chromium scaricato. Per sbloccare quarantine su Chromium:
```bash
xattr -cr pw-browsers/
```

### Fase 5 — Test server completo su Mac

Prima di buildare, verifica che un api/search funzioni dalla Mac:
```bash
PORT=3003 node backend/server.js &
sleep 30  # Attendi pre-warm dei 3 browser
curl -s "http://localhost:3003/api/search?tipo=moto&marca=Yamaha&modello=MT-07&regione=lombardia" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('Totale:',j.totale)});"
# Deve stampare "Totale: ~290+"
kill %1
```

Se stampa 0 o errore, c'è un problema di compatibilità ambiente che va
investigato PRIMA del build (il DMG funzionerà solo se qui funziona).

### Fase 6 — Icona

```bash
chmod +x scripts/make-mac-icon.sh
./scripts/make-mac-icon.sh
ls -lh electron/icon.icns
```

Verifica che sia almeno 100 KB (altrimenti è stato convertito male).

### Fase 7 — Build DMG

```bash
npm run build:mac
```

Output in `dist/`. Il nome esatto contiene la versione di `package.json`:
```
dist/Auto Moto Radar-1.0.0.dmg
```

### Fase 8 — Test DMG su iMac prima di consegnare

```bash
open "dist/Auto Moto Radar-1.0.0.dmg"
```

- Trascina l'icona in Applicazioni (sovrascrivi se già presente).
- Apri con **click-destro → Apri** (prima volta).
- Verifica che la UI appaia e una ricerca funzioni.
- Se ok, chiudi e **rimuovi l'app dall'iMac** (non è la sua macchina target):
  ```bash
  rm -rf "/Applications/Auto Moto Radar.app"
  ```

### Fase 9 — Consegna al MacBook di papà

Istruisci l'utente a:
1. Trasferire il DMG via **AirDrop** al MacBook di papà.
2. Recarsi di persona (o videochiamata) sul MacBook per il primo setup (5 min):
   - Trascina in Applicazioni
   - Terminale: `xattr -cr "/Applications/Auto Moto Radar.app"`
   - Primo avvio: doppio click
3. Aggiungere alias al Dock e alla Scrivania.

### Fase 10 — Pubblica release GitHub per abilitare auto-update

Se l'utente ha `gh` CLI configurato:
```bash
gh auth status  # Verifica sia loggato
gh release create v1.0.0 \
  "dist/Auto Moto Radar-1.0.0.dmg" \
  --title "Auto Moto Radar v1.0.0" \
  --notes "Prima release."
```

Altrimenti guidalo a farlo via UI web:
https://github.com/Maxigio/AGG/releases/new

**Importante**: deve caricare il file DMG come asset della release, non solo
creare il tag. L'auto-update legge `assets[].browser_download_url`.

## File chiave del progetto (per orientarti velocemente)

- `backend/server.js` — Express server, unisce i 3 scraper
- `backend/scrapers/*.js` — Playwright scrapers (Subito, AS24, Moto.it)
- `backend/scrapers/utils.js` — helpers + `resolveChromiumExecutable` cross-platform
- `electron/main.js` — entry Electron, fa fork del server
- `electron/auto-update.js` — check GitHub Releases all'avvio
- `frontend/index.html` — UI
- `data/models.json` — catalogo unificato brand/modelli/slug
- `data/province.json` — mapping CAP → regione/provincia

## Memory rilevanti (in `.claude/projects/.../memory/`)

Se hai accesso alle memory, le più utili per il contesto del progetto sono:
- `project_bananacheprezzi.md` — overview del progetto
- `user_father.md` — profilo utente target
- `feedback_completeness_first.md` — priorità (non perdere annunci economici)
- `as24_region_filter.md` — fix recente del filtro regione AS24
- `motoit_scraper_v2.md` — dettagli scraper Moto.it

## Cosa evitare

- **Non firmare il codice** in modi fittizi: senza Apple Developer ID vero, non c'è trucco. L'approccio unsigned + `xattr -cr` è intenzionale.
- **Non usare `--universal`**: il target è SOLO Intel. Universal raddoppia il peso del DMG inutilmente.
- **Non riscrivere gli scraper**: funzionano già. I fix recenti sono in `memory/as24_region_filter.md` (non romperli).
- **Non commitare `pw-browsers/`**: c'è un `.gitignore` che lo esclude (verifica con `cat .gitignore`). In caso contrario, aggiungilo.
- **Non toccare `data/models.json` e `data/province.json`** senza sapere cosa fai: è catalogo curato con centinaia di brand/modelli mappati su 3 siti.

## In caso di problemi imprevisti

Se incontri un blocco non coperto qui:
1. **Fermati e chiedi all'utente** — il progetto è importante per suo padre, non rischiare decisioni autonome su codice in produzione.
2. Riporta output completi (non troncati) di comandi falliti.
3. Non cancellare mai `node_modules/`, `pw-browsers/`, `dist/` senza conferma.

---

*Creato il 2026-04-21 dalla sessione Windows. Buon lavoro.* 🍌
