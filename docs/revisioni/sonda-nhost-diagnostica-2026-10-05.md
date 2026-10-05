# Diagnostica della sonda Nhost — 5 ottobre 2026

## Perimetro e baseline

Branch `feat/nodi-residenziali-prototipo`, HEAD iniziale `de9745e`.
Lavoro limitato al gate ingress della sonda; nessuna modifica al runtime
AMR, ad Auth/DB remoti, al DNS del computer o all'M2. Preservati i file
locali delle altre lavorazioni. L'utente autorizza il commit e ha già
autorizzato la sola sonda temporanea, massimo 20 minuti, poi stop verificato.

Sorgente remoto invariato rispetto a `bc4444e`, SHA-256
`165f49e100cb812c9a67d89198d6b957388bee38ce2c3ab7f79c790950536180`.
Stesso index multiarch già caricato:
`sha256:f00bc535b0b9d581aa85e4736f7cebce426749c71d2ce4badb5dc7d9dc410b24`.
Una replica da 0,5 vCPU/1024 MiB, porta HTTP 3000 con HTTPS Nhost.
Nessuna credenziale, volume, dato applicativo, catalogo o scraper nella sonda.
Il centro AMR non è stato caricato nel registry o avviato in cloud.

## Piano verificato e implementazione

Il precedente client conservava il solo fallimento della disponibilità:
non permetteva di distinguere DNS, connessione, TLS e risposta HTTP.
L'attesa di due minuti non era prova sufficiente di un crash remoto.

`scripts/nhost/attendi-sonda-staging.js` aggiunge una verifica HTTPS di
`/healthz`, sequenziale e limitata: massimo 60 tentativi, cinque minuti
complessivi, cinque secondi per richiesta, 4 KiB per body e 16 KiB per
header. Solo `200`, `no-store`, senza cookie, con body completo `ok`
indica disponibilità. Nessun redirect, login o chiamata ai portali.
Retry soltanto per errori di rete/DNS e HTTP 404/502/503/504;
403, 429, errori TLS e risposte anomale fermano la prova.

Registra solo fase, codice, status, contatore e durata. Non registra
body, header, IP, messaggi d'errore grezzi o credenziali.
Il client delle misure distingue ora DNS, connessione rifiutata e reset
mediante codici ammessi; gli altri errori restano `rete_o_tls`.

Entrambi i client accettano un `lookup` opzionale solo per prove esplicite.
Default invariato: resolver di sistema. Nessun fallback automatico.
Il lookup non cambia URL, Host ordinario, SNI o verifica del certificato.
L'hostname sentinella della prova Host resta una variazione intenzionale.
Il controllo con hostname non presente nel certificato fallisce anche con
il lookup personalizzato e una CA fidata.

## Finding verificati e corretti durante la review

1. **Header terminali decisi dopo il body.** Con 429, redirect o cookie
   e body pendente, il nuovo verificatore arrivava al timeout e riprovava.
   Repro prima della correzione: tre tentativi invece di uno.
   Ora classifica gli header subito, chiude la richiesta e conserva una
   sola decisione anche quando la chiusura genera altri eventi.
2. **Lookup avviato dopo annullamento preventivo.** Node poteva chiamare
   il lookup nonostante il signal fosse già annullato. Riproduzione main
   su Node 24.21: due lookup aggiuntivi, pur senza richiesta HTTP al server.
   Il controllo anticipato elimina quei lookup nei due client; il ciclo
   di attesa aveva già il controllo.
3. **Aspettativa troppo stretta nel test della deadline.** Il timeout
   intero arrotondato poteva lasciare meno di un millisecondo per un
   secondo tentativo, comunque dentro il budget. Corretto il test per
   verificare timeout e durata complessiva, senza imporre una sola chiamata.
   Nessuna modifica al comportamento per adattarlo a quell'aspettativa.

Review indipendente in sola lettura: primo finding riprodotto e chiuso;
secondo riprodotto, poi sette controprove sulla correzione e sui codici
sanitizzati. Nessun nuovo finding confermato nell'ultimo diff.
Le sue controprove usano Node 24.19/26.4; il main usa TLS reale su
Node 24.21. Sono evidenze distinte, non un unico collaudo remoto.

Limite: annullare HTTPS non annulla automaticamente il lavoro di un
resolver personalizzato. Quello temporaneo della prova usa un resolver
indipendente per richiesta, timeout di due secondi e un tentativo.
Il lookup deve restare circoscritto al solo hostname della sonda.

## Prove automatiche

Ambiente isolato con `env -i`, `USER_DATA_PATH` e log temporanei;
preload `test/no-dotenv-preload.cjs`. Nessuna credenziale reale caricata.
Ultimo giro dei file `nodi-sonda-proxy` e `nodi-ingress-staging`:
**21 pass, zero failure/cancelled, uno skip opt-in**, 22 casi, Node 24.21.0.
Lo skip riguarda le attese locali reali di 55/65 secondi.
La suite completa del runtime non è stata rieseguita in questo incremento;
il suo risultato precedente riguarda il candidato `6a9b314`.

