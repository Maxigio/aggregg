# Pacchetto della misura ingress Nhost — 4 ottobre 2026

## Stato e perimetro

Preparazione locale, non autorizzazione al deploy. Branch
`feat/nodi-residenziali-prototipo`, HEAD iniziale `ed493d7`.
Console consultata in sola lettura: progetto AMR, servizio
`amr-centro-staging`, zero repliche, immagine vuota, nessuna porta,
variabile, volume o health check configurato. Le bozze del form usate per
leggere preventivo e URL sono state scartate, senza premere Update.

La sola sonda esegue Node standard library; non importa AMR, non autentica,
non chiama PostgreSQL o portali, non assegna lavori, non legge credenziali.
Le prove locali precedenti e i loro limiti sono nel
[registro della sonda](sonda-proxy-staging-2026-10-04.md).

## Artefatto e configurazione preparati

- Immagine locale già costruita da `bc4444e39c0bbdbf9ea06856cfa685d904986bb1`:
  `amr-centro:bc4444e`, linux/amd64, UID 1000, Node 24.21.0.
- ID locale `sha256:add38acd65c934c86a0ac5449ecd28d04cd7146555a4fb2b19580c6d403201ff`.
  Non è il digest del manifest nel registry; quest'ultimo si verifica dopo
  l'upload e prima dell'attivazione. Non sostituire implicitamente l'immagine
  con una build del checkout o con un tag aggiornato.
- Registry mostrato dalla console:
  `registry.eu-central-1.nhost.run/40f9c208-5e1b-49ac-afcd-54e56d70de8b`.
- URL previsto dal form non salvato:
  `https://fashsekadydbcdkedqqx-3000.svc.eu-central-1.nhost.run`.
- Comando alternativo: `node scripts/nhost/sonda-proxy-staging.js --origine`
  seguito dall'URL sopra e `--ascolto 0.0.0.0`.
- Una replica, 500 millicpu, 1024 MiB, porta 3000 HTTP pubblicata tramite
  HTTPS Nhost; health check sulla stessa porta. Nessun segreto o volume.
- Bozza solo locale `/private/tmp/amr-sonda-config-20261004.toml`, riferimento
  all'immagine tramite tag specifico del commit, da vincolare al digest
  verificato prima dell'uso. Il template tracciato resta fermo e non pubblico.

CLI ufficiale 1.51.2: `config-validate` sulla bozza accettata con exit 0,
root e HOME temporanei e `.secrets` vuoto. Nessun `service-id`: nessuna
risoluzione di segreti remoti. Un primo comando usava l'opzione inesistente
`--root`; corretto in `--root-folder`, senza effetti esterni.

## Preventivo verificato, non promessa di fattura

Il form della console, con una replica da 0,5 vCPU / 1024 MiB, mostra
**25 USD/mese** di compute. Con zero repliche mostra zero. Il
[listino ufficiale](https://nhost.io/pricing) distingue Dedicated
50 USD/vCPU/mese e 0,0012 USD/vCPU/minuto da Shared
15 USD/vCPU/mese e 0,00034 USD/vCPU/minuto. Il preventivo del progetto
corrisponde al primo: non applicare il prezzo Shared senza conferma.

Per 20 minuti a 0,5 vCPU il costo teorico è circa **0,012 USD** di compute,
prima di eventuali imposte, arrotondamenti e altre voci. I 25 USD del piano
Pro e i 15 USD di compute credits sono separati: i crediti possono essere
già consumati dagli altri servizi. Questa misura non verifica il costo
complessivo del futuro AMR. La scadenza di 15 minuti della sonda chiude
l'ammissione diagnostica, **non** arresta Run o la fatturazione.

## Esecuzione proposta, ancora da autorizzare

1. Ricontrollare che il servizio sia ancora vuoto e fermo. Se è cambiato,
   fermarsi prima di sovrascrivere configurazioni altrui.
2. Caricare la sola immagine sopra nel registry Nhost, verificare il digest
   remoto e usarlo nella configurazione locale. Nessuna credenziale in log,
   argomenti, documenti o repository; autenticazione del registry a cura
   dell'utente se manca una sessione utilizzabile.
3. Attivare soltanto la sonda, non il centro AMR. Eseguire il client HTTPS
   con sette richieste prefissate, senza login, cookie, redirect o retry:
   liveness, risposta, header sentinella, Origin, Host, attese 55 e 65 secondi.
4. Confrontare gli esiti con i log filtrati lato server: istanza, peer
   privato, classificazione degli header e durata. Non registrare IP pubblici
   o contenuti arbitrari. Un campione non definisce una lista stabile di
   proxy attendibili: nessun trust allargato automaticamente.
5. Portare repliche a zero, verificare arresto e assenza di servizio attivo.
   Se utile ripetere su una nuova istanza nella finestra concordata; arrestare
   comunque al primo impedimento e riportare il gate come non concluso.

Successo: misure complete e correlabili, attese reali senza header anticipati,
nessuna deriva di istanza, stop confermato. Host rifiutato dall'ingress è
distinto da Host rifiutato dall'app. Anche un successo non verifica Auth,
DB, volume, SMTP, backup esterno, worker reali o frontend commerciale.

## Riferimenti e debunking

- [Nhost registry](https://docs.nhost.io/products/run/registry): servizio vuoto
  fermo prima dell'upload; il nostro inventario rispetta questa fase.
- [Configurazione](https://docs.nhost.io/products/run/configuration) e
  [deploy CLI](https://docs.nhost.io/products/run/cli-deployments): validare
  una bozza non crea repliche né dimostra il contenuto del registry.
- [Networking](https://docs.nhost.io/products/run/networking): URL pubblico
  per porta e rete privata condivisa; non garantisce gli header osservati.
- [Risorse](https://docs.nhost.io/products/run/resources): zero repliche
  ferma compute, conserva registry e volumi; qui nessun volume è previsto.
- [Express proxy](https://expressjs.com/en/guide/behind-proxies/): la fiducia
  deve corrispondere al trasporto reale. Un IP visto una volta non dimostra
  stabilità futura né la rimozione di ogni header falsificabile.

La preparazione non richiede né comporta modifiche all'M2 o richieste ai portali.
