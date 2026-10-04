# Immagine del centro e gate locale — 4 ottobre 2026

## Perimetro e risultato

Branch `feat/nodi-residenziali-prototipo`, candidato `468b79c`.
Nessuna modifica tracciata preesistente all'inizio; file locali e lavoro APP
preservati. Costruzione e collaudo locali, non upload o deploy. Nessuna
credenziale reale letta, nessun contatto con Nhost, M2 o portali degli annunci.

Il gate dell'immagine aggiornata è **passato con exit 0**, compreso cleanup.
Due difetti dei soli strumenti di collaudo sono stati riprodotti e corretti.
Le correzioni degli script/test di questo incremento sono ancora nel worktree:
questo turno non richiede un commit. L'immagine attestata contiene il commit
sotto, non queste successive correzioni degli strumenti eseguiti sull'host.
Prima dell'upload, includere le correzioni nel commit candidato e rigenerare
contesto/manifest/immagine: l'inventario di compatibilità comprende gli script.

## Identità verificata

Contesto materializzato dai blob del commit, attraverso gli strumenti
esistenti; non dalla cartella di lavoro o da `node_modules` dell'iMac.

- release: `468b79cfd6f061660b72cd3d90f8f9aaa9b381f4`;
- codice: `bf0a17443ef025019654ce55f7c4776abe0d8dc6bdf22da75510dd8ac026a4c1`;
- cataloghi: `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`;
- tag locale: `amr-centro:staging-468b79c`;
- ID Docker: `sha256:b72a3d08bc26e83206ecb2a502e8bd12eee8a8f987b35a1933685437ef1bfb61`;
- Linux amd64, utente `node`, 116.627.737 byte.

Base Node 24.21.0 Bookworm slim fissata per digest; `npm ci` dal lockfile,
senza dev dependency o script di installazione; verifica dell'artefatto durante
la build. L'ID Docker locale non è un digest del registry. Le dipendenze sono
state riutilizzate dalla cache di build: questo passo non è uno scan CVE né
una verifica di nuove patch della base. Builder legacy deprecato disponibile
localmente; nessuna installazione di plugin per cambiare la toolchain.

## Finding, controprove e correzioni

### G01 — P2: gate non legato al candidato atteso

Il helper verificava l'integrità del manifest dentro il container, poi usava
quello stesso manifest per simulare il worker. Un'immagine vecchia ma integra
poteva passare, senza attestare il candidato richiesto.

Correzione: il launcher ricava il manifest dal commit HEAD una volta, prima
delle fixture; il helper lo richiede e confronta protocollo, release, codice
e cataloghi con il manifest verificato dentro l'immagine. Non usa il tag come
prova della release e non prende il valore atteso dal container.

Regressione sul codice precedente: il candidato diverso era accettato.
Dopo il fix: manifest identico accettato, differenza di release/codice/cataloghi
rifiutata. Prova positiva anche nel gate Docker reale. Il cambio di HEAD
durante la prova non modifica il manifest atteso già acquisito.

### G02 — P2: cleanup fallito poteva lasciare il gate positivo

Il launcher stampava un warning se `compose down` falliva, ma la Promise
poteva risolversi e il processo terminare con exit 0. Anche una chiusura di
risorsa locale fallita veniva soltanto segnalata.

Correzione: prova comunque tutte le chiusure; conserva i temporanei protetti
in caso di errore e rifiuta il gate con messaggio generico. La conferma finale
di successo viene stampata soltanto dopo il cleanup. Preserva anche i
temporanei necessari se il helper figlio non completa la propria pulizia.

Regressione sul codice precedente: `down` fallito non respingeva il gate.
Dopo il fix: fallimento di `down` o chiusura locale respinto, senza stampare
l'errore raw; successo elimina i temporanei. Il cleanup Docker reale ha
completato. Nessun prune, stop o cancellazione dei collaudi manuali esistenti.

## Prove eseguite e limite osservato

- Test pertinenti Node 24 con dati temporanei e dotenv disabilitato:
  **65/65 pass**, zero skip. Include avvio, HTTPS, compatibilità, configurazione
  e due nuove regressioni. Nessuna modifica al runtime applicativo.
- Gate reale locale: Auth Nhost 0.49.1, PostgreSQL 16, HTTPS con CA di prova,
  account sintetici, worker simulato e risposta Moto/Subito sintetica.
  Login/MFA, separazione Admin/referente, Auto negato all'azienda Moto,
  revoche, quote 10/30, ricerca, sospensione e revoca del token verificati.
