# Review del branch centro–nodi — 4 ottobre 2026

## Perimetro e verdetto

Branch `feat/nodi-residenziali-prototipo`, base ricostruita `81e25ab`.
La cronologia distingue estrazione/coordinatore, prototipo, identità locali,
Auth/PostgreSQL, aziende/colleghi, backup/recovery, HTTPS e candidato Run.
Non sono incrementi già distribuiti a clienti: il servizio preliminare Nhost
resta distinto dall’immagine locale e dall’AMR M2.

La review segue i percorsi del codice e le dipendenze, con reviewer indipendenti
in sola lettura. È una revisione mirata dei confini di accesso, assegnazione,
composizione, UI, persistenza, recovery e release; non una prova esaustiva di
ogni combinazione né una certificazione dei portali o della produzione.

Il candidato applicativo corrente è `b1d9d6d`; il commit di questo documento
sarà distinto e non sostituirà implicitamente l’artefatto collaudato.

## Decisioni confrontate con il comportamento reale

- **Centro e nodi separati.** Il centro assegna lavori e usa `componiRicerca`
  senza chiamare scraper per completare la porzione di un’altra fonte.
  `backend/nodi/operazioni.js` esegue coordinatore, menu e dettagli sul worker.
  Le sole prove del presente turno sono simulate o verso servizi locali.
- **Una fonte per failover.** `centro.js` considera disponibilità, pausa,
  affinità e release; un 429 può far provare un solo alternativo per fonte.
  I cursori Subito non vengono inviati alla porzione AutoScout/Moto.it.
  Una disconnessione dopo consegna produce esito incerto, non replay presunto.
- **Condivisione limitata.** Solo prima pagina ordinaria identica e in volo;
  query ammesse ordinate nella chiave. Pagine/retry restano separati.
  Destinatari e firme dei dettagli sono per sessione; revoca/scadenza
  vengono ricontrollate prima della consegna.
- **Commerciale.** Identità proviene da Nhost e permessi dal DB, non da ruolo,
  azienda o moduli del browser. Admin con MFA, referente e colleghi distinti;
  10 aziende, 30 posti, tre per azienda inclusi gli inviti pending.
  Scadenza blocca accesso e consegna. I comandi già ammessi possono terminare
  dopo logout, secondo la decisione esplicita; non concedono nuove richieste.
- **Riavvio.** Sessioni, affinità e coda sono RAM; niente ripresa automatica.
  Metadati SQLite marcano attesa interrotta/in corso incerto. Una replica
  e manutenzione con arresto verificato: il solo numero repliche non prova
  assenza di sovrapposizione nel lifecycle remoto.
- **Privacy e backup.** Gli annunci attraversano memoria temporanea, non il
  journal commerciale. Journal e dump sono copie separate; restore ordinato,
  fingerprint, sequenze e riconciliazione delle accettazioni. Repository restic
  cifrati reali del gate sono locali: non dimostrano storage remoto operativo.

## Finding verificati durante il lavoro richiesto

Il registro [correzioni](correzioni-centro-2026-10-04.md) documenta L01,
R03, B05, B06 e U05 già corretti con controprove prima del presente incremento.
La ricerca autorevole C03 non era di per sé un fix: conclusa ora con codice.

1. **Login/cookie concorrenti:** `3cc4d78` separa verifica Nhost e finalizzazione
   monouso. Web Lock su bootstrap/finalizzazione/logout, mai sull’attesa Auth.
   Validazione server di origine, contesto, scadenza, epoca e revoca conservata.
2. **Cleanup Nhost ritardava il logout:** riprodotto dal reviewer nel nuovo diff;
   il diniego ora risponde prima del cleanup remoto, ancora bounded e tracciato.
3. **Recupero cookie perso a quota 100:** riprodotto nel nuovo diff; quota applicata
   dopo aver contato le sessioni del browser da sostituire. Nuovo browser resta
   negato. Ripristino dei due bug in memoria li fa ricomparire.
4. **Menu/dettagli abbandonati avviabili:** il job accodato conservava il
   destinatario dopo socket chiuso. `b1d9d6d` lo ritira, cancella solo il queued
   e verifica connessione prima/dopo permessi. Già iniziati terminano.
5. **Sospensione manuale Moto.it ignorata dal menu:** il catalogo locale era
   correttamente disponibile, ma il cache-miss poteva chiamare l’API.
   `b1d9d6d` trasmette lo snapshot manuale al poll e impedisce solo nuova rete;
   cache/catalogo/inflight avviati restano disponibili. Non genera un falso 429.

Review finale Auth: 57 test mirati e controprove dei due nuovi finding;
nessun finding residuo confermato in quel diff. Review nodi: 96 test pertinenti
e nove controprove indipendenti; nessun finding residuo nei due fix.
Un errore della fixture detail usava un oggetto sessione nuovo a ogni richiesta:
corretta l’identità sintetica, non indebolita la firma. Due errori del reviewer
erano causati da temporanei riutilizzati: prova pulita 7/7, codice invariato.

## Prove del candidato

- Node 24.21.0, ambiente vuoto, dotenv disabilitato, dati/log temporanei.
- Suite completa: **1.335 casi, 1.330 pass, zero failure, cinque skip opt-in**.
  Nessun test escluso per mascherare un finding.
- Gruppo mirato Auth/nodi/HTTP: 101/101; include Chromium headless sintetico
  con due schede, risposta cookie ritardata e timeout fetch effettivo.
- Manuale dell’utente: non eseguito per il protocollo nuovo. Nessuna preview
  aperta, nessun riavvio del collaudo con le credenziali dell’utente.
