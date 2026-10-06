# Gate locale dell'immagine e preparazione staging — 7 ottobre 2026

## Perimetro

L'utente autorizza staging e M2 solo stato con il CHECK storico ancora aperto.
Questo non autorizza la produzione, non attribuisce il CHECK e non elimina
i gate su ingress, backup, migrazioni e identità degli artefatti.
L'originale remoto `66e2b24` è stato ripristinato e verificato nella
[sonda ingress](staging-ingress-sonda-2026-10-06.md). Nessun M2 collegato in
questo incremento.

## Difetto confermato nella ricetta

Il candidato pubblico `56f9857dc0a68037179eb99902921e052c01b4e5`, materializzato
dai blob Git, ha file 0600 e directory 0700. Anche il produttore
`scripts/prepara-contesto-centro.js` può generare questi permessi con umask 077:
il modo 0644 passato a `writeFileSync` viene ridotto dalla umask.
Non è un problema di credenziali o del provider Auth.

`COPY` conserva i permessi, mentre nell'immagine l'owner resta root.
La ricetta precedente verificava il manifest come root, toglieva i bit di
scrittura e passava a `USER node`: i file rimanevano 0400 e le directory 0500.
Il container non poteva leggere il suo codice. La prima prova del costruttore
registra `EACCES`; il gate Auth dell'immagine si ferma nell'avvio HTTPS.
Un build riuscito come root non dimostrava l'avvio non-root.

Correzione circoscritta a `scripts/docker/centro.Dockerfile`:

- rendere leggibile/attraversabile il codice mediante `a+rX,a-w`;
- mantenere l'owner root e l'assenza dei bit di scrittura;
- eseguire la verifica del manifest dopo `USER node`, già durante la build;
- mantenere scrivibile per node solo la directory dei dati `/var/lib/amr`.

