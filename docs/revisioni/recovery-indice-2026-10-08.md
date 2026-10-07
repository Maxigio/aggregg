# Punto di recovery esplicito — 8 ottobre 2026

Baseline `e5efdd1`, branch `feat/nodi-residenziali-prototipo`. Segue
[discovery senza source](storage-r2-recovery-2026-10-07.md). L'utente ha
approvato indice cifrato, ricevuta separata e stop se manca una copia richiesta
o l'indice non è verificabile. La seconda copia offline della chiave è
concordata, ma la sua effettiva custodia non è ancora attestata.

## Piano verificato e limiti

La sola lista degli snapshot disponibili non può segnalare un intero snapshot
scomparso. Si conserva quindi un punto esplicito, costruito con il source
congelato: ID del dump e lista attesa dei journal dell'outbox. Non si inventa
continuità dalla sequence PostgreSQL, che può avere buchi legittimi.

L'indice usa la cifratura/integrità restic già presente. Nessun algoritmo
crittografico nuovo, dipendenza, password nel payload o archivio di annunci.
Una ricevuta separata indica repository, snapshot esatto dell'indice e SHA-256
dei suoi byte. È un'ancora fidata da custodire fuori dai repository: il suo
hash non è una firma e non protegge se un attaccante può sostituire anche la
ricevuta. Non usare `latest` o un indice vecchio come ripiego silenzioso.

Il punto attesta gli ID forniti dal source, non l'intera vita futura dell'app.
Una ricevuta vecchia non dimostra l'assenza di operazioni successive. La
produzione richiederà pubblicazione e custodia aggiornate, uno stato visibile
dei mancati checkpoint e un nuovo punto dopo modifiche di retention. La
retention distruttiva non è autorizzata da questo incremento.

## Implementazione

- `backup-restic.js`: `copiaIndice` conserva `/recovery.json`, tag `recovery`,
  nel repository database. `leggiIndice` accetta solo un ID completo e al
  massimo 16 MiB. Categoria separata da dump/journal: nessuna retention
  automatica, discovery o selezione del più recente. I comandi delle due
  categorie precedenti conservano argomenti e limiti.
- `recovery-indice.js`: valida schema chiuso, due repository diversi, dump
  esatto, massimo 10.000 ID journal univoci. Prima di pubblicare controlla
  presenza e validità di tutti i journal, poi copia e rilegge l'indice.
  Una copia con readback fallito non produce una ricevuta confermata; può
  comunque esistere e non va ripetuta alla cieca.
- Il recovery riceve solo ricevuta e repository. Verifica SHA, identità,
  presenza del dump e di ogni journal atteso, quindi riusa il parser/replay
  esistenti per ordine e conflitti. Nessuna connessione SQL o modifica DB
  nel modulo dell'indice. Il dump viene verificato con restore restic prima
  del suo impiego in PostgreSQL, non dalla sola presenza nell'indice.
- `collauda-backup-r2-postgres.js`: source sintetico congelato, ID attesi
  presi dall'outbox; ricevuta privata separata dai repository; source spento
  prima del recovery. La prova sceglie esplicitamente il dump vecchio per
  esercitare sette journal successivi, non come policy di recovery.

Non è ancora collegato il backup operativo del runtime staging. Nessuna
modifica a Nhost, R2, credenziali, M2 o portali effettuata da questo incremento.

## Prove e controprove

Node **24.21.0**, restic **0.19.1**, binario preesistente verificato SHA-256
`b2b553b402b9971b0c3f673d880397a421526f55a08f21fe5b82b5dd9e049a08`.
Nessuna installazione. Gate indice/restic/replay: **124/124**, zero
fail/skip/cancel, 85,734 s. Include prove restic reali solo su nuovi repository
locali. Gate collaudo/backup/notifiche interne: **16/16**, zero fail/skip/cancel.

Controprove: snapshot journal omesso ma discovery residua valida; dump
mancante con un altro dump disponibile; ricevuta/payload alterati; repository
diverso; lista attesa assente/duplicata/oltre cap; journal illeggibile o
invalido; readback fallito; input inatteso. Il recovery si ferma senza un
nuovo punto scelto implicitamente. La prova nativa sposta soltanto lo
snapshot della propria fixture, ne ripristina il file e conferma `check`.
Nessuna copia remota eliminata.

PostgreSQL **18.6**, immagine già presente e fissata per digest; due cluster
sintetici nuovi. Ricevuta:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-r2-pg-uDC3yy/esito.json`.
Conclusa alle **01:06:02 Europe/Rome**, 8 ottobre: 251.435 byte, due dump,
tredici journal, un indice cifrato. Source spento prima della lettura del punto;
copia omessa bloccata prima del restore; sette journal applicati e sei
superati, retry idempotente, stato commerciale equivalente, revoche e permessi
preservati, vecchi accessi invalidati. Cleanup dei soli container/rete della
fixture confermato; repository locali e chiave di prova conservati privatamente.
Retention solo dry-run: zero eliminazioni.

Review indipendente in sola lettura: nessun finding confermato nel perimetro.
Il reviewer ha eseguito 81 test passati e 13 controprove sintetiche; cinque
prove native non eseguite da lui. Le prove native e PG sopra sono del main.
Non è un nuovo collaudo Auth completo né prova dello storage remoto.

## Fonti e prossimo gate

- [restic: formato e threat model](https://restic.readthedocs.io/en/stable/100_references.html):
  cifratura e autenticazione dei contenuti; una lista disponibile non
  attesta automaticamente snapshot completamente scomparsi.
- [restic: restore](https://restic.readthedocs.io/en/stable/050_restore.html):
  ID esplicito, lettura e verifica; niente restore sul database vivo.
- [OWASP: cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html):
  protezione/separazione delle chiavi. Una copia privata sullo stesso disco
  non equivale a una seconda copia offline o a un vault.

Login Cloudflare ripristinato dall'utente e pannello R2 verificato l'8 ottobre.
Gate operativo ancora aperto: nuovi bucket staging e credenziale stabile
limitata, chiave e ricevuta custodite separatamente,
backup vivi e restore isolato del candidato. Questi prerequisiti precedono
le modifiche remote e M2. Log/bug report R2 restano al gate della console,
come richiesto; frontend non anticipato.
