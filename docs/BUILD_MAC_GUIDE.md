# Build DMG per macOS — Guida operativa (per te)

Questa guida ti porta dal repo su Windows al DMG consegnabile al MacBook Intel di tuo padre.

## Prerequisiti iMac

- macOS Ventura o superiore
- Node.js ≥ 20 (`node -v`)
- Git (`git --version`)
- Librsvg per l'icona (opzionale, migliore qualità): `brew install librsvg`

## 1. Clone e setup iniziale (prima volta)

```bash
cd ~/Sviluppo   # o dove preferisci
git clone https://github.com/Maxigio/AGG.git
cd AGG
npm install
```

`npm install` tira giù anche `electron`, `electron-builder`, `electron-updater`.

## 2. Scarica Chromium x64-Mac

```bash
npm run prepare:mac
```

Script intelligente:
1. Prova `npx playwright install chromium` — su iMac Intel installa la build x64-Mac nativa.
2. Se fallisce, fallback su download diretto dalla CDN Playwright.

Al termine verifica:
```bash
ls pw-browsers/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium
```
Deve esistere un file eseguibile.

## 3. Genera icona .icns

```bash
chmod +x scripts/make-mac-icon.sh
./scripts/make-mac-icon.sh
```

Produce `electron/icon.icns` partendo da `electron/icon.svg`. Se vuoi un'icona
diversa, sostituisci l'SVG e rilancia lo script (serve solo al primo build o
quando cambi il design).

## 4. Build del DMG

```bash
npm run build:mac
```

Equivalente a `npm run prepare:mac && electron-builder --mac --x64`. Output:
```
dist/Auto Moto Radar-1.0.0.dmg
```

Dimensione attesa: **~300-400 MB** (include Chromium x64-Mac).

## 5. Test sull'iMac prima di consegnare

```bash
open "dist/Auto Moto Radar-1.0.0.dmg"
```

Trascina l'icona in Applicazioni, apri con **click-destro → Apri** (la prima
volta macOS avverte "sviluppatore non identificato"). Verifica:

- [ ] L'app si apre, vedi la UI di ricerca.
- [ ] Una ricerca di prova restituisce risultati (serve rete).
- [ ] I link "Vedi annuncio" si aprono nel browser di sistema, non dentro l'app.

Se tutto ok, sposta l'app fuori da Applicazioni dell'iMac (per non lasciare
residui) e consegna il DMG al MacBook di papà.

## 6. Consegna al MacBook Intel di papà

**Trasferimento DMG**: AirDrop è il metodo più semplice. Se i due Mac non si
vedono, USB o iCloud Drive vanno bene. Il DMG è circa 300-400 MB.

**Primo setup (in presenza, una volta sola — 5 minuti):**

1. Apri il DMG sul MacBook, trascina l'icona in Applicazioni.
2. Apri **Terminale** (Cmd+Spazio → digita "Terminale" → Invio).
3. Incolla ed esegui:
   ```
   xattr -cr "/Applications/Auto Moto Radar.app"
   ```
4. Da ora in poi, doppio click normale dall'icona in Launchpad/Dock o
   Applicazioni — nessun prompt "sviluppatore non identificato".
5. Metti un alias sul Dock e sulla Scrivania di papà per comodità.

## 7. Pubblica release su GitHub (per abilitare auto-update)

```bash
# Aggiorna versione in package.json (da 1.0.0 a 1.0.1, ecc.)
npm version patch    # o minor/major

git push origin main --tags

# Crea release su GitHub (serve `gh` CLI: brew install gh, poi gh auth login)
gh release create v$(node -p "require('./package.json').version") \
  "dist/Auto Moto Radar-$(node -p "require('./package.json').version").dmg" \
  --title "Auto Moto Radar v$(node -p "require('./package.json').version")" \
  --notes "Bug fix e miglioramenti."
```

L'app di papà al prossimo avvio troverà la nuova release, gli chiederà
"Aggiorna ora?" → scarica il DMG e apre il Finder. Lui trascina l'icona, **la
nuova versione eredita il via libera dal quarantine già rimosso**, quindi non
deve rifare il passaggio Terminale.

## Troubleshooting

### Il DMG si apre ma l'app non parte

Controlla console.log aprendo il Terminale e lanciando:
```
/Applications/Auto\ Moto\ Radar.app/Contents/MacOS/Auto\ Moto\ Radar
```

Cause più probabili:
- **Chromium non bundlato**: `ls /Applications/Auto\ Moto\ Radar.app/Contents/Resources/pw-browsers/` — se vuoto, il `prepare:mac` non ha lavorato. Rifai build.
- **Path Chromium sbagliato**: controlla che `backend/scrapers/utils.js` abbia la funzione `resolveChromiumExecutable`.

### L'app dice "non è possibile aprire" su papà

Hai saltato il passaggio `xattr -cr`. Ripeti dal Terminale:
```
xattr -cr "/Applications/Auto Moto Radar.app"
```

### Auto-update non parte

- Controlla che la release su GitHub abbia un asset `.dmg` visibile (niente draft).
- Il `tag_name` deve essere strettamente maggiore della versione locale (es. `v1.0.1` > `v1.0.0`).
- L'app logga `[auto-update]` nella console di Electron (`Shift+Cmd+I` dal menu Visualizza se abiliti DevTools temporaneamente).