`X` non aggiunge esecuzione ai normali file 0600. Non si usa `chown node` sul
codice, che permetterebbe all'utente del servizio di cambiarne i permessi.
Nessun permesso sul checkout o sul computer host è modificato.
Fondamento: [Docker COPY e USER](https://docs.docker.com/reference/dockerfile/).

## Prove locali e limiti

- Suite sul sorgente congelato `56f9857`, Node 24.21.0, dati/log temporanei,
  dotenv reale escluso: 1.604 test, 1.593 pass, 11 skip, zero fail/cancelled.
  Gli skip opt-in non attestano PostgreSQL, Restic o la CLI reale.
  Ricevuta: `/private/tmp/amr-suite-56f9857-10ENmP/esito.json`.
- Test pertinenti alla ricetta/avvio/compatibilità: 75 test, 73 pass, due skip,
  zero fail. `/private/tmp/amr-permessi-test-20261007.tap`.
- Primo gate dell'immagine originale: exit 1 all'avvio, non PASS Auth.
  `/private/tmp/amr-gate-candidato-56f9857-ruk3d99y/collaudo.log`.
- Build corretta di prova `amr-centro:permessi-prova-20261007`: linux/amd64,
  verifica del manifest eseguita con successo come node.
  `/private/tmp/amr-build-permessi-prova-20261007.log`.
- Costruttore nell'immagine corretta, rete assente, PostgreSQL simulato:
  avvio riuscito, exit 0, nessun EACCES, cleanup verificato.
  `/private/tmp/amr-avvio-permessi-esito-20261007.json`.

La ricetta di prova alla radice è un overlay sul contesto `56f9857`, SHA-256
`198390f726138b0e0395f897d9f7579da69553ac9ec70677750e25e58e315d93`.
**Non è un artefatto distribuibile:** il manifest inventaria anche la ricetta
in `scripts/docker/`. La release finale richiede il commit della correzione,
un nuovo contesto dai suoi blob Git e un nuovo manifest, senza overlay.
Il primo build multiarch ha fallito nell'installazione npm ARM64 con
`ECONNRESET`; non certifica ARM64 né un difetto del codice applicativo.

Review indipendente del diff: nessun finding confermato. Le controprove
mostrano che il manifest verifica i contenuti inventariati, non da solo owner,
permessi o tutte le dipendenze: questi controlli restano distinti.
Verifica indipendente nell'immagine, UID/GID 1000: 854 directory 0555,
9.530 file aperti in lettura, tutti root-owned e senza bit di scrittura.
I 697 file inventariati sono 0444 e hanno hash coerenti con il manifest.
Cinque symlink root-owned risolvono all'interno di `/opt/amr`; il loro mode
Linux 0777 non dà accesso in scrittura al link, e i parent non sono scrivibili.
Nessun mount/porta o rete esterna nella prova; cleanup confermato.
Gate Auth completo sull'immagine corretta: exit 0, cleanup verificato,
otto container preesistenti preservati. Auth 0.49.1 e PostgreSQL 18.6 reali
locali: verifica email/MFA, inviti e quote concorrenti, rinnovi e revoche,
guard HTTPS, permessi commerciali e compatibilità del manifest. La ricerca
resta sintetica, senza portali. Avvio breve 96 ms, 14 consultazioni, lavoro
di 16.001 ms oltre il timeout proxy di 15.000 ms, un solo job. SIGTERM/uscita
0, stesso volume, sospensioni/revoche conservate e vecchie sessioni negate.
`/private/tmp/amr-auth-permessi-gate-z8aqbou8/collaudo.log` e `esito.json`.
Nessun 23514 in questo giro: non attribuisce né chiude il CHECK storico e
non sostituisce il collaudo della versione Auth remota.

## Preparazione delle migrazioni e del collegamento M2

Pacchetto append-only delle tre migrazioni dopo `66e2b24`, SHA-256
`8c08ac398a1e3941b34501b8ffef1739eb5d87465cdb7f446af758ab215901e8`:
24.188 byte. Prova su PostgreSQL 18.6 isolato: dati e sequenze invariati,
rollback su guasto intermedio e prima del commit, drift rifiutato prima del
DDL, riapplicazione rifiutata, funzioni non pubbliche e ruolo minimo.
Ricevuta `/private/tmp/amr-migrazioni-esito-20261007.json`, cleanup verificato.
I primi errori 42809/42601 appartenevano alle query del harness, corrette
prima della ricevuta finale; non dimostrano un fallimento della migrazione.
Nessun SQL eseguito sullo staging remoto. Una risposta persa al commit
resta un esito incerto da riconciliare, senza retry cieco.
Riferimento: [PostgreSQL CREATE FUNCTION](https://www.postgresql.org/docs/18/sql-createfunction.html).

Launcher/collaudo M2 temporanei: 51 prove locali passate, di cui 15 IPC/socket
Unix reali, 11 VM e 25 stub Python. Review indipendente: altre 45 prove VM,
nessun finding confermato. Non si sommano come prove remote.
Avvio subordinato a ricevuta privata persistita e messaggio CONFERMA.
L'ACK attesta l'avvio al chiamante: perderne la risposta non dimostra che
il worker non sia partito. Recovery tramite socket privato, senza segnali
a PID numerici; uscita forzata dichiarata non nominale. Le prove native
usano un dummy worker e `avvia/close` archiviati, con allowlist adattata
in RAM e guasti iniettati: non provano il worker completo del nuovo candidato.
Ricevute sotto `/private/tmp/amr-ipc8c-D0lfVT/` e
`/private/tmp/amr-ipc8c-0uIOIL/`; la review VM indipendente è in
`/private/tmp/amr-readonly-patch-review-20261007-1y2bxccc/snapshot-1587467d3c1443415c6d/review-summary.json`.
I riferimenti sono ancora fissati al vecchio candidato: devono essere
rigenerati/verificati prima dell'uso effettivo.

Prima del nuovo staging resta la decisione sulla lista esplicita provvisoria
dei proxy osservati. Prima dell'M2 servono staging verificato, artefatti
identici e backup aggiornato con restore di prova. Le prove live M2 e la
console owner restano gate successivi; produzione e portali non coinvolti.