- Immagine locale `amr-centro:b1d9d6d`, linux/amd64, utente `node`:
  `sha256:85c0edd1f6177f2ada8b817871110b1679ad7a397362004ae6e117b9f4560ea2`.
- Contesto solo blob pubblici del commit, manifest verificato durante build.
  Codice `443ef98fc5c840a347ce9eeed37816eee3a55f95a7b16056f58d94aa3ee53272`;
  cataloghi `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.
- SQL prima installazione da `b1d9d6d`, 78.320 byte, SHA-256
  `2912ab465aa4d58eaf18a83aba1948ea4ddfd2c37917f394e584cd50ffaa8079`.
  Preparato, non applicato al cloud.

Gate integrato dell’immagine **passato, exit 0**: PostgreSQL 18.6,
Auth 0.49.1, HTTPS reale, installazione SQL atomica/ruoli minimi,
login e MFA con il protocollo nuovo, quota commerciale concorrente,
revoca/scadenza in coda e in volo, worker simulato, risultato Moto/Subito.
SIGTERM exit 0 senza OOM, stesso volume dopo restart, sospensioni/revoche
conservate e vecchie sessioni negate. Restic 0.19.1: journal e dump in
repository locali separati, restore in un secondo cluster e replay/ACL.
Il gate non ha richiesto un rilancio o modifiche alle quote per passare.
Cleanup del launcher verificato; dopo il giro restano gli otto container
manuali preesistenti e le loro due reti. Nessuna loro configurazione letta.

Review indipendente commerciale/recovery/Run: 93 test passati, nessun nuovo
finding confermato. Il reviewer usa SQL statico/mock; il gate reale del main
verifica separatamente PG18/Auth/restic/immagine, senza equiparare le due prove.

Evidenze temporanee:
`/private/tmp/amr-final-suite-20261004.log`,
`/private/tmp/amr-c03-nodi-completo.log`,
`/private/tmp/amr-centro-context-final-20261004.json`,
`/private/tmp/amr-schema-final-20261004.sql`,
`/private/tmp/amr-centro-build-final-20261004.log`,
`/private/tmp/amr-centro-gate-final-20261004.log`.

## Limiti confermati e gate successivi

Questi sono requisiti/prove mancanti, non nuovi bug dimostrati dalle fixture:

1. Ingress Nhost: peer/header reali, Host/Origin, timeout, long polling,
   arresto completo, una replica, volume UID 1000 e rollback compatibile.
   `/healthz` prova solo liveness; non Auth, DB o capacità di ricerca.
2. Auth remoto: SMTP e URL di ritorno, verifica/reset email, recovery MFA,
   limiti effettivi del provider e login aggregati dal centro. I limiti locali
   20 tentativi/minuto e quattro pendenti non sono un benchmark di 30 persone.
3. Backup esterno operativo: repository indipendenti, login minimo capace di
   fare dump, copie dello stato SQLite, restore separato e prova di revoche.
   L’entry Run senza repository configurati espone avviso; non ha backup remoto.
4. Integrazione APP: flusso reale Auto/Moto, export/dettagli e errori nel
   frontend destinato ai clienti. Il prototipo non sostituisce questo gate.
5. Nodi reali: prima iMac con release identica, poi gate M2 separato,
   isolamento dal servizio di tuo padre e pause condivise sullo stesso IP.
   Latenza/capacità 60 s / due ricerche per persona / 60 totali da misurare.

Nessun nuovo deploy, upload, modifica Nhost, M2 o richiesta ai portali.
Il pacchetto remoto va presentato con risorse/costi e rollback concreti;
l’autorizzazione del servizio preliminare fermo non autorizza l’avvio.

## Fonti e controprove

- [W3C Web Locks](https://www.w3.org/TR/web-locks/): lock cooperativo tra
  contesti dello stesso storage bucket; non autentica il client. Il callback
  mantiene il lock fino al settlement: per questo il cleanup lento è separato.
- [RFC 6265](https://www.rfc-editor.org/rfc/rfc6265.html#section-4.1): risposte
  concorrenti possono creare race sui cookie. Il controllo server da solo
  non ordina la consegna al browser, verificata anche con Chromium.
- [OWASP sessioni](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html):
  identificatori opachi, rotazione, TTL e invalidazione server-side.
- [OWASP autorizzazioni](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html):
  deny by default e controllo corrente, compresa la consegna asincrona.
- [Nhost health checks](https://docs.nhost.io/products/run/health-checks):
  sonda del container distinta dalle prove delle dipendenze.

Le fonti motivano i criteri; né una best practice né la suite verde prova
da sola l’affidabilità dell’ambiente cloud o del contenuto di un nodo.

## Collaudo manuale ancora da eseguire

Prerequisito: riavvio concordato del collaudo locale con questo candidato;
non usare il server precedente con il nuovo JavaScript e il vecchio protocollo.
Il presente turno non riavvia processi che leggono le credenziali dell’utente.

1. Login password/MFA → ingresso e permessi attesi; nessun ticket/token esposto.
2. Due schede: logout in una durante il login nell’altra → tentativo vecchio
   rifiutato; nuovo login dopo il logout utilizzabile.
3. Admin → sospensione Moto.it: cataloghi locali disponibili, eventuale
   fallback remoto sospeso dichiarato. Nessuna ricerca live necessaria.
4. Referente Moto → Auto non disponibile; stato diagnostico e account
   coerenti con il ruolo. Le ricerche live richiedono il perimetro concordato.
