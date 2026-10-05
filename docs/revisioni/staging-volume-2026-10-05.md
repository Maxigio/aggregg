# Preparazione del volume staging — 5 ottobre 2026

## Problema verificato

Il centro candidato `66e2b24` non può creare file in `/var/lib/amr` sul mount
Nhost: EACCES come UID/GID 1000. Configurazione, release e tre pool PostgreSQL
superano la sonda privata. La manutenzione separata ha poi confermato e
impostato ownership 1000:1000 e permessi 0700 sul mount. Il centro è stato
ripristinato come UID 1000: l'avvio supera ora `/healthz`; il gate dell'app
rimane da superare per un distinto diniego 403 del controllo di trasporto.

L'accordo in `staging-nhost.md` impone di fermarsi se il mount non è scrivibile
e di non eseguire AMR come root. Non si sposta il database in storage effimero.

## Procedura autorizzata ed eseguita

Usare lo stesso servizio e **lo stesso volume**, temporaneamente, con un
container amministrativo separato dall'applicazione:

- immagine ufficiale
  `node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6`;
- nessun codice AMR, variabile applicativa, riferimento a segreti, porta,
  worker o connessione a database/portali;
- sola esecuzione di `scripts/nhost/prepara-volume-staging.js` come UID 0;
- modifica non ricorsiva di owner/group della directory montata a 1000:1000
  e permessi 0700; nessuna modifica dei figli;
- rifiuto se non è un mount reale o contiene file applicativi. La sola voce
  `lost+found`, quando presente, resta invariata;
- arresto dopo l'esito, ripristino della configurazione e dell'immagine
  candidata del centro, che resta **USER node/UID 1000**.

Per la precedente sonda terminante, verificare `replicas=0`, comando atteso,
conclusione dei controlli nei log e assenza di nuove esecuzioni osservate.
Il provider non espone il numero effettivo dei pod: queste evidenze attestano
la conclusione delle operazioni della sonda, non la terminazione fisica dei pod.
Il criterio non si estende a un centro attivo con SQLite/scheduler/worker.
La lettura della configurazione Nhost
deve confermare nome/percorso/capacità invariati. Se queste condizioni non
sono confermabili, fermarsi. Non rinominare o rimuovere il disco.

Il processo può terminare senza successo se Run non consente `chown`; in quel
caso resta necessario l'intervento Nhost. Non elevare i privilegi dell'app.
Se una modifica dei permessi riesce solo in parte, non dichiarare il gate
passato: il servizio resta fermo e si verifica lo stato della directory.

Alternativa: chiedere a Nhost una preparazione del mount o un security context
`fsGroup` compatibile. Disponibilità sul prodotto non dimostrata. Lo schema
pubblico interrogato per Run espone command, environment, image, ports,
healthCheck e resources; storage espone soltanto capacity/name/path.

## Prove e review

Sei test unitari: mount assente, contenuti esistenti, symlink, UID/percorso
errati, permessi non applicati, descriptor e chiusura. Il test del pathname
verifica l'uso del descriptor: non simula un attacco reale al mount.

Docker, volume nuovo dedicato e cancellato al termine:

1. UID 1000 rifiutato prima della preparazione;
2. helper sul mount reale conferma 1000:1000 e 0700;
3. UID 1000 scrive e rilegge in un secondo container;
4. ownership, permessi e contenuto dei figli di `lost+found` invariati;
5. nuova preparazione con file applicativo presente rifiutata;
6. esecuzione senza mount rifiutata.

La review indipendente ha identificato due controlli inizialmente mancanti:
mountpoint reale e race sul pathname. Chiusi con `/proc/self/mountinfo`,
`O_DIRECTORY | O_NOFOLLOW` e operazioni sullo stesso descriptor. Nessun nuovo
difetto confermato nella seconda review. La prova Docker conferma i permessi
locali; **non dimostra che Run consenta la manutenzione**.

## Riferimenti

- [Nhost Run: storage](https://docs.nhost.io/products/run/resources): il disco
  appartiene al servizio; rinominarlo lo sostituisce, fermare le repliche lo
  conserva. La pausa compute non azzera il costo dello storage.
- [Nhost Run: configurazione](https://docs.nhost.io/products/run/configuration):
  opzioni pubbliche del servizio; non documenta un'opzione fsGroup.
- [Kubernetes: security context](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/#configure-volume-permission-and-ownership-change-policy-for-pods):
  fsGroup può gestire l'accesso al volume, secondo il driver. Non prova che
  Nhost esponga quella configurazione.

Stato: helper, prove locali e manutenzione remota completati. L'Admin cloud
e la MFA restano invariati. La riuscita della manutenzione non dimostra il
funzionamento del login o della ricerca nel centro.

## Primo tentativo remoto

Il 5 ottobre il proprietario ha autorizzato la manutenzione separata. La
configurazione effettiva è stata riletta: immagine Node ufficiale fissata,
zero environment, zero porte, stesso volume e nessuna healthcheck residua.
L'avvio è stato richiesto; entro la deadline non è comparso un esito né un
errore nei log del container. Il cleanup ha riportato e verificato repliche 0
e identità del volume invariata. **Ownership remota non confermata**.

Non si attribuisce il mancato esito a root, pull dell'immagine o porte mancanti
senza prova. La CLI ufficiale usa `ReplaceRunServiceConfig`: la proposta di
un ulteriore comando di deploy è stata falsificata leggendo il suo sorgente.
Proposta di confronto separata: dichiarare una porta TCP interna non pubblica,
senza listener, lasciando identici immagine, comando, environment e volume.
Il proprietario ha successivamente autorizzato questa variazione.

## Confronto remoto e ripristino del centro

Stessa immagine, comando, environment vuoto e volume; unica variazione una
porta TCP 3000 interna con `publish=false`, senza listener. Entro la deadline
il container ha restituito `volumePreparato` con UID/GID 1000 e mode 0700.
Arresto a repliche 0 e identità del volume verificati. Questo prova l'esecuzione
della manutenzione; **non dimostra che Run richieda sempre una porta** per
avviare un container: i tempi di provisioning possono influire sul confronto.

Ripristinati immagine candidata, 22 variabili/configurazioni di riferimento,
comando predefinito non-root, healthcheck e stesso disco. Il centro è partito
con una replica e porta HTTP pubblica. `/healthz` restituisce 200; l'accesso
all'app e alle API restituisce 403, compresa la richiesta con Origin corretto.
Il problema del volume è chiuso; il gate HTTPS/proxy è ancora aperto.
