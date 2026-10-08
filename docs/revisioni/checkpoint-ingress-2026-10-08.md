# Checkpoint dello staging con ingress Nhost — 8 ottobre 2026

## Perimetro e preparazione

Prosegue il gate ordinato della [policy ingress](ingress-policy-2026-10-08.md).
Sono autorizzati checkpoint cifrato PostgreSQL + volume Run, restore isolato,
aggiornamento del solo staging e successivo M2 solo stato. Produzione M2 esclusa.

La configurazione Run originale è confrontata integralmente con la ricevuta
validata. Il preflight osserva una replica pronta e `/healthz` 200; accetta
solo la risposta applicativa originale nota, 200 oppure il 403 del vecchio
guard con body e header esatti. Questo non costituisce un gate Auth superato.

Immagine di manutenzione dai tre blob del commit `4d329e8`, caricata nel
registry di staging e verificata amd64/arm64:

`sha256:80a30f3ff4bada3cdba67841c6d27a3835f7827001b21d56da55afdf0cbf1b51`.

Fixture amd64 legacy e arm64 `AMR_BACKUP_INGRESS=nhost`: dump PostgreSQL
18.6, cifratura, due repository e restore senza rete PASS. Dimensioni
sintetiche: archivio PostgreSQL 10.240 byte, SQLite 20.480 byte.
Nessun dato cloud in queste fixture; nessun prune o modifica dei container
di collaudo preesistenti.

## Finding verificati prima del checkpoint remoto

La review indipendente ha segnalato tre guard del recovery/restore:

- Il controller temporaneo poteva essere interrotto mentre disabilitava
  i segnali nel `finally`. Ora registra SIGINT/SIGTERM e li osserva ai
  confini di fase; il recovery non solleva eccezioni per questi segnali.
- Un errore successivo all'assegnazione di `ok=true` poteva lasciare un
  falso PASS. L'`except` azzera l'esito e il controllo finale esclude errori,
  interruzioni e recovery/cleanup non confermati.
- Nel conservatore, un container con nome atteso ma label/ID discordanti
  non veniva rimosso, correttamente, ma lasciava `cleanup=true`. Ora il
  controllo `pulisciRestore` fallisce senza rimuovere il container estraneo;
  il chiamante registra `cleanup=false` e `restore=false`.

Prove: 16/16 test backup; 8 scenari del controller (download 403/503,
mutazione senza ack, ruolo negato, cifratura lunga, chiusura CLI fallita,
arresto lungo, successo); 3 controprove aggiuntive su errore finale e
segnali durante cleanup/dopo download. Tutte PASS. Controlli del readback
grezzo/tipizzato e degli schemi sconosciuti: 14 casi PASS.

Le prove del controller sono simulate; quelle Docker sono locali. Il
checkpoint remoto e il ritorno verificato all'originale richiedono una
ricevuta di esecuzione separata. Gli esiti effettivi sono riportati sotto;
le prove preparatorie non sostituiscono il gate remoto.

Evidenze private prive di body applicativi, cookie o segreti:
`/var/folders/fg/l5gxkc013yvf8p6pzqkywstc0000gp/T/amr-checkpoint-nhost-20261008-yex4nmod/`.

## Esecuzioni remote e controprove

Cinque tentativi del checkpoint hanno incontrato errori. Le ricevute
fallite restano tali: non vengono riscritte per trasformarle in successi.
I primi quattro tentativi hanno verificato il ritorno alla configurazione
originale e alla risposta applicativa originale. Il quinto ha completato
la cifratura ma non ha confermato il recovery pubblico entro il budget.

Finding verificati durante l'esecuzione:

- Con zero repliche effettive e zero connessioni dei tre ruoli AMR, Run
  rispondeva a `/healthz` con HTTP 200 e `Content-Length: 0`; la rotta
  applicativa rispondeva 404. Contare soltanto lo status 200 rendeva il
  guard di arresto troppo restrittivo. Ora l'eventuale 200 vuoto è ammesso
  soltanto con lunghezza dichiarata esattamente zero, senza
  Transfer-Encoding né cookie, rotta applicativa non disponibile e due
  osservazioni concordi di Run/connessioni. Il body `ok` non è mai
  interpretato come arresto.
- La controprova con `http.client.HTTPResponse` ha mostrato che `read(3)`
  può restituire vuoto anche dopo una risposta troncata che dichiarava
  due byte. Il guard richiede quindi la lunghezza zero dagli header,
  anziché dedurla dalla sola lettura. Ventuno casi HTTP/quorum PASS.
- Il secondo tentativo acquisiva i file ma tentava il recovery prima
  della cifratura; un errore del canale cloud impediva la conservazione.
  Il controller ora cifra prima del recovery, riservando tempo al
  ripristino e registrando separatamente i due esiti.
- Il resolver pubblico forzato nel controller dava esiti discordanti
  dal resolver di sistema. È stato rimosso l'override, mantenendo TLS,
  verifica hostname e divieto di redirect. Questo finding non spiega
  automaticamente tutti gli errori DNS precedenti.

Il test di regressione della sonda distingue anche HTTP 200 vuoto,
con o senza `no-store`, dalla risposta applicativa attesa: **14 pass,
1 skip opt-in**, zero errori. Review indipendente in sola lettura del
guard e della controprova di risposta troncata.

## Copia reale ripristinata e candidato

Il quinto tentativo ha prodotto una copia cifrata reale in
`/Users/aincrad/AMR-backup-staging/copia-aC0Ys8`: dump PostgreSQL
235.520 byte e snapshot SQLite del volume 36.864 byte. Due repository
restic locali separati; directory privata e chiave distinta dalle
credenziali runtime. Nessuna copia preesistente eliminata.

