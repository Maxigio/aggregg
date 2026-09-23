# Aggiornare AMR sul Mac M2

Il Mac M2 in casa è **il server**: è quello che papà usa e quello che gli altri raggiungono da
fuori. Qui si sviluppa, lì si serve. Questo documento è la procedura provata — non un promemoria:
seguila nell'ordine, perché ogni passo esiste per un guasto già successo.

Prima di oggi (2026-08-12) di questa procedura non c'era traccia in nessun file del repo.

---

## La macchina

| cosa | dove |
|---|---|
| nodo Tailscale | `auto-moto-radar` · `100.66.119.62` |
| indirizzo pubblico | `https://auto-moto-radar.tailc82888.ts.net` (Tailscale Funnel) |
| accesso | `ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62` |
| installazione | `/Users/massimo/AutoMotoRadar` — **non è un repo git**, è una cartella copiata |
| Node | `/opt/homebrew/bin/node` |
| servizio | launchd `com.automotoradar.m2` (PORT 47321, KeepAlive) + `com.automotoradar.caffeinate` |
| log | `~/Library/Logs/automotoradar.log` |
| riavvio | `launchctl kickstart -k gui/$(id -u)/com.automotoradar.m2` |

`~/Desktop/BananaChePrezzi` su quella macchina è un residuo del 2026-06 senza `package.json`:
**non è quella che gira.**

---

## I file che non si sovrascrivono MAI

Sono l'unica copia al mondo di quello che contengono. Un `rsync` che li porta via non si annulla.

- **`data/auth.json`** — le credenziali di tutti: hash delle password e il segreto che firma i
  cookie. Sovrascriverlo significa che nessuno entra più, papà compreso.
- **`data/amr-utenti.db`** (e i suoi `-wal` / `-shm`) — **il magazzino delle persone**: richieste
  di registrazione, inviti, ricerche salvate, annunci salvati, ricambi, impostazioni di prezzo,
  parco concorrenti, contatori del tetto giornaliero. Dal 2026-08-12 è il posto dove vivono i dati
  di chi si registra dal sito. Le vecchie ricerche e gli annunci salvati sono stati rimossi
  dal prodotto: non usare questa descrizione come elenco delle funzioni ancora attive.

Sono entrambi in `.gitignore`, quindi **non** compaiono in `git ls-files` e il perimetro qui sotto
non li tocca. Il `.gitignore` è la difesa; il fatto che siano scritti qui è la seconda.

**Come si salvano.** Il `tar` del passo 1 prende l'installazione, incluse le dipendenze e
`data/`; ogni SQLite viene aggiunto come snapshot `sqlite3 .backup`, non come copia del file
vivo. Il backup va provato con un ripristino separato prima del deploy. (Fino al 2026-08-17 c'era anche
`scripts/backup-db.js`, che faceva `pg_dump` di Postgres e questi due file non li toccava
comunque: è stato cancellato con tutto il resto di Postgres.)

---

## La procedura

### 1. Backup, prima di qualsiasi cosa

```bash
ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 '
  set -e
  rm -rf ~/amr-rollback && mkdir -p ~/amr-rollback/AutoMotoRadar/data
  for db in ~/AutoMotoRadar/data/*.db; do
    [ -f "$db" ] || continue
    nome=${db##*/}
    snap=~/amr-rollback/AutoMotoRadar/data/$nome
    /usr/bin/sqlite3 "$db" ".backup $snap"
    [ "$(/usr/bin/sqlite3 "$snap" "PRAGMA integrity_check")" = ok ]
    : > "$snap-wal"
    : > "$snap-shm"
  done
  B=~/AutoMotoRadar-backup-$(date +%Y%m%d-%H%M).tar
  cd ~ && tar \
    --exclude="AutoMotoRadar/data/*.db" \
    --exclude="AutoMotoRadar/data/*.db-wal" \
    --exclude="AutoMotoRadar/data/*.db-shm" \
    -cf "$B" AutoMotoRadar
  tar -rf "$B" -C ~/amr-rollback AutoMotoRadar/data
  gzip -f "$B"
  gzip -t "$B.gz"
  tar -tzf "$B.gz" >/dev/null
  rm -rf ~/amr-rollback
  ls -lh ~/AutoMotoRadar-backup-*.tar.gz | tail -1
'
```

Include anche `node_modules`: è più grande dei vecchi archivi, ma ripristina le dipendenze
che `npm install` può cambiare. Non riestrarlo sopra il servizio in esecuzione: fermare il
servizio, ripristinare codice, dipendenze e dati insieme, quindi riavviare e verificare.

