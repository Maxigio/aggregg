# Review centro–nodi e prossimo gate — 4 ottobre 2026

## Candidato e confini

Branch `feat/nodi-residenziali-prototipo`, base `81e25ab`, HEAD iniziale
`ed493d7`. Checkout condiviso con APP: nessun cambio branch, nessuna modifica
ai file preesistenti non tracciati, nessun caricamento di `.env` o dati reali.
Staging e M2 restano ambienti distinti. Il presente registro non sostituisce
le evidenze storiche dei precedenti candidati.

Tre review indipendenti in sola lettura coprono: coordinamento/worker,
accessi/aziende/UI, backup/recovery/configurazione e strumenti di release.
Il main verifica sonda, ingresso HTTPS e preparazione del gate remoto.
Le fonti online sono criteri da confrontare con codice e comportamento, non
una prova automatica della sicurezza di AMR.

## Primo incremento concluso

[Pacchetto Nhost](sonda-nhost-pacchetto-2026-10-04.md) preparato e committato
in `763e373`: inventario remoto consultato, costo della bozza verificato,
origine e registry rilevati, configurazione candidata validata dalla CLI
ufficiale 1.51.2. Form scartati senza Update; nessun upload o attivazione.

Verificato nuovamente il contesto locale dell'immagine `bc4444e`:
207 file di codice e 474 cataloghi pubblici, manifest coerente, nessun nome
`.env`, auth JSON o DB nell'inventario di codice. È l'artefatto proposto per
la sola sonda. Non promuove implicitamente il centro applicativo corrente.

Controlli ingress/sonda/HTTPS/configurazione: **25 pass, zero failure,
uno skip opt-in** della prova lenta già eseguita nel precedente incremento.
Il primo giro in sandbox è fallito con `listen EPERM`; lo stesso comando
fuori sandbox è passato. Nessuna correzione al prodotto motivata da EPERM.
Log `/private/tmp/amr-ap-review-proxy-20261004.log`, Node 24.21.0, ambiente
vuoto e preload anti-dotenv, directory temporanee.

## Gate e decisioni ancora aperti

1. Upload e avvio pubblico temporaneo della **sola sonda** su Nhost
   autorizzati ed eseguiti; arresto verificato dopo entrambi i tentativi.
   La misura remota resta non conclusa: dettagli nelle sezioni finali.
2. Il proxy reale: correlare misure e log, senza trasformare un IP osservato
   o un generico PASS del client in una configurazione trust attendibile.
3. Auth/DB/volume/backup/SMTP reali, aggiornamento con stop completo e rollback:
   richiedono gate successivi; le simulazioni e i repository restic locali
   non provano il servizio remoto o lo storage esterno.
4. APP: ricerca e rotte accessorie dell'app commerciale non sono ancora tutte
   equivalenti nel centro. Il collaudo del prototipo non sostituisce CSV/PDF,
   dettagli, dati veicolo, preferenze e assistenza della web app completa.
5. Nodo reale iMac dopo il gate del centro; M2 soltanto dopo il proprio gate
   separato con isolamento e coordinamento delle pause sullo stesso IP.

## Riferimenti autorevoli consultati