Un primo tentativo in sandbox non poteva aprire listener o interrogare
DNS UDP. Non è un difetto AMR: i test TLS e le controprove di rete sono
stati ripetuti con i permessi necessari. Un comando indicava un nome di
test inesistente; il giro valido e completo sopra usa `nodi-ingress-staging`.

## Prove remote, in ordine

Orari qui in UTC; sull'iMac corrispondono a UTC+2.

### Resolver di sistema

Avvio richiesto 4 ottobre **23:36:05.660**, stop richiesto **23:41:02.596**,
configurazione originaria riletta e confermata **23:41:04.183**.
60 controlli in 295.210 ms: tutti `ENOTFOUND`, fase DNS, nessuno status HTTP.
Alla fine, mentre la configurazione era ancora attiva, Google e Cloudflare
via HTTPS davano entrambi `Status=0` con CNAME e record A.
Non sono stati conservati gli indirizzi delle risposte DNS.

**Verificato:** discordanza fra il percorso del resolver di sistema e i
due resolver pubblici in quella finestra. **Non dimostrato:** quale cache,
rete o resolver abbia causato la discordanza. Non chiamarla automaticamente
un errore del provisioning Nhost, del telefono o della cache macOS.

### Resolver dedicato alla singola richiesta

Avvio richiesto **23:53:52.976**. Il resolver Cloudflare UDP ha raggiunto
healthz al tentativo 16, dopo 76.188 ms. Misura iniziata **23:55:10.727**:
healthz 200 in 197 ms, risposta normale 200 in 184 ms;
istanza `c985e05d017daf0b` confermata anche nei log del solo servizio.
Durata server della risposta normale: 2 ms.

La prova degli header sentinella fallisce prima della risposta HTTP,
31 ms, codice precedente `rete_o_tls`. Non è possibile ricostruirne
la causa dal codice generico conservato. Nessuna richiesta header nei
log consultati. Non è una prova che l'ingress respinga quegli header.
Stop richiesto **23:55:11.140**, ripristino della configurazione verificato.
Config zero repliche confermata **23:55:13.222**.

### Misura con risposta DNS mantenuta solo durante l'esperimento

Avvio richiesto 5 ottobre **00:01:41.747**; disponibilità al tentativo 23,
dopo 111.425 ms, misura iniziata **00:03:34.821**. Gli indirizzi ottenuti
dal resolver dedicato sono mantenuti solo in RAM durante l'esperimento:
non è una politica di cache DNS per AMR e non conserva il TTL del portale.
La verifica separata del resolver di sistema, a sonda disponibile, torna
anch'essa 200 in 258 ms: il problema osservato prima non è permanente.

| Prova | Esito client | Durata client |
| --- | --- | --- |
| healthz | 200, body valido | 148 ms |
| risposta normale | 200, istanza valida | 159 ms |
| header sentinella | 200, stessa istanza | 140 ms |
| Origin sentinella | 200, stessa istanza | 152 ms |
| Host sentinella | 404, routing negato dall'ingress | 159 ms |
| attesa 55 s | 200, nessun header anticipato | 55.148 ms |
| attesa 65 s | timeout client, nessuno status ricevuto | 75.001 ms |

Istanza `63215409d64499a0`, correlata ai log del solo servizio Run.
Normale/header/Origin durano 1–2 ms sul server; il resto della durata
client include DNS, connessione, TLS, rete e proxy, non il solo ingress.
Host sentinella non arriva al processo: il 404 è del routing, non un
controllo Host applicativo. La sonda accetta intenzionalmente Origin;
quel 200 non è prova del controllo CSRF del centro.

**Prova lunga fallita, con evidenza ulteriore:** richiesta server n. 4
termina dopo 55.002 ms con `risposta_inviata`. La n. 5 (`attesa_65`)
viene interrotta dopo **60.002 ms**; una n. 6 sullo stesso percorso entra
subito dopo e viene interrotta dopo 14.897 ms. Il client apre una sola
richiesta per quella prova, senza retry, e scade a 75.001 ms.

**Verificato:** due ingressi sul percorso lungo nello stesso processo e
interruzione del primo a circa 60 secondi. **Inferenza sostenuta:** un
retry a monte del processo, compatibile con l'ingress, non con il ciclo
del client o della sonda. Non sono stati letti la configurazione interna
del proxy o un request ID end-to-end; la sonda pubblica non identifica
univocamente il mittente. Non presentare l'attribuzione a Nhost come una
politica documentata né dimostrare da questo solo campione una duplicazione
di ricerche o chiamate ai portali in AMR.

Confronto col runtime: `backend/nodi/centro.js` ammette la ricerca con
`GET /api/search` e il budget di `config-centro-run.js` è 60.000 ms.
**Rischio condizionato concreto:** il margine rispetto all'interruzione
osservata è insufficiente e un retry del GET può sovrapporsi alla scadenza
o alla consegna del risultato. Va riprodotto sul centro con fonti simulate
prima di scegliere un timeout più breve o un protocollo di lavori asincroni.
Non sono stati cambiati il budget concordato o il protocollo dell'app.