Perché non un semplice `tar` di tutto: `amr-utenti.db` è in WAL e lo scrive il server vivo —
db, `-wal` e `-shm` fotografati in istanti diversi non sono uno snapshot consistente
(riestratto può risultare "database disk image is malformed" o perdere transazioni). Il db
entra nel tar SOLO come snapshot `sqlite3 .backup` (la stessa regola di
`scripts/backup-dati-m2.sh`), e le `-wal`/`-shm` nel tar sono vuote apposta: un ripristino
non deve rigiocare vecchie transazioni sul database fotografato.

### 2. Si sincronizza da HEAD, MAI dal working tree

Deciso e fatto il 2026-08-11. `git archive HEAD` in una cartella temporanea, e si copia da lì.

Il motivo è concreto: sul disco di sviluppo possono esserci modifiche non committate di un'altra
sessione di lavoro. Quel giorno erano `backend/auth.js` e `backend/whatsapp/{bot,webhook}.js` —
cioè proprio gli accessi, a metà di un lavoro. Copiare il working tree le avrebbe portate in
produzione senza che nessuno lo avesse deciso.

**Conseguenza da tenere a mente: quello che non è committato non arriva sull'M2.** Un file nuovo
non ancora aggiunto a git non esiste per `git archive`, e il deploy riesce senza di lui — e il
server non parte, o parte monco.

```bash
cd /Volumes/MAIN/BananaChePrezzi-main
TMP=$(mktemp -d) && git archive HEAD | tar -x -C "$TMP"
git ls-files backend frontend pagine data scripts docs/guida package.json package-lock.json > /tmp/perimetro.txt
wc -l < /tmp/perimetro.txt        # ~650 file
rsync -a --files-from=/tmp/perimetro.txt "$TMP"/ \
  -e "ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes" \
  massimo@100.66.119.62:/Users/massimo/AutoMotoRadar/
```

**Mai `--delete`.** Cancellerebbe proprio i file fuori perimetro, cioè quelli del capitolo
qui sopra.

Il perimetro è `git ls-files`, non una lista scritta a mano: il `.gitignore` esclude già
`.env`, `data/auth.json`, il database, le cache e i log.

Cosa deve esserci dentro, e perché:
- `scripts/` — `backend/server.js` richiede `build-frontend` e `build-guida` in cima: senza,
  non parte;
- `docs/guida/**` — la Guida (`/guida`) si monta all'avvio da quei markdown, quindi `docs/` non
  è più solo documentazione;
- `pagine/` — **dal 2026-08-12**: la pagina `/invito`. Sta fuori da `frontend/` di proposito
  (quella cartella la serve `express.static`, e il filesystem non distingue le maiuscole: quello
  che ci si mette dentro si scarica anche scritto in un altro modo). Se non arriva, chi apre un
  link d'invito prende un 404.

### 3. Dipendenze

```bash
ssh … 'cd ~/AutoMotoRadar && /opt/homebrew/bin/npm install'
```

Le dipendenze divergono da quelle dell'iMac (jspdf, jspdf-autotable, @anthropic-ai/sdk), e il
`postinstall` rifà `frontend/vendor/`. Il magazzino delle persone **non** aggiunge dipendenze:
`node:sqlite` è dentro Node (provato: iMac v26.4.0, M2 v25.8.1).

### 4. Controlli PRIMA di riavviare

```bash
ssh … 'cd ~/AutoMotoRadar && find backend scripts -name "*.js" | xargs -n1 /opt/homebrew/bin/node --check && echo TUTTO-OK'
ssh … 'ls ~/AutoMotoRadar/pagine/'          # invito.html
```

### 5. Riavvio e verifica

```bash
ssh … 'launchctl kickstart -k gui/$(id -u)/com.automotoradar.m2 && sleep 4 && launchctl list | grep automotoradar'
ssh … 'tail -25 ~/Library/Logs/automotoradar.log'
ssh … 'curl -s -o /dev/null -w "%{http_code}\n" http://localhost:47321/api/brands?tipo=auto'   # 401 = muro in piedi
```

Il 401 verifica solo che la rotta protetta chieda una sessione. Per un rilascio
servono anche login con una credenziale autorizzata, rifiuto di una credenziale
non valida e prove rappresentative di Auto, Moto, Ricambi, Competitor ed export
sul codice **effettivamente trasferito**. `scripts/deploy-m2.sh` non esegue
ancora queste prove né un rollback automatico: il suo
`TRASFERIMENTO-VERIFICATO` non è un'approvazione del rilascio. La situazione è in
`docs/REVISIONE-M2-2026-09-23.md`.