- [OWASP autorizzazioni](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  diniego predefinito, privilegi minimi e autorizzazione corrente.
- [Express proxy](https://expressjs.com/en/guide/behind-proxies/): fiducia
  aderente al percorso e riscrittura degli header da parte dell'ultimo proxy.
- [Node 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html): abort,
  timeout, gestione dei body e chiusura esplicita delle connessioni.
- [Restic retention](https://restic.readthedocs.io/en/stable/060_forget.html):
  forget e prune distinti, selezione dei repository e snapshot.
- [Nhost configurazione](https://docs.nhost.io/products/run/configuration),
  [networking](https://docs.nhost.io/products/run/networking),
  [risorse](https://docs.nhost.io/products/run/resources) e
  [listino](https://nhost.io/pricing): confrontati con CLI e console attuali.

## Baseline e review

Suite completa prima dei nuovi fix: **1.347 pass, zero failure, sei skip
opt-in**, 1.353 casi, 114,6 secondi. Log
`/private/tmp/amr-ap-branch-suite-20261004.log`. I test verdi non hanno escluso
i finding successivi, riprodotti con casi non presenti nella baseline.

### F1 — Password nel repository restic attraverso alias — confermato e corretto

`backup-restic.js` confrontava soltanto due percorsi assoluti lessicali.
Repository relativo, prefisso `local:` e symlink potevano lasciare la password
dentro il repository, annullando la separazione voluta per il backup cifrato.
Non è una prova di accesso remoto al file: è una configurazione locale
insicura che il controllo dichiarato non impediva.

Regressione prima del fix: sette varianti insicure accettate. Correzione:
risoluzione fisica dei percorsi locali e dei genitori esistenti per directory
nuove, controllo anche prima di ciascun comando, errori senza percorsi.
Il percorso del repository viene prima normalizzato come nel backend restic;
per il file password si conserva la risoluzione fisica dei symlink.
I repository remoti mantengono la propria configurazione.

Controprove: password esterna ammessa; alias repository/password negati;
directory nuova controllata; symlink cambiato dopo il setup impedisce lo
spawn; S3 non riscritto e nessuna connessione remota nei test. Sono passati
anche init, backup, check e restore con restic reale 0.19.1 e password
sintetiche. Il controllo non sostituisce i permessi sul filesystem e non
garantisce contro un proprietario ostile che modifica i file durante lo spawn.

La review indipendente ha smentito la prima correzione del caso `symlink/..`:
restic pulisce lessicalmente il repository, quindi risolvere prima il symlink
non era equivalente. Allineamento corretto e nuova prova con restic reale:
sia root normale sia prefisso `local:` inizializzano la directory attesa;
password interna rifiutata ed esterna ammessa. **57 test backup pass**, zero
failure e zero skip, compresi i tre test con restic reale e i relativi sotto-casi.
Log `/private/tmp/amr-restic-f1-completo.log`. Ultima controverifica del reviewer
conclusa: finding chiuso, nessun nuovo finding confermato. Commit `8ad685d`.

### F2 — Cleanup del restore fallito non controllato — confermato e corretto

La rimozione della directory temporanea poteva lanciare nel catch del restore,
esponendo un errore del filesystem con percorso e lasciando un dump residuo.
Main probe con root `0500`: prima `erroreSanificato=false`, nessun flag e
`residuo=true`; dopo `erroreSanificato=true` e `residuo=false`.

Correzione: ripristina `0700` soltanto sulla root privata creata dal comando,
poi tenta la rimozione. Se chmod/rm falliscono, conserva il codice
`backup_non_disponibile` con `cleanupIncompleto=true`, senza path/cause.
Non forza ricorsivamente permessi o sovrascrive file vivi.

Regressione: normale, root non scrivibile e rimozione fallita; gli ultimi due
fallivano prima del fix. **56 test pass, tre gate restic opt-in esclusi** nel
giro mirato. Review indipendente: 65 casi mirati passati, prova reale
restore/password errata, mkdtemp fallita senza alterazione del parent,
directory annidata non rimovibile segnalata senza errore grezzo. Non è una
garanzia di eliminazione su un filesystem guasto: il flag richiede una
pulizia esplicita dell'area temporanea. I chiamanti attuali del restore sono
strumenti di collaudo, non una rotta pubblica del centro.

### F3 — Controllo collettivo dei destinatari — confermato e corretto

Main riproduce la prova HTTP indipendente: A e B, aziende diverse, stessa
prima pagina condivisa. Con risultato a 58 secondi e controllo tardivo/revoca
di A, anche B riceve 504. B da solo e revoca immediata di A sono controprove
valide. Il controllo finale per destinatario deve restare obbligatorio;
l'aggiornamento dell'affinità non deve attendere quello degli altri.

La composizione pura termina senza controlli collettivi successivi alle
chiamate ai nodi. La rotta conserva il controllo finale corrente e il budget
di ciascun destinatario, poi registra soltanto la sua affinità. Il callback
interno resta fuori dal body JSON; i chiamanti sintetici senza destinatari
conservano la registrazione diretta. Restano i controlli prima di assegnare
nuove chiamate e prima del failover.

Quattro regressioni: creatore A/B, risposta semplice/composta dopo 429.
Falliscono tutte sul codice precedente; sul fix B riceve 200 mentre A
attende la revoca, A non riceve annunci, e il callback non è serializzato.
Il test della deadline finale ora usa una fase esplicita anziché il numero
dei controlli, cambiato dall'estrazione. Un primo giro interrotto per quel
vecchio test pendente non viene contato come PASS.

Main: **58 test mirati pass**, zero failure/skip, log
`/private/tmp/amr-affinita-green2.log`. Review indipendente: **94 test pass e
cinque prove aggiuntive**, compreso il primo harness; affinità distinta per
azienda, paginazione sul nodo assegnato e nessuna registrazione dopo revoca
o scadenza. Nessun nuovo finding confermato nel diff rispetto a `4fda0de`.
Sono prove simulate locali, non una misura di latenza o carico di Nhost.

## Chiusura locale del 5 ottobre

Commit dei tre fix: `8ad685d`, `4fda0de`, `6a9b314`. Candidato runtime
`6a9b314d85ca0ee4b857bbb4105b3517c395b02e`, senza modifiche tracciate residue.
Suite completa aggiornata: **1.366 pass, zero failure/cancelled, sette skip
opt-in**, 1.373 casi, 105,8 secondi. Node 24.21.0, ambiente isolato e preload
anti-dotenv. Log `/private/tmp/amr-finale-review-suite-20261005.log`.

La review indipendente accessi/aziende/UI termina senza nuovi finding
confermati. Letture di login, MFA, finalizzazione, logout, aziende/colleghi,
permessi SQL e frontend. **18 test indipendenti pass**; il suo giro HTTP è
stato fermato da `listen EPERM`, e il rilancio non è stato completato.
Non attribuire a questa review una verifica dinamica integrale o browser
reale. Le ipotesi sulle risposte obsolete non hanno una nuova riproduzione.
I controlli HTTP della suite main e il gate seguente sono evidenze distinte.

Build locale dal solo Git del candidato:
`amr-centro:6a9b314`, Linux/amd64, utente `node`, ID
`sha256:468eb131f80e19b3ef85b1069228e49c49a1ecec3cbf16bf5f1f038b007f49ef`.
Contesto `/private/tmp/amr-centro-context-dTR8xm`, codice
`f4b7d51d8267abeb9ff80491dc574f7aa089c97caa2633792b57f28f283aa160`,
cataloghi `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.
La build non è stata caricata nel registry: l'autorizzazione remota riguarda
soltanto la sonda `bc4444e`.

Gate locale sull'immagine: **PASS**, PostgreSQL 18.6, Auth 0.49.1, email
locale/verifica/MFA, ruoli minimi e quote concorrenti, rinnovi/revoche,
HTTPS e artefatto, ricerca sintetica, SIGTERM, riavvio/volume/sessioni,
restic reale e restore in secondo cluster con replay ordinato e ACL.
Cleanup verificato. Gli otto container manuali preesistenti rimangono
in esecuzione e non sono stati modificati. Log
`/private/tmp/amr-candidato-6a9b314-gate.log`.

## Gate remoto: limite confermato

Il proprietario ha autorizzato upload e avvio della sola sonda `bc4444e`,
massimo 20 minuti, poi arresto. Login CLI e configurazione del credential
helper eseguiti dall'utente nel terminale; nessuna credenziale in log o Git.

Upload verificato al digest
`sha256:add38acd65c934c86a0ac5449ecd28d04cd7146555a4fb2b19580c6d403201ff`.
Il primo verificatore confrontava erroneamente il digest della config OCI
con l'ID dell'immagine: in questo daemon l'ID è il digest del manifest.
Controverifica con Descriptor remoto, RepoDigests e piattaforma: corrisponde
all'artefatto approvato. Non è un problema applicativo AMR.

Avvio richiesto alle **22:38:14 UTC del 4 ottobre**; dopo la mancata
disponibilità, arresto richiesto alle **22:39:15**, configurazione originaria
riletta e confermata alle **22:39:17**: zero repliche, CPU 62, memoria 128,
nessuna porta/env/volume/health check. Durata della finestra circa 63 secondi,
non 20 minuti. Il DNS dell'endpoint non risolve (`ENOTFOUND`): questa prova
di rete, da sola, non certifica lo stato dei container; la conferma dello
stop deriva dal ripristino e dalla lettura della configurazione Run.

Log del solo `run-amr-centro-staging`, orari locali 00:38:35, 00:38:47 e
00:39:08: **`exec /usr/local/bin/docker-entrypoint.sh: exec format error`**.
Stessa immagine in locale: Node `x64`, `/bin/dash` ELF machine 62,
shebang `#!/bin/sh` con LF e nessun CRLF. Verificato il fallimento dell'avvio
remoto; incompatibilità di architettura è un'ipotesi sostenuta, non una misura
diretta dell'host Nhost. La guida ufficiale delle
[build CLI](https://docs.nhost.io/products/run/cli-deployments) prepara sia
`linux/amd64` sia `linux/arm64`. L'index Node fissato contiene entrambe.

### Secondo tentativo: stessa sonda, immagine multiarch

La variante mantiene il sorgente della sonda di `bc4444e` byte per byte,
SHA-256 `165f49e100cb812c9a67d89198d6b957388bee38ce2c3ab7f79c790950536180`.
Contiene soltanto quel file e la base ufficiale Node 24.21.0 fissata al
digest dell'index: nessun backend AMR, dipendenza npm, catalogo o dato.
Buildx ufficiale 0.37.2 installato soltanto in una configurazione Docker
temporanea, binario verificato contro il checksum della release ufficiale.
Nessuna modifica alla configurazione Docker ordinaria.

Build e smoke test locali su **linux/amd64 e linux/arm64: PASS**: processo
Node dell'architettura attesa, sorgente identico, healthz, risposta JSON e
classificazione degli header. Container senza rete, read-only e senza
directory applicative. Review indipendente della ricetta/contenuto e nove
test della sonda passati; prova lunga esclusa in quel giro. Le prove locali
non dimostrano quale architettura usa l'host remoto.

Upload della variante nel perimetro già autorizzato per la sola sonda,
senza aggiungere servizi o connessioni. Index remoto verificato, entrambe
le piattaforme presenti; configurazione vincolata al digest
`sha256:f00bc535b0b9d581aa85e4736f7cebce426749c71d2ce4badb5dc7d9dc410b24`.
L'immagine del centro `6a9b314` non è stata caricata né eseguita su Nhost.

Avvio richiesto alle **23:02:20 UTC del 4 ottobre**, arresto richiesto alle
**23:04:21**, configurazione originaria riletta e confermata alle
**23:04:22**. Anche questo tentativo non ha raggiunto healthz nella finestra
di attesa; il client con le sette misure non è quindi partito. Finestra
complessiva dei due tentativi circa **185 secondi**, sotto i 20 minuti
autorizzati. È il tempo fra richiesta di avvio e verifica dello stop,
non una misura della fatturazione o del tempo effettivo dei container.

La console conferma zero repliche, nessuna porta pubblicata e costo compute
stimato zero. URL riletto in una bozza poi scartata, senza Update: coincide
con quello usato dal client e con il formato della documentazione ufficiale.
Log del solo servizio, intervallo 15 minuti comprendente il secondo
tentativo: nessuna riga disponibile. La sonda non registra startup/healthz:
l'assenza di log non dimostra né un avvio riuscito né un crash risolto.

Verifica DNS successiva allo stop: resolver del sistema `ENOTFOUND`, Google
e Cloudflare via HTTPS `Status=3` (NXDOMAIN), senza conservare indirizzi IP.
Il primo tentativo di questa verifica in sandbox non poteva risolvere
nemmeno i resolver pubblici: escluso dalle evidenze di rete; controprova
fuori sandbox riuscita. La verifica DNS **a servizio fermo non dimostra**
che il DNS fosse la causa dell'indisponibilità durante l'avvio. Il controllo
di disponibilità salva soltanto l'esito, non l'errore di ciascun tentativo:
la causa remota resta non determinata. L'attesa di circa due minuti non
dimostra che un'istanza con tempi di provisioning maggiori non possa partire.

Artefatti diagnostici temporanei, senza credenziali:

- `/private/tmp/amr-sonda-multiarch-smoke-20261005.json`;
- `/private/tmp/amr-upload-sonda-multiarch-esito-20261005.json`;
- `/private/tmp/amr-sonda-multiarch-remota-esito-20261005.json`;
- `/private/tmp/amr-sonda-run-fermo-20261005.jpg`.

**Gate remoto non concluso; nessuna misura del proxy disponibile.** Il
prossimo esperimento deve distinguere provisioning, DNS e risposta HTTP
mentre la sola sonda è attiva, con tempi limitati e stop controllato. Non
cambiare trust proxy né aggirare TLS per ottenere un PASS. Auth, PostgreSQL,
volume, SMTP, storage esterno, worker iMac e M2 richiedono gate separati.

## Diagnostica successiva del 5 ottobre

Raggiunta la sonda multiarch; fonte remota `bc4444e` invariata. Correzioni
ai client diagnostici (header terminali, annullamento prima del lookup),
review indipendente, **21 test pass e uno skip**, zero failure.
La prova remota con lookup dedicato ottiene sei controlli, ma l'attesa di
65 secondi fallisce: log server con interruzione dopo 60.002 ms e secondo
ingresso sul percorso, mentre il client invia una sola richiesta.
Attribuzione al retry dell'ingress sostenuta ma non ancora documentata;
duplicazione di chiamate scraper nell'app non dimostrata.

Run torna a zero repliche e senza porte pubbliche, confermato dalla
config e dalla console; controllo successivo non riconosce più la sonda.
Circa 13 minuti e 30 di finestre complessive, inclusi i tentativi precedenti.
DNS di sistema nuovamente funzionante durante l'ultimo avvio; causa della
discordanza precedente non determinata. Nessun trust proxy o timeout AMR
modificato, nessun centro completo in cloud e nessun portale interrogato.

**Gate remoto non superato; prossimo passo:** riprodurre in locale sul
centro il timeout/retry osservato, poi scegliere la correzione. Evidenze,
controprove e limiti nel
[registro diagnostico](sonda-nhost-diagnostica-2026-10-05.md).