- Manifest interno confrontato con candidato atteso; centro senza porta
  diretta pubblicata, UID 1000 e volume nominato. SIGTERM exit 0, nessun OOM,
  stesso volume dopo riavvio; vecchie sessioni negate e stato persistito.
- Processo lanciato con ambiente esplicito (`env -i`), HOME e DOCKER_CONFIG
  temporanei/vuoti; non con la configurazione Docker personale.
- Dopo il cleanup, nessun container/rete/volume con label del gate; elenco
  dei container manuali preesistenti invariato.

Il primo giro si è fermato **prima dell'immagine**, nella fixture colleghi
`nodi-colleghi-pg.test.js:172` → accettazione del referente. È lo scenario
già osservato in precedenza. Non si è modificato o escluso il test, non si sono
allargati timeout o quote. Il secondo giro, con osservazione temporanea dei
soli codici SQL al confine del pool, è passato completamente. L'analisi
indipendente delle quote non trova un doppio conteggio: 10 aziende/30 posti.
**La causa del primo fallimento resta non dimostrata**; la ripetizione passata
non lo cancella e non ne prova una risoluzione. Aggiunta al launcher una
diagnostica di dominio da allowlist; rimosso il precedente contesto Auth
fuorviante in quella fase, senza esporre cause/parametri/credenziali SQL.

Evidenze temporanee:
`/private/tmp/amr-staging-context-20261004.json`,
`/private/tmp/amr-staging-build-20261004.log`,
`/private/tmp/amr-staging-gate-regression-before-20261004.log`,
`/private/tmp/amr-staging-gate-regression-after-20261004.log`,
`/private/tmp/amr-staging-final-unit-20261004.log`,
`/private/tmp/amr-staging-image-gate-20261004.log` (giro fallito),
`/private/tmp/amr-staging-image-gate-diagnostica-20261004.log` (giro passato).

Review indipendente in sola lettura prima e dopo i fix; finding ricontrollati
dal main. Nessun ulteriore finding confermato nel diff.

## Prossimo gate

Questo collaudo non prova l'ingress o il costo Nhost, SMTP remoto, backup su
storage esterno, integrazione completa APP o carico clienti. Il helper usa
limiti di fixture 1 CPU/512 MiB, non una misura del candidato Run 0,5 CPU/1 GiB.
La suite completa del turno precedente resta un'evidenza storica distinta;
non è stata dichiarata rieseguita per queste sole modifiche al collaudo.

Dopo il commit e la rigenerazione dell'artefatto: verificare in sola lettura
progetto, PostgreSQL, registry e configurazione effettiva; preparare ruoli,
segreti, volume, proxy e rollback per revisione. L'autorizzazione precedente
copre soltanto il servizio preliminare fermo: upload, configurazione remota e
avvio con costi richiedono una scelta esplicita sul pacchetto concreto.

Fonti ufficiali ricontrollate:
[Docker build best practices](https://docs.docker.com/build/building/best-practices/),
[Nhost registry](https://docs.nhost.io/products/run/registry),
[Nhost CLI deployments](https://docs.nhost.io/products/run/cli-deployments),
[Nhost health checks](https://docs.nhost.io/products/run/health-checks).
Supportano digest, contesto minimo, separazione build/deploy e limiti della
liveness; non attestano il comportamento remoto del nostro pacchetto.

## Candidato aggiornato dopo la review: b1d9d6d

La prova precedente su `9ed5479` rimane storica. Nuovo contesto materializzato
dal commit `b1d9d6dd7717ce0fa7e5fd34b6e73127f7b7cca3`, senza checkout,
credenziali o DB reali. Build locale `amr-centro:b1d9d6d`, linux/amd64,
utente `node`, ID
`sha256:85c0edd1f6177f2ada8b817871110b1679ad7a397362004ae6e117b9f4560ea2`.

Gate integrato passato al primo giro: PostgreSQL 18.6, Auth 0.49.1,
restic 0.19.1, HTTPS, protocollo `/finalizza`, ruoli, quote, revoche,
ricerca sintetica, SIGTERM, riavvio/stesso volume e restore nel secondo
cluster. Manifest dell’immagine confrontato con il candidato. Cleanup
verificato; otto container manuali e due reti preesistenti preservati.

Nessun upload o avvio Nhost, nessun M2/portale. Il commit documentale
successivo non cambia implicitamente la release provata. Evidenze,
controprove e gate remoti aperti nella
[review finale del branch](branch-nodi-2026-10-04-finale.md).
