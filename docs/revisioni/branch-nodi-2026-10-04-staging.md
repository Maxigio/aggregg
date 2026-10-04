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

1. Autorizzazione dell'upload e dell'avvio pubblico temporaneo della **sola
   sonda** su Nhost, poi arresto verificato. Domanda pendente al proprietario;
   la creazione preliminare del servizio fermo non autorizza questo passo.
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

### F1 — Password nel repository restic attraverso alias — confermato

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

### F3 — Controllo collettivo dei destinatari — confermato, fix successivo

Main riproduce la prova HTTP indipendente: A e B, aziende diverse, stessa
prima pagina condivisa. Con risultato a 58 secondi e controllo tardivo/revoca
di A, anche B riceve 504. B da solo e revoca immediata di A sono controprove
valide. Il controllo finale per destinatario deve restare obbligatorio;
l'aggiornamento dell'affinità non deve attendere quello degli altri.

La review di accessi/UI non è ancora conclusa. Il proprietario ha autorizzato
la sola sonda remota temporanea: upload e avvio non sono ancora eseguiti.