Nel log di avvio devono comparire `[frontend] minify OK v…` e `[guida] montata v… (11 sezioni)`,
con **gli stessi hash** del dev server locale: se differiscono, è arrivato codice diverso.

Righe normali su quella macchina, da non scambiare per guasti:
- `[prewarm] Subito/AS24 KO: pw-browsers non trovato` — lì Playwright non c'è e non serve: le tre
  fonti vanno via API/HTTP;
- (fino al 2026-08-17 usciva anche `[db] DATABASE_URL assente → persistenza/crawler
  disattivati`: Postgres è stato cancellato, quella riga non esiste più. **Il magazzino delle
  persone è un'altra cosa** e non c'entra: se manca *quello*, il log lo dice con parole sue.)

### 6. La prova di fine lavoro: md5

Non "sembra a posto": tutti identici, zero diversi, zero assenti. Quanti siano lo dice
`wc -l < /tmp/perimetro.txt` — erano 633 il 2026-08-17, e il numero cambia a ogni file
aggiunto o tolto: è quello il totale da confrontare, non un numero scritto qui.

```bash
cd "$TMP" && while read f; do md5 -q "$f" 2>/dev/null | sed "s|$|  $f|"; done < /tmp/perimetro.txt > /tmp/md5-head.txt
ssh … 'cd ~/AutoMotoRadar && while read f; do md5 -q "$f" 2>/dev/null | sed "s|$|  $f|"; done' < /tmp/perimetro.txt > /tmp/md5-m2.txt
diff <(sort /tmp/md5-head.txt) <(sort /tmp/md5-m2.txt) && echo "IDENTICI"
```

### 7. E che il database non sia stato toccato

```bash
ssh … 'ls -l ~/AutoMotoRadar/data/auth.json ~/AutoMotoRadar/data/amr-utenti.db 2>/dev/null'
```

La data di modifica di `auth.json` dev'essere **quella di prima del deploy**.
Il database SQLite e il suo WAL sono scritti dal server vivo, quindi la loro
data può cambiare legittimamente. La protezione del database è l'esclusione
esplicita dal perimetro di rsync; se cambia `auth.json`, fermati e verifica
prima di qualsiasi ripristino.

---

## Le persone

Chi entra sta in `data/auth.json`, in due modi che non vanno confusi:

