#!/bin/bash
# Deploy di AMR sul Mac M2 — la procedura di DEPLOY-M2.md, automatizzata.
# Ogni passo esiste per un guasto già successo: l'ordine non si cambia.
# Si ferma al PRIMO errore: se stampa DEPLOY-OK in fondo, è andata davvero.
set -euo pipefail

CHIAVE=~/.ssh/amr_m2_ed25519
M2="massimo@100.66.119.62"
SSH=(ssh -i "$CHIAVE" -o IdentitiesOnly=yes -o ConnectTimeout=10 "$M2")
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PERIMETRO=$(mktemp)

passo() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

cd "$REPO"

passo "0. La macchina risponde"
"${SSH[@]}" 'echo "M2 raggiungibile: $(hostname)"'

passo "1. Backup sull'M2 (è il rollback: se dopo va storto, si riestrae questo)"
# amr-utenti.db è in WAL e lo scrive il server vivo: db/-wal/-shm letti in
# istanti diversi NON sono uno snapshot consistente (riestratto può risultare
# "malformed" o perdere transazioni). Nel tar entra quindi uno snapshot fatto
# con sqlite3 .backup — la stessa regola di backup-dati-m2.sh — mai il file
# vivo. Le -wal/-shm nel tar sono VUOTE apposta: riestraendo sopra la cartella
# viva troncano quelle stantie, che altrimenti verrebbero rigiocate sul db
# ripristinato corrompendolo.
"${SSH[@]}" '
  set -e
  rm -rf ~/amr-rollback && mkdir -p ~/amr-rollback/AutoMotoRadar/data
  /usr/bin/sqlite3 ~/AutoMotoRadar/data/amr-utenti.db ".backup /Users/massimo/amr-rollback/AutoMotoRadar/data/amr-utenti.db"
  : > ~/amr-rollback/AutoMotoRadar/data/amr-utenti.db-wal
  : > ~/amr-rollback/AutoMotoRadar/data/amr-utenti.db-shm
  B=~/AutoMotoRadar-backup-$(date +%Y%m%d-%H%M).tar
  cd ~ && tar --exclude=node_modules \
    --exclude=AutoMotoRadar/data/amr-utenti.db \
    --exclude=AutoMotoRadar/data/amr-utenti.db-wal \
    --exclude=AutoMotoRadar/data/amr-utenti.db-shm \
    -cf "$B" AutoMotoRadar
  tar -rf "$B" -C ~/amr-rollback \
    AutoMotoRadar/data/amr-utenti.db AutoMotoRadar/data/amr-utenti.db-wal AutoMotoRadar/data/amr-utenti.db-shm
  gzip -f "$B"
  rm -rf ~/amr-rollback
  ls -lh ~/AutoMotoRadar-backup-*.tar.gz | tail -1
'

passo "2. Perimetro e archivio da HEAD (MAI dal working tree)"
TMP=$(mktemp -d)
git archive HEAD | tar -x -C "$TMP"
# Il perimetro DEVE venire da HEAD come l'archivio: git ls-files legge l'INDICE,
# e un file in staging non committato starebbe nel perimetro ma non in $TMP —
# rsync copierebbe tutto il resto sull'M2 vivo e poi morirebbe (exit 23),
# lasciando codice nuovo con node_modules vecchi e il riavvio mai fatto.
git ls-tree -r --name-only HEAD -- backend frontend pagine data scripts docs/guida package.json package-lock.json > "$PERIMETRO"
N_FILE=$(wc -l < "$PERIMETRO" | tr -d ' ')
echo "HEAD: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) — $N_FILE file nel perimetro"

# I file sacri non devono MAI stare nel perimetro: se compaiono, qualcuno li ha
# aggiunti a git e questo deploy li sovrascriverebbe. Ci si ferma qui.
if grep -E 'data/(auth\.json|amr-utenti\.db)' "$PERIMETRO"; then
  echo "ERRORE: auth.json o amr-utenti.db sono tracciati da git. FERMO TUTTO." >&2
  exit 1
fi

# La data di auth.json prima del deploy: dopo, deve essere identica.
AUTH_PRIMA=$("${SSH[@]}" 'stat -f "%m" ~/AutoMotoRadar/data/auth.json 2>/dev/null || echo assente')

passo "3. rsync (senza --delete: i file fuori perimetro non si toccano)"
rsync -a --files-from="$PERIMETRO" "$TMP"/ \
  -e "ssh -i $CHIAVE -o IdentitiesOnly=yes" \
  "$M2":/Users/massimo/AutoMotoRadar/

passo "4. Dipendenze"
"${SSH[@]}" 'cd ~/AutoMotoRadar && /opt/homebrew/bin/npm install'

passo "5. Controlli PRIMA di riavviare"
"${SSH[@]}" 'cd ~/AutoMotoRadar && find backend scripts -name "*.js" | xargs -n1 /opt/homebrew/bin/node --check && echo SINTASSI-OK'
"${SSH[@]}" 'ls ~/AutoMotoRadar/pagine/'

passo "6. Riavvio e verifica"
"${SSH[@]}" 'launchctl kickstart -k gui/$(id -u)/com.automotoradar.m2 && sleep 4 && launchctl list | grep automotoradar'
"${SSH[@]}" 'tail -25 ~/Library/Logs/automotoradar.log'
CODICE=$("${SSH[@]}" 'curl -s -o /dev/null -w "%{http_code}" http://localhost:47321/api/brands?tipo=auto')
if [ "$CODICE" != "401" ]; then
  echo "ERRORE: /api/brands risponde $CODICE invece di 401 (il muro non è in piedi, o il server non è su)." >&2
  exit 1
fi
echo "muro in piedi (401)"

passo "7. md5: tutti identici, zero diversi, zero assenti ($N_FILE file)"
( cd "$TMP" && while read -r f; do md5 -q "$f" 2>/dev/null | sed "s|\$|  $f|"; done < "$PERIMETRO" ) > /tmp/md5-head.txt
"${SSH[@]}" 'cd ~/AutoMotoRadar && while read f; do md5 -q "$f" 2>/dev/null | sed "s|$|  $f|"; done' < "$PERIMETRO" > /tmp/md5-m2.txt
diff <(sort /tmp/md5-head.txt) <(sort /tmp/md5-m2.txt)
echo "IDENTICI"

passo "8. E che il database non sia stato toccato"
AUTH_DOPO=$("${SSH[@]}" 'stat -f "%m" ~/AutoMotoRadar/data/auth.json 2>/dev/null || echo assente')
if [ "$AUTH_PRIMA" != "$AUTH_DOPO" ]; then
  echo "ERRORE: la data di auth.json è cambiata durante il deploy. Riestrai il backup del passo 1." >&2
  exit 1
fi
# amr-utenti.db lo scrive il server vivo (utenti che lavorano): la sua data può
# cambiare per motivi legittimi. Il controllo vero è il perimetro del passo 2.
"${SSH[@]}" 'ls -l ~/AutoMotoRadar/data/auth.json ~/AutoMotoRadar/data/amr-utenti.db'

rm -rf "$TMP" "$PERIMETRO"
printf '\n\033[1;32mDEPLOY-OK\033[0m — %s file, HEAD %s\n' "$N_FILE" "$(git rev-parse --short HEAD)"