### Header: cosa dimostra il classificatore

Nella prova con sentinelle, `x-forwarded-proto` arriva come `https` e
`x-forwarded-host` come host atteso. `Forwarded` conserva invece esattamente
la sentinella. `x-forwarded-for` e `x-real-ip` sono classificati `altro`:
questo **non distingue sovrascrittura da append**, quindi non dimostra
la rimozione di quei valori falsificabili. Nessun IP pubblico letto o
conservato. La precedente formulazione generica «X-Forwarded riscritti»
va limitata ai soli Proto e Host effettivamente provati.

Il peer privato osservato è lo stesso nei due avvii raggiunti, ma non è
una garanzia che resti fisso dopo restart, rollout o cambio di infrastruttura.
`creaTrasporto` richiede IP espliciti, Host esatto e Proto coerente; non
legge `Forwarded` né determina i permessi da IP. Nessuna vulnerabilità
autorizzativa è dimostrata dalla sola sentinella preservata. Resta da
verificare il contratto stabile dell'ingress prima di configurare il centro.

### Stop e limite di tempo

Stop richiesto **00:05:45.989**, configurazione originaria riletta e
confermata **00:05:47.887**. Subito dopo la variazione healthz risponde
ancora: la lettura di zero repliche prova la configurazione desiderata,
non l'immediata cessazione del processo. Controllo successivo alle
**00:07:33.233**: 200 classificato `risposta_inattesa` sugli header,
non più la risposta ammessa della sonda. Non interpretare un 200 generico
come probe ancora attiva. La console conferma zero repliche, zero compute
stimato, nessuna porta/env/volume/health check e immagine non configurata.

Finestre di questo incremento: 298,523 + 80,246 + 246,140 secondi;
inclusi i due tentativi precedenti, circa **810 secondi (13 minuti e 30)**,
sotto i 20 minuti concordati. Tempo fra avvio richiesto e config stop
verificata, non misura della fattura o della terminazione fisica dei pod.

Artefatti temporanei sanitizzati: `amr-sonda-diagnostica-remota-esito-20261005.json`,
`amr-sonda-dns-dedicato-remota-esito-20261005.json`,
`amr-sonda-dns-misura-remota-esito-20261005.json` e
`amr-sonda-ferma-finale-20261005.jpg`, tutti sotto `/private/tmp`.

**Gate proxy non superato.** Raggiungibilità e sei controlli ottenuti;
la prova 65 secondi fallisce. Il prossimo incremento deve riprodurre
timeout/retry del proxy sul centro locale senza portali, poi discutere
il rimedio. Anche stabilità del peer e trattamento completo degli header
restano da verificare. Non avviare il centro completo su queste sole prove.

## Criterio di completamento e limiti

Una risposta healthz dimostra liveness, non la validità della finestra
diagnostica. Il gate del proxy richiede tutte le misure e la correlazione
dei log con la stessa istanza, comprese le attese reali senza header
anticipati. Un successo con lookup dedicato non ripristina né verifica
il normale resolver dell'iMac.

Il ripristino della configurazione deriva dalla lettura dell'originale:
zero repliche e nessuna porta/env/volume/health check, non dalla sola
mancata risposta DNS. Il controllo successivo distingue quella prova
dalla propagazione della cessazione della sonda.

Nessun esito abilita automaticamente trust proxy o dimostra Auth,
PostgreSQL, volume, SMTP, backup esterno, nodi residenziali o readiness
commerciale. Non estendere la fiducia agli header sentinella preservati.

## Fonti autorevoli usate

- [Nhost health checks](https://docs.nhost.io/products/run/health-checks):
  health check e politica di restart sono distinti dal tempo di provisioning.
- [Nhost networking](https://docs.nhost.io/products/run/networking):
  pubblicazione della porta e formato dell'URL del servizio.
- [Nhost risorse](https://docs.nhost.io/products/run/resources): zero
  repliche ferma il compute; registry e volumi hanno vita separata.
- [Node 24 DNS](https://nodejs.org/docs/latest-v24.x/api/dns.html):
  `lookup` usa le facilities del sistema; `resolve4` interroga DNS;
  un `Resolver` separato non cambia le impostazioni globali.
- [Node 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html):
  opzione `lookup`, errori/eventi del trasporto e annullamento effettivo
  mediante AbortSignal; il solo evento timeout non chiude la richiesta.
- [Express dietro proxy](https://expressjs.com/en/guide/behind-proxies/):
  la fiducia deve corrispondere al trasporto reale, senza accettare gli
  header falsificabili sulla base di un campione del peer.

Contesto precedente: [review del branch](branch-nodi-2026-10-04-staging.md)
e [pacchetto della sonda](sonda-nhost-pacchetto-2026-10-04.md).