- **dal `.env`** — `node scripts/utenti-da-env.js` rispecchia l'elenco scritto nel `.env`
  dell'iMac: chi c'è entra, chi non c'è più non entra più, e le credenziali vengono copiate anche
  sulle destinazioni di `AMR_AUTH_ANCHE` (compreso l'M2 via `scp`). ⚠ **Rigenera il segreto dei
  cookie: dopo un giro, tutti rifanno il login.** La copia remota legge e poi
  scrive `auth.json` in due operazioni distinte: se una registrazione arriva nel
  frattempo, può perdere l'aggiornamento. Non usarla come sincronizzazione
  concorrente finché la scrittura sul destinatario non è coordinata.
- **dal sito** — chi si registra da `/login`, viene approvato **da questa macchina** e si sceglie
  la password col link d'invito. Queste persone hanno `origine: "web"` e **`utenti-da-env.js` NON
  le tocca**: non stanno nel `.env` e non è una dimenticanza.

### Approvare, rifiutare, revocare: `scripts/richieste.js`

**Non c'è nessun pannello web, ed è una scelta.** C'era, dentro l'app, ed è stato tolto il
2026-08-12 dopo averne misurato il costo: approvare una richiesta crea una credenziale
**permanente**, cioè trasforma una sessione presa in prestito per un minuto — un telefono lasciato
sul bancone, non un attacco da internet — in un accesso che sopravvive alla scadenza del cookie,
alla revoca della sessione e al cambio della password del proprietario. L'approvazione restituisce
un link valido 48 ore che si consuma **senza più nessuna sessione**, e la variante peggiore non
fabbrica un account nuovo: approva una richiesta vera e se ne prende il nome.

**Chi ha chiesto di entrare, e chi entra già**

```bash
ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 'cd ~/AutoMotoRadar && /opt/homebrew/bin/node scripts/richieste.js --elenco'
```

**Approvare** — stampa il link da girare, e lo stampa **una volta sola**

```bash
ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 'cd ~/AutoMotoRadar && /opt/homebrew/bin/node scripts/richieste.js --approva "Mario Rossi"'
```

**Rifiutare** (il motivo è facoltativo e finisce nel registro)

```bash
ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 'cd ~/AutoMotoRadar && /opt/homebrew/bin/node scripts/richieste.js --rifiuta "Mario Rossi" non lo conosco'
```

**Togliere l'accesso a qualcuno**

```bash
ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 'cd ~/AutoMotoRadar && /opt/homebrew/bin/node scripts/richieste.js --revoca "Massimo"'
```

**Il registro: cosa è successo e quando**

```bash
ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 'cd ~/AutoMotoRadar && /opt/homebrew/bin/node scripts/richieste.js --registro 30'
```

Comodità, una riga nel proprio `~/.zshrc` — poi basta `amr-richieste --elenco`:

```bash
echo "alias amr-richieste=\"ssh -i ~/.ssh/amr_m2_ed25519 -o IdentitiesOnly=yes massimo@100.66.119.62 'cd ~/AutoMotoRadar && /opt/homebrew/bin/node scripts/richieste.js'\"" >> ~/.zshrc
```

Tre cose che evitano una sorpresa:

- **Il nome basta parziale**: `--approva "carla"` trova «Carla Prova». Se corrisponde a due
  richieste non ne sceglie una — le mostra e chiede il numero. Su un gesto che crea un accesso
  non si decide al posto di chi comanda.
- ⚠ **Si lancia SULL'M2, sempre.** Lanciato sull'iMac apre un **altro** archivio: qui `data/`
  esiste, quindi non darebbe nessun errore — mostrerebbe una coda vuota e approverebbe nel vuoto.
  Per questo la prima riga stampata è sempre il percorso del database aperto
  (`Archivio: /Users/massimo/AutoMotoRadar/data/amr-utenti.db [ok]`): **leggila**.
- **Le virgolette attorno al nome servono**, perché c'è uno spazio: senza,
  `--approva Mario Rossi` legge solo `Mario`.

Quando arriva una richiesta **non lo dice nessuno**: si vede con `--elenco`.

Il registro (`--registro`) tiene richieste, approvazioni, account creati, rifiuti e revoche. Non è
esposto da nessuna rotta web: ci arriva solo chi ha accesso alla macchina. **Non contiene i
token**, nemmeno le loro impronte: un registro da cui si può rubare un accesso sarebbe un secondo
posto da cui rubare un accesso.

Nell'app resta una sola cosa che riguarda gli altri, e in **sola lettura**: il proprietario vede
etichetta, criteri, ultimo controllo e numero di avvisi delle ricerche salvate di ciascuno — non
la coda degli avvisi, che contiene gli annunci e i prezzi che quella persona sta seguendo.

Il `.env` dell'M2 inietta **0 variabili** (sull'iMac ne inietta 18): gli accessi lì vivono in
`data/auth.json` e funzionano, ma `scripts/utenti-da-env.js` su quella macchina non avrebbe
nessun elenco da cui pescare. Quel comando si lancia **dall'iMac**.

---

## Postgres, crawler, worker: cancellati (2026-08-17)

Non sono più «in pausa»: sono **fuori dal repo**, per decisione del proprietario. Via
`backend/crawler.js`, `backend/dealer.js`, `backend/db/`, `db/*.sql`, `worker/`, `tools/owner/`
(la TUI Python), otto script, il `plist` del backup e la dipendenza `pg` — 79 file in tutto.

Cosa vuol dire in pratica, sull'M2:
- l'avvio non stampa più nessuna riga `[db]` né `[worker-bundle]`;
- `/api/crawl/*`, `/api/worker/*` e `/api/crawler/health` non esistono: rispondono 404 a chi è
  entrato, 401 a chi no (il cancello nega prima);
- `DATABASE_URL` nel `.env` non la legge più nessuno. Lasciarla lì non fa danno, toglierla neanche;
- **il magazzino delle persone (`data/amr-utenti.db`, SQLite) non c'entra e resta**: è dentro Node,
  non ha mai avuto a che fare con Postgres.

Se il job `com.automotoradar.backup` è caricato su una macchina, ora punta a uno script che non
c'è: va scaricato a mano (`launchctl bootout gui/$(id -u)/com.automotoradar.backup`).

Il codice resta nella storia di git: `git show <commit>^:backend/crawler.js` lo tira fuori.