Restore in PostgreSQL/SQLite isolati, senza rete, e verifica cleanup:
**PASS**, ricevuta `restore-copia.json`. Il restore locale riuscito
non attesta la raggiungibilità dello staging.

Candidato immutabile `d632f50`, verificato localmente con Nhost Auth
0.49.1, PostgreSQL 18.6, centro HTTPS e worker sintetico:

- digest multiarch: `sha256:4ed5414ae8cae68c5e8f7df345d4103dbdce704251ad4e30e4ff65292393e64f`;
- codice: `35e6c369a75bc5bbe406425db5986e96b136fcddf404b95f8fbd64006f1e6d60`;
- cataloghi: `0f20b3c6473b8c28890724f17b073ffff6d0073e0c090e96cb3c61c176252657`.

Upload nel registry riuscito e manifest amd64/arm64 verificato. Il primo
tentativo era stato respinto con 503; un solo retry dello stesso digest
è riuscito. Non è dimostrato un legame con il problema DNS.
Nessuna distribuzione del candidato o migrazione remota ancora eseguita.
Il CHECK storico non è ricomparso in questo collaudo, ma la causa resta
non dimostrata.

## Recovery pubblico: evidenze iniziali e conferma successiva

Readback completo: configurazione originale esatta, immagine `66e2b24`,
una replica Running/ready e avvio applicativo confermato dai log filtrati.
Alle **12:20 UTC** il nostro helper `resolve4` contro i quattro nameserver
della zona restituiva ENOTFOUND. I resolver pubblici riportavano un lookup
negativo. ID progetto, servizio e subdomain coincidono con quelli
originali; la porta resta pubblica 3000 HTTP. Correzione della diagnosi:
queste letture ricorsive non dimostrano quale elemento della catena DNS
fosse assente, né escludono da sole una cache negativa. L'attribuzione
precedente al record autorevole del servizio era troppo forte.

Il preflight delle 12:24 UTC conferma la configurazione originale ma
non la risposta HTTP pubblica. Il gate resta aperto.

Alle **12:35:58 UTC** una sola riconciliazione dell'intero array di porte
già dichiarato, senza toggle o nuove risorse, ha ricevuto ACK esatto e
readback originale. Il lookup DNS continua a fallire; il pod ha mantenuto
la data di avvio originale. Nessun recupero pubblico dimostrato.

La review indipendente dell'executor ha trovato, prima dell'esecuzione,
sintassi non valida, readiness assorbita come errore HTTP e flag di
interruzione/cleanup ignorati. Correzioni verificate con sedici modelli
(nessuna rete): conflitti prima/dopo la mutation, readiness persa,
identità errata, ACK incerto, segnali e cleanup. Seconda review: finding
chiusi. La ricevuta viene prenotata con `O_EXCL` prima della mutation;
un ACK incerto non provoca un retry automatico. I guard prima/dopo
non costituiscono CAS: altre modifiche dello staging vanno escluse
durante l'operazione.

Lo schema ufficiale delle porte comprende anche `ingresses` e `rateLimit`.
Il JSON grezzo corrente contiene soltanto port/type/publish; la vista
tipizzata restituisce zero ingress espliciti. Non è stata dimostrata
la perdita di un dominio configurato dal nostro restore. La documentazione
prevede il dominio automatico con HTTP/pubblicazione attiva.

ACK, readiness e readback non sono prove di recupero DNS/HTTP. La
diagnosi non contatta il supporto Nhost e non coinvolge M2 o portali.

### Recovery confermato, senza ritiro della porta

L'utente ha poi autorizzato una sola prova di ritiro/ripubblicazione della
porta. Executor preparato con quindici controprove simulate PASS e review
indipendente senza finding residui. Il preflight delle **12:57:53 UTC**
ha trovato l'originale già raggiungibile: **zero mutazioni**, nessun ritiro.

Ricevuta separata `recovery-originale.json`: due osservazioni delle
**12:59:57 e 13:00:03 UTC**, configurazione originale esatta, una replica
pronta con la stessa data di avvio, `/healthz` 200 con body applicativo
`ok` e risposta 403 originale riconosciuta. Il 403 è quello del vecchio
guard del peer, non un gate Auth superato.

Le quattro interrogazioni DNS senza ricorsione (`dig +norecurse`) rispondono
NOERROR e mostrano un CNAME. La controprova mostra inoltre che `resolve4`
contro quei server può restituire zero indirizzi pur essendoci il CNAME:
la lettura della catena va distinta dall'assenza del record.
Ricevuta `dns-pacchetti-recuperato.json`. Nessuna modifica del resolver Mac.

Checkpoint cifrato + restore isolato + recovery dell'originale sono ora
verificati con ricevute distinte. La causa del precedente lookup negativo
non è dimostrata; non attribuire il ritorno del DNS all'aggiornamento
identico delle porte. I fallimenti precedenti non vengono cancellati.
Il candidato resta da distribuire dopo la review delle migrazioni.

## Riferimenti

[PostgreSQL pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html):
snapshot consistente; i ruoli globali richiedono una copia distinta. Il
dump proviene esclusivamente dal nostro progetto e il restore viene
eseguito in risorse nuove senza rete.
[Nhost CLI deployments](https://docs.nhost.io/products/run/cli-deployments):
build multiarch e deployment della configurazione Run. La procedura usa
un digest immutabile, readback completo e rollback alla configurazione esatta.
